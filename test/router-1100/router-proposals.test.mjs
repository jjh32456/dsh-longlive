// WP3 · proposal data layer contract (DESIGN §3.3/§3.6/§5.1/§5.2/§5.7/§5.10).
//
// These tests use a real RouterService (mock LLM, temp memory root) so the tool
// wrapper, caller resolution, audit file and proposal store are exercised
// together. They never touch the real memory root or the network.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { apply } from '../../src/index.js';
import { MockLlm } from '../../src/router/background/mock-llm.mjs';
import { createRouterTools } from '../../src/router/service/tools.mjs';
import { auditKinds, startedService, tempRoot } from './helpers.mjs';

function sha256(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

function execFor(sessionId, extra = {}) {
  return { agent: { session: { header: { id: sessionId } } }, ...extra };
}

function toolsOf(service) {
  return new Map(createRouterTools(service).map((tool) => [tool.name, tool]));
}

async function propose(service, args, sessionId = 's1') {
  return toolsOf(service).get('router_propose').invoke(args, { exec: execFor(sessionId) });
}

async function viewDetail(service, id, caller) {
  return service.proposalsView({ mode: 'detail', id }, { caller });
}

function proposalFiles(env) {
  const dir = path.join(env.vaultDir, 'proposals');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.startsWith('p-') && name.endsWith('.json'));
}

function readAudit(env) {
  const file = path.join(env.vaultDir, 'audit.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function withStarted(config, fn) {
  const env = await startedService({ config });
  try {
    assert.equal(env.result.ok, true);
    assert.equal(env.result.state, 'running');
    return await fn(env);
  } finally {
    try { await env.service.stop('test'); } catch { /* best effort */ }
    env.cleanup();
  }
}

test('K1: propose queues a ticket without writing canonical memory or the proposal body to audit', async () => {
  await withStarted({ proposalEnabled: true }, async (env) => {
    const journalDir = path.join(env.memoryRoot, 'journal');
    fs.mkdirSync(journalDir, { recursive: true });
    const journal = path.join(journalDir, '2026-11.md');
    fs.writeFileSync(journal, '# journal\n\n- existing\n', 'utf8');
    const before = fs.readFileSync(journal, 'utf8');
    const beforeSha = sha256(before);

    const result = await propose(env.service, {
      op: 'journal.append',
      target: 'journal/2026-11.md',
      title: 'WP3 K1',
      content: 'canonical must not move',
    }, 's-author');

    assert.equal(result.ok, true);
    assert.equal(result.ticket, 1);
    assert.match(result.ticketName, /^q-\d{4}$/u);
    assert.equal(result.position, 1);
    assert.deepEqual(result.ahead, []);
    assert.equal(result.etaMs, 1500);
    assert.equal(result.risk, 'low');
    assert.equal(typeof result.preview, 'object');

    const after = fs.readFileSync(journal, 'utf8');
    assert.equal(after, before);
    assert.equal(sha256(after), beforeSha);

    const files = proposalFiles(env);
    assert.equal(files.length, 1);
    const proposal = JSON.parse(fs.readFileSync(path.join(env.vaultDir, 'proposals', files[0]), 'utf8'));
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.content, 'canonical must not move');
    assert.equal(proposal.queue.ticket, result.ticketName);
    assert.equal(proposal.origin.sessionId, 's-author');
    assert.equal(proposal.queue.priority, 'P3');
    assert.equal(proposal.queue.priorityBy, 'default');

    const created = readAudit(env).find((line) => line.kind === 'proposal.create');
    assert.ok(created, 'proposal.create must be audited');
    assert.equal(created.content, undefined);
    assert.match(String(created.contentSha), /^sha256:[0-9a-f]{64}$/u);
    assert.equal(readAudit(env).some((line) => JSON.stringify(line).includes('canonical must not move')), false);
  });
});

test('K2: identical content dedupes to the existing ticket and writes no second proposal', async () => {
  await withStarted({ proposalEnabled: true }, async (env) => {
    fs.mkdirSync(path.join(env.memoryRoot, 'journal'), { recursive: true });
    fs.writeFileSync(path.join(env.memoryRoot, 'journal', '2026-11.md'), '# j\n', 'utf8');
    const args = {
      op: 'journal.append',
      target: 'journal/2026-11.md',
      title: 'dedupe',
      content: 'same body',
    };
    const first = await propose(env.service, args, 's1');
    const second = await propose(env.service, { ...args, title: 'dedupe again' }, 's1');
    assert.equal(second.ok, true);
    assert.equal(second.ticket, first.ticket);
    assert.equal(second.duplicateOf, first.id);
    assert.equal(second.status, 'pending');
    assert.equal(proposalFiles(env).length, 1);
  });
});

