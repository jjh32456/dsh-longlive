// Regression gate for the two panel data gaps found in the 2026-11-06 real-machine
// acceptance report (C:\dshops\batch\panel-accept\REPORT.md §6.1):
//
//   G1  /truncations only read truncate.json, so the 10 newest visible-conversation
//       truncations in truncate-visible.json never reached the page.
//   G2  summary.totals.shadowRecords dropped the whole .longlive/router-runtime.jsonl
//       count when the legacy root-level file was missing (read but not assigned):
//       86 instead of 171 + 86 = 257 on the real machine.
//
// Run: node gap-fixes.test.mjs   (node >= 22, no host, no network, temp dirs only)

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPanel } from './src/server.js';

const ISO = (minute) => new Date(Date.UTC(2026, 10, 6, 4, minute, 0)).toISOString();

async function put(root, rel, content) {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`, 'utf8');
}

async function jsonl(root, rel, rows) {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
}

function visibleRow(at, extra = {}) {
  return {
    at,
    tool: 'session_truncate_visible',
    cutTurn: 167,
    cutSeq: 6563,
    droppedTurns: 166,
    keptTurns: 6,
    beforeBytes: 4_911_530,
    afterBytes: 114_893,
    beforeMessages: 1780,
    afterMessages: 69,
    beforeTokens: 690_819,
    afterTokens: 28_610,
    archivePath: 'C:\\Users\\fixture\\.dsh\\sessions\\ws1\\s1\\session.v4.jsonl.zstd.archive\\20261106-040851.jsonl.zstd',
    backupPath: 'C:\\Users\\fixture\\.dsh\\sessions\\ws1\\s1\\session.v4.jsonl.zstd.bak-20261106',
    beforeSha256: 'a'.repeat(64),
    afterSha256: 'b'.repeat(64),
    ...extra,
  };
}

/** memoryRoot + sessionsRoot with: 1 legacy ledger, 3 visible ledgers, 2 router files, 1 filter file. */
async function makeFixture({ rootRouter = 0, dotRouter = 194, filter = 86 } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'llp-gap-'));
  const memory = path.join(base, 'memory');
  const sessions = path.join(base, 'sessions');
  await fs.mkdir(memory, { recursive: true });
  await fs.mkdir(sessions, { recursive: true });

  const ws1 = '--C-fixture-ws1--';
  const ws2 = '--C-fixture-ws2--';

  // s1: both ledgers (the real-machine shape: 1 old + 10 visible, trimmed here to 1 + 3)
  await put(sessions, `${ws1}/s1/truncate.json`, {
    truncations: [{
      at: '2026-11-01T14:28:06.280Z',
      beforeBytes: 5_030_747,
      afterBytes: 3_192_946,
      beforeEvents: 12_053,
      afterEvents: 11_490,
      cutSeq: 0,
      cutTurn: 1,
      backup: `C:\\fixture\\sessions\\${ws1}\\s1\\session.v4.jsonl.zstd.bak-20261101-2`,
      backupSha256: 'c'.repeat(64),
    }],
  });
  await put(sessions, `${ws1}/s1/truncate-visible.json`, {
    version: 1,
    truncations: [visibleRow(ISO(50)), visibleRow(ISO(40), { cutTurn: 160 }), visibleRow(ISO(30), { cutTurn: 150 })],
  });

  // s2: visible ledger only, newest entry wins the global sort
  await put(sessions, `${ws1}/s2/truncate-visible.json`, {
    version: 1,
    truncations: [visibleRow(ISO(58)), visibleRow(ISO(55))],
  });

  // s3: older/foreign ledger shape: top-level array + alias field names
  await put(sessions, `${ws2}/s3/truncate-visible.json`, [
    {
      time: ISO(10),
      turn: 42,
      seq: 1234,
      bytesBefore: 2_000_000,
      bytesAfter: 100_000,
      backupPath: 'C:\\fixture\\sessions\\ws2\\s3\\session.v4.jsonl.zstd.bak-20261102',
      archivePath: 'C:\\fixture\\sessions\\ws2\\s3\\session.v4.jsonl.zstd.archive\\20261102-120000.jsonl.zstd',
    },
    null,
    'not-an-object',
  ]);

  // s4: corrupt ledger must be ignored, not crash the scan
  await put(sessions, `${ws2}/s4/truncate-visible.json`, '{ this is not json');

  // filter + router records for G2
  const filterRows = Array.from({ length: filter }, (_, i) => ({ unitId: `u-${i}`, target: 'archive_only', score: 2, ts: ISO(0) }));
  if (filter > 0) await jsonl(memory, '.longlive/filter/decisions-2026-11-06.jsonl', filterRows);
  const routerRows = (n) => Array.from({ length: n }, (_, i) => ({ ts: ISO(0), tool: 'read', action: 'allow', mode: 'shadow' }));
  if (rootRouter > 0) await jsonl(memory, 'router-runtime.jsonl', routerRows(rootRouter));
  if (dotRouter > 0) await jsonl(memory, '.longlive/router-runtime.jsonl', routerRows(dotRouter));

  return { base, memory, sessions };
}

async function cleanup(base) {
  await fs.rm(base, { recursive: true, force: true });
}

test('G1: /truncations merges truncate-visible.json with truncate.json', async () => {
  const fx = await makeFixture({ dotRouter: 10, filter: 3 });
  try {
    const panel = createPanel({ memoryRoot: fx.memory, sessionsRoot: fx.sessions });
    const res = await panel.handle('truncations', { limit: '100' });
    assert.equal(res.status, 200);
    const body = res.body;
    // 1 legacy + 3 + 2 + 1 visible = 7
    assert.equal(body.page.total, 7);
    assert.deepEqual(body.kinds, { ledger: 1, visible: 6 });
    assert.equal(body.items.length, 7);
    const kinds = body.items.map((x) => x.kind);
    assert.equal(kinds.filter((k) => k === 'visible').length, 6);
    assert.equal(kinds.filter((k) => k === 'ledger').length, 1);
    // newest first: s2's ISO(58) row is the global newest
    assert.equal(body.items[0].at, ISO(58));
    assert.equal(new Set(body.items.map((x) => x.sessionId)).size, 3, 'multi-session: s1/s2/s3 must all appear');
    // visible rows carry the data the page shows
    const newest = body.items.find((x) => x.sessionId.endsWith('s2') && x.at === ISO(58));
    assert.ok(newest);
    assert.equal(newest.beforeBytes, 4_911_530);
    assert.equal(newest.afterBytes, 114_893);
    assert.equal(newest.savedBytes, 4_911_530 - 114_893);
    assert.equal(newest.cutTurn, 167);
    assert.equal(newest.beforeMessages, 1780);
    assert.equal(newest.backup, 'session.v4.jsonl.zstd.bak-20261106');
    assert.equal(newest.archive, '20261106-040851.jsonl.zstd');
    assert.ok(!JSON.stringify(newest).includes('C:\\\\'), 'absolute paths must not leak to the API');
  } finally {
    await cleanup(fx.base);
  }
});

test('G1: old-format ledger (top-level array + alias fields) is readable', async () => {
  const fx = await makeFixture({ dotRouter: 5, filter: 1 });
  try {
    const panel = createPanel({ memoryRoot: fx.memory, sessionsRoot: fx.sessions });
    const body = (await panel.handle('truncations', { limit: '100' })).body;
    const oldRow = body.items.find((x) => x.sessionId.endsWith('s3'));
    assert.ok(oldRow, 'old-format row missing');
    assert.equal(oldRow.at, ISO(10));
    assert.equal(oldRow.cutTurn, 42); // from `turn`
    assert.equal(oldRow.cutSeq, 1234); // from `seq`
    assert.equal(oldRow.beforeBytes, 2_000_000); // from `bytesBefore`
    assert.equal(oldRow.afterBytes, 100_000); // from `bytesAfter`
    assert.equal(oldRow.backup, 'session.v4.jsonl.zstd.bak-20261102');
    assert.equal(oldRow.archive, '20261102-120000.jsonl.zstd');
    // the two junk array members are skipped, not fatal
    assert.equal(body.items.filter((x) => x.sessionId.endsWith('s3')).length, 1);
    // corrupt s4 ledger is ignored
    assert.equal(body.items.filter((x) => x.sessionId.endsWith('s4')).length, 0);
  } finally {
    await cleanup(fx.base);
  }
});

test('G1: summary truncations counts the merged list and ?session= filters visible rows', async () => {
  const fx = await makeFixture({ dotRouter: 7, filter: 2 });
  try {
    const panel = createPanel({ memoryRoot: fx.memory, sessionsRoot: fx.sessions });
    const summary = (await panel.handle('summary')).body;
    const all = (await panel.handle('truncations', { limit: '100' })).body;
    assert.equal(summary.totals.truncations, all.page.total);
    assert.equal(summary.totals.truncations, 7);

    const one = (await panel.handle('truncations', { session: 's1', limit: '100' })).body;
    assert.equal(one.page.total, 4); // 1 legacy + 3 visible
    assert.deepEqual(one.kinds, { ledger: 1, visible: 3 });
    assert.ok(one.items.every((x) => x.sessionId.endsWith('s1')));
  } finally {
    await cleanup(fx.base);
  }
});

test('G2: shadowRecords counts .longlive/router-runtime.jsonl (regression: 86 vs 257)', async () => {
  // Real-machine shape: no root file, only the live .longlive one.
  const fx = await makeFixture({ rootRouter: 0, dotRouter: 194, filter: 86 });
  try {
    const panel = createPanel({ memoryRoot: fx.memory, sessionsRoot: fx.sessions });
    const summary = (await panel.handle('summary')).body;
    const shadow = (await panel.handle('shadow', { limit: '1' })).body;
    assert.equal(summary.totals.filterDecisions, 86);
    assert.equal(summary.totals.shadowRecords, 280); // 194 + 86
    assert.equal(summary.totals.shadowRecords, shadow.page.total);
    const routerFile = shadow.files.find((f) => f.path === '.longlive/router-runtime.jsonl');
    assert.ok(routerFile);
    assert.equal(routerFile.lines, 194);
  } finally {
    await cleanup(fx.base);
  }
});

test('G2: both router locations are summed, matching /shadow', async () => {
  const fx = await makeFixture({ rootRouter: 11, dotRouter: 194, filter: 86 });
  try {
    const panel = createPanel({ memoryRoot: fx.memory, sessionsRoot: fx.sessions });
    const summary = (await panel.handle('summary')).body;
    const shadow = (await panel.handle('shadow', { limit: '1' })).body;
    assert.equal(summary.totals.shadowRecords, 291); // 11 + 194 + 86
    assert.equal(summary.totals.shadowRecords, shadow.page.total);
  } finally {
    await cleanup(fx.base);
  }
});

test('G2: no router file still reports the filter count', async () => {
  const fx = await makeFixture({ rootRouter: 0, dotRouter: 0, filter: 86 });
  try {
    const panel = createPanel({ memoryRoot: fx.memory, sessionsRoot: fx.sessions });
    const summary = (await panel.handle('summary')).body;
    assert.equal(summary.totals.shadowRecords, 86);
  } finally {
    await cleanup(fx.base);
  }
});
