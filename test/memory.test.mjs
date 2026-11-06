// Memory-layer acceptance tests (0.4.0).
//
// Wired into test/run.mjs after P6. Every fixture is created under the suite's
// TMP directory, so the P6 "package tree is unchanged" check stays honest.
// The cases map one-to-one to the acceptance list in the 0.4 research SPEC:
//   M1 index: dry-run / apply / completeness / idempotence / hand-written text
//   M2 consolidate: report only, cards and state untouched
//   M3 reinforce: +1, cap 9, backup, body byte-identical
//   M4 forget: dry-run writes nothing, confirm gate, tombstone before move
//   M5 out-of-bounds paths rejected with E_PATH_OUTSIDE_ROOT
//   M6 unset memoryRoot is an explicit error, never a guessed default
//   M7 frontmatter round-trip, empty values, multiline limit, malformed input
//   M8 state merge/backup, atomic rename/read-back rollback, corrupt JSON
//   M9 consolidate salience/target rules, excerpt, since and undated handling
//   M10 reinforce decay recovery across 0/1/many uses, strength cap and body preservation
//   M11 forget 90/365 boundaries, immune core, tombstone-before-move, move failure
//   M12 tool layer schemas and coded errors for invalid arguments
//   M13 BOM+CRLF cards survive update/reinforce, and a throwing read-back restores the backup
//   M14 a minimal card gains missing fields with a real EOL before the closing fence (LF/CRLF)
//   M15 salience 0..9, empty numerics default (3/3/0), junk/out-of-range are coded errors
//   M16 memory_* tool entries reject null/non-plain args and config with E_BAD_ARGUMENT
//   M17 multiline frontmatter values are refused on write and reported on read
//   M18 memory paths refuse junction/symlink escapes by real path
//   M19 same-millisecond consolidation report backups never overwrite each other
//   M20 affect markers: marked > heuristic > default, bad markers reported, never thrown
//   M21 proposal ids: repeat run yields 0 new ids; lastConsolidated only advances when all resolved
//   M22 forget rules: strict 89/90/91 and 364/365/366 boundaries, salience-5 immunity, dry-run zero writes
//   M23 forget confirm: scaffold created only on confirm, per-card backups, three-question epitaphs, one audit line
//   M24 procedures: save/get/list, frontmatter contract, same-slug merge (version +1, old bytes in backups)
//   M25 procedures: trigger keyword filter, report +1/-1 with cap 9 / floor 0, revisions untouched
//   M26 index: procedures/ scanned and counted, 「程序性」 table, rows == cards, idempotent apply
//   M27 procedures: absent/empty directory and broken/incomplete/legacy cards never throw and stay counted
//   M28 recall: mixed scoring, deterministic order, topK, room/status filters, locked cards, read-only
//   M29 recall: empty query is E_RECALL_EMPTY_QUERY; no match is E_RECALL_NO_MATCH with an empty list
//   M30 forget: a locked card is immune, stays byte-identical, and is reported as immune
//   M31 consolidate: a locked card is neither a merge target nor a merge source
//   M32 status/salience: default active, locked/archived accepted, illegal values are coded errors
//   M33 index: active/locked/archived counted separately in the result and the INDEX.md counter
//   M40 B3 provenance: source_session/source_turn/written_at on new cards, kept on merge
//   M41 B3 conflict: same-slug/same-title/same-key-opposite detected, unrelated cards ignored, old card not overwritten
//   M42 B3 manifest: sha256 baseline, changed/missing/untracked/corrupt/missing manifest reported, verify is read-only

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  memoryIndex, extractGeneratedSection, countGeneratedRows, BEGIN_GENERATED, END_GENERATED,
} from '../src/memory/index.js';
import { memoryConsolidate, contentTokens, paragraphUnits, pickQuote } from '../src/memory/consolidate.js';
import { memoryReinforce } from '../src/memory/reinforce.js';
import { memoryForget } from '../src/memory/forget.js';
import {
  parseFrontmatter, serializeFrontmatter, updateFrontmatter, appendLine,
  isRevLine, normalizedBody, countRevLines, daysBetween, DEFAULT_FIELDS,
} from '../src/memory/frontmatter.js';
import {
  readState, updateState, writeFileAtomic, appendAudit, backupFile,
  statePath, listMarkdownFiles,
} from '../src/memory/state.js';
import { resolveInside } from '../src/memory/paths.js';
import { detectConflicts, writeCard } from '../src/memory/cards.js';
import {
  manifestPath, readManifest, refreshManifest, verifyManifest,
} from '../src/memory/manifest.js';
import { TOOLS } from '../src/tools.js';

const FIXED_DAY = '2026-11-02';
const FIXED_NOW = new Date('2026-11-02T03:00:00Z');

function sha(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function fixture(base, name) {
  const dir = path.join(base, 'memory-cases', name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function put(root, rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
  return abs;
}

/** Map of relative path -> sha256 for every file, optionally skipping prefixes. */
function snapshot(root, skipPrefixes = []) {
  const map = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (skipPrefixes.some((prefix) => rel.startsWith(prefix))) continue;
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) map.set(rel, sha(fs.readFileSync(abs, 'utf8')));
    }
  };
  walk(root);
  return map;
}

function sameSnapshot(assert, before, after, label) {
  assert(before.size === after.size, `${label}: file count ${before.size} -> ${after.size}`);
  for (const [rel, hash] of before) {
    assert(after.has(rel), `${label}: file disappeared: ${rel}`);
    assert(after.get(rel) === hash, `${label}: file changed: ${rel}`);
  }
}

function stripStamp(section) {
  return section
    .split('\n')
    .filter((line) => !line.startsWith('<!-- generated:'))
    .join('\n');
}

function backupNames(root) {
  const dir = path.join(root, '.longlive', 'backups');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir);
}

/** Temporarily replace node:fs functions (system-call fault injection only). */
function withPatchedFs(patches, fn) {
  const saved = new Map();
  for (const [name, wrap] of Object.entries(patches)) {
    saved.set(name, fs[name]);
    fs[name] = wrap(fs[name].bind(fs));
  }
  try {
    return fn();
  } finally {
    for (const [name, original] of saved) fs[name] = original;
  }
}

/** Write a card with the fields the memory layer reads. */
function cardFile({
  title, salience = 3, strength = 3, lastUsed = null, revisions = 0,
  date = null, tags = [], body = '正文。', status = null, scope = null,
}) {
  return [
    '---',
    `title: ${title}`,
    ...(date ? [`date: ${date}`] : []),
    ...(tags.length ? [`tags: [${tags.join(', ')}]`] : []),
    ...(scope ? [`scope: ${scope}`] : []),
    ...(status ? [`status: ${status}`] : []),
    `salience: ${salience}`,
    `strength: ${strength}`,
    ...(lastUsed ? [`last_used: ${lastUsed}`] : []),
    `revisions: ${revisions}`,
    '---',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n');
}

function journalFile(day, lines) {
  return [
    '---',
    `title: ${day}`,
    `date: ${day}`,
    'salience: 3',
    'strength: 3',
    'revisions: 0',
    '---',
    '',
    ...lines,
    '',
  ].join('\n');
}

/**
 * An oracle that is deliberately NOT src/memory/frontmatter.js.
 *
 * When the test parsed the mutated card with the same parser that produced it,
 * a bug in that parser made both sides agree and the assertion proved nothing.
 * This reader knows only what these tests need: `key: value` lines between the
 * first two fences, everything after the second fence is the body. It also
 * accepts a legacy card with no frontmatter at all.
 */
function parseCardForAssertions(text) {
  const source = String(text).replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match) return { fields: {}, body: source };
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { fields, body: match[2] };
}

function invokeTool(tool, args, config) {
  try {
    return { ok: true, value: tool.invoke(args, config) };
  } catch (error) {
    return { ok: false, error };
  }
}

function assertCodedError(assert, result, code, label) {
  assert(result.ok === false, `${label}: expected an error, got a successful call`);
  const error = result.error;
  assert(error instanceof Error, `${label}: thrown value is not an Error`);
  assert(error.code === code, `${label}: expected ${code}, got ${error.code ?? '(no code)'}: ${error.message}`);
  assert(/^E_[A-Z_]+$/.test(error.code), `${label}: code ${error.code} is not a stable E_* code`);
  assert(error.name !== 'TypeError' && error.name !== 'ReferenceError', `${label}: raw ${error.name} escaped`);
  assert(typeof error.message === 'string' && error.message.length > 0, `${label}: empty error message`);
}

function m1Index(runCase, assert, expectCode, TMP) {
  runCase('M1', 'memory_index: dry-run, completeness, idempotence, hand-written text', () => {
    const root = fixture(TMP, 'm1-index');
    put(root, 'topics/记忆解剖.md', [
      '---',
      'title: 记忆解剖',
      'date: 2026-11-02',
      'tags: [memory, design]',
      'salience: 5',
      'strength: 4',
      'last_used: 2026-10-30',
      'revisions: 2',
      '---',
      '# 记忆解剖',
      '',
      'salience 5 是核心记忆。',
      '',
    ].join('\n'));
    put(root, 'topics/工程约定.md', [
      '---',
      'title: 工程约定',
      'date: 2026-10-20',
      'tags: [engineering]',
      'salience: 3',
      'strength: 3',
      'last_used: 2026-10-01',
      'revisions: 1',
      '---',
      '# 工程约定',
      '',
      '所有写入先备份。',
      '',
    ].join('\n'));
    put(root, 'journal/2026-11-01.md', [
      '---',
      'title: 今天的日志',
      'date: 2026-11-01',
      'salience: 2',
      'strength: 3',
      'last_used: 2026-11-01',
      'revisions: 0',
      '---',
      '# 今天的日志',
      '',
      '看了索引工具。',
      '',
    ].join('\n'));
    put(root, 'topics/legacy-one.md', '# 旧卡一\n\n没有 frontmatter 的旧卡。\n');
    put(root, 'journal/2026-10-31.md', '# 旧日志\n\n没有 frontmatter 的旧日志。\n');
    put(root, 'INDEX.md', [
      '# 记忆索引（手写）',
      '',
      '手写介绍，不许动。',
      '',
      BEGIN_GENERATED,
      '| 旧 | 旧 |',
      END_GENERATED,
      '',
      '底部手写：不要改。',
      '',
    ].join('\n'));

    const before = snapshot(root);
    const dry = memoryIndex({}, { memoryRoot: root, now: FIXED_NOW });
    assert(dry.dryRun === true && dry.applied === false, `dry-run flags: ${JSON.stringify({ dryRun: dry.dryRun, applied: dry.applied })}`);
    assert(dry.cards === 5, `expected 5 scanned cards, got ${dry.cards}`);
    assert(dry.legacy === 2, `expected 2 legacy cards, got ${dry.legacy}`);
    sameSnapshot(assert, before, snapshot(root), 'dry-run');

    const first = memoryIndex({ apply: true }, { memoryRoot: root, now: FIXED_NOW });
    assert(first.applied === true, 'first apply did not report applied');
    assert(first.cards === 5 && first.legacy === 2, `apply counts: cards=${first.cards} legacy=${first.legacy}`);
    const afterFirst = fs.readFileSync(path.join(root, 'INDEX.md'), 'utf8');
    assert(afterFirst.startsWith('# 记忆索引（手写）\n\n手写介绍，不许动。\n\n'), 'hand-written head was not preserved');
    assert(afterFirst.endsWith('\n\n底部手写：不要改。\n'), 'hand-written tail was not preserved');
    const section1 = extractGeneratedSection(afterFirst);
    assert(section1, 'generated section missing after apply');
    assert(countGeneratedRows(section1) === 5, `generated rows ${countGeneratedRows(section1)} != 5 cards`);
    for (const rel of ['topics/记忆解剖.md', 'topics/工程约定.md', 'journal/2026-11-01.md', 'topics/legacy-one.md', 'journal/2026-10-31.md']) {
      assert(section1.includes(rel), `generated section is missing card path ${rel}`);
    }
    assert(section1.includes('legacy: 2'), 'generated section does not count legacy cards');
    assert(backupNames(root).some((name) => name.startsWith('INDEX.') && name.endsWith('.md')), 'INDEX.md was not backed up');

    const later = new Date('2026-11-02T04:00:00Z');
    const second = memoryIndex({ apply: true }, { memoryRoot: root, now: later });
    assert(second.applied === true, 'second apply did not report applied');
    const afterSecond = fs.readFileSync(path.join(root, 'INDEX.md'), 'utf8');
    const section2 = extractGeneratedSection(afterSecond);
    assert(stripStamp(section1) === stripStamp(section2), 'generated section is not idempotent (only the timestamp may differ)');
    assert(afterSecond.startsWith('# 记忆索引（手写）\n\n手写介绍，不许动。\n\n'), 'hand-written head changed on second apply');
    assert(afterSecond.endsWith('\n\n底部手写：不要改。\n'), 'hand-written tail changed on second apply');

    const third = memoryIndex({ apply: true }, { memoryRoot: root, now: later });
    assert(third.changed === false, 'same-timestamp apply still reports changed:true');

    const state = JSON.parse(fs.readFileSync(path.join(root, '.longlive', 'memory-state.json'), 'utf8'));
    assert(state.indexBuiltAt === later.toISOString(), `indexBuiltAt ${state.indexBuiltAt} != ${later.toISOString()}`);
    const audit = fs.readFileSync(path.join(root, '.longlive', 'audit.log'), 'utf8').trim().split(/\r?\n/);
    assert(audit.length >= 2 && audit.every((line) => line.includes('memory_index')), 'audit.log should record each apply');
    return '5 cards (2 legacy), hand-written head/tail preserved, 2 applies byte-identical except timestamp';
  });
}

function m2Consolidate(runCase, assert, expectCode, TMP) {
  runCase('M2', 'memory_consolidate: proposals only, cards untouched, state records ids', () => {
    const root = fixture(TMP, 'm2-consolidate');
    put(root, 'topics/记忆解剖.md', [
      '---',
      'title: 记忆解剖',
      'tags: [memory, design]',
      'salience: 5',
      'strength: 4',
      'last_used: 2026-10-30',
      'revisions: 2',
      '---',
      '# 记忆解剖',
      '',
      '记忆解剖 讲 salience 与 strength 的关系。',
      '',
    ].join('\n'));
    put(root, 'topics/工程约定.md', [
      '---',
      'title: 工程约定',
      'tags: [engineering]',
      'salience: 3',
      'strength: 3',
      'last_used: 2026-10-01',
      'revisions: 1',
      '---',
      '# 工程约定',
      '',
      '工程约定：所有写入先备份。',
      '',
    ].join('\n'));
    put(root, 'journal/2026-10-01.md', [
      '---',
      'date: 2026-10-01',
      '---',
      '# 旧日志',
      '',
      '这条在增量起点之前，不该被读到。',
      '',
    ].join('\n'));
    put(root, 'journal/2026-11-01.md', [
      '---',
      'date: 2026-11-01',
      '---',
      '## 记录',
      '',
      '今天读了 记忆解剖，确认 salience 5 是核心记忆，决定保持。',
      '',
      '另一段：工程约定 里说所有写入先备份。',
      '',
    ].join('\n'));
    fs.mkdirSync(path.join(root, '.longlive'), { recursive: true });
    put(root, '.longlive/memory-state.json', `${JSON.stringify({
      lastConsolidated: '2026-10-15',
      indexBuiltAt: null,
      forgetRuns: [],
    }, null, 2)}\n`);

    const skip = ['.longlive/'];
    const before = snapshot(root, skip);
    const stateBefore = JSON.parse(fs.readFileSync(path.join(root, '.longlive', 'memory-state.json'), 'utf8'));
    const result = memoryConsolidate({}, { memoryRoot: root, now: FIXED_NOW, today: FIXED_DAY });
    assert(result.readOnly === true && result.stateUpdated === false, 'consolidate must report readOnly/stateUpdated:false');
    assert(result.proposals.length === 2, `expected 2 proposals, got ${result.proposals.length}`);
    for (const proposal of result.proposals) {
      assert(proposal.excerpt.length <= 120, `excerpt too long: ${proposal.excerpt.length}`);
      assert(proposal.suggestedSalience >= 1 && proposal.suggestedSalience <= 5, 'suggestedSalience out of range');
      assert(proposal.source === 'journal/2026-11-01.md', `proposal read from wrong journal: ${proposal.source}`);
      assert(proposal.salienceSource === 'heuristic' || proposal.salienceSource === 'default', `unexpected salienceSource: ${proposal.salienceSource}`);
    }
    const targets = result.proposals.map((proposal) => proposal.target).sort();
    assert(targets.join(',') === 'topics/工程约定.md,topics/记忆解剖.md', `unexpected targets: ${targets.join(',')}`);
    assert(fs.existsSync(result.reportPath), 'consolidate report was not written');
    const report = fs.readFileSync(result.reportPath, 'utf8');
    assert(report.includes('# 巩固提案') && report.includes('摘录：') && report.includes('建议 salience：'), 'report is missing required sections');
    const stateAfter = JSON.parse(fs.readFileSync(path.join(root, '.longlive', 'memory-state.json'), 'utf8'));
    assert(stateAfter.lastConsolidated === stateBefore.lastConsolidated, 'pending proposals must not advance lastConsolidated');
    assert(stateAfter.seenProposals.length === 2 && stateAfter.seenProposals.every((entry) => entry.status === 'proposed'), 'new proposal ids were not recorded as proposed');
    sameSnapshot(assert, before, snapshot(root, skip), 'consolidate');

    const applied = expectCode(
      () => memoryConsolidate({ apply: true }, { memoryRoot: root, now: FIXED_NOW }),
      'E_READ_ONLY',
    );
    assert(applied.message.includes('apply'), 'read-only error should mention apply');
    sameSnapshot(assert, before, snapshot(root, skip), 'consolidate apply:true');
    return '2 proposals from the incremental journal, report written, cards untouched, since pinned';
  });
}

function m3Reinforce(runCase, assert, TMP) {
  runCase('M3', 'memory_reinforce: +1, cap 9, backup, body byte-identical', () => {
    const root = fixture(TMP, 'm3-reinforce');
    const cardText = [
      '---',
      'title: 加固测试',
      'date: 2026-10-01',
      'salience: 3',
      'strength: 3',
      'last_used: 2026-10-01',
      'revisions: 1',
      '---',
      '# 加固测试',
      '',
      '正文第一段。',
      '',
      '正文第二段。',
      '',
    ].join('\n');
    put(root, 'topics/test.md', cardText);
    put(root, 'topics/cap.md', [
      '---',
      'title: 封顶测试',
      'salience: 4',
      'strength: 9',
      'last_used: 2026-09-01',
      'revisions: 4',
      '---',
      '# 封顶测试',
      '',
      '已经到顶的卡。',
      '',
    ].join('\n'));
    put(root, 'topics/legacy.md', '# 旧卡\n\n旧正文。\n');

    const original = fs.readFileSync(path.join(root, 'topics/test.md'), 'utf8');
    const result = memoryReinforce(
      { path: 'topics/test.md', reason: '测试使用' },
      { memoryRoot: root, now: FIXED_NOW, today: FIXED_DAY },
    );
    assert(result.before.strength === 3 && result.after.strength === 4, `strength ${result.before.strength}->${result.after.strength}`);
    assert(result.before.revisions === 1 && result.after.revisions === 2, `revisions ${result.before.revisions}->${result.after.revisions}`);
    assert(result.after.last_used === FIXED_DAY, `last_used ${result.after.last_used}`);
    assert(result.capped === false, 'capped should be false below 9');
    assert(result.bodyIdentical === true, 'bodyIdentical should be true');

    const updated = fs.readFileSync(path.join(root, 'topics/test.md'), 'utf8');
    const parsed = parseCardForAssertions(updated);
    assert(parsed.fields.strength === '4' && parsed.fields.revisions === '2' && parsed.fields.last_used === FIXED_DAY, 'written frontmatter is wrong');
    assert(updated.includes('正文第一段。\n\n正文第二段。\n'), 'prose body changed');
    assert(normalizedBody(parsed.body) === normalizedBody(parseCardForAssertions(original).body), 'normalized body differs');
    assert(countRevLines(parsed.body) === 1, 'exactly one rev line should be appended');
    assert(updated.includes('<!-- rev: 2026-11-02 测试使用 -->'), 'rev line missing the reason');
    const backups = backupNames(root).filter((name) => name.startsWith('test.'));
    assert(backups.length === 1, `expected one backup of test.md, got ${backups.length}`);
    assert(fs.readFileSync(path.join(root, '.longlive', 'backups', backups[0]), 'utf8') === original, 'backup bytes differ from the original');

    const capped = memoryReinforce({ path: 'topics/cap.md' }, { memoryRoot: root, now: FIXED_NOW, today: FIXED_DAY });
    assert(capped.after.strength === 9 && capped.capped === true, `cap failed: strength=${capped.after.strength} capped=${capped.capped}`);

    const legacyOriginal = '# 旧卡\n\n旧正文。\n';
    const legacy = memoryReinforce({ path: 'topics/legacy.md' }, { memoryRoot: root, now: FIXED_NOW, today: FIXED_DAY });
    assert(legacy.before.legacy === true, 'legacy card was not recognized');
    const legacyUpdated = fs.readFileSync(path.join(root, 'topics/legacy.md'), 'utf8');
    assert(legacyUpdated.startsWith('---\n'), 'legacy card did not get a frontmatter block');
    assert(legacyUpdated.includes(legacyOriginal), 'legacy body was not preserved');
    assert(normalizedBody(parseCardForAssertions(legacyUpdated).body) === normalizedBody(legacyOriginal), 'legacy body changed after migration');
    return 'strength 3->4, revisions 1->2, backup verified, cap 9 held, legacy body intact';
  });
}

