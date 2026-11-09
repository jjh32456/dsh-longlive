// RouterService —— dsh-longlive 1.1.0 的插件内后台服务（DESIGN §2）。
//
// 生命周期：
//   apply() 里 createRouterService() 只保存 config（不碰 fs）；
//   start() 才抢实例锁、建 vault、校验审计/账本/锚、写 status，然后进入 running。
//
// 这是第 1 阶段：模型调用只走 ctx.llm.stream 的接口，测试用 MockLlm。没有可用
// provider 时明确进入 blocked(E_NO_PROVIDER)，并如实写 status/审计，不假装在跑。
//
// 能力边界（必须与 REPORT 一致）：
//   audit/ledger/anchor 都在同一个用户可写 vault 里。校验能发现崩溃残留、半行、
//   误删、回滚和代码 bug，但同一用户蓄意重写三者无法防御；这不是安全边界。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { AnchorLog, readAnchor, verifyAnchor } from '../background/anchor.mjs';
import { AuditLog, readAudit } from '../background/audit.mjs';
import { BudgetLedger } from '../background/budget-ledger.mjs';
import { TaskQueue } from '../background/queue.mjs';
import { buildMessages, consumeStream } from '../background/stream.mjs';
import { computeBackoff } from '../background/retry.mjs';
import { parseAction } from '../background/router.mjs';
import { assembleContext } from './context.mjs';
import { normalizeRouterConfig } from './config.mjs';
import { InstanceLock, LOCK_RENEW_MS, STANDBY_RETRY_MS } from './lock.mjs';
import { dayKey, reconcileRuns, scanDayUsage, verifyRunAnchors } from './reconcile.mjs';
import { loadContextSources } from './sources.mjs';
import { buildStatus, KNOWN_WARNING_CODES, writeStatus } from './status.mjs';
import { createBoardBuilder, listSessionMetadata } from './board.mjs';
import { createHintInjector } from './hint.mjs';
import { createLiveWriter, scanLiveRows, sessionIdOf, stateForTurnEnd } from './live.mjs';
import { liveSweep, liveHealth } from '../../live.js';
import { createProposalEngine } from './proposals.mjs';
import { createApplier } from './apply.mjs';
import { clampLeaseTtl, computeMaxHoldMs, createWriterLease } from './lease.mjs';
import { createQueueManager } from './queue.mjs';
import { createTickLock } from './ticklock.mjs';
import { createWakeChannel } from './wake.mjs';
import { createWal } from './wal.mjs';
import { isSubagentCaller, sessionIdOfCaller } from './caller.mjs';
import {
  MODEL_AUTO_PICKED_LIST_ORDER,
  REASONING_EFFORT_UNSUPPORTED,
  mapProviderFailure,
  resolveModelTarget,
} from './model-resolve.mjs';
import { routerPaths } from './paths.mjs';
import { estimateTokens } from './tokens.mjs';

// D-CR5: a subagent session may ask at most 3 questions per rolling hour. The
// main session keeps its own (unlimited by this limiter) design quota.
const SUBAGENT_ASKS_PER_HOUR = 3;
const ASK_RATE_WINDOW_MS = 60 * 60 * 1000;

const HARD_BLOCK_CODES = new Set([
  'E_LEDGER_TAMPERED',
  'E_ANCHOR_MISSING',
  'E_VAULT_LOST',
  'E_AUDIT_WRITE',
  'E_LEDGER_WRITE',
  'E_CONTEXT_OVER_BUDGET',
]);

