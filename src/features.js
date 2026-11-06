// 0.9.0-rc.1 feature wiring — every capability here is OFF by default.
//
// This module is deliberately side-effect free at import time. `registerFeatures`
// is called at the end of `apply()`; when every switch is off it registers no
// listener, performs no filesystem access and emits no log line, so a 0.9.0-rc.1
// install behaves exactly like 0.8.0 until an operator opts in.
//
// Wiring (see docs/FEATURES.md):
//   identityCard.enabled  -> agent/pre-step (open card, prepend:true)
//   autoRecall.enabled    -> agent/pre-step (recall, prepend:false) + session/event
//   presenceBus.enabled   -> session/event (drain this session's bus inbox)
//   autoMaintenance.enabled -> one unref'd timer to the next local midnight
//                              (consolidate report + forget dry-run pending list;
//                              no turn hook, so a failure cannot affect a turn)
//   routerRuntime         -> unchanged 0.8.0 off|shadow|on adapter (src/router/runtime.js)
//
// The router background modules under src/router/background/ are shipped code
// plus their own test suite; 0.9.0-rc.1 does not register a second router hook.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { collectOpenCard, resolveMemoryRoot } from './identity/handover.js';
import {
  claimCardMarker,
  finalizeCardMarker,
  pruneCardMarkers,
  readCardMarker,
  releaseCardMarker,
} from './identity/card-marker.js';
import { isInsideRoot, memoryError, PATH_CODES } from './memory/paths.js';
import {
  assertInjectionSource,
  injectionSource,
  insertionIndex,
  placeAfterFirstHuman,
  sameMessageOrder,
} from './identity/inject-position.js';
import { apply as applyAutoRecall } from './recall/index.js';
import { createBus, normalizeSessionId, shouldAckOnTurnEnd } from './bus/bus.mjs';
import { createMaintenanceScheduler } from './memory/maintenance.js';
import {
  claimFallbackInjection,
  markReceiptFallbackInjected,
  readSurgeryState,
  recordFallbackInjectionSkip,
  releaseFallbackInjectionClaim,
} from './surgery-recovery.js';

