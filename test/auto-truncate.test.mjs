// 0.7.1 — user-authored-message detection + auto-truncation tests.
//
// Everything here writes under TMP. No test reads ~/.dsh/sessions.
//
// The cases are built to fail against plausible fake-greens:
//   * if isUserAuthoredMessage is loosened back to "any kind:user row", A2
//     carries the surgical checkpoint instead of the human line and goes red;
//   * if auto-truncate writes the session log again (mode apply, or a request
//     mode that "helpfully" cuts in-process), A6/A12's sha256 assertions go red;
//   * if the request file loses its single-flight guard, A12's byte compare of
//     the pending request goes red;
//   * if log/dryrun accidentally touch the session log, the sha256 assertions
//     go red.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseSession, encodeSession } from '../src/codec.js';
import {
  isUserAuthoredMessage,
  looksLikeInjectedText,
  USER_TEXT_MARKERS,
  planVisibleTruncation,
  truncateVisibleSession,
  archiveDirFor,
  inflightPathFor,
  VISIBLE_CONFIRM_WORD,
} from '../src/truncate-visible.js';
import {
  AUTO_TRUNCATE_DEFAULTS,
  AUTO_TRUNCATE_ERRORS,
  AUTO_TRUNCATE_LEGACY_MODES,
  AUTO_TRUNCATE_MODES,
  appendAutoTruncateLog,
  autoTruncatePaths,
  createAutoTruncator,
  findSessionFile,
  normalizeAutoTruncateConfig,
} from '../src/auto-truncate.js';
import { createAutoHeartbeat } from '../src/heartbeat.js';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function fileSha(file) {
  return sha256(fs.readFileSync(file));
}

function readParsed(file) {
  return parseSession(fs.readFileSync(file));
}

function readLogLines(memoryRoot) {
  const { logPath } = autoTruncatePaths(memoryRoot);
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

/**
 * A synthetic log with 20 turns. `checkpointAt` inserts one surgical-checkpoint
 * user/message (source.kind "user", rpcId, no clientTimeZone) before turn 1;
 * `humanSource` lets a case turn every turn message into an injected block.
 */
function buildFixture({ id, turns = 20, checkpointAt = null, humanSource = null, padding = 900 }) {
  const events = [];
  const base = Date.now() - 120_000;
  const push = (event) => {
    event.seq = events.length;
    event.time = base + events.length;
    events.push(event);
  };
  push({
    type: 'system/message',
    surfaceOp: 'append',
    data: {
      message: {
        role: 'system', id: 'system-1', source: { kind: 'system-prompt' },
        content: [{ type: 'text', text: '测试用系统提示' }],
      },
    },
  });
  if (checkpointAt != null) {
    push({
      type: 'user/message',
      surfaceOp: 'append',
      data: {
        role: 'user', id: 'checkpoint-1',
        content: [{
          type: 'text',
          text: 'This is an automatically generated checkpoint condensing an earlier span of the conversation. 这是压缩检查点（非用户发言）。',
        }],
        source: { kind: 'user', rpcId: 'rpc-checkpoint' },
      },
    });
  }
  for (let t = 1; t <= turns; t += 1) {
    push({ type: 'turn/start', data: { turn: t } });
    push({
      type: 'user/message',
      surfaceOp: 'append',
      data: {
        turn: t, step: 1, role: 'user', id: `user-${t}`,
        content: [{ type: 'text', text: humanSource ? humanSource(t) : `第 ${t} 个问题` }],
        source: humanSource
          ? { kind: 'runtime-context', snapshot: { t } }
          : { kind: 'user', rpcId: `rpc-${t}`, clientTimeZone: 'Asia/Shanghai' },
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
          content: [{ type: 'text', text: `第 ${t} 个回答 ${'x'.repeat(padding)}` }],
        },
      },
    });
    push({ type: 'turn/end', data: { turn: t } });
  }
  return {
    header: {
      type: 'session', version: 4, id, createdAt: base,
      cwd: 'C:\\fixtures', isSeeded: false, delegationDepth: 0,
    },
    events,
  };
}

