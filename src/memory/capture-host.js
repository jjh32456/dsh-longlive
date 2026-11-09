// src/memory/capture-host.js — 逐轮采集接线（turn/end → captureTurn）
//
// 背景（2026-11-09 真机实测）：`captureTurn` 实现完整，但 1.8.1 final **没有**
// 任何 turn/end 触发点调用它（只有 lifecycle 用 createCapture 做生命周期），
// 事件索引只靠脚本回填：本机 events.db 最后一笔停在 2026-11-08 17:57，之后
// 新对话全部没有入库。
//
// 复核复核后修订（2026-11-09）：
//   - 每会话单飞（single-flight）：同会话同一时刻最多一次 capture；事件到达只置
//     pending，不并发不炸内存。captureTurn 幂等且会补齐全部未入索引轮次。
//   - debounce 合并同一轮连续事件；全部 setTimeout(...).unref()，不阻塞宿主。
//   - `session/disposed` 也只排一次**异步**收尾，不同步等待（复核实测旧版同步
//     收尾阻塞 2.12s）。
//   - 空记忆根自举：`E_EVENTS_INDEX_NOT_BUILT` 时后台跑 `scripts/recall-index-build.mjs`
//     建索引（每进程一次），建好后下一轮采集自动成功。
//   - 失败不占节流窗口：旧版 lastAt 在排队时就更新，失败要空等 20s；现在只记
//     lastError，下一轮立即可重试。
//   - 注册独立于 memoryV2 开关（复核 P0-1）：memoryV2 是面板 API 的 kill switch，
//     不应控制采集。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCapture } from './capture.js';

export const CAPTURE_DEBOUNCE_MS = 500;
const PACKAGE_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// 进程退出兜底：只挂一个 exit 监听，把每个实例的"待采集会话"同步 flush 一次。
// 目的：宿主退出时最后 1 轮可能还在 debounce timer 里（复核 R3 残余风险），
// 这里补上；L0 原文本来就有，flush 只补索引，失败静默。
const EXIT_FLUSHERS = new Set();
let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  try {
    process.on('exit', () => {
      for (const flush of EXIT_FLUSHERS) {
        try {
          flush();
        } catch {
          /* never throw from exit */
        }
      }
    });
  } catch {
    /* a sandboxed runtime may forbid exit hooks; capture still works on turn/end */
  }
}

/**
 * @param {{on?: Function, effect?: Function}} ctx host context
 * @param {{memoryRoot?: string, sessionRoots?: string[], now?: Function, warn?: Function,
 *          debounceMs?: number, bootstrap?: boolean}} options
 */
