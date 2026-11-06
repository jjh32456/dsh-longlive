// @local/dsh-longlive — visible-conversation truncation tests
//
// These fixtures are tiny synthetic logs written under TMP. The one exception is
// N4, which copies an existing session log read-only (never writes into
// ~/.dsh/sessions) and falls back to a synthetic 46,8xx-event log when the
// machine has none; everything else stays fake. The cases pin the contract:
//   * dryRun writes nothing;
//   * writing needs the exact confirm word;
//   * the cut is a whole-turn boundary and seq is renumbered 0..n-1;
//   * the retained events keep their data field-for-field;
//   * the archive is a valid log containing exactly the dropped prefix;
//   * a torn/partial write and a crash after rename are both recoverable;
//   * a read-back mismatch after the rename itself restores the original bytes;
//   * the first user-authored message survives its dropped turn;
//   * path extraction is linear time and semantically identical to the 0.7.6
//     regular expression it replaced (N1–N5).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  parseSession,
  encodeSession,
  assertContiguous,
  deriveMessagesDigest,
} from '../src/codec.js';
import {
  truncateVisibleSession,
  planVisibleTruncation,
  buildVisibleTruncated,
  recoverInflight,
  readInflight,
  inflightPathFor,
  archiveDirFor,
  matchPathStrings,
  extractPaths,
  VISIBLE_CONFIRM_WORD,
  INFLIGHT_FILENAME,
  ERROR_CODES,
} from '../src/truncate-visible.js';
import { truncateVisibleTool, truncateTool, TOOLS, LIVE_GUARD_CODES, LIVE_ESCAPE_CONFIRM_WORD } from '../src/tools.js';
import { ensureBackup } from '../src/backup.js';
import { CONFIRM_WORD } from '../src/truncate.js';

// The manual tools refuse to write the session this app has loaded. A test run
// is never the loaded session: pin a synthetic id so every fixture (whose ids
// are `session-visible-*`) is "some other session". Tests that need an unknown
// caller delete this variable and restore it in a finally block.
if (!process.env.DSH_SESSION_ID) process.env.DSH_SESSION_ID = 'session-suite-runner';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function buildFixture({ id, turns = 20, title = '可见截断测试', checkpointAt = 0 }) {
  const events = [];
  const surface = [];
  const base = Date.now() - 60_000;
  const push = (event) => {
    event.seq = events.length;
    event.time = base + events.length;
    events.push(event);
    if (event.surfaceOp === 'append') surface.push(event.seq);
  };
  push({
    type: 'system/message',
    surfaceOp: 'append',
    data: { message: { role: 'system', id: 'system-1', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: '测试用系统提示' }] } },
  });
  if (title) push({ type: 'session/title', data: { title, messageSeqs: [], source: { kind: 'user' } } });
  for (let t = 1; t <= turns; t += 1) {
    push({ type: 'turn/start', data: { turn: t } });
    push({ type: 'step/start', data: { turn: t, step: 1 } });
    push({
      type: 'user/message',
      surfaceOp: 'append',
      data: {
        turn: t, step: 1, role: 'user', id: `user-${t}`,
        content: [{ type: 'text', text: `第 ${t} 个问题` }],
        source: { kind: 'user', clientTimeZone: 'Asia/Shanghai' },
      },
    });
    push({
      type: 'assistant/message',
      surfaceOp: 'append',
      data: {
        turn: t, step: 1, stream: [],
        message: {
          role: 'assistant', id: `assistant-call-${t}`,
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' },
          content: [{ type: 'tool-call', id: `call-${t}`, name: 'demo', arguments: '{"n":1}' }],
        },
      },
    });
    push({ type: 'tool/call', data: { turn: t, step: 1, callId: `call-${t}`, name: 'demo', arguments: '{"n":1}' } });
    push({
      type: 'tool/result',
      surfaceOp: 'append',
      sourceEventSeqs: [events.length - 1],
      data: {
        turn: t, step: 1,
        message: {
          role: 'tool', source: { kind: 'tool', callId: `call-${t}` }, toolCallId: `call-${t}`,
          content: [{ type: 'text', text: '{"ok":true}' }], isError: false, id: `result-${t}`,
        },
      },
    });
    push({
      type: 'assistant/message',
      surfaceOp: 'append',
      data: {
        turn: t, step: 1, stream: [],
        message: {
          role: 'assistant', id: `assistant-${t}`,
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' },
          content: [{ type: 'text', text: `第 ${t} 个回答` }],
        },
      },
    });
    if (checkpointAt && t === checkpointAt) {
      // A compaction checkpoint replaces the visible surface so far, exactly
      // like a real log. The log truncator may cut only inside the shadowed
      // span, so a fixture that wants a *successful* truncateSession() cut
      // needs one of these (V13 does; the visible-truncation cases do not).
      const compactionId = 'ckpt-1';
      const startSeq = surface[0];
      const endSeq = surface[surface.length - 1];
      push({ type: 'compaction/start', data: { compactionId, turn: t } });
      push({
        type: 'compaction/summary',
        data: {
          compactionId, turn: t, summary: '（压缩摘要）',
          shadowedRange: { start: startSeq, end: endSeq },
          shadowedSeqs: [...surface],
        },
      });
      push({
        type: 'user/message',
        surfaceOp: { op: 'replace', startSeq, endSeq },
        sourceEventSeqs: [...surface],
        data: {
          turn: t, step: 1, role: 'user', id: `checkpoint-${t}`,
          content: [{ type: 'text', text: '（压缩摘要）' }],
          source: { kind: 'compact-checkpoint', compactionId },
        },
      });
      push({ type: 'compaction/end', data: { compactionId, turn: t } });
      surface.length = 0;
      surface.push(events.length - 1);
    }
    push({ type: 'step/end', data: { turn: t, step: 1 } });
    // Real host logs always carry a turn-end reason object. Keeping the fixture
    // honest is what lets V14/V15 prove that truncation adds the missing one on
    // its synthetic head instead of relying on unrealistic input.
    push({ type: 'turn/end', data: { turn: t, reason: { kind: 'completed' } } });
  }
  return {
    header: {
      type: 'session', version: 4, id, createdAt: base,
      cwd: 'C:\\fixtures', isSeeded: false, delegationDepth: 0,
    },
    events,
  };
}