export const FEATURE_DEFAULTS = Object.freeze({
  autoRecall: Object.freeze({ enabled: false, topK: 3, budgetTokens: 2000, everyNTurns: 6 }),
  identityCard: Object.freeze({ enabled: false, path: '<memoryRoot>/STATE.md', maxChars: 800 }),
  presenceBus: Object.freeze({ enabled: false, pollMs: 3000 }),
  autoMaintenance: Object.freeze({
    enabled: false,
    consolidate: true,
    forget: true,
    runOnStart: true,
    startDelayMs: 500,
  }),
});

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function bool(value) {
  return value === true;
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Normalize the five feature blocks. Pure: no I/O, no logging. */
export function normalizeFeatureConfig(config = {}) {
  const value = config && typeof config === 'object' ? config : {};
  const auto = value.autoRecall && typeof value.autoRecall === 'object' ? value.autoRecall : {};
  const identity = value.identityCard && typeof value.identityCard === 'object' ? value.identityCard : {};
  const bus = value.presenceBus && typeof value.presenceBus === 'object' ? value.presenceBus : {};
  const maintenance = value.autoMaintenance && typeof value.autoMaintenance === 'object'
    ? value.autoMaintenance
    : {};

  return {
    autoRecall: {
      enabled: bool(auto.enabled),
      topK: clampInt(auto.topK, FEATURE_DEFAULTS.autoRecall.topK, 1, 10),
      budgetTokens: clampInt(auto.budgetTokens, FEATURE_DEFAULTS.autoRecall.budgetTokens, 200, 2000),
      everyNTurns: clampInt(auto.everyNTurns, FEATURE_DEFAULTS.autoRecall.everyNTurns, 1, 1000),
      // Test seam; production resolves @deepseek-ai/dsh-llm lazily.
      createUserMessage: typeof auto.createUserMessage === 'function' ? auto.createUserMessage : undefined,
    },
    identityCard: {
      enabled: bool(identity.enabled),
      path: text(identity.path) ?? FEATURE_DEFAULTS.identityCard.path,
      maxChars: clampInt(identity.maxChars, FEATURE_DEFAULTS.identityCard.maxChars, 120, 4000),
      createUserMessage: typeof identity.createUserMessage === 'function' ? identity.createUserMessage : undefined,
    },
    presenceBus: {
      enabled: bool(bus.enabled),
      pollMs: clampInt(bus.pollMs, FEATURE_DEFAULTS.presenceBus.pollMs, 0, 3600000),
      root: text(bus.root),
    },
    autoMaintenance: {
      enabled: bool(maintenance.enabled),
      consolidate: maintenance.consolidate !== false,
      forget: maintenance.forget !== false,
      runOnStart: maintenance.runOnStart !== false,
      startDelayMs: clampInt(
        maintenance.startDelayMs,
        FEATURE_DEFAULTS.autoMaintenance.startDelayMs,
        0,
        300000,
      ),
    },
  };
}

/** Resolve `<memoryRoot>/STATE.md` and prove it stays inside the memory root. */
export function resolveCardPath(rawPath, memoryRoot) {
  const raw = text(rawPath) ?? FEATURE_DEFAULTS.identityCard.path;
  if (raw.includes('<memoryRoot>') && !memoryRoot) return null;
  const root = memoryRoot ? path.resolve(memoryRoot) : null;
  const resolved = raw.includes('<memoryRoot>')
    ? path.resolve(raw.replaceAll('<memoryRoot>', root))
    : path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root ?? process.cwd(), raw);
  if (!root) return resolved;
  // 红队 M2：`../`、根外绝对路径、盘符跳转一律 E_PATH_OUTSIDE_ROOT。
  // 只做词法判定、不读盘：越界路径在读任何文件之前就被拒绝。
  if (!isInsideRoot(root, resolved)) {
    throw memoryError(
      PATH_CODES.PATH_OUTSIDE_ROOT,
      `identityCard.path 越界：${resolved} 不在记忆根 ${root} 内 (E_PATH_OUTSIDE_ROOT)`,
    );
  }
  return resolved;
}

function loggerOf(ctx) {
  try {
    const logger = typeof ctx?.logger === 'function' ? ctx.logger() : ctx?.logger;
    return logger && typeof logger.warn === 'function' ? logger : null;
  } catch {
    return null;
  }
}

async function resolveUserMessageFactory(explicit) {
  if (typeof explicit === 'function') return explicit;
  try {
    const mod = await import('@deepseek-ai/dsh-llm');
    return typeof mod?.createUserMessage === 'function' ? mod.createUserMessage : null;
  } catch {
    return null;
  }
}

function isSubagent(agent) {
  return agent?.session?.header?.origin === 'subagent' || agent?.origin === 'subagent';
}

function keyOf(agent) {
  return String(agent?.session?.id ?? agent?.id ?? 'unknown');
}

/**
 * Identity card only: pre-step, outer waterfall, splice before next().
 * Mirrors `src/identity/index.js` but deliberately does NOT register the
 * writeback hooks — `identityCard` is a card-injection switch, not permission
 * to write handover drafts.
 */