export function registerTurnCapture(ctx, options = {}) {
  const memoryRoot = typeof options.memoryRoot === 'string' ? options.memoryRoot : '';
  if (memoryRoot === '' || typeof ctx?.on !== 'function') {
    return { ok: false, code: 'E_CAPTURE_NO_WIRING' };
  }
  const sessionRoots = Array.isArray(options.sessionRoots) ? options.sessionRoots : [];
  const warn = typeof options.warn === 'function' ? options.warn : null;
  const debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : CAPTURE_DEBOUNCE_MS;
  const bootstrapEnabled = options.bootstrap !== false;
  const now = options.now;
  const capture = createCapture({ memoryRoot, sessionRoots, now });

  /** sessionId -> 状态 */
  const states = new Map();
  const stateFor = (sessionId) => {
    let state = states.get(sessionId);
    if (!state) {
      state = {
        timer: null,
        running: false,
        pending: false,
        lastTurn: -1,
        lastSuccessAt: null,
        lastError: null,
        bootstrapped: false,
        bootstrapRunning: false,
        bootstrapAttemptAt: 0,
        bootstrapWarned: false,
        warned: false,
      };
      states.set(sessionId, state);
    }
    return state;
  };

  // 复核复验 P1/P2 修复（2026-11-09）：
  //  - 自举不再"提前置 bootstrapped=true 永不重试"：spawn 成功才记账，失败/退出/超时冷却后
  //    允许重试（失败重试由下一条 turn/end 驱动，不主动定时轰炸）。
  //  - 进程退出时对"仍有待采集会话"同步补一次，避免最后一轮索引随宿主退出丢失
  //    （只在进程 exit 时发生一次；L0 原文本来就有，这里只是补索引）。
  const BOOTSTRAP_RETRY_COOLDOWN_MS = 120000;
  const bootstrapIndex = (sessionId, state) => {
    if (!bootstrapEnabled || state.bootstrapped || state.bootstrapRunning) return;
    const nowMs = Date.now();
    if (nowMs - state.bootstrapAttemptAt < BOOTSTRAP_RETRY_COOLDOWN_MS) return;
    state.bootstrapAttemptAt = nowMs;
    state.bootstrapRunning = true;
    try {
      const script = path.join(PACKAGE_ROOT, 'scripts', 'recall-index-build.mjs');
      const args = [script, '--memory-root', memoryRoot, '--json'];
      if (sessionRoots.length > 0) args.push('--sessions-root', sessionRoots[0]);
      const env = { ...process.env };
      // 宿主可能是 Electron 可执行文件；让它以 node 模式运行脚本。
      if (process.versions?.electron && env.ELECTRON_RUN_AS_NODE === undefined) {
        env.ELECTRON_RUN_AS_NODE = '1';
      }
      const child = spawn(process.execPath, args, { env, stdio: 'ignore', windowsHide: true });
      if (typeof child.unref === 'function') child.unref();
      const settle = () => {
        state.bootstrapRunning = false;
        state.bootstrapAttemptAt = Date.now();
      };
      if (typeof child.once === 'function') {
        child.once('error', settle);
        child.once('exit', settle);
      }
      if (!state.bootstrapWarned) {
        state.bootstrapWarned = true;
        if (warn) warn(`[longlive] 事件索引不存在，已后台自举（${path.basename(script)}）— 建好后采集自动恢复`);
      }
    } catch (error) {
      state.bootstrapRunning = false;
      state.bootstrapped = false;
      if (warn) warn(`[longlive] 事件索引自举失败：${error?.message ?? error}`);
    }
  };

  const schedule = (sessionId, delay = debounceMs) => {
    const state = stateFor(sessionId);
    if (state.timer) return; // 已排过，合并到同一次
    const timer = setTimeout(() => {
      state.timer = null;
      runCapture(sessionId);
    }, Math.max(0, delay));
    if (typeof timer.unref === 'function') timer.unref();
    state.timer = timer;
  };

  const runCapture = (sessionId) => {
    const state = stateFor(sessionId);
    if (state.running) {
      state.pending = true;
      return;
    }
    state.running = true;
    try {
      capture.captureTurn({ sessionId, source: 'turn-end' });
      state.lastSuccessAt = Date.now();
      state.lastError = null;
      state.running = false;
      if (state.pending) {
        state.pending = false;
        schedule(sessionId, 0);
      }
    } catch (error) {
      state.running = false;
      const message = String(error?.message ?? error);
      state.lastError = message;
      if (message.includes('E_EVENTS_INDEX_NOT_BUILT')) {
        bootstrapIndex(sessionId, state);
      } else if (warn && !state.warned) {
        state.warned = true;
        warn(`[longlive] 逐轮采集失败（${sessionId}）：${message} — 下一轮会重试`);
      }
      if (state.pending) {
        state.pending = false;
        schedule(sessionId, debounceMs);
      }
    }
  };

  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'turn/end') return;
      const sessionId = typeof session?.id === 'string' ? session.id : '';
      if (sessionId === '') return;
      const state = stateFor(sessionId);
      const turn = Number(event?.data?.turn);
      if (Number.isFinite(turn)) state.lastTurn = Math.max(state.lastTurn, turn);
      schedule(sessionId);
    } catch (error) {
      if (warn) warn(`[longlive] 逐轮采集接线异常：${error?.message ?? error}`);
    }
  });

  ctx.on('session/disposed', (session) => {
    try {
      const sessionId = typeof session?.id === 'string' ? session.id : '';
      if (sessionId === '') return;
      // 异步收尾：不阻塞宿主关闭（旧版同步在复核实测里阻塞 2.12s）。
      schedule(sessionId, 0);
    } catch (error) {
      if (warn) warn(`[longlive] 会话收尾采集调度失败：${error?.message ?? error}`);
    }
  });

  // 退出兜底 flush：只处理"还有 timer/pending"的会话，同步补一次索引。
  const flushPending = () => {
    for (const [sessionId, state] of states) {
      if (!state || (!state.timer && !state.pending)) continue;
      if (state.timer) {
        try {
          clearTimeout(state.timer);
        } catch {
          /* ignore */
        }
        state.timer = null;
      }
      state.pending = false;
      try {
        capture.captureTurn({ sessionId, source: 'session-end' });
        state.lastSuccessAt = Date.now();
        state.lastError = null;
      } catch (error) {
        state.lastError = String(error?.message ?? error);
      }
    }
  };
  EXIT_FLUSHERS.add(flushPending);
  installExitHook();

  return { ok: true, capture, states, debounceMs, flushPending };
}
