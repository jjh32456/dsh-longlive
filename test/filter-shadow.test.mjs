// 1.2.0 acceptance: the two passive observers write the panel contract shape.
//
// These are integration tests over real files in a temp memoryRoot. They never
// touch the owner's real memory root, never call an LLM, and never import a
// host package.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runFilter, parseJournal } from '../src/memory/filter-runner.js';
import { createRouterRuntime } from '../src/router/runtime.js';

const NOW = new Date('2026-11-05T10:00:00+08:00');
const SECRET = 'password: abcdef123456';

const JOURNAL = [
  '\uFEFF---',
  'title: 2026-11',
  'date: 2026-11-05',
  '---',
  '',
  '## 2026-11-05 · 过滤器与影子验收',
  '',
  '老大要求过滤器只读记忆文件，写 decisions jsonl，异常只记 warning，绝不阻断工具调用。',
  '',
  '- **影子记录必须只记录不执行**：route() 与 guard() 的判定追加到 router-runtime.jsonl，工具原值原样返回。',
  '',
  SECRET,
  '',
].join('\n');

function tempMemory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'longlive-filter-shadow-'));
  fs.mkdirSync(path.join(root, 'journal'), { recursive: true });
  fs.mkdirSync(path.join(root, 'topics'), { recursive: true });
  fs.writeFileSync(path.join(root, 'journal', '2026-11.md'), JOURNAL, 'utf8');
  fs.writeFileSync(
    path.join(root, 'topics', 'card.md'),
    '---\ntitle: card\n---\n\n影子记录是只读审计，不改变工具行为。\n',
    'utf8',
  );
  return root;
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

test('parseJournal: BOM is stripped and line numbers point at the journal body', () => {
  const units = parseJournal(JOURNAL);
  assert.equal(units.length, 3);
  assert.equal(units[0].lineStart, 8);
  assert.equal(units[0].lineEnd, 8);
  assert.equal(units[0].heading, '2026-11-05 · 过滤器与影子验收');
  assert.equal(units[0].date, '2026-11-05');
  assert.equal(units[1].lineStart, 10);
});