function registerIdentityCard(ctx, cfg, memoryRoot, warn) {
  const states = new Map();
  const stateFor = (key) => {
    let state = states.get(key);
    if (!state) {
      state = { card: null, opened: false, warned: false, markerWarned: false };
      states.set(key, state);
    }
    return state;
  };

  // 跨进程判定落在磁盘上。memoryRoot 的解析沿用开机卡自己的解析器：没有显式
  // memoryRoot 时用 `<DSH home>/longlive-memory`（或 DSH_IDENTITY_MEMORY_ROOT），绝不写进 cwd。
  let markerRoot = null;
  try {
    markerRoot = memoryRoot ? path.resolve(memoryRoot) : resolveMemoryRoot({});
  } catch {
    markerRoot = null;
  }
  // 启动时顺手清掉 30 天以上的旧标记。best-effort：目录不存在/只读都静默。
  if (markerRoot) pruneCardMarkers(markerRoot);

  let cardPath = null;
  let cardPathResolved = false;

  ctx.on('agent/pre-step', async (payload, next) => {
    if (Number(payload?.step) !== 1) return next();
    const agent = payload?.agent;
    if (!agent || isSubagent(agent)) return next();

    const sessionId = keyOf(agent);
    const state = stateFor(sessionId);
    if (state.opened) return next();

    // 先看持久化标记：已经开过就直接放行，连卡都不读。
    if (!markerRoot) {
      if (!state.markerWarned) {
        state.markerWarned = true;
        warn('[identity-card] 没有可用的记忆根，跳过注入（无法保证跨进程只注入一次）。');
      }
      return next();
    }
    const marker = readCardMarker({ memoryRoot: markerRoot, sessionId });
    if (marker.ok && marker.exists) return next();
    if (!marker.ok) {
      // 读/解析失败、sessionId 对不上：fail-closed 到「不重复注入」。
      if (!state.markerWarned) {
        state.markerWarned = true;
        warn(`[identity-card] 开机标记不可用（${marker.code ?? 'E_MARKER'}），跳过注入以免重复。`);
      }
      return next();
    }

    if (state.card === null) {
      try {
        // 延迟到首次注入才解析：越界路径只让本特性静默失效，不阻断插件加载。
        if (!cardPathResolved) {
          cardPath = resolveCardPath(cfg.path, memoryRoot);
          cardPathResolved = true;
        }
        const card = collectOpenCard({
          memoryRoot: memoryRoot ?? undefined,
          statePath: cardPath ?? undefined,
          maxChars: cfg.maxChars,
        });
        state.card = typeof card?.text === 'string' ? card.text : '';
      } catch (error) {
        state.card = '';
        if (!state.warned) {
          state.warned = true;
          warn(`[identity-card] 开机卡生成失败：${error?.code ?? error?.message ?? error}`);
        }
      }
    }
    if (state.card.trim() === '') return next();

    const createUserMessage = await resolveUserMessageFactory(cfg.createUserMessage);
    if (!createUserMessage) return next();

    let message;
    try {
      message = assertInjectionSource(createUserMessage({
        content: [{ type: 'text', text: state.card }],
        source: injectionSource(),
      }));
    } catch (error) {
      if (!state.warned) {
        state.warned = true;
        warn(`[identity-card] 注入消息被拒绝：${error?.code ?? error?.message ?? error}`);
      }
      return next();
    }

    // 注入前用 O_EXCL 抢占本会话的 marker：两个进程同时到 step 1 时只有赢家
    // 注入，输家（E_ALREADY_CLAIMED）直接放行。写入失败（只读盘、权限）也跳过：
    // 记不下来就无法保证下一次不重复，宁可这一次不开。
    const claim = claimCardMarker({ memoryRoot: markerRoot, sessionId });
    if (!claim.ok) {
      if (claim.code !== 'E_ALREADY_CLAIMED' && !state.markerWarned) {
        state.markerWarned = true;
        warn(`[identity-card] 开机标记写入失败（${claim.code ?? 'E_MARKER'}），跳过注入以免重复。`);
      }
      return next();
    }

    const claimed = Array.isArray(payload?.messages) ? payload.messages : null;
    if (claimed) claimed.splice(insertionIndex(claimed), 0, message);
    const withdraw = () => {
      if (!claimed) return;
      const index = claimed.indexOf(message);
      if (index !== -1) claimed.splice(index, 1);
    };

    let decision;
    try {
      decision = await next();
    } catch (error) {
      withdraw();
      releaseCardMarker(claim);
      throw error;
    }
    if (!decision || decision.kind === 'reject') {
      withdraw();
      releaseCardMarker(claim);
      return decision;
    }

    state.opened = true;
    // 注入已被宿主接受：原子落最终 marker。写失败不抛、只 warn 一次；磁盘上还留着
    // 抢占时写的占位 marker，后续进程照样跳过（本进程也由 state.opened 拦住）。
    const finalized = finalizeCardMarker(claim, { sessionId });
    if (!finalized.ok && !state.markerWarned) {
      state.markerWarned = true;
      warn(`[identity-card] 开机标记落盘失败（${finalized.code ?? 'E_MARKER'}）：本进程只注入一次，后续进程按已注入处理。`);
    }
    const messages = Array.isArray(decision.messages) ? decision.messages : [];
    const ordered = placeAfterFirstHuman(messages, message);
    if (sameMessageOrder(messages, ordered)) return decision;
    return { ...decision, messages: ordered };
  }, { prepend: true });
}