function m4Forget(runCase, assert, expectCode, TMP) {
  runCase('M4', 'memory_forget: dry-run zero writes, confirm gate, tombstones before move', () => {
    const root = fixture(TMP, 'm4-forget');
    const card = (title, salience, strength, lastUsed, body) => [
      '---',
      `title: ${title}`,
      `salience: ${salience}`,
      `strength: ${strength}`,
      ...(lastUsed ? [`last_used: ${lastUsed}`] : []),
      'revisions: 1',
      '---',
      `# ${title}`,
      '',
      body,
      '',
    ].join('\n');
    put(root, 'topics/core.md', card('核心', 5, 1, '2020-01-01', '核心记忆不能被自动遗忘。'));
    put(root, 'topics/old.md', card('很久没用', 3, 1, '2024-01-01', '超过一年没用了。'));
    put(root, 'topics/stale.md', card('有点旧', 2, 1, '2026-05-01', '超过九十天且强度低。'));
    put(root, 'topics/fresh.md', card('还新鲜', 3, 5, '2026-10-30', '最近还在用。'));
    put(root, 'topics/undated.md', card('没日期', 3, 0, null, '没有 last_used。'));

    const before = snapshot(root);
    const dry = memoryForget({}, { memoryRoot: root, now: FIXED_NOW, today: FIXED_DAY });
    assert(dry.dryRun === true && dry.applied === false, 'forget default must be a dry-run');
    assert(dry.proposals.length === 2, `expected 2 proposals, got ${dry.proposals.length}`);
    assert(dry.immune.length === 1 && dry.immune[0].path === 'topics/core.md', 'salience 5 card is not immune');
    assert(dry.undated.length === 1, `expected 1 undated card, got ${dry.undated.length}`);
    sameSnapshot(assert, before, snapshot(root), 'forget dry-run');
    assert(!fs.existsSync(path.join(root, 'tombstones.md')), 'dry-run created tombstones.md');

    expectCode(() => memoryForget({ confirm: 'yes' }, { memoryRoot: root, now: FIXED_NOW, today: FIXED_DAY }), 'E_CONFIRM_REQUIRED');
    sameSnapshot(assert, before, snapshot(root), 'wrong confirm');

    const done = memoryForget({ confirm: 'FORGET' }, { memoryRoot: root, now: FIXED_NOW, today: FIXED_DAY });
    assert(done.applied === true && done.moved === 2, `execute moved=${done.moved}`);
    assert(!fs.existsSync(path.join(root, 'topics/old.md')), 'tombstoned card still in topics/');
    assert(!fs.existsSync(path.join(root, 'topics/stale.md')), 'demoted card still in topics/');
    assert(fs.existsSync(path.join(root, 'archive/tombstones/topics/old.md')), 'tombstoned card not under archive/tombstones/');
    assert(fs.existsSync(path.join(root, 'epochs/topics/stale.md')), 'demoted card not under epochs/');
    assert(fs.existsSync(path.join(root, 'topics/core.md')), 'immune card was touched');
    assert(fs.existsSync(path.join(root, 'topics/fresh.md')), 'fresh card was touched');
    const tombs = fs.readFileSync(path.join(root, 'tombstones.md'), 'utf8');
    const tombLines = tombs.split(/\r?\n/).filter((line) => line.startsWith('- '));
    assert(tombLines.length === 2, `tombstones.md has ${tombLines.length} lines, expected 2`);
    assert(tombLines.every((line) => line.includes('recoverable:')), 'tombstone line is missing the recoverable path');
    assert(done.tombstoneLines === 2, `result tombstoneLines=${done.tombstoneLines}`);
    const auditLines = fs.readFileSync(path.join(root, '.longlive', 'audit.log'), 'utf8').trim().split(/\r?\n/);
    assert(auditLines.length === 1 && auditLines[0].includes('memory_forget'), 'audit.log should have exactly one memory_forget line');
    const state = JSON.parse(fs.readFileSync(path.join(root, '.longlive', 'memory-state.json'), 'utf8'));
    assert(state.forgetRuns.length === 1 && state.forgetRuns[0].moved === 2, 'forgetRuns was not recorded');
    return 'dry-run wrote nothing; FORGET moved 2 cards, 2 tombstone lines, immune card intact';
  });
}

function m5PathGuard(runCase, assert, expectCode, TMP) {
  runCase('M5', 'memory paths: six escapes rejected with E_PATH_OUTSIDE_ROOT', () => {
    const root = fixture(TMP, 'm5-paths');
    put(root, 'topics/seed.md', '---\ntitle: seed\n---\n# seed\n');
    const attempts = [
      '../../../etc/passwd',
      '..\\..\\..\\Windows\\win.ini',
      'C:\\Windows\\win.ini',
      'D:\\outside\\x.md',
      '/etc/passwd',
      'topics/../../escape.md',
    ];
    for (const attempt of attempts) {
      const error = expectCode(
        () => memoryReinforce({ path: attempt }, { memoryRoot: root, today: FIXED_DAY }),
        'E_PATH_OUTSIDE_ROOT',
      );
      assert(error.message.includes('E_PATH_OUTSIDE_ROOT'), `message for ${attempt} lacks the code marker`);
    }
    return `${attempts.length} escaping paths rejected before any read/write`;
  });
}

function m6NoRoot(runCase, assert, expectCode) {
  runCase('M6', 'unset memoryRoot errors; legacy cards parse with defaults', () => {
    for (const [tool, call] of [
      ['memory_index', () => memoryIndex({}, { strictMemoryRoot: true })],
      ['memory_consolidate', () => memoryConsolidate({}, { strictMemoryRoot: true })],
      ['memory_reinforce', () => memoryReinforce({ path: 'topics/x.md' }, { strictMemoryRoot: true })],
      ['memory_forget', () => memoryForget({}, { strictMemoryRoot: true })],
    ]) {
      const error = expectCode(call, 'E_MEMORY_ROOT_UNSET');
      assert(error.message.includes('memoryRoot'), `${tool} error should name memoryRoot`);
    }

    const legacy = parseFrontmatter('# 旧卡\n\n旧正文。\n');
    assert(legacy.legacy === true && legacy.hasFrontmatter === false, 'legacy card not marked legacy');
    assert(legacy.fields.salience === 3 && legacy.fields.strength === 3 && legacy.fields.revisions === 0, 'legacy defaults are wrong');
    assert(Array.isArray(legacy.fields.tags) && legacy.fields.tags.length === 0, 'legacy tags default is wrong');
    const migrated = updateFrontmatter('# 旧卡\n\n旧正文。\n', { strength: 4 });
    assert(migrated.startsWith('---\n') && migrated.includes('strength: 4'), 'migration did not add frontmatter');
    assert(migrated.endsWith('# 旧卡\n\n旧正文。\n'), 'migration changed the legacy body');

    expectCode(() => parseFrontmatter('---\ntitle: x\n'), 'E_FRONTMATTER_UNTERMINATED');
    return 'all four tools refuse an unset root; legacy defaults and migration verified';
  });
}

function m7Frontmatter(runCase, assert, expectCode) {
  runCase('M7', 'frontmatter: round-trip, Chinese/colon, empty values, multiline limit, invalid input', () => {
    const fields = {
      title: '中文：冒号: 仍在值里',
      date: '2026-11-02',
      tags: ['记忆', '设计', 'x:y'],
      salience: 4,
      strength: 7,
      last_used: '2026-10-31',
      revisions: 3,
    };
    const extras = { owner: '听澜', 'custom-key': '值：含冒号' };
    const text = serializeFrontmatter(fields, extras);
    const parsed = parseFrontmatter(text);
    assert(parsed.hasFrontmatter && !parsed.legacy, 'serialized block was not recognized as frontmatter');
    assert(parsed.fields.title === fields.title, `title round-trip: ${JSON.stringify(parsed.fields.title)}`);
    assert(parsed.fields.tags.join('|') === fields.tags.join('|'), `tags round-trip: ${parsed.fields.tags.join('|')}`);
    assert(parsed.fields.salience === 4 && parsed.fields.strength === 7 && parsed.fields.revisions === 3, 'numeric fields changed');
    assert(parsed.extras.owner === '听澜' && parsed.extras['custom-key'] === extras['custom-key'], 'extras changed');
    assert(serializeFrontmatter(parsed.fields, parsed.extras) === text, 'serialize(parse(x)) != x');

    const crlfText = serializeFrontmatter(fields, extras, '\r\n');
    const crlfParsed = parseFrontmatter(crlfText);
    assert(crlfParsed.eol === '\r\n', `CRLF eol: ${JSON.stringify(crlfParsed.eol)}`);
    assert(serializeFrontmatter(crlfParsed.fields, crlfParsed.extras, crlfParsed.eol) === crlfText, 'CRLF round-trip changed bytes');

    const crlfCard = [
      '---',
      'title: 旧标题',
      'tags: [a, 设计]',
      'strength: 3',
      'last_used: 2026-10-01',
      'revisions: 1',
      'custom: keep-me',
      '---',
      '# 标题',
      '',
      '正文：含冒号。',
      '',
    ].join('\r\n');
    const updated = updateFrontmatter(crlfCard, { title: '新标题', strength: 6 });
    assert(updated.includes('title: 新标题\r\n') && updated.includes('strength: 6\r\n'), 'updated fields missing');
    assert(updated.includes('custom: keep-me\r\n'), 'unknown frontmatter key was dropped');
    assert(updated.endsWith('# 标题\r\n\r\n正文：含冒号。\r\n'), 'body bytes changed');
    assert(!updated.replace(/\r\n/g, '').includes('\n'), 'mixed EOL was introduced');
    const reparsed = parseCardForAssertions(updated);
    assert(reparsed.fields.title === '新标题' && reparsed.fields.strength === '6', 'updated fields do not parse');
    assert(updated.includes('tags: [a, 设计]\r\n') && updated.includes('revisions: 1\r\n'), 'untouched fields changed');
    assert(updated.includes('custom: keep-me\r\n'), 'extras did not survive the update');

    const lfCard = [
      '---', 'title: 要删', 'tags: [x]', 'strength: 2',
      'last_used: 2026-10-01', 'revisions: 0', '---', 'BODY', '',
    ].join('\n');
    const deleted = updateFrontmatter(lfCard, { title: null, tags: [] });
    assert(!deleted.includes('title:') && !deleted.includes('tags:'), 'deleted fields still present');
    assert(deleted.includes('strength: 2\n') && deleted.endsWith('BODY\n'), 'deleting fields damaged the card');
    const deletedParsed = parseCardForAssertions(deleted);
    assert(!('title' in deletedParsed.fields) && !('tags' in deletedParsed.fields), 'deleted fields still parse');

    assert(appendLine('a', 'b') === 'a\nb\n', 'appendLine LF');
    assert(appendLine('a\n', 'b') === 'a\nb\n', 'appendLine trailing LF');
    assert(appendLine('a\r\n', 'b') === 'a\r\nb\r\n', 'appendLine CRLF');
    assert(appendLine('', 'b') === 'b\n', 'appendLine empty');
    assert(isRevLine('<!-- rev: 2026-11-02 why -->') === true, 'canonical rev line not recognized');
    assert(isRevLine('  <!-- REV : x -->') === true, 'indented/case-insensitive rev line not recognized');
    assert(isRevLine('<!-- revx: no -->') === false, 'non-rev comment misdetected');
    const revBody = 'A\n<!-- rev: 1 x -->\n\nB\n\n';
    assert(countRevLines(revBody) === 1, 'rev line count');
    assert(normalizedBody(revBody) === 'A\n\nB', `normalizedBody: ${JSON.stringify(normalizedBody(revBody))}`);

    const empty = parseFrontmatter('---\ntitle:\ndate:\ntags:\nsalience:\nstrength:\nlast_used:\nrevisions:\nextra:\n---\nBODY');
    assert(empty.fields.title === null && empty.fields.date === null && empty.fields.last_used === null, 'empty string fields should be null');
    assert(empty.fields.tags.length === 0, 'empty tags should be []');
    assert(empty.fields.salience === DEFAULT_FIELDS.salience && empty.fields.strength === DEFAULT_FIELDS.strength, 'empty numerics must take defaults, not the clamp floor');
    assert(empty.fields.revisions === DEFAULT_FIELDS.revisions, 'empty revisions must take the default 0');
    assert(empty.extras.extra === '', 'empty unknown value should stay an empty string');
    const emptySerialized = serializeFrontmatter({ ...DEFAULT_FIELDS, tags: [] }, { extra: '' });
    const emptyRound = parseFrontmatter(`${emptySerialized}\nBODY`);
    assert(emptyRound.fields.salience === 3 && emptyRound.fields.strength === 3, 'defaults did not serialize/parse');
    assert(emptyRound.fields.title === null && emptyRound.fields.tags.length === 0, 'empty fields did not stay empty');

    expectCode(() => parseFrontmatter(42), 'E_BAD_ARGUMENT');
    expectCode(() => parseFrontmatter(null), 'E_BAD_ARGUMENT');
    expectCode(() => parseFrontmatter(undefined), 'E_BAD_ARGUMENT');
    expectCode(() => parseFrontmatter('---\ntitle: x\n'), 'E_FRONTMATTER_UNTERMINATED');
    const malformed = parseFrontmatter([
      '---', '9bad: x', 'bad key: x', 'no colon', 'title: "a: b"',
      'tags: [one, , two]', 'salience: 9', 'strength: -4', 'revisions: 1.9',
      'Extra-Key: kept', '# comment', '---', 'BODY',
    ].join('\n'));
    assert(malformed.fields.title === 'a: b', `quoted colon title: ${JSON.stringify(malformed.fields.title)}`);
    assert(malformed.fields.tags.join('|') === 'one|two', `tags holes: ${malformed.fields.tags.join('|')}`);
    assert(malformed.fields.salience === 9 && malformed.fields.strength === 0 && malformed.fields.revisions === 1, 'clamping failed');
    assert(malformed.extras['Extra-Key'] === 'kept' && !('9bad' in malformed.extras), 'bad keys leaked into extras');
    // status/salience are validated, not silently clamped: an out-of-range or
    // non-integer salience is a coded error, and so is an unknown status.
    expectCode(() => parseFrontmatter('---\nsalience: 99\n---\nBODY'), 'E_CARD_SALIENCE_INVALID');
    expectCode(() => parseFrontmatter('---\nsalience: -1\n---\nBODY'), 'E_CARD_SALIENCE_INVALID');
    expectCode(() => parseFrontmatter('---\nstatus: frozen\n---\nBODY'), 'E_CARD_STATUS_INVALID');

    // The on-disk format is single-line only. A continuation line is now a
    // coded error instead of being dropped silently, and the write side refuses
    // values containing CR/LF so a card can always round-trip.
    expectCode(() => parseFrontmatter('---\ntitle: 第一行\n  第二行\n---\nBODY'), 'E_FRONTMATTER_MULTILINE');
    expectCode(() => serializeFrontmatter({ ...DEFAULT_FIELDS, title: '第一行\n第二行' }, {}), 'E_BAD_ARGUMENT');
    expectCode(() => updateFrontmatter('---\ntitle: x\n---\nBODY', { title: 'a\nb' }), 'E_BAD_ARGUMENT');

    const bomText = '\uFEFF---\r\ntitle: 中文\r\ntags: [a, 设计]\r\ncustom: keep\r\n---\r\n# 标题\r\n\r\n正文：含冒号。\r\n';
    const bomParsed = parseFrontmatter(bomText);
    assert(bomParsed.bom === '\uFEFF' && bomParsed.eol === '\r\n', 'BOM/CRLF not detected');
    assert(bomParsed.fields.title === '中文' && bomParsed.fields.tags.join('|') === 'a|设计', 'BOM card fields changed');
    assert(bomParsed.extras.custom === 'keep', 'BOM card extras changed');
    assert(bomParsed.body.startsWith('# 标题\r\n'), 'BOM card body lost its heading');
    assert(bomParsed.text.slice(bomParsed.bodyStart) === bomParsed.body, 'bodyStart is not an index into text');
    // updateFrontmatter on a BOM card is covered by M13 (round-trip and rollback).
    return 'canonical/CRLF round-trip, deletion, empty values, multiline limit and malformed input covered';
  });
}

function m8State(runCase, assert, expectCode, TMP) {
  runCase('M8', 'state: defaults, merge/backup, atomic write rollback, corrupt state, audit/list', () => {
    const root = fixture(TMP, 'm8-state');
    const defaults = readState(root);
    assert(defaults.lastConsolidated === null && defaults.indexBuiltAt === null, 'missing state should give null fields');
    assert(Array.isArray(defaults.forgetRuns) && defaults.forgetRuns.length === 0, 'missing state should give empty forgetRuns');

    const first = updateState(root, { lastConsolidated: '2026-10-31' }, { now: FIXED_NOW });
    assert(first.write.created === true, 'first update should create the state file');
    assert(first.updatedAt === FIXED_NOW.toISOString(), 'updatedAt is not the injected clock');
    assert(readState(root).lastConsolidated === '2026-10-31', 'first update was not persisted');

    const second = updateState(root, { indexBuiltAt: '2026-11-02T01:00:00.000Z' }, { now: new Date('2026-11-02T04:00:00Z') });
    assert(second.write.created === false && second.write.backup, 'second update should back up the previous state');
    const merged = readState(root);
    assert(merged.lastConsolidated === '2026-10-31' && merged.indexBuiltAt === '2026-11-02T01:00:00.000Z', 'updateState did not merge');
    assert(backupNames(root).filter((name) => name.startsWith('memory-state.')).length === 1, 'state backup missing');

    const atomicAbs = put(root, 'topics/atomic.md', 'ORIGINAL\n');
    const rewrite = writeFileAtomic(root, 'topics/atomic.md', 'REPLACED\n', { now: FIXED_NOW });
    assert(rewrite.created === false && rewrite.bytes === 9 && rewrite.sha256 === sha('REPLACED\n'), 'rewrite result metadata wrong');
    assert(fs.readFileSync(atomicAbs, 'utf8') === 'REPLACED\n', 'rewrite did not land');
    assert(backupNames(root).some((name) => name.startsWith('atomic.')), 'rewrite did not back up the old bytes');
    const created = writeFileAtomic(root, 'topics/new-atomic.md', 'NEW\n', { now: FIXED_NOW });
    assert(created.created === true && fs.readFileSync(created.path, 'utf8') === 'NEW\n', 'create did not land');
    const leftovers = () => fs.readdirSync(path.join(root, 'topics')).filter((name) => name.includes('.tmp-'));
    assert(leftovers().length === 0, 'successful writes left tmp files');

    const beforeFailure = fs.readFileSync(atomicAbs, 'utf8');
    const backupsBefore = backupNames(root).length;
    const renameError = withPatchedFs({
      renameSync: () => () => { throw Object.assign(new Error('simulated rename EACCES'), { code: 'EACCES' }); },
    }, () => expectCode(() => writeFileAtomic(root, 'topics/atomic.md', 'HALF-WRITTEN\n', { now: FIXED_NOW }), 'EACCES'));
    assert(renameError.code === 'EACCES', 'rename fault did not surface its code');
    assert(fs.readFileSync(atomicAbs, 'utf8') === beforeFailure, 'failed rename changed the destination');
    assert(leftovers().length === 0, 'failed rename left a tmp file');
    assert(backupNames(root).length === backupsBefore + 1, 'failed write did not keep its pre-write backup');

    const beforeReadBack = fs.readFileSync(atomicAbs, 'utf8');
    let armed = false;
    const readBackError = withPatchedFs({
      renameSync: (orig) => (from, to) => {
        const result = orig(from, to);
        if (path.resolve(to) === path.resolve(atomicAbs)) armed = true;
        return result;
      },
      readFileSync: (orig) => (file, ...args) => {
        if (armed && path.resolve(String(file)) === path.resolve(atomicAbs)) {
          armed = false;
          return 'CORRUPTED READBACK';
        }
        return orig(file, ...args);
      },
    }, () => expectCode(() => writeFileAtomic(root, 'topics/atomic.md', 'SHOULD-ROLL-BACK\n', { now: FIXED_NOW }), 'E_WRITE_VERIFY'));
    assert(readBackError.code === 'E_WRITE_VERIFY', 'verify fault did not surface E_WRITE_VERIFY');
    assert(fs.readFileSync(atomicAbs, 'utf8') === beforeReadBack, 'read-back failure did not restore the original bytes');
    assert(leftovers().length === 0, 'read-back failure left a tmp file');

    put(root, 'topics/tamper.md', 'SOURCE\n');
    const tamperError = withPatchedFs({
      copyFileSync: (orig) => (from, to) => {
        orig(from, to);
        fs.writeFileSync(to, 'TAMPERED\n');
      },
    }, () => expectCode(() => backupFile(root, 'topics/tamper.md', { now: FIXED_NOW }), 'E_BACKUP_VERIFY'));
    assert(tamperError.code === 'E_BACKUP_VERIFY', 'tampered backup was accepted');
    assert(!backupNames(root).some((name) => name.startsWith('tamper.')), 'tampered backup copy was left behind');

    fs.writeFileSync(statePath(root), '{not json', 'utf8');
    expectCode(() => readState(root), 'E_STATE_CORRUPT');
    fs.writeFileSync(statePath(root), '[]', 'utf8');
    expectCode(() => readState(root), 'E_STATE_CORRUPT');
    fs.writeFileSync(statePath(root), 'null', 'utf8');
    const nullState = readState(root);
    assert(nullState.lastConsolidated === null && nullState.forgetRuns.length === 0, 'JSON null should behave like an empty state');

    const audit = appendAudit(root, { action: 'a\nb', object: 'obj\tx', result: 'ok\r\n', now: FIXED_NOW });
    const auditLines = fs.readFileSync(audit.path, 'utf8').trim().split(/\r?\n/);
    assert(auditLines.length === 1, `audit should write exactly one line, got ${auditLines.length}`);
    const parts = auditLines[0].split('\t');
    assert(parts.length === 4, `audit should have 4 tab-separated fields, got ${parts.length}`);
    assert(parts[0] === FIXED_NOW.toISOString(), 'audit timestamp wrong');
    assert(parts[1] === 'a b' && parts[2] === 'obj x' && parts[3].trim() === 'ok', 'audit newlines/tabs were not sanitized');

    put(root, 'topics/nested/deep.md', 'DEEP\n');
    put(root, 'topics/skip.txt', 'TXT\n');
    put(root, 'topics/.hidden.md', 'HIDDEN\n');
    const listed = listMarkdownFiles(root, 'topics').map((abs) => path.relative(root, abs).split(path.sep).join('/'));
    assert(listed.includes('topics/atomic.md') && listed.includes('topics/nested/deep.md'), 'recursive listing missed a card');
    assert(!listed.includes('topics/skip.txt') && !listed.some((rel) => rel.includes('.hidden')), 'listing did not skip non-md/dot files');
    assert(listMarkdownFiles(root, 'missing').length === 0, 'missing directory should list nothing');
    return 'state merge, backup, rename/read-back failures, corrupt JSON, audit sanitization and recursive listing covered';
  });
}