const ALLOWED_ACTIONS = new Set(['note', 'report', 'noop']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRunId(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-`
    + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `run-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function errorMessage(error) {
  if (typeof error === 'string') return error;
  return error?.message ?? error?.code ?? String(error);
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

function clampLimit(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) return fallback;
  return Math.min(n, max);
}

/**
 * 只保存 config；不读文件、不建目录、不注册钩子。默认关闭时 apply 调用它也不会产生副作用。
 * @param {object} ctx
 * @param {object} config
 * @param {object} [deps] 测试注入：llm/queue/audit/anchor/ledger/now/runId/installTimers 等
 */
export function createRouterService(ctx, config, deps = {}) {
  // Test hooks are a build seam, never a configuration switch: a production
  // build must not accept routerTestHooks at all (index.js asserts this).
  const hooks = deps.testHooks
    ?? (process.env.LONGLIVE_ROUTER_TEST === '1' ? config?.routerTestHooks : undefined);
  const raw = config && typeof config === 'object' ? config : {};
  // D-WP5-3: reasoningEffort is intentionally NOT a config key in 1.1.0
  // (50-key ledger). Future hosts/lead may pass it through deps.
  const explicitReasoningEffort = typeof deps.reasoningEffort === 'string' && deps.reasoningEffort.trim() !== ''
    ? deps.reasoningEffort.trim()
    : (typeof raw.reasoningEffort === 'string' && raw.reasoningEffort.trim() !== ''
      ? raw.reasoningEffort.trim()
      : null);
  const normalized = normalizeRouterConfig(config);
  const nextDeps = { ...deps, explicitReasoningEffort };
  return new RouterService(ctx, normalized, hooks ? { ...nextDeps, testHooks: hooks } : nextDeps);
}

export class RouterService {
  constructor(ctx, config, deps = {}) {
    this.ctx = ctx ?? {};
    this.config = config && typeof config === 'object' ? config : normalizeRouterConfig({});
    this.deps = deps ?? {};
    this.runId = this.deps.runId ?? makeRunId(this.#now());
    this.startedAt = this.#iso();
    this.since = this.startedAt;

    this.panelState = 'stopped';
    this.substate = 'idle';
    this.reason = 'constructed';
    this.started = false;
    this.disposed = false;
    this.busy = false;
    this.inflight = null;
    this.stopPromise = null;
    this.stopRequested = false;

    this.llm = null;
    this.queue = null;
    this.ledger = null;
    this.audit = null;
    this.anchor = null;
    this.lock = null;
    this.vaultDir = null;
    this.runDir = null;
    this.outboxDir = null;
    this.stability = this.deps.stability ?? { enabled: true, waitMs: 50, retries: 3 };

    this.seen = new Set();
    this.dayUsage = null;
    this.lastTickAt = null;
    this.nextTickAt = null;
    this.heartbeatAt = this.startedAt;
    this.lastError = null;
    this.lastReport = null;
    this.reports = [];
    this.ticks = 0;
    this.processed = 0;
    this.denied = 0;
    this.lastIdleAt = 0;
    this.consecutiveErrors = 0;
    this.auditCount = 0;
    this.agentMode = this.config.allowAgent === true;
    this.warnings = [];
    this.warnedUnknown = new Set();
    this.providerInfo = {
      configured: typeof this.config.provider === 'string' && this.config.provider.trim() !== '',
      missing: !(typeof this.config.provider === 'string' && this.config.provider.trim() !== ''),
    };
    this.modelInfo = this.#initialModelInfo();
    // WP5 (D-WP5-1..6): effective provider/model are resolved at start/first
    // call, never guessed. providerExplicit survives normalizeRouterConfig so a
    // defaulted provider is not mistaken for an explicit one.
    this.effectiveProvider = this.config.provider;
    this.providerSource = this.config.providerExplicit === true ? 'explicit' : 'default';
    this.modelSource = this.modelInfo.auto ? null : 'explicit';
    this.reasoningEffort = null;
    this.explicitReasoningEffort = this.deps.explicitReasoningEffort ?? null;
    this.providerCandidates = null;
    this.providerWait = { attempts: 0, lastError: null, nextRetryAt: null };
    this.pendingAudits = [];
    this.providerListenerInstalled = false;
    this.providerRetryTimer = null;
    this.autoResolveTimer = null;
    this.boardInfo = null;
    this.proposalsInfo = null;
    this.proposalEngine = null;
    this.wakeInfo = null;
    this.leaseInfo = null;
    this.walInfo = null;

    // WP2 · L1/L2（DESIGN §2.1/§2.2）。构造只记录字段；路径/监听/文件写入
    // 全部推迟到 start() 之后，默认关闭时这里一个目录都不会建。
    this.paths = null;
    this.liveWriter = null;
    this.boardBuilder = null;
    this.injector = null;
    this.boardSnapshot = null;
    this.liveCreatedEventVia = null;
    this.liveTurnEndEventVia = null;
    this.liveInfo = {
      rows: 0,
      maxRows: Number.isInteger(this.config.liveRowsMax) ? this.config.liveRowsMax : 128,
      unknown: 0,
      corrupt: 0,
      saturated: false,
      createdEventVia: null,
      turnEndEventVia: null,
    };
    this.sharedInfo = {
      hintTokensLast: 0,
      injectedTurns: 0,
      injectedTokensToday: 0,
      skipped: 0,
      readyProposals: 0,
      lastInjectAt: null,
      lastInjectSha256: null,
      liveRows: 0,
      unknownSessions: 0,
    };
    // Test-only seam: only ever supplied by deps in tests (see createRouterService).
    this.testHooks = this.deps.testHooks ?? null;

    this.timers = new Set();
    this.listenerDisposers = [];
    this.tickTimer = null;
    this.heartbeatTimer = null;
    this.stopFileTimer = null;
    this.firstTickTimer = null;
    this.reflectTimer = null;
    this.standbyTimer = null;
    this.lastTurnReflectAt = 0;
    this.abortController = null;
  }

  #now() {
    const value = typeof this.deps.now === 'function' ? this.deps.now() : new Date();
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : new Date();
  }

  #iso() {
    return this.#now().toISOString();
  }

  #initialModelInfo() {
    const model = this.config.model;
    const auto = model === 'auto';
    return {
      auto,
      resolved: !auto && typeof model === 'string' && model.trim() !== '' ? model : null,
      resolvedAt: auto ? null : this.#iso(),
    };
  }

  #markProviderMissing(missing = true) {
    this.providerInfo = {
      configured: !missing && typeof this.config.provider === 'string' && this.config.provider.trim() !== '',
      missing,
    };
  }

  #addWarning(code) {
    const text = String(code ?? '').trim();
    if (!text) return;
    if (!this.warnings.includes(text)) this.warnings.push(text);
  }

  /**
   * F-05: when routerAllowMissingAnchor lets the run start, the relaxation must
   * be visible — a warning plus an `anchor.*` audit row, never a silent pass.
   */
  #auditAllowedMissingAnchors(anchors) {
    const results = Array.isArray(anchors?.results) ? anchors.results : [];
    const allowed = results.filter((item) => item && item.ok === true && item.anchored === false);
    if (allowed.length === 0) return;
    this.#addWarning('ANCHOR_MISSING_ALLOWED');
    try {
      this.#auditSafe('anchor.missing.allowed', {
        count: allowed.length,
        run_ids: allowed.map((item) => item.runId).filter(Boolean).slice(0, 20),
        reason: 'routerAllowMissingAnchor',
      });
    } catch { /* auditing is best-effort here; the warning still stands */ }
  }

  #auditUnknownWarnings(warnings) {
    if (!this.audit) return;
    for (const code of Array.isArray(warnings) ? warnings : []) {
      if (KNOWN_WARNING_CODES.includes(code)) continue;
      if (this.warnedUnknown.has(code)) continue;
      this.warnedUnknown.add(code);
      try {
        this.#audit('warn.unknown', { code: String(code).slice(0, 64) });
      } catch { /* 审计失败由调用方 fail-closed，不在这里递归 */ }
    }
  }

  #log(level, message, extra) {
    try {
      const logger = this.deps.logger ?? (typeof this.ctx.logger === 'function' ? this.ctx.logger() : null);
      const fn = logger?.[level];
      if (typeof fn === 'function') fn.call(logger, `[longlive.router] ${message}`, extra);
    } catch {
      /* 日志失败不影响服务 */
    }
  }

  #timer(fn, ms) {
    const handle = setTimeout(() => {
      this.timers.delete(handle);
      if (this.disposed) return;
      try { fn(); } catch (error) { this.#failSafe(error); }
    }, Math.max(0, ms));
    if (typeof handle.unref === 'function') handle.unref();
    this.timers.add(handle);
    return handle;
  }

  #interval(fn, ms) {
    const handle = setInterval(() => {
      if (this.disposed) return;
      try { fn(); } catch (error) { this.#failSafe(error); }
    }, Math.max(1, ms));
    if (typeof handle.unref === 'function') handle.unref();
    this.timers.add(handle);
    return handle;
  }

  #clearTimer(handle) {
    if (handle === null || handle === undefined) return;
    clearTimeout(handle);
    this.timers.delete(handle);
  }

  #clearTimers() {
    for (const handle of this.timers) {
      try { clearTimeout(handle); } catch { /* ignore */ }
    }
    this.timers.clear();
    this.tickTimer = null;
    this.heartbeatTimer = null;
    this.stopFileTimer = null;
    this.firstTickTimer = null;
    this.reflectTimer = null;
    this.standbyTimer = null;
    this.providerRetryTimer = null;
    this.autoResolveTimer = null;
  }

  #result(extra = {}) {
    let budget = null;
    try { budget = this.ledger?.snapshot() ?? null; } catch { budget = null; }
    return {
      ok: this.panelState === 'running' || this.panelState === 'standby',
      state: this.panelState,
      substate: this.substate,
      reason: this.reason,
      runId: this.runId,
      provider: this.config.provider,
      model: this.config.model,
      busy: this.busy,
      ticks: this.ticks,
      processed: this.processed,
      denied: this.denied,
      lastError: this.lastError,
      lastReport: this.lastReport,
      today: this.dayUsage,
      budget: budget ? {
        used: budget.used,
        reserved: budget.reserved,
        maxTokens: budget.maxTokens,
        remaining: budget.remaining,
      } : null,
      ...extra,
    };
  }

  #setState(next, reason) {
    const from = this.panelState;
    this.panelState = next;
    this.reason = reason ?? next;
    this.since = this.#iso();
    if (from !== next && next !== 'standby' && this.audit) {
      try { this.#audit('state.change', { from, to: next, reason: this.reason }); } catch { /* 由调用方 fail-closed */ }
    }
  }

  #emit(kind, data = {}) {
    if (!this.audit) {
      const error = new Error('audit is not open');
      error.code = 'E_AUDIT_WRITE';
      throw error;
    }
    try {
      const record = this.audit.append(kind, { run_id: this.runId, ...data });
      this.auditCount += 1;
      if (this.auditCount % 100 === 0) this.#sealAnchor();
      return record;
    } catch (cause) {
      const error = new Error(`audit append failed: ${errorMessage(cause)}`);
      error.code = 'E_AUDIT_WRITE';
      error.cause = cause;
      throw error;
    }
  }

  #audit(kind, data = {}) {
    return this.#emit(kind, data);
  }

  /** A skipped concurrent tick is evidence, not silence (H-01). */
  #auditTickBusy(source, info = {}) {
    try {
      this.#audit('tick.busy', {
        source,
        tier: info.tier === 'reflect' ? 'reflect' : 'full',
        reason: info.reason ?? null,
        code: info.code ?? 'E_BUSY',
        lock_reason: info.lockReason ?? null,
        state: this.panelState,
      });
    } catch { /* never turn a skip into a crash */ }
  }

  #sealAnchor() {
    if (!this.audit || !this.ledger || !this.anchor) return { ok: false, reason: 'not_ready' };
    try {
      const snap = this.ledger.snapshot();
      // `AuditLog.seq` 是「下一条」要写的序号（append 里 seq++），锚必须指向
      // 已经落盘的最后一条，否则重启时 recordAt(seq) 为空 → audit_prefix_mismatch
      // → E_LEDGER_TAMPERED（P0 回归，F-03 之外的锚 off-by-one）。
      const auditSeq = Number.isInteger(this.audit.seq) ? Math.max(0, this.audit.seq - 1) : 0;
      const result = this.anchor.seal({
        ledger: {
          seq: snap.seq,
          lastHash: snap.lastHash,
          used: snap.used,
          reserved: snap.reserved,
        },
        audit: {
          file: this.audit.file ? path.basename(this.audit.file) : null,
          seq: auditSeq,
          lastHash: this.audit.lastHash ?? null,
          settledUsed: snap.used,
          records: auditSeq,
        },
      });
      return result;
    } catch (error) {
      // DESIGN §7.3：锚写失败只告警，不阻塞 tick。
      this.#log('warn', `anchor seal failed: ${errorMessage(error)}`);
      return { ok: false, reason: error?.code ?? 'E_ANCHOR_WRITE' };
    }
  }

  /**
   * E-06 / G-02 / G-03：回收本 run + 所有历史 run 的崩溃遗留预留。
   * 账本是按 run 分目录的，重启后新 service 只持有新 run 的账本；不扫旧 run
   * 就永远释放不了子进程 reserve 后被 SIGKILL 留下的额度。
   * @returns {Array<{run_id:string,scope:string,released:number,freed_tokens:number,items:Array}>}
   */
  #reclaimRunLedgers() {
    const results = [];
    const current = this.ledger.reclaimDead();
    results.push({
      run_id: this.runId,
      scope: 'current',
      released: current.released,
      freed_tokens: current.freedTokens,
      items: current.items,
    });
    const runsDir = path.join(this.vaultDir, 'runs');
    let entries = [];
    try { entries = fs.readdirSync(runsDir, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === this.runId || entry.name.startsWith('.')) continue;
      const file = path.join(runsDir, entry.name, 'budget.ledger.jsonl');
      if (!fs.existsSync(file)) continue;
      try {
        const ledger = new BudgetLedger({ file, runId: entry.name, now: () => this.#iso() });
        const result = ledger.reclaimDead();
        if (result.released > 0) {
          results.push({
            run_id: entry.name,
            scope: 'previous_run',
            released: result.released,
            freed_tokens: result.freedTokens,
            items: result.items,
          });
        }
      } catch (error) {
        this.#log('warn', `reclaim of previous run ${entry.name} failed: ${errorMessage(error)}`);
      }
    }
    return results;
  }

  /** 把 #reclaimRunLedgers 的结果写成一条 budget.reclaim 审计（无回收时不写）。 */
  #auditBudgetReclaim(origin, results) {
    const rows = Array.isArray(results) ? results.filter((row) => row.released > 0) : [];
    if (rows.length === 0) return;
    try {
      this.#audit('budget.reclaim', {
        origin,
        released: rows.reduce((sum, row) => sum + row.released, 0),
        freed_tokens: rows.reduce((sum, row) => sum + row.freed_tokens, 0),
        charged: 0,
        runs: rows,
        items: rows.flatMap((row) => row.items ?? []).slice(0, 10),
      });
    } catch (error) {
      // 回收已经落账；审计失败不能反过来把预算锁死。
      this.#log('warn', `budget.reclaim audit failed: ${errorMessage(error)}`);
    }
  }

  #statusSnapshot() {
    const now = this.#iso();
    let tickQueue = { pending: 0, invalid: 0, oldestAgeMs: 0 };
    try {
      if (this.queue) {
        const view = this.queue.pending(this.seen);
        tickQueue = {
          pending: view.tasks.length,
          invalid: view.invalid.length,
          oldestAgeMs: this.#oldestAge(view.tasks),
        };
      }
    } catch { /* status 是只读快照，失败不影响服务 */ }
    let run = { usedTokens: 0, capTokens: this.config.maxTokensPerRun };
    try {
      const snap = this.ledger?.snapshot();
      if (snap) {
        run = {
          usedTokens: snap.used,
          capTokens: Number.isFinite(snap.maxTokens) ? snap.maxTokens : this.config.maxTokensPerRun,
        };
      }
    } catch { /* ignore */ }
    const day = this.dayUsage ?? {
      day: dayKey(this.#now()),
      usedTokens: 0,
      reservedTokens: 0,
      capTokens: this.config.maxTokensPerDay,
    };
    // WP3 提供提案投影；WP4 提供队列/租约/WAL 的实测快照，二者只读。
    let l3 = null;
    try { l3 = this.applier ? this.applier.status() : null; } catch { /* status 只读，失败降级 */ }
    const proposalsBase = this.proposalEngine
      ? this.proposalEngine.status()
      : (this.proposalsInfo ?? {});
    const proposals = l3
      ? {
        ...proposalsBase,
        doneToday: l3.proposals.doneToday,
        conflicts: l3.proposals.conflicts,
        superseded: l3.proposals.superseded,
        counts: l3.proposals.counts,
      }
      : proposalsBase;
    const proposalCounts = proposals.counts ?? {};
    const queue = {
      pending: proposalCounts.pending ?? 0,
      queued: proposalCounts.queued ?? 0,
      applying: proposalCounts.applying ?? 0,
      blockedOnUser: proposalCounts.blockedOnUser ?? 0,
      expired: proposalCounts.expired ?? 0,
    };
    const board = this.boardSnapshot?.board ?? this.boardInfo ?? {};
    const lease = l3?.lease ?? this.leaseInfo ?? {};
    const wal = l3?.wal ?? this.walInfo ?? {};
    let wakeStatus = this.wakeInfo ?? {};
    try { wakeStatus = this.wakeChannel?.status?.() ?? wakeStatus; } catch { /* 只读降级 */ }
    const wake = {
      enabled: this.config.wakeEnabled === true,
      ...wakeStatus,
    };
    return buildStatus({
      now,
      state: this.panelState,
      reason: this.reason,
      since: this.since,
      runId: this.runId,
      provider: this.providerInfo,
      model: this.modelInfo,
      autonomy: this.config.autonomy,
      agentMode: this.agentMode,
      lastTickAt: this.lastTickAt,
      nextTickAt: this.nextTickAt,
      heartbeatAt: now,
      today: {
        day: day.day,
        usedTokens: day.usedTokens,
        reservedTokens: day.reservedTokens,
        capTokens: this.config.maxTokensPerDay,
      },
      run,
      tickQueue,
      queueStatus: queue,
      liveMaxRows: this.config.liveRowsMax,
      live: {
        ...this.liveInfo,
        createdEventVia: this.liveCreatedEventVia,
        turnEndEventVia: this.liveTurnEndEventVia,
      },
      board: {
        ...board,
        pulse: {
          ...(board.pulse ?? {}),
          active: board.activeSessions ?? 0,
          // R4.2: same projection as board.json — never a second, hardcoded
          // number. Before this, status.json said 0 while board.json said 34.
          running: board.pulse?.running ?? 0,
          // R4.7: blocked is the same pulse field as the board's — never the
          // Router's own panelState wearing the same name with another value.
          // Router state is already reported as status.state.
          blocked: board.pulse?.blocked ?? 0,
          unknownSessions: board.unknownSessions ?? 0,
          queuedProposals: proposals.queue?.depth ?? 0,
          approvedProposals: proposalCounts.queued ?? 0,
          blockedOnUser: queue.blockedOnUser,
          readyProposals: Number(wakeStatus.readyCount ?? 0),
          lastApplyAt: board.lastApplyAt ?? null,
          lease: lease.active === true
            ? { holder: lease.holder ?? null, since: lease.since ?? null, expiresAt: lease.expiresAt ?? null }
            : null,
        },
      },
      proposals,
      lease,
      wal,
      shared: {
        hintTokensLast: 0,
        injectedTurns: 0,
        injectedTokensToday: 0,
        skipped: 0,
        readyProposals: 0,
        lastInjectAt: null,
        lastInjectSha256: null,
        liveRows: 0,
        unknownSessions: 0,
        ...(this.sharedInfo ?? {}),
      },
      wake,
      warnings: this.warnings.slice(),
      alerts: this.alerts ?? [],
      lastError: this.lastError,
      lastReport: this.lastReport,
      files: {
        vault: this.vaultDir ?? '',
        board: this.paths?.boardFile ?? (this.vaultDir ? path.join(this.vaultDir, 'board.json') : ''),
        audit: this.audit?.file ?? '',
        ledger: this.ledger?.file ?? '',
        anchor: this.anchor?.file ?? '',
        outbox: this.outboxDir ?? '',
      },
    });
  }

  #writeStatus() {
    if (!this.vaultDir) return { ok: false, error: 'E_NO_VAULT' };
    try {
      const snapshot = this.#statusSnapshot();
      this.#auditUnknownWarnings(snapshot.warnings);
      const file = path.join(this.vaultDir, 'status.json');
      const result = writeStatus(file, snapshot);
      if (!result.ok) this.#log('warn', `status write failed: ${result.error}`);
      return result;
    } catch (error) {
      this.#log('warn', `status write failed: ${errorMessage(error)}`);
      return { ok: false, error: error?.code ?? 'E_STATUS_WRITE' };
    }
  }

  #oldestAge(tasks) {
    let oldest = null;
    for (const task of Array.isArray(tasks) ? tasks : []) {
      const raw = task?.createdAt ?? task?.created_at;
      const ts = typeof raw === 'string' ? Date.parse(raw) : (Number.isFinite(raw) ? raw : NaN);
      if (!Number.isFinite(ts)) continue;
      if (oldest === null || ts < oldest) oldest = ts;
    }
    return oldest === null ? 0 : Math.max(0, this.#now().getTime() - oldest);
  }

  #queueRows(tasks) {
    return (Array.isArray(tasks) ? tasks : []).map((task) => {
      const raw = task?.createdAt ?? task?.created_at;
      const ts = typeof raw === 'string' ? Date.parse(raw) : (Number.isFinite(raw) ? raw : NaN);
      return {
        id: task?.id,
        type: task?.type,
        depth: task?.depth ?? 0,
        ageMs: Number.isFinite(ts) ? Math.max(0, this.#now().getTime() - ts) : 0,
      };
    });
  }

  // WP5 (D-WP5-4): only ctx.get('llm') is a supported probe. ctx.llm may throw
  // and must never be read — the host contract calls that out explicitly.
  async #resolveLlm() {
    this.providerListenerInstalled = this.providerListenerInstalled || false;
    if (this.deps.llm !== undefined) {
      this.llm = this.deps.llm;
      return this.llm;
    }
    let llm = null;
    try {
      if (typeof this.ctx.get === 'function') llm = this.ctx.get('llm') ?? null;
    } catch { /* 宿主没注册 llm */ }
    this.llm = llm;
    return llm;
  }

  // D-WP5-4: absence of llm is a wait state, not a terminal block. The timer is
  // the safety net; `llm/adapters-updated` wakes immediately when available.
  async #enterWaitingProvider(message) {
    if (this.disposed) return this.#result();
    this.panelState = 'waiting_provider';
    this.substate = 'waiting';
    this.reason = 'waiting_provider';
    this.since = this.#iso();
    this.lastError = null;
    this.providerWait.lastError = String(message ?? 'llm service is not registered');
    this.providerWait.attempts += 1;
    this.#markProviderMissing(true);
    this.#installProviderListener();
    this.#scheduleProviderRetry();
    this.providerInfo = {
      ...this.providerInfo,
      waitAttempts: this.providerWait.attempts,
      lastError: this.providerWait.lastError,
      ...(this.providerWait.nextRetryAt ? { nextRetryAt: this.providerWait.nextRetryAt } : {}),
    };
    this.#writeStatus();
    this.#log('warn', `waiting for llm service: ${this.providerWait.lastError}`);
    return this.#result();
  }

  #providerRetryDelayMs() {
    const base = Number.isFinite(this.deps.providerRetryMs) && this.deps.providerRetryMs > 0
      ? this.deps.providerRetryMs
      : 30000;
    const hardCap = Number.isFinite(this.deps.providerMaxRetryMs) && this.deps.providerMaxRetryMs > 0
      ? Math.min(this.deps.providerMaxRetryMs, 300000)
      : 300000;
    const attempt = Math.max(1, this.providerWait.attempts);
    return Math.min(hardCap, base * 2 ** Math.min(attempt - 1, 10));
  }

  #scheduleProviderRetry() {
    if (this.disposed) return;
    this.#clearTimer(this.providerRetryTimer);
    this.providerRetryTimer = null;
    const delay = this.#providerRetryDelayMs();
    this.providerWait.nextRetryAt = new Date(this.#now().getTime() + delay).toISOString();
    this.nextTickAt = this.providerWait.nextRetryAt;
    // Tests pass installTimers:false and drive retries explicitly.
    if (this.deps.installTimers === false) return;
    this.providerRetryTimer = this.#timer(() => {
      this.providerRetryTimer = null;
      this.#runProviderRetry().catch((error) => this.#failSafe(error));
    }, delay);
  }

  async #runProviderRetry() {
    if (this.disposed) return;
    const waiting = this.panelState === 'waiting_provider';
    const recoverableBlock = this.panelState === 'blocked' && this.lastError?.code === 'E_NO_PROVIDER';
    if (!waiting && !recoverableBlock) return;
    this.panelState = 'starting';
    this.substate = 'starting';
    this.reason = 'provider_retry';
    this.lastError = null;
    this.providerInfo = {
      configured: typeof this.config.provider === 'string' && this.config.provider.trim() !== '',
      missing: true,
      waitAttempts: this.providerWait.attempts,
      ...(this.providerWait.lastError ? { lastError: this.providerWait.lastError } : {}),
    };
    try {
      await this.#start();
    } catch (error) {
      await this.block(error?.code ?? 'E_START_FAILED', error);
    }
  }

  // Public test seam: same path as the timer, without waiting for it.
  async retryProviderNow() {
    return this.#runProviderRetry();
  }

  async handleProviderAdaptersUpdated() {
    if (this.disposed) return;
    if (this.panelState === 'waiting_provider'
      || (this.panelState === 'blocked' && this.lastError?.code === 'E_NO_PROVIDER')) {
      this.#clearTimer(this.providerRetryTimer);
      this.providerRetryTimer = null;
      return this.#runProviderRetry();
    }
    if (this.panelState === 'running' && this.modelInfo?.auto === true) {
      this.#scheduleAutoReResolve();
    }
    return undefined;
  }

  #installProviderListener() {
    if (this.providerListenerInstalled || this.deps.installListener === false) return;
    if (typeof this.ctx?.on !== 'function') return;
    try {
      const dispose = this.ctx.on('llm/adapters-updated', () => {
        this.handleProviderAdaptersUpdated().catch((error) => this.#failSafe(error));
      }, { prepend: false });
      if (typeof dispose === 'function') this.listenerDisposers.push(dispose);
      this.providerListenerInstalled = true;
    } catch (error) {
      this.#log('warn', `llm/adapters-updated listener failed: ${errorMessage(error)}`);
    }
  }

  #scheduleAutoReResolve() {
    if (this.disposed || this.autoResolveTimer) return;
    const delay = 200; // host contract: 100–500ms debounce
    if (this.deps.installTimers === false) return;
    this.autoResolveTimer = this.#timer(() => {
      this.autoResolveTimer = null;
      this.#reResolveAutoModel().catch((error) => this.#failSafe(error));
    }, delay);
  }

  async #reResolveAutoModel() {
    if (this.disposed || this.panelState !== 'running' || this.modelInfo?.auto !== true) return;
    const previous = this.modelInfo.resolved;
    const target = await resolveModelTarget({
      config: this.config,
      ctx: this.ctx,
      llm: this.llm,
      explicitReasoningEffort: this.explicitReasoningEffort,
    });
    if (!target.ok) {
      this.#addWarning('MODEL_AUTO_UNRESOLVED');
      this.#writeStatus();
      return;
    }
    if (!target.auto) return;
    if (target.model !== previous || target.provider !== this.effectiveProvider) {
      this.#applyModelTarget(target);
      this.#auditSafe('model.auto_resolved', {
        run_id: this.runId,
        from: previous,
        to: target.model,
        provider: target.provider,
        source: target.modelSource,
      });
      this.#writeStatus();
      this.#log('info', `model auto re-resolved to ${target.model}`);
    }
  }

  #applyModelTarget(target) {
    this.effectiveProvider = target.provider;
    this.providerSource = target.providerSource;
    this.providerCandidates = Array.isArray(target.providerCandidates) ? target.providerCandidates.slice() : null;
    this.modelInfo = {
      auto: target.auto === true,
      resolved: target.model,
      resolvedAt: this.#iso(),
    };
    this.modelSource = target.modelSource;
    this.reasoningEffort = target.reasoningEffort ?? null;
    for (const code of Array.isArray(target.warnings) ? target.warnings : []) this.#addWarning(code);
    if (target.unlisted === true) {
      this.pendingAudits.push(['model.unlisted', {
        model: target.model,
        provider: target.provider,
        source: 'explicit',
        candidates: Array.isArray(target.candidates) ? target.candidates.slice(0, 20) : [],
      }]);
    }
    if (target.auto === true) {
      this.pendingAudits.push(['model.auto_resolved', {
        model: target.model,
        provider: target.provider,
        source: target.modelSource,
        ...(target.reasoningEffort ? { reasoning_effort: target.reasoningEffort } : {}),
      }]);
    }
    if (target.warnings.includes(MODEL_AUTO_PICKED_LIST_ORDER)) {
      this.pendingAudits.push(['model.auto_list_order', {
        model: target.model,
        provider: target.provider,
      }]);
    }
    if (target.warnings.includes(REASONING_EFFORT_UNSUPPORTED)) {
      this.pendingAudits.push(['model.reasoning_effort_unsupported', {
        provider: target.provider,
        model: target.model,
      }]);
    }
  }

  #flushPendingAudits() {
    if (!this.audit || this.pendingAudits.length === 0) return;
    const pending = this.pendingAudits.splice(0);
    for (const [kind, data] of pending) this.#auditSafe(kind, { run_id: this.runId, ...data });
  }

  // Vault 目录是 status.json 的落点。provider 缺失/非法时也要先有目录，否则
  // waiting_provider/blocked 写 status 会静默失败（面板看不到状态）。
  #initVaultDir() {
    const memoryRoot = this.config.memoryRoot ?? this.deps.memoryRoot ?? null;
    const vaultDir = this.config.vaultDir
      ? path.resolve(this.config.vaultDir)
      : (typeof memoryRoot === 'string' && memoryRoot.trim() !== ''
        ? path.join(path.resolve(memoryRoot), '.longlive', 'router')
        : null);
    if (!vaultDir) {
      const error = new Error('router vault needs memoryRoot or routerVaultDir');
      error.code = 'E_NO_MEMORY_ROOT';
      throw error;
    }
    this.vaultDir = vaultDir;
    fs.mkdirSync(vaultDir, { recursive: true });
    return vaultDir;
  }

  #initPaths() {
    const vaultDir = this.#initVaultDir();
    this.runDir = path.join(vaultDir, 'runs', this.runId);
    this.outboxDir = path.join(vaultDir, 'outbox');
    fs.mkdirSync(this.runDir, { recursive: true });
    fs.mkdirSync(this.outboxDir, { recursive: true });

    const now = () => this.#iso();
    this.lock = new InstanceLock({
      file: path.join(vaultDir, 'router.lock'),
      runId: this.runId,
      leaseMs: this.deps.lockLeaseMs ?? 30000,
      now: () => this.#now(),
    });
    this.queue = this.deps.queue ?? new TaskQueue({
      file: path.join(vaultDir, 'queue.jsonl'),
      maxTasks: this.deps.maxTasks ?? 200,
      maxBytes: this.config.queueMaxBytes,
    });
    this.ledger = this.deps.ledger ?? new BudgetLedger({
      file: path.join(this.runDir, 'budget.ledger.jsonl'),
      runId: this.runId,
      maxTokens: this.config.maxTokensPerRun,
      now,
      reservationLeaseMs: this.deps.reservationLeaseMs ?? 60000,
    });
    this.audit = this.deps.audit ?? new AuditLog({
      file: path.join(vaultDir, 'audit.jsonl'),
      runId: this.runId,
      now,
    });
    this.anchor = this.deps.anchor ?? new AnchorLog({
      file: this.config.anchorPath ? path.resolve(this.config.anchorPath) : path.join(this.runDir, 'anchor.jsonl'),
      now,
    });
    this.#initL2();
  }

  /**
   * WP2 wiring. Pure constructors: no directory is created and no listener is
   * registered here; the board file only appears on the first tick/pre-step.
   */
  #initL2() {
    const memoryRoot = this.config.memoryRoot ?? this.deps.memoryRoot ?? null;
    this.paths = routerPaths({ memoryRoot, vaultDir: this.vaultDir });
    try {
      this.liveWriter = createLiveWriter({
        memoryRoot: this.paths.liveRoot,
        maxRows: this.config.liveRowsMax,
        now: () => this.#now(),
        audit: (kind, data) => this.#audit(kind, data),
        onWarning: (code) => this.#addWarning(code),
        logger: (message) => this.#log('warn', message),
      });
    } catch (error) {
      this.liveWriter = null;
      this.#log('warn', `live writer init failed: ${errorMessage(error)}`);
    }
    // Startup sweep: dead same-host rows (>4x ttl) move to the tombstone ledger
    // before removal; stale rows stay visible in health/status.
    try {
      const swept = liveSweep({ autoCleanup: true }, { memoryRoot: this.paths.liveRoot, now: this.#now() });
      this.liveSweepInfo = { stale: swept.stale, dead: swept.dead, removed: swept.removed.length, tombstoned: swept.tombstoned };
      if (swept.removed.length > 0) this.#auditSafe('live.sweep', { removed: swept.removed.length, stale: swept.stale, dead: swept.dead });
    } catch (error) {
      this.liveSweepInfo = null;
      this.#log('warn', `live startup sweep failed: ${errorMessage(error)}`);
    }
    try {
      this.boardBuilder = createBoardBuilder({
        memoryRoot: this.paths.liveRoot,
        config: this.config,
        now: () => this.#now(),
        paths: this.paths,
      });
    } catch (error) {
      this.boardBuilder = null;
      this.#log('warn', `board builder init failed: ${errorMessage(error)}`);
    }
    try {
      this.injector = createHintInjector({
        ctx: this.ctx,
        config: this.config,
        now: () => this.#now(),
        audit: (kind, data) => this.#audit(kind, data),
        onInject: (info) => this.#onInject(info),
        onSkip: () => { this.sharedInfo.skipped += 1; },
        onWarning: (code) => this.#addWarning(code),
        logger: (message) => this.#log('warn', message),
        boardProvider: () => this.#boardForInjection(),
        injectStateDir: this.paths.injectStateDir,
        // v1 bridge: shared IDENTITY.md + router-face outbox live under memoryRoot.
        memoryRoot,
        testHooks: this.testHooks,
        installListener: this.deps.installListener !== false,
      });
    } catch (error) {
      this.injector = null;
      this.#log('warn', `hint injector init failed: ${errorMessage(error)}`);
    }
    if (this.config.proposalEnabled === true) {
      try {
        this.proposalEngine = createProposalEngine({
          config: this.config,
          paths: this.paths,
          memoryRoot: this.paths.liveRoot,
          audit: (kind, data) => this.#audit(kind, data),
          now: () => this.#now(),
          logger: (message) => this.#log('warn', message),
        });
        // Read-only warm-up; the proposals directory is only created by the
        // first real propose (DESIGN §5.1 / K13 default-off contract).
        this.proposalsInfo = this.proposalEngine.status();
        // WP4: queue/lease/WAL/wake/tick-lock live beside the proposal store.
        const audit = (kind, data) => this.#audit(kind, data);
        const logger = (message) => this.#log('warn', message);
        const now = () => this.#now();
        const locksDir = path.join(this.vaultDir, 'locks');
        this.wal = createWal({
          file: this.proposalEngine.walFile,
          audit,
          logger,
          maxBytes: this.config.walMaxBytes,
          now,
        });
        this.lease = createWriterLease({
          file: path.join(locksDir, 'writer.lease.json'),
          lockDir: locksDir,
          ttlMs: clampLeaseTtl(this.config.writerLeaseMs),
          renewalsMax: this.config.leaseRenewMax,
          holder: { sessionId: 'router-service', runId: this.runId, pid: process.pid, host: 'local' },
          now,
          audit,
        });
        this.queueManager = createQueueManager({ paths: this.paths, config: this.config, wal: this.wal, audit, now });
        this.wakeChannel = createWakeChannel({ vaultDir: this.vaultDir, config: this.config, now, audit, logger });
        this.tickLock = createTickLock({
          file: path.join(this.vaultDir, 'tick.lock'),
          maxHoldMs: computeMaxHoldMs(clampLeaseTtl(this.config.writerLeaseMs), this.config.leaseRenewMax),
          now,
          audit,
        });
        this.applier = createApplier({
          paths: this.paths,
          vaultDir: this.vaultDir,
          memoryRoot: this.paths.liveRoot,
          config: this.config,
          lease: this.lease,
          wal: this.wal,
          queue: this.queueManager,
          wake: this.wakeChannel,
          audit,
          now,
          logger,
          testHooks: this.testHooks,
          caller: { kind: 'root', sessionId: 'router-service' },
          // D-CR17: apply/rollback warnings must reach status().warnings.
          onWarning: (code) => this.#addWarning(code),
        });
        this.proposalEngine.applier = this.applier;
        this.proposalEngine.wake = this.wakeChannel;
        this.proposalEngine.lease = this.lease;
        this.wakeInfo = this.wakeChannel.status();
        this.proposalsInfo = this.applier.status().proposals;
      } catch (error) {
        this.proposalEngine = null;
        this.#log('warn', `proposal engine init failed: ${errorMessage(error)}`);
      }
    }
  }

  #auditSafe(kind, data = {}) {
    try { this.#audit(kind, data); } catch { /* L1/L2 diagnostics never block a turn */ }
  }

  /**
   * L-03 restart rebuild. Idempotent: on a healthy vault `rebuild()` sees a
   * queue that already matches the proposal files and writes nothing.
   */
  #restoreProposalQueue() {
    if (!this.queueManager || !this.proposalEngine) return;
    try {
      const rebuilt = this.queueManager.rebuild();
      if (rebuilt.written || rebuilt.recovered.length > 0 || rebuilt.orphans.length > 0) {
        this.#auditSafe('queue.restored', {
          written: rebuilt.written === true,
          depth: rebuilt.depth ?? null,
          nonTerminal: rebuilt.nonTerminal ?? null,
          recovered: rebuilt.recovered.length,
          orphans: rebuilt.orphans.length,
        });
      }
      this.proposalsInfo = this.proposalEngine.status();
    } catch (error) {
      this.#log('warn', `proposal queue restore failed: ${errorMessage(error)}`);
    }
  }

  async #boardForInjection() {
    try {
      await this.#refreshL2({ write: true });
    } catch (error) {
      this.#log('warn', `board refresh for injection failed: ${errorMessage(error)}`);
    }
    return this.boardSnapshot?.board ?? null;
  }

  /**
   * Rebuild the read-only board projection from live rows + session metadata.
   * Never throws: a broken live directory degrades to LIVE_UNREADABLE and the
   * tick continues (DESIGN §2.1).
   */
  async #refreshL2({ write = true } = {}) {
    if (!this.boardBuilder || this.disposed) return null;
    try { this.boardBuilder.cleanTmp?.(); } catch { /* tmp hygiene is best-effort */ }
    let metadata = null;
    try {
      metadata = await listSessionMetadata(this.ctx);
    } catch {
      metadata = null;
    }
    let snapshot;
    try {
      snapshot = this.boardBuilder.build({
        metadata,
        saturated: this.liveWriter?.saturated === true,
      });
    } catch (error) {
      this.#log('warn', `board build failed: ${errorMessage(error)}`);
      return null;
    }
    this.boardSnapshot = snapshot;
    let liveHealthInfo = null;
    try { liveHealthInfo = liveHealth(this.paths.liveRoot, { now: this.#now() }); } catch { liveHealthInfo = null; }
    this.liveInfo = {
      ...this.liveInfo,
      rows: snapshot.live.rows,
      maxRows: snapshot.live.maxRows,
      unknown: snapshot.live.unknown,
      corrupt: snapshot.live.corrupt,
      saturated: snapshot.live.saturated,
      ...(liveHealthInfo ? {
        active: liveHealthInfo.active,
        stale: liveHealthInfo.stale,
        dead: liveHealthInfo.dead,
        tombstoned: liveHealthInfo.tombstoned,
      } : {}),
      createdEventVia: this.liveCreatedEventVia,
      turnEndEventVia: this.liveTurnEndEventVia,
    };
    const priorHintTokens = this.sharedInfo?.hintTokensLast;
    const injected = this.#aggregateInjected();
    this.sharedInfo = {
      ...this.sharedInfo,
      ...snapshot.shared,
      ...injected,
    };
    // The board projection is a disk snapshot; it must never overwrite the
    // live injection counters with its placeholder zero (M-01).
    if (!Number.isInteger(injected.hintTokensLast) && Number.isInteger(priorHintTokens)) {
      this.sharedInfo.hintTokensLast = priorHintTokens;
    }
    if (write && this.config.sharedBoard === true) {
      try {
        const written = this.boardBuilder.write(snapshot);
        if (!written.ok) {
          this.#log('warn', `board write failed: ${written.code}`);
          this.#auditSafe('write.board_failed', { code: written.code ?? null });
        }
      } catch (error) {
        this.#log('warn', `board write failed: ${errorMessage(error)}`);
      }
    }
    return snapshot;
  }

  #aggregateInjected() {
    try {
      return this.injector?.aggregate() ?? {};
    } catch {
      return {};
    }
  }

  /**
   * WP6 Tier B actor (DESIGN §5.13). Reached only when both
   * routerProposalEnabled and routerWakeEnabled are true, so the default-off
   * tick path performs zero wake work. Host seams are injectable through deps
   * (sessionController / createUserMessage / flushSessions / sessionLogSize /
   * wakeSessions); §6.6 #6 froze them for the mock contract.
   */
  async #runWakeTierB() {
    const deps = this.deps ?? {};
    const getService = async (key) => {
      try {
        if (typeof this.ctx?.get !== 'function') return null;
        return await this.ctx.get(key);
      } catch {
        return null;
      }
    };

    let sessions = Array.isArray(deps.wakeSessions) ? deps.wakeSessions : null;
    if (!sessions) {
      const metadata = await listSessionMetadata(this.ctx).catch(() => null);
      if (!metadata) {
        this.#auditSafe('wake.skipped', { reason: 'metadata-unavailable' });
        return { ok: false, reason: 'metadata-unavailable' };
      }
      const metaById = new Map(metadata.map((item) => [item.sessionId, item]));
      const live = scanLiveRows({ memoryRoot: this.paths.liveRoot, now: this.#now() });
      sessions = live.entries
        .filter((entry) => entry && !entry.corrupt && typeof entry.sessionId === 'string')
        .map((entry) => {
          const meta = metaById.get(entry.sessionId) ?? null;
          return {
            sessionId: entry.sessionId,
            // Raw row state: Tier B never uses effectiveState (DESIGN §5.13).
            state: entry.state,
            origin: meta?.origin ?? null,
            parentSessionId: meta?.parentSession ?? null,
            isSubagent: meta?.origin === 'subagent',
          };
        });
    }

    const sessionController = deps.sessionController ?? await getService('sessionController');
    const sessionsService = deps.flushSessions ? null : await getService('sessions');
    const flush = typeof deps.flushSessions === 'function'
      ? deps.flushSessions
      : (typeof sessionsService?.flush === 'function' ? (session) => sessionsService.flush(session) : null);

    let createUserMessage = typeof deps.createUserMessage === 'function' ? deps.createUserMessage : null;
    if (!createUserMessage) {
      try {
        const llm = await import('@deepseek-ai/dsh-llm');
        if (typeof llm.createUserMessage === 'function') createUserMessage = (input) => llm.createUserMessage(input);
      } catch { /* runCycle falls back to an equivalent durable shape */ }
    }

    let sessionLogSize = typeof deps.sessionLogSize === 'function' ? deps.sessionLogSize : null;
    if (!sessionLogSize && typeof deps.sessionLogPath === 'function') {
      sessionLogSize = (sessionId) => {
        const file = deps.sessionLogPath(sessionId);
        if (!file) return null;
        try { return fs.statSync(file).size; } catch { return null; }
      };
    }

    const result = await this.wakeChannel.runCycle({
      sessions,
      sessionController,
      createUserMessage,
      flush,
      sessionLogSize,
    });
    if (result?.failed || result?.denied?.some((item) => item.code === 'E_WAKE_LOG_TOO_LARGE')) {
      // status.wake.lastError already carries the reason; do not flip the switch.
      this.#log('warn', `wake cycle: ${result?.reason ?? 'unknown'}`);
    }
    return result;
  }

  #onInject(info) {
    if (!info) return;
    const tokens = Number.isInteger(info.tokens) ? info.tokens : 0;
    this.sharedInfo = {
      ...this.sharedInfo,
      hintTokensLast: tokens,
      injectedTurns: (Number.isInteger(this.sharedInfo.injectedTurns) ? this.sharedInfo.injectedTurns : 0) + 1,
      injectedTokensToday: (Number.isInteger(this.sharedInfo.injectedTokensToday) ? this.sharedInfo.injectedTokensToday : 0) + tokens,
      lastInjectAt: info.at ?? null,
      lastInjectSha256: typeof info.sha256 === 'string' ? info.sha256 : null,
    };
  }

  #readPriorStatus() {
    if (!this.vaultDir) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(this.vaultDir, 'status.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  async #refreshDayUsage({ initial = false } = {}) {
    const today = dayKey(this.#now());
    const prior = this.#readPriorStatus();
    const priorUsed = prior && prior.today?.day === today
      ? Number(prior.today.usedTokens) || 0
      : 0;
    // 日窗口滚动：只继承同一个本地日内已经计过的用量；换日即从零开始。
    const carryUsed = this.dayUsage?.day === today ? this.dayUsage.usedTokens : 0;
    const scan = scanDayUsage({
      vaultDir: this.vaultDir,
      now: this.#now(),
      statusTodayUsed: Math.max(priorUsed, carryUsed),
    });
    if (scan.tampered) {
      this.#addWarning('E_LEDGER_TAMPERED');
      await this.block('E_LEDGER_TAMPERED', 'ledger bad line / broken hash chain');
      return false;
    }
    if (scan.clockRegression) {
      this.#addWarning('CLOCK_REGRESSION');
      try { this.#audit('clock.regression', { day: scan.day, status_used: scan.statusUsed, scanned_used: scan.scannedSettled }); } catch { /* optional */ }
    }
    this.dayUsage = {
      day: scan.day,
      usedTokens: scan.used,
      reservedTokens: scan.reserved,
      capTokens: this.config.maxTokensPerDay,
      runs: scan.runs,
    };
    return true;
  }

  async #start() {
    // 先用最小步骤建 vault 目录：后面无论进入 waiting_provider 还是 blocked，
    // 都要能把 status.json 写出来（VM B-03/B-05、面板可见性都依赖这一点）。
    try {
      this.#initVaultDir();
    } catch (error) {
      await this.block(error?.code ?? 'E_VAULT_WRITE', errorMessage(error));
      return;
    }

    const llm = await this.#resolveLlm();
    this.#installProviderListener();
    if (!llm || typeof llm.stream !== 'function') {
      return this.#enterWaitingProvider('no llm service is registered (ctx.get("llm") is empty)');
    }

    // WP5 D-WP5-1/2/3/6：显式 > 宿主当前默认 > listModels 首个非 preview >
    // blocked(E_NO_PROVIDER)+candidates。解析器绝不猜版本、也绝不回退写死 id。
    const target = await resolveModelTarget({
      config: this.config,
      ctx: this.ctx,
      llm,
      explicitReasoningEffort: this.explicitReasoningEffort,
    });
    if (!target.ok) {
      this.#markProviderMissing(true);
      await this.block(target.code ?? 'E_NO_PROVIDER', target.message ?? 'no usable provider/model');
      return;
    }
    this.#applyModelTarget(target);
    this.#markProviderMissing(false);
    this.providerWait = { attempts: this.providerWait.attempts, lastError: null, nextRetryAt: null };
    this.nextTickAt = null;

    try {
      this.#initPaths();
    } catch (error) {
      await this.block(error?.code ?? 'E_VAULT_WRITE', errorMessage(error));
      return;
    }

    const lockResult = this.lock.acquire();
    if (!lockResult.ok) {
      this.#setState('standby', 'standby');
      this.#writeStatus();
      this.#scheduleStandbyRetry();
      return;
    }

    let reclaimed = null;
    try {
      this.ledger.repairTail();
      this.audit.open();
      this.anchor.repairTail();
      reclaimed = this.#reclaimRunLedgers();
    } catch (error) {
      await this.block(error?.code ?? 'E_LEDGER_WRITE', errorMessage(error));
      return;
    }

    this.#flushPendingAudits();

    const auditRead = readAudit(this.audit.file);
    if (auditRead.tamperedLines > 0 || auditRead.badLines > 0 || auditRead.chainBreaks.length > 0) {
      this.#addWarning('E_LEDGER_TAMPERED');
      await this.block('E_LEDGER_TAMPERED', `audit chain is not clean (bad=${auditRead.badLines}, breaks=${auditRead.chainBreaks.length})`);
      return;
    }

    // E-06/G-02/G-03：回收结果必须在审计洁净检查之后落账，避免往坏链上追加。
    this.#auditBudgetReclaim('startup', reclaimed);

    // L-03: a restart must not inherit a stale queue view. `proposals/*.json`
    // is the source of truth; `proposals/queue.json` is a derived cache that a
    // crash between "write proposal" and "write queue" can leave behind. Build
    // it once, before the first tick, so `list`, `queue` and `status` agree the
    // moment the service is up (an approved row must never be listed as pending).
    this.#restoreProposalQueue();

    if (lockResult.takeover) {
      try { this.#audit('lock.takeover', { previous_run: lockResult.previous?.runId ?? null }); } catch { /* start will fail below */ }
    }

    const reconciled = reconcileRuns({
      vaultDir: this.vaultDir,
      audit: this.audit,
      auditRecords: auditRead.records,
    });
    if (!reconciled.ok) {
      this.#addWarning(reconciled.code ?? 'E_LEDGER_TAMPERED');
      await this.block(reconciled.code ?? 'E_LEDGER_TAMPERED', 'audit/ledger reconcile failed');
      return;
    }

    const anchors = verifyRunAnchors({
      vaultDir: this.vaultDir,
      auditRecords: readAudit(this.audit.file).records,
      auditFile: this.audit.file,
      allowMissingAnchor: this.config.allowMissingAnchor,
      verifyAnchor,
      readAnchor,
    });
    if (!anchors.ok) {
      this.#addWarning(anchors.code ?? 'E_LEDGER_TAMPERED');
      await this.block(anchors.code ?? 'E_LEDGER_TAMPERED', `anchor verification failed: ${anchors.failure?.reason ?? 'unknown'}`);
      return;
    }
    this.#auditAllowedMissingAnchors(anchors);

    const dayOk = await this.#refreshDayUsage({ initial: true });
    if (!dayOk) return;

    try {
      this.#setState('running', 'started');
      this.#audit('router.start', {
        run_id: this.runId,
        provider: this.effectiveProvider,
        provider_source: this.providerSource,
        model: this.modelInfo.resolved ?? this.config.model,
        model_auto: this.modelInfo.auto,
        model_source: this.modelSource,
        ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
        autonomy: this.config.autonomy,
        agent_mode: this.agentMode,
        budget: { run_cap: this.config.maxTokensPerRun, day_cap: this.config.maxTokensPerDay },
      });
      this.#sealAnchor();
    } catch (error) {
      await this.block(error?.code ?? 'E_AUDIT_WRITE', errorMessage(error));
      return;
    }

    this.nextTickAt = new Date(this.#now().getTime() + (this.deps.firstTickMs ?? 3000)).toISOString();
    this.heartbeatAt = this.#iso();
    this.#installTurnListener();
    try { this.injector?.start(); } catch (error) { this.#log('warn', `agent/pre-step install failed: ${errorMessage(error)}`); }
    try { await this.#refreshL2({ write: true }); } catch (error) { this.#log('warn', `initial board refresh failed: ${errorMessage(error)}`); }
    this.#installTimers();
    this.#writeStatus();
    this.#log('info', `running (runId=${this.runId}, vault=${this.vaultDir})`);
  }

  async start() {
    if (this.config.enabled !== true) {
      this.panelState = 'stopped';
      this.reason = 'disabled';
      this.started = false;
      return { ok: false, code: 'E_DISABLED', state: this.panelState };
    }
    if (this.started) return this.#result();
    this.started = true;
    this.panelState = 'starting';
    this.reason = 'starting';
    this.since = this.#iso();
    try {
      await this.#start();
    } catch (error) {
      await this.block(error?.code ?? 'E_START_FAILED', error);
    }
    return this.#result();
  }

  #scheduleStandbyRetry() {
    if (this.deps.installTimers === false || this.disposed) return;
    this.standbyTimer = this.#timer(async () => {
      if (this.panelState !== 'standby' || this.disposed) return;
      const acquired = this.lock?.acquire();
      if (!acquired?.ok) {
        this.#scheduleStandbyRetry();
        return;
      }
      // 抢到了：重新走一遍账本/审计/锚校验，而不是复用 standby 之前的状态。
      this.panelState = 'starting';
      this.started = false;
      try {
        await this.#reinitializeAfterStandby();
      } catch (error) {
        await this.block(error?.code ?? 'E_START_FAILED', errorMessage(error));
      }
    }, this.deps.standbyRetryMs ?? STANDBY_RETRY_MS);
  }

  async #reinitializeAfterStandby() {
    let reclaimed = null;
    try {
      this.ledger.repairTail();
      this.audit.open();
      this.anchor.repairTail();
      reclaimed = this.#reclaimRunLedgers();
    } catch (error) {
      await this.block(error?.code ?? 'E_LEDGER_WRITE', errorMessage(error));
      return;
    }
    const auditRead = readAudit(this.audit.file);
    if (auditRead.tamperedLines > 0 || auditRead.badLines > 0 || auditRead.chainBreaks.length > 0) {
      this.#addWarning('E_LEDGER_TAMPERED');
      await this.block('E_LEDGER_TAMPERED', 'audit chain is not clean after standby takeover');
      return;
    }
    this.#auditBudgetReclaim('standby_takeover', reclaimed);
    const reconciled = reconcileRuns({ vaultDir: this.vaultDir, audit: this.audit, auditRecords: auditRead.records });
    if (!reconciled.ok) {
      this.#addWarning(reconciled.code ?? 'E_LEDGER_TAMPERED');
      await this.block(reconciled.code ?? 'E_LEDGER_TAMPERED', 'reconcile failed after standby takeover');
      return;
    }
    const anchors = verifyRunAnchors({
      vaultDir: this.vaultDir,
      auditRecords: readAudit(this.audit.file).records,
      auditFile: this.audit.file,
      allowMissingAnchor: this.config.allowMissingAnchor,
      verifyAnchor,
      readAnchor,
    });
    if (!anchors.ok) {
      this.#addWarning(anchors.code ?? 'E_LEDGER_TAMPERED');
      await this.block(anchors.code ?? 'E_LEDGER_TAMPERED', `anchor verification failed: ${anchors.failure?.reason ?? 'unknown'}`);
      return;
    }
    this.#auditAllowedMissingAnchors(anchors);
    if (!(await this.#refreshDayUsage())) return;
    try {
      this.#setState('running', 'standby_takeover');
      this.#audit('router.start', {
        run_id: this.runId,
        provider: this.effectiveProvider,
        provider_source: this.providerSource,
        model: this.modelInfo.resolved ?? this.config.model,
        model_auto: this.modelInfo.auto,
        model_source: this.modelSource,
        ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
        autonomy: this.config.autonomy,
        agent_mode: this.agentMode,
        budget: { run_cap: this.config.maxTokensPerRun, day_cap: this.config.maxTokensPerDay },
      });
      this.#sealAnchor();
    } catch (error) {
      await this.block(error?.code ?? 'E_AUDIT_WRITE', errorMessage(error));
      return;
    }
    this.nextTickAt = new Date(this.#now().getTime() + (this.deps.firstTickMs ?? 3000)).toISOString();
    this.#installTurnListener();
    this.#installTimers();
    this.#writeStatus();
  }

  #installTurnListener() {
    if (this.deps.installListener === false) return;
    if (typeof this.ctx.on !== 'function') return;
    try {
      // R4.4: the real host emits `session/event` as TWO positional args
      // `(session, event)` (recorded DSH logs, 2026-11-06), while several
      // shipped tests drive the legacy one-arg envelope. Accept both arities:
      // two-arg -> event is arg 2 and arg 1 is the session; one-arg -> arg 1 is
      // the event (which may still carry `.session` inside).
      const listener = (...args) => {
        const twoArg = args.length >= 2 && args[1] != null;
        const event = twoArg ? args[1] : args[0];
        const session = twoArg ? args[0] : null;
        return this.handleSessionEvent(event, session);
      };
      const disposer = this.ctx.on('session/event', listener, { prepend: false });
      if (typeof disposer === 'function') this.listenerDisposers.push(disposer);
    } catch (error) {
      this.#log('warn', `session/event listener install failed: ${errorMessage(error)}`);
    }
    // Some host builds emit session/created as a direct event instead of a
    // session/event envelope. Register both and report which one actually fired
    // through status.live.createdEventVia — never silently assume.
    try {
      const created = this.ctx.on('session/created', (session) => {
        try { this.#onSessionCreated(session, 'session/created'); } catch (error) {
          this.#log('warn', `session/created heartbeat failed: ${errorMessage(error)}`);
        }
      }, { prepend: false });
      if (typeof created === 'function') this.listenerDisposers.push(created);
    } catch (error) {
      this.#log('warn', `session/created listener install failed: ${errorMessage(error)}`);
    }
  }

  #installTimers() {
    if (this.deps.installTimers === false) return;
    if (this.firstTickTimer) this.#clearTimer(this.firstTickTimer);
    this.firstTickTimer = this.#timer(() => {
      this.firstTickTimer = null;
      this.tick({ tier: 'full', reason: 'startup' }).catch((error) => this.#failSafe(error));
    }, this.deps.firstTickMs ?? 3000);

    if (this.tickTimer) this.#clearTimer(this.tickTimer);
    this.tickTimer = this.#interval(() => {
      if (this.panelState !== 'running') return;
      // status.nextTickAt means "the next scheduled tick" (DESIGN §6.5); the
      // periodic timer owns that slot, so refresh it before the tick runs.
      this.nextTickAt = new Date(this.#now().getTime() + this.config.tickMs).toISOString();
      this.tick({ tier: 'reflect', reason: 'timer' }).catch((error) => this.#failSafe(error));
    }, this.config.tickMs);

    if (this.heartbeatTimer) this.#clearTimer(this.heartbeatTimer);
    this.heartbeatTimer = this.#interval(() => this.#heartbeat(), this.deps.heartbeatMs ?? LOCK_RENEW_MS);

    if (this.config.stopFile) {
      if (this.stopFileTimer) this.#clearTimer(this.stopFileTimer);
      this.stopFileTimer = this.#interval(() => {
        if (this.#stopFileExists()) {
          this.stop('stop_file').catch((error) => this.#failSafe(error));
        }
      }, this.deps.stopFilePollMs ?? 5000);
    }
  }

  #heartbeat() {
    if (this.panelState !== 'running' && this.panelState !== 'standby') return;
    const wasOwned = this.lock?.owned === true;
    let renewed = true;
    try { renewed = this.lock?.renew() !== false; } catch (error) { this.#log('warn', `lock renew failed: ${errorMessage(error)}`); renewed = false; }
    this.heartbeatAt = this.#iso();
    if (!renewed && wasOwned) {
      // F-01 fail-stop: another process reclaimed our lock while we were
      // paused. Continuing would write as a second live instance.
      this.#onLockLost();
      return;
    }
    this.#writeStatus();
  }

  #onLockLost() {
    if (this.lockLost) return;
    this.lockLost = true;
    try { this.#auditSafe('lock.lost', { runId: this.runId, at: this.#iso() }); } catch { /* best effort */ }
    this.block('E_LOCK_LOST', 'writer lock was reclaimed by another instance').catch((error) => this.#failSafe(error));
  }

  #stopFileExists() {
    if (!this.config.stopFile) return false;
    try { return fs.existsSync(this.config.stopFile); } catch { return false; }
  }

  #sessionOfEvent(event) {
    return event?.session ?? event?.data?.session ?? event?.data ?? event;
  }

  /** The session this Router instance belongs to, when the host exposes it. */
  #ownSessionId() {
    try {
      const direct = this.ctx?.sessionId
        ?? this.ctx?.session?.id
        ?? this.ctx?.get?.('session')?.id
        ?? this.ctx?.get?.('sessionId');
      return typeof direct === 'string' && direct.trim() ? direct.trim().toLowerCase() : null;
    } catch {
      return null;
    }
  }

  #onSessionCreated(session, via) {
    if (this.disposed) return;
    const id = sessionIdOf(session);
    if (!id) {
      this.#auditSafe('live.row_skipped', { reason: 'bad_session_id', via });
      return;
    }
    const header = session?.header ?? session?.session?.header ?? {};
    // DESIGN §2.1: subagents are only a count; they never get a Router live row.
    if (header.origin === 'subagent') {
      this.#auditSafe('live.row_skipped', { session_id: id, via, reason: 'subagent' });
      return;
    }
    // DESIGN §2.1: Router never writes another session's row.
    const own = this.#ownSessionId();
    if (own && own !== id) {
      this.#auditSafe('live.row_skipped', { session_id: id, via, reason: 'other-session' });
      return;
    }
    const goal = typeof header.goal === 'string'
      ? header.goal
      : (typeof session?.goal === 'string' ? session.goal : undefined);
    const result = this.liveWriter?.write({
      sessionId: id,
      state: 'idle',
      goal,
      reason: 'session/created',
      via,
      turn: Number.isInteger(header.turn) ? header.turn : undefined,
    });
    if (result?.ok) {
      this.liveCreatedEventVia = via;
      this.liveInfo = { ...this.liveInfo, createdEventVia: via };
    } else {
      this.#auditSafe('live.row_skipped', { session_id: id, via, code: result?.code ?? 'NO_WRITER' });
    }
  }

  #onTurnEnd(event, via, sessionArg = null) {
    if (this.disposed) return;
    const session = sessionArg ?? this.#sessionOfEvent(event);
    const id = sessionIdOf(session) ?? sessionIdOf(event);
    if (!id) return;
    const header = session?.header ?? {};
    if (header.origin === 'subagent') {
      this.#auditSafe('live.row_skipped', { session_id: id, via, reason: 'subagent' });
      return;
    }
    const own = this.#ownSessionId();
    if (own && own !== id) {
      this.#auditSafe('live.row_skipped', { session_id: id, via, reason: 'other-session' });
      return;
    }
    const scan = this.liveWriter?.scan();
    const ownRow = scan?.ok ? scan.entries.find((entry) => entry.sessionId === id) : null;
    const state = stateForTurnEnd(ownRow?.state);
    const rawTurn = Number.isInteger(event?.turn)
      ? event.turn
      : (Number.isInteger(event?.data?.turn) ? event.data.turn : ownRow?.turn);
    const goal = typeof event?.data?.goal === 'string'
      ? event.data.goal
      : (typeof header.goal === 'string' ? header.goal : undefined);
    const result = this.liveWriter?.write({
      sessionId: id,
      state,
      turn: Number.isInteger(rawTurn) ? rawTurn : undefined,
      goal,
      blocked_on: state === 'blocked' ? ownRow?.blocked_on : undefined,
      reason: 'turn/end',
      via,
    });
    if (result?.ok) {
      this.liveTurnEndEventVia = via;
      this.liveInfo = { ...this.liveInfo, turnEndEventVia: via };
    } else {
      this.#auditSafe('live.row_skipped', { session_id: id, via, code: result?.code ?? 'NO_WRITER' });
    }
  }

  #handleLiveEvent(event, sessionArg = null) {
    const type = event?.type;
    if (type === 'session/created') {
      this.#onSessionCreated(sessionArg ?? this.#sessionOfEvent(event), 'session/event');
      return true;
    }
    if (type === 'turn/end') {
      this.#onTurnEnd(event, 'turn/end', sessionArg);
      return true;
    }
    if (type === 'agent/status') {
      const status = event?.data?.state ?? event?.data?.status ?? event?.status;
      if (status === 'idle') {
        this.#onTurnEnd(event, 'agent/status', sessionArg);
        return true;
      }
    }
    return false;
  }

  /**
   * turn/end 唤醒：只认 reason.kind === 'completed'，2 秒防抖 + 5 分钟合并。
   * 返回 {scheduled, coalesced?, debounced?, ignored?}，方便单测。
   */
  handleSessionEvent(event, session = null) {
    // L1 heartbeat runs for every turn boundary, independent of reflectOnTurn
    // and of reason.kind (an aborted turn still ends).
    try { this.#handleLiveEvent(event, session); } catch (error) {
      this.#log('warn', `live heartbeat failed: ${errorMessage(error)}`);
    }
    const type = event?.type;
    if (type !== 'turn/end') return { scheduled: false, ignored: true, reason: 'not_turn_end' };
    if (event?.data?.reason?.kind !== 'completed') {
      return { scheduled: false, ignored: true, reason: 'not_completed' };
    }
    if (event?.data?.origin === 'router' || event?.data?.task?.origin === 'router') {
      return { scheduled: false, ignored: true, reason: 'recursive' };
    }
    if (this.config.reflectOnTurn !== true) return { scheduled: false, ignored: true, reason: 'disabled' };
    if (this.panelState !== 'running' || this.disposed) return { scheduled: false, ignored: true, reason: 'not_running' };

    const now = this.#now().getTime();
    if (this.lastTurnReflectAt > 0 && now - this.lastTurnReflectAt < this.config.reflectCoalesceMs) {
      return { scheduled: false, coalesced: true, reason: 'coalesced' };
    }
    if (this.reflectTimer) return { scheduled: false, debounced: true, reason: 'debounced' };

    const delayMs = this.deps.turnDebounceMs ?? 2000;
    this.reflectTimer = this.#timer(() => {
      this.reflectTimer = null;
      const current = this.#now().getTime();
      if (this.lastTurnReflectAt > 0 && current - this.lastTurnReflectAt < this.config.reflectCoalesceMs) return;
      this.lastTurnReflectAt = current;
      this.tick({ tier: 'reflect', reason: 'turn' }).catch((error) => this.#failSafe(error));
    }, delayMs);
    return { scheduled: true, delayMs };
  }

  /**
   * 工具/内部触发。同步检查 busy 与状态，返回 {ok,accepted} 或错误码；tick 本身异步。
   */
  requestTick({ tier = 'full', reason = 'manual', manual = true, caller } = {}) {
    if (isSubagentCaller(caller)) return { ok: false, code: 'E_NOT_MAIN_SESSION' };
    if (this.disposed || this.panelState === 'stopped') return { ok: false, code: 'E_STOPPED', state: this.panelState };
    if (!this.started) return { ok: false, code: 'E_NOT_STARTED' };
    if (this.panelState === 'standby') return { ok: false, code: 'E_STANDBY', state: this.panelState };
    if (this.panelState === 'stopping') return { ok: false, code: 'E_STOPPING', state: this.panelState };
    if (this.panelState === 'blocked' && !manual) return { ok: false, code: 'E_BLOCKED', state: this.panelState };
    if (this.busy) {
      this.#auditTickBusy('request', { tier, reason, code: 'E_BUSY' });
      return { ok: false, code: 'E_BUSY', state: this.panelState };
    }
    const normalizedTier = tier === 'reflect' ? 'reflect' : 'full';
    const delayMs = this.deps.manualDelayMs ?? 2000;
    this.#timer(() => {
      this.tick({ tier: normalizedTier, reason, manual }).catch((error) => this.#failSafe(error));
    }, delayMs);
    return { ok: true, accepted: true, tier: normalizedTier, runId: this.runId, delayMs };
  }

  async #resumeForTick() {
    const code = this.lastError?.code;
    if (HARD_BLOCK_CODES.has(code)) return false;
    if (code === 'E_NO_PROVIDER') {
      const llm = await this.#resolveLlm();
      if (!llm || typeof llm.stream !== 'function') return false;
      const target = await resolveModelTarget({
        config: this.config,
        ctx: this.ctx,
        llm,
        explicitReasoningEffort: this.explicitReasoningEffort,
      });
      if (!target.ok) return false;
      this.#applyModelTarget(target);
      this.#markProviderMissing(false);
    }
    const previous = this.panelState;
    this.panelState = 'running';
    this.reason = 'resumed';
    this.since = this.#iso();
    this.lastError = null;
    this.consecutiveErrors = 0;
    this.substate = 'idle';
    try { this.#audit('state.change', { from: previous, to: 'running', reason: 'manual_resume' }); } catch { /* status below */ }
    this.#installTimers();
    this.#writeStatus();
    return true;
  }

  async tick({ tier = 'full', reason = 'manual', manual = false } = {}) {
    if (!this.started) return { ok: false, code: 'E_NOT_STARTED' };
    if (this.panelState === 'blocked') {
      if (!manual) return { ok: false, code: 'E_NOT_RUNNING', state: this.panelState };
      const resumed = await this.#resumeForTick();
      if (!resumed) return { ok: false, code: 'E_NOT_RUNNING', state: this.panelState, lastError: this.lastError };
    }
    if (this.panelState !== 'running') {
      return { ok: false, code: 'E_NOT_RUNNING', state: this.panelState };
    }
    if (this.busy) {
      this.#auditTickBusy('tick', { tier, reason, code: 'E_BUSY' });
      return { ok: false, code: 'E_BUSY', state: this.panelState };
    }

    // DESIGN §3.6 (D30): one tick at a time across accidental dual instances.
    // A holder that is alive makes this round a quiet skip; an unrecoverable
    // reclaim mutex is surfaced as TICK_RECLAIM_BUSY, never waited on.
    if (this.tickLock) {
      let locked;
      try { locked = this.tickLock.tryAcquire(); } catch (error) {
        this.#log('warn', `tick lock failed: ${errorMessage(error)}`);
        locked = { ok: false, reason: 'error' };
      }
      if (!locked.ok) {
        if (locked.reason === 'reclaim-busy') this.#addWarning('TICK_RECLAIM_BUSY');
        this.#auditTickBusy('lock', { tier, reason, code: 'E_TICK_LOCKED', lockReason: locked.reason });
        return { ok: true, skipped: true, reason: locked.reason, tier: tier === 'reflect' ? 'reflect' : 'full' };
      }
    }

    this.busy = true;
    const promise = this.#doTick({ tier: tier === 'reflect' ? 'reflect' : 'full', reason, manual });
    this.inflight = promise;
    let result;
    try {
      result = await promise;
    } catch (error) {
      result = await this.#failSafe(error);
    } finally {
      this.busy = false;
      this.inflight = null;
      try { this.tickLock?.release(); } catch { /* evidence stays; next tick reclaims */ }
    }
    return result;
  }

  async #doTick({ tier, reason }) {
    this.lastTickAt = this.#iso();
    this.heartbeatAt = this.lastTickAt;
    this.substate = 'idle';

    if (this.#stopFileExists()) {
      // stop() waits for this.inflight; this tick is that inflight, so clear it
      // first or the service deadlocks until disposeTimeoutMs.
      this.inflight = null;
      await this.stop('stop_file');
      return { ok: true, stopped: true, reason: 'stop_file' };
    }

    let reclaimed = null;
    try { reclaimed = this.#reclaimRunLedgers(); } catch (error) {
      await this.block('E_LEDGER_WRITE', `reclaimDead failed: ${errorMessage(error)}`);
      return { ok: false, code: 'E_LEDGER_WRITE' };
    }
    this.#auditBudgetReclaim('tick', reclaimed);
    if (!(await this.#refreshDayUsage())) {
      return { ok: false, code: this.lastError?.code ?? 'E_LEDGER_TAMPERED' };
    }

    let view;
    try {
      view = this.queue.pending(this.seen);
    } catch (error) {
      await this.block('E_LEDGER_WRITE', `queue read failed: ${errorMessage(error)}`);
      return { ok: false, code: 'E_LEDGER_WRITE' };
    }
    const totalLines = view.tasks.length + view.invalid.length + (view.duplicates?.length ?? 0);
    if (view.invalid.length > 0 && totalLines > 0 && view.invalid.length / totalLines > 0.1) {
      await this.block('E_QUEUE_DIRTY', `queue has ${view.invalid.length}/${totalLines} invalid lines`);
      return { ok: false, code: 'E_QUEUE_DIRTY' };
    }

    // WP2: refresh the read-only board projection and age out inject-state.
    // Both are best-effort; a broken live/inject directory never blocks a tick.
    try { this.liveWriter?.evict({ limit: this.config.liveRowsMax }); } catch (error) {
      this.#log('warn', `live row eviction failed: ${errorMessage(error)}`);
    }
    try { await this.#refreshL2({ write: true }); } catch (error) {
      this.#log('warn', `board refresh failed: ${errorMessage(error)}`);
    }
    try { this.injector?.prune({ maxSessions: this.config.injectStateMaxSessions }); } catch (error) {
      this.#log('warn', `inject-state prune failed: ${errorMessage(error)}`);
    }

    // WP4: queue/WAL reconciliation plus at most one apply per tick. This runs
    // under tick.lock; an apply failure is recorded on the proposal and must
    // never abort the rest of the tick (DESIGN §5.3a/§5.4).
    if (this.applier) {
      try {
        const maintenance = await this.applier.maintain({ allowApply: this.config.applyEnabled === true });
        if (maintenance?.applied) this.lastApplyAt = this.#iso();
        if (maintenance?.walBroken === true) this.#addWarning('WAL_BROKEN');
      } catch (error) {
        this.#log('warn', `apply maintenance failed: ${errorMessage(error)}`);
      }
    }

    // WP6: Tier B wake (DESIGN §5.13). Default off; a disabled Router must not
    // read wake state, call resolveAgent or followup. Runs even when the host
    // task queue is empty, hence before the idle early-return below.
    if (this.wakeChannel && this.config.wakeEnabled === true && this.config.proposalEnabled === true) {
      try {
        await this.#runWakeTierB();
      } catch (error) {
        this.#log('warn', `wake cycle failed: ${errorMessage(error)}`);
      }
    }

    // DESIGN §4.2: 每个 completed turn 的 reflect 是轻量整理——即使宿主任务队列
    // 为空，也要跑一次 reflect 档模型（C-02）。它不进 TaskQueue（B-06），只在
    // 本次 tick 里作为内部任务执行，审计里能看到 type=tier=reflect。
    let runTasks = view.tasks;
    if (runTasks.length === 0 && tier === 'reflect' && reason === 'turn' && this.config.reflectOnTurn === true) {
      runTasks = [{
        id: `turn-reflect-${this.runId}-${this.ticks + 1}`,
        type: 'reflect',
        question: 'turn/end reflect',
        payload: { question: 'turn/end reflect' },
        origin: 'host',
        depth: 0,
      }];
    }

    if (runTasks.length === 0) {
      const now = this.#now().getTime();
      if (now - this.lastIdleAt >= 10 * 60 * 1000) {
        this.lastIdleAt = now;
        try { this.#audit('tick.idle', { reason }); } catch (error) {
          return this.#handleTickFailure(error);
        }
      }
      // An empty queue is not "not running": the periodic timer is still
      // armed, so nextTickAt must keep pointing at the next scheduled tick.
      this.#writeStatus();
      return { ok: true, idle: true, processed: 0, tier, reason };
    }

    this.ticks += 1;
    try {
      this.#audit('tick.start', { tick: this.ticks, tier, reason, pending: runTasks.length });
    } catch (error) {
      return this.#handleTickFailure(error);
    }

    let processed = 0;
    let tokensUsed = 0;
    const maxTasks = clampLimit(this.deps.maxTasksPerTick, 1, 5, 3);
    for (const task of runTasks.slice(0, maxTasks)) {
      if (this.panelState !== 'running') break;
      const result = await this.#runTask(task, { tier, queueView: view });
      processed += 1;
      tokensUsed += Number(result.tokensUsed) || 0;
      if (result.stop) break;
    }

    try {
      this.#audit('tick.end', { tick: this.ticks, tier, processed, tokens: tokensUsed });
    } catch (error) {
      return this.#handleTickFailure(error);
    }
    if (this.ticks % 10 === 0) this.#sealAnchor();
    this.#writeStatus();
    return { ok: true, processed, tokensUsed, tier, state: this.panelState };
  }

  async #handleTickFailure(error) {
    if (error?.code === 'E_AUDIT_WRITE') {
      this.panelState = 'stopped';
      this.reason = 'E_AUDIT_WRITE';
      this.lastError = { code: 'E_AUDIT_WRITE', at: this.#iso(), message: errorMessage(error) };
      this.#clearTimers();
      this.#writeStatus();
      return { ok: false, code: 'E_AUDIT_WRITE', state: 'stopped' };
    }
    return this.#failSafe(error);
  }

  #accountDaySettled(reservationTokens, applied) {
    if (!this.dayUsage) return;
    this.dayUsage.reservedTokens = Math.max(0, (this.dayUsage.reservedTokens ?? 0) - (Number(reservationTokens) || 0));
    this.dayUsage.usedTokens = (this.dayUsage.usedTokens ?? 0) + Math.max(0, Number(applied) || 0);
  }

  #accountDayReleased(reservationTokens) {
    if (!this.dayUsage) return;
    this.dayUsage.reservedTokens = Math.max(0, (this.dayUsage.reservedTokens ?? 0) - (Number(reservationTokens) || 0));
  }

  async #runTask(task, { tier, queueView }) {
    if (task?.origin === 'router' || (Number.isInteger(task?.depth) && task.depth > 0)) {
      this.denied += 1;
      this.seen.add(task.id);
      try { this.#audit('task.denied', { task_id: task.id, type: task.type, reason: 'recursive' }); } catch (error) {
        return this.#handleTickFailure(error);
      }
      return { denied: true, tokensUsed: 0 };
    }

    const sources = await loadContextSources({
      memoryRoot: this.config.memoryRoot ?? this.deps.memoryRoot ?? null,
      task,
      now: this.#now(),
      stability: this.stability,
    });
    sources.queue = {
      rows: this.#queueRows(queueView.tasks),
      pending: queueView.tasks.length,
      invalid: queueView.invalid.length,
      oldestAgeMs: this.#oldestAge(queueView.tasks),
    };
    let led = null;
    try { led = this.ledger.snapshot(); } catch { /* ignore */ }
    sources.ledger = {
      runUsed: led?.used ?? 0,
      runCap: this.config.maxTokensPerRun,
      dayUsed: this.dayUsage?.usedTokens ?? 0,
      dayCap: this.config.maxTokensPerDay,
      reserved: (led?.reserved ?? 0) + (this.dayUsage?.reservedTokens ?? 0),
    };
    for (const warning of sources.warnings) {
      if (String(warning).startsWith('INDEX_MISSING_FILE') || String(warning).endsWith('_UNSTABLE') || String(warning) === 'MEMORY_ROOT_MISSING') {
        try { this.#audit('llm.diagnostic', { task_id: task.id, code: warning }); } catch { /* diagnostic 不是关键路径 */ }
      }
    }

    let context = assembleContext({
      tier,
      task,
      sources,
      forceOverBudget: this.testHooks?.forceContextOverBudget === true,
    });
    let degraded = false;

    if (!context.ok) {
      if (tier === 'full' && context.canDegrade) {
        const reflect = assembleContext({
          tier: 'reflect',
          task,
          sources,
          degraded: true,
          forceOverBudget: this.testHooks?.forceContextOverBudget === true,
        });
        if (reflect.ok) {
          context = reflect;
          degraded = true;
          try {
            this.#audit('budget.degrade', {
              task_id: task.id,
              from: 'full',
              to: 'reflect',
              full_tokens: context.totalTokens,
              reason: 'context_over_budget',
            });
          } catch (error) { return this.#handleTickFailure(error); }
        } else {
          await this.block('E_CONTEXT_OVER_BUDGET', 'both full and reflect context exceed budget');
          return { stop: true, tokensUsed: 0 };
        }
      } else {
        await this.block('E_CONTEXT_OVER_BUDGET', 'reflect context exceeds budget');
        return { stop: true, tokensUsed: 0 };
      }
    }

    let reservation = null;
    let reservationTokens = 0;
    let settled = false;
    const callMax = this.config.callMaxTokens;
    let contextInputTokens = context.contentTokens;

    const reserveFor = (ctx) => {
      const needed = (ctx.contentTokens + callMax) * this.config.maxAttempts;
      const dayRemaining = Math.max(0, this.config.maxTokensPerDay
        - (this.dayUsage?.usedTokens ?? 0)
        - (this.dayUsage?.reservedTokens ?? 0));
      if (needed > dayRemaining) {
        return { needed, result: { ok: false, code: 'E_BUDGET_EXCEEDED', remaining: dayRemaining } };
      }
      try {
        const result = this.ledger.reserve({ taskId: task.id, tokens: needed, owner: this.runId, tick: this.ticks });
        if (result.ok && this.dayUsage) this.dayUsage.reservedTokens = (this.dayUsage.reservedTokens ?? 0) + needed;
        return { needed, result };
      } catch (error) {
        const code = error?.code ?? 'E_LEDGER_WRITE';
        return { needed, error: { code: code.startsWith('E_BUDGET_') ? 'E_LEDGER_WRITE' : code, message: errorMessage(error) } };
      }
    };

    let attempt = reserveFor(context);
    if (attempt.error) {
      await this.block(attempt.error.code, attempt.error.message);
      return { stop: true, tokensUsed: 0 };
    }
    if (!attempt.result.ok) {
      if (tier === 'full') {
        const fullTokens = context.totalTokens;
        const reflect = assembleContext({
          tier: 'reflect',
          task,
          sources,
          degraded: true,
          forceOverBudget: this.testHooks?.forceContextOverBudget === true,
        });
        if (reflect.ok) {
          const second = reserveFor(reflect);
          if (second.error) {
            await this.block(second.error.code, second.error.message);
            return { stop: true, tokensUsed: 0 };
          }
          if (second.result.ok) {
            context = reflect;
            contextInputTokens = reflect.contentTokens;
            degraded = true;
            attempt = second;
            try {
              this.#audit('budget.degrade', {
                task_id: task.id,
                from: 'full',
                to: 'reflect',
                full_tokens: fullTokens,
                needed: second.needed,
                remaining: attempt.result.remaining,
                reason: 'reserve_not_fit',
              });
            } catch (error) { return this.#handleTickFailure(error); }
          }
        }
      }
      if (!attempt?.result?.ok) {
        try {
          this.#audit('budget.exceeded', {
            task_id: task.id,
            tier: context.tier,
            needed: attempt.needed ?? null,
            remaining: attempt.result?.remaining ?? null,
          });
        } catch (error) { return this.#handleTickFailure(error); }
        await this.block('E_BUDGET_EXHAUSTED', `budget reserve failed (needed=${attempt.needed ?? '?'}, remaining=${attempt.result?.remaining ?? '?'})`);
        return { stop: true, tokensUsed: 0 };
      }
    }

    reservation = attempt.result;
    reservationTokens = attempt.needed;
    try {
      this.#audit('budget.reserve', {
        task_id: task.id,
        reservation_id: reservation.id,
        tokens: reservationTokens,
        tier: context.tier,
      });
      this.#audit('task.start', {
        task_id: task.id,
        type: task.type,
        tier: context.tier,
        input_tokens: contextInputTokens,
        reserved_tokens: reservationTokens,
      });
    } catch (error) {
      try { this.ledger.release({ id: reservation.id }); } catch { /* ignore */ }
      this.#accountDayReleased(reservationTokens);
      return this.#handleTickFailure(error);
    }

    this.abortController = new AbortController();
    let callResult;
    try {
      callResult = await this.#callModel(context, task, { signal: this.abortController.signal });
    } catch (error) {
      callResult = {
        ok: false,
        failureCode: error?.code ?? 'E_CALL_FAILED',
        retryExhausted: true,
        usage: null,
        invalidUsage: false,
        attempts: 1,
        aborted: this.abortController.signal.aborted,
      };
    } finally {
      this.abortController = null;
    }

    const usage = callResult.usage;
    const validUsage = usage && !callResult.invalidUsage && Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens);
    const actualUsage = validUsage
      ? Math.max(0, Math.round(usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)))
      : contextInputTokens + callMax;
    const usageEstimated = !validUsage;

    if (callResult.aborted) {
      try { this.ledger.release({ id: reservation.id }); } catch { /* ignore */ }
      this.#accountDayReleased(reservationTokens);
      try { this.#audit('task.error', { task_id: task.id, code: 'E_ABORTED', attempt: callResult.attempts ?? 1 }); } catch { /* ignore */ }
      return { stop: true, aborted: true, tokensUsed: 0 };
    }

    if (callResult.invalidUsage) {
      try {
        const settledResult = this.ledger.settle({ id: reservation.id, tokens: actualUsage, allowOvershoot: true });
        settled = true;
        this.#accountDaySettled(reservationTokens, settledResult.applied ?? 0);
        this.#audit('budget.settle', {
          task_id: task.id,
          reservation_id: reservation.id,
          tokens: settledResult.applied ?? 0,
          requested: actualUsage,
          usage_estimated: true,
          usage_invalid: true,
        });
      } catch { /* below */ }
      await this.block('E_USAGE_INVALID', 'llm usage is negative/NaN/non-integer');
      return { stop: true, tokensUsed: actualUsage };
    }

    try {
      const settledResult = this.ledger.settle({ id: reservation.id, tokens: actualUsage, allowOvershoot: true });
      settled = true;
      this.#accountDaySettled(reservationTokens, settledResult.applied ?? 0);
      // A reservation is a forecast, not a billing ceiling. Account what the call
      // really cost (up to the hard run cap), surface the forecast miss, and halt
      // instead of pretending the extra tokens never happened (E-05).
      const overshoot = !settledResult.ok || actualUsage > reservationTokens;
      if (overshoot) {
        try {
          this.#audit('budget.overshoot', {
            task_id: task.id,
            reservation_id: reservation.id,
            requested: actualUsage,
            applied: settledResult.applied ?? 0,
            rejected: settledResult.rejected ?? 0,
            reserved_tokens: reservationTokens,
          });
        } catch { /* the halt below still applies */ }
        await this.#halt('E_BUDGET_OVERSHOOT', `actual usage ${actualUsage} exceeds reservation ${reservationTokens}`);
        return { stop: true, tokensUsed: actualUsage };
      }
      this.#audit('budget.settle', {
        task_id: task.id,
        reservation_id: reservation.id,
        tokens: settledResult.applied ?? actualUsage,
        requested: actualUsage,
        usage_estimated: usageEstimated,
      });
    } catch (error) {
      if (!settled) {
        try { this.ledger.release({ id: reservation.id }); } catch { /* ignore */ }
        this.#accountDayReleased(reservationTokens);
      }
      await this.block('E_LEDGER_WRITE', `ledger settle failed: ${errorMessage(error)}`);
      return { stop: true, tokensUsed: actualUsage };
    }

    if (!callResult.ok) {
      const code = callResult.failureCode ?? 'E_CALL_FAILED';
      const hostCode = callResult.hostCode ?? code;
      this.consecutiveErrors += 1;
      try {
        this.#audit('task.error', {
          task_id: task.id,
          code: hostCode,
          router_code: code,
          attempt: callResult.attempts ?? this.config.maxAttempts,
          streak: this.consecutiveErrors,
          retry_exhausted: callResult.retryExhausted === true,
          ...(callResult.rateLimited ? { rate_limited: true } : {}),
        });
      } catch (error) {
        return this.#handleTickFailure(error);
      }
      if (callResult.fatal || callResult.terminal) {
        // D-WP5-5: terminal host failures surface as Router codes, with the
        // host code in the message for diagnosis (never credential material).
        await this.block(code, `llm provider error: ${hostCode}`);
        return { stop: true, tokensUsed: actualUsage };
      }
      this.substate = 'backoff';
      const baseDelay = computeBackoff({
        attempt: callResult.rateLimited ? 1 : this.consecutiveErrors,
        initialDelayMs: this.deps.backoffInitialMs ?? 5000,
        maxDelayMs: this.deps.backoffMaxMs ?? 300000,
        jitterRatio: 0,
      });
      const delayMs = callResult.rateLimited && Number.isFinite(callResult.retryAfterMs)
        ? Math.min(Math.max(callResult.retryAfterMs, 0), 300000)
        : baseDelay;
      this.nextTickAt = new Date(this.#now().getTime() + delayMs).toISOString();
      this.#scheduleBackoff(delayMs);
      // Rate limiting is retryable by contract: it must never become a
      // permanent E_ERROR_STREAK block (D-WP5-5).
      if (!callResult.rateLimited && this.consecutiveErrors >= this.config.maxConsecutiveErrors) {
        await this.block('E_ERROR_STREAK', `${this.consecutiveErrors} consecutive tick errors (last ${code})`);
        return { stop: true, tokensUsed: actualUsage };
      }
      this.#writeStatus();
      return { stop: true, tokensUsed: actualUsage, retryInMs: delayMs };
    }

    this.consecutiveErrors = 0;
    this.substate = 'idle';

    const text = typeof callResult.text === 'string' ? callResult.text : '';
    const action = parseAction(text);
    if (!action) {
      this.consecutiveErrors += 1;
      try {
        this.#audit('action.denied', { task_id: task.id, reason: 'parse', text_length: text.length, text_sha256: sha256Text(text) });
      } catch (error) {
        return this.#handleTickFailure(error);
      }
      this.seen.add(task.id);
      if (this.consecutiveErrors >= this.config.maxConsecutiveErrors) {
        await this.block('E_ERROR_STREAK', `parse failed ${this.consecutiveErrors} times`);
      }
      return { stop: true, tokensUsed: actualUsage };
    }

    if (!ALLOWED_ACTIONS.has(action.type)) {
      this.denied += 1;
      this.seen.add(task.id);
      try {
        this.#audit('action.denied', {
          task_id: task.id,
          reason: 'not_allowed',
          action_type: String(action.type ?? ''),
          text_length: text.length,
          text_sha256: sha256Text(text),
        });
      } catch (error) {
        return this.#handleTickFailure(error);
      }
      return { stop: false, tokensUsed: actualUsage };
    }

    try {
      this.#audit('action', {
        task_id: task.id,
        action_type: action.type,
        text_length: text.length,
        text_sha256: sha256Text(text),
      });
    } catch (error) {
      return this.#handleTickFailure(error);
    }

    if (action.type === 'report') {
      await this.#recordReport(task, action, { degraded });
    }

    this.seen.add(task.id);
    this.processed += 1;
    try {
      this.#audit('task.done', { task_id: task.id, action_type: action.type, tokens: actualUsage });
    } catch (error) {
      return this.#handleTickFailure(error);
    }
    this.#writeStatus();
    return { ok: true, tokensUsed: actualUsage };
  }

  #scheduleBackoff(delayMs) {
    if (this.deps.installTimers === false || this.disposed) return;
    this.#timer(() => {
      if (this.panelState !== 'running') return;
      this.tick({ tier: 'reflect', reason: 'backoff', manual: true }).catch((error) => this.#failSafe(error));
    }, delayMs);
  }

  async #callModel(context, task, { signal }) {
    const messages = buildMessages({
      system: context.messages?.system ?? '',
      prompt: context.messages?.prompt ?? context.userText ?? '',
    });
    let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let invalidUsage = false;
    let attempts = 0;

    const provider = this.effectiveProvider || this.config.provider;
    const resolvedModel = this.modelInfo?.resolved
      ?? (this.config.model && this.config.model !== 'auto' ? this.config.model : null);
    if (!provider || !resolvedModel || resolvedModel === 'auto') {
      // Belt and braces: never send the literal "auto" to the host.
      return {
        ok: false,
        fatal: true,
        failureCode: 'E_NO_PROVIDER',
        hostCode: 'MODEL_UNRESOLVED',
        terminal: true,
        usage,
        invalidUsage: true,
        attempts: 0,
      };
    }

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
      attempts = attempt;
      let stream;
      try {
        stream = this.llm.stream({
          messages,
          task,
          signal,
          maxTokens: this.config.callMaxTokens,
          provider,
          model: resolvedModel,
          ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
        });
      } catch (error) {
        const hostCode = String(error?.code ?? 'TRANSPORT');
        const mapped = mapProviderFailure(hostCode, { retryAfterMs: error?.providerRetryAfterMs });
        if (!mapped.terminal && mapped.retryable !== false
          && attempt < this.config.maxAttempts && !signal?.aborted) {
          await this.#retryWait(attempt, mapped.retryAfterMs);
          continue;
        }
        return {
          ok: false,
          failureCode: mapped.routerCode,
          hostCode,
          terminal: mapped.terminal === true,
          fatal: mapped.terminal === true,
          rateLimited: mapped.rateLimited === true,
          retryAfterMs: mapped.retryAfterMs,
          retryExhausted: true,
          usage,
          invalidUsage,
          attempts,
          aborted: signal?.aborted === true,
        };
      }

      let result;
      try {
        result = await consumeStream(stream, { signal });
      } catch (error) {
        result = {
          ok: false,
          failure: { code: error?.code ?? 'E_STREAM_CONSUME', message: errorMessage(error) },
          aborted: signal?.aborted === true,
          usage: null,
        };
      }

      if (result?.usage) {
        if (result.usage.invalid === true) invalidUsage = true;
        usage = {
          inputTokens: usage.inputTokens + (Number(result.usage.inputTokens) || 0),
          outputTokens: usage.outputTokens + (Number(result.usage.outputTokens) || 0),
          cacheReadTokens: usage.cacheReadTokens + (Number(result.usage.cacheReadTokens) || 0),
          cacheWriteTokens: usage.cacheWriteTokens + (Number(result.usage.cacheWriteTokens) || 0),
        };
      }

      if (signal?.aborted || result?.aborted) {
        return { ok: false, aborted: true, failureCode: 'E_ABORTED', hostCode: 'ABORTED', usage, invalidUsage, attempts };
      }
      if (result?.ok && typeof result.text === 'string') {
        return { ok: true, text: result.text, usage, invalidUsage, attempts };
      }

      const code = String(result?.failure?.code ?? result?.code ?? (result?.missingFinish ? 'E_STREAM_NO_FINISH' : 'EMPTY_RESPONSE'));
      const mapped = mapProviderFailure(code, {
        retryAfterMs: result?.failure?.providerRetryAfterMs,
      });
      if (mapped.aborted) {
        return { ok: false, aborted: true, failureCode: 'E_ABORTED', hostCode: code, usage, invalidUsage, attempts };
      }
      if (mapped.terminal) {
        return {
          ok: false,
          fatal: true,
          terminal: true,
          failureCode: mapped.routerCode,
          hostCode: code,
          usage,
          invalidUsage,
          attempts,
          streamFailure: result?.failure ?? null,
        };
      }
      if (attempt < this.config.maxAttempts && mapped.retryable) {
        await this.#retryWait(attempt, mapped.retryAfterMs);
        continue;
      }
      return {
        ok: false,
        retryExhausted: true,
        failureCode: mapped.routerCode,
        hostCode: code,
        rateLimited: mapped.rateLimited === true,
        retryAfterMs: mapped.retryAfterMs,
        usage,
        invalidUsage,
        attempts,
        streamFailure: result?.failure ?? null,
      };
    }

    return { ok: false, retryExhausted: true, failureCode: 'E_RETRY_EXHAUSTED', usage, invalidUsage, attempts };
  }

  async #retryWait(attempt, retryAfterMs) {
    if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
      const delayMs = Math.min(retryAfterMs, 30000);
      if (delayMs > 0) await sleep(delayMs);
      return;
    }
    await this.#retrySleep(attempt);
  }

  async #retrySleep(attempt) {
    const delayMs = this.deps.retryDelayMs !== undefined
      ? Math.max(0, this.deps.retryDelayMs)
      : Math.min(5000 * (2 ** (attempt - 1)), 300000);
    if (delayMs > 0) await sleep(delayMs);
  }

  async #recordReport(task, action, { degraded }) {
    const summary = String(action.summary ?? action.note ?? '').slice(0, 1200);
    const next = String(action.next ?? '').slice(0, 300);
    const waiting = String(action.waiting ?? '').slice(0, 300);
    this.lastReport = {
      at: this.#iso(),
      summary,
      next,
      waiting,
      degraded: degraded === true,
    };
    this.reports.push({ at: this.lastReport.at, summary });
    if (this.reports.length > 20) this.reports.shift();

    if (this.config.autonomy === 'draft') {
      try {
        const stamp = this.#iso().replace(/[:.]/gu, '-');
        const file = path.join(this.outboxDir, `report-${stamp}.md`);
        const body = `# Router 报告草案\n\n- at: ${this.lastReport.at}\n- task: ${task.id}\n- degraded: ${this.lastReport.degraded}\n\n## summary\n\n${summary}\n\n## next\n\n${next}\n\n## waiting\n\n${waiting}\n`;
        fs.mkdirSync(this.outboxDir, { recursive: true });
        fs.writeFileSync(file, body, 'utf8');
        this.#audit('writeback.draft', { task_id: task.id, file: path.basename(file), bytes: Buffer.byteLength(body) });
      } catch (error) {
        this.#log('warn', `report draft write failed: ${errorMessage(error)}`);
      }
    }
  }

  async #failSafe(error) {
    const code = String(error?.code ?? 'E_INTERNAL');
    this.lastError = { code, at: this.#iso(), message: errorMessage(error) };
    if (code === 'E_AUDIT_WRITE') {
      this.panelState = 'stopped';
      this.reason = 'E_AUDIT_WRITE';
      this.#clearTimers();
      this.#writeStatus();
      return { ok: false, code: 'E_AUDIT_WRITE', state: 'stopped' };
    }
    if (this.panelState === 'running' || this.panelState === 'starting') {
      try { this.#audit('state.change', { from: this.panelState, to: 'blocked', reason: code }); } catch { /* ignore */ }
    }
    this.panelState = 'blocked';
    this.reason = code;
    this.since = this.#iso();
    this.#clearTimers();
    this.#writeStatus();
    return { ok: false, code, state: 'blocked' };
  }

  async block(code, errorOrMessage) {
    if (this.disposed) return this.#result();
    const message = errorMessage(errorOrMessage);
    const from = this.panelState;
    this.panelState = 'blocked';
    this.reason = String(code ?? 'E_BLOCKED');
    this.since = this.#iso();
    this.lastError = { code: this.reason, at: this.#iso(), message };
    this.#clearTimers();
    if (this.audit && from !== 'blocked') {
      try { this.#audit('state.change', { from, to: 'blocked', reason: this.reason }); } catch { /* status is best-effort */ }
    }
    if (HARD_BLOCK_CODES.has(this.reason)) {
      try { this.lock?.release(); } catch { /* ignore */ }
    }
    this.#writeStatus();
    this.#log('warn', `blocked: ${this.reason} (${message})`);
    return this.#result();
  }

  async #halt(code, message) {
    if (this.disposed) return this.#result();
    const from = this.panelState;
    this.panelState = 'stopped';
    this.substate = 'idle';
    this.reason = String(code ?? 'E_STOPPED');
    this.since = this.#iso();
    this.lastError = { code: this.reason, at: this.#iso(), message: errorMessage(message) };
    this.nextTickAt = null;
    this.#clearTimers();
    if (this.audit && from !== 'stopped') {
      try { this.#audit('state.change', { from, to: 'stopped', reason: this.reason }); } catch { /* best effort */ }
    }
    this.#writeStatus();
    this.#log('warn', `stopped: ${this.reason} (${errorMessage(message)})`);
    return this.#result();
  }

  async stop(reason = 'manual') {
    if (this.stopPromise) return this.stopPromise;
    if (this.disposed && this.panelState === 'stopped') return this.#result({ auditBroken: false });
    if (this.panelState === 'stopped') return this.#result({ auditBroken: false });

    this.stopPromise = (async () => {
      this.panelState = 'stopping';
      this.reason = String(reason);
      this.since = this.#iso();
      this.stopRequested = true;
      this.#clearTimers();
      try { this.abortController?.abort(); } catch { /* ignore */ }
      let timedOut = false;
      if (this.inflight) {
        const timeoutMs = this.config.disposeTimeoutMs ?? 1000;
        const raced = await Promise.race([
          this.inflight.then(() => 'done', () => 'done'),
          sleep(timeoutMs).then(() => 'timeout'),
        ]);
        timedOut = raced === 'timeout';
      }
      if (timedOut) {
        try { this.ledger?.releaseOwner(this.runId); } catch { /* ignore */ }
      }

      let auditBroken = false;
      try {
        this.#audit('router.stop', {
          reason: this.reason,
          timeout: timedOut,
          ticks: this.ticks,
          processed: this.processed,
        });
      } catch {
        auditBroken = true;
      }
      try { this.ledger?.releaseOwner(this.runId); } catch { /* ignore */ }
      this.#sealAnchor();
      this.panelState = 'stopped';
      this.substate = 'idle';
      this.reason = String(reason);
      this.since = this.#iso();
      this.nextTickAt = null;
      this.#writeStatus();
      try { this.lock?.release(); } catch { /* ignore */ }
      for (const dispose of this.listenerDisposers) {
        try { dispose(); } catch { /* ignore */ }
      }
      this.listenerDisposers = [];
      try { this.injector?.dispose(); } catch { /* ignore */ }
      return this.#result({ auditBroken });
    })();

    try {
      return await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  async dispose() {
    if (this.disposed) return this.#result({ auditBroken: false });
    this.disposed = true;
    this.#clearTimers();
    try {
      if (this.panelState !== 'stopped') await this.stop('dispose');
      else {
        for (const dispose of this.listenerDisposers) {
          try { dispose(); } catch { /* ignore */ }
        }
        this.listenerDisposers = [];
        try { this.injector?.dispose(); } catch { /* ignore */ }
        try { this.lock?.release(); } catch { /* ignore */ }
      }
    } finally {
      try { this.audit?.close(); } catch { /* ignore */ }
    }
    return this.#result({ auditBroken: false });
  }

  status() {
    return this.#statusSnapshot();
  }

  /**
   * WP3 tool entry: create one proposal. `options.caller` carries
   * `{sessionId,kind,turn,host}` from the host tool wrapper.
   */
  async proposeProposal(args = {}, options = {}) {
    if (!this.proposalEngine) {
      return {
        ok: false,
        code: this.config.proposalEnabled === true ? 'E_NOT_RUNNING' : 'E_PROPOSAL_DISABLED',
        message: this.config.proposalEnabled === true
          ? 'router proposal engine is only available after start()'
          : 'routerProposalEnabled is false',
      };
    }
    return this.proposalEngine.propose(args, options);
  }

  /** WP3 tool entry: read-only list/queue/detail view. */
  proposalsView(args = {}, options = {}) {
    if (!this.proposalEngine) {
      return {
        ok: false,
        code: this.config.proposalEnabled === true ? 'E_NOT_RUNNING' : 'E_PROPOSAL_DISABLED',
        message: this.config.proposalEnabled === true
          ? 'router proposal engine is only available after start()'
          : 'routerProposalEnabled is false',
      };
    }
    return this.proposalEngine.view(args, options);
  }

  /**
   * WP5 seam for `router_apply` and the owner CLI. The actual state machine and
   * lease/WAL writer belong to WP4b; this method only delegates when that
   * applier is installed and otherwise reports the gap honestly. It never
   * mutates a proposal file itself (that would bypass lease/WAL).
   */
  async requestApply(args = {}, options = {}) {
    if (!this.proposalEngine) {
      return {
        ok: false,
        code: this.config.proposalEnabled === true ? 'E_NOT_RUNNING' : 'E_PROPOSAL_DISABLED',
        message: this.config.proposalEnabled === true
          ? 'router proposal engine is only available after start()'
          : 'routerProposalEnabled is false',
      };
    }
    const mode = String(args?.mode ?? '');
    if (!['approve', 'reject', 'apply', 'rollback', 'cancel'].includes(mode)) {
      return { ok: false, code: 'E_BAD_MODE', message: `unknown proposal transition: ${mode}` };
    }
    const caller = options?.caller ?? { kind: 'root' };
    // D-CR2 hard gate: a subagent may only cancel its own proposal; every
    // review/apply transition is main-session/owner only. This runs before the
    // confirm check so a subagent cannot probe confirm strings either.
    if (mode !== 'cancel' && isSubagentCaller(caller)) {
      return { ok: false, code: 'E_NOT_MAIN_SESSION', message: 'subagent sessions cannot approve, reject, apply or rollback proposals' };
    }
    const engine = this.proposalEngine;
    let effectiveArgs = args;
    let id = typeof args?.id === 'string' ? args.id.trim() : '';
    // K-04: `router_apply` advertises `ticket`; resolve it here so a pending row
    // can be cancelled/rejected by ticket without an extra list round-trip.
    if (id === '' && typeof args?.ticket === 'string' && args.ticket.trim() !== ''
      && typeof engine.idForTicket === 'function') {
      const resolved = engine.idForTicket(args.ticket);
      if (!resolved) {
        return { ok: false, code: 'E_TICKET_UNKNOWN', message: `ticket ${args.ticket.trim()} was not found` };
      }
      id = resolved;
      effectiveArgs = { ...args, id: resolved };
    }
    if (mode === 'apply' && id === '') {
      // D-CR3: no id -> resolve the approved queue head first, then require the
      // matching confirm. An empty queue is E_TICKET_UNKNOWN, never a silent idle.
      const head = typeof engine.headApproved === 'function' ? engine.headApproved() : null;
      if (!head?.id) return { ok: false, code: 'E_TICKET_UNKNOWN', message: 'no approved proposal at the queue head' };
      if (args?.confirm !== head.id.slice(-6)) {
        return { ok: false, code: 'E_CONFIRM_REQUIRED', message: 'confirm must equal the last 6 characters of the proposal id' };
      }
      effectiveArgs = { ...args, id: head.id };
    } else if (['approve', 'apply', 'rollback'].includes(mode)) {
      if (id === '') return { ok: false, code: 'E_TICKET_UNKNOWN', message: 'a valid proposal id is required' };
      const expected = id.slice(-6);
      if (args?.confirm !== expected) {
        return { ok: false, code: 'E_CONFIRM_REQUIRED', message: 'confirm must equal the last 6 characters of the proposal id' };
      }
    }
    const candidates = mode === 'apply'
      ? ['requestApply', 'applyProposal']
      : [mode, `${mode}Proposal`];
    const fn = candidates.map((name) => engine[name]).find((candidate) => typeof candidate === 'function');
    if (!fn) {
      return {
        ok: false,
        code: 'E_WP4_PENDING',
        state: this.panelState,
        message: `proposal transition "${mode}" requires the WP4 queue/lease/apply writer, which is not installed in this build`,
      };
    }
    // D-CR7: a lost rev CAS is retried from a fresh read, bounded; callers that
    // keep racing get the stable E_STATE_RACE result instead of a silent overwrite.
    let last = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await fn.call(engine, effectiveArgs, { caller });
        // N-03/L-04: status.json must reflect a proposal transition immediately
        // (the VM reads it right after apply, before the next heartbeat).
        try { this.#writeStatus(); } catch { /* status is best-effort */ }
        if (!(result && result.ok === false && result.code === 'E_STATE_RACE') || attempt === 2) return result;
        last = result;
      } catch (error) {
        if (error?.code !== 'E_STATE_RACE' || attempt === 2) throw error;
        last = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
    return last;
  }

  /** Tool-channel P0 denial audit hook (DESIGN §5.2/§5.10). */
  auditPriorityRejected(info = {}) {
    this.#auditSafe('priority.rejected', {
      id: null,
      attempted: 'P0',
      by: info.by ?? null,
      // `kind` is reserved by the audit envelope; keep the caller kind apart.
      callerKind: info.kind ?? null,
      reason: info.reason ?? 'tool-cannot-P0',
    });
  }

  reportHistory(limit = 5) {
    const max = clampLimit(limit, 1, 10, 5);
    const recent = this.reports.slice(-max);
    return {
      lastReport: this.lastReport,
      recent,
      count: recent.length,
    };
  }

  async ask({ question, tier = 'full', caller = null } = {}) {
    if (!this.started || this.disposed) return { ok: false, code: 'E_NOT_RUNNING', state: this.panelState };
    if (this.panelState === 'stopped' || this.panelState === 'standby') {
      return { ok: false, code: 'E_NOT_RUNNING', state: this.panelState };
    }
    const raw = typeof question === 'string' ? question.trim() : '';
    const q = Array.from(raw).slice(0, 500).join('');
    if (q === '') return { ok: false, code: 'E_INVALID_QUESTION' };
    // D-CR5: a subagent may ask at most 3 questions per rolling hour. The bucket
    // lives in memory on purpose: this is a safety valve for one service run,
    // not durable quota state (proposal quotas stay on disk).
    let askSession = null;
    let askBucket = null;
    let askNow = 0;
    if (caller && isSubagentCaller(caller)) {
      askSession = sessionIdOfCaller(caller);
      askNow = Date.now();
      if (!(this.askRate instanceof Map)) this.askRate = new Map();
      askBucket = (this.askRate.get(askSession) ?? []).filter((ts) => askNow - ts < ASK_RATE_WINDOW_MS);
      if (askBucket.length >= SUBAGENT_ASKS_PER_HOUR) {
        this.#auditSafe('ask.rejected', {
          by: askSession,
          reason: 'subagent-rate-limit',
          limit: SUBAGENT_ASKS_PER_HOUR,
        });
        return {
          ok: false,
          code: 'E_RATE_LIMITED',
          message: `subagent session exceeded ${SUBAGENT_ASKS_PER_HOUR} questions per hour`,
          limit: SUBAGENT_ASKS_PER_HOUR,
        };
      }
      this.askRate.set(askSession, askBucket);
    }
    const id = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let appended;
    try {
      appended = this.queue.writer.append({
        id,
        type: 'question',
        payload: { question: q },
        origin: 'tool',
        depth: 0,
        createdAt: this.#iso(),
        ...(askSession ? { sessionId: askSession, callerKind: 'subagent' } : {}),
      });
    } catch (error) {
      return { ok: false, code: error?.code ?? 'E_QUEUE_WRITE', message: errorMessage(error) };
    }
    if (!appended.ok) return appended;
    if (askBucket) askBucket.push(askNow);
    const trigger = this.requestTick({ tier, reason: 'ask', manual: true });
    return {
      ok: true,
      accepted: true,
      taskId: id,
      truncated: Array.from(raw).length > 500,
      tick: trigger.ok ? { accepted: true } : { accepted: false, code: trigger.code },
    };
  }

  async requestStop(reason = 'tool') {
    return this.stop(reason);
  }
}

/**
 * Compatibility re-export. The single source of truth is now
 * `caller.mjs` (session.header.origin first, legacy heuristic only when the
 * header is absent); keeping this named export preserves older importers.
 */
export { isSubagentCaller } from './caller.mjs';