/**
 * Presence bus consumer. On a COMPLETED turn/end only, poll this session's
 * inbox at most once per `pollMs`, spool non-control messages to
 * `<busRoot>/spool/<sessionId>.jsonl`, then ack. A failed spool write leaves
 * the message pending (at-least-once); an ack failure leaves it for the next
 * poll. Failed/aborted turns never poll, so nothing is consumed for a turn the
 * model did not finish.
 */
function registerPresenceBus(ctx, cfg, memoryRoot, warn) {
  if (!cfg.root && !memoryRoot) {
    warn('[presence-bus] 没有 memoryRoot 且未配置 presenceBus.root — 总线消费不启用。');
    return;
  }
  const root = cfg.root ?? path.join(memoryRoot, '.longlive', 'bus');
  const sessions = new Map();

  const stateFor = (sessionId) => {
    let state = sessions.get(sessionId);
    if (!state) {
      state = { lastPoll: -Infinity, bus: null };
      sessions.set(sessionId, state);
    }
    return state;
  };

  ctx.on('session/event', (session, event) => {
    try {
      if (!shouldAckOnTurnEnd(event)) return;
      const sessionId = normalizeSessionId(session?.id, 'sessionId');
      const state = stateFor(sessionId);
      const now = Date.now();
      if (now - state.lastPoll < cfg.pollMs) return;
      state.lastPoll = now;

      state.bus ??= createBus({ root, sessionId, memoryRoot: memoryRoot ?? undefined });
      const pending = state.bus.poll({ since: 0, limit: 100 });
      const messages = pending.messages.filter((message) => message.kind !== 'control');
      if (messages.length === 0) return;

      const spoolDir = path.join(root, 'spool');
      fs.mkdirSync(spoolDir, { recursive: true });
      const spool = path.join(spoolDir, `${sessionId}.jsonl`);
      const receivedAt = new Date().toISOString();
      for (const message of messages) {
        fs.appendFileSync(spool, `${JSON.stringify({ receivedAt, sessionId, message })}\n`, 'utf8');
      }
      for (const message of messages) {
        try {
          state.bus.ack(message.id);
        } catch (error) {
          if (error?.code !== 'E_NOT_FOUND') {
            warn(`[presence-bus] ack 失败 ${message.id}: ${error?.code ?? error?.message ?? error}`);
          }
        }
      }
    } catch (error) {
      warn(`[presence-bus] 消费失败：${error?.code ?? error?.message ?? error}`);
    }
  });

  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => () => sessions.clear(), 'longlive.presence-bus');
    } catch {
      /* fake context without effect scope */
    }
  }
}

/**
 * Visible surgery receipt (必修二, fallback path).
 *
 * The launcher normally appends this text to the session itself before the
 * restart, so the next activation already shows it. When that write never
 * happened (crash / older state / failed run), this one-shot pre-step hook
 * injects the exact same text as a *visible* user message on the first step of
 * the first turn, then unregisters. The message uses `source.kind: 'user'`
 * because the host renders user-sourced messages as conversation text; a
 * `session-reference` source would land in the invisible context rail.
 *
 * With no receipt text this function is not called at all (index.js passes
 * null), so a clean start registers no hook and reads nothing.
 */
