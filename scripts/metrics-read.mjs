#!/usr/bin/env node
/**
 * Read-only D1/D4 ledger endpoint.
 *
 * The plugin has no HTTP server by design (see docs/PANEL-INTEGRATION.md).
 * The panel and the Router read the ledger in one of two ways:
 *
 *   1. read `<memoryRoot>/.longlive/metrics/turns.jsonl` directly, or
 *   2. run this script for a one-line JSON summary:
 *
 *        node scripts/metrics-read.mjs --memory-root <root>
 *        node scripts/metrics-read.mjs --memory-root <root> --json --limit 50
 *
 * Exit code is 0 even when the ledger does not exist yet; the payload carries
 * `exists:false`.  This is a metrics endpoint, not a health check.
 */

import os from 'node:os';
import path from 'node:path';
import { readMetricsSummary, readTurnLedger, ledgerPath, calibrationPath } from '../src/metrics/store.mjs';

function parseArgs(argv) {
  const out = { memoryRoot: '', sessionId: '', limit: 0, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--memory-root' || arg === '--mem-root') out.memoryRoot = argv[++index] ?? '';
    else if (arg === '--session' || arg === '--session-id') out.sessionId = argv[++index] ?? '';
    else if (arg === '--limit') out.limit = Number.parseInt(argv[++index] ?? '', 10) || 0;
    else if (arg.startsWith('--memory-root=')) out.memoryRoot = arg.slice('--memory-root='.length);
    else if (arg.startsWith('--session=')) out.sessionId = arg.slice('--session='.length);
    else if (arg.startsWith('--limit=')) out.limit = Number.parseInt(arg.slice('--limit='.length), 10) || 0;
  }
  return out;
}

function resolveMemoryRoot(explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(explicit.trim());
  for (const key of ['DSH_LONGLIVE_MEMORY_ROOT', 'DSH_MEMORY_ROOT', 'DSH_MEM']) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim() !== '') return path.resolve(value.trim());
  }
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh');
  return path.join(home, 'longlive-memory');
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(
    'usage: node scripts/metrics-read.mjs [--memory-root <root>] [--session <id>] [--limit N] [--json]\n' +
    '  default: one-line JSON summary (router_status.ledger shape)\n' +
    '  --json : the ledger rows (newest N when --limit is set)\n',
  );
  process.exit(0);
}

const memoryRoot = resolveMemoryRoot(args.memoryRoot);
if (args.json) {
  const ledger = readTurnLedger({ memoryRoot, sessionId: args.sessionId, limit: args.limit });
  process.stdout.write(`${JSON.stringify({
    ok: ledger.ok,
    path: ledger.path,
    exists: ledger.exists,
    total: ledger.total,
    skipped: ledger.skipped,
    bytes: ledger.bytes,
    rows: ledger.rows,
  })}\n`);
} else {
  const summary = readMetricsSummary({ memoryRoot, sessionId: args.sessionId, limit: args.limit || 500 });
  process.stdout.write(`${JSON.stringify({
    ...summary,
    ledgerPath: ledgerPath(memoryRoot),
    statePath: calibrationPath(memoryRoot),
  })}\n`);
}