function m9ConsolidateRules(runCase, assert, expectCode, TMP) {
  runCase('M9', 'consolidate: salience rules, target scoring, excerpt, since/undated, report only', () => {
    const root = fixture(TMP, 'm9-consolidate-rules');
    put(root, 'topics/记忆解剖.md', [
      '---',
      'title: 记忆解剖',
      'date: 2026-10-20',
      'tags: [memory, design]',
      'salience: 5',
      'strength: 4',
      'last_used: 2026-10-30',
      'revisions: 2',
      '---',
      '# 记忆解剖',
      '',
      'salience 与 strength 是记忆的两个维度。',
      '',
    ].join('\n'));
    put(root, 'topics/工程约定.md', [
      '---',
      'title: 工程约定',
      'date: 2026-10-20',
      'tags: [engineering]',
      'salience: 3',
      'strength: 3',
      'last_used: 2026-10-01',
      'revisions: 1',
      '---',
      '# 工程约定',
      '',
      '所有写入先备份，命名用中文。',
      '',
    ].join('\n'));
    put(root, 'journal/2026-10-31.md', [
      '---',
      'date: 2026-10-31',
      '---',
      '# 旧日志',
      '',
      '这条在增量起点之前，不该被读到。',
      '',
    ].join('\n'));
    put(root, 'journal/2026-11-01.md', [
      '# 记录',
      '',
      '铁律：永远不许骗他，这是必须守住的底线。',
      '',
      '## 小标题',
      '',
      '决定：所有写入先备份。',
      '',
      '<!-- 备注：不该出现 -->',
      '',
      '记忆解剖里的 salience 与 design 标签要保留。',
      '',
      '随手记：明天买牛奶。',
      '',
      `这一段是流水账。\n${'内容'.repeat(80)}`,
      '',
    ].join('\n'));
    put(root, 'journal/undated.md', [
      '# 无日期',
      '',
      '没有日期的段落。',
      '',
    ].join('\n'));
    put(root, '.longlive/memory-state.json', `${JSON.stringify({
      lastConsolidated: '2026-10-31T12:00:00.000Z',
      indexBuiltAt: null,
      forgetRuns: [],
    }, null, 2)}\n`);

    const config = { memoryRoot: root, now: FIXED_NOW, today: FIXED_DAY };
    const skip = ['.longlive/'];
    const before = snapshot(root, skip);
    const result = memoryConsolidate({}, config);
    assert(result.since === '2026-10-31', `state timestamp should reduce to 2026-10-31, got ${result.since}`);
    assert(result.entries === 5, `expected 5 read paragraphs, got ${result.entries}`);
    assert(result.proposals.length === 5, `expected 5 proposals, got ${result.proposals.length}`);
    assert(result.undated.length === 1 && result.undated[0].source === 'journal/undated.md', 'undated paragraph not isolated');

    const proposals = result.proposals;
    assert(proposals.map((item) => item.suggestedSalience).join(',') === '5,4,3,2,3', `salience rules: ${proposals.map((item) => item.suggestedSalience).join(',')}`);
    assert(proposals.map((item) => item.lineStart).join(',') === '3,7,11,13,15', `unit line numbers: ${proposals.map((item) => item.lineStart).join(',')}`);
    assert(proposals[0].target === null && proposals[0].reason.includes('建议新建卡'), `铁律 paragraph should not match a card: ${proposals[0].reason}`);
    assert(proposals[1].target === 'topics/工程约定.md' && proposals[1].targetTitle === '工程约定', `backup paragraph target: ${proposals[1].target}`);
    assert(proposals[1].reason.startsWith('原文引用『') && proposals[1].reason.includes('话题命中'), `backup paragraph reason: ${proposals[1].reason}`);
    assert(proposals[2].target === 'topics/记忆解剖.md' && proposals[2].targetTitle === '记忆解剖', `memory paragraph target: ${proposals[2].target}`);
    assert(proposals[2].reason.includes('原文引用') && proposals[2].reason.includes('话题命中'), `memory paragraph reason: ${proposals[2].reason}`);
    assert(proposals[2].quote === '记忆解剖里的 salience 与 design 标签要保留。', `quote must be the routed sentence: ${proposals[2].quote}`);
    assert(proposals[3].target === null && proposals[4].target === null, 'low-value paragraphs should not force a target');
    assert(proposals[4].excerpt === proposals[4].claim.slice(0, 120) && proposals[4].claim.length > 0, `excerpt must derive from the claim sentence: ${proposals[4].excerpt.slice(0, 40)}`);
    assert(proposals.every((item) => item.excerpt.length <= 120 && !item.excerpt.includes('\n')), 'excerpt length/newlines');
    assert(proposals.every((item) => item.quote === null || item.quote.length <= 120), 'quote length');
    assert(proposals.every((item) => item.source === 'journal/2026-11-01.md' && item.date === '2026-11-01'), 'journal date fallback is wrong');
    assert(proposals.every((item) => !item.excerpt.startsWith('#') && !item.excerpt.includes('<!--')), 'headings/comments leaked into excerpts');

    const reportAbs = path.join(root, '.longlive', 'reports', 'consolidate-2026-11-02.md');
    assert(result.reportRel === '.longlive/reports/consolidate-2026-11-02.md', `reportRel: ${result.reportRel}`);
    assert(fs.existsSync(reportAbs), 'report file was not written');
    const report = fs.readFileSync(reportAbs, 'utf8');
    assert(report.includes('提案') && report.includes('topics/记忆解剖.md') && report.includes('建议 salience'), 'report is missing proposal details');
    assert(report.includes('- 原文引用：') && report.includes('- 结论句：') && report.includes('- 行号：3'), 'report is missing quote/claim/line details');
    assert(result.sha256 === sha(report), 'report sha256 does not match the file');
    sameSnapshot(assert, before, snapshot(root, skip), 'consolidate report-only');
    const stateAfterFirst = JSON.parse(fs.readFileSync(path.join(root, '.longlive', 'memory-state.json'), 'utf8'));
    assert(stateAfterFirst.lastConsolidated === '2026-10-31T12:00:00.000Z', 'consolidate advanced memory-state.json with unresolved proposals');
    assert(stateAfterFirst.seenProposals.length === 5 && stateAfterFirst.seenProposals.every((entry) => entry.status === 'proposed'), 'proposal ids were not recorded');

    expectCode(() => memoryConsolidate({ apply: true }, config), 'E_READ_ONLY');

    const second = memoryConsolidate({ since: '2026-11-01' }, config);
    assert(second.since === '2026-11-01' && second.entries === 0 && second.proposals.length === 0, 'explicit since did not cut the journal');
    assert(second.undated.length === 1, 'undated paragraph should survive an explicit since');
    const backupDir = path.join(root, '.longlive', 'reports', '.backups');
    assert(fs.existsSync(backupDir) && fs.readdirSync(backupDir).length === 1, 'overwriting the report did not back it up');

    const invalidSince = memoryConsolidate({ since: 'not-a-day' }, config);
    assert(invalidSince.since === null, `invalid since should fall back to null, got ${invalidSince.since}`);
    assert(invalidSince.entries === 7, `invalid since should scan everything, got ${invalidSince.entries} paragraphs`);
    assert(invalidSince.proposals.length === 2 && invalidSince.duplicatesSuppressed === 5,
      `invalid since should only emit unseen paragraphs: ${invalidSince.proposals.length} new / ${invalidSince.duplicatesSuppressed} seen`);
    assert(invalidSince.undated.length === 0, 'invalid since has no incremental start, so nothing is "undated"');
    // A fixed clock makes all three reports share one timestamp. The backup name
    // must still disambiguate, or the third call silently eats the second
    // call's backup.
    const backups = fs.readdirSync(backupDir).sort();
    assert(backups.length === 2, `fixed-clock report backups must not collide, got ${backups.length}`);
    assert(new Set(backups).size === 2, 'report backup names are not unique');
    const backupTexts = backups.map((name) => fs.readFileSync(path.join(backupDir, name), 'utf8'));
    assert(backupTexts.some((text) => text.includes('增量起点：2026-10-31')), 'first report backup was lost');
    assert(backupTexts.some((text) => text.includes('增量起点：2026-11-01')), 'second report backup was lost');
    sameSnapshot(assert, before, snapshot(root, skip), 'consolidate since variants');
    return '5 proposals mapped to expected targets/salience; since, dedup, undated, report backup and read-only guard covered';
  });
}

function m10ReinforceDecay(runCase, assert, TMP) {
  runCase('M10', 'reinforce: 0/1/many uses, decay recovery, cap 9, body preserved', () => {
    const root = fixture(TMP, 'm10-decay');
    put(root, 'topics/heat.md', cardFile({ title: '热卡', strength: 2, lastUsed: '2026-08-01', body: '热卡正文。' }));
    put(root, 'topics/ancient-used.md', cardFile({ title: '老卡', strength: 4, lastUsed: '2024-01-01', body: '老卡正文。' }));
    const config = { memoryRoot: root, now: FIXED_NOW, today: FIXED_DAY };

    const heatAbs = path.join(root, 'topics/heat.md');
    const originalBody = parseCardForAssertions(fs.readFileSync(heatAbs, 'utf8')).body;
    const dry0 = memoryForget({}, config);
    const heat0 = dry0.proposals.find((item) => item.path === 'topics/heat.md');
    const ancient0 = dry0.proposals.find((item) => item.path === 'topics/ancient-used.md');
    assert(heat0 && heat0.kind === 'epochs' && heat0.ageDays === 93, `93-day card: ${JSON.stringify(heat0)}`);
    assert(ancient0 && ancient0.kind === 'tombstone', 'two-year card should be a tombstone proposal');
    assert(parseCardForAssertions(fs.readFileSync(heatAbs, 'utf8')).fields.strength === '2', '0 uses must not change strength');

    const heat1 = memoryReinforce({ path: 'topics/heat.md', reason: '第一次真实使用' }, config);
    assert(heat1.before.strength === 2 && heat1.after.strength === 3, 'one use should add exactly 1 strength');
    assert(heat1.after.last_used === FIXED_DAY && heat1.after.revisions === 1, 'one use should refresh last_used and revisions');
    assert(heat1.capped === false && heat1.bodyIdentical === true, 'one use should not cap or touch the body');
    const dry1Heat = memoryForget({}, config);
    assert(!dry1Heat.proposals.some((item) => item.path === 'topics/heat.md'), 'one citation did not clear the decay proposal');
    assert(dry1Heat.proposals.some((item) => item.path === 'topics/ancient-used.md'), 'untouched old card should still be proposed');

    const ancient1 = memoryReinforce({ path: 'topics/ancient-used.md', reason: '重新使用' }, config);
    assert(ancient1.after.last_used === FIXED_DAY && ancient1.after.strength === 5, 'old card did not recover after a citation');
    const dry1 = memoryForget({}, config);
    assert(dry1.proposals.length === 0, `both cards should be safe now, got ${dry1.proposals.length}`);

    const strengths = [heat1.after.strength];
    let cappedAt = null;
    for (let call = 2; call <= 9; call += 1) {
      const result = memoryReinforce({ path: 'topics/heat.md', reason: `第${call}次引用` }, config);
      strengths.push(result.after.strength);
      if (result.capped && cappedAt === null) cappedAt = call;
    }
    assert(strengths.join(',') === '3,4,5,6,7,8,9,9,9', `strength sequence: ${strengths.join(',')}`);
    assert(cappedAt === 8, `capped flag first true at call ${cappedAt}`);

    const finalCard = parseCardForAssertions(fs.readFileSync(heatAbs, 'utf8'));
    assert(finalCard.fields.strength === '9' && finalCard.fields.revisions === '9', `final fields: strength=${finalCard.fields.strength} revisions=${finalCard.fields.revisions}`);
    assert(finalCard.fields.salience === '3' && finalCard.fields.last_used === FIXED_DAY, 'salience/last_used changed unexpectedly');
    assert(countRevLines(finalCard.body) === 9, `rev lines: ${countRevLines(finalCard.body)}`);
    assert(normalizedBody(finalCard.body) === normalizedBody(originalBody), 'reinforce changed the prose body');
    assert(memoryForget({}, config).proposals.length === 0, 'repeated citations should keep the card safe');
    return '0/1/9 citations: 93-day proposal clears after one use, strength caps at 9, body byte-identical';
  });
}

function m11ForgetThresholds(runCase, assert, expectCode, TMP) {
  runCase('M11', 'forget: 90/365 boundaries, immune core, tombstone-before-move, failure state', () => {
    const root = fixture(TMP, 'm11-thresholds');
    const cards = {
      'topics/age90.md': cardFile({ title: '九十天', strength: 1, lastUsed: '2026-08-04', body: '刚好九十天。' }),
      'topics/age91low.md': cardFile({ title: '九十一天低', strength: 2, lastUsed: '2026-08-03', body: '低强度。' }),
      'topics/age91high.md': cardFile({ title: '九十一天高', strength: 3, lastUsed: '2026-08-03', body: '高强度。' }),
      'topics/age365low.md': cardFile({ title: '一年低', strength: 1, lastUsed: '2025-11-02', body: '一年低强度。' }),
      'topics/age365high.md': cardFile({ title: '一年高', strength: 9, lastUsed: '2025-11-02', body: '一年高强度。' }),
      'topics/age366.md': cardFile({ title: '超过一年', strength: 9, lastUsed: '2025-11-01', body: '超过一年。' }),
      'topics/core.md': cardFile({ title: '核心', salience: 5, strength: 0, lastUsed: '2020-01-01', body: '核心记忆。' }),
      'topics/undated.md': cardFile({ title: '没日期', strength: 0, body: '没有 last_used。' }),
      'topics/fresh.md': cardFile({ title: '新鲜', strength: 0, lastUsed: '2026-11-01', body: '昨天用过。' }),
    };
    const originals = new Map();
    for (const [rel, text] of Object.entries(cards)) {
      put(root, rel, text);
      originals.set(rel, text);
    }
    const config = { memoryRoot: root, now: FIXED_NOW, today: FIXED_DAY };
    const before = snapshot(root);
    const dry = memoryForget({}, config);
    assert(dry.proposals.length === 3, `expected 3 proposals, got ${dry.proposals.length}`);
    assert(dry.proposals.map((item) => item.path).join(',') === 'topics/age366.md,topics/age365low.md,topics/age91low.md', `proposal order: ${dry.proposals.map((item) => item.path).join(',')}`);
    assert(dry.proposals.map((item) => item.kind).join(',') === 'tombstone,epochs,epochs', 'kind mapping is wrong');
    assert(dry.proposals[1].ageDays === 365 && dry.proposals[2].ageDays === 91, 'age boundaries are off');
    assert(!dry.proposals.some((item) => ['topics/age90.md', 'topics/age91high.md', 'topics/age365high.md', 'topics/fresh.md'].includes(item.path)), 'a below-threshold card was proposed');
    assert(dry.immune.length === 1 && dry.immune[0].path === 'topics/core.md', 'core memory is not immune');
    assert(dry.undated.length === 1 && dry.undated[0].path === 'topics/undated.md', 'undated card handling is wrong');
    sameSnapshot(assert, before, snapshot(root), 'forget boundary dry-run');
    assert(!fs.existsSync(path.join(root, 'tombstones.md')), 'dry-run wrote tombstones.md');

    const done = memoryForget({ confirm: 'FORGET' }, config);
    assert(done.applied === true && done.moved === 3 && done.tombstoneLines === 3, `execute moved=${done.moved} lines=${done.tombstoneLines}`);
    assert(fs.existsSync(path.join(root, 'archive/tombstones/topics/age366.md')), 'tombstoned card missing');
    assert(fs.existsSync(path.join(root, 'epochs/topics/age365low.md')), '365-day low-strength card missing');
    assert(fs.existsSync(path.join(root, 'epochs/topics/age91low.md')), '91-day low-strength card missing');
    assert(fs.readFileSync(path.join(root, 'archive/tombstones/topics/age366.md'), 'utf8') === originals.get('topics/age366.md'), 'tombstone copy changed bytes');
    assert(fs.readFileSync(path.join(root, 'epochs/topics/age365low.md'), 'utf8') === originals.get('topics/age365low.md'), 'epochs copy changed bytes');
    for (const rel of ['topics/age90.md', 'topics/age91high.md', 'topics/age365high.md', 'topics/core.md', 'topics/undated.md', 'topics/fresh.md']) {
      assert(fs.existsSync(path.join(root, rel)), `below-threshold/immune card disappeared: ${rel}`);
    }
    const tombLines = fs.readFileSync(path.join(root, 'tombstones.md'), 'utf8').split(/\r?\n/).filter((line) => line.startsWith('- '));
    assert(tombLines.length === 3, `tombstones.md has ${tombLines.length} lines`);
    assert(tombLines.every((line) => line.includes('recoverable:')), 'tombstone line lacks a recoverable path');
    assert(!tombLines.some((line) => line.includes('core.md')), 'immune core card got a tombstone line');
    const state = JSON.parse(fs.readFileSync(statePath(root), 'utf8'));
    assert(state.forgetRuns.length === 1 && state.forgetRuns[0].moved === 3, 'forgetRuns not recorded');
    assert(fs.readFileSync(path.join(root, '.longlive', 'audit.log'), 'utf8').trim().split(/\r?\n/).length === 1, 'audit line missing');

    const noopRoot = fixture(TMP, 'm11-noop');
    put(noopRoot, 'topics/age90.md', cards['topics/age90.md']);
    const noopBefore = snapshot(noopRoot);
    const noop = memoryForget({ confirm: 'FORGET' }, { memoryRoot: noopRoot, now: FIXED_NOW, today: FIXED_DAY });
    assert(noop.status === 'noop' && noop.applied === false && noop.moved === 0, `noop status=${noop.status} moved=${noop.moved}`);
    sameSnapshot(assert, noopBefore, snapshot(noopRoot), 'noop forget');
    assert(!fs.existsSync(path.join(noopRoot, 'tombstones.md')), 'noop forget wrote tombstones.md');
    assert(!fs.existsSync(statePath(noopRoot)), 'noop forget wrote state');
    assert(!fs.existsSync(path.join(noopRoot, '.longlive', 'audit.log')), 'noop forget wrote audit');

    const orderRoot = fixture(TMP, 'm11-order');
    put(orderRoot, 'topics/ancient.md', cards['topics/age366.md']);
    let captured = null;
    withPatchedFs({
      renameSync: (orig) => (from, to) => {
        if (String(from).endsWith('ancient.md')) {
          const tomb = path.join(orderRoot, 'tombstones.md');
          captured = {
            sourceExists: fs.existsSync(from),
            tomb: fs.existsSync(tomb) ? fs.readFileSync(tomb, 'utf8') : '',
            to,
          };
        }
        return orig(from, to);
      },
    }, () => memoryForget({ confirm: 'FORGET' }, { memoryRoot: orderRoot, now: FIXED_NOW, today: FIXED_DAY }));
    assert(captured, 'card move was never observed');
    assert(captured.sourceExists === true, 'source card vanished before the move');
    assert(captured.tomb.includes('topics/ancient.md') && captured.tomb.includes('recoverable: archive/tombstones/topics/ancient.md'), 'tombstone line was not written before the move');
    assert(String(captured.to).endsWith(path.join('archive', 'tombstones', 'topics', 'ancient.md')), `unexpected archive destination: ${captured.to}`);

    const failRoot = fixture(TMP, 'm11-move-fail');
    put(failRoot, 'topics/ancient.md', cards['topics/age366.md']);
    const moveError = withPatchedFs({
      renameSync: (orig) => (from, to) => {
        if (String(from).endsWith('ancient.md')) {
          throw Object.assign(new Error('simulated move failure'), { code: 'EACCES' });
        }
        return orig(from, to);
      },
    }, () => expectCode(() => memoryForget({ confirm: 'FORGET' }, { memoryRoot: failRoot, now: FIXED_NOW, today: FIXED_DAY }), 'E_FORGET_MOVE'));
    assert(moveError.message.includes('墓碑已写'), 'move failure should name the written tombstone');
    assert(fs.existsSync(path.join(failRoot, 'topics/ancient.md')), 'move failure lost the source card');
    assert(!fs.existsSync(path.join(failRoot, 'archive/tombstones/topics/ancient.md')), 'move failure produced an archive copy');
    assert(fs.readFileSync(path.join(failRoot, 'tombstones.md'), 'utf8').includes('topics/ancient.md'), 'move failure did not leave a tombstone line');
    assert(!fs.existsSync(statePath(failRoot)), 'move failure wrote state');
    assert(!fs.existsSync(path.join(failRoot, '.longlive', 'audit.log')), 'move failure wrote audit');
    return '90/365 boundaries, core immunity, tombstone-before-move and move-failure state covered';
  });
}