function registerSurgeryReceipt(ctx, receipt, warn, { memoryRoot = null } = {}) {
  const text = typeof receipt === 'string' ? receipt.trim() : '';
  if (!text) return false;

  let done = false;
  let dispose = null;

  // Stop offering the receipt in this process. Safe to call more than once.
  const stop = () => {
    done = true;
    if (typeof dispose === 'function') {
      try {
        dispose();
      } catch {
        /* already disposed */
      }
    }
  };

  const handler = async (payload, next) => {
    if (done || Number(payload?.step) !== 1) return next();
    if (isSubagent(payload?.agent)) return next();
    const decision = await next();
    if (done || !decision || decision.kind === 'reject' || !Array.isArray(decision.messages)) {
      return decision;
    }
    // R3-03: two hosts can reach step 1 of the same session at the same time.
    // Claim the injection across processes before touching anything; the loser
    // skips (`skipped-concurrent`, audited by the claim) instead of appending
    // the same receipt twice.
    let claimed = null;
    if (memoryRoot) {
      try {
        const claim = claimFallbackInjection({ memoryRoot });
        if (!claim.ok) {
          if (claim.code !== 'skipped-concurrent') {
            warn(`[surgery-receipt] 兜底占用失败：${claim.code}`);
          }
          return decision;
        }
        claimed = claim.claim;
      } catch (error) {
        warn(`[surgery-receipt] 兜底占用失败：${error?.code ?? error?.message ?? error}`);
        return decision;
      }
      // R4-01: both hosts can pass the startup check before either injects, so
      // holding the claim is not enough. Re-read the persistent state while the
      // claim is held: if the other host already marked (or a real receipt was
      // written), this host must skip instead of appending a second copy.
      let current = null;
      try {
        current = readSurgeryState(memoryRoot);
      } catch {
        current = null;
      }
      const receiptState = current?.exists && current?.state ? current.state.receipt : null;
      if (receiptState?.written === true || receiptState?.fallbackInjected === true) {
        stop();
        // Release before the early return: the loop below only runs for the
        // append path, and a retained lock would block the next host for 60s.
        try {
          releaseFallbackInjectionClaim({ memoryRoot, claim: claimed });
        } catch {
          /* the TTL expires the claim even if the release fails */
        }
        claimed = null;
        recordFallbackInjectionSkip({ memoryRoot, result: 'skipped-already' });
        return decision;
      }
    }
    try {
      // A plain frozen-shape user message: the host validates id/role/source/
      // content and renders `source.kind === 'user'` as visible chat text.
      const message = Object.freeze({
        id: `surgery-receipt-${randomUUID()}`,
        role: 'user',
        content: Object.freeze([Object.freeze({ type: 'text', text })]),
        source: Object.freeze({ kind: 'user' }),
      });
      // R2-02 / minor: mark the one-shot fallback only after the injection was
      // accepted. The marker is atomic and idempotent; a second start reads it
      // and skips the receipt instead of appending the same text again.
      if (memoryRoot) {
        try {
          const marked = markReceiptFallbackInjected({ memoryRoot });
          if (!marked.ok) {
            warn(`[surgery-receipt] 兜底标记未写入：${marked.code}`);
          } else if (marked.alreadyMarked === true || marked.written === true) {
            // R4-01: lost the gap between the re-read and the atomic mark.
            // Whatever happened, a receipt already exists — never append a
            // second one.
            stop();
            recordFallbackInjectionSkip({ memoryRoot, result: 'skipped-already' });
            return decision;
          }
        } catch (error) {
          warn(`[surgery-receipt] 兜底标记未写入：${error?.code ?? error?.message ?? error}`);
        }
      }
      stop();
      // Append at the end: the receipt is the newest thing the operator sees.
      return { ...decision, messages: [...decision.messages, message] };
    } catch (error) {
      warn(`[surgery-receipt] 注入失败：${error?.code ?? error?.message ?? error}`);
      return decision;
    } finally {
      if (claimed) {
        try {
          releaseFallbackInjectionClaim({ memoryRoot, claim: claimed });
        } catch {
          /* the TTL expires the claim even if the release fails */
        }
      }
    }
  };

  dispose = ctx.on('agent/pre-step', handler, { prepend: false });
  return true;
}