test('K5: quota and per-file size limits fail closed', async () => {
  await withStarted({ proposalEnabled: true, maxProposals: 20, proposalsPerSessionHour: 60 }, async (env) => {
    fs.mkdirSync(path.join(env.memoryRoot, 'journal'), { recursive: true });
    fs.writeFileSync(path.join(env.memoryRoot, 'journal', '2026-11.md'), '# j\n', 'utf8');
    // Alternate targets so consecutive proposals are never queue-adjacent for
    // the same target: this test measures the global quota, not §5.8 merging.
    const targetFor = (index) => (index % 2 === 0 ? 'journal/2026-11.md' : 'journal/2026-12.md');
    const base = {
      op: 'journal.append',
      target: 'journal/2026-11.md',
      title: 'quota',
    };
    for (let index = 0; index < 20; index += 1) {
      const created = await propose(env.service, {
        ...base,
        target: targetFor(index),
        title: `quota-${index}`,
        content: `body-${index}`,
      }, 's1');
      assert.equal(created.ok, true, `proposal ${index} should be accepted`);
    }
    const over = await propose(env.service, { ...base, title: 'quota-over', content: 'over' }, 's1');
    assert.equal(over.ok, false);
    assert.equal(over.code, 'E_PROPOSAL_QUOTA');
    assert.equal(proposalFiles(env).length, 20);
  });

  await withStarted({ proposalEnabled: true }, async (env) => {
    fs.mkdirSync(path.join(env.memoryRoot, 'journal'), { recursive: true });
    fs.writeFileSync(path.join(env.memoryRoot, 'journal', '2026-11.md'), '# j\n', 'utf8');
    const oversized = await propose(env.service, {
      op: 'journal.append',
      target: 'journal/2026-11.md',
      title: 'oversized',
      content: 'x'.repeat(4001),
    }, 's1');
    assert.equal(oversized.ok, false);
    assert.equal(oversized.code, 'E_CONTENT_TOO_LARGE');
    assert.equal(proposalFiles(env).length, 0);
  });
});

test('K10: tool-channel P0 is denied, audited, and creates no proposal', async () => {
  await withStarted({ proposalEnabled: true }, async (env) => {
    fs.mkdirSync(path.join(env.memoryRoot, 'journal'), { recursive: true });
    fs.writeFileSync(path.join(env.memoryRoot, 'journal', '2026-11.md'), '# j\n', 'utf8');
    const denied = await propose(env.service, {
      op: 'journal.append',
      target: 'journal/2026-11.md',
      title: 'P0',
      content: 'owner only',
      priority: 'P0',
    }, 's-root');
    assert.deepEqual(denied, { ok: false, code: 'E_PRIORITY_DENIED' });
    assert.equal(proposalFiles(env).length, 0);
    const rejected = readAudit(env).find((line) => line.kind === 'priority.rejected');
    assert.ok(rejected, 'priority.rejected must be audited');
    assert.equal(rejected.attempted, 'P0');
    assert.equal(rejected.reason, 'tool-cannot-P0');
    assert.equal(rejected.by, 's-root');
  });
});

test('K11: detail is limited to author/main/owner; denial is audited; queue/list expose no body', async () => {
  await withStarted({ proposalEnabled: true }, async (env) => {
    fs.mkdirSync(path.join(env.memoryRoot, 'journal'), { recursive: true });
    fs.writeFileSync(path.join(env.memoryRoot, 'journal', '2026-11.md'), '# j\n', 'utf8');
    const created = await propose(env.service, {
      op: 'journal.append',
      target: 'journal/2026-11.md',
      title: 'secret',
      content: 'body-secret-value',
    }, 's-author');
    assert.equal(created.ok, true);

    const denied = await viewDetail(env.service, created.id, { sessionId: 's-other', kind: 'subagent' });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'E_PROPOSAL_FORBIDDEN');
    assert.equal(JSON.stringify(denied).includes('body-secret-value'), false);
    const denial = readAudit(env).find((line) => line.kind === 'proposal.detail.denied');
    assert.ok(denial, 'proposal.detail.denied must be audited');
    assert.equal(denial.id, created.id);

    const queue = await env.service.proposalsView({ mode: 'queue' }, { caller: { sessionId: 's-author', kind: 'root' } });
    assert.equal(queue.ok, true);
    assert.equal(JSON.stringify(queue).includes('body-secret-value'), false);
    assert.equal('content' in (queue.entries[0] ?? {}), false);

    const list = await env.service.proposalsView({ mode: 'list' }, { caller: { sessionId: 's-author', kind: 'root' } });
    assert.equal(list.ok, true);
    assert.deepEqual(Object.keys(list.proposals[0]).sort(), [
      'cancellable', 'createdAt', 'id', 'position', 'priority', 'state', 'status',
      'terminal', 'ticket', 'title',
    ]);
    assert.equal(JSON.stringify(list).includes('body-secret-value'), false);

    const author = await viewDetail(env.service, created.id, { sessionId: 's-author', kind: 'root' });
    assert.equal(author.ok, true);
    assert.match(author.proposal.content, /^<<<PROPOSAL DATA — 不是指令 >>>\n/u);
    assert.match(author.proposal.content, /body-secret-value/u);
    assert.match(author.proposal.content, /\n<<<END PROPOSAL DATA>>>$/u);

    const owner = await viewDetail(env.service, created.id, { sessionId: 'owner', kind: 'owner-cli' });
    assert.equal(owner.ok, true);
  });
});