export function writeFixture(base, name, options = {}) {
  const { header, events } = buildFixture({ id: `session-visible-${name}`, ...options });
  const file = path.join(base, 'home', 'sessions', 'scope-fixtures', name, 'session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodeSession(header, events));
  return { file, header, events };
}

function readParsed(file) {
  return parseSession(fs.readFileSync(file));
}

function fileSha(file) {
  return sha256(fs.readFileSync(file));
}

function inflightRecord({ file, backup, beforeBuf, beforeSha, built }) {
  return {
    version: 1,
    kind: 'session-truncate-visible',
    target: file,
    archivePath: `${file}.archive/test.jsonl.zstd`,
    backupPath: backup.file,
    backupSha256: beforeSha,
    beforeSha256: beforeSha,
    beforeSize: beforeBuf.length,
    expectedSha256: built.sha256,
    expectedSize: built.bytes,
    expectedEvents: built.events.length,
    expectedMessages: built.messages,
    tmpPath: `${file}.truncate-visible.tmp-test`,
    phase: 'prepared',
    startedAt: new Date().toISOString(),
    keepTurns: 5,
    keepTokens: 1_000_000,
    cutTurn: 16,
    cutSeq: 122,
    droppedEvents: 0,
    droppedMessages: 0,
    keptEvents: built.retainedEvents,
    keptMessages: built.retainedMessages,
    platform: process.platform,
    pid: process.pid,
  };
}

// ------------------------------------------------------- 0.7.6 oracle + corpus
//
// `LEGACY_PATH_RE` is a frozen copy of the pattern `extractPaths` used up to
// 0.7.6. It is test-only: src/ no longer contains it, because it backtracked
// exponentially on long separator runs. N5 uses it purely as a differential
// oracle, on strings small enough for it to finish.

const LEGACY_PATH_RE = /(?:[A-Za-z]:[\\/]|\/)(?:[^"'<>\s|:*?]+[\\/])*[^"'<>\s|:*?]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|txt|log|ps1|psm1|py|yml|yaml|zst|html|css|toml|ini|cfg|zip|png|jpg|jpeg|wav|mp3)/g;

function legacyMatchStrings(text) {
  return text.match(LEGACY_PATH_RE) ?? [];
}

function walkStrings(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string') { out.push(value); return out; }
  if (Array.isArray(value)) { for (const item of value) walkStrings(item, out); return out; }
  if (typeof value === 'object') { for (const item of Object.values(value)) walkStrings(item, out); }
  return out;
}

function separatorCount(text, limit = Number.POSITIVE_INFINITY) {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x2f || code === 0x5c) {
      count += 1;
      if (count >= limit) return count;
    }
  }
  return count;
}

function legacyExtractPaths(droppedEvents, max = 8) {
  const counts = new Map();
  for (const event of droppedEvents) {
    for (const text of walkStrings(event.data)) {
      for (const raw of legacyMatchStrings(text)) {
        const normalized = raw.replace(/\\\\/g, '\\').replace(/\\/g, '/');
        if (normalized.length < 5 || normalized.length > 180) continue;
        const key = normalized.toLowerCase();
        counts.set(key, { path: normalized, count: (counts.get(key)?.count ?? 0) + 1 });
      }
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    .slice(0, max)
    .map((item) => item.path);
}

// Hand-picked strings around every branch of the grammar: drive prefixes, bare
// slashes, quotes/whitespace/`:`/`|`/`*`/`?` terminators, extension order
// (`.json` ends at `.js`), empty bodies, multibyte text.
const CURATED_PATH_SAMPLES = [
  '', '/', 'a', '/a.js', '/a.json', '/a.jsx', '/a.JSON', '/a.mjs', '/a.jpeg', '/a.jpg', '/a.png',
  '/a b.js', '/a"b.js', '/a<b.js', '/a|b.js', '/a*b.js', '/a?b.js', '/a:b.js', '/a\tb.js',
  '/a\nb.js', '/.js', '/..js', '/a/', '/a/b/c.md', '/a//b.md', '/a\\b.md', 'C:\\a\\b.js',
  'C:/a/b.js', 'c:\\x', 'C:\\', 'C:/', 'C:a/b.js', '::C:\\a.js', 'xC:\\a.js', 'x C:\\a.js',
  '/a.js/b.md', '/a.js/b.md5', '/x/a.js.y', '/x/a.b.c.js', '/x/a.b.c', '//server/share/a.js',
  String.raw`\\server\share\a.js`, String.raw`\\?\C:\a.js`, 'see /tmp/a.js and C:\\x\\b.json now',
  'https://example.com/a.js', '/a.js?x=1', '/a.js#frag', '"/a.js"', "('/a.js')", '/a.js,',
  '/a.js;', '/a.js)', '/a.js]', '/a.js}', '/a.js\\', '/a.js|', '/汉字/文件.js', '/漢字.js',
  '/a.js/very/long/path/that/has/a/file.md', '/ab.js', '////a.js', '/a/.js', '/a/./b.js',
  '/a/../b.js', '\\\\a\\b.js', '/\\/a.js', 'C:\\a\\b', 'x.js', '.js', 'a.js', 'a/b.js',
  '/tmp/x.jpg.png', '/tmp/.hidden.md', '/tmp/a..js', '/tmp/a. .js', 'D:\\Users\\x\\.dsh\\a.zst',
];

// Deterministic pseudo-random corpus (LCG, no Math.random) over an alphabet that
// mixes separators, dots, extension letters and the characters that end a path.
function generatePathCorpus(count) {
  let state = 0x5eed1234;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const alphabet = '/\\.:abjsm1 "|*?<>-\tqdWZ_\u00e9\u6c49';
  const extensions = ['js', 'mjs', 'json', 'md', 'txt', 'png', 'jpeg', 'exe', 'JS', 'j', 'json5'];
  const junk = ['a', 'bb', 'Z', '0', '_', '-', '.', ' ', '"', ':', '|', '\u6c49'];
  const corpus = [];
  while (corpus.length < count) {
    let text = '';
    if (next() < 0.3) text += 'C:';
    const parts = 1 + Math.floor(next() * 6);
    for (let p = 0; p < parts; p += 1) {
      const roll = next();
      if (roll < 0.3) text += '/';
      else if (roll < 0.4) text += '\\';
      else if (roll < 0.5) text += '.';
      else if (roll < 0.8) text += extensions[Math.floor(next() * extensions.length)];
      else text += junk[Math.floor(next() * junk.length)];
      if (next() < 0.2) text += '.';
    }
    if (separatorCount(text, 11) > 10) continue;
    corpus.push(text);
  }
  // A few pure-random strings too, for combinations the generator never builds.
  for (let n = 0; n < 1_000; n += 1) {
    const length = 1 + Math.floor(next() * 18);
    let text = '';
    for (let i = 0; i < length; i += 1) text += alphabet[Math.floor(next() * alphabet.length)];
    if (separatorCount(text, 11) > 10) continue;
    corpus.push(text);
  }
  return corpus;
}

// Find a large, settled session log to copy read-only. Never used for anything
// but a copy: the original is only opened with fs.readFileSync/statSync.
function findRealSessionLog(minBytes = 5 * 1024 * 1024) {
  const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions');
  let scopes;
  try { scopes = fs.readdirSync(sessionsRoot, { withFileTypes: true }); } catch { return null; }
  const candidates = [];
  for (const scope of scopes) {
    if (!scope.isDirectory()) continue;
    let entries;
    try {
      entries = fs.readdirSync(path.join(sessionsRoot, scope.name), { withFileTypes: true });
    } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(sessionsRoot, scope.name, entry.name, 'session.v4.jsonl.zstd');
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      if (!stat.isFile() || stat.size < minBytes) continue;
      candidates.push({ file, size: stat.size, mtimeMs: stat.mtimeMs, name: entry.name });
    }
  }
  if (!candidates.length) return null;
  const known = candidates.find((item) => item.name.includes('0ba78a91'));
  if (known) return known;
  // Prefer a log nobody is writing right now, then the biggest one.
  const settled = candidates
    .filter((item) => Date.now() - item.mtimeMs > 10 * 60_000)
    .sort((a, b) => b.size - a.size);
  return settled[0] ?? null;
}

export function runVisibleTruncateSuite({ runCase, assert, TMP }) {
  const base = fs.mkdtempSync(path.join(TMP, 'visible-'));

  // 0.8.0-rc.11 fixtures need to tamper with texts / references without
  // changing the event count (which would invalidate seq-based references).
  // Patching happens before encoding, so every seq stays authoritative.
  function writePatchedFixture(name, options, patch) {
    const { header, events } = buildFixture({ id: `session-visible-${name}`, ...options });
    patch(events, header);
    const file = path.join(base, 'home', 'sessions', 'scope-fixtures', name, 'session.v4.jsonl.zstd');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, encodeSession(header, events));
    return { file, header, events };
  }

  runCase('V1', 'visible dry-run 不改文件、不写归档/回滚记录', () => {
    const { file } = writeFixture(base, 'dry');
    const before = fileSha(file);
    const result = truncateVisibleSession(file, {
      dryRun: true, keepTurns: 5, keepTokens: 1_000_000, recentWriteWindowMs: 0,
    });
    assert(result.needed === true, 'dry-run must find a boundary');
    assert(result.status === 'planned', `status ${result.status}`);
    assert(result.cut.turn === 16, `cut turn ${result.cut.turn}, expected 16`);
    assert(result.keptTurnCount === 5, `kept ${result.keptTurnCount}`);
    assert(fileSha(file) === before, 'dry-run changed the log bytes');
    assert(!fs.existsSync(archiveDirFor(file)), 'dry-run created an archive directory');
    assert(!fs.existsSync(inflightPathFor(file)), 'dry-run created an inflight record');
    assert(!fs.existsSync(path.join(path.dirname(file), 'truncate-visible.json')), 'dry-run wrote a ledger');
    assert(result.message.includes('预演'), 'report must say 预演');
    return `cut turn ${result.cut.turn}, kept ${result.keptTurnCount}`;
  });

  runCase('V2', 'visible 写盘必须精确确认词', () => {
    const { file } = writeFixture(base, 'confirm');
    const before = fileSha(file);
    let direct = null;
    try {
      truncateVisibleSession(file, {
        dryRun: false, confirm: 'TRUNCATE', keepTurns: 5, keepTokens: 1_000_000, recentWriteWindowMs: 0,
      });
    } catch (error) {
      direct = error;
    }
    assert(direct && direct.code === ERROR_CODES.CONFIRM_REQUIRED, `direct code ${direct?.code}`);
    assert(fileSha(file) === before, 'refused write changed the file');

    const viaTool = truncateVisibleTool({
      sessionPath: file, dryRun: false, confirm: 'truncate-visible',
      keepTurns: 5, keepTokens: 1_000_000,
    }, { home: path.join(base, 'home'), recentWriteWindowMs: 0 });
    assert(viaTool.ok === false, 'tool accepted a bad confirm word');
    assert(viaTool.code === 'CONFIRM_REQUIRED', `tool code ${viaTool.code}`);
    assert(viaTool.message.includes(VISIBLE_CONFIRM_WORD), 'tool error must name the confirm word');
    return 'both direct and tool paths refuse';
  });

  runCase('V3', 'visible 真截断：seq 连续、保留段逐字段一致、归档含被删前缀', () => {
    const { file } = writeFixture(base, 'real');
    const beforeParsed = readParsed(file);
    const beforeSha = fileSha(file);
    const result = truncateVisibleSession(file, {
      dryRun: false, confirm: VISIBLE_CONFIRM_WORD,
      keepTurns: 5, keepTokens: 1_000_000, recentWriteWindowMs: 0,
    });
    assert(result.applied === true, 'write did not land');
    assert(result.after.bytes < result.before.bytes, 'rewrite did not shrink the file');
    assert(result.after.messages < result.before.messages, 'rewrite did not reduce message count');
    assert(!fs.existsSync(inflightPathFor(file)), 'inflight record survived a successful write');
    assert(fs.existsSync(result.archivePath), 'archive file is missing');
    assert(fs.existsSync(result.backupPath), 'backup file is missing');

    const afterParsed = readParsed(file);
    assertContiguous(afterParsed.events);
    afterParsed.events.forEach((event, index) => {
      assert(event.seq === index, `event ${index} has seq ${event.seq}`);
    });
    const digest = deriveMessagesDigest(afterParsed.header, afterParsed.events);
    assert(digest.count === result.after.messages, `digest ${digest.count} != report ${result.after.messages}`);

    const originalKept = beforeParsed.events.slice(result.cut.startSeq);
    const rewrittenKept = afterParsed.events.slice(afterParsed.events.length - originalKept.length);
    assert(originalKept.length === rewrittenKept.length, 'retained length changed');
    for (let i = 0; i < originalKept.length; i += 1) {
      const expected = structuredClone(originalKept[i].data);
      if (expected && typeof expected === 'object' && typeof expected.turn === 'number') {
        expected.turn += 2 - result.cut.turn;
      }
      assert(isDeepStrictEqual(rewrittenKept[i].data, expected),
        `retained event ${i} data changed: ${JSON.stringify(rewrittenKept[i].data)} != ${JSON.stringify(expected)}`);
      assert(rewrittenKept[i].type === originalKept[i].type, `retained event ${i} type changed`);
      assert(rewrittenKept[i].time === originalKept[i].time, `retained event ${i} time changed`);
    }
    assert(rewrittenKept[0].type === 'turn/start', 'cut did not land on a turn/start');
    const withRefs = rewrittenKept.filter((event) => Array.isArray(event.sourceEventSeqs));
    assert(withRefs.length > 0, 'fixture lost its tool/result sourceEventSeqs');
    for (const event of withRefs) {
      for (const ref of event.sourceEventSeqs) {
        assert(ref < event.seq, `sourceEventSeqs ${ref} is not earlier than seq ${event.seq}`);
        assert(afterParsed.events[ref]?.type === 'tool/call', `sourceEventSeqs ${ref} does not point at tool/call`);
      }
    }

    const archiveParsed = readParsed(result.archivePath);
    assert(archiveParsed.events.length === result.cut.startSeq,
      `archive has ${archiveParsed.events.length} events, expected ${result.cut.startSeq}`);
    for (let i = 0; i < archiveParsed.events.length; i += 1) {
      assert(isDeepStrictEqual(archiveParsed.events[i].data, beforeParsed.events[i].data),
        `archive event ${i} data differs from the original`);
      assert(archiveParsed.events[i].type === beforeParsed.events[i].type, `archive event ${i} type differs`);
    }
    assert(fileSha(file) === result.after.sha256, 'read-back sha differs from report');
    assert(beforeSha !== result.after.sha256, 'sha did not change');
    return `bytes ${result.before.bytes} -> ${result.after.bytes}, messages ${result.before.messages} -> ${result.after.messages}`;
  });

  runCase('V4', 'visible 保留首条真人消息并插入归档卡', () => {
    const { file } = writeFixture(base, 'carry');
    const result = truncateVisibleSession(file, {
      dryRun: false, confirm: VISIBLE_CONFIRM_WORD,
      keepTurns: 5, keepTokens: 1_000_000, recentWriteWindowMs: 0,
    });
    const parsed = readParsed(file);
    assert(parsed.events[0].type === 'turn/start', 'synthetic head turn is not first');
    assert(parsed.events[1].type === 'step/start', 'synthetic head step is not second');
    assert(parsed.events[2].type === 'system/message', 'head is not inside the synthetic turn');
    assert(parsed.events[5].type === 'user/message', 'archive card is not first surface message after the head turn');
    assert(parsed.events[5].data.source.kind === 'archive-card', 'archive card source kind');
    const card = parsed.events[5].data.content[0].text;
    assert(card.startsWith('[已归档 '), `card does not start with [已归档: ${card.slice(0, 40)}`);
    assert(card.includes('当时在做：'), 'card has no 当时在做');
    assert(card.includes('原文归档：'), 'card has no 原文归档');
    const carry = parsed.events[6].data.content[0].text;
    assert(carry.startsWith('[会话起点 · 已归档]'), 'first-user carry marker missing');
    assert(carry.includes('第 1 个问题'), 'first-user text missing');
    assert(result.firstUserMessage.carried === true, 'report did not mark the first user message carried');
    return `card ${card.split('\n').length} lines`;
  });

  runCase('V5', 'visible 边界：12 轮/80K token 取更靠后，且不切 sub-turn', () => {
    const { file } = writeFixture(base, 'boundary');
    const parsed = readParsed(file);
    const planTurns = planVisibleTruncation(parsed, { keepTurns: 5, keepTokens: 1_000_000 });
    assert(planTurns.cutTurn === 16, `keepTurns plan cut ${planTurns.cutTurn}`);
    assert(planTurns.keptTurnCount === 5, `keepTurns kept ${planTurns.keptTurnCount}`);

    const planTokens = planVisibleTruncation(parsed, { keepTurns: 1, keepTokens: 1 });
    assert(planTokens.cutTurn === 20, `token plan cut ${planTokens.cutTurn}`);
    assert(planTokens.keptTurnCount === 1, `token plan kept ${planTokens.keptTurnCount}`);

    const none = planVisibleTruncation(parsed, { keepTurns: 100, keepTokens: 1_000_000_000 });
    assert(none.needed === false, 'a 100-turn keep request must be a no-op');
    return `turn cut ${planTurns.cutTurn}, token cut ${planTokens.cutTurn}`;
  });

  runCase('V6', 'visible 崩溃恢复：写一半可回滚、rename 后可判定完成', () => {
    const { file } = writeFixture(base, 'crash');
    const beforeBuf = fs.readFileSync(file);
    const beforeSha = sha256(beforeBuf);
    const beforeParsed = parseSession(beforeBuf);
    const plan = planVisibleTruncation(beforeParsed, { keepTurns: 5, keepTokens: 1_000_000 });
    const built = buildVisibleTruncated(beforeParsed, plan, {
      now: Date.now(), archivePath: `${file}.archive/test.jsonl.zstd`,
    });
    const backup = ensureBackup(file, {
      date: new Date(), sourceBuf: beforeBuf, sha256: beforeSha, size: beforeBuf.length,
    });
    const record = inflightRecord({ file, backup, beforeBuf, beforeSha, built });

    // A torn write: half the new buffer and a record that says "prepared".
    fs.writeFileSync(file, built.buffer.subarray(0, Math.floor(built.buffer.length / 2)));
    fs.writeFileSync(inflightPathFor(file), JSON.stringify(record, null, 2));
    assert(readInflight(file)?.target === file, 'inflight record is not readable');
    const rolled = recoverInflight(file);
    assert(rolled.status === 'rolled-back', `torn recovery status ${rolled.status}`);
    assert(fileSha(file) === beforeSha, 'torn recovery did not restore the original bytes');
    assert(!fs.existsSync(inflightPathFor(file)), 'torn recovery left the record');

    // A crash after rename: the target already has the new bytes.
    fs.writeFileSync(file, built.buffer);
    fs.writeFileSync(inflightPathFor(file), JSON.stringify(record, null, 2));
    const completed = recoverInflight(file);
    assert(completed.status === 'completed', `post-rename recovery status ${completed.status}`);
    assert(fileSha(file) === built.sha256, 'post-rename recovery changed the new bytes');
    assert(!fs.existsSync(inflightPathFor(file)), 'post-rename recovery left the record');

    // A crash before the rename: the target is still the old bytes.
    fs.writeFileSync(file, beforeBuf);
    fs.writeFileSync(inflightPathFor(file), JSON.stringify(record, null, 2));
    const clean = recoverInflight(file);
    assert(clean.status === 'clean', `pre-rename recovery status ${clean.status}`);
    assert(fileSha(file) === beforeSha, 'pre-rename recovery changed the old bytes');
    assert(!fs.existsSync(inflightPathFor(file)), 'pre-rename recovery left the record');
    return 'rolled-back / completed / clean all reached';
  });

  runCase('V7', 'visible 故障注入：rename 后校验失败会恢复备份', () => {
    const { file } = writeFixture(base, 'fault');
    const before = fileSha(file);
    let error = null;
    try {
      truncateVisibleSession(file, {
        dryRun: false, confirm: VISIBLE_CONFIRM_WORD,
        keepTurns: 5, keepTokens: 1_000_000, recentWriteWindowMs: 0,
        faultAt: 'after-rename',
      });
    } catch (caught) {
      error = caught;
    }
    assert(error && error.code === ERROR_CODES.FAULT_INJECTED, `fault code ${error?.code}`);
    assert(error.result?.restored === true, 'fault path did not report a restore');
    assert(fileSha(file) === before, 'fault path did not restore the original bytes');
    assert(!fs.existsSync(inflightPathFor(file)), 'fault path left the inflight record');
    return 'restored after injected fault';
  });

  runCase('V8', '手动工具拒绝写当前会话：两条截断工具入口拒绝，dry-run 仍可预演', () => {
    const { file } = writeFixture(base, 'tool-live');
    const currentId = 'session-visible-tool-live';
    const before = fileSha(file);
    const binds = [];
    const autoHeartbeat = { bind: (sid) => { binds.push(sid); return true; } };
    const saved = process.env.DSH_SESSION_ID;
    delete process.env.DSH_SESSION_ID; // exercise the explicit config identity path
    try {
      const cfg = { home: path.join(base, 'home'), recentWriteWindowMs: 0, currentSessionId: currentId, autoHeartbeat };

      // A dry run is a plan, not a write: the live guard must not fire.
      const planned = truncateVisibleTool({
        sessionPath: file, keepTurns: 5, keepTokens: 1_000_000,
      }, cfg);
      assert(planned.ok === true && planned.status === 'planned', `planned ${planned.status}`);
      assert(planned.message.includes('预演'), 'tool dry-run report missing 预演');
      assert(planned.rollback === null, 'dry-run must not claim a rollback command');

      const refused = truncateVisibleTool({
        sessionPath: file, dryRun: false, confirm: VISIBLE_CONFIRM_WORD,
        keepTurns: 5, keepTokens: 1_000_000,
      }, cfg);
      assert(refused.ok === false && refused.status === 'error', `written ${refused.status}`);
      assert(refused.code === LIVE_GUARD_CODES.TARGET_IS_LIVE_SESSION, `code ${refused.code}`);
      assert(refused.message.includes('currently loaded by this app'), `message ${refused.message}`);
      assert(refused.message.includes('app is stopped'), 'message does not say to stop the app');
      assert(fileSha(file) === before, 'refusal changed the session bytes');
      assert(!fs.existsSync(archiveDirFor(file)), 'refusal created an archive dir');
      assert(!fs.existsSync(inflightPathFor(file)), 'refusal left an inflight record');
      assert(binds.length > 0 && binds[0] === currentId, `identity chain did not bind (${binds.join(',')})`);

      // The log-level tool (truncateSession) shares the same live guard.
      const refusedLog = truncateTool({
        sessionPath: file, dryRun: false, confirm: CONFIRM_WORD, keepEvents: 10,
      }, cfg);
      assert(refusedLog.ok === false && refusedLog.code === LIVE_GUARD_CODES.TARGET_IS_LIVE_SESSION,
        `log tool code ${refusedLog.code}`);
      assert(fileSha(file) === before, 'log tool refusal changed the session bytes');
      return 'both tools refused; bytes, archive dir and inflight tree unchanged';
    } finally {
      process.env.DSH_SESSION_ID = saved;
    }
  });

  runCase('V9', '其他会话 + 精确确认词：允许截断并给出回滚命令；schema 含 allowLive', () => {
    const { file } = writeFixture(base, 'tool-other');
    const before = fileSha(file);
    const written = truncateVisibleTool({
      sessionPath: file, dryRun: false, confirm: VISIBLE_CONFIRM_WORD,
      keepTurns: 5, keepTokens: 1_000_000,
    }, {
      home: path.join(base, 'home'), recentWriteWindowMs: 0,
      currentSessionId: 'session-visible-somebody-else',
    });
    assert(written.ok === true && written.status === 'truncated', `written ${written.status}`);
    assert(fileSha(file) !== before, 'allowed write did not change the session bytes');
    assert(written.message.includes('已截断'), 'tool write report missing 已截断');
    assert(written.rollback.includes('Copy-Item') || written.rollback.includes('cp -f'),
      'tool write report has no rollback command');

    const tool = TOOLS.find((entry) => entry.name === 'session_truncate_visible');
    assert(tool, 'session_truncate_visible is not in TOOLS');
    for (const key of ['sessionPath', 'sessionId', 'session', 'keepTurns', 'keepTokens', 'dryRun', 'confirm', 'allowLive']) {
      assert(tool.parameters[key], `parameter ${key} missing`);
    }
    assert(tool.parameters.confirm.description.includes(VISIBLE_CONFIRM_WORD), 'confirm description');
    assert(tool.parameters.allowLive.description.includes(LIVE_ESCAPE_CONFIRM_WORD),
      'allowLive description does not name the escape word');
    const logTool = TOOLS.find((entry) => entry.name === 'session_truncate');
    assert(logTool && logTool.parameters.allowLive, 'session_truncate has no allowLive parameter');
    return `rollback: ${written.rollback.slice(0, 60)}`;
  });

  runCase('V11', '当前会话 id 未知：写路径 fail-closed 拒绝，dry-run 仍可预演', () => {
    const { file } = writeFixture(base, 'tool-unknown');
    const before = fileSha(file);
    const saved = process.env.DSH_SESSION_ID;
    delete process.env.DSH_SESSION_ID;
    try {
      const cfg = { home: path.join(base, 'home'), recentWriteWindowMs: 0 };
      const planned = truncateVisibleTool({
        sessionPath: file, keepTurns: 5, keepTokens: 1_000_000,
      }, cfg);
      assert(planned.ok === true && planned.status === 'planned', `dry-run became ${planned.status}`);

      const refused = truncateVisibleTool({
        sessionPath: file, dryRun: false, confirm: VISIBLE_CONFIRM_WORD,
        keepTurns: 5, keepTokens: 1_000_000,
      }, cfg);
      assert(refused.ok === false && refused.code === LIVE_GUARD_CODES.CURRENT_ID_UNKNOWN,
        `code ${refused.code}`);
      assert(refused.message.includes('refusing to write'), 'unknown-id message does not refuse');
      assert(fileSha(file) === before, 'unknown-id refusal changed the bytes');
      assert(!fs.existsSync(archiveDirFor(file)), 'unknown-id refusal created an archive dir');
      return 'unknown caller refused, dry-run still planned';
    } finally {
      process.env.DSH_SESSION_ID = saved;
    }
  });

  runCase('V12', 'allowLive 逃生口：缺 I-KNOW-THIS-CORRUPTS 拒绝，带它才放行', () => {
    const { file } = writeFixture(base, 'tool-escape');
    const before = fileSha(file);
    const cfg = {
      home: path.join(base, 'home'), recentWriteWindowMs: 0,
      currentSessionId: 'session-visible-tool-escape',
    };
    const noEscape = truncateVisibleTool({
      sessionPath: file, dryRun: false, confirm: VISIBLE_CONFIRM_WORD, allowLive: true,
      keepTurns: 5, keepTokens: 1_000_000,
    }, cfg);
    assert(noEscape.ok === false && noEscape.code === LIVE_GUARD_CODES.ESCAPE_CONFIRM_REQUIRED,
      `code ${noEscape.code}`);
    assert(fileSha(file) === before, 'escape refusal changed the bytes');

    const allowed = truncateVisibleTool({
      sessionPath: file, dryRun: false, confirm: LIVE_ESCAPE_CONFIRM_WORD, allowLive: true,
      keepTurns: 5, keepTokens: 1_000_000,
    }, cfg);
    assert(allowed.ok === true && allowed.status === 'truncated', `escape write ${allowed.status}`);
    assert(fileSha(file) !== before, 'escape write did not change the bytes');
    return 'refused without the escape word; applied with it';
  });

  runCase('V13', 'truncateTool allowLive 逃生口：缺词/无 allowLive 都拒绝，带词才真正写入', () => {
    // Permanent regression for src/tools.js:691. The log tool's escape path is
    // the one the 0.7.2 fix repaired: before it, the escape word was forwarded
    // to truncateSession() as `confirm`, so the core refused and allowLive
    // could never write. V12 covers only the visible tool; this case fails if
    // line 691 is changed back to `args.confirm`.
    const { file } = writeFixture(base, 'tool-log-escape', { checkpointAt: 17 });
    const before = fileSha(file);
    const cfg = {
      home: path.join(base, 'home'), recentWriteWindowMs: 0,
      currentSessionId: 'session-visible-tool-log-escape',
    };
    // Exercise the explicit config identity chain: with $DSH_SESSION_ID set to
    // the suite runner, the "own session" refusal would not fire.
    const saved = process.env.DSH_SESSION_ID;
    delete process.env.DSH_SESSION_ID;
    try {
      const noEscape = truncateTool({
        sessionPath: file, dryRun: false, confirm: CONFIRM_WORD, allowLive: true, keepEvents: 40,
      }, cfg);
      assert(noEscape.ok === false && noEscape.code === LIVE_GUARD_CODES.ESCAPE_CONFIRM_REQUIRED,
        `allowLive without the escape word -> ${noEscape.ok}/${noEscape.code}`);
      assert(fileSha(file) === before, 'escape-word refusal changed the bytes');

      const plain = truncateTool({
        sessionPath: file, dryRun: false, confirm: CONFIRM_WORD, keepEvents: 40,
      }, cfg);
      assert(plain.ok === false && plain.code === LIVE_GUARD_CODES.TARGET_IS_LIVE_SESSION,
        `own live session without allowLive -> ${plain.ok}/${plain.code}`);
      assert(fileSha(file) === before, 'live-session refusal changed the bytes');

      const allowed = truncateTool({
        sessionPath: file, dryRun: false, confirm: LIVE_ESCAPE_CONFIRM_WORD, allowLive: true, keepEvents: 40,
      }, cfg);
      assert(allowed.ok === true, `escape write refused: ${allowed.code} ${allowed.message}`);
      assert(allowed.status === 'truncated', `escape write status ${allowed.status}`);
      assert(allowed.dryRun === false, 'escape write did not report a real write');
      assert(allowed.afterEvents < allowed.beforeEvents,
        `escape write did not shrink the log (${allowed.beforeEvents} -> ${allowed.afterEvents})`);
      assert(fileSha(file) !== before, 'escape write did not change the bytes');
      assert(allowed.backupFile && fs.existsSync(allowed.backupFile), 'escape write left no backup');
      return `escape word writes through the core (${allowed.beforeEvents} -> ${allowed.afterEvents} events)`;
    } finally {
      process.env.DSH_SESSION_ID = saved;
    }
  });

  runCase('V10', 'visible 读回校验失败：rename 成功但读回字节不符时回滚并报 POST_VERIFY', () => {
    const { file } = writeFixture(base, 'readback');
    const beforeBuf = fs.readFileSync(file);
    const beforeSha = sha256(beforeBuf);
    const tool = TOOLS.find((entry) => entry.name === 'session_truncate_visible');
    assert(tool && typeof tool.invoke === 'function', 'session_truncate_visible invoke is missing');

    // The injected seam only corrupts the bytes read back after the rename; the
    // file on disk keeps the truncated bytes, so this exercises readbackVerify
    // instead of failing earlier at the rename.
    const out = tool.invoke({
      sessionPath: file, dryRun: false, confirm: VISIBLE_CONFIRM_WORD,
      keepTurns: 5, keepTokens: 1_000_000,
    }, {
      home: path.join(base, 'home'),
      recentWriteWindowMs: 0,
      currentSessionId: 'session-suite-runner',
      faultAt: 'after-rename-corrupt-readback',
    });

    assert(out.ok === false, `tool reported ok=${out.ok}`);
    assert(out.status === 'error', `tool status ${out.status}`);
    assert(out.code === ERROR_CODES.POST_VERIFY, `tool code ${out.code}`);
    assert(out.errorCode === ERROR_CODES.POST_VERIFY, `errorCode ${out.errorCode}`);
    assert(out.restored === true, 'tool result did not report a restore');
    assert(out.backupPath && fs.existsSync(out.backupPath), 'backup file is missing after rollback');
    assert(sha256(fs.readFileSync(out.backupPath)) === beforeSha, 'backup bytes differ from the original');
    assert(out.archivePath && fs.existsSync(out.archivePath), 'archive file is missing');
    const afterBuf = fs.readFileSync(file);
    assert(afterBuf.length === beforeBuf.length, `main file size ${afterBuf.length} != ${beforeBuf.length}`);
    assert(sha256(afterBuf) === beforeSha, 'main file was not rolled back byte-for-byte');
    assert(!fs.existsSync(inflightPathFor(file)), 'inflight record survived the failed write');
    const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.truncate-visible.tmp-'));
    assert(leftovers.length === 0, `tmp leftovers: ${leftovers.join(', ')}`);
    return `POST_VERIFY, restored ${beforeSha.slice(0, 12)}`;
  });

  runCase('V14', '截断产物里每个 turn/end 都有非空字符串 data.reason.kind', () => {
    const { file } = writeFixture(base, 'reason');
    const result = truncateVisibleSession(file, {
      dryRun: false, confirm: VISIBLE_CONFIRM_WORD,
      keepTurns: 5, keepTokens: 1_000_000, recentWriteWindowMs: 0,
    });
    assert(result.applied === true, 'the truncation did not land');
    const parsed = readParsed(file);
    const ends = parsed.events.filter((event) => event.type === 'turn/end');
    assert(ends.length > 0, 'the truncated log contains no turn/end at all');
    for (const event of ends) {
      const reason = event.data?.reason;
      assert(reason !== null && typeof reason === 'object' && !Array.isArray(reason),
        `turn/end seq ${event.seq} (turn ${event.data?.turn}) has no data.reason object: ${JSON.stringify(reason)}`);
      assert(typeof reason.kind === 'string' && reason.kind.trim() !== '',
        `turn/end seq ${event.seq} (turn ${event.data?.turn}) has no non-empty string data.reason.kind: ${JSON.stringify(reason.kind)}`);
    }
    // The synthetic head is the one turn/end the plugin writes itself; pin its
    // kind so a future refactor cannot "fix" the crash with a host kind that
    // would misreport why that turn ended.
    const headEnd = parsed.events[4];
    assert(headEnd.type === 'turn/end', `event 4 is ${headEnd?.type}, not the synthetic turn/end`);
    assert(headEnd.data.reason.kind === 'truncated',
      `synthetic head reason: ${JSON.stringify(headEnd.data.reason)}`);
    return `${ends.length} turn/end events, synthetic head kind "${headEnd.data.reason.kind}"`;
  });

  runCase('V15', '严格消费者：逐个 turn/end 直接读 event.data.reason.kind 不抛异常', () => {
    const { file } = writeFixture(base, 'strict-consumer');
    const result = truncateVisibleSession(file, {
      dryRun: false, confirm: VISIBLE_CONFIRM_WORD,
      keepTurns: 5, keepTokens: 1_000_000, recentWriteWindowMs: 0,
    });
    assert(result.applied === true, 'the truncation did not land');
    const parsed = readParsed(file);
    const kinds = [];
    for (const event of parsed.events) {
      if (event.type !== 'turn/end') continue;
      // No optional chaining on purpose: this is the exact third-party access
      // that threw before the synthetic event carried data.reason.
      const kind = event.data.reason.kind;
      assert(typeof kind === 'string' && kind !== '',
        `turn/end seq ${event.seq} exposed kind ${JSON.stringify(kind)}`);
      kinds.push(kind);
    }
    const total = parsed.events.filter((event) => event.type === 'turn/end').length;
    assert(kinds.length > 0, 'the consumer never saw a turn/end');
    assert(kinds.length === total, `consumer read ${kinds.length} of ${total} turn/end events`);
    return `consumer read ${kinds.length} reasons without throwing: ${[...new Set(kinds)].join(', ')}`;
  });

  // -------------------------------------------------------------------------
  // V16–V18: 0.8.0-rc.11 — a bounded first-user carry, a post-cut token
  // budget that includes the synthetic cards, and a boundary retry that drops
  // one more turn instead of throwing VISIBLE_NO_BOUNDARY at the caller.
  // -------------------------------------------------------------------------

  runCase('V16', '15,524 字符首条消息 + keepTokens 8000：复刻卡截断后预算达标', () => {
    const firstUserChars = 15_524;
    const { file } = writePatchedFixture('long-first-user', { turns: 20 }, (events) => {
      const prompt = events.find((event) => event.type === 'system/message');
      prompt.data.message.content[0].text = 'S'.repeat(5_952); // keeps the head's weight realistic
      const firstUser = events.find((event) =>
        event.type === 'user/message' && event.data?.source?.kind === 'user');
      firstUser.data.content[0].text = 'A'.repeat(firstUserChars);
      for (const event of events) {
        if (event.type !== 'assistant/message') continue;
        const part = event.data.message.content[0];
        if (part.type === 'text') part.text = part.text.padEnd(2_000, 'x');
      }
    });
    const result = truncateVisibleSession(file, { dryRun: true, keepTurns: 6, keepTokens: 8_000 });
    assert(result.needed === true, `no cut was planned: ${result.reason ?? result.message}`);
    assert(result.feasible !== false, 'V16 must be feasible');
    assert(result.budget.carryTokens > 0, 'the carried card is not counted in the budget');
    assert(result.after.tokens <= 8_000,
      `after ${result.after.tokens} tokens is still over keepTokens 8000 -> an immediate retrigger`);
    assert(result.firstUserCarry.capped === true, 'the first-user carry was not capped');
    assert(result.firstUserCarry.originalChars === firstUserChars,
      `originalChars ${result.firstUserCarry.originalChars}, expected ${firstUserChars}`);
    assert(result.firstUserCarry.keptChars <= 4_000, `kept ${result.firstUserCarry.keptChars} chars`);
    assert(result.firstUserCarry.text.endsWith(`原文见 ${result.archivePath}]`),
      `carry text lost the archive pointer: …${result.firstUserCarry.text.slice(-80)}`);
    assert(result.message.includes('已截断') && result.message.includes('预算'),
      'report does not show the cap / budget lines');
    // Same log, same cut request, but no cap: the planner can only fit the
    // budget by dropping extra turns it was asked to keep. That difference is
    // exactly why the cap is not cosmetic.
    const uncapped = planVisibleTruncation(readParsed(file), {
      keepTurns: 6, keepTokens: 8_000, firstUserCapChars: 10_000_000,
    });
    assert(uncapped.budget.carryTokens > 3_000,
      `uncapped carry ${uncapped.budget.carryTokens} tokens; fixture does not reproduce the VM card`);
    assert(uncapped.budget.trimmedTurns >= 1,
      'uncapped plan fits without trimming — the fixture is too small to prove the fix');
    assert(uncapped.budget.afterTokens > result.budget.afterTokens,
      'capping did not reduce the projected tokens');
    return `${firstUserChars} chars -> ${result.firstUserCarry.keptChars}, after ${result.budget.afterTokens} <= 8000`;
  });

  // A kept event that points into the dropped prefix is unsalvageable; an
  // event that points at *it* only becomes unsalvageable in the next pass.
  // rc.10 rebuilt the candidate set from base each pass, so those two events
  // kept taking each other's place and the loop never converged (the VM's
  // "22 candidates, 21 survived").
  function writeBoundaryRefsFixture(name, cutTurn = 15) {
    return writePatchedFixture(name, { turns: 20 }, (events) => {
      // keepTurns 6 over 20 turns cuts at turn 15 by default.
      const droppedCall = events.find((event) => event.type === 'tool/call' && event.data.turn === 2);
      const poisoned = events.find((event) =>
        event.type === 'assistant/message'
        && event.data.turn === cutTurn
        && event.data.message.content[0].type === 'text');
      poisoned.data.messageSeqs = [droppedCall.seq]; // invalid on its own
      const dependent = events.find((event) =>
        event.type === 'tool/result' && event.data.turn === cutTurn);
      dependent.data.sourceEventSeq = poisoned.seq; // only invalid once poisoned is gone
    });
  }

  runCase('V17', '边界不稳样本（引用被删前缀的链）: dryrun 收敛、不抛 NO_BOUNDARY', () => {
    const { file } = writeBoundaryRefsFixture('boundary-chain');
    const before = fileSha(file);
    const parsed = readParsed(file);
    const result = truncateVisibleSession(file, { dryRun: true, keepTurns: 6, keepTokens: 1_000_000 });
    assert(result.needed === true, `no cut: ${result.reason ?? ''}`);
    assert(result.feasible !== false, 'the boundary chain reported infeasible');
    assert(result.attempts.length === 1,
      `one pass should suffice, got ${result.attempts.length} attempts`);
    assert(result.attempts[0].code === null, `attempt carried code ${result.attempts[0].code}`);
    // Both the directly-poisoned event and its dependent are gone: the built
    // log must not reference a seq that survived the cut. The build itself
    // validates this (remapReferences returns false for a dangling seq), so
    // reaching `planned` at all is the contract; assert the sizes too.
    assert(result.after.events < result.before.events,
      `retained ${result.after.events} of ${result.before.events} events`);
    assert(fileSha(file) === before, 'dry-run rewrote the log');
    assert(result.message.includes('预演'), 'report is not a dry-run report');
    return `converged on attempt 1 (${result.before.events} -> ${result.after.events} events)`;
  });

  runCase('V18', '边界重试：第 1 次 NO_BOUNDARY，再删 1 轮后成功；预算死路则 feasible:false', () => {
    const { file } = writeBoundaryRefsFixture('boundary-retry');
    // stabilizePasses:1 makes the first cut fail on purpose, which is the
    // same decision the planner takes when its real pass budget runs out.
    const retried = truncateVisibleSession(file, {
      dryRun: true, keepTurns: 6, keepTokens: 1_000_000, stabilizePasses: 1, boundaryRetries: 2,
    });
    assert(retried.needed === true, 'the retry path did not produce a cut');
    assert(retried.feasible === true, 'the retry path reported infeasible');
    assert(retried.attempts.length === 2,
      `expected 2 attempts, got ${retried.attempts.length}`);
    assert(retried.attempts[0].code === 'VISIBLE_NO_BOUNDARY',
      `first attempt code ${retried.attempts[0].code}, expected VISIBLE_NO_BOUNDARY`);
    assert(retried.attempts[1].code === null, `second attempt code ${retried.attempts[1].code}`);
    assert(retried.cut.turn === retried.attempts[1].cutTurn,
      'successful attempt does not describe the applied cut');
    assert(retried.cut.turn > retried.attempts[0].cutTurn,
      'the retry did not drop an extra turn');

    // Dead end: the protected head + capped cards alone exceed the budget, so
    // every attempt is infeasible. That must be a structured result, never a
    // throw, and never a silent "noop".
    const headHeavy = writePatchedFixture('boundary-infeasible', { turns: 20 }, (events) => {
      const prompt = events.find((event) => event.type === 'system/message');
      prompt.data.message.content[0].text = 'H'.repeat(8_000);
    });
    const before = fileSha(headHeavy.file);
    const dead = truncateVisibleSession(headHeavy.file, {
      dryRun: true, keepTurns: 6, keepTokens: 100, boundaryRetries: 2,
    });
    assert(dead.ok === false, 'infeasible result claims ok');
    assert(dead.feasible === false, 'infeasible result claims feasible');
    assert(dead.status === 'infeasible', `status ${dead.status}`);
    assert(dead.code === ERROR_CODES.TOKEN_BUDGET, `code ${dead.code}`);
    assert(Array.isArray(dead.attempts) && dead.attempts.length >= 1,
      'the dead end recorded no attempt at all');
    assert(dead.attempts.every((attempt) => attempt.code === ERROR_CODES.TOKEN_BUDGET),
      'a dead-end attempt does not say why it was infeasible');
    assert(dead.attempts.every((attempt) => typeof attempt.cutTurn === 'number'),
      'an attempt does not carry the keepTurns/cutTurn it tried');
    assert(dead.message.includes('无法截断'), 'report does not say 无法截断');
    assert(fileSha(headHeavy.file) === before, 'infeasible dry-run changed the log');
    return `retry ${retried.attempts[0].cutTurn}->${retried.attempts[1].cutTurn}, dead end ${dead.attempts.length} attempt(s)`;
  });

  runCase('V19', '边界重试跑满 3 次：坏事件在下一轮里，逐轮多删才收敛', () => {
    // The poisoned pair sits in turn 16, so the first retry (cut turn 16) still
    // keeps it and only the second retry (cut turn 17) drops the whole turn.
    // This pins "drop one more turn per attempt", not "retry once and give up".
    const { file } = writeBoundaryRefsFixture('boundary-retry-2', 16);
    const result = truncateVisibleSession(file, {
      dryRun: true, keepTurns: 6, keepTokens: 1_000_000, stabilizePasses: 1, boundaryRetries: 3,
    });
    assert(result.feasible === true, `feasible ${result.feasible} (${result.code}: ${result.reason})`);
    assert(result.attempts.length === 3, `expected 3 attempts, got ${result.attempts.length}`);
    assert(result.attempts[0].code === 'VISIBLE_NO_BOUNDARY', `attempt 0 ${result.attempts[0].code}`);
    assert(result.attempts[1].code === 'VISIBLE_NO_BOUNDARY', `attempt 1 ${result.attempts[1].code}`);
    assert(result.attempts[2].code === null, `attempt 2 ${result.attempts[2].code}`);
    assert(result.cut.turn === 17, `cut turn ${result.cut.turn}, expected 17`);
    return `3 attempts, cut turn ${result.cut.turn}`;
  });


  // N4 keeps the real log it used so N5 can diff against real text too.
  let realLogFile = null;

  runCase('N1', 'base64 PNG 长串（≥6000 字符、多斜杠）单次路径抽取 <100ms', () => {
    const payload = 'iVBORw0KGgo' + '/'.repeat(400) + 'A'.repeat(6_000) + '/'.repeat(400) + '===';
    const text = `![img](data:image/png;base64,${payload})`;
    assert(text.length >= 6_000, `payload is only ${text.length} chars`);
    const started = process.hrtime.bigint();
    const paths = extractPaths([{ data: { text, note: 'n1' } }], 8);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert(paths.length === 0, `base64 payload yielded paths ${JSON.stringify(paths)}`);
    assert(elapsedMs < 100, `single extraction took ${elapsedMs.toFixed(1)}ms (limit 100ms)`);
    return `${text.length} chars, 0 paths, ${elapsedMs.toFixed(2)}ms`;
  });

  runCase('N2', '转义 Windows 路径串：归一化、去重与计数正确', () => {
    const escaped = String.raw`D:\\Users\\codeuser\\repos\\proj\\engine2.py`;
    const text = `cd ${escaped} && node ${escaped}`;
    const started = process.hrtime.bigint();
    const paths = extractPaths([{ data: { text } }], 8);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert(isDeepStrictEqual(paths, ['D:/Users/codeuser/repos/proj/engine2.py']),
      `escaped path extracted as ${JSON.stringify(paths)}`);
    assert(elapsedMs < 100, `single extraction took ${elapsedMs.toFixed(1)}ms (limit 100ms)`);
    // Same path, different case and separator spelling: one entry, three hits,
    // and the surviving spelling is the last one seen (0.7.6 behaviour).
    const mixed = extractPaths([
      { data: { text: 'C:\\Work\\A.js and C:/WORK/A.js and c:\\work\\a.js' } },
      { data: { text: escaped } },
    ], 8);
    assert(mixed.length === 2, `expected 2 distinct paths, got ${JSON.stringify(mixed)}`);
    assert(mixed[0].toLowerCase() === 'c:/work/a.js', `most frequent path is ${mixed[0]}`);
    assert(mixed[1].toLowerCase() === 'd:/users/codeuser/repos/proj/engine2.py',
      `second path is ${mixed[1]}`);
    return `escaped path → ${paths[0]}, ${mixed.length} distinct across spellings`;
  });

  runCase('N3', '/a 重复 30 次 + /zzz：<100ms 且结果正确', () => {
    const run = '/a'.repeat(30);
    const misses = run + '/zzz';
    const hits = run + '/zzz.js';
    let started = process.hrtime.bigint();
    const none = matchPathStrings(misses);
    const missMs = Number(process.hrtime.bigint() - started) / 1e6;
    started = process.hrtime.bigint();
    const found = matchPathStrings(hits);
    const hitMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert(none.length === 0, `slash run yielded ${JSON.stringify(none)}`);
    assert(isDeepStrictEqual(found, [hits]), `slash run with extension yielded ${JSON.stringify(found)}`);
    assert(missMs < 100, `no-match scan took ${missMs.toFixed(2)}ms (limit 100ms)`);
    assert(hitMs < 100, `match scan took ${hitMs.toFixed(2)}ms (limit 100ms)`);
    const extractionMs = (() => {
      const t0 = process.hrtime.bigint();
      extractPaths([{ data: { text: misses } }], 8);
      return Number(process.hrtime.bigint() - t0) / 1e6;
    })();
    assert(extractionMs < 100, `extractPaths took ${extractionMs.toFixed(2)}ms (limit 100ms)`);
    return `no-match ${missMs.toFixed(2)}ms, match ${hitMs.toFixed(2)}ms, extract ${extractionMs.toFixed(2)}ms`;
  });

  runCase('N4', '真实日志（46,834 事件，只读副本）带归档卡端到端截断 <10s', () => {
    const root = path.join(base, 'real', 'sessions', 'scope-real', 'session-real-copy');
    fs.mkdirSync(root, { recursive: true });
    const target = path.join(root, 'session.v4.jsonl.zstd');
    const real = findRealSessionLog();
    let source;
    if (real) {
      fs.copyFileSync(real.file, target);
      realLogFile = real.file;
      source = `real log ${real.size} bytes`;
    } else {
      // Fallback for machines without a big real log: the same shape (46,8xx
      // events over 5,200 turns) with the pathological payloads injected.
      const { header, events } = buildFixture({ id: 'session-visible-real-fallback', turns: 5_200 });
      const base64 = 'iVBORw0KGgo' + '/'.repeat(400) + 'A'.repeat(6_000) + '/'.repeat(400) + '===';
      const slashRun = '/a'.repeat(30) + '/zzz';
      let injected = 0;
      for (let i = 120; i < events.length - 120; i += 37) {
        const content = events[i]?.data?.message?.content;
        if (!Array.isArray(content) || !content[0] || events[i].type !== 'tool/result') continue;
        content[0].text = [
          `data:image/png;base64,${base64}`,
          String.raw`cwd C:\\work\\proj\\engine2.py`,
          slashRun,
        ].join('\n');
        injected += 1;
      }
      assert(injected > 0, 'the fallback log injected no pathological payload');
      fs.writeFileSync(target, encodeSession(header, events));
      source = `synthetic fallback (${injected} pathological payloads, no real log found)`;
    }

    const started = process.hrtime.bigint();
    const result = truncateVisibleSession(target, {
      dryRun: false, confirm: VISIBLE_CONFIRM_WORD,
      keepTurns: 12, keepTokens: 80_000, recentWriteWindowMs: 0,
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert(result.applied === true, 'the end-to-end truncation did not land');
    assert(result.archiveCard?.inserted === true, 'the archive card was not inserted');
    const card = result.archiveCard.text;
    assert(card.includes('涉及文件'), `the card has no path section:\n${card}`);
    assert(!/\/{20,}/.test(card), 'the card carries a raw slash run');
    assert(result.before.events >= 40_000, `only ${result.before.events} events — expected a 46.8k-event log`);
    assert(elapsedMs < 10_000, `end-to-end truncation took ${elapsedMs.toFixed(0)}ms (limit 10,000ms)`);
    const after = parseSession(fs.readFileSync(target));
    assertContiguous(after.events);
    assert(fs.existsSync(result.archivePath), 'the archive file is missing');
    assert(fs.existsSync(result.backupPath), 'the backup file is missing');
    return `${source}, ${result.before.events} events, card in ${elapsedMs.toFixed(0)}ms`;
  });

  runCase('N5', '旧新实现等价性：小样本语料逐串一致', () => {
    const corpus = [...CURATED_PATH_SAMPLES, ...generatePathCorpus(3_000)];
    let compared = 0;
    let withPaths = 0;
    for (const text of corpus) {
      const before = legacyMatchStrings(text);
      const after = matchPathStrings(text);
      assert(before.length === after.length,
        `match count differs for ${JSON.stringify(text.slice(0, 120))}: old ${before.length} new ${after.length}`);
      for (let i = 0; i < before.length; i += 1) {
        assert(before[i] === after[i],
          `match ${i} differs for ${JSON.stringify(text.slice(0, 120))}: ${JSON.stringify(before[i])} != ${JSON.stringify(after[i])}`);
      }
      compared += 1;
      if (before.length) withPaths += 1;
    }
    const events = corpus.filter((_, index) => index % 3 === 0).map((text, index) => ({ data: { text, index } }));
    assert(isDeepStrictEqual(legacyExtractPaths(events, 8), extractPaths(events, 8)),
      'the extracted path set/order differs from the 0.7.6 pipeline');

    // A bounded slice of the real log N4 used, if there is one: pathological
    // strings are excluded because the old pattern cannot finish them at all.
    let realDetail = '';
    if (realLogFile) {
      const parsed = parseSession(fs.readFileSync(realLogFile));
      const limit = 200_000;
      let seen = 0;
      let skipped = 0;
      for (const event of parsed.events) {
        for (const text of walkStrings(event.data)) {
          if (separatorCount(text, 11) > 10 || text.length > 4_000) { skipped += 1; continue; }
          if (seen >= limit) break;
          const before = legacyMatchStrings(text);
          const after = matchPathStrings(text);
          assert(before.length === after.length,
            `real-log match count differs for ${JSON.stringify(text.slice(0, 120))}`);
          for (let i = 0; i < before.length; i += 1) {
            assert(before[i] === after[i],
              `real-log match ${i} differs for ${JSON.stringify(text.slice(0, 120))}`);
          }
          seen += 1;
        }
        if (seen >= limit) break;
      }
      compared += seen;
      realDetail = `, +${seen} real-log strings (${skipped} pathological skipped)`;
    }
    return `${compared} strings identical (${withPaths} with paths)${realDetail}`;
  });
}

export const VISIBLE_SUITE_CASES = [
  'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'V11', 'V12', 'V13', 'V14', 'V15',
  'V16', 'V17', 'V18', 'V19',
  'N1', 'N2', 'N3', 'N4', 'N5',
];