/**
 * Register the opt-in features. Returns `{ enabled: string[] }` for tests and
 * for a single startup log line; with every flag off it touches nothing.
 */
export function registerFeatures(ctx, config = {}, options = {}) {
  const cfg = normalizeFeatureConfig(config);
  const memoryRoot = options.memoryRoot ?? null;
  const logger = loggerOf(ctx);
  const warn = (message) => {
    if (logger) logger.warn(message);
  };
  const enabled = [];

  // Not an opt-in feature: this is the operator-facing receipt required after
  // every surgery. `index.js` passes text only when a state exists and its
  // receipt is missing, so a clean start stays side-effect free.
  if (registerSurgeryReceipt(ctx, options.surgeryReceipt, warn, { memoryRoot })) {
    enabled.push('surgeryReceipt');
  }

  if (cfg.identityCard.enabled) {
    registerIdentityCard(ctx, cfg.identityCard, memoryRoot, warn);
    enabled.push('identityCard');
  }

  if (cfg.autoRecall.enabled) {
    const recallConfig = {
      autoRecall: true,
      maxItems: cfg.autoRecall.topK,
      budget: cfg.autoRecall.budgetTokens,
      everyNTurns: cfg.autoRecall.everyNTurns,
      skipSubagents: true,
      log: false,
    };
    if (memoryRoot) recallConfig.memoryRoot = memoryRoot;
    if (cfg.autoRecall.createUserMessage) recallConfig.createUserMessage = cfg.autoRecall.createUserMessage;
    // A3/A4：embedding 是 autoRecall 的一个可选后端，不属于 normalizeFeatureConfig
    // 的三块开关（feature-flags 的既有 deepEqual 锁死了那个输出形状）。
    if (config.embedding && typeof config.embedding === 'object') recallConfig.embedding = config.embedding;
    applyAutoRecall(ctx, recallConfig);
    enabled.push('autoRecall');
  }

  if (cfg.presenceBus.enabled) {
    registerPresenceBus(ctx, cfg.presenceBus, memoryRoot, warn);
    enabled.push('presenceBus');
  }

  if (cfg.autoMaintenance.enabled) {
    if (!memoryRoot) {
      warn('[longlive] autoMaintenance 已开启但没有可解析的 memoryRoot — 已跳过');
    } else {
      try {
        const scheduler = createMaintenanceScheduler({
          memoryRoot,
          config: cfg.autoMaintenance,
          // Test seam only (CONFIG.md lists `now` as internal); never a
          // deployment-facing setting.
          now: config.now,
          timers: config.timers,
          logger: warn,
        });
        const started = scheduler.start();
        if (started?.started === false && started.reason === 'disabled') {
          warn('[longlive] autoMaintenance 已开启但 consolidate/forget 都为 false — 已跳过');
        } else {
          if (typeof ctx.effect === 'function') {
            try {
              ctx.effect(() => () => scheduler.stop(), 'longlive.auto-maintenance');
            } catch {
              /* a fake/simple ctx may not support effect; the timer still runs */
            }
          }
          enabled.push('autoMaintenance');
        }
      } catch (error) {
        warn(`[longlive] autoMaintenance 启动失败（${error?.code ?? error?.message ?? error}）— 已跳过`);
      }
    }
  }

  if (enabled.length > 0 && logger && typeof logger.info === 'function') {
    logger.info(`[longlive] opt-in features: ${enabled.join(', ')}`);
  }
  return { enabled, config: cfg };
}
