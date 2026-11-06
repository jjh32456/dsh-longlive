#!/usr/bin/env node
// Router 1.1.0 WP5 — owner CLI for the proposal channel.
//
//   node scripts/router-proposals.mjs propose  --memory-root <dir> --op journal.append \
//        --target journal/2026-11.md --title "<title>" --content-file <file> \
//        [--priority P0] [--priority-reason "<why>"] [--json]
//   node scripts/router-proposals.mjs list     --vault-dir <vault> [--status queued]
//   node scripts/router-proposals.mjs show     --vault-dir <vault> --id <proposal-id>
//   node scripts/router-proposals.mjs queue    --vault-dir <vault>
//   node scripts/router-proposals.mjs approve  --vault-dir <vault> --id <id> --confirm <last6>
//   node scripts/router-proposals.mjs reject|cancel|rollback|apply ...
//
// Boundaries (binding):
//   - This CLI shares the exact proposal JSON/state machine with the tools. It
//     does not re-implement any transition and never writes canonical memory.
//   - approve/reject/apply/rollback go through the same WP4 applier as
//     router_apply: the CLI never writes canonical memory or proposal state by
//     hand, and apply/rollback must still take the writer lease and emit WAL.
//   - Invoking the owner CLI is an explicit owner action, so transitions run
//     with applyEnabled=true in this process only (plugin config is untouched).
//   - Only `propose --priority P0` is allowed to use P0 (owner channel), and it
//     is stamped origin.kind=owner-cli / priorityBy=owner-cli / by=owner:cli.
//   - No network, no host plugin context, no service start.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AuditLog } from '../src/router/background/audit.mjs';
import { normalizeRouterConfig } from '../src/router/service/config.mjs';
import { createApplier } from '../src/router/service/apply.mjs';
import { clampLeaseTtl, createWriterLease } from '../src/router/service/lease.mjs';
import { createQueueManager } from '../src/router/service/queue.mjs';
import { createProposalEngine, isProposalId } from '../src/router/service/proposals.mjs';
import { scanProposalDir } from '../src/router/service/store.mjs';
import { createWakeChannel } from '../src/router/service/wake.mjs';
import { createWal } from '../src/router/service/wal.mjs';

const USAGE = `router-proposals (owner CLI)

  propose   --memory-root <dir> --op <op> --target <rel> --title <text>
            (--content <text> | --content-file <path>) [--rationale <text>]
            [--base-sha <sha>] [--priority P0..P4] [--priority-reason <text>]
  list      --vault-dir <dir> [--status <status>] [--limit 1..20]
  show      --vault-dir <dir> (--id <proposal-id> | --ticket <q-0001>)
  queue     --vault-dir <dir>
  approve   --vault-dir <dir> (--id <id> | --ticket <q-0001>) --confirm <last6>
  reject    --vault-dir <dir> (--id <id> | --ticket <q-0001>) [--note <text>]
  cancel    --vault-dir <dir> (--id <id> | --ticket <q-0001>) [--note <text>]
  rollback  --vault-dir <dir> (--id <id> | --ticket <q-0001>) --confirm <last6>
  apply     --vault-dir <dir> (--id <id> | --ticket <q-0001>) --confirm <last6>

Global: [--json] [--vault-dir <dir>] [--memory-root <dir>]

P0 is owner-only. approve/apply/rollback require --confirm = last 6 chars of the id.
Transitions use the WP4 writer (lease + WAL); apply may return state=queued when
another writer holds the lease — that is not an error.`;

class CliError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

function fail(code, message, extra) {
  throw new CliError(code, message, extra);
}


function parseArgv(argv) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    let key;
    let value;
    if (eq >= 0) {
      key = arg.slice(2, eq);
      value = arg.slice(eq + 1);
    } else {
      key = arg.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        value = argv[i + 1];
        i += 1;
      } else {
        value = 'true';
      }
    }
    options[key] = value;
  }
  return { command: positional[0] ?? null, options };
}

function requireOption(options, name) {
  const value = options[name];
  if (typeof value !== 'string' || value.trim() === '') fail('E_USAGE', `--${name} is required`);
  return value;
}

function resolveVault(options, { requireMemoryRoot = false } = {}) {
  const vaultOption = typeof options['vault-dir'] === 'string' ? options['vault-dir'] : '';
  const memoryOption = typeof options['memory-root'] === 'string' ? options['memory-root'] : '';
  const memoryRoot = memoryOption ? path.resolve(memoryOption) : null;
  if (requireMemoryRoot && !memoryRoot) fail('E_USAGE', '--memory-root is required for propose');
  if (memoryRoot && !fs.existsSync(memoryRoot)) fail('E_NO_MEMORY_ROOT', `memory root does not exist: ${memoryRoot}`);
  const vaultDir = vaultOption
    ? path.resolve(vaultOption)
    : (memoryRoot ? path.join(memoryRoot, '.longlive', 'router') : null);
  if (!vaultDir) fail('E_USAGE', 'one of --vault-dir or --memory-root is required');
  // `--vault-dir` may point at the default `<memoryRoot>/.longlive/router`;
  // derive the memory root from that layout so applier targets (journal/...,
  // STATE.md, ...) resolve against the same root the proposer validated.
  let effectiveMemoryRoot = memoryRoot;
  if (!effectiveMemoryRoot
    && path.basename(vaultDir) === 'router'
    && path.basename(path.dirname(vaultDir)) === '.longlive') {
    effectiveMemoryRoot = path.dirname(path.dirname(vaultDir));
  }
  return { vaultDir, memoryRoot: effectiveMemoryRoot };
}