function m12ToolErrors(runCase, assert, expectCode, TMP) {
  runCase('M12', 'tool layer: memory_* schemas and coded errors for invalid arguments', () => {
    const root = fixture(TMP, 'm12-tools');
    put(root, 'topics/valid.md', cardFile({ title: '有效卡', strength: 2, lastUsed: FIXED_DAY }));
    const notDir = path.join(TMP, 'm12-not-a-directory');
    fs.writeFileSync(notDir, 'not a dir', 'utf8');
    const missingRoot = path.join(TMP, 'm12-root-does-not-exist');
    fs.rmSync(missingRoot, { recursive: true, force: true });

    const names = TOOLS.filter((tool) => tool.name.startsWith('memory_')).map((tool) => tool.name);
    assert(TOOLS.length === 22, `TOOLS length ${TOOLS.length} != 22`);
    assert(names.join(',') === 'memory_index,memory_consolidate,memory_reinforce,memory_forget,memory_procedure,memory_recall', `memory tool order: ${names.join(',')}`);
    const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));
    const expectedParams = {
      memory_index: ['apply'],
      memory_consolidate: ['since'],
      memory_reinforce: ['path', 'reason'],
      memory_forget: ['confirm'],
      memory_procedure: ['action', 'name', 'slug', 'trigger', 'steps', 'outcome', 'reason', 'limit'],
      memory_recall: ['query', 'topK', 'room', 'status'],
    };
    for (const [name, keys] of Object.entries(expectedParams)) {
      const tool = byName.get(name);
      assert(typeof tool?.invoke === 'function', `${name}: missing invoke`);
      assert(typeof tool.description === 'string' && tool.description.length > 20, `${name}: description missing`);
      assert(tool.parameters && typeof tool.parameters === 'object', `${name}: parameters missing`);
      for (const key of keys) {
        assert(tool.parameters[key] && typeof tool.parameters[key].type === 'string', `${name}.${key}: schema entry missing`);
      }
      assert(tool.output && tool.output.schema && typeof tool.output.render === 'function', `${name}: output schema/render missing`);
    }
    assert(byName.get('memory_reinforce').parameters.path.type === 'string', 'path must be a string');
    assert(byName.get('memory_forget').parameters.confirm.type === 'string', 'confirm must be a string');

    const cases = [
      ['memory_index', {}, { strictMemoryRoot: true }, 'E_MEMORY_ROOT_UNSET'],
      ['memory_index', {}, { memoryRoot: missingRoot }, 'E_MEMORY_ROOT_MISSING'],
      ['memory_index', {}, { memoryRoot: notDir }, 'E_MEMORY_ROOT_NOT_DIR'],
      ['memory_consolidate', { apply: true }, { memoryRoot: root }, 'E_READ_ONLY'],
      ['memory_reinforce', {}, { memoryRoot: root }, 'E_BAD_ARGUMENT'],
      ['memory_reinforce', { path: '   ' }, { memoryRoot: root }, 'E_BAD_ARGUMENT'],
      ['memory_reinforce', { path: 123 }, { memoryRoot: root }, 'E_BAD_ARGUMENT'],
      ['memory_reinforce', { path: '../escape.md' }, { memoryRoot: root }, 'E_PATH_OUTSIDE_ROOT'],
      ['memory_reinforce', { path: 'topics/missing.md' }, { memoryRoot: root }, 'E_CARD_NOT_FOUND'],
      ['memory_forget', { confirm: 'nope' }, { memoryRoot: root }, 'E_CONFIRM_REQUIRED'],
      ['memory_forget', { confirm: 42 }, { memoryRoot: root }, 'E_CONFIRM_REQUIRED'],
      ['memory_procedure', {}, { memoryRoot: root }, 'E_BAD_ARGUMENT'],
      ['memory_procedure', { action: 'nope' }, { memoryRoot: root }, 'E_BAD_ARGUMENT'],
      ['memory_procedure', { action: 'save' }, { memoryRoot: root }, 'E_BAD_ARGUMENT'],
      ['memory_procedure', { action: 'save', name: '无步骤', when: '某个时刻' }, { memoryRoot: root }, 'E_BAD_ARGUMENT'],
      ['memory_procedure', { action: 'get', slug: '../escape' }, { memoryRoot: root }, 'E_BAD_ARGUMENT'],
      ['memory_procedure', { action: 'get', slug: 'missing' }, { memoryRoot: root }, 'E_PROCEDURE_NOT_FOUND'],
      ['memory_procedure', { action: 'report', slug: 'missing', outcome: 'success' }, { memoryRoot: root }, 'E_PROCEDURE_NOT_FOUND'],
    ];
    const before = snapshot(root);
    for (const [name, args, config, code] of cases) {
      assertCodedError(assert, invokeTool(byName.get(name), args, config), code, `${name} ${JSON.stringify(args)}`);
    }
    sameSnapshot(assert, before, snapshot(root), 'failed tool calls wrote files');

    const dryIndex = invokeTool(byName.get('memory_index'), {}, { memoryRoot: root });
    assert(dryIndex.ok === true && dryIndex.value.dryRun === true && dryIndex.value.applied === false, 'valid memory_index dry-run failed');
    const dryForget = invokeTool(byName.get('memory_forget'), {}, { memoryRoot: root });
    assert(dryForget.ok === true && dryForget.value.dryRun === true, 'valid memory_forget dry-run failed');
    sameSnapshot(assert, before, snapshot(root), 'valid dry-run tools wrote files');

    // One real write through the same entry the host calls, then read it back.
    const saved = invokeTool(byName.get('memory_procedure'), {
      action: 'save', name: 'M12 卡', trigger: ['m12'], when: '契约测试时。', steps: ['存一张'],
    }, { memoryRoot: root, now: FIXED_NOW, today: FIXED_DAY });
    assert(saved.ok === true && saved.value.version === 1, `memory_procedure save failed: ${saved.error?.message}`);
    const fetched = invokeTool(byName.get('memory_procedure'), { action: 'get', slug: saved.value.slug }, { memoryRoot: root });
    assert(fetched.ok === true && fetched.value.rel === saved.value.rel, 'memory_procedure get failed');
    return `${names.length} memory tools expose schemas; ${cases.length} invalid calls return coded errors without writes`;
  });
}

function m13BomRoundTrip(runCase, assert, expectCode, TMP) {
  runCase('M13', 'BOM+CRLF card: update/reinforce keep one BOM, closing fence and body; failed read-back restores it', () => {
    const header = [
      'title: BOM 卡',
      'tags: [a, 设计]',
      'strength: 2',
      'last_used: 2026-10-01',
      'revisions: 1',
      'custom: keep',
    ].join('\r\n');
    const original = `\uFEFF---\r\n${header}\r\n---\r\n# 标题\r\n\r\n正文：含冒号。\r\n`;
    const bomCount = (text) => text.split('\uFEFF').length - 1;
    const originalParsed = parseCardForAssertions(original);

    const updated = updateFrontmatter(original, { strength: 3 });
    const updateExpected = original.replace('strength: 2\r\n', 'strength: 3\r\n');
    assert(updated === updateExpected, `updateFrontmatter changed more than the requested field: ${JSON.stringify(updated)}`);
    assert(bomCount(updated) === 1, 'update produced a second BOM');
    assert(updated.includes('\r\n---\r\n# 标题\r\n\r\n正文：含冒号。\r\n'), 'closing fence or body heading was lost');
    assert(!updated.split(/\r?\n/).includes('-'), 'a lone "-" line was written');
    const updatedParsed = parseCardForAssertions(updated);
    assert(updatedParsed.fields.strength === '3' && updatedParsed.fields.title === 'BOM 卡', 'updated BOM card does not parse');
    assert(updatedParsed.body === '# 标题\r\n\r\n正文：含冒号。\r\n', `body changed: ${JSON.stringify(updatedParsed.body)}`);

    const root = fixture(TMP, 'm13-bom');
    const cardAbs = put(root, 'topics/bom.md', original);
    const result = memoryReinforce({ path: 'topics/bom.md' }, { memoryRoot: root, now: FIXED_NOW, today: FIXED_DAY });
    assert(result.ok === true && result.status === 'reinforced', 'reinforce on BOM+CRLF card failed');
    assert(result.after.strength === 3 && result.after.revisions === 2, 'reinforce counters are wrong');
    assert(backupNames(root).length === 1, 'reinforce did not leave exactly one backup');

    const afterText = fs.readFileSync(cardAbs, 'utf8');
    const reinforceExpected = original
      .replace('strength: 2\r\n', 'strength: 3\r\n')
      .replace('last_used: 2026-10-01\r\n', `last_used: ${FIXED_DAY}\r\n`)
      .replace('revisions: 1\r\n', 'revisions: 2\r\n') +
      `<!-- rev: ${FIXED_DAY} 被真实使用 -->\r\n`;
    assert(afterText === reinforceExpected, `reinforce rewrote the BOM card: ${JSON.stringify(afterText)}`);
    assert(bomCount(afterText) === 1, 'reinforce wrote a second BOM');
    assert(!afterText.split(/\r?\n/).includes('-'), 'reinforce wrote a lone "-" line');
    const afterParsed = parseCardForAssertions(afterText);
    assert(afterParsed.fields.title === 'BOM 卡' && afterParsed.fields.last_used === FIXED_DAY, 'reinforced BOM card fields changed');
    assert(afterParsed.body.startsWith('# 标题\r\n\r\n正文：含冒号。\r\n'), 'reinforced BOM card body lost its heading');
    assert(normalizedBody(afterParsed.body) === normalizedBody(originalParsed.body), 'reinforced BOM card body changed');

    // Fault injection: the third utf8 read of the card is reinforce's own
    // read-back (1 = before write, 2 = writeFileAtomic verify). Strip the
    // closing fence from that read; parseFrontmatter throws and the transaction
    // must restore the original bytes before surfacing a coded rollback error.
    const rollbackRoot = fixture(TMP, 'm13-bom-rollback');
    const rollbackAbs = put(rollbackRoot, 'topics/rollback.md', original);
    let rollbackReads = 0;
    withPatchedFs({
      readFileSync: (orig) => (file, ...rest) => {
        const text = orig(file, ...rest);
        if (file === rollbackAbs && rest[0] === 'utf8' && (rollbackReads += 1) === 3) {
          return text.replace('\r\n---\r\n', '\r\n');
        }
        return text;
      },
    }, () => {
      expectCode(
        () => memoryReinforce({ path: 'topics/rollback.md' }, { memoryRoot: rollbackRoot, now: FIXED_NOW, today: FIXED_DAY }),
        'E_REINFORCE_VERIFY',
      );
    });
    assert(fs.readFileSync(rollbackAbs, 'utf8') === original, 'failed read-back did not restore the original card');
    assert(!fs.existsSync(path.join(rollbackRoot, '.longlive', 'audit.log')), 'failed reinforce wrote an audit line');

    // Same corruption, but the restore copy itself fails -> E_ROLLBACK_FAILED.
    const failRoot = fixture(TMP, 'm13-bom-rollback-fail');
    const failAbs = put(failRoot, 'topics/fail.md', original);
    let failReads = 0;
    withPatchedFs({
      readFileSync: (orig) => (file, ...rest) => {
        const text = orig(file, ...rest);
        if (file === failAbs && rest[0] === 'utf8' && (failReads += 1) === 3) {
          return text.replace('\r\n---\r\n', '\r\n');
        }
        return text;
      },
      copyFileSync: (orig) => (from, to, ...rest) => {
        if (to === failAbs) {
          const error = new Error('simulated restore failure');
          error.code = 'E_TEST_COPY';
          throw error;
        }
        return orig(from, to, ...rest);
      },
    }, () => {
      expectCode(
        () => memoryReinforce({ path: 'topics/fail.md' }, { memoryRoot: failRoot, now: FIXED_NOW, today: FIXED_DAY }),
        'E_ROLLBACK_FAILED',
      );
    });
    return 'BOM+CRLF update/reinforce byte-exact; throwing read-back rolls back; failed restore reports E_ROLLBACK_FAILED';
  });
}

function m14MissingFieldEol(runCase, assert, TMP) {
  runCase('M14', 'minimal card gains missing fields with an EOL before the closing fence (LF and CRLF)', () => {
    for (const eol of ['\n', '\r\n']) {
      const minimal = ['---', 'title: 极小卡', 'strength: 5', '---', '正文', ''].join(eol);
      const updated = updateFrontmatter(minimal, { last_used: FIXED_DAY, revisions: 1 });
      const expected = [
        '---', 'title: 极小卡', 'strength: 5',
        `last_used: ${FIXED_DAY}`, 'revisions: 1', '---', '正文', '',
      ].join(eol);
      assert(updated === expected, `${JSON.stringify(eol)} minimal card was corrupted: ${JSON.stringify(updated)}`);
      assert(!updated.includes('1---'), 'closing fence was glued to the revisions value');
      const parsed = parseCardForAssertions(updated);
      assert(parsed.fields.last_used === FIXED_DAY && parsed.fields.revisions === '1', 'new fields do not parse');
      assert(parsed.body === `正文${eol}`, `body changed: ${JSON.stringify(parsed.body)}`);

      const root = fixture(TMP, `m14-minimal-${eol === '\n' ? 'lf' : 'crlf'}`);
      put(root, 'topics/min.md', minimal);
      const result = memoryReinforce({ path: 'topics/min.md' }, { memoryRoot: root, now: FIXED_NOW, today: FIXED_DAY });
      assert(result.ok === true && result.after.strength === 6 && result.after.revisions === 1, 'reinforce on a minimal card failed');
      const after = parseCardForAssertions(fs.readFileSync(path.join(root, 'topics/min.md'), 'utf8'));
      assert(after.fields.revisions === '1' && after.fields.last_used === FIXED_DAY, 'reinforced minimal card does not parse');
      assert(after.body.includes('正文'), 'reinforced minimal card lost its body');
    }
    return 'minimal LF/CRLF cards append last_used/revisions with a real EOL and survive reinforce';
  });
}

function m15EmptyNumericDefaults(runCase, assert, expectCode) {
  runCase('M15', 'empty numeric fields take defaults (3/3/0); salience is 0..9 with coded errors', () => {
    const empty = parseFrontmatter('---\nsalience:\nstrength:   \nrevisions:\t\n---\nBODY');
    assert(empty.fields.salience === DEFAULT_FIELDS.salience, `empty salience: ${empty.fields.salience}`);
    assert(empty.fields.strength === DEFAULT_FIELDS.strength, `empty strength: ${empty.fields.strength}`);
    assert(empty.fields.revisions === DEFAULT_FIELDS.revisions, `empty revisions: ${empty.fields.revisions}`);
    assert(empty.fields.status === 'active', `missing status must default to active, got ${empty.fields.status}`);

    const whitespace = parseFrontmatter('---\nsalience: \t \nstrength:\t \nrevisions:    \n---\nBODY');
    assert(whitespace.fields.salience === 3 && whitespace.fields.strength === 3 && whitespace.fields.revisions === 0, 'whitespace-only numerics did not take defaults');

    // A non-numeric salience is not a default any more — it is a broken card.
    expectCode(() => parseFrontmatter('---\nsalience: high\nstrength: n/a\nrevisions: many\n---\nBODY'), 'E_CARD_SALIENCE_INVALID');

    // Zero is a real value on both ends: salience 0 and strength 0 stay 0.
    const zero = parseFrontmatter('---\nsalience: 0\nstrength: 0\nrevisions: 0\n---\nBODY');
    assert(zero.fields.salience === 0 && zero.fields.strength === 0 && zero.fields.revisions === 0, 'zero was mistaken for empty');

    const top = parseFrontmatter('---\nsalience: 9\nstrength: -4\nrevisions: 1.9\n---\nBODY');
    assert(top.fields.salience === 9 && top.fields.strength === 0 && top.fields.revisions === 1, 'valid top salience / still-clamped strength broke');
    expectCode(() => parseFrontmatter('---\nsalience: 10\n---\nBODY'), 'E_CARD_SALIENCE_INVALID');
    expectCode(() => parseFrontmatter('---\nsalience: 1.5\n---\nBODY'), 'E_CARD_SALIENCE_INVALID');
    return 'empty numerics default to 3/3/0; salience 0/9 valid, junk/10/1.5 coded';
  });
}

function m16ToolArgGuards(runCase, assert, TMP) {
  runCase('M16', 'memory_* tool entries reject null/non-plain args and config with E_BAD_ARGUMENT', () => {
    const root = fixture(TMP, 'm16-args');
    put(root, 'topics/valid.md', cardFile({ title: '有效卡', strength: 2, lastUsed: FIXED_DAY }));
    const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));
    const names = ['memory_index', 'memory_consolidate', 'memory_reinforce', 'memory_forget', 'memory_procedure', 'memory_recall'];
    const validArgs = {
      memory_index: {},
      memory_consolidate: {},
      memory_reinforce: { path: 'topics/valid.md' },
      memory_forget: {},
      memory_procedure: { action: 'list' },
      memory_recall: { query: '有效' },
    };
    const before = snapshot(root);
    const badArgs = [null, undefined, 'text', [1, 2], 42, new Date(0)];
    for (const name of names) {
      for (const args of badArgs) {
        assertCodedError(
          assert,
          invokeTool(byName.get(name), args, { memoryRoot: root }),
          'E_BAD_ARGUMENT',
          `${name} args=${Object.prototype.toString.call(args)}`,
        );
      }
    }
    const badConfigs = [null, undefined, 'cfg', [], 7, new Date(0)];
    for (const name of names) {
      for (const config of badConfigs) {
        assertCodedError(
          assert,
          invokeTool(byName.get(name), validArgs[name], config),
          'E_BAD_ARGUMENT',
          `${name} config=${Object.prototype.toString.call(config)}`,
        );
      }
    }
    sameSnapshot(assert, before, snapshot(root), 'rejected memory tool calls wrote files');

    const dry = invokeTool(byName.get('memory_index'), {}, { memoryRoot: root });
    assert(dry.ok === true && dry.value.dryRun === true, 'the guard rejected a valid plain-object call');
    return `${names.length} tools reject ${badArgs.length} bad args and ${badConfigs.length} bad configs without writes`;
  });
}

function m17MultilineValues(runCase, assert, expectCode) {
  runCase('M17', 'multiline frontmatter values are refused on write and reported on read', () => {
    expectCode(() => serializeFrontmatter({ ...DEFAULT_FIELDS, title: '第一行\n第二行' }, {}), 'E_BAD_ARGUMENT');
    expectCode(() => serializeFrontmatter({ ...DEFAULT_FIELDS, tags: ['a', 'b\nc'] }, {}), 'E_BAD_ARGUMENT');
    expectCode(() => serializeFrontmatter({}, { custom: 'x\r\ny' }), 'E_BAD_ARGUMENT');
    expectCode(() => updateFrontmatter('---\ntitle: x\n---\nBODY', { title: 'a\r\nb' }), 'E_BAD_ARGUMENT');
    expectCode(() => updateFrontmatter('---\ntitle: x\n---\nBODY', { tags: ['ok', 'bad\nline'] }), 'E_BAD_ARGUMENT');

    expectCode(() => parseFrontmatter('---\ntitle: 第一行\n  第二行\n---\nBODY'), 'E_FRONTMATTER_MULTILINE');
    expectCode(() => parseFrontmatter('---\ntitle: 第一行\n\t第二行\n---\nBODY'), 'E_FRONTMATTER_MULTILINE');

    // Indented blank lines and indented comments are not continuation values.
    const legal = parseFrontmatter('---\ntitle: x\n   \n  # 注释\n---\nBODY');
    assert(legal.fields.title === 'x' && legal.body === 'BODY', 'blank/comment lines were mistaken for a multiline value');
    return 'write side refuses CR/LF; parse side throws E_FRONTMATTER_MULTILINE instead of dropping lines';
  });
}

// M18 is split in two on purpose. A directory junction is creatable without
// any privilege, so the junction assertions must ALWAYS run. A file symlink is
// not: a plain Windows user gets EPERM, and then the fixture itself cannot
// exist. That half is registered through runSymlinkCase, which reports SKIP
// with the OS error instead of a fake PASS or a bogus failure.
function m18RealpathGuard(runCase, assert, expectCode, TMP) {
  runCase('M18', 'memory paths: junction escape refused by realpath; missing tails and legal paths still resolve', () => {
    const base = path.join(TMP, 'memory-cases', 'm18');
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.md'), '# outside\n');

    assert(
      resolveInside(root, path.join('topics', 'new.md')) === path.join(root, 'topics', 'new.md'),
      'a legal, not-yet-created path resolves unchanged',
    );

    const junction = path.join(root, 'j-link');
    fs.symlinkSync(outside, junction, 'junction');
    const dirEscape = expectCode(
      () => resolveInside(root, path.join('j-link', 'secret.md')),
      'E_PATH_OUTSIDE_ROOT',
    );
    assert(dirEscape.message.includes('真实路径'), 'junction refusal must name the real path');
    expectCode(
      () => resolveInside(root, path.join('j-link', 'missing', 'new.md')),
      'E_PATH_OUTSIDE_ROOT',
    );
    return 'junction dir and junction tail refused; legal missing path still resolves';
  });
}

