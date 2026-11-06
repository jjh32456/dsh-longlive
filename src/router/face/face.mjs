// routerFace v1 · 后台面本体。
//
// 一个 tick = 读材料（≤maxContextTokens）→ 调一次模型（dryRun 时跳过）
// → 写一条 journal + 最多 maxSuggestions 条 outbox。不执行任何工具、
// 不注册任何 turn 监听、不改会话历史。失败只记 status，绝不影响 turn。
//
// 刹车（硬边界）：
//   - routerFace.enabled 默认 false，关闭时 start() 什么都不做；
//   - 每日 token 预算用完 → state=stopped / reason=daily-budget；
//   - 连续 3 次失败 → state=stopped / reason=consecutive-failures；
//   - dryRun 默认 true，只写 journal，不调 LLM、不写 outbox；
//   - tick 单飞锁 + tickKey 幂等，定时器抖动不会写重。

import fs from 'node:fs';
import {
  FACE_FIRST_TICK_MS,
  FACE_HARD_CONTEXT_FLOOR,
  FACE_MAX_CONSECUTIVE_FAILURES,
  FACE_MAX_JOURNAL_CHARS,
  FACE_MAX_OUTPUT_TOKENS,
  FACE_SESSION_HINT,
  FACE_TICK_TASK,
  normalizeFaceConfig,
} from './config.mjs';
import { facePaths } from './paths.mjs';
import { hasJournalTick, appendJournalOnce, readJournal } from './journal.mjs';
import { appendOutbox } from './outbox.mjs';
import { buildFaceContext, summarizeContext } from './context.mjs';
import { buildFacePrompt, callFaceModel, parseFaceOutput, FACE_SYSTEM_PROMPT } from './llm.mjs';
import { ensureDir, localDayKey, readJsonFile, writeJsonAtomic } from '../service/paths.mjs';

export const FACE_STATUS_VERSION = 1;
export const FACE_STATE_VERSION = 1;
const LOCK_STALE_MIN_MS = 5 * 60 * 1000;