function makeEngine(options, audit = null) {
  const { vaultDir, memoryRoot } = resolveVault(options);
  const config = normalizeRouterConfig({
    ...(options.config ?? {}),
    proposalEnabled: true,
    // Owner CLI = explicit owner action (see header boundary note).
    applyEnabled: true,
    ...(options['max-proposals'] ? { maxProposals: Number(options['max-proposals']) } : {}),
    ...(options['per-hour'] ? { proposalsPerSessionHour: Number(options['per-hour']) } : {}),
    ...(options['max-chars'] ? { proposalMaxChars: Number(options['max-chars']) } : {}),
  });
  const paths = {
    vaultDir,
    proposalsDir: path.join(vaultDir, 'proposals'),
    liveRoot: memoryRoot ?? path.dirname(vaultDir),
  };
  const now = () => new Date();
  const log = audit ?? (() => {});
  const engine = createProposalEngine({
    config,
    paths,
    memoryRoot: memoryRoot ?? path.dirname(vaultDir),
    audit: log,
    now,
    logger: () => null,
  });
  const locksDir = path.join(vaultDir, 'locks');
  const wal = createWal({ file: engine.walFile, audit: log, logger: () => null });
  const lease = createWriterLease({
    file: path.join(locksDir, 'writer.lease.json'),
    lockDir: locksDir,
    ttlMs: clampLeaseTtl(config.writerLeaseMs),
    renewalsMax: config.leaseRenewMax,
    holder: { sessionId: 'owner-cli', runId: `cli-${process.pid}-${Date.now()}`, pid: process.pid, host: 'local' },
    now,
    audit: log,
  });
  const queue = createQueueManager({ paths, config, wal, audit: log, now });
  const wake = createWakeChannel({ vaultDir, config, audit: log, now, logger: () => null });
  engine.wal = wal;
  engine.lease = lease;
  engine.wake = wake;
  engine.applier = createApplier({
    paths,
    vaultDir,
    memoryRoot: paths.liveRoot,
    config,
    lease,
    wal,
    queue,
    wake,
    audit: log,
    now,
    logger: () => null,
    caller: { kind: 'owner-cli', sessionId: 'owner-cli' },
  });
  return { engine, vaultDir, memoryRoot, config };
}

function ownerCaller() {
  return { kind: 'owner-cli', sessionId: 'owner-cli' };
}

function findProposal(engine, vaultDir, options) {
  const id = typeof options.id === 'string' ? options.id.trim() : '';
  const ticket = typeof options.ticket === 'string' ? options.ticket.trim() : '';
  const scan = scanProposalDir(path.join(vaultDir, 'proposals'));
  const proposals = scan.proposals;
  if (id) {
    if (!isProposalId(id)) fail('E_TICKET_UNKNOWN', `invalid proposal id: ${id}`);
    const found = proposals.find((proposal) => proposal.id === id);
    if (!found) fail('E_TICKET_UNKNOWN', `proposal not found: ${id}`);
    return found;
  }
  if (ticket) {
    const found = proposals.find((proposal) => proposal?.queue?.ticket === ticket);
    if (!found) fail('E_TICKET_UNKNOWN', `ticket not found: ${ticket}`);
    return found;
  }
  fail('E_USAGE', '--id or --ticket is required');
  return null;
}