function m18SymlinkGuard(runSymlinkCase, assert, expectCode, TMP) {
  runSymlinkCase('M18-link', 'memory paths: file symlink escape refused by realpath; linked card refused (needs symlink privilege)', () => {
    const base = path.join(TMP, 'memory-cases', 'm18-link');
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.md'), '# outside\n');

    const fileLink = path.join(root, 'topics-link.md');
    fs.symlinkSync(path.join(outside, 'secret.md'), fileLink, 'file');
    expectCode(() => resolveInside(root, 'topics-link.md'), 'E_PATH_OUTSIDE_ROOT');

    const memoryRoot = path.join(base, 'memory');
    fs.mkdirSync(path.join(memoryRoot, 'topics'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(memoryRoot, 'topics', 'evil.md'), 'file');
    expectCode(
      () => memoryReinforce({ path: 'topics/evil.md' }, { memoryRoot }),
      'E_PATH_OUTSIDE_ROOT',
    );
    return 'file symlink and linked card both refused with E_PATH_OUTSIDE_ROOT';
  });
}

/**
 * Two consolidations inside one millisecond used to compute the same backup
 * name, so the second copy silently overwrote the first. The name must gain a
 * numeric suffix instead; this test pins that by running the same instant twice.
 */
function m19ReportBackupSameMs(runCase, assert, TMP) {
  runCase('M19', 'same-millisecond report backups keep both copies (suffix -2)', () => {
    const root = fixture(TMP, 'm19-report-backup');
    put(root, 'topics/备份策略.md', [
      '---',
      'title: 备份策略',
      'tags: [backup]',
      'salience: 3',
      'strength: 3',
      'last_used: 2026-11-01',
      'revisions: 1',
      '---',
      '# 备份策略',
      '',
      '报告覆盖前必须先备份。',
      '',
    ].join('\n'));
    put(root, 'journal/2026-11-02.md', [
      '---',
      'date: 2026-11-02',
      '---',
      '## 记录',
      '',
      '决定：同一毫秒的两次巩固也要留下两份报告备份。',
      '',
    ].join('\n'));

    const now = new Date('2026-11-02T03:00:00.000Z');
    const options = { memoryRoot: root, now, today: FIXED_DAY };
    const first = memoryConsolidate({}, options);
    assert(first.ok === true && fs.existsSync(first.reportPath), 'first run must write the report');
    const firstText = fs.readFileSync(first.reportPath, 'utf8');

    const second = memoryConsolidate({}, options);
    const third = memoryConsolidate({}, options);
    assert(second.ok === true && third.ok === true, 'repeat runs must still succeed');

    const dir = path.join(root, '.longlive', 'reports', '.backups');
    const names = fs.readdirSync(dir).filter((name) => name.endsWith('.md')).sort();
    assert(names.length === 2, `two same-ms backups expected, got ${names.length}: ${names.join(', ')}`);
    const baseName = names.find((name) => !/-\d+\.md$/.test(name));
    assert(Boolean(baseName), `base backup name missing: ${names.join(', ')}`);
    const suffixName = names.find((name) => name !== baseName);
    assert(
      suffixName === `${baseName.replace(/\.md$/, '')}-2.md`,
      `collision suffix must be -2, got ${suffixName}`,
    );
    assert(
      fs.readFileSync(path.join(dir, baseName), 'utf8') === firstText,
      'the first backup must preserve the first report',
    );
    return `same-ms backups: ${names.join(' + ')}; first copy preserved`;
  });
}

function m20AffectMarkers(runCase, assert, TMP) {
  runCase('M20', 'affect markers: 3 marked win, bad format/range listed in badAffect, no throw', () => {
    const root = fixture(TMP, 'm20-affect');
    put(root, 'topics/工程约定.md', [
      '---',
      'title: 工程约定',
      'tags: [engineering]',
      'salience: 3',
      'strength: 3',
      'last_used: 2026-10-01',
      'revisions: 1',
      '---',
      '# 工程约定',
      '',
      '所有写入先备份。',
      '',
    ].join('\n'));
    put(root, 'journal/2026-11-01.md', [
      '# 记录',
      '',
      '第一段：今天普通地过完了。<!-- affect: 5 | 其实心里很重 -->',
      '',
      '第二段：随手记一下。<!-- affect: 2 | 只是流水账 -->',
      '',
      '第三段：决定按方案走。<!-- affect: 1 | 其实很不安 -->',
      '',
      '第四段：坏格式的情绪标记。<!-- affect: high | 不知道填什么 -->',
      '',
      '第五段：越界的情绪标记。<!-- affect: 9 | 情绪过头 -->',
      '',
      '第六段：决定明天继续。',
      '',
    ].join('\n'));

    const config = { memoryRoot: root, now: FIXED_NOW, today: FIXED_DAY };
    const result = memoryConsolidate({}, config);
    assert(result.ok === true, 'consolidate should succeed despite bad markers');
    assert(result.entries === 6, `expected 6 paragraph entries, got ${result.entries}`);
    assert(result.proposals.length === 6, `expected 6 proposals, got ${result.proposals.length}`);

    const proposals = result.proposals;
    const marked = proposals.slice(0, 3);
    assert(marked.map((item) => item.suggestedSalience).join(',') === '5,2,1', `marked salience: ${marked.map((item) => item.suggestedSalience).join(',')}`);
    assert(marked.every((item) => item.salienceSource === 'marked'), `marked sources: ${marked.map((item) => item.salienceSource).join(',')}`);
    assert(marked[0].affectReason === '其实心里很重' && marked[2].affectReason === '其实很不安', 'affect reason was not carried into the proposal');

    // The two broken markers must not throw and must not win over the regex.
    const broken = proposals.slice(3, 5);
    assert(broken.every((item) => item.salienceSource !== 'marked'), `broken markers were trusted: ${broken.map((item) => item.salienceSource).join(',')}`);
    assert(proposals[5].suggestedSalience === 4 && proposals[5].salienceSource === 'heuristic', `unmarked paragraph: ${proposals[5].suggestedSalience}/${proposals[5].salienceSource}`);

    assert(Array.isArray(result.badAffect) && result.badAffect.length === 2, `badAffect: ${JSON.stringify(result.badAffect)}`);
    assert(result.badAffect.some((item) => item.code === 'E_AFFECT_FORMAT'), 'bad format was not recorded');
    assert(result.badAffect.some((item) => item.code === 'E_AFFECT_RANGE'), 'out-of-range marker was not recorded');
    assert(result.badAffect.every((item) => item.source === 'journal/2026-11-01.md' && item.marker.includes('affect')), 'badAffect entries lack source/marker');

    const report = fs.readFileSync(result.reportPath, 'utf8');
    assert(report.includes('salienceSource'), 'report does not expose salienceSource');
    assert(report.includes('badAffect'), 'report does not expose badAffect');
    assert(report.includes('affect: 9') && report.includes('E_AFFECT_RANGE'), 'report does not name the out-of-range marker');
    assert(proposals.every((item) => item.excerpt.length > 0 && !item.excerpt.includes('<!--')), 'marker leaked into an excerpt');
    return '5/2/1 marked values trusted; high and 9 recorded in badAffect; unmarked fell back to heuristic 4';
  });
}

function m21DedupSince(runCase, assert, TMP) {
  runCase('M21', 'proposal ids: repeat run 0 new ids; since advances only when every proposal is resolved', () => {
    const root = fixture(TMP, 'm21-dedup');
    put(root, 'topics/工程约定.md', [
      '---',
      'title: 工程约定',
      'tags: [engineering]',
      'salience: 3',
      'strength: 3',
      'last_used: 2026-10-01',
      'revisions: 1',
      '---',
      '# 工程约定',
      '',
      '所有写入先备份。',
      '',
    ].join('\n'));
    const paragraphs = [
      '决定：所有写入先备份。',
      '随手记：周三买牛奶。<!-- affect: 2 | 琐事 -->',
      '铁律：永远不许骗他。',
    ];
    put(root, 'journal/2026-11-01.md', ['# 记录', '', ...paragraphs.flatMap((text) => [text, '']), ''].join('\n'));
    put(root, '.longlive/memory-state.json', `${JSON.stringify({
      lastConsolidated: '2026-10-20',
      indexBuiltAt: null,
      forgetRuns: [],
    }, null, 2)}\n`);

    const stateAbs = path.join(root, '.longlive', 'memory-state.json');
    const readStateFile = () => JSON.parse(fs.readFileSync(stateAbs, 'utf8'));
    const config = { memoryRoot: root, now: FIXED_NOW, today: FIXED_DAY };

    const first = memoryConsolidate({}, config);
    assert(first.proposals.length === 3, `first run proposals: ${first.proposals.length}`);
    assert(first.stateUpdated === false, 'first run must not advance lastConsolidated');
    assert(first.duplicatesSuppressed === 0, `first run duplicates: ${first.duplicatesSuppressed}`);
    const firstState = readStateFile();
    assert(firstState.lastConsolidated === '2026-10-20', `lastConsolidated moved on the first run: ${firstState.lastConsolidated}`);
    assert(Array.isArray(firstState.seenProposals) && firstState.seenProposals.length === 3, 'seenProposals was not persisted');
    assert(firstState.seenProposals.every((entry) => entry.status === 'proposed' && entry.day === '2026-11-01'), 'seenProposals status/day is wrong');

    const expectedId = (source, text) => crypto.createHash('sha1')
      .update(`${source}\n${text.replace(/\s+/g, ' ').trim()}`, 'utf8').digest('hex').slice(0, 12);
    assert(first.proposals[0].id === expectedId('journal/2026-11-01.md', paragraphs[0]), `proposal id formula: ${first.proposals[0].id}`);
    assert(first.proposals[1].id === expectedId('journal/2026-11-01.md', paragraphs[1].replace(/\s*<!--[\s\S]*?-->\s*/g, '')), `marked proposal id: ${first.proposals[1].id}`);
    assert(first.proposals.every((item) => /^[0-9a-f]{12}$/.test(item.id)), 'proposal ids are not 12 hex chars');

    const second = memoryConsolidate({}, config);
    assert(second.proposals.length === 0, `repeat run re-proposed ${second.proposals.length} paragraph(s)`);
    assert(second.duplicatesSuppressed === 3, `duplicatesSuppressed: ${second.duplicatesSuppressed}`);
    assert(second.stateUpdated === false, 'repeat run must not advance lastConsolidated');
    const secondState = readStateFile();
    assert(secondState.lastConsolidated === '2026-10-20', 'unresolved proposals advanced lastConsolidated');
    assert(secondState.seenProposals.length === 3, 'repeat run duplicated seenProposals entries');
    const repeatRate = second.proposals.filter((item) => first.proposals.some((old) => old.id === item.id)).length
      / Math.max(1, second.proposals.length + second.duplicatesSuppressed);
    assert(repeatRate === 0, `duplicate proposal rate is ${repeatRate}`);

    // Only an accepted/rejected status resolves a proposal. Flip them by hand:
    // this slice has no merge tool yet, so the state file is the contract.
    const resolved = readStateFile();
    for (const entry of resolved.seenProposals) entry.status = 'accepted';
    fs.writeFileSync(stateAbs, `${JSON.stringify(resolved, null, 2)}\n`, 'utf8');

    const third = memoryConsolidate({}, config);
    assert(third.proposals.length === 0, `resolved run re-proposed ${third.proposals.length} paragraph(s)`);
    assert(third.stateUpdated === true, 'all-resolved run did not advance lastConsolidated');
    assert(third.lastConsolidated === '2026-11-01', `advanced to ${third.lastConsolidated}, expected 2026-11-01`);
    assert(readStateFile().lastConsolidated === '2026-11-01', 'advanced day was not persisted');

    const fourth = memoryConsolidate({}, config);
    assert(fourth.since === '2026-11-01', `since after advance: ${fourth.since}`);
    assert(fourth.proposals.length === 0 && fourth.stateUpdated === false, 'post-advance run should be a no-op');
    return '3 ids stable across two runs (0 re-proposed); manual accept advanced lastConsolidated 2026-10-20 -> 2026-11-01';
  });
}

function m22ForgetRules(runCase, assert, TMP) {
  runCase('M22', 'forget rules: 89/90/91 and 364/365/366, salience-5 immunity, dry-run writes nothing', () => {
    const root = fixture(TMP, 'm22-rules');
    const cards = {
      'topics/d89.md': cardFile({ title: '八十九天', strength: 1, lastUsed: '2026-08-05' }),
      'topics/d90low.md': cardFile({ title: '九十天低强度', strength: 2, lastUsed: '2026-08-04' }),
      'topics/d90high.md': cardFile({ title: '九十天高强度', strength: 9, lastUsed: '2026-08-04' }),
      'topics/d91low.md': cardFile({ title: '九十一天低强度', strength: 2, lastUsed: '2026-08-03' }),
      'topics/d91high.md': cardFile({ title: '九十一天高强度', strength: 3, lastUsed: '2026-08-03' }),
      'topics/d364.md': cardFile({ title: '三百六十四天', strength: 9, lastUsed: '2025-11-03' }),
      'topics/d365low.md': cardFile({ title: '三百六十五天低强度', strength: 2, lastUsed: '2025-11-02' }),
      'topics/d365high.md': cardFile({ title: '三百六十五天高强度', strength: 9, lastUsed: '2025-11-02' }),
      'topics/d366.md': cardFile({ title: '三百六十六天', strength: 9, lastUsed: '2025-11-01', tags: ['项目甲', '老张'] }),
      'topics/core5.md': cardFile({ title: '核心五', salience: 5, strength: 0, lastUsed: '2015-01-01' }),
      'topics/fresh.md': cardFile({ title: '新鲜', strength: 1, lastUsed: '2026-11-01' }),
    };
    for (const [rel, text] of Object.entries(cards)) put(root, rel, text);
    const config = { memoryRoot: root, now: FIXED_NOW, today: FIXED_DAY };
    const before = snapshot(root);

    const dry = memoryForget({}, config);
    assert(dry.status === 'dry-run' && dry.dryRun === true && dry.applied === false, 'forget default must be a dry-run');
    const picked = dry.proposals.map((item) => `${item.path}:${item.kind}:${item.ageDays}`).join(',');
    assert(picked === 'topics/d366.md:tombstone:366,topics/d365low.md:epochs:365,topics/d91low.md:epochs:91', `decay rules picked ${picked}`);
    assert(!dry.proposals.some((item) => ['topics/d89.md', 'topics/d90low.md', 'topics/d90high.md', 'topics/d91high.md', 'topics/d364.md', 'topics/d365high.md', 'topics/fresh.md'].includes(item.path)), 'a below-threshold card was proposed');
    assert(dry.immune.length === 1 && dry.immune[0].path === 'topics/core5.md', 'salience-5 card is not immune');
    assert(dry.undated.length === 0, `unexpected undated cards: ${dry.undated.length}`);
    assert(dry.rules.immuneSalience === 5, `immune threshold ${dry.rules.immuneSalience}`);
    assert(dry.rules.epochs.minAgeDays === 90 && dry.rules.epochs.maxStrength === 2 && dry.rules.epochs.strict === true, 'epochs rule is not >90d with strength<=2');
    assert(dry.rules.tombstone.minAgeDays === 365 && dry.rules.tombstone.strict === true, 'tombstone rule is not >365d');

    for (const item of dry.proposals) {
      assert(item.epitaph && typeof item.epitaph.reason === 'string' && item.epitaph.reason.length > 0, `${item.path}: epitaph.reason missing`);
      assert(typeof item.epitaph.affects === 'string' && item.epitaph.affects.length > 0, `${item.path}: epitaph.affects missing`);
      assert(typeof item.epitaph.stillUseful === 'string' && item.epitaph.stillUseful.includes('移回'), `${item.path}: epitaph.stillUseful is not a recovery note`);
      assert(typeof item.destRel === 'string' && item.destRel.endsWith(item.path), `${item.path}: destRel ${item.destRel}`);
    }
    assert(dry.proposals[0].epitaph.affects.includes('项目甲'), 'tags are not carried into affects');
    assert(dry.proposals[1].epitaph.affects.includes('未标注'), 'an untagged card should say its impact is unknown');

    assert(dry.scaffold.ready === false, 'a fresh root must not report a ready scaffold');
    assert(dry.scaffold.missing.join(',') === 'epochs,archive,backups,audit', `scaffold missing: ${dry.scaffold.missing.join(',')}`);
    assert(dry.scaffold.entries.every((entry) => entry.exists === false), 'scaffold entry reported as existing');
    assert(dry.audit.appended === 0 && dry.audit.willAppend === 1, 'dry-run audit plan is wrong');

    for (const rel of ['epochs', 'archive', 'archive/tombstones', '.longlive']) {
      assert(!fs.existsSync(path.join(root, rel)), `dry-run created ${rel}`);
    }
    assert(!fs.existsSync(path.join(root, 'tombstones.md')), 'dry-run created tombstones.md');
    sameSnapshot(assert, before, snapshot(root), 'forget rules dry-run');
    assert(dry.message.includes('未写任何文件'), 'dry-run message should say nothing was written');
    return '89/90/91 and 364/365/366 all decided by strict >N rules; salience 5 immune; dry-run created no file and no directory';
  });
}

function m23ForgetExecute(runCase, assert, TMP) {
  runCase('M23', 'forget confirm: scaffold created, per-card backups, three-question epitaphs, one audit line', () => {
    const root = fixture(TMP, 'm23-execute');
    const cards = {
      'topics/e91a.md': cardFile({ title: '九十一天甲', strength: 1, lastUsed: '2026-08-03' }),
      'topics/e91b.md': cardFile({ title: '九十一天乙', strength: 2, lastUsed: '2026-08-03', tags: ['项目甲', '老张'] }),
      'topics/t366.md': cardFile({ title: '超过一年', strength: 4, lastUsed: '2025-11-01', tags: ['旧项目'] }),
      'topics/core5.md': cardFile({ title: '核心五', salience: 5, strength: 0, lastUsed: '2015-01-01' }),
      'topics/fresh.md': cardFile({ title: '新鲜', strength: 1, lastUsed: '2026-11-01' }),
    };
    const originals = new Map();
    for (const [rel, text] of Object.entries(cards)) {
      put(root, rel, text);
      originals.set(rel, text);
    }
    const dests = {
      'topics/e91a.md': 'epochs/topics/e91a.md',
      'topics/e91b.md': 'epochs/topics/e91b.md',
      'topics/t366.md': 'archive/tombstones/topics/t366.md',
    };
    const config = { memoryRoot: root, now: FIXED_NOW, today: FIXED_DAY };
    const before = snapshot(root);

    const done = memoryForget({ confirm: 'FORGET' }, config);
    assert(done.applied === true && done.moved === 3, `applied=${done.applied} moved=${done.moved}`);
    assert(done.scaffold.ready === true, 'scaffold is not ready after an executed run');
    assert(done.scaffold.created.join(',') === 'epochs,archive,backups', `scaffold created: ${done.scaffold.created.join(',')}`);
    for (const rel of ['epochs', 'archive/tombstones', '.longlive/backups']) {
      assert(fs.statSync(path.join(root, rel)).isDirectory(), `${rel} is not a directory after confirm`);
    }

    for (const [from, to] of Object.entries(dests)) {
      assert(!fs.existsSync(path.join(root, from)), `source still present: ${from}`);
      assert(fs.existsSync(path.join(root, to)), `destination missing: ${to}`);
      assert(fs.readFileSync(path.join(root, to), 'utf8') === originals.get(from), `bytes changed after the move: ${to}`);
    }
    assert(fs.readFileSync(path.join(root, 'topics/core5.md'), 'utf8') === originals.get('topics/core5.md'), 'salience-5 card was touched');
    assert(fs.readFileSync(path.join(root, 'topics/fresh.md'), 'utf8') === originals.get('topics/fresh.md'), 'fresh card was touched');

    const tombText = fs.readFileSync(path.join(root, 'tombstones.md'), 'utf8');
    const lines = tombText.split(/\r?\n/).filter((line) => line.startsWith('- '));
    assert(lines.length === 3, `tombstones.md has ${lines.length} lines, expected 3`);
    for (const line of lines) {
      for (const field of ['reason:', 'affects:', 'stillUseful:', 'recoverable:']) {
        assert(line.includes(field), `tombstone line lacks ${field}: ${line}`);
      }
    }
    assert(lines.some((line) => line.includes('affects: tags: 项目甲')), 'a tagged card does not name its tags under affects');
    assert(lines.some((line) => line.includes('topics/t366.md') && line.includes('recoverable: archive/tombstones/topics/t366.md')), 'tombstoned card line is wrong');
    assert(!lines.some((line) => line.includes('core5.md')), 'immune card got a tombstone line');
    assert(done.tombstoneLines === 3, `result tombstoneLines=${done.tombstoneLines}`);

    const backups = backupNames(root);
    for (const [from] of Object.entries(dests)) {
      const base = path.basename(from, '.md');
      const names = backups.filter((name) => name.startsWith(`${base}.`));
      assert(names.length === 1, `${from} should have exactly one backup, got ${names.join(',') || 'none'}`);
      assert(fs.readFileSync(path.join(root, '.longlive', 'backups', names[0]), 'utf8') === originals.get(from), `backup bytes changed: ${from}`);
    }
    assert(done.archived.length === 3 && done.archived.every((item) => item.backupRel && fs.existsSync(path.join(root, item.backupRel))), 'result does not point at the per-card backups');

    const audit = fs.readFileSync(path.join(root, '.longlive', 'audit.log'), 'utf8').trim().split(/\r?\n/);
    assert(audit.length === 1 && audit[0].includes('memory_forget') && audit[0].includes('moved=3'), `audit.log: ${audit.join(' | ')}`);
    assert(done.audit.appended === 1, 'result audit count is wrong');
    const state = JSON.parse(fs.readFileSync(statePath(root), 'utf8'));
    assert(state.forgetRuns.length === 1 && state.forgetRuns[0].moved === 3, 'forgetRuns was not recorded');

    const after = snapshot(root);
    for (const [rel, hash] of before) {
      if (dests[rel]) {
        assert(!after.has(rel), `moved card still at its old path: ${rel}`);
        assert(after.get(dests[rel]) === hash, `moved card changed bytes: ${rel}`);
        continue;
      }
      assert(after.has(rel), `file vanished: ${rel}`);
      assert(after.get(rel) === hash, `untouched file changed: ${rel}`);
    }
    // 3 cards moved (same count, new paths) + 3 per-card backups + tombstones.md
    // + audit.log + memory-state.json = 6 new files, and nothing disappeared.
    assert(after.size === before.size + 6, `file count ${before.size} -> ${after.size}, expected +6 (3 backups + tombstones + audit + state)`);

    const beforeSecond = snapshot(root);
    const second = memoryForget({ confirm: 'FORGET' }, config);
    assert(second.status === 'noop' && second.applied === false, `second run status=${second.status}`);
    sameSnapshot(assert, beforeSecond, snapshot(root), 'second confirm run');
    return 'confirm created the three scaffolds, backed up each card, wrote 3 three-question epitaphs, moved 3 cards, kept every byte';
  });
}

// ---------------------------------------------------------------------------
// M24-M27: procedural memory (procedures/<slug>.md + memory_procedure).
//
// The card format is a contract, not a suggestion: name/trigger/salience/
// strength/last_used live in the frontmatter, the body is 何时用 / 怎么做
// (numbered) / 失败模式 / 例子. These cases pin the format through an
// independent oracle (parseCardForAssertions) and never through the writer
// that produced it.
// ---------------------------------------------------------------------------

function procedureTool(assert) {
  const tool = TOOLS.find((item) => item.name === 'memory_procedure');
  assert(Boolean(tool), 'memory_procedure is not registered in TOOLS');
  return tool;
}

function procedureOptions(root) {
  return { memoryRoot: root, now: FIXED_NOW, today: FIXED_DAY };
}

/** A plain topics/ card, for index fixtures that need a non-procedure row. */
function topicCard(title, salience = 3, strength = 3, lastUsed = FIXED_DAY) {
  return [
    '---',
    `title: ${title}`,
    'date: 2026-11-02',
    'tags: [procedural]',
    `salience: ${salience}`,
    `strength: ${strength}`,
    `last_used: ${lastUsed}`,
    'revisions: 0',
    '---',
    `# ${title}`,
    '',
    '正文。',
    '',
  ].join('\n');
}

function m24ProcedureSaveGetList(runCase, assert, TMP) {
  runCase('M24', 'memory_procedure: save/get/list 与同名合并（版本号 +1，旧版进备份）', () => {
    const root = fixture(TMP, 'm24-procedure');
    const tool = procedureTool(assert);
    const options = procedureOptions(root);

    const created = invokeTool(tool, {
      action: 'save',
      name: '部署流程',
      trigger: ['部署', '上线'],
      when: '要把新版本发到线上时。',
      steps: ['跑全量测试', '打包并校验 sha256'],
      failureModes: '测试红了就别发。',
      example: '0.7.7 发版走的就是这条。',
    }, options);
    assert(created.ok === true, `save failed: ${created.error?.message}`);
    const card = created.value;
    assert(card.action === 'save' && card.status === 'created', `save status: ${card.status}`);
    assert(card.version === 1 && card.revisions === 0, `new card version/revisions: ${card.version}/${card.revisions}`);
    assert(card.slug === '部署流程' && card.rel === 'procedures/部署流程.md', `slug/rel: ${card.slug} / ${card.rel}`);

    const abs = path.join(root, 'procedures', '部署流程.md');
    assert(fs.existsSync(abs), 'the procedure card was not written');
    const firstText = fs.readFileSync(abs, 'utf8');
    assert(card.sha256 === sha(firstText), 'save sha256 does not match the file on disk');

    // Independent oracle: the key lines themselves, in the documented order.
    const parsed = parseCardForAssertions(firstText);
    const keys = firstText.split('\n').slice(1, 7).map((line) => line.slice(0, line.indexOf(':')));
    assert(
      keys.join(',') === 'name,trigger,salience,strength,last_used,revisions',
      `frontmatter must be name,trigger,salience,strength,last_used,revisions — got ${keys.join(',')}`,
    );
    assert(parsed.fields.name === '部署流程', `frontmatter name: ${parsed.fields.name}`);
    assert(parsed.fields.trigger === '[部署, 上线]', `frontmatter trigger: ${parsed.fields.trigger}`);
    assert(parsed.fields.salience === '3' && parsed.fields.strength === '3', `defaults: ${parsed.fields.salience}/${parsed.fields.strength}`);
    assert(parsed.fields.last_used === FIXED_DAY, `last_used: ${parsed.fields.last_used}`);
    assert(parsed.fields.revisions === '0', `revisions: ${parsed.fields.revisions}`);
    for (const [heading, needle] of [
      ['何时用', '要把新版本发到线上时'],
      ['怎么做', '1. 跑全量测试'],
      ['失败模式', '测试红了就别发'],
      ['例子', '0.7.7 发版走的就是这条'],
    ]) {
      assert(parsed.body.includes(`## ${heading}`), `missing section 「${heading}」`);
      assert(parsed.body.includes(needle), `section 「${heading}」 lost its content: ${needle}`);
    }
    assert(parsed.body.includes('2. 打包并校验 sha256'), 'steps are not numbered');

    const readOnlyBefore = snapshot(root);
    const got = invokeTool(tool, { action: 'get', slug: '部署流程' }, options);
    assert(got.ok === true, `get failed: ${got.error?.message}`);
    assert(got.value.name === '部署流程' && got.value.rel === card.rel, `get name/rel: ${got.value.name} / ${got.value.rel}`);
    assert(JSON.stringify(got.value.trigger) === JSON.stringify(['部署', '上线']), `get trigger: ${JSON.stringify(got.value.trigger)}`);
    assert(
      JSON.stringify(got.value.sections.steps) === JSON.stringify(['跑全量测试', '打包并校验 sha256']),
      `get steps: ${JSON.stringify(got.value.sections.steps)}`,
    );
    assert(got.value.sections.when.includes('要把新版本发到线上时'), 'get lost the 「何时用」 text');
    assert(got.value.text === firstText, 'get did not return the raw card text');
    assert(got.value.version === 1, `get version: ${got.value.version}`);

    const listed = invokeTool(tool, { action: 'list' }, options);
    assert(listed.ok === true && listed.value.count === 1, `list count: ${listed.value?.count}`);
    assert(listed.value.items[0].rel === card.rel && listed.value.items[0].version === 1, 'list entry is wrong');
    sameSnapshot(assert, readOnlyBefore, snapshot(root), 'get/list must not write');

    // Same slug again: revisions + 1, previous bytes go to .longlive/backups.
    const merged = invokeTool(tool, {
      action: 'save',
      name: '部署流程',
      steps: ['跑全量测试', '打包并校验 sha256', '灰度 10%'],
    }, options);
    assert(merged.ok === true, `merge save failed: ${merged.error?.message}`);
    assert(
      merged.value.status === 'merged' && merged.value.version === 2 && merged.value.revisions === 1,
      `merged status/version/revisions: ${merged.value.status}/${merged.value.version}/${merged.value.revisions}`,
    );
    assert(
      typeof merged.value.backupRel === 'string' && merged.value.backupRel.startsWith('.longlive/backups/'),
      `backupRel: ${merged.value.backupRel}`,
    );
    assert(fs.readFileSync(path.join(root, merged.value.backupRel), 'utf8') === firstText, 'the backup is not the previous version');
    const secondText = fs.readFileSync(abs, 'utf8');
    const secondParsed = parseCardForAssertions(secondText);
    assert(secondParsed.fields.revisions === '1', `merged revisions: ${secondParsed.fields.revisions}`);
    assert(
      secondParsed.fields.name === '部署流程' && secondParsed.fields.trigger === '[部署, 上线]',
      'merge dropped name/trigger that were not passed again',
    );
    assert(secondParsed.body.includes('3. 灰度 10%'), 'merge did not write the new step');
    assert(secondParsed.body.includes('要把新版本发到线上时'), 'merge dropped the old 「何时用」');
    assert(secondParsed.body.includes('测试红了就别发'), 'merge dropped the old 「失败模式」');

    assertCodedError(assert, invokeTool(tool, { action: 'get', slug: '不存在的卡' }, options), 'E_PROCEDURE_NOT_FOUND', 'get unknown card');
    assertCodedError(assert, invokeTool(tool, { action: 'nope' }, options), 'E_BAD_ARGUMENT', 'unknown action');
    assertCodedError(assert, invokeTool(tool, { action: 'save', name: '新卡' }, options), 'E_BAD_ARGUMENT', 'new card without when/steps');
    assertCodedError(
      assert,
      invokeTool(tool, { action: 'save', name: 'x/y', when: 'a', steps: ['b'] }, options),
      'E_BAD_ARGUMENT',
      'name with a path separator',
    );
    assertCodedError(
      assert,
      invokeTool(tool, { action: 'save', name: '空触发', trigger: [], when: 'a', steps: ['b'] }, options),
      'E_BAD_ARGUMENT',
      'empty trigger list',
    );
    return 'format pinned by an independent oracle; merge bumped the version and kept the old bytes in backups';
  });
}

function m25ProcedureTriggerReport(runCase, assert, TMP) {
  runCase('M25', 'memory_procedure: trigger 关键词过滤，report 提权/降权且不动 revisions', () => {
    const root = fixture(TMP, 'm25-procedure');
    const tool = procedureTool(assert);
    const options = procedureOptions(root);
    const save = (args) => {
      const result = invokeTool(tool, { action: 'save', ...args }, options);
      assert(result.ok === true, `save ${args.name} failed: ${result.error?.message}`);
      return result.value;
    };
    const list = (args) => {
      const result = invokeTool(tool, { action: 'list', ...args }, options);
      assert(result.ok === true, `list ${JSON.stringify(args)} failed: ${result.error?.message}`);
      return result.value;
    };

    save({ name: '重启服务', trigger: ['运维', '重启'], when: '服务卡死时。', steps: ['systemctl restart 服务'] });
    save({ name: '写周报', trigger: ['文档'], when: '每周五。', steps: ['列三件事'] });
    save({ name: '上线检查', trigger: ['发布', '运维', 'Deploy'], when: '发版前。', steps: ['检查回滚脚本'] });

    const ops = list({ trigger: '运维' });
    assert(ops.count === 2, `trigger=运维 should hit 2, got ${ops.count}`);
    assert(ops.items.every((item) => item.trigger.includes('运维')), 'a hit does not carry the keyword');
    assert(
      JSON.stringify(ops.items.map((item) => item.name).sort()) === JSON.stringify(['上线检查', '重启服务'].sort()),
      `hits: ${ops.items.map((item) => item.name).join(',')}`,
    );
    assert(list({ trigger: '运维 重' }).count === 2, 'several keywords must OR together');
    assert(list({ trigger: '重' }).count === 1, `single keyword 重 should hit one card, got ${list({ trigger: '重' }).count}`);
    assert(list({ trigger: 'deploy' }).count === 1, 'trigger matching must be case-insensitive');
    assert(list({ trigger: '不存在' }).count === 0, 'an unknown keyword must hit nothing');
    assert(list({}).count === 3, 'list without a filter returns every card');
    assert(list({ trigger: '   ' }).count === 3, 'a blank filter must not filter anything');

    const cardPath = path.join(root, 'procedures', '重启服务.md');
    const before = fs.readFileSync(cardPath, 'utf8');
    const promote = invokeTool(tool, { action: 'report', slug: '重启服务', outcome: 'success', reason: '卡死时用了两次' }, options);
    assert(promote.ok === true, `report success failed: ${promote.error?.message}`);
    assert(promote.value.before.strength === 3 && promote.value.after.strength === 4, `promote: ${JSON.stringify(promote.value.after)}`);
    assert(promote.value.revisions === 0, 'report must not touch revisions (that counts content versions)');
    const after = fs.readFileSync(cardPath, 'utf8');
    const parsedAfter = parseCardForAssertions(after);
    assert(parsedAfter.fields.strength === '4' && parsedAfter.fields.last_used === FIXED_DAY, 'report did not persist strength/last_used');
    assert(parsedAfter.fields.revisions === '0', 'report rewrote revisions');
    assert(parsedAfter.fields.name === '重启服务' && parsedAfter.fields.trigger === '[运维, 重启]', 'report moved name/trigger');
    assert(
      normalizedBody(parsedAfter.body) === normalizedBody(parseCardForAssertions(before).body),
      'report changed the prose body',
    );
    assert(countRevLines(parsedAfter.body) === 1, `report must append exactly one rev line, got ${countRevLines(parsedAfter.body)}`);
    assert(after.includes(`<!-- rev: ${FIXED_DAY} success`), `rev line: ${after.split('\n').filter((line) => line.includes('rev:')).join(' | ')}`);

    const demote = invokeTool(tool, { action: 'report', slug: '重启服务', outcome: 'failure', reason: '重启后又卡了' }, options);
    assert(demote.ok === true && demote.value.after.strength === 3, 'report failure must lower strength');
    assert(countRevLines(parseCardForAssertions(fs.readFileSync(cardPath, 'utf8')).body) === 2, 'the second report did not append a rev line');

    let last = null;
    for (let index = 0; index < 7; index += 1) {
      const result = invokeTool(tool, { action: 'report', slug: '写周报', outcome: 'success' }, options);
      assert(result.ok === true, `promote #${index + 1} failed: ${result.error?.message}`);
      last = result.value;
    }
    assert(last.after.strength === 9 && last.capped === true, `strength cap: ${last.after.strength} capped=${last.capped}`);
    assert(list({ trigger: '文档' }).items[0].strength === 9, 'list does not reflect the reported strength');

    const floorCard = save({ name: '没用的卡', trigger: ['废弃'], when: '不要用。', steps: ['别做'], strength: 0 });
    assert(floorCard.strength === 0, `explicit strength: ${floorCard.strength}`);
    const floored = invokeTool(tool, { action: 'report', slug: '没用的卡', outcome: 'failure' }, options);
    assert(floored.ok === true && floored.value.after.strength === 0 && floored.value.floored === true, 'strength floor at 0');

    const backups = backupNames(root).filter((name) => name.startsWith('重启服务.'));
    assert(backups.length === 2, `two reports need two backups, got ${backups.length}: ${backups.join(', ')}`);

    const guarded = snapshot(root);
    assertCodedError(assert, invokeTool(tool, { action: 'report', slug: '写周报' }, options), 'E_BAD_ARGUMENT', 'report without outcome');
    assertCodedError(assert, invokeTool(tool, { action: 'report', outcome: 'success' }, options), 'E_BAD_ARGUMENT', 'report without a target');
    sameSnapshot(assert, guarded, snapshot(root), 'rejected reports wrote files');
    return 'trigger filter ORs and ignores case; report +1/-1 with cap 9 and floor 0, revisions untouched, one backup per report';
  });
}

function m26IndexProcedures(runCase, assert, TMP) {
  runCase('M26', 'memory_index: procedures/ 进扫描计数，INDEX 有「程序性」小节且不与主表重复', () => {
    const root = fixture(TMP, 'm26-index');
    put(root, 'topics/工程约定.md', topicCard('工程约定'));
    put(root, 'journal/2026-11-02.md', topicCard('今天的日志', 2));
    const saved = invokeTool(procedureTool(assert), {
      action: 'save',
      name: '部署流程',
      trigger: ['部署', '上线'],
      when: '发版时。',
      steps: ['跑测试', '打包'],
      strength: 4,
    }, procedureOptions(root));
    assert(saved.ok === true, `save failed: ${saved.error?.message}`);

    const dry = memoryIndex({}, { memoryRoot: root, now: FIXED_NOW });
    assert(dry.ok === true && dry.dryRun === true, 'index dry-run failed');
    assert(dry.cards === 3, `cards: ${dry.cards}, expected 3`);
    assert(dry.procedures === 1, `procedures: ${dry.procedures}, expected 1`);
    assert(dry.legacy === 0, `legacy: ${dry.legacy}`);
    assert(dry.invalid === 0, `invalid: ${dry.invalid}`);

    const section = dry.generated;
    assert(section.includes('<!-- cards: 3 · legacy: 0 · procedures: 1 · active: 3 · locked: 0 · archived: 0 -->'), `counter line: ${section.split('\n')[2]}`);
    assert(section.includes('### 程序性（procedures/）'), 'the 「程序性」 subsection heading is missing');
    assert(section.includes('| 名称 | 触发 | 路径 | strength | 版本 |'), 'the procedures table header is missing');
    const procRow = section.split('\n').find((line) => line.includes('procedures/部署流程.md'));
    assert(Boolean(procRow), 'the procedure card is not in the generated section');
    assert(procRow.includes('部署流程'), `procedure row name: ${procRow}`);
    assert(procRow.includes('部署, 上线'), `procedure row trigger: ${procRow}`);
    assert(procRow.includes('| 4 |') && procRow.includes('| 1 |'), `procedure row strength/version: ${procRow}`);
    assert(
      section.split('procedures/部署流程.md').length - 1 === 1,
      'the procedure card must appear exactly once (not in both tables)',
    );
    assert(countGeneratedRows(section) === 3, `generated rows ${countGeneratedRows(section)} != 3 cards`);
    assert(section.includes('topics/工程约定.md') && section.includes('journal/2026-11-02.md'), 'core rows disappeared');

    const before = snapshot(root, ['.longlive', 'INDEX.md']);
    const applied = memoryIndex({ apply: true }, { memoryRoot: root, now: FIXED_NOW });
    assert(applied.ok === true && applied.applied === true, 'index apply failed');
    assert(applied.cards === 3 && applied.procedures === 1, `applied counts: ${applied.cards}/${applied.procedures}`);
    assert(applied.backupRel === null || typeof applied.backupRel === 'string', 'first apply has no backup to report');
    const text = fs.readFileSync(path.join(root, 'INDEX.md'), 'utf8');
    const written = extractGeneratedSection(text);
    assert(Boolean(written), 'INDEX.md has no generated section');
    assert(countGeneratedRows(written) === 3, `INDEX.md rows ${countGeneratedRows(written)} != 3`);
    assert(written.includes('### 程序性（procedures/）'), 'INDEX.md lost the procedures section');
    assert(written.includes('procedures/部署流程.md'), 'INDEX.md lost the procedure row');
    sameSnapshot(assert, before, snapshot(root, ['.longlive', 'INDEX.md']), 'index apply must not touch cards');

    const again = memoryIndex({ apply: true }, { memoryRoot: root, now: FIXED_NOW });
    assert(again.changed === false, 'a second apply at the same instant must be a no-op');
    return 'procedures/ scanned and counted, one 「程序性」 table, rows == cards, idempotent apply';
  });
}

function m27ProcedureTolerance(runCase, assert, TMP) {
  runCase('M27', 'procedures/ 空目录与坏 frontmatter：不抛错，坏卡仍计数并标注', () => {
    const tool = procedureTool(assert);

    // 1) The directory does not exist at all.
    const bare = fixture(TMP, 'm27-bare');
    put(bare, 'topics/只有主题.md', topicCard('只有主题'));
    const bareDry = memoryIndex({}, { memoryRoot: bare, now: FIXED_NOW });
    assert(bareDry.ok === true && bareDry.cards === 1 && bareDry.procedures === 0, `no dir: ${bareDry.cards}/${bareDry.procedures}`);
    assert(bareDry.generated.includes('### 程序性（procedures/）'), 'the procedures subsection must exist even with no directory');
    assert(countGeneratedRows(bareDry.generated) === 1, `no dir rows: ${countGeneratedRows(bareDry.generated)}`);

    // 2) The directory exists and is empty.
    const empty = fixture(TMP, 'm27-empty');
    fs.mkdirSync(path.join(empty, 'procedures'), { recursive: true });
    put(empty, 'topics/只有主题.md', topicCard('只有主题'));
    const emptyDry = memoryIndex({}, { memoryRoot: empty, now: FIXED_NOW });
    assert(emptyDry.ok === true && emptyDry.procedures === 0, `empty dir: ${emptyDry.procedures}`);
    assert(countGeneratedRows(emptyDry.generated) === 1, `empty dir rows: ${countGeneratedRows(emptyDry.generated)}`);
    const emptyList = invokeTool(tool, { action: 'list' }, procedureOptions(empty));
    assert(emptyList.ok === true && emptyList.value.count === 0, `empty store list: ${emptyList.value?.count}`);

    // 3) An unterminated frontmatter block must not take the index down.
    const broken = fixture(TMP, 'm27-broken');
    put(broken, 'topics/好卡.md', topicCard('好卡'));
    put(broken, 'procedures/坏卡.md', '---\nname: 坏卡\ntrigger: [x]\n');
    const brokenDry = memoryIndex({}, { memoryRoot: broken, now: FIXED_NOW });
    assert(brokenDry.ok === true, `index threw on a broken procedure card: ${brokenDry.error?.message}`);
    assert(brokenDry.cards === 2, `broken card must still be counted, cards=${brokenDry.cards}`);
    assert(brokenDry.invalid === 1, `invalid: ${brokenDry.invalid}`);
    assert(brokenDry.generated.includes('procedures/坏卡.md'), 'the broken card has no row');
    assert(countGeneratedRows(brokenDry.generated) === 2, `broken rows: ${countGeneratedRows(brokenDry.generated)}`);

    // 4) A parsed card that misses a required field, plus a bare legacy card.
    put(broken, 'procedures/缺字段.md', '---\nname: 缺字段\nsalience: 3\n---\n\n## 何时用\n\n随便。\n');
    put(broken, 'procedures/纯正文.md', '# 纯正文\n\n没有 frontmatter 的旧卡。\n');
    const fourDry = memoryIndex({}, { memoryRoot: broken, now: FIXED_NOW });
    assert(fourDry.ok === true && fourDry.cards === 4, `cards=${fourDry.cards}, expected 4`);
    assert(fourDry.invalid === 2, `invalid: ${fourDry.invalid}`);
    assert(fourDry.legacy === 1, `legacy: ${fourDry.legacy}`);
    assert(countGeneratedRows(fourDry.generated) === 4, `rows: ${countGeneratedRows(fourDry.generated)}`);

    const listed = invokeTool(tool, { action: 'list' }, procedureOptions(broken));
    assert(listed.ok === true, `list threw on broken cards: ${listed.error?.message}`);
    assert(listed.value.count === 3, `list should show 3 procedure cards, got ${listed.value.count}`);
    assert(
      listed.value.invalid.length === 2
        && listed.value.invalid.some((item) => item.rel === 'procedures/坏卡.md')
        && listed.value.invalid.some((item) => item.rel === 'procedures/缺字段.md'),
      `invalid list: ${JSON.stringify(listed.value.invalid)}`,
    );

    const before = snapshot(broken);
    assertCodedError(assert, invokeTool(tool, { action: 'get', slug: '坏卡' }, procedureOptions(broken)), 'E_PROCEDURE_INVALID', 'get a broken card');
    assertCodedError(assert, invokeTool(tool, { action: 'get', slug: '缺字段' }, procedureOptions(broken)), 'E_PROCEDURE_INVALID', 'get an incomplete card');
    assertCodedError(
      assert,
      invokeTool(tool, { action: 'save', name: '缺字段', when: 'x', steps: ['y'] }, procedureOptions(broken)),
      'E_PROCEDURE_INVALID',
      'save must not silently overwrite an incomplete card',
    );
    sameSnapshot(assert, before, snapshot(broken), 'tolerating broken cards must not write');
    return 'absent/empty procedures/ indexed with zero rows; broken, incomplete and legacy cards counted and reported, never thrown';
  });
}

function m28Recall(runCase, assert, TMP) {
  runCase('M28', 'memory_recall: 混合打分、分数排序、topK、room/status 过滤、locked 可命中、只读', () => {
    const root = fixture(TMP, 'm28-recall');
    put(root, 'topics/听觉.md', cardFile({
      title: '听觉训练与离散进化',
      tags: ['听觉', '训练'],
      status: 'locked',
      salience: 5,
      body: '从听觉开始，靠离散训练长出人类那样的感觉。听觉是起点，训练是方法。',
    }));
    put(root, 'topics/编曲.md', cardFile({
      title: '编曲与混音',
      tags: ['arrangement'],
      body: '鼓、贝斯、钢琴与混音；听觉只在验收时用一次。',
    }));
    put(root, 'journal/2026-11-02.md', cardFile({
      title: '今天的日志',
      date: FIXED_DAY,
      body: '今天聊了听觉与训练，也聊了编曲。',
    }));

    const tool = TOOLS.find((entry) => entry.name === 'memory_recall');
    assert(tool, 'memory_recall is not registered');
    const before = snapshot(root);

    const hit = invokeTool(tool, { query: '听觉 训练' }, { memoryRoot: root });
    assert(hit.ok, `recall threw: ${hit.error?.message}`);
    const value = hit.value;
    assert(value.ok === true && Array.isArray(value.results), 'recall result shape is wrong');
    assert(value.count === value.results.length && value.count >= 2, `count/results mismatch: ${value.count}/${value.results.length}`);
    assert(value.results[0].path === 'topics/听觉.md', `top-1 is ${value.results[0].path}`);
    assert(value.results[0].score > value.results[1].score, `scores are not descending: ${value.results.map((r) => r.score).join(',')}`);
    for (const item of value.results) {
      assert(Object.keys(item).sort().join(',') === 'excerpt,path,score,title', `result fields: ${Object.keys(item).join(',')}`);
      assert(typeof item.title === 'string' && item.title.length > 0, 'title missing');
      assert(typeof item.excerpt === 'string' && item.excerpt.length > 0, 'excerpt missing');
      assert(typeof item.score === 'number' && Number.isFinite(item.score) && item.score > 0, `score invalid: ${item.score}`);
    }
    assert(value.results[0].excerpt.includes('听觉'), `excerpt does not contain the match: ${value.results[0].excerpt}`);

    // Reproducible: the same query on the same tree returns byte-identical hits.
    const again = invokeTool(tool, { query: '听觉 训练' }, { memoryRoot: root });
    assert(JSON.stringify(again.value.results) === JSON.stringify(value.results), 'two identical recalls returned different results');

    const one = invokeTool(tool, { query: '听觉', topK: 1 }, { memoryRoot: root });
    assert(one.value.results.length === 1 && one.value.topK === 1, 'topK was not applied');

    const room = invokeTool(tool, { query: '听觉', room: 'topics' }, { memoryRoot: root });
    assert(room.value.results.length > 0 && room.value.results.every((r) => r.path.startsWith('topics/')), 'room filter leaked journal cards');

    const locked = invokeTool(tool, { query: '听觉', status: 'locked' }, { memoryRoot: root });
    assert(locked.value.results.length === 1 && locked.value.results[0].path === 'topics/听觉.md', `status=locked filter: ${JSON.stringify(locked.value.results)}`);

    sameSnapshot(assert, before, snapshot(root), 'recall must be read-only');
    assert(!fs.existsSync(path.join(root, '.longlive')), 'recall created .longlive/');
    return `${value.count} hits, top1=${value.results[0].score}, locked card recalled, tree unchanged`;
  });
}

function m29RecallErrors(runCase, assert, TMP) {
  runCase('M29', 'memory_recall: 空 query 抛 E_RECALL_EMPTY_QUERY；无命中返回空列表 + E_RECALL_NO_MATCH 不抛', () => {
    const root = fixture(TMP, 'm29-recall-errors');
    put(root, 'topics/one.md', cardFile({ title: '唯一卡片', body: '这里只有一段普通正文。' }));
    const tool = TOOLS.find((entry) => entry.name === 'memory_recall');
    assert(tool, 'memory_recall is not registered');
    for (const query of [undefined, null, '', '   ', '\t\n', 42]) {
      assertCodedError(
        assert,
        invokeTool(tool, query === undefined ? {} : { query }, { memoryRoot: root }),
        'E_RECALL_EMPTY_QUERY',
        `query=${JSON.stringify(query)}`,
      );
    }

    const miss = invokeTool(tool, { query: 'zzzqqqxxx' }, { memoryRoot: root });
    assert(miss.ok, `no-match must not throw: ${miss.error?.message}`);
    assert(miss.value.ok === true, 'no-match ok flag');
    assert(miss.value.code === 'E_RECALL_NO_MATCH', `no-match code: ${miss.value.code}`);
    assert(miss.value.count === 0 && Array.isArray(miss.value.results) && miss.value.results.length === 0, 'no-match results are not empty');
    assert(typeof miss.value.message === 'string' && miss.value.message.length > 0, 'no-match message missing');
    return 'empty queries coded; no-match is an empty list with a hint, not a throw';
  });
}

function m30LockedImmune(runCase, assert, TMP) {
  runCase('M30', 'locked 卡免疫 forget：dry-run 不进提案，执行后仍在原位且字节未改', () => {
    const root = fixture(TMP, 'm30-locked-forget');
    put(root, 'topics/locked-core.md', cardFile({
      title: '核心记忆第七条', status: 'locked', salience: 3, strength: 1, lastUsed: '2020-01-01',
      body: '从听觉开始，靠离散训练长出人类那样的感觉，不是工具是伙伴。',
    }));
    put(root, 'topics/stale.md', cardFile({
      title: '旧卡', salience: 3, strength: 1, lastUsed: '2020-01-01', body: '早该被忘掉的旧卡。',
    }));
    const lockedAbs = path.join(root, 'topics', 'locked-core.md');
    const lockedBytes = fs.readFileSync(lockedAbs, 'utf8');
    const before = snapshot(root);

    const dry = memoryForget({}, { memoryRoot: root, today: FIXED_DAY, now: FIXED_NOW });
    assert(dry.dryRun === true, 'forget default is not dry-run');
    assert(dry.proposals.every((p) => p.path !== 'topics/locked-core.md'), 'locked card leaked into forget proposals');
    const immune = dry.immune.find((entry) => entry.path === 'topics/locked-core.md');
    assert(immune, `locked card missing from immune[]: ${JSON.stringify(dry.immune)}`);
    assert(/locked/i.test(String(immune.reason)), `immune reason does not name locked: ${immune.reason}`);
    sameSnapshot(assert, before, snapshot(root), 'forget dry-run');

    const run = memoryForget({ confirm: 'FORGET' }, { memoryRoot: root, today: FIXED_DAY, now: FIXED_NOW });
    assert(run.applied === true, 'confirmed forget did not run');
    assert(fs.existsSync(lockedAbs), 'locked card was moved by forget');
    assert(fs.readFileSync(lockedAbs, 'utf8') === lockedBytes, 'locked card bytes changed');
    assert(!fs.existsSync(path.join(root, 'topics', 'stale.md')), 'the active stale card was not moved');
    const tombstones = fs.readFileSync(path.join(root, 'tombstones.md'), 'utf8');
    assert(tombstones.includes('topics/stale.md') && !tombstones.includes('topics/locked-core.md'), 'tombstone lines do not match the moved set');
    return 'locked card immune (reason names locked); stale card moved; locked bytes identical';
  });
}

function m31ConsolidateLocked(runCase, assert, TMP) {  runCase('M31', 'locked 卡免疫 distill/consolidate：不作合并来源，也不作合并目标', () => {
    const root = fixture(TMP, 'm31-locked-consolidate');
    put(root, 'topics/locked.md', cardFile({
      title: '编曲核心（锁定）', tags: ['编曲', '混音'], status: 'locked', salience: 5,
      body: '编曲：鼓、贝斯、钢琴与混音的分层，先定节奏再配和声，最后混音让位给人声。',
    }));
    put(root, 'topics/active.md', cardFile({
      title: '编曲笔记', tags: ['编曲', '混音'],
      body: '编曲：鼓、贝斯、钢琴与混音的分层，先定节奏再配和声，最后混音让位给人声。',
    }));
    put(root, 'journal/2026-11-02.md', [
      '---',
      'title: 2026-11-02',
      `date: ${FIXED_DAY}`,
      'salience: 3',
      'strength: 3',
      'revisions: 0',
      '---',
      '',
      '编曲：鼓、贝斯、钢琴与混音的分层，先定节奏再配和声，最后混音让位给人声。',
      '',
    ].join('\n'));

    const before = snapshot(root, ['.longlive']);
    const report = memoryConsolidate({}, { memoryRoot: root, today: FIXED_DAY, now: FIXED_NOW });
    assert(report.ok === true, `consolidate failed: ${report.message}`);
    assert(Array.isArray(report.proposals) && report.proposals.length > 0, 'fixture produced no proposal');
    assert(report.proposals.every((p) => p.target !== 'topics/locked.md'), 'locked card was used as a merge target');
    assert(report.proposals.every((p) => p.source !== 'topics/locked.md'), 'locked card was used as a merge source');
    assert(report.proposals.some((p) => p.target === 'topics/active.md'), `active card was not chosen: ${JSON.stringify(report.proposals.map((p) => p.target))}`);
    assert(report.lockedSkipped >= 1, `lockedSkipped not reported: ${report.lockedSkipped}`);
    sameSnapshot(assert, before, snapshot(root, ['.longlive']), 'consolidate must not edit cards');
    return `${report.proposals.length} proposal(s) target the active card; locked card skipped (${report.lockedSkipped})`;
  });
}

function m32StatusFields(runCase, assert, expectCode) {
  runCase('M32', 'status/salience: 缺省 active、locked/archived 可读写、非法值报 E_CARD_*_INVALID', () => {
    const locked = parseFrontmatter('---\ntitle: x\nstatus: locked\nsalience: 9\n---\nBODY');
    assert(locked.fields.status === 'locked' && locked.fields.salience === 9, 'locked/9 did not parse');
    const plain = parseFrontmatter('---\ntitle: x\n---\nBODY');
    assert(plain.fields.status === 'active', `missing status defaulted to ${plain.fields.status}`);
    assert(parseFrontmatter('---\ntitle: x\nstatus: archived\n---\nBODY').fields.status === 'archived', 'archived did not parse');

    expectCode(() => parseFrontmatter('---\nstatus: frozen\n---\nBODY'), 'E_CARD_STATUS_INVALID');
    expectCode(() => parseFrontmatter('---\nstatus: LOCKED\n---\nBODY'), 'E_CARD_STATUS_INVALID');
    expectCode(() => parseFrontmatter('---\nsalience: 10\n---\nBODY'), 'E_CARD_SALIENCE_INVALID');
    expectCode(() => parseFrontmatter('---\nsalience: 3.5\n---\nBODY'), 'E_CARD_SALIENCE_INVALID');

    expectCode(() => updateFrontmatter('---\ntitle: x\n---\nBODY', { status: 'frozen' }), 'E_CARD_STATUS_INVALID');
    expectCode(() => updateFrontmatter('---\ntitle: x\n---\nBODY', { salience: 10 }), 'E_CARD_SALIENCE_INVALID');
    expectCode(() => serializeFrontmatter({ ...DEFAULT_FIELDS, status: 'frozen' }, {}), 'E_CARD_STATUS_INVALID');
    expectCode(() => serializeFrontmatter({ ...DEFAULT_FIELDS, salience: -1 }, {}), 'E_CARD_SALIENCE_INVALID');

    const updated = updateFrontmatter('---\ntitle: x\nsalience: 3\n---\nBODY', { status: 'locked', salience: 5 });
    const reload = parseFrontmatter(updated);
    assert(reload.fields.status === 'locked' && reload.fields.salience === 5, `update did not stick: ${updated}`);
    assert(reload.body === 'BODY', 'body changed during status update');
    // active is the default and is not written back, so legacy cards stay minimal.
    const active = updateFrontmatter('---\ntitle: x\nsalience: 3\n---\nBODY', { status: 'active' });
    assert(!/status\s*:/.test(active), `default active was serialized: ${active}`);
    return 'locked/archived parse; active is the default; invalid status/salience coded on read and write';
  });
}

function m33IndexStatusStats(runCase, assert, TMP) {
  runCase('M33', 'memory_index: 统计分别列 active / locked / archived，INDEX 计数器同步', () => {
    const root = fixture(TMP, 'm33-index-status');
    for (const [rel, title, status] of [
      ['topics/a.md', '主动一', 'active'],
      ['topics/b.md', '主动二', 'active'],
      ['topics/c.md', '锁定三', 'locked'],
      ['topics/d.md', '归档四', 'archived'],
    ]) {
      put(root, rel, cardFile({ title, status, salience: status === 'locked' ? 5 : 3 }));
    }
    put(root, 'topics/legacy.md', '# 旧卡\n\n没有 frontmatter 的老卡，默认 active。\n');
    put(root, 'INDEX.md', `# 索引\n\n${BEGIN_GENERATED}\n${END_GENERATED}\n`);

    const dry = memoryIndex({}, { memoryRoot: root, now: FIXED_NOW });
    assert(dry.active === 3 && dry.locked === 1 && dry.archived === 1, `counts: active=${dry.active} locked=${dry.locked} archived=${dry.archived}`);
    assert(dry.generated.includes('active: 3') && dry.generated.includes('locked: 1') && dry.generated.includes('archived: 1'), `counter line lacks status counts: ${dry.generated.split('\n')[2]}`);

    const applied = memoryIndex({ apply: true }, { memoryRoot: root, now: FIXED_NOW });
    assert(applied.applied === true, 'apply failed');
    const index = fs.readFileSync(path.join(root, 'INDEX.md'), 'utf8');
    assert(index.includes('active: 3') && index.includes('locked: 1') && index.includes('archived: 1'), 'INDEX.md does not carry the status counts');
    return 'active=3 (2 explicit + 1 legacy), locked=1, archived=1 in result and INDEX';
  });
}

function m34ScopeRouting(runCase, assert, TMP) {
  runCase('M34', 'consolidate: scope 是 frontmatter 字段，并按 scope 覆盖率（×3）选卡', () => {
    const parsed = parseFrontmatter('---\ntitle: t\nscope: 母带, LUFS，动态\n---\nBODY');
    assert(parsed.fields.scope === '母带, LUFS，动态', `scope did not parse into fields: ${parsed.fields.scope}`);
    assert(!('scope' in parsed.extras), 'scope is still treated as an unknown key');
    const round = parseFrontmatter(serializeFrontmatter(parsed.fields, parsed.extras));
    assert(round.fields.scope === '母带, LUFS，动态', 'scope did not survive serialization');
    const updated = updateFrontmatter('---\ntitle: t\n---\nBODY', { scope: '母带 LUFS' });
    assert(/scope:\s*母带 LUFS/.test(updated), `updateFrontmatter did not write scope: ${updated}`);

    const root = fixture(TMP, 'm34-scope-routing');
    put(root, 'topics/arrangement.md', cardFile({ title: '编曲笔记', tags: ['编曲'], body: '鼓、贝斯、和声。' }));
    put(root, 'topics/mastering.md', cardFile({ title: '音频笔记', scope: '母带 LUFS 动态 响度', body: '待补。' }));
    put(root, 'journal/2026-11-02.md', journalFile(FIXED_DAY, [
      '结论：母带响度按 LUFS 处理，动态范围不达标就重做。',
    ]));
    const result = memoryConsolidate({}, { memoryRoot: root, today: FIXED_DAY, now: FIXED_NOW });
    assert(result.ok === true && result.proposals.length === 1, `expected one proposal: ${result.message}`);
    const proposal = result.proposals[0];
    assert(proposal.target === 'topics/mastering.md', `scope did not route the paragraph: ${proposal.target} / ${proposal.reason}`);
    assert(proposal.reason.includes('原文引用') && proposal.reason.includes('话题命中'), `reason lost routing evidence: ${proposal.reason}`);
    assert(/\d+%/.test(proposal.reason) === false, `a hit reason should not print a coverage percentage: ${proposal.reason}`);
    return `scope round-trips and routes to ${proposal.target}`;
  });
}

function m35ContentTokens(runCase, assert, TMP) {
  runCase('M35', 'contentTokens: 剥 URL/域名/纯数字/年份，CJK bigram 去停用词，不再靠日期选中卡', () => {
    const tokens = contentTokens('参见 https://example.com/a/2026 与 docs.acestudio.ai，2026-10-27 复跑 surfaceOp 12 次。');
    for (const noise of ['https', 'example', 'com', 'acestudio', 'ai', '2026', '12']) {
      assert(!tokens.has(noise), `noise token survived: ${noise} in ${JSON.stringify([...tokens.keys()])}`);
    }
    assert(tokens.has('surface') || tokens.has('surfaceop'), `identifier token lost: ${JSON.stringify([...tokens.keys()])}`);
    assert(tokens.size > 0 && [...tokens.values()].every((count) => count > 0), 'token counts must be positive');

    const root = fixture(TMP, 'm35-date-routing');
    put(root, 'topics/dated.md', cardFile({ title: '2026-10-27 记录', body: '数字与日期。' }));
    put(root, 'journal/2026-11-02.md', journalFile(FIXED_DAY, [
      '2026-10-27 决定再跑一次。',
    ]));
    const result = memoryConsolidate({}, { memoryRoot: root, today: FIXED_DAY, now: FIXED_NOW });
    assert(result.proposals.length === 1, `expected one proposal: ${result.proposals.length}`);
    assert(result.proposals[0].target === null, `date-only overlap routed to ${result.proposals[0].target}`);
    assert(result.proposals[0].reason.includes('建议新建卡'), `abstain reason missing: ${result.proposals[0].reason}`);
    return `noise tokens dropped; date-only paragraph abstains`;
  });
}

function m36ClaimRouting(runCase, assert, TMP) {
  runCase('M36', 'consolidate: 结论句路由；症状句再多也不改目标', () => {
    const root = fixture(TMP, 'm36-claim-routing');
    put(root, 'topics/mastering.md', cardFile({ title: '母带笔记', scope: '母带 LUFS 响度' }));
    put(root, 'topics/arrangement.md', cardFile({ title: '编曲笔记', scope: '编曲 鼓 贝斯 和声' }));
    put(root, 'journal/2026-11-02.md', journalFile(FIXED_DAY, [
      '今天又把编曲过了一遍，鼓、贝斯与和声都逐个试过，鼓组和贝斯听起来都没问题，和声也没有打架。结论：母带 LUFS 响度超标，编曲不用改。',
    ]));
    const result = memoryConsolidate({}, { memoryRoot: root, today: FIXED_DAY, now: FIXED_NOW });
    assert(result.proposals.length === 1, `expected one proposal: ${result.proposals.length}`);
    const proposal = result.proposals[0];
    assert(proposal.target === 'topics/mastering.md', `claim routing failed, target=${proposal.target}`);
    assert(proposal.claim === '结论：母带 LUFS 响度超标，编曲不用改。', `claim sentence wrong: ${proposal.claim}`);
    assert(proposal.reason.includes('原文引用『结论：母带 LUFS 响度超标，编曲不用改。』'), `reason should quote the claim: ${proposal.reason}`);
    return `conclusion sentence routed to ${proposal.target}`;
  });
}

function m37QuoteRequired(runCase, assert, TMP) {
  runCase('M37', 'consolidate: quote 必须是原文精确子串，理由与报告都带引用', () => {
    const root = fixture(TMP, 'm37-quote');
    put(root, 'topics/memory.md', cardFile({ title: '记忆日志', scope: '记忆 日志 备份' }));
    const paragraph = '决定：记忆日志按天备份。备份文件放在 sessions 目录之外，每天一次。';
    put(root, 'journal/2026-11-02.md', journalFile(FIXED_DAY, [paragraph]));
    const result = memoryConsolidate({}, { memoryRoot: root, today: FIXED_DAY, now: FIXED_NOW });
    assert(result.proposals.length === 1, `expected one proposal: ${result.proposals.length}`);
    const proposal = result.proposals[0];
    assert(typeof proposal.quote === 'string' && proposal.quote.length > 0, `proposal has no quote: ${proposal.quote}`);
    assert(paragraph.includes(proposal.quote), `quote is not an exact substring: ${proposal.quote}`);
    assert(proposal.reason.startsWith(`原文引用『${proposal.quote}』`), `reason does not lead with the quote: ${proposal.reason}`);
    assert(proposal.quote.length <= 120, `quote too long: ${proposal.quote.length}`);
    const report = fs.readFileSync(path.join(root, '.longlive', 'reports', 'consolidate-2026-11-02.md'), 'utf8');
    assert(report.includes(`- 原文引用：${proposal.quote}`), 'report is missing the exact quote');
    return `quote kept verbatim (${proposal.quote.length} chars) and echoed in the report`;
  });
}

function m38Abstain(runCase, assert, TMP) {
  runCase('M38', 'consolidate: 排期指令与低覆盖都弃权，并建议新建卡', () => {
    const root = fixture(TMP, 'm38-abstain');
    put(root, 'topics/music.md', cardFile({ title: '音乐体系', scope: '音乐 体系 审计 章节' }));
    put(root, 'topics/groceries.md', cardFile({ title: '采购', scope: '牛奶 面包' }));
    put(root, 'journal/2026-11-02.md', journalFile(FIXED_DAY, [
      '音乐体系审计先挂起，排在记忆模块之后，在他点名前不动音乐。',
      '',
      '今天顺手把桌面收拾了一下，别的什么都没动。',
    ]));
    const result = memoryConsolidate({}, { memoryRoot: root, today: FIXED_DAY, now: FIXED_NOW });
    assert(result.proposals.length === 2, `expected two proposals: ${result.proposals.length}`);
    const [plan, low] = result.proposals;
    assert(plan.target === null, `plan paragraph was routed to ${plan.target}`);
    assert(plan.reason.includes('建议新建卡'), `plan abstain reason missing: ${plan.reason}`);
    assert(low.target === null, `low-coverage paragraph was routed to ${low.target}`);
    assert(/最高覆盖\s*\d+%/.test(low.reason), `low-coverage reason missing the percentage: ${low.reason}`);
    return `both paragraphs abstain: plan + ${low.reason.match(/最高覆盖\s*\d+%/)?.[0]}`;
  });
}

function m39EntryUnits(runCase, assert, TMP) {
  runCase('M39', 'F6 paragraphUnits: unit 带 startLine/endLine，entrySplit 才在时间戳/结论行切', () => {
    const body = [
      '## 2026-11-02 日志',
      '- 症状：日志坏了。',
      '- 决定：先备份。',
      '- **2026-10-30 12:38** 日志截断成功。',
      '- 结论：备份放在 sessions 外。',
    ].join('\n');
    const flat = paragraphUnits(body);
    assert(Array.isArray(flat) && flat.length === 1, `default units should stay whole: ${JSON.stringify(flat)}`);
    assert(flat[0].startLine === 2 && flat[0].endLine === 5, `unit range wrong: ${flat[0].startLine}-${flat[0].endLine}`);
    assert(flat[0].text.startsWith('- 症状：日志坏了。'), `heading leaked into unit: ${flat[0].text}`);

    const split = paragraphUnits(body, { splitEntries: true });
    assert(split.length === 4, `entry split produced ${split.length} units`);
    assert(split.map((unit) => unit.startLine).join(',') === '2,3,4,5', `startLine: ${split.map((unit) => unit.startLine).join(',')}`);
    assert(split.every((unit) => unit.endLine >= unit.startLine), 'endLine must not precede startLine');

    const root = fixture(TMP, 'm39-entry-units');
    put(root, 'topics/ops.md', cardFile({ title: '运维日志', scope: '日志 备份 截断' }));
    put(root, 'journal/2026-11-02.md', journalFile(FIXED_DAY, body.split('\n')));
    const flatRun = memoryConsolidate({}, { memoryRoot: root, today: FIXED_DAY, now: FIXED_NOW });
    assert(flatRun.proposals.length === 1, `default mode should emit one proposal: ${flatRun.proposals.length}`);
    const splitRun = memoryConsolidate({ entrySplit: true }, { memoryRoot: root, today: FIXED_DAY, now: FIXED_NOW });
    assert(splitRun.proposals.length === 4, `entrySplit should emit four proposals: ${splitRun.proposals.length}`);
    assert(new Set(splitRun.proposals.map((p) => p.lineStart)).size === 4, 'entry proposals reuse a line number');
    return `1 unit by default, 4 with entrySplit (lines 2-5)`;
  });
}

function m40Provenance(runCase, assert, TMP) {
  runCase('M40', 'B3 provenance: 新卡写 source_session/source_turn/written_at，合并时保留旧值', () => {
    const root = fixture(TMP, 'm40-provenance');
    const tool = procedureTool(assert);
    const options = { memoryRoot: root, now: FIXED_NOW, today: FIXED_DAY };
    const exec = { agent: { id: 'session-b3' } };

    const created = invokeTool(tool, {
      action: 'save',
      name: '来源戳',
      trigger: ['provenance'],
      when: '写一张卡并记录它从哪来。',
      steps: ['记录 session 与 turn'],
    }, { ...options, exec, turn: 7 });
    assert(created.ok === true, `save failed: ${created.error?.message}`);
    const abs = path.join(root, created.value.rel);
    const firstText = fs.readFileSync(abs, 'utf8');
    const first = parseCardForAssertions(firstText);
    assert(first.fields.source_session === 'session-b3', `source_session: ${first.fields.source_session}`);
    assert(first.fields.source_turn === '7', `source_turn: ${first.fields.source_turn}`);
    assert(first.fields.written_at === FIXED_NOW.toISOString(), `written_at: ${first.fields.written_at}`);
    const keys = firstText.split('\n').slice(1, 7).map((line) => line.slice(0, line.indexOf(':')));
    assert(
      keys.join(',') === 'name,trigger,salience,strength,last_used,revisions',
      `source extras must not disturb the pinned six keys — got ${keys.join(',')}`,
    );

    const manifest = readManifest(root);
    assert(manifest !== null && manifest.cards.length === 1, `manifest cards: ${manifest?.cards.length}`);
    const row = manifest.cards[0];
    assert(row.path === created.value.rel, `manifest path: ${row.path}`);
    assert(row.source?.session === 'session-b3' && row.source?.turn === '7', `manifest source: ${JSON.stringify(row.source)}`);
    assert(row.written_at === FIXED_NOW.toISOString(), `manifest written_at: ${row.written_at}`);
    assert(verifyManifest(root).ok === true, 'a freshly saved card must verify clean');

    // A merge writes a new version but must not rewrite the original stamps.
    const merged = invokeTool(tool, {
      action: 'save',
      name: '来源戳',
      steps: ['记录 session 与 turn', '合并时保留来源'],
    }, { ...options, exec: { agent: { id: 'session-other' } }, turn: 9 });
    assert(merged.ok === true, `merge failed: ${merged.error?.message}`);
    const second = parseCardForAssertions(fs.readFileSync(abs, 'utf8'));
    assert(second.fields.source_session === 'session-b3', `merge rewrote source_session: ${second.fields.source_session}`);
    assert(second.fields.source_turn === '7', `merge rewrote source_turn: ${second.fields.source_turn}`);
    assert(second.fields.written_at === FIXED_NOW.toISOString(), `merge rewrote written_at: ${second.fields.written_at}`);

    // No host session at all: the honest label is manual/unknown, never a guess.
    const manual = invokeTool(tool, {
      action: 'save',
      name: '手工卡',
      trigger: ['手工'],
      when: '没有会话上下文时手工写卡。',
      steps: ['写 manual'],
    }, options);
    assert(manual.ok === true, `manual save failed: ${manual.error?.message}`);
    const manualFields = parseCardForAssertions(fs.readFileSync(path.join(root, manual.value.rel), 'utf8')).fields;
    assert(manualFields.source_session === 'manual', `manual session: ${manualFields.source_session}`);
    assert(manualFields.source_turn === 'unknown', `manual turn: ${manualFields.source_turn}`);

    return `source stamped (${manualFields.source_session}/${manualFields.source_turn}), merge kept the first stamp`;
  });
}

function m41Conflict(runCase, assert, TMP) {
  runCase('M41', 'B3 conflict: 同 slug/同 title/同 key 反结论才标记，旧卡正文不被覆盖', () => {
    const root = fixture(TMP, 'm41-conflict');
    const oldRel = 'topics/记忆后端.md';
    const oldText = [
      '---',
      'title: 记忆后端选型',
      'date: 2026-11-01',
      'salience: 4',
      'strength: 3',
      'revisions: 1',
      'key: 记忆后端',
      '---',
      '# 记忆后端选型',
      '',
      '结论：使用 SQLite 作为记忆后端。',
      '',
    ].join('\n');
    put(root, oldRel, oldText);
    const oldBody = parseCardForAssertions(oldText).body;

    const opposite = detectConflicts(root, {
      rel: 'topics/反方.md',
      title: '记忆后端反方',
      body: '# 记忆后端反方\n\n结论：不使用 SQLite 作为记忆后端。\n',
      key: '记忆后端',
    });
    assert(opposite.length === 1 && opposite[0].rel === oldRel, `opposite conflicts: ${JSON.stringify(opposite)}`);
    assert(opposite[0].reasons.includes('same-key-opposite-conclusion'), `opposite reasons: ${opposite[0].reasons}`);

    const sameTitle = detectConflicts(root, {
      rel: 'topics/同名.md',
      title: '记忆后端选型',
      body: '# 记忆后端选型\n\n结论：使用 Postgres 作为记忆后端。\n',
      key: '数据库',
    });
    assert(sameTitle.some((row) => row.reasons.includes('same-title')), `same-title conflicts: ${JSON.stringify(sameTitle)}`);

    const sameSlug = detectConflicts(root, {
      rel: oldRel,
      title: '记忆后端选型',
      body: '# 记忆后端选型\n\n结论：使用 Postgres 作为记忆后端。\n',
      key: '记忆后端',
    });
    assert(sameSlug.some((row) => row.reasons.includes('same-slug')), `same-slug conflicts: ${JSON.stringify(sameSlug)}`);

    // Same key, same polarity: an alternative, not a contradiction.
    const alternative = detectConflicts(root, {
      rel: 'topics/备选.md',
      title: '另一个后端',
      body: '# 另一个后端\n\n结论：使用 Postgres 作为记忆后端。\n',
      key: '记忆后端',
    });
    assert(alternative.length === 0, `same-polarity alternative was reported as conflict: ${JSON.stringify(alternative)}`);

    // Unrelated conclusion and key: must stay quiet.
    const unrelated = detectConflicts(root, {
      rel: 'topics/灰度.md',
      title: '灰度方案',
      body: '# 灰度方案\n\n结论：先灰度 10%。\n',
      key: '发布',
    });
    assert(unrelated.length === 0, `unrelated card was reported as conflict: ${JSON.stringify(unrelated)}`);

    const newRel = 'topics/记忆后端-反方.md';
    const result = writeCard(root, {
      rel: newRel,
      title: '记忆后端反方',
      body: '# 记忆后端反方\n\n结论：不使用 SQLite 作为记忆后端。\n',
      key: '记忆后端',
      sessionId: 'session-b3',
      turn: 12,
    }, { now: FIXED_NOW });
    assert(result.status === 'created' && result.conflicts.length === 1, `writeCard conflicts: ${JSON.stringify(result.conflicts)}`);
    assert(result.conflicts[0].rel === oldRel, `conflict target: ${result.conflicts[0].rel}`);
    assert(result.conflictWith.includes(oldRel), `conflictWith: ${JSON.stringify(result.conflictWith)}`);

    const newText = fs.readFileSync(path.join(root, newRel), 'utf8');
    const newFields = parseCardForAssertions(newText).fields;
    assert(newFields.conflict === `[${oldRel}]`, `new conflict marker: ${newFields.conflict}`);
    assert(newFields.source_session === 'session-b3' && newFields.source_turn === '12', 'new card lost provenance');
    assert(newFields.written_at === FIXED_NOW.toISOString(), `new written_at: ${newFields.written_at}`);

    const oldAfterText = fs.readFileSync(path.join(root, oldRel), 'utf8');
    const oldAfter = parseCardForAssertions(oldAfterText);
    assert(oldAfter.fields.conflict_with === `[${newRel}]`, `old conflict_with: ${oldAfter.fields.conflict_with}`);
    assert(oldAfter.fields.title === '记忆后端选型' && oldAfter.fields.revisions === '1', 'old card frontmatter was rewritten');
    assert(normalizedBody(oldAfter.body) === normalizedBody(oldBody), 'old card body changed');
    assert(oldAfterText.includes('结论：使用 SQLite 作为记忆后端。'), 'old conclusion was replaced');
    assert(!oldAfterText.includes('不使用 SQLite 作为记忆后端。'), 'new conclusion leaked into the old body');

    const manifest = readManifest(root);
    assert(manifest.cards.some((row) => row.path === newRel), 'new card missing from manifest');
    assert(verifyManifest(root).ok === true, 'manifest must match both cards after a conflict write');

    // Same rel again: refused, and nothing on disk moves (not even a backup).
    const before = snapshot(root);
    let duplicate = null;
    try {
      writeCard(root, {
        rel: newRel,
        title: '记忆后端反方',
        body: '# 记忆后端反方\n\n结论：使用 SQLite 作为记忆后端。\n',
        key: '记忆后端',
      }, { now: FIXED_NOW });
    } catch (error) {
      duplicate = error;
    }
    assert(duplicate !== null && duplicate.code === 'E_CARD_EXISTS', `duplicate write: ${duplicate?.code ?? duplicate}`);
    sameSnapshot(assert, before, snapshot(root), 'E_CARD_EXISTS must be a no-op');

    // The existing procedure writer is the other real write path: a new
    // procedure must get the same marker when an older card shares its title.
    put(root, 'topics/部署流程.md', cardFile({ title: '部署流程', body: '旧结论：手工部署。' }));
    const procedure = invokeTool(procedureTool(assert), {
      action: 'save',
      name: '部署流程',
      trigger: ['部署'],
      when: '要部署时。',
      steps: ['跑测试'],
    }, { memoryRoot: root, now: FIXED_NOW, today: FIXED_DAY });
    assert(procedure.ok === true, `procedure save failed: ${procedure.error?.message}`);
    assert(procedure.value.conflicts?.some((row) => row.rel === 'topics/部署流程.md'), `procedure conflicts: ${JSON.stringify(procedure.value.conflicts)}`);
    const procedureFields = parseCardForAssertions(fs.readFileSync(path.join(root, procedure.value.rel), 'utf8')).fields;
    assert(procedureFields.conflict === '[topics/部署流程.md]', `procedure conflict marker: ${procedureFields.conflict}`);
    const topicAfter = parseCardForAssertions(fs.readFileSync(path.join(root, 'topics/部署流程.md'), 'utf8'));
    assert(topicAfter.fields.conflict_with === `[${procedure.value.rel}]`, `topic conflict_with: ${topicAfter.fields.conflict_with}`);
    assert(verifyManifest(root).ok === true, 'manifest must include the procedure conflict write');

    return 'opposite key flagged, alternative/unrelated quiet, old body byte-identical, duplicate refused, procedure path marked too';
  });
}

function m42Manifest(runCase, assert, TMP) {
  runCase('M42', 'B3 manifest: sha256 基线可校验，能发现被改/缺失/未登记/损坏', () => {
    const root = fixture(TMP, 'm42-manifest');
    put(root, 'topics/a.md', cardFile({ title: '甲', body: '甲的内容。' }));
    put(root, 'procedures/b.md', [
      '---',
      'name: 乙',
      'trigger: [乙]',
      'salience: 3',
      'strength: 3',
      'last_used: 2026-11-01',
      'revisions: 0',
      '---',
      '',
      '## 何时用',
      '',
      '乙。',
      '',
      '## 怎么做',
      '',
      '1. 做乙。',
      '',
    ].join('\n'));
    // A broken card must still be tracked by its raw bytes, not hidden.
    put(root, 'topics/broken.md', '---\ntitle: 坏卡\n');

    const refreshed = refreshManifest(root, { now: FIXED_NOW });
    assert(refreshed.manifest.cards.length === 3, `manifest cards: ${refreshed.manifest.cards.length}`);
    const manifest = readManifest(root);
    assert(manifest.cards.map((row) => row.path).join(',') === 'procedures/b.md,topics/a.md,topics/broken.md', `manifest order: ${manifest.cards.map((row) => row.path)}`);
    for (const row of manifest.cards) {
      assert(/^[a-f0-9]{64}$/.test(row.sha256), `bad sha for ${row.path}: ${row.sha256}`);
      assert(Number.isFinite(Date.parse(row.written_at)), `bad written_at for ${row.path}: ${row.written_at}`);
      assert(row.source === null, `legacy card should have no source: ${JSON.stringify(row.source)}`);
    }

    const manifestBytes = fs.readFileSync(manifestPath(root));
    const clean = verifyManifest(root);
    assert(clean.ok === true && clean.checked === 3, `clean verify: ok=${clean.ok} checked=${clean.checked}`);
    assert(clean.changed.length === 0 && clean.missing.length === 0 && clean.untracked.length === 0, 'clean verify reported problems');
    assert(fs.readFileSync(manifestPath(root)).equals(manifestBytes), 'verifyManifest must be read-only');

    fs.appendFileSync(path.join(root, 'topics/a.md'), '\n补充。\n', 'utf8');
    const changed = verifyManifest(root);
    assert(changed.ok === false && changed.changed.length === 1, `changed verify: ${JSON.stringify(changed.changed)}`);
    assert(changed.changed[0].path === 'topics/a.md', `changed path: ${changed.changed[0].path}`);
    assert(changed.changed[0].expected_sha256 !== changed.changed[0].actual_sha256, 'changed hashes are equal');
    assert(changed.changed[0].actual_sha256 === sha(fs.readFileSync(path.join(root, 'topics/a.md'), 'utf8')), 'actual hash is not the disk hash');
    assert(fs.readFileSync(manifestPath(root)).equals(manifestBytes), 'a failed verify wrote the manifest');

    fs.unlinkSync(path.join(root, 'procedures/b.md'));
    put(root, 'journal/c.md', journalFile(FIXED_DAY, ['新卡。']));
    const gone = verifyManifest(root);
    assert(gone.ok === false, 'missing/untracked must fail verification');
    assert(gone.missing.some((row) => row.path === 'procedures/b.md'), `missing: ${JSON.stringify(gone.missing)}`);
    assert(gone.untracked.includes('journal/c.md'), `untracked: ${JSON.stringify(gone.untracked)}`);

    let parsedError = null;
    fs.writeFileSync(manifestPath(root), '{ this is not json', 'utf8');
    try {
      readManifest(root);
    } catch (error) {
      parsedError = error;
    }
    assert(parsedError !== null && parsedError.code === 'E_MANIFEST_CORRUPT', `readManifest corrupt: ${parsedError?.code ?? parsedError}`);
    const corrupt = verifyManifest(root);
    assert(corrupt.ok === false && corrupt.code === 'E_MANIFEST_CORRUPT', `corrupt verify: ${corrupt.code}`);

    fs.unlinkSync(manifestPath(root));
    const absent = verifyManifest(root);
    assert(absent.ok === false && absent.code === 'E_MANIFEST_MISSING', `absent verify: ${absent.code}`);
    assert(absent.untracked.includes('topics/a.md') && absent.untracked.includes('journal/c.md'), `absent untracked: ${JSON.stringify(absent.untracked)}`);

    // Rebuild repairs the store and the next check is clean again.
    refreshManifest(root, { now: FIXED_NOW });
    const repaired = verifyManifest(root);
    assert(repaired.ok === true && repaired.checked === 3, `repaired verify: ok=${repaired.ok} checked=${repaired.checked}`);

    // A legitimate card edit must refresh an opted-in manifest, not look like
    // tampering on the next startup check.
    const reinforced = memoryReinforce({ path: 'topics/a.md', reason: 'B3' }, { memoryRoot: root, now: FIXED_NOW, today: FIXED_DAY });
    assert(reinforced.manifest && reinforced.manifest.manifest.cards.length === 3, 'reinforce did not refresh the manifest');
    assert(verifyManifest(root).ok === true, 'manifest went stale after a legitimate reinforce');

    // Forgetting moves a card out of the indexed directories; the manifest must
    // drop it in the same run instead of reporting it as missing on startup.
    // Drop the intentionally broken card first: forget scans every card and is
    // allowed to refuse a store it cannot read (that behavior is covered by M27).
    fs.unlinkSync(path.join(root, 'topics/broken.md'));
    put(root, 'topics/old.md', cardFile({ title: '旧卡', body: '很久没用。', lastUsed: '2024-01-01' }));
    refreshManifest(root, { now: FIXED_NOW });
    const forgot = memoryForget({ confirm: 'FORGET' }, { memoryRoot: root, now: FIXED_NOW, today: FIXED_DAY });
    assert(forgot.moved === 1 && forgot.manifest, `forget did not refresh the manifest: moved=${forgot.moved}`);
    assert(verifyManifest(root).ok === true, 'manifest went stale after a legitimate forget');
    assert(readManifest(root).cards.every((row) => row.path !== 'topics/old.md'), 'forgotten card still in manifest');

    return 'changed/missing/untracked/corrupt/missing-manifest all reported; verify never wrote; reinforce/forget refresh';
  });
}

/** Entry point used by test/run.mjs. */
export function runMemorySuite({ runCase, runSymlinkCase, assert, expectCode, TMP }) {
  m1Index(runCase, assert, expectCode, TMP);
  m2Consolidate(runCase, assert, expectCode, TMP);
  m3Reinforce(runCase, assert, TMP);
  m4Forget(runCase, assert, expectCode, TMP);
  m5PathGuard(runCase, assert, expectCode, TMP);
  m6NoRoot(runCase, assert, expectCode);
  m7Frontmatter(runCase, assert, expectCode);
  m8State(runCase, assert, expectCode, TMP);
  m9ConsolidateRules(runCase, assert, expectCode, TMP);
  m10ReinforceDecay(runCase, assert, TMP);
  m11ForgetThresholds(runCase, assert, expectCode, TMP);
  m12ToolErrors(runCase, assert, expectCode, TMP);
  m13BomRoundTrip(runCase, assert, expectCode, TMP);
  m14MissingFieldEol(runCase, assert, TMP);
  m15EmptyNumericDefaults(runCase, assert, expectCode);
  m16ToolArgGuards(runCase, assert, TMP);
  m17MultilineValues(runCase, assert, expectCode);
  m18RealpathGuard(runCase, assert, expectCode, TMP);
  m18SymlinkGuard(runSymlinkCase, assert, expectCode, TMP);
  m19ReportBackupSameMs(runCase, assert, TMP);
  m20AffectMarkers(runCase, assert, TMP);
  m21DedupSince(runCase, assert, TMP);
  m22ForgetRules(runCase, assert, TMP);
  m23ForgetExecute(runCase, assert, TMP);
  m24ProcedureSaveGetList(runCase, assert, TMP);
  m25ProcedureTriggerReport(runCase, assert, TMP);
  m26IndexProcedures(runCase, assert, TMP);
  m27ProcedureTolerance(runCase, assert, TMP);
  m28Recall(runCase, assert, TMP);
  m29RecallErrors(runCase, assert, TMP);
  m30LockedImmune(runCase, assert, TMP);
  m31ConsolidateLocked(runCase, assert, TMP);
  m32StatusFields(runCase, assert, expectCode);
  m33IndexStatusStats(runCase, assert, TMP);
  m34ScopeRouting(runCase, assert, TMP);
  m35ContentTokens(runCase, assert, TMP);
  m36ClaimRouting(runCase, assert, TMP);
  m37QuoteRequired(runCase, assert, TMP);
  m38Abstain(runCase, assert, TMP);
  m39EntryUnits(runCase, assert, TMP);
  m40Provenance(runCase, assert, TMP);
  m41Conflict(runCase, assert, TMP);
  m42Manifest(runCase, assert, TMP);
}