function cleanText(value, maxChars) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join('')}…`;
}

function freshState() {
  return {
    v: FACE_STATE_VERSION,
    day: '',
    dayTokens: 0,
    ticks: 0,
    consecutiveFailures: 0,
    stopped: false,
    stopReason: null,
    stopAt: null,
    waitingProvider: false,
    lastTickKey: null,
    lastTickAt: null,
    lastResult: null,
    lastError: null,
  };
}

function mergeState(raw) {
  const state = freshState();
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(state)) {
      if (raw[key] !== undefined && typeof raw[key] === typeof state[key]) state[key] = raw[key];
    }
  }
  return state;
}

/**
 * 创建后台面。不启动任何定时器；调 start() 才调度。
 *
 * @param {object} options
 * @param {object} options.ctx 宿主 ctx（生产取 llm 用）
 * @param {string} options.memoryRoot
 * @param {object} [options.config] 已归一化配置；缺省用 options.rawConfig 归一化
 * @param {object} [options.rawConfig]
 * @param {object|Function} [options.client] 测试注入的假 LLM
 * @param {() => Date} [options.now]
 * @param {(message:string, error?:any) => void} [options.logger]
 */
export function createRouterFace(options = {}) {
  const memoryRoot = options.memoryRoot ?? options.config?.memoryRoot ?? null;
  const paths = facePaths(memoryRoot);
  if (!paths) throw new Error('E_FACE_NO_MEMORY_ROOT');
  const config = options.config ?? normalizeFaceConfig(options.rawConfig ?? {}, { memoryRoot });
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const client = options.client ?? null;
  const logger = typeof options.logger === 'function' ? options.logger : () => {};
  const ctx = options.ctx ?? null;

  const stateRead = readJsonFile(paths.stateFile);
  const state = mergeState(stateRead.ok ? stateRead.value : null);
  let running = false;
  let disposed = false;
  let tickTimer = null;
  let firstTickTimer = null;
  let statusState = 'idle';
  let statusReason = null;
  let statusSince = new Date(now()).toISOString();

  function writeState() {
    try {
      ensureDir(paths.dir);
      writeJsonAtomic(paths.stateFile, state);
    } catch (error) {
      logger('face state write failed', error);
    }
  }

  function statusSnapshot(extra = {}) {
    const at = now();
    return {
      v: FACE_STATUS_VERSION,
      name: 'router-face',
      enabled: config.enabled === true,
      dryRun: config.dryRun !== false,
      tickMs: config.tickMs,
      state: statusState,
      reason: statusReason,
      since: statusSince,
      lastTickAt: state.lastTickAt,
      lastTickKey: state.lastTickKey,
      nextTickAt: tickTimer ? new Date(at.getTime() + config.tickMs).toISOString() : null,
      today: {
        day: state.day || localDayKey(at),
        usedTokens: state.dayTokens,
        dailyTokenBudget: config.dailyTokenBudget,
        ticks: state.ticks,
      },
      consecutiveFailures: state.consecutiveFailures,
      lastError: state.lastError,
      lastResult: state.lastResult,
      files: {
        dir: paths.dir,
        journal: paths.journalFile,
        state: paths.stateFile,
        status: paths.statusFile,
        outbox: paths.outboxFile,
        identity: paths.identityFile,
      },
      ...(extra || {}),
    };
  }

  function writeStatus(extra = {}) {
    try {
      ensureDir(paths.dir);
      writeJsonAtomic(paths.statusFile, statusSnapshot(extra));
    } catch (error) {
      logger('face status write failed', error);
    }
  }

  function setStatus(next, reason) {
    if (next !== statusState || reason !== statusReason) {
      statusState = next;
      statusReason = reason ?? null;
      statusSince = new Date(now()).toISOString();
    }
  }

  function resetDay(at) {
    const day = localDayKey(at);
    if (state.day === day) return false;
    state.day = day;
    state.dayTokens = 0;
    state.ticks = 0;
    state.lastTickKey = null;
    if (state.stopped && state.stopReason === 'daily-budget') {
      state.stopped = false;
      state.stopReason = null;
      state.stopAt = null;
    }
    return true;
  }

  function stop(reason) {
    state.stopped = true;
    state.stopReason = reason;
    state.stopAt = new Date(now()).toISOString();
    setStatus('stopped', reason);
    clearTimers();
    writeState();
    writeStatus();
  }

  function clearTimers() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    if (firstTickTimer) {
      clearTimeout(firstTickTimer);
      firstTickTimer = null;
    }
  }

  function lockStaleMs() {
    return Math.max(LOCK_STALE_MIN_MS, config.tickMs * 2);
  }

  function acquireLock(at) {
    try {
      fs.mkdirSync(paths.dir, { recursive: true });
      const fd = fs.openSync(paths.lockFile, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: at.toISOString() }));
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') return false;
      try {
        const stat = fs.statSync(paths.lockFile);
        if (Date.now() - stat.mtimeMs > lockStaleMs()) {
          fs.unlinkSync(paths.lockFile);
          return acquireLock(at);
        }
      } catch {
        // 锁文件刚被别的进程删掉，当作拿不到，下次再试。
      }
      return false;
    }
  }

  function releaseLock() {
    try {
      fs.unlinkSync(paths.lockFile);
    } catch {
      // 不存在就算了。
    }
  }

  function failure(code, detail = null) {
    state.consecutiveFailures += 1;
    state.lastError = { code: String(code ?? 'E_FACE_TICK'), detail: detail ? cleanText(detail, 300) : null, at: new Date(now()).toISOString() };
    state.lastResult = 'error';
    if (state.consecutiveFailures >= FACE_MAX_CONSECUTIVE_FAILURES) {
      stop('consecutive-failures');
      return { ok: false, error: code, stopped: true, reason: 'consecutive-failures' };
    }
    writeState();
    setStatus(state.waitingProvider ? 'waiting-provider' : 'idle', state.waitingProvider ? 'waiting-provider' : 'tick-failed');
    writeStatus();
    return { ok: false, error: code, stopped: false };
  }

  function dryRunJournal(context, at) {
    const keys = context.sections.map((section) => section.key);
    const todo = context.sections.find((section) => section.key === 'todos');
    const journalRows = readJournal(paths.journalFile, { limit: 5 }).length;
    return cleanText(
      `[dry-run] ${at.toISOString().slice(11, 19)} 完成上下文组装：${summarizeContext(context)}；`
        + `段=${keys.join('/') || 'empty'}；journal 回看 ${journalRows} 条；待办段=${todo ? '有' : '无'}。`
        + '未调用 LLM，未写 outbox。',
      FACE_MAX_JOURNAL_CHARS,
    );
  }

  async function tick(reason = 'timer') {
    if (disposed) return { ok: false, skipped: 'disposed' };
    if (running) return { ok: false, skipped: 'busy' };
    running = true;
    let locked = false;
    try {
      const at = now();
      resetDay(at);
      if (state.stopped) {
        setStatus('stopped', state.stopReason);
        return { ok: false, skipped: 'stopped', reason: state.stopReason };
      }
      if (state.dayTokens >= config.dailyTokenBudget) {
        stop('daily-budget');
        return { ok: false, skipped: 'daily-budget' };
      }
      const tickKey = `face-${state.day}-${Math.floor(at.getTime() / config.tickMs)}`;
      if (hasJournalTick(paths.journalFile, tickKey)) {
        state.lastTickKey = tickKey;
        return { ok: true, skipped: 'duplicate-tick', tickKey };
      }
      locked = acquireLock(at);
      if (!locked) {
        setStatus('idle', 'locked');
        return { ok: false, skipped: 'locked' };
      }

      setStatus('running', reason);
      state.lastTickKey = tickKey;
      state.lastTickAt = at.toISOString();
      writeState();

      const context = buildFaceContext({
        memoryRoot,
        paths,
        maxContextTokens: Math.max(FACE_HARD_CONTEXT_FLOOR, config.maxContextTokens),
        now,
      });

      if (config.dryRun !== false) {
        const text = dryRunJournal(context, at);
        const appended = appendJournalOnce(paths.journalFile, {
          tickKey,
          at,
          day: state.day,
          text,
          kind: 'dry-run',
          dryRun: true,
        });
        if (!appended.ok) return failure(appended.error ?? 'E_JOURNAL_WRITE', appended.message);
        state.ticks += 1;
        state.consecutiveFailures = 0;
        state.waitingProvider = false;
        state.lastResult = 'dry-run';
        state.lastError = null;
        writeState();
        setStatus('idle', 'dry-run');
        writeStatus();
        return { ok: true, dryRun: true, tickKey, contextTokens: context.tokens };
      }

      const remaining = Math.max(0, config.dailyTokenBudget - state.dayTokens);
      if (remaining <= 0) {
        stop('daily-budget');
        return { ok: false, skipped: 'daily-budget' };
      }
      const prompt = buildFacePrompt(context.text, { at: at.toISOString() });
      const call = await callFaceModel({
        ctx,
        config,
        client,
        system: FACE_SYSTEM_PROMPT,
        prompt,
        maxTokens: Math.min(FACE_MAX_OUTPUT_TOKENS, Math.max(128, remaining)),
      });
      if (!call.ok) {
        if (call.error === 'E_NO_LLM') state.waitingProvider = true;
        return failure(call.error ?? 'E_FACE_MODEL', call.reason ?? null);
      }
      const parsed = parseFaceOutput(call.text, {
        maxJournalChars: FACE_MAX_JOURNAL_CHARS,
        maxSuggestions: config.maxSuggestions,
      });
      if (parsed.journal === '') return failure('E_FACE_EMPTY_JOURNAL', call.text ? 'model returned no journal' : null);

      const inputTokens = Number.isInteger(call.usage?.inputTokens) ? call.usage.inputTokens : 0;
      const outputTokens = Number.isInteger(call.usage?.outputTokens) ? call.usage.outputTokens : 0;
      const spent = inputTokens + outputTokens;

      const appended = appendJournalOnce(paths.journalFile, {
        tickKey,
        at,
        day: state.day,
        text: parsed.journal,
        kind: FACE_TICK_TASK,
        suggestions: parsed.suggestions,
        usage: call.usage ?? null,
        provider: call.provider ?? '',
        model: call.model ?? '',
      });
      if (!appended.ok) return failure(appended.error ?? 'E_JOURNAL_WRITE', appended.message);

      let outboxWritten = 0;
      for (const suggestion of parsed.suggestions) {
        const written = appendOutbox(paths.outboxFile, {
          at: at.toISOString(),
          sessionHint: FACE_SESSION_HINT,
          text: suggestion,
          kind: 'suggestion',
        });
        if (written.ok) outboxWritten += 1;
      }

      state.dayTokens += spent;
      state.ticks += 1;
      state.consecutiveFailures = 0;
      state.waitingProvider = false;
      state.lastResult = 'journal';
      state.lastError = null;
      state.lastUsage = { inputTokens, outputTokens, spent, estimated: call.usage?.estimated === true };
      writeState();

      if (state.dayTokens >= config.dailyTokenBudget) {
        stop('daily-budget');
        return {
          ok: true,
          tickKey,
          contextTokens: context.tokens,
          spent,
          suggestions: parsed.suggestions.length,
          outboxWritten,
          stopped: true,
          reason: 'daily-budget',
        };
      }
      setStatus('idle', 'ok');
      writeStatus();
      return {
        ok: true,
        tickKey,
        contextTokens: context.tokens,
        spent,
        suggestions: parsed.suggestions.length,
        outboxWritten,
      };
    } catch (error) {
      logger('face tick failed', error);
      return failure(error?.code ?? 'E_FACE_TICK', String(error?.message ?? error));
    } finally {
      if (locked) releaseLock();
      running = false;
    }
  }

  function start() {
    if (disposed) return { started: false, reason: 'disposed' };
    if (config.enabled !== true) return { started: false, reason: 'disabled' };
    if (tickTimer || firstTickTimer) return { started: true, already: true };
    setStatus(state.stopped ? 'stopped' : 'idle', state.stopReason ?? 'start');
    firstTickTimer = setTimeout(() => {
      firstTickTimer = null;
      void tick('first').catch(() => {});
    }, FACE_FIRST_TICK_MS);
    firstTickTimer.unref?.();
    tickTimer = setInterval(() => {
      void tick('timer').catch(() => {});
    }, config.tickMs);
    tickTimer.unref?.();
    writeStatus();
    return { started: true };
  }

  function stopTicking(reason = 'manual') {
    clearTimers();
    if (!disposed) {
      state.stopped = true;
      state.stopReason = reason;
      state.stopAt = new Date(now()).toISOString();
      setStatus('stopped', reason);
      writeState();
      writeStatus();
    }
    return { stopped: true, reason };
  }

  function dispose() {
    clearTimers();
    disposed = true;
    setStatus('stopped', 'disposed');
    writeStatus();
  }

  function getStatus() {
    return statusSnapshot();
  }

  return {
    tick,
    start,
    stop: stopTicking,
    dispose,
    getStatus,
    getState: () => ({ ...state }),
    paths,
    config,
  };
}