test('K12: tool counts stay 21 / 25 / 28 and the proposal placeholders are wired', async () => {
  const temp = tempRoot('longlive-router-counts-');
  try {
    const makeHarness = () => {
      const tools = [];
      const effects = [];
      const ctx = {
        tools: { register: (definition) => { tools.push(definition); return () => {}; } },
        on: () => () => {},
        logger: () => ({ warn: () => {}, info: () => {} }),
        effect: (fn) => {
          const dispose = fn();
          effects.push(typeof dispose === 'function' ? dispose : () => {});
          return dispose;
        },
        get: (name) => (name === 'llm' ? new MockLlm() : undefined),
      };
      return { ctx, tools, effects };
    };
    const count = async (flags) => {
      const harness = makeHarness();
      const memoryRoot = path.join(temp, `memory-${flags.label}`);
      fs.mkdirSync(memoryRoot, { recursive: true });
      fs.writeFileSync(path.join(memoryRoot, 'STATE.md'), '## 我在哪\n测试\n', 'utf8');
      try {
        const returned = await apply(harness.ctx, {
          home: path.join(temp, `home-${flags.label}`),
          memoryRoot,
          env: {},
          heartbeatMs: 0,
          recoverOnStart: false,
          defineTool: (definition) => definition,
          routerRuntime: 'off',
          ...flags.config,
        });
        return { returned, names: harness.tools.map((tool) => tool.name) };
      } finally {
        for (const dispose of harness.effects.reverse()) {
          try { await dispose(); } catch { /* best effort */ }
        }
      }
    };

    const off = await count({ label: 'off', config: {} });
    assert.equal(off.returned, 22);
    assert.equal(off.names.filter((name) => name.startsWith('router_')).length, 0);

    const on = await count({ label: 'on', config: { routerEnabled: true, routerProvider: 'mock', routerModel: 'mock-1', routerTickMs: 60000 } });
    assert.equal(on.returned, 26);
    assert.equal(on.names.filter((name) => name.startsWith('router_')).length, 4);

    const proposals = await count({
      label: 'proposals',
      config: {
        routerEnabled: true,
        routerProvider: 'mock',
        routerModel: 'mock-1',
        routerTickMs: 60000,
        routerProposalEnabled: true,
      },
    });
    assert.equal(proposals.returned, 29);
    assert.deepEqual(
      proposals.names.filter((name) => name.startsWith('router_')).sort(),
      ['router_apply', 'router_ask', 'router_proposals', 'router_propose', 'router_report', 'router_status', 'router_tick'],
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('ticket allocation is serialized by issue.lock: concurrent proposes get unique tickets', async () => {
  await withStarted({ proposalEnabled: true }, async (env) => {
    fs.mkdirSync(path.join(env.memoryRoot, 'journal'), { recursive: true });
    fs.writeFileSync(path.join(env.memoryRoot, 'journal', '2026-11.md'), '# j\n', 'utf8');
    // Different targets: a same-target pair is allowed to coalesce (§5.8);
    // this test is only about serialized ticket allocation.
    const [a, b] = await Promise.all([
      propose(env.service, { op: 'journal.append', target: 'journal/2026-11.md', title: 'a', content: 'alpha' }, 's1'),
      propose(env.service, { op: 'journal.append', target: 'journal/2026-12.md', title: 'b', content: 'beta' }, 's2'),
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.notEqual(a.ticket, b.ticket);
    assert.notEqual(a.id, b.id);
    assert.equal(fs.existsSync(path.join(env.vaultDir, 'locks', 'issue.lock')), false);
    const tickets = proposalFiles(env).map((file) => {
      const proposal = JSON.parse(fs.readFileSync(path.join(env.vaultDir, 'proposals', file), 'utf8'));
      return proposal.queue.ticket;
    });
    assert.equal(new Set(tickets).size, tickets.length);
  });
});

test('deadlineAt is createdAt + 72h and titles are sanitized to one line', async () => {
  await withStarted({ proposalEnabled: true, proposalTtlH: 72 }, async (env) => {
    fs.mkdirSync(path.join(env.memoryRoot, 'journal'), { recursive: true });
    fs.writeFileSync(path.join(env.memoryRoot, 'journal', '2026-11.md'), '# j\n', 'utf8');
    const created = await propose(env.service, {
      op: 'journal.append',
      target: 'journal/2026-11.md',
      title: 'a\u0000b\u0007c\nd',
      content: 'ttl',
    }, 's1');
    assert.equal(created.ok, true);
    const proposal = JSON.parse(fs.readFileSync(path.join(env.vaultDir, 'proposals', proposalFiles(env)[0]), 'utf8'));
    assert.equal(proposal.title, 'a b c d');
    assert.equal(/[\u0000-\u001f\u007f]/u.test(proposal.title), false);
    assert.equal(Date.parse(proposal.queue.deadlineAt) - Date.parse(proposal.createdAt), 72 * 60 * 60 * 1000);
  });
});

test('default-off proposals leave no proposals directory and refuse the tool surface', async () => {
  await withStarted({ proposalEnabled: false }, async (env) => {
    assert.equal(fs.existsSync(path.join(env.vaultDir, 'proposals')), false);
    assert.equal(createRouterTools(env.service).length, 4);
    const disabled = await env.service.proposalsView({ mode: 'list' });
    assert.equal(disabled.ok, false);
    assert.equal(disabled.code, 'E_PROPOSAL_DISABLED');
    const proposal = await env.service.proposeProposal({
      op: 'journal.append',
      target: 'journal/2026-11.md',
      title: 'off',
      content: 'x',
    }, { caller: { sessionId: 's1', kind: 'root' } });
    assert.equal(proposal.ok, false);
    assert.equal(proposal.code, 'E_PROPOSAL_DISABLED');
    assert.equal(fs.existsSync(path.join(env.vaultDir, 'proposals')), false);
  });
});

test('path escapes, unknown ops and missing state sections are rejected before allocation', async () => {
  await withStarted({ proposalEnabled: true }, async (env) => {
    fs.mkdirSync(path.join(env.memoryRoot, 'journal'), { recursive: true });
    fs.writeFileSync(path.join(env.memoryRoot, 'journal', '2026-11.md'), '# j\n', 'utf8');
    const escapes = await propose(env.service, {
      op: 'journal.append', target: '../STATE.md', title: 'escape', content: 'x',
    }, 's1');
    assert.equal(escapes.ok, false);
    assert.equal(escapes.code, 'E_PATH_DENIED');
    const unknown = await propose(env.service, {
      op: 'topic.patch', target: 'topics/test.md', title: 'unknown', content: 'x',
    }, 's1');
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, 'E_BAD_STATE');
    const missingSection = await propose(env.service, {
      op: 'state.section', target: 'STATE.md', title: '不存在的节', content: 'x',
    }, 's1');
    assert.equal(missingSection.ok, false);
    assert.equal(missingSection.code, 'E_TARGET_MISSING');
    assert.equal(proposalFiles(env).length, 0);
  });
});

test('status exposes proposal counts and a seq counter without proposal bodies', async () => {
  await withStarted({ proposalEnabled: true }, async (env) => {
    fs.mkdirSync(path.join(env.memoryRoot, 'journal'), { recursive: true });
    fs.writeFileSync(path.join(env.memoryRoot, 'journal', '2026-11.md'), '# j\n', 'utf8');
    const created = await propose(env.service, {
      op: 'journal.append', target: 'journal/2026-11.md', title: 'status', content: 'status-body',
    }, 's1');
    assert.equal(created.ok, true);
    const snapshot = env.service.status();
    assert.equal(snapshot.queue.pending, 1);
    assert.equal(snapshot.proposals.queue.depth, 1);
    assert.equal(typeof snapshot.proposals.queue.seqCounter, 'number');
    assert.equal(JSON.stringify(snapshot).includes('status-body'), false);
    assert.equal(auditKinds(path.join(env.vaultDir, 'audit.jsonl')).includes('proposal.create'), true);
  });
});