function writeFixture(TMP, name, options = {}) {
  const id = `session-auto-${name}`;
  const { header, events } = buildFixture({ id, ...options });
  const home = path.join(TMP, 'auto-truncate', name, 'home');
  const file = path.join(home, 'sessions', 'scope-fixtures', id, 'session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodeSession(header, events));
  return { id, home, file, header, events, memoryRoot: path.join(TMP, 'auto-truncate', name, 'memory') };
}

const NOW = 1_700_000_000_000;

function clock(stepMs = 0) {
  let t = NOW;
  return () => {
    t += stepMs;
    return t;
  };
}

export async function runAutoTruncateSuite({ runCase, assert, TMP }) {
  const base = path.join(TMP, 'auto-truncate');

  runCase('A1', 'isUserAuthoredMessage：宿主字段优先，拿不准一律 false', () => {
    const human = {
      type: 'user/message',
      data: { source: { kind: 'user', rpcId: 'rpc-1', clientTimeZone: 'Asia/Shanghai' }, content: [{ type: 'text', text: '这不对，上下文会暴涨' }] },
    };
    const checkpoint = {
      type: 'user/message',
      data: {
        source: { kind: 'user', rpcId: 'rpc-2' },
        content: [{ type: 'text', text: 'This is an automatically generated checkpoint condensing an earlier span of the conversation.' }],
      },
    };
    const spliced = {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你是打包执行者，任务如下' }] },
    };
    const runtime = {
      type: 'user/message',
      data: { source: { kind: 'runtime-context', snapshot: {} }, content: [{ type: 'text', text: 'Current runtime context.' }] },
    };
    assert(isUserAuthoredMessage(human) === true, 'real human message (clientTimeZone) rejected');
    assert(isUserAuthoredMessage(checkpoint) === false, 'checkpoint accepted as human');
    assert(isUserAuthoredMessage(spliced) === false, 'spliced task brief accepted as human');
    assert(isUserAuthoredMessage(runtime) === false, 'runtime-context block accepted as human');
    assert(isUserAuthoredMessage({ type: 'assistant/message', data: human.data }) === false, 'assistant message accepted');
    assert(isUserAuthoredMessage(null) === false, 'null accepted');

    for (const marker of [
      'This is an automatically generated checkpoint',
      'Current runtime context',
      '<current_user_request>',
      '<engram_profile>',
      '<engram_memory_context>',
      '<system-reminder>',
      '[Compressed conversation section]',
      'background job b-123 finished',
      '<available_skills>',
    ]) {
      assert(looksLikeInjectedText(`${marker} …`) === true, `blacklist missed marker: ${marker}`);
    }
    assert(USER_TEXT_MARKERS.length >= 9, 'blacklist is shorter than the spec');
    return `${USER_TEXT_MARKERS.length} markers; host positive field = clientTimeZone`;
  });

  runCase('A2', '首条真人消息复刻：跳过检查点，只认 clientTimeZone 那条', () => {
    const { file } = writeFixture(TMP, 'carry', { checkpointAt: 0 });
    const parsed = readParsed(file);
    const checkpointSeq = parsed.events.findIndex((event) => event.data?.id === 'checkpoint-1');
    const humanSeq = parsed.events.findIndex((event) => event.data?.id === 'user-1');
    assert(checkpointSeq > 0 && humanSeq > checkpointSeq, 'fixture does not have checkpoint before human');

    const result = truncateVisibleSession(file, {
      dryRun: true, keepTurns: 5, keepTokens: 1_000_000,
    });
    assert(result.needed === true, 'fixture was not truncatable');
    assert(result.firstUserMessage !== null, 'no first user message found');
    assert(result.firstUserMessage.seq === humanSeq, `carried seq ${result.firstUserMessage.seq}, expected ${humanSeq}`);
    assert(result.firstUserMessage.text.includes('第 1 个问题'), 'human text missing');
    assert(!result.firstUserMessage.text.includes('automatically generated checkpoint'), 'checkpoint text leaked into carry');

    const plan = planVisibleTruncation(parsed, { keepTurns: 5, keepTokens: 1_000_000 });
    assert(plan.firstUserMessage.seq === humanSeq, 'plan picked the checkpoint');
    assert(plan.carryFirstUserMessage === true, 'plan did not mark the human message as carried');

    // And the assembled buffer carries the human line, not the checkpoint.
    const applied = truncateVisibleSession(file, {
      dryRun: false, confirm: VISIBLE_CONFIRM_WORD, keepTurns: 5, keepTokens: 1_000_000, recentWriteWindowMs: 0,
    });
    const after = readParsed(file);
    const carry = after.events.slice(0, 8).find((event) => (event.data?.content?.[0]?.text ?? '').startsWith('[会话起点 · 已归档]'));
    assert(carry, 'no carried first-user message in the rewritten log');
    assert(carry.data.content[0].text.includes('第 1 个问题'), 'carry is not the human message');
    assert(!carry.data.content[0].text.includes('automatically generated checkpoint'), 'carry is the checkpoint');
    assert(applied.firstUserMessage.seq === humanSeq, 'report seq is not the human message');
    return `carried seq ${humanSeq}, not checkpoint seq ${checkpointSeq}`;
  });

  runCase('A3', '只有注入块：不回退，工具明说「未找到真人消息」', () => {
    const { file } = writeFixture(TMP, 'no-human', { humanSource: (t) => `Current runtime context snapshot ${t}` });
    const parsed = readParsed(file);
    assert(parsed.events.some((event) => event.type === 'user/message'), 'fixture has no user/message rows');

    // The load-bearing assertion: with only injected rows the plan must report
    // "no human", not quietly promote the first runtime-context block.
    const plan = planVisibleTruncation(parsed, { keepTurns: 5, keepTokens: 1_000_000 });
    assert(plan.firstUserMessage === null, 'plan fell back to an injected block');
    assert(plan.firstUserMessageNote.includes('未找到真人消息'), 'plan note does not say no human message');
    assert(parsed.events.filter((event) => event.type === 'user/message').every((event) => isUserAuthoredMessage(event) === false),
      'fixture accidentally contains a human message');

    const result = truncateVisibleSession(file, { dryRun: true, keepTurns: 5, keepTokens: 1_000_000 });
    assert(result.needed === false, 'no-human fixture should not be cut (no safe boundary)');
    assert(result.firstUserMessage === null, 'result fell back to an injected block');
    assert(result.message.includes('未找到真人消息'), `tool message does not say it: ${result.message.slice(0, 120)}`);
    assert(fs.existsSync(file), 'dry-run removed the file');
    return 'no human -> noop + explicit note';
  });

  runCase('A4', 'auto log：会话字节不变、日志恰一行、含切割范围与预计降幅', () => {
    const { id, file, memoryRoot } = writeFixture(TMP, 'mode-log');
    const beforeSha = fileSha(file);
    const truncator = createAutoTruncator({
      memoryRoot, autoTruncate: { enabled: true, mode: 'log', tokensThreshold: 500, minTurns: 3 }, now: clock(),
    });
    assert(truncator.config.mode === 'log', 'default override failed');

    const status = truncator.onTurnEnd({ sessionId: id, turn: 20, sessionPath: file });
    assert(status.status === 'logged', `unexpected status ${status.status}`);
    assert(status.action === 'planned', `unexpected action ${status.action}`);
    assert(fileSha(file) === beforeSha, 'log mode wrote the session file');
    assert(!fs.existsSync(archiveDirFor(file)), 'log mode created an archive dir');
    assert(!fs.existsSync(inflightPathFor(file)), 'log mode left an inflight record');

    const lines = readLogLines(memoryRoot);
    assert(lines.length === 1, `expected exactly one log line, got ${lines.length}`);
    const entry = JSON.parse(lines[0]);
    assert(entry.mode === 'log', 'log entry mode');
    assert(entry.sessionId === id, 'log entry session id');
    assert(entry.estimate.basis.includes('MESSAGE_TYPES'), 'log entry has no estimate basis');
    assert(entry.estimate.tokens >= 500, 'estimate did not exceed threshold');
    assert(entry.plan.cut.droppedTurns > 0, 'plan has no cut range');
    assert(entry.plan.projected.dropTokens > 0, 'plan has no projected drop');
    assert(entry.plan.projected.dropPercent > 0, 'plan has no drop percent');
    assert(entry.threshold.tokens === 500, 'threshold not recorded');
    return `one line, drop ${entry.plan.projected.dropPercent}%`;
  });

  runCase('A5', 'auto dryrun：仍不写会话，日志含完整计划（cut/before/after）', () => {
    const { id, file, memoryRoot } = writeFixture(TMP, 'mode-dryrun');
    const beforeSha = fileSha(file);
    const truncator = createAutoTruncator({
      memoryRoot, autoTruncate: { enabled: true, mode: 'dryrun', tokensThreshold: 500, minTurns: 3 }, now: clock(),
    });
    const status = truncator.onTurnEnd({ sessionId: id, turn: 20, sessionPath: file });
    assert(status.status === 'dryrun', `unexpected status ${status.status}`);
    assert(status.action === 'dryrun-planned', `unexpected action ${status.action}`);
    assert(fileSha(file) === beforeSha, 'dryrun mode wrote the session file');
    assert(!fs.existsSync(archiveDirFor(file)), 'dryrun created an archive dir');

    const lines = readLogLines(memoryRoot);
    assert(lines.length === 1, `expected one log line, got ${lines.length}`);
    const entry = JSON.parse(lines[0]);
    assert(entry.dryRun === true, 'entry not marked dryRun');
    assert(entry.wroteSessionFile === false, 'entry claims a write');
    assert(entry.plan.cut.droppedTurns > 0, 'dryrun plan has no cut');
    assert(entry.plan.after.tokens < entry.plan.dropped.tokens + entry.plan.kept.tokens,
      'dryrun plan has no after estimate');
    assert(entry.plan.after.sha256 && entry.plan.after.sha256 !== beforeSha, 'dryrun after sha missing/unchanged');
    return `planned cut turn ${entry.plan.cut.turn}, no write`;
  });

  runCase('A6', 'auto apply（旧配置）：按 request 处理，会话字节不变，日志记 modeAlias', () => {
    const { id, file, memoryRoot } = writeFixture(TMP, 'mode-apply');
    const beforeSha = fileSha(file);
    const truncator = createAutoTruncator({
      memoryRoot,
      autoTruncate: { enabled: true,
        mode: 'apply',
        tokensThreshold: 500,
        minTurns: 3,
        keepTurns: 5,
        keepTokens: 1_000_000,
        appExe: 'C:\\fake\\DeepSeek Harness.exe',
        profile: 'desktop',
      },
      now: () => Date.now(),
    });
    assert(truncator.config.mode === 'request', 'legacy apply was not rewritten to request');
    assert(truncator.config.modeAlias === 'apply->request', 'modeAlias missing from normalized config');

    const status = truncator.onTurnEnd({ sessionId: id, turn: 20, sessionPath: file });
    assert(status.status === 'request-written', `unexpected status ${status.status} (${status.code ?? ''})`);
    assert(status.action === 'request-written', `unexpected action ${status.action}`);
    assert(fileSha(file) === beforeSha, 'legacy apply wrote the session file');
    assert(!fs.existsSync(archiveDirFor(file)), 'legacy apply created an archive dir');
    assert(!fs.existsSync(inflightPathFor(file)), 'legacy apply left an inflight record');

    const lines = readLogLines(memoryRoot);
    assert(lines.length === 1, `expected one log line, got ${lines.length}`);
    const entry = JSON.parse(lines[0]);
    assert(entry.mode === 'request', `log mode is ${entry.mode}, expected request`);
    assert(entry.modeAlias === 'apply->request', 'log has no modeAlias');
    assert(entry.action === 'request-written', `log action is ${entry.action}`);
    assert(entry.wroteSessionFile === false, 'log claims a session write');
    for (const oldField of ['applied', 'before', 'after', 'delta', 'hostReloadRequired', 'backupPath', 'archivePath']) {
      assert(!(oldField in entry), `old apply field ${oldField} came back`);
    }

    const request = JSON.parse(fs.readFileSync(truncator.requestPath, 'utf8'));
    assert(request.sessionPath === path.resolve(file), 'request points at another session');
    assert(request.app.exe === 'C:\\fake\\DeepSeek Harness.exe', 'request app.exe not from config');
    return `alias logged, request ${request.requestId.slice(0, 8)}, session untouched`;
  });

  runCase('A7', '防抖：同一 turn 只评估一次；cooldown 内不重复；below-threshold 不写日志', () => {
    const { id, file, memoryRoot } = writeFixture(TMP, 'debounce');
    const now = clock(0);
    const truncator = createAutoTruncator({
      memoryRoot, autoTruncate: { enabled: true, mode: 'log', tokensThreshold: 500, minTurns: 3, cooldownMinutes: 60 }, now,
    });
    const first = truncator.onTurnEnd({ sessionId: id, turn: 20, sessionPath: file });
    assert(first.status === 'logged', 'first evaluation did not log');
    const duplicate = truncator.onTurnEnd({ sessionId: id, turn: 20, sessionPath: file });
    assert(duplicate.status === 'skipped' && duplicate.reason === 'duplicate-turn', 'duplicate turn re-evaluated');
    const cooldown = truncator.onTurnEnd({ sessionId: id, turn: 21, sessionPath: file });
    assert(cooldown.status === 'skipped' && cooldown.reason === 'cooldown', 'cooldown not applied');
    assert(readLogLines(memoryRoot).length === 1, 'debounce still produced log lines');

    const small = writeFixture(TMP, 'below-threshold');
    const tr2 = createAutoTruncator({
      memoryRoot: small.memoryRoot,
      autoTruncate: { enabled: true, mode: 'log', tokensThreshold: 10_000_000, minTurns: 3 },
      now: clock(),
    });
    const under = tr2.onTurnEnd({ sessionId: small.id, turn: 20, sessionPath: small.file });
    assert(under.status === 'skipped' && under.reason === 'below-threshold', `unexpected ${under.reason}`);
    assert(readLogLines(small.memoryRoot).length === 0, 'below-threshold wrote a log line');
    return 'duplicate + cooldown + below-threshold all quiet';
  });

  runCase('A8', '防抖：inflight 记录存在时跳过且不写日志；坏配置明确报错', () => {
    const { id, file, memoryRoot } = writeFixture(TMP, 'inflight');
    fs.mkdirSync(path.dirname(inflightPathFor(file)), { recursive: true });
    fs.writeFileSync(inflightPathFor(file), JSON.stringify({ version: 1, phase: 'prepared' }));
    const truncator = createAutoTruncator({
      memoryRoot, autoTruncate: { enabled: true, mode: 'log', tokensThreshold: 500, minTurns: 3 }, now: clock(),
    });
    const status = truncator.onTurnEnd({ sessionId: id, turn: 20, sessionPath: file });
    assert(status.status === 'skipped' && status.reason === 'inflight', `unexpected ${status.reason}`);
    assert(readLogLines(memoryRoot).length === 0, 'inflight skip wrote a log line');

    const alias = normalizeAutoTruncateConfig({ mode: 'apply' });
    assert(alias.mode === 'request' && alias.modeAlias === 'apply->request', 'apply was not aliased to request');
    assert(AUTO_TRUNCATE_MODES.join(',') === 'log,dryrun,request', 'mode list');
    assert(AUTO_TRUNCATE_LEGACY_MODES.join(',') === 'apply', 'legacy mode list');

    let badMode = null;
    try {
      normalizeAutoTruncateConfig({ mode: 'APPLY' });
    } catch (error) {
      badMode = error;
    }
    assert(badMode?.code === AUTO_TRUNCATE_ERRORS.BAD_MODE, 'bad mode was silently accepted');
    let badThreshold = null;
    try {
      normalizeAutoTruncateConfig({ tokensThreshold: 0 });
    } catch (error) {
      badThreshold = error;
    }
    assert(badThreshold?.code === AUTO_TRUNCATE_ERRORS.BAD_CONFIG, 'bad threshold was silently accepted');
    let badProfile = null;
    try {
      normalizeAutoTruncateConfig({ profile: '   ' });
    } catch (error) {
      badProfile = error;
    }
    assert(badProfile?.code === AUTO_TRUNCATE_ERRORS.BAD_CONFIG, 'empty profile was silently accepted');
    let badAppExe = null;
    try {
      normalizeAutoTruncateConfig({ appExe: 42 });
    } catch (error) {
      badAppExe = error;
    }
    assert(badAppExe?.code === AUTO_TRUNCATE_ERRORS.BAD_CONFIG, 'non-string appExe was silently accepted');

    const defaults = normalizeAutoTruncateConfig(undefined);
    assert(defaults.mode === 'dryrun' && defaults.enabled === false && defaults.tokensThreshold === 300000,
      '1.6.0 safety defaults changed');
    assert(defaults.keepTurns === AUTO_TRUNCATE_DEFAULTS.keepTurns, 'keepTurns default changed');
    assert(defaults.profile === 'desktop' && defaults.appExe === '', 'request defaults changed');
    return 'inflight quiet; apply aliased; bad config throws';
  });

  runCase('A9', '触发点：heartbeat 的 session/event turn/end 调用 onTurnEnd（未绑定也调用）', () => {
    const calls = [];
    let listener = null;
    const ctx = {
      on(name, fn) {
        if (name === 'session/event') listener = fn;
        return () => { listener = null; };
      },
    };
    const hb = createAutoHeartbeat({
      ctx,
      memoryRoot: path.join(base, 'hb-memory'),
      heartbeatMs: 0,
      now: () => NOW,
      onTurnEnd: (info) => calls.push(info),
    });
    hb.start();
    assert(typeof listener === 'function', 'heartbeat did not subscribe to session/event');
    listener({ id: 'session-never-bound' }, { type: 'turn/end', data: { turn: 7 } });
    assert(calls.length === 1, `turn/end did not call onTurnEnd (${calls.length})`);
    assert(calls[0].sessionId === 'session-never-bound' && calls[0].turn === 7, 'wrong info');
    listener({ id: 'session-never-bound' }, { type: 'turn/start', data: { turn: 8 } });
    assert(calls.length === 1, 'turn/start incorrectly triggered auto-truncate');
    hb.stop();
    return 'turn/end only, before the bound-set gate';
  });

  runCase('A10', '日志/状态隔离：不同 memoryRoot 互不影响，状态文件可解析', () => {
    const one = writeFixture(TMP, 'iso-one');
    const two = writeFixture(TMP, 'iso-two');
    const tr1 = createAutoTruncator({
      memoryRoot: one.memoryRoot, autoTruncate: { enabled: true, mode: 'log', tokensThreshold: 500, minTurns: 3 }, now: clock(),
    });
    const tr2 = createAutoTruncator({
      memoryRoot: two.memoryRoot, autoTruncate: { enabled: true, mode: 'log', tokensThreshold: 500, minTurns: 3 }, now: clock(),
    });
    tr1.onTurnEnd({ sessionId: one.id, turn: 20, sessionPath: one.file });
    tr2.onTurnEnd({ sessionId: two.id, turn: 20, sessionPath: two.file });
    assert(readLogLines(one.memoryRoot).length === 1, 'session one log');
    assert(readLogLines(two.memoryRoot).length === 1, 'session two log');
    const statePath = autoTruncatePaths(one.memoryRoot).statePath;
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert(state.sessions[one.id]?.status === 'over', 'state did not record the evaluation');
    assert(findSessionFile(one.home, one.id) === one.file, 'findSessionFile did not resolve the id');
    return 'isolated logs + resolvable id -> path';
  });

  runCase('A11', 'appendAutoTruncateLog 是追加（不是覆盖），并返回同一路径', () => {
    const memoryRoot = path.join(base, 'append-log', 'memory');
    const a = appendAutoTruncateLog(memoryRoot, { time: 't1', action: 'a' });
    const b = appendAutoTruncateLog(memoryRoot, { time: 't2', action: 'b' });
    assert(a.logPath === b.logPath, 'log path changed between appends');
    const lines = readLogLines(memoryRoot);
    assert(lines.length === 2, `expected 2 lines, got ${lines.length}`);
    assert(JSON.parse(lines[0]).action === 'a' && JSON.parse(lines[1]).action === 'b', 'order lost');
    return 'append-only, same path';
  });

  runCase('A12', 'auto request：请求文件 schema 完整、会话不变；已有请求时单飞不覆盖', () => {
    const { id, file, memoryRoot } = writeFixture(TMP, 'mode-request');
    const beforeSha = fileSha(file);
    const truncator = createAutoTruncator({
      memoryRoot,
      autoTruncate: { enabled: true,
        mode: 'request',
        tokensThreshold: 500,
        minTurns: 3,
        keepTurns: 5,
        keepTokens: 1_000_000,
        appExe: 'C:\\fake\\App.exe',
        profile: 'desktop',
      },
      now: () => Date.now(),
    });
    const status = truncator.onTurnEnd({ sessionId: id, turn: 20, sessionPath: file });
    assert(status.status === 'request-written', `unexpected status ${status.status} (${status.code ?? ''})`);
    assert(fileSha(file) === beforeSha, 'request mode wrote the session file');
    assert(!fs.existsSync(archiveDirFor(file)), 'request mode created an archive dir');
    assert(!fs.existsSync(inflightPathFor(file)), 'request mode left an inflight record');

    const requestPath = autoTruncatePaths(memoryRoot).requestPath;
    assert(requestPath === truncator.requestPath, 'requestPath is not under .longlive/logs');
    assert(fs.existsSync(requestPath), 'request file missing');
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
    const keys = Object.keys(request).sort();
    const expected = ['app', 'at', 'estimate', 'plan', 'pluginDir', 'reason', 'requestId', 'sessionId', 'sessionPath', 'version'];
    assert(keys.join(',') === expected.join(','), `schema keys: ${keys.join(',')}`);
    assert(request.version === 1, 'version is not 1');
    assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.requestId),
      `requestId is not a uuid: ${request.requestId}`);
    assert(Math.abs(Date.now() - Date.parse(request.at)) < 10_000, 'at is not real time');
    assert(request.sessionPath === path.resolve(file), 'sessionPath is not absolute');
    assert(request.sessionId === id, 'sessionId mismatch');
    assert(request.reason === 'tokens-over-threshold', 'reason mismatch');
    assert(request.estimate.threshold === 500 && request.estimate.tokens >= 500, 'estimate mismatch');
    assert(Number.isInteger(request.plan.cut) && request.plan.cut > 0, 'plan.cut');
    assert(Number.isInteger(request.plan.dropped) && request.plan.dropped > 0, 'plan.dropped');
    assert(Number.isInteger(request.plan.kept) && request.plan.kept > 0, 'plan.kept');
    assert(request.plan.keepTurns === 5 && request.plan.keepTokens === 1_000_000, 'plan keeps changed');
    assert(request.plan.projectedTokens < request.estimate.tokens, 'projectedTokens does not drop');
    assert(request.app.exe === 'C:\\fake\\App.exe' && request.app.profile === 'desktop', 'app metadata');
    assert(fs.statSync(request.pluginDir).isDirectory(), 'pluginDir is not a directory');
    assert(fs.readdirSync(path.dirname(requestPath)).every((name) => !name.includes('.tmp-')),
      'request tmp file left behind');

    const entry = JSON.parse(readLogLines(memoryRoot)[0]);
    assert(entry.action === 'request-written' && entry.requestId === request.requestId, 'log does not carry the request');
    assert(entry.request?.requestId === request.requestId, 'log does not embed the full request');
    assert(entry.plan?.projected?.dropEvents > 0, 'log plan projection missing');
    assert(entry.wroteSessionFile === false, 'log claims a session write');

    const bytesBefore = fs.readFileSync(requestPath);
    const second = createAutoTruncator({
      memoryRoot,
      autoTruncate: { enabled: true,
        mode: 'request',
        tokensThreshold: 500,
        minTurns: 3,
        cooldownMinutes: 0,
        keepTurns: 5,
        keepTokens: 1_000_000,
        appExe: 'C:\\fake\\App.exe',
        profile: 'desktop',
      },
      now: () => Date.now(),
    });
    const pending = second.onTurnEnd({ sessionId: id, turn: 19, sessionPath: file });
    assert(pending.status === 'request-pending' && pending.action === 'request-pending',
      `single-flight status ${pending.status}`);
    assert(pending.requestId === request.requestId, 'pending lost the existing requestId');
    assert(fs.readFileSync(requestPath).equals(bytesBefore), 'pending evaluation overwrote the request');
    assert(fileSha(file) === beforeSha, 'pending evaluation wrote the session');
    const lines = readLogLines(memoryRoot);
    assert(lines.length === 2, `expected two log lines, got ${lines.length}`);
    const pendingEntry = JSON.parse(lines[1]);
    assert(pendingEntry.action === 'request-pending' && pendingEntry.requestPending === true,
      'pending log entry missing the flag');
    assert(pendingEntry.wroteSessionFile === false, 'pending log claims a write');
    assert(pendingEntry.plan?.needed === true, 'pending entry lost the plan');
    return `schema ok, ${request.requestId.slice(0, 8)}, single-flight preserved`;
  });

  runCase('A16', 'request 前文件又长了几条：estimate/plan 按最新计数，plan 记录 snapshotEvents/snapshotAt', () => {
    // The VM run: the plugin read 295 events / 91 messages at turn/end, the app
    // appended seq 295-297 eight milliseconds later, and the request described a
    // file that no longer existed. The fake fs appends those three events on the
    // SECOND session read, i.e. exactly between the turn/end snapshot and the
    // moment the request is built.
    const { id, file, memoryRoot } = writeFixture(TMP, 'growing-file');
    const parsed = readParsed(file);
    const grown = parsed.events.map((event) => ({ ...event }));
    for (let i = 0; i < 3; i += 1) {
      grown.push({
        type: 'session/title',
        seq: grown.length,
        time: Date.now() + i,
        data: { title: `late-${i}`, messageSeqs: [], source: { kind: 'user' } },
      });
    }
    const grownBuf = encodeSession(parsed.header, grown.map((event, index) => ({ ...event, seq: index })));
    const staleEvents = parsed.events.length;
    const freshPlan = planVisibleTruncation(parseSession(grownBuf), { keepTurns: 5, keepTokens: 1_000_000 });

    let reads = 0;
    const fakeFs = Object.create(fs);
    fakeFs.readFileSync = (target, opts) => {
      if (path.resolve(String(target)) === path.resolve(file)) {
        reads += 1;
        if (reads >= 2) return grownBuf;
      }
      return fs.readFileSync(target, opts);
    };

    const truncator = createAutoTruncator({
      memoryRoot,
      autoTruncate: { enabled: true,
        mode: 'request',
        tokensThreshold: 500,
        minTurns: 3,
        cooldownMinutes: 0,
        keepTurns: 5,
        keepTokens: 1_000_000,
        appExe: 'C:\\fake\\App.exe',
        profile: 'desktop',
      },
      fs: fakeFs,
      now: () => Date.now(),
    });
    const status = truncator.onTurnEnd({ sessionId: id, turn: 20, sessionPath: file });
    assert(status.status === 'request-written', `unexpected status ${status.status} (${status.code ?? ''})`);
    assert(reads >= 2, `the request never re-read the session file (${reads} read(s))`);

    const request = JSON.parse(fs.readFileSync(autoTruncatePaths(memoryRoot).requestPath, 'utf8'));
    assert(request.estimate.events === grown.length,
      `estimate described ${request.estimate.events} events, the file had ${grown.length} (stale snapshot: ${staleEvents})`);
    assert(request.estimate.events !== staleEvents, 'estimate reused the stale turn/end count');
    assert(request.estimate.source === 'pre-request', `estimate.source ${request.estimate.source}`);
    assert(request.plan.snapshotEvents === grown.length,
      `plan.snapshotEvents ${request.plan.snapshotEvents}, expected ${grown.length}`);
    assert(request.plan.snapshotMessages === freshPlan.original.messages,
      `plan.snapshotMessages ${request.plan.snapshotMessages}, expected ${freshPlan.original.messages}`);
    assert(typeof request.plan.snapshotAt === 'string' && Number.isFinite(Date.parse(request.plan.snapshotAt)),
      `plan.snapshotAt is not a timestamp: ${request.plan.snapshotAt}`);
    assert(request.plan.kept === freshPlan.kept.events,
      `plan.kept ${request.plan.kept} does not match a plan over the grown file (${freshPlan.kept.events})`);
    assert(request.plan.dropped === freshPlan.dropped.events,
      `plan.dropped ${request.plan.dropped} does not match a plan over the grown file (${freshPlan.dropped.events})`);

    const entry = JSON.parse(readLogLines(memoryRoot)[0]);
    assert(entry.action === 'request-written', 'log entry missing');
    assert(entry.plan?.snapshot?.source === 'pre-request', 'log does not record which snapshot the plan used');
    assert(entry.plan?.snapshot?.events === grown.length, 'log snapshotEvents mismatch');
    return `${staleEvents} -> ${grown.length} events, plan rebuilt from the pre-request snapshot`;
  });

  runCase('A14', 'request 原子写：tmp 写到 12 字节 ENOSPC -> 无请求文件/无残留 tmp，下一次评估正常写', () => {
    const { id, file, memoryRoot } = writeFixture(TMP, 'request-enospc');
    const beforeSha = fileSha(file);
    const paths = autoTruncatePaths(memoryRoot);
    const config = {
      enabled: true,
      mode: 'request',
      tokensThreshold: 500,
      minTurns: 3,
      cooldownMinutes: 0,
      keepTurns: 5,
      keepTokens: 1_000_000,
      appExe: 'C:\\fake\\App.exe',
      profile: 'desktop',
    };

    // A disk-full writer leaves 12 bytes behind and throws. The tmp write is
    // inside writeRequestAtomic's try, so the partial file must be removed and
    // the final name must never appear.
    let injected = false;
    const fakeFs = Object.create(fs);
    fakeFs.writeFileSync = (target, data, opts) => {
      if (!injected && String(target).includes('.tmp-')) {
        fs.writeFileSync(target, String(data).slice(0, 12), opts);
        injected = true;
        const error = new Error('ENOSPC: no space left on device, write');
        error.code = 'ENOSPC';
        throw error;
      }
      return fs.writeFileSync(target, data, opts);
    };
    const failing = createAutoTruncator({ memoryRoot, autoTruncate: config, fs: fakeFs, now: () => Date.now() });
    const failed = failing.onTurnEnd({ sessionId: id, turn: 20, sessionPath: file });
    assert(injected, 'fake fs never reached the tmp write');
    assert(failed.status === 'request-failed' && failed.code === 'ENOSPC',
      `unexpected failure ${failed.status}/${failed.code}`);
    assert(!fs.existsSync(paths.requestPath), 'half-written request file is visible');
    const leftovers = fs.readdirSync(paths.logDir).filter((name) => name.includes('.tmp-'));
    assert(leftovers.length === 0, `tmp leftovers after ENOSPC: ${leftovers.join(', ')}`);
    assert(fileSha(file) === beforeSha, 'ENOSPC path wrote the session');

    // The next evaluation (real fs, same memory root) self-heals by publishing
    // a complete request instead of sticking at "corrupt" forever.
    const healthy = createAutoTruncator({ memoryRoot, autoTruncate: config, now: () => Date.now() });
    const healed = healthy.onTurnEnd({ sessionId: id, turn: 21, sessionPath: file });
    assert(healed.status === 'request-written', `second evaluation ${healed.status}/${healed.code ?? ''}`);
    const request = JSON.parse(fs.readFileSync(paths.requestPath, 'utf8'));
    assert(request.requestId && request.sessionId === id, 'healed request is incomplete');
    assert(fs.readdirSync(paths.logDir).every((name) => !name.includes('.tmp-')), 'second write left a tmp');
    return `ENOSPC -> no request, next turn wrote ${request.requestId.slice(0, 8)}`;
  });

  runCase('A15', '坏 request JSON：quarantine 保留证据并自愈重写；合法请求仍单飞', () => {
    const { id, file, memoryRoot } = writeFixture(TMP, 'request-corrupt');
    const paths = autoTruncatePaths(memoryRoot);
    fs.mkdirSync(paths.logDir, { recursive: true });
    const junk = '{"version":1,"requestId":"half';
    fs.writeFileSync(paths.requestPath, junk);

    const config = {
      enabled: true,
      mode: 'request',
      tokensThreshold: 500,
      minTurns: 3,
      cooldownMinutes: 0,
      keepTurns: 5,
      keepTokens: 1_000_000,
      appExe: 'C:\\fake\\App.exe',
      profile: 'desktop',
    };
    const truncator = createAutoTruncator({ memoryRoot, autoTruncate: config, now: () => Date.now() });
    const healed = truncator.onTurnEnd({ sessionId: id, turn: 20, sessionPath: file });
    assert(healed.status === 'request-written', `heal status ${healed.status}/${healed.code ?? ''}`);

    const quarantined = fs.readdirSync(paths.logDir)
      .filter((name) => /^auto-truncate\.request\.corrupt-.*\.json$/.test(name));
    assert(quarantined.length === 1, `quarantine files: ${quarantined.join(', ') || '(none)'}`);
    assert(fs.readFileSync(path.join(paths.logDir, quarantined[0]), 'utf8') === junk,
      'quarantine did not preserve the corrupt bytes verbatim');
    assert(fs.existsSync(paths.requestPath), 'self-healing did not write a fresh request');
    const healedRequest = JSON.parse(fs.readFileSync(paths.requestPath, 'utf8'));
    assert(healedRequest.requestId && healedRequest.sessionId === id, 'healed request is incomplete');

    const entry = JSON.parse(readLogLines(memoryRoot)[0]);
    assert(entry.action === 'request-written', `log action ${entry.action}`);
    assert(entry.pendingState === 'quarantined', `pendingState ${entry.pendingState}`);
    assert(entry.quarantinedFile === path.join(paths.logDir, quarantined[0]), 'log lost the quarantine path');

    // A valid request still wins single-flight: no second heal, no overwrite.
    const bytes = fs.readFileSync(paths.requestPath);
    const second = createAutoTruncator({ memoryRoot, autoTruncate: config, now: () => Date.now() });
    const pending = second.onTurnEnd({ sessionId: id, turn: 21, sessionPath: file });
    assert(pending.status === 'request-pending' && pending.entry.pendingState === 'valid',
      `pending after heal ${pending.status}/${pending.entry?.pendingState}`);
    assert(fs.readFileSync(paths.requestPath).equals(bytes), 'pending evaluation overwrote the healed request');
    return `quarantined ${quarantined[0]}, then ${entry.requestId.slice(0, 8)}`;
  });

  runCase('A13', 'truncate-cli：成功单行 JSON；坏文件/缺 confirm 退出 2 且不留半写', () => {
    const fixture = writeFixture(TMP, 'cli-cut');
    const beforeSha = fileSha(fixture.file);
    const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'truncate-cli.mjs');
    // rc.2: truncate-cli.mjs refuses a --session outside <DSH_HOME>/sessions.
    const run = (args) => spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, DSH_HOME: fixture.home },
    });

    const ok = run(['--session', fixture.file, '--keep-turns', '5', '--keep-tokens', '1000000',
      '--confirm', VISIBLE_CONFIRM_WORD]);
    assert(ok.status === 0, `cli exit ${ok.status}: ${ok.stdout.slice(0, 300)} ${ok.stderr}`);
    assert(ok.stdout.trim().split('\n').length === 1, `stdout is not one line: ${ok.stdout}`);
    const out = JSON.parse(ok.stdout.trim());
    assert(out.ok === true && out.needed === true && out.applied === true && out.status === 'truncated',
      `unexpected cli result ${out.status}`);
    assert(out.before.sha256 === beforeSha, 'cli before sha mismatch');
    assert(out.after.bytes === fs.statSync(fixture.file).size, 'cli after bytes mismatch');
    assert(out.bytes.before === out.before.bytes && out.bytes.after === out.after.bytes, 'bytes block mismatch');
    assert(out.archivePath && fs.existsSync(out.archivePath), 'cli archive missing');
    assert(out.backupPath && fs.existsSync(out.backupPath), 'cli backup missing');
    assert(out.verify.ok === true && out.verify.messages === out.after.messages, 'cli read-back verify missing');
    assert(fileSha(fixture.file) === out.after.sha256, 'cli result does not match the file');
    assert(!fs.existsSync(inflightPathFor(fixture.file)), 'cli left an inflight record');

    const again = run(['--session', fixture.file, '--keep-turns', '5', '--keep-tokens', '1000000',
      '--confirm', VISIBLE_CONFIRM_WORD]);
    assert(again.status === 0, `noop exit ${again.status}: ${again.stderr}`);
    const noop = JSON.parse(again.stdout.trim());
    assert(noop.ok === true && noop.needed === false && noop.applied === false, 'second run is not a noop');
    assert(noop.bytes.before === noop.bytes.after, 'noop changed the file');

    const badDir = path.join(fixture.home, 'sessions', 'scope-fixtures', 'cli-bad');
    fs.mkdirSync(badDir, { recursive: true });
    const bad = path.join(badDir, 'session.v4.jsonl.zstd');
    fs.writeFileSync(bad, 'not a zstd session\n');
    const badSha = fileSha(bad);
    const failed = run(['--session', bad, '--keep-turns', '5', '--keep-tokens', '1000',
      '--confirm', VISIBLE_CONFIRM_WORD]);
    assert(failed.status === 2, `bad file exit ${failed.status}: ${failed.stdout}`);
    assert(failed.stdout.trim().split('\n').length === 1, 'bad file stdout is not one line');
    const failJson = JSON.parse(failed.stdout.trim());
    assert(failJson.ok === false && typeof failJson.code === 'string' && failJson.message, 'bad file JSON');
    assert(fileSha(bad) === badSha, 'bad file changed');
    assert(!fs.existsSync(inflightPathFor(bad)), 'bad file left an inflight record');
    assert(fs.readdirSync(badDir).every((name) => !name.includes('.truncate-visible.tmp-')),
      'bad file left a tmp record');

    const fresh = writeFixture(TMP, 'cli-noconfirm');
    const freshSha = fileSha(fresh.file);
    const noConfirm = run(['--session', fresh.file, '--keep-turns', '5', '--keep-tokens', '1000000']);
    assert(noConfirm.status === 2, `missing confirm exit ${noConfirm.status}`);
    const nc = JSON.parse(noConfirm.stdout.trim());
    assert(nc.code === 'CONFIRM_REQUIRED', 'missing confirm code');
    assert(fileSha(fresh.file) === freshSha, 'missing confirm wrote the session');
    assert(!fs.existsSync(archiveDirFor(fresh.file)), 'missing confirm created an archive');
    return 'ok one-line JSON; bad input exit 2 with no tmp/inflight; confirm required';
  });

  // -------------------------------------------------------------------------
  // A17–A20: 0.8.0-rc.11 — infeasible plans are recorded, requests are only
  // written after the cut has been built, and an unexpected exception leaves a
  // log line instead of vanishing into {status:'error'}.
  // -------------------------------------------------------------------------

  function writeHeadHeavyFixture(name) {
    const fixture = writeFixture(TMP, name);
    const prompt = fixture.events.find((event) => event.type === 'system/message');
    prompt.data.message.content[0].text = 'H'.repeat(8_000); // ~2,000 tokens of head
    fs.writeFileSync(fixture.file, encodeSession(fixture.header, fixture.events));
    return fixture;
  }

  runCase('A17', 'auto dryrun 不可行：写 dryrun-infeasible 日志行，带 code/attempts，会话不变', () => {
    const { id, file, memoryRoot } = writeHeadHeavyFixture('dryrun-infeasible');
    const beforeSha = fileSha(file);
    const truncator = createAutoTruncator({
      memoryRoot,
      autoTruncate: { enabled: true, mode: 'dryrun', tokensThreshold: 500, minTurns: 3, keepTurns: 6, keepTokens: 100 },
      now: clock(),
    });
    const status = truncator.onTurnEnd({ sessionId: id, turn: 20, sessionPath: file });
    assert(status.status === 'dryrun-infeasible', `status ${status.status}`);
    assert(status.action === 'dryrun-infeasible', `action ${status.action}`);
    assert(status.code === 'VISIBLE_TOKEN_BUDGET', `code ${status.code}`);
    assert(fileSha(file) === beforeSha, 'infeasible dryrun wrote the session');

    const lines = readLogLines(memoryRoot);
    assert(lines.length === 1, `expected one log line, got ${lines.length}`);
    const entry = JSON.parse(lines[0]);
    assert(entry.action === 'dryrun-infeasible', `entry action ${entry.action}`);
    assert(entry.feasible === false, 'entry claims feasible');
    assert(entry.code === 'VISIBLE_TOKEN_BUDGET', `entry code ${entry.code}`);
    assert(typeof entry.reason === 'string' && entry.reason.length > 0, 'entry has no reason');
    assert(Array.isArray(entry.attempts) && entry.attempts.length >= 1, 'entry has no attempts');
    assert(entry.plan.needed === true && entry.plan.feasible === false, 'entry plan does not say infeasible');
    assert(entry.wroteSessionFile === false, 'entry claims a write');
    return `infeasible ${entry.code} after ${entry.attempts.length} attempt(s), logged`;
  });

  runCase('A18', 'auto request 不可行：不写请求文件，写 request-infeasible 日志行', () => {
    const { id, file, memoryRoot } = writeHeadHeavyFixture('request-infeasible');
    const beforeSha = fileSha(file);
    const truncator = createAutoTruncator({
      memoryRoot,
      autoTruncate: { enabled: true,
        mode: 'request', tokensThreshold: 500, minTurns: 3, keepTurns: 6, keepTokens: 100,
        appExe: 'C:\\fake\\DeepSeek Harness.exe', profile: 'desktop',
      },
      now: clock(),
    });
    const status = truncator.onTurnEnd({ sessionId: id, turn: 20, sessionPath: file });
    assert(status.status === 'request-infeasible', `status ${status.status} (${status.code ?? ''})`);
    assert(status.action === 'request-infeasible', `action ${status.action}`);
    assert(status.code === 'VISIBLE_TOKEN_BUDGET', `code ${status.code}`);
    assert(!fs.existsSync(truncator.requestPath), 'an impossible request was written');
    assert(fileSha(file) === beforeSha, 'request-infeasible wrote the session');

    const lines = readLogLines(memoryRoot);
    assert(lines.length === 1, `expected one log line, got ${lines.length}`);
    const entry = JSON.parse(lines[0]);
    assert(entry.action === 'request-infeasible' && entry.feasible === false, 'log line does not record infeasible');
    assert(entry.code === 'VISIBLE_TOKEN_BUDGET', `log code ${entry.code}`);
    assert(Array.isArray(entry.attempts) && entry.attempts.length >= 1, 'log has no attempts');
    return `no request file, logged ${entry.code}`;
  });

  runCase('A19', 'auto request 只在裁剪构建成功后写：projectedTokens 等于实际裁剪估算', () => {
    const { id, file, memoryRoot } = writeFixture(TMP, 'request-verified');
    const truncator = createAutoTruncator({
      memoryRoot,
      autoTruncate: { enabled: true,
        mode: 'request', tokensThreshold: 500, minTurns: 3, keepTurns: 5, keepTokens: 1_000_000,
        appExe: 'C:\\fake\\DeepSeek Harness.exe', profile: 'desktop',
      },
      now: clock(),
    });
    const status = truncator.onTurnEnd({ sessionId: id, turn: 20, sessionPath: file });
    assert(status.status === 'request-written', `status ${status.status} (${status.code ?? ''})`);
    const request = JSON.parse(fs.readFileSync(truncator.requestPath, 'utf8'));
    assert(request.plan.feasible === true, 'request plan is not feasible');
    assert(request.plan.firstUserCapChars === AUTO_TRUNCATE_DEFAULTS.firstUserCapChars,
      `request cap ${request.plan.firstUserCapChars}`);
    assert(request.plan.attempts >= 1, `request attempts ${request.plan.attempts}`);
    const preview = truncateVisibleSession(file, {
      dryRun: true, keepTurns: 5, keepTokens: 1_000_000,
    });
    assert(request.plan.projectedTokens === preview.after.tokens,
      `request projectedTokens ${request.plan.projectedTokens} != built ${preview.after.tokens}`);
    assert(request.plan.projectedTokens <= Math.ceil(1_000_000 * 1.05), 'request projects over budget');
    const entry = JSON.parse(readLogLines(memoryRoot).at(-1));
    assert(entry.plan.projected.afterTokensEstimate === request.plan.projectedTokens,
      'log entry and request disagree on the projection');
    return `request ${request.requestId.slice(0, 8)}, projected ${request.plan.projectedTokens}`;
  });

  runCase('A20', 'auto 意外异常：写 action:error 日志行，返回结构化错误而不抛', () => {
    const { id, file, memoryRoot } = writeFixture(TMP, 'evaluate-error');
    fs.writeFileSync(file, 'not a zstd session at all\n');
    const beforeSha = fileSha(file);
    const truncator = createAutoTruncator({
      memoryRoot, autoTruncate: { enabled: true, mode: 'dryrun', tokensThreshold: 500, minTurns: 3 }, now: clock(),
    });
    const status = truncator.onTurnEnd({ sessionId: id, turn: 20, sessionPath: file });
    assert(status.status === 'error', `status ${status.status}`);
    assert(status.reason === 'exception', `reason ${status.reason}`);
    assert(typeof status.code === 'string' && status.code.length > 0, 'error has no code');
    assert(typeof status.message === 'string' && status.message.length > 0, 'error has no message');
    assert(status.logPath && fs.existsSync(status.logPath), 'error was not logged');
    const lines = readLogLines(memoryRoot);
    assert(lines.length === 1, `expected one error line, got ${lines.length}`);
    const entry = JSON.parse(lines[0]);
    assert(entry.action === 'error', `entry action ${entry.action}`);
    assert(entry.code === status.code, 'entry code differs from return value');
    assert(typeof entry.message === 'string' && entry.message.length > 0, 'entry has no message');
    assert(entry.wroteSessionFile === false, 'error entry claims a write');
    assert(fileSha(file) === beforeSha, 'error path rewrote the corrupt file');
    return `logged ${status.code}`;
  });
}

export const AUTO_SUITE_CASES = [
  'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A12', 'A13', 'A16',
  'A17', 'A18', 'A19', 'A20',
];