function printResult(result, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (result?.ok) {
    if (result.mode === 'list') {
      process.stdout.write(`${result.proposals.length} proposal(s)\n`);
      for (const row of result.proposals) {
        process.stdout.write(`${row.ticket}  ${row.state.padEnd(12)} ${row.priority}  ${row.id}  ${row.title}\n`);
      }
      return;
    }
    if (result.mode === 'queue') {
      process.stdout.write(`queue depth=${result.depth} seqCounter=${result.seqCounter} etaMs=${result.etaMs}\n`);
      for (const row of result.entries) {
        process.stdout.write(`${row.ticket}  ${row.status.padEnd(12)} ${row.priority}  ${row.target}\n`);
      }
      return;
    }
    if (result.id) {
      process.stdout.write(`ok ${result.id}${result.ticket ? ` ticket ${result.ticket}` : ''}${result.state ? ` state ${result.state}` : ''}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function run(argv) {
  const { command, options } = parseArgv(argv);
  if (options.help || !command) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!['propose', 'list', 'show', 'queue', 'approve', 'reject', 'cancel', 'rollback', 'apply'].includes(command)) {
    fail('E_USAGE', `unknown subcommand: ${command}`);
  }

  if (command === 'propose') {
    const memoryRoot = requireOption(options, 'memory-root');
    if (!fs.existsSync(memoryRoot)) fail('E_NO_MEMORY_ROOT', `memory root does not exist: ${path.resolve(memoryRoot)}`);
    const op = requireOption(options, 'op');
    const target = requireOption(options, 'target');
    const title = requireOption(options, 'title');
    let content = typeof options.content === 'string' ? options.content : '';
    if (typeof options['content-file'] === 'string') {
      const file = path.resolve(options['content-file']);
      if (!fs.existsSync(file)) fail('E_USAGE', `content file not found: ${file}`);
      content = fs.readFileSync(file, 'utf8');
    }
    if (!content) fail('E_USAGE', '--content or --content-file is required');

    const { vaultDir } = resolveVault(options, { requireMemoryRoot: true });
    const runId = `cli-propose-${process.pid}-${Date.now()}`;
    const audit = new AuditLog({ file: path.join(vaultDir, 'audit.jsonl'), runId });
    audit.open();
    try {
      const { engine } = makeEngine(options, (kind, data) => audit.append(kind, data));
      const result = await engine.propose({
        op,
        target,
        title,
        content,
        ...(typeof options.rationale === 'string' ? { rationale: options.rationale } : {}),
        ...(typeof options['base-sha'] === 'string' ? { baseSha: options['base-sha'] } : {}),
        ...(typeof options.priority === 'string' ? { priority: options.priority } : {}),
        ...(typeof options['priority-reason'] === 'string' ? { priorityReason: options['priority-reason'] } : {}),
      }, { caller: ownerCaller() });
      printResult(result, options);
      return result?.ok ? 0 : 1;
    } finally {
      audit.close();
    }
  }

  if (command === 'list') {
    const { vaultDir } = resolveVault(options);
    const { engine } = makeEngine(options);
    const result = engine.view({
      mode: 'list',
      ...(typeof options.status === 'string' ? { status: options.status } : {}),
      ...(typeof options.limit === 'string' ? { limit: Number(options.limit) } : {}),
    }, { caller: ownerCaller() });
    printResult(result, options);
    return result?.ok ? 0 : 1;
  }

  if (command === 'queue') {
    const { vaultDir } = resolveVault(options);
    const { engine } = makeEngine(options);
    const result = engine.view({ mode: 'queue' }, { caller: ownerCaller() });
    printResult(result, options);
    return result?.ok ? 0 : 1;
  }

  if (command === 'show') {
    const { vaultDir } = resolveVault(options);
    const { engine } = makeEngine(options);
    let id = typeof options.id === 'string' ? options.id.trim() : '';
    if (!id) {
      const found = findProposal(engine, vaultDir, options);
      id = found.id;
    }
    const result = engine.view({ mode: 'detail', id }, { caller: ownerCaller() });
    printResult(result, options);
    return result?.ok ? 0 : 1;
  }

  // Mutations: shared seam with router_apply. Never write proposal JSON here.
  const { vaultDir } = resolveVault(options);
  const { engine } = makeEngine(options);
  const proposal = findProposal(engine, vaultDir, options);
  const id = proposal.id;
  if (['approve', 'apply', 'rollback'].includes(command)) {
    const confirm = typeof options.confirm === 'string' ? options.confirm : '';
    if (!confirm) fail('E_CONFIRM_REQUIRED', '--confirm <last6> is required');
    if (confirm !== id.slice(-6)) fail('E_CONFIRM_REQUIRED', '--confirm must equal the last 6 characters of the proposal id');
  }
  const methodNames = command === 'apply'
    ? ['requestApply', 'applyProposal']
    : [command, `${command}Proposal`];
  const fn = methodNames.map((name) => engine[name]).find((candidate) => typeof candidate === 'function');
  if (!fn) {
    printResult({
      ok: false,
      code: 'E_WP4_PENDING',
      id,
      ticket: proposal?.queue?.ticket ?? null,
      message: `proposal transition "${command}" requires the WP4 queue/lease/apply writer, which is not installed in this build`,
    }, options);
    return 1;
  }
  // D-CR7: a concurrent writer may win the rev CAS; re-run the transition from
  // a fresh read a bounded number of times instead of reporting a lost update.
  let result = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      result = await fn.call(engine, {
        mode: command,
        id,
        ticket: proposal?.queue?.ticket ?? null,
        confirm: options.confirm,
        note: options.note,
      }, { caller: ownerCaller() });
      if (!(result?.ok === false && result.code === 'E_STATE_RACE') || attempt === 2) break;
    } catch (error) {
      if (error?.code !== 'E_STATE_RACE' || attempt === 2) throw error;
      result = { ok: false, code: 'E_STATE_RACE', message: String(error?.message ?? error) };
    }
    await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)));
  }
  printResult(result, options);
  return result?.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    const payload = {
      ok: false,
      code: error?.code ?? 'E_CLI',
      message: String(error?.message ?? error),
      ...(error?.extra ?? {}),
    };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    process.exitCode = 1;
  });
}

export { run, parseArgv };