test('filter: writes decisions jsonl with every §5 field and never echoes a secret', () => {
  const root = tempMemory();
  const result = runFilter({ memoryRoot: root, now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.units, 3);
  assert.equal(result.appended, 3);

  const file = path.join(root, '.longlive', 'filter', 'decisions-2026-11-05.jsonl');
  assert.equal(fs.existsSync(file), true);
  const rows = readJsonl(file);
  assert.equal(rows.length, 3);

  const allowed = new Set(['remember', 'archive_only', 'human', 'local_only']);
  for (const row of rows) {
    for (const key of ['ts', 'unitId', 'turn', 'target', 'score', 'dims', 'hardSignals', 'privacy',
      'needsHuman', 'human', 'source', 'excerpt', 'dedup']) {
      assert.equal(Object.prototype.hasOwnProperty.call(row, key), true, `missing ${key}`);
    }
    assert.match(row.ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(row.unitId, /^[0-9a-f]{16}$/);
    assert.equal(row.turn, null);
    assert.equal(allowed.has(row.target), true);
    assert.equal(typeof row.score, 'number');
    assert.equal(row.dims.length, 8);
    assert.deepEqual(row.dims.map((dim) => dim.id), ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8']);
    for (const dim of row.dims) {
      assert.equal(typeof dim.name, 'string');
      assert.equal(typeof dim.score, 'number');
      assert.equal(typeof dim.max, 'number');
      assert.equal(typeof dim.why, 'string');
    }
    assert.equal(typeof row.privacy.verdict, 'string');
    assert.equal(typeof row.needsHuman, 'boolean');
    assert.deepEqual(Object.keys(row.human).sort(), ['note', 'verdict']);
    assert.equal(row.source.file, 'journal/2026-11.md');
    assert.equal(Number.isInteger(row.source.lineStart), true);
    assert.equal(Number.isInteger(row.source.lineEnd), true);
    assert.equal(row.excerpt, null);
    assert.equal(typeof row.dedup.delta, 'number');
    assert.equal(row.dedup.delta === -3 || row.dedup.delta === 0 || row.dedup.delta === 1, true);
    if (row.dedup.nearestUnitId !== null) assert.equal(typeof row.dedup.nearestUnitId, 'string');
  }

  const blocked = rows.find((row) => row.target === 'local_only');
  assert.ok(blocked, 'the privacy paragraph must become local_only');
  assert.equal(blocked.privacy.verdict, 'blocked');
  assert.equal(blocked.privacy.marker, 'V1_PRIVACY_BLOCK');
  assert.equal(blocked.excerpt, null);
  assert.equal(JSON.stringify(blocked).includes('abcdef123456'), false, 'secret leaked into the audit row');

  // Audit trail exists too; the panel only needs decisions-*.jsonl.
  assert.equal(fs.existsSync(path.join(root, '.longlive', 'filter', 'queue', '2026-11-05.json')), true);
  assert.equal(fs.existsSync(path.join(root, '.longlive', 'filter', 'state.json')), true);
  const runs = fs.readdirSync(path.join(root, '.longlive', 'filter', 'runs'));
  assert.equal(runs.length, 1);
  const run = JSON.parse(fs.readFileSync(path.join(root, '.longlive', 'filter', 'runs', runs[0]), 'utf8'));
  assert.equal(run.schemaVersion, 'maf-1');
  assert.equal(run.policy.version, 'maf-2');
  assert.equal(run.units.length, 3);
  assert.equal(run.counts.remember + run.counts.archive_only + run.counts.human + run.counts.local_only, 3);

  // Same day, second startup: nothing is appended twice.
  const again = runFilter({ memoryRoot: root, now: NOW });
  assert.equal(again.ok, true);
  assert.equal(again.appended, 0);
  assert.equal(readJsonl(file).length, 3);
});

test('shadow: recordAllTools writes the §6 contract fields and returns the tool value unchanged', async () => {
  const root = tempMemory();
  const runtime = createRouterRuntime({ mode: 'shadow', memoryRoot: root, recordAllTools: true });
  const expected = { ok: true, status: 'healthy' };
  const value = await runtime.intercept('session_health', { sessionId: 'test' }, async () => expected);
  assert.equal(value, expected, 'the exact object comes back');

  const file = path.join(root, '.longlive', 'router-runtime.jsonl');
  assert.equal(fs.existsSync(file), true);
  const [row] = readJsonl(file);
  assert.equal(row.mode, 'shadow');
  assert.equal(row.tool, 'session_health');
  assert.equal(row.subject, 'session_health');
  assert.equal(['allow', 'deny', 'ask'].includes(row.action), true);
  assert.equal(row.action, 'allow');
  assert.equal(row.status, 'ok');
  assert.equal(typeof row.callText, 'string');
  assert.equal(Array.isArray(row.errors), true);
  assert.equal(row.guard.verdict, 'allow');
  assert.equal(row.outcome.status, 'ok');
  assert.equal(typeof row.totalMs, 'number');
  assert.equal(typeof row.decision, 'object');
  assert.equal(fs.existsSync(path.join(root, 'router-runtime.jsonl')), false, 'must not write the legacy top-level path');
});

test('shadow: a failing record sink never changes the tool call', async () => {
  const root = tempMemory();
  // Make `.longlive` a file: creating the record directory must fail, but the
  // tool result is still returned and the error is swallowed into onError.
  fs.writeFileSync(path.join(root, '.longlive'), 'not a directory', 'utf8');
  const errors = [];
  const runtime = createRouterRuntime({
    mode: 'shadow',
    memoryRoot: root,
    recordAllTools: true,
    onError: (error) => errors.push(error),
  });
  const value = await runtime.intercept('memory_recall', { query: '过滤器' }, async () => 'cards');
  assert.equal(value, 'cards');
  assert.equal(errors.length > 0, true);
});
