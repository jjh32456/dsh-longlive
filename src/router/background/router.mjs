// router.mjs — 后台 Router 骨架（spike 原型）
//
// 这一版针对第二轮评审 mustFix 重写，关键不变量：
//   1. 预算硬上限是「每个 run 目录」的：预留/结算都走 budget-ledger.mjs 的
//      文件锁账本，跨实例串行、跨重启累加；调用前按 callMaxTokens 预留，
//      剩余不够就绝不发起调用（而不是先花了再发现超了）。
//   2. start() 从账本恢复 used + reserved；只有「账本不存在」时才用审计
//      bootstrap 一次。审计有 CRC，坏行/截断行会被计数；没有账本又发现审计
//      损坏时 fail-closed（E_AUDIT_CORRUPT），不再静默少算预算。
//   3. 整个 tick 包在 try/catch 里，包括每一次 audit.append；审计写失败
//      转 stopped + 记录，tick 不 reject。
//   4. stop 先 abort，再等在飞 tick 到边界（带超时）；超时就强制释放本实例
//      的预留（僵尸 tick 不能继续占额度），最后才关审计。router.stop 写不进去
//      时 stop() 返回 ok:false + E_AUDIT_WRITE，而不是假报成功。
//   5. busy flag：并发 tick 只跑一个，另一个立即返回 E_BUSY。
//   6. 任务队列按 id 去重并带容量上限；写路径只给可信生产者（queue.writer）。
//   7. 工具面 restrict/guard 在 tool-policy.mjs；后台 agent 只读。
//   8. stream 按 AsyncIterable 契约消费，iterator.return() 有时限（stream.mjs）。
//   9. agent 生命周期 create -> agent.followup -> agent.whenIdle -> dispose
//      （agent-runner.mjs，真宿主返回 {agent, dispose}）。
//  10. RATE_LIMIT 退避 / QUOTA 立即停（retry.mjs），每次 attempt 的 usage 都累加。
//  11. llm.stream 必须带 provider + model（dsh-llm README:50-57），否则真机
//      NO_ADAPTER；配置从 constructor 或 llm 实例解析，并写进审计。

import fs from 'node:fs';
import path from 'node:path';
import { AuditLog, readAudit } from './audit.mjs';
import { BudgetLedger, readLedger } from './budget-ledger.mjs';
import { AnchorLog, verifyAnchor } from './anchor.mjs';
import { TaskQueue } from './queue.mjs';
import { MemoryReader, memoryToSystemPrompt } from './memory.mjs';
import { buildMessages, consumeStream } from './stream.mjs';
import { retryOnFailure } from './retry.mjs';
import { runAgentTask } from './agent-runner.mjs';

export const FORBIDDEN_ACTIONS = Object.freeze([
  'router.start',
  'router.spawn',
  'spawn_router',
  'subagent.spawn',
  'queue.append',
  'queue.write',
]);

export const DEFAULT_ALLOWED_ACTIONS = Object.freeze(['note', 'report', 'noop']);

/** 递归任务：由 Router 自己派生，或 depth > 0。 */
export function isRecursiveTask(task) {
  return task?.origin === 'router' || (Number.isInteger(task?.depth) && task.depth > 0);
}

/** 从文本末尾的 `ACTION: {...}` 行解析动作；解析失败返回 null。 */
export function parseAction(text) {
  if (typeof text !== 'string') return null;
  const matches = [...text.matchAll(/ACTION:\s*(\{.*\})\s*$/gm)];
  if (matches.length === 0) return null;
  try {
    return JSON.parse(matches[matches.length - 1][1]);
  } catch {
    return null;
  }
}

function recursiveAction(type) {
  return FORBIDDEN_ACTIONS.includes(type)
    || (typeof type === 'string' && (type.startsWith('router.') || type.startsWith('subagent')));
}

/**
 * 只有审计、没有账本时的一次性 bootstrap：把已发生的 settle 累加起来。
 * 旧实现用 max(tokens_total)，多实例/多任务时会少算；这里改成求和。
 * 未 settle 的 reserve 按「预留已花」保守计入（崩溃恢复）。
 * 记录里带 reservation_id 时按 id 配对；旧审计退回 task_id。
 */
export function foldAuditUsage(records) {
  let settledUsed = 0;
  const active = new Map();
  const settled = new Set();
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    const key = rec.reservation_id ?? (rec.task_id ? `task:${rec.task_id}` : null);
    if (rec.kind === 'budget.reserve') {
      const tokens = Number(rec.budgetReserved);
      if (key && Number.isFinite(tokens) && tokens >= 0) active.set(key, tokens);
    } else if (rec.kind === 'budget.settle') {
      const tokens = Number(rec.actual_tokens);
      if (key) {
        if (settled.has(key)) continue;
        settled.add(key);
        active.delete(key);
      }
      if (Number.isFinite(tokens) && tokens >= 0) settledUsed += tokens;
    } else if (rec.kind === 'budget.release' || rec.kind === 'stop.timeout') {
      if (key) active.delete(key);
    }
  }
  let openTokens = 0;
  for (const tokens of active.values()) openTokens += tokens;
  return {
    used: settledUsed + openTokens,
    settledUsed,
    openReservations: active.size,
    openTokens,
  };
}

export class Router {
  constructor({
    queuePath,
    auditPath,
    memoryPath = null,
    llm,
    provider = null,
    model = null,
    maxTokens = 4000,
    callMaxTokens = null,
    maxTicks = 50,
    maxTasksPerTick = 3,
    maxConsecutiveErrors = 3,
    callTimeoutMs = 2000,
    stopTimeoutMs = 1000,
    stopFile = null,
    runId = `run-${process.pid}-${Date.now().toString(36)}`,
    now = () => new Date().toISOString(),
    logger = null,
    retry = {},
    auditMaxBytes = undefined,
    auditMaxRotations = undefined,
    maxQueuedTasks = 500,
    maxQueueBytes = 1024 * 1024,
    heartbeatMs = 0,
    ledgerPath = null,
    ledgerLockTimeoutMs = 3000,
    anchorPath = null,
    allowMissingAnchor = false,
    reservationLeaseMs = 60000,
    ctx = null,
    agents = null,
    agentOptions = {},
    agentSetup = null,
    sessionId = null,
  } = {}) {
    if (!queuePath) throw new Error('Router: queuePath is required');
    if (!auditPath) throw new Error('Router: auditPath is required');
    if (!llm || typeof llm.stream !== 'function') {
      throw new Error('Router: llm.stream() is required (the promise-style complete() is not the host contract)');
    }

    this.queuePath = queuePath;
    this.auditPath = auditPath;
    this.memoryPath = memoryPath;
    this.llm = llm;
    // 真宿主 llm.stream 必须带 provider/model；允许从 llm 实例上取默认值。
    this.provider = provider ?? llm.provider ?? llm.defaultProvider ?? null;
    this.model = model ?? llm.model ?? llm.defaultModel ?? null;
    this.maxTokens = maxTokens;
    this.callMaxTokens = Math.max(1, Math.min(callMaxTokens ?? 1024, maxTokens));
    this.maxTicks = maxTicks;
    this.maxTasksPerTick = maxTasksPerTick;
    this.maxConsecutiveErrors = maxConsecutiveErrors;
    this.callTimeoutMs = callTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.stopFile = stopFile;
    this.runId = runId;
    this.now = now;
    this.logger = logger;
    this.retryOptions = {
      maxAttempts: 3,
      initialDelayMs: 500,
      maxDelayMs: 10000,
      jitterRatio: 0.1,
      ...retry,
    };
    this.heartbeatMs = heartbeatMs;
    this.ledgerPath = ledgerPath ?? path.join(path.dirname(queuePath), 'budget.ledger.jsonl');
    this.ledgerLockTimeoutMs = ledgerLockTimeoutMs;
    // 外部锚：独立文件、只追加 hash 链。随包之外（只读目录 / 外部 checkpoint）是本部署的降级说明。
    this.anchorPath = anchorPath ?? `${this.ledgerPath}.anchor.jsonl`;
    this.allowMissingAnchor = Boolean(allowMissingAnchor);
    this.reservationLeaseMs = reservationLeaseMs;
    this.ctx = ctx;
    this.agents = agents;
    this.agentOptions = agentOptions;
    this.agentSetup = agentSetup;
    this.sessionId = sessionId;

    this.queue = new TaskQueue({ file: queuePath, maxTasks: maxQueuedTasks, maxBytes: maxQueueBytes });
    this.memory = memoryPath ? new MemoryReader({ file: memoryPath }) : null;
    this.audit = new AuditLog({
      file: auditPath,
      runId,
      now,
      maxBytes: auditMaxBytes,
      maxRotations: auditMaxRotations,
    });
    this.ledger = new BudgetLedger({
      file: this.ledgerPath,
      runId,
      maxTokens,
      lockTimeoutMs: ledgerLockTimeoutMs,
      now,
      reservationLeaseMs,
    });
    this.anchor = new AnchorLog({ file: this.anchorPath, now });

    this.state = 'idle';
    this.busy = false;
    this.seen = new Set();
    this.tokensUsed = 0;
    this.reservedTokens = 0;
    this.ticks = 0;
    this.processed = 0;
    this.denied = 0;
    this.errors = 0;
    this.deadLettered = 0;
    this.consecutiveErrors = 0;
    this.stopReason = null;
    this.alreadyStopped = false;
    this.started = false;
    this.lastError = null;
    this.lastMessages = null;
    this.startup = null;

    this.#controller = new AbortController();
    this.#inflight = new Set();
    this.#reservations = new Map();
    this.#finalized = false;
    this.#finalResult = null;
    this.#auditBroken = false;
    this.#timerDispose = null;
    this.#disposed = false;
  }

  #controller;
  #inflight;
  #reservations;
  #finalized;
  #finalResult;
  #auditBroken;
  #timerDispose;
  #disposed;

  get signal() {
    return this.#controller.signal;
  }

  get budget() {
    return {
      maxTokens: this.maxTokens,
      callMaxTokens: this.callMaxTokens,
      tokensUsed: this.tokensUsed,
      reservedTokens: this.reservedTokens,
      remaining: Math.max(0, this.maxTokens - this.tokensUsed - this.reservedTokens),
    };
  }

  get auditBroken() {
    return this.#auditBroken;
  }

  /**
   * 启动：从账本恢复预算、续 seq、写 router.start。
   * 审计/账本损坏不 throw，返回 {ok:false, code}。
   */
  start() {
    if (this.#disposed) return { ok: false, code: 'E_DISPOSED', alreadyRunning: false, replayed: 0 };
    if (this.state === 'running' || this.state === 'stopping') {
      return { ok: true, alreadyRunning: true, replayed: 0, resumedTokens: this.tokensUsed + this.reservedTokens };
    }
    if (this.state === 'stopped') {
      return { ok: false, code: 'E_STOPPED', alreadyRunning: false, replayed: 0, state: this.state };
    }

    if (!this.provider || !this.model) {
      this.state = 'stopped';
      this.stopReason = 'no_provider';
      this.lastError = {
        code: 'E_NO_PROVIDER',
        message: `Router needs provider/model before start (provider=${String(this.provider)}, model=${String(this.model)})`,
      };
      return {
        ok: false,
        code: 'E_NO_PROVIDER',
        missing: [...(this.provider ? [] : ['provider']), ...(this.model ? [] : ['model'])],
        alreadyRunning: false,
        replayed: 0,
      };
    }

    // P0-2/P0-3：先修崩溃留下的半行尾，再回收「pid 已死 / 租约过期」的预留。
    // 这两步必须在读账本之前，否则半行尾会被当成 CORRUPT、死预留会占着预算。
    let repaired = { ok: true, repaired: false };
    let reclaimed = { released: 0, freedTokens: 0, items: [] };
    try {
      repaired = this.ledger.repairTail();
      reclaimed = this.ledger.reclaimDead({ now: Date.now() });
    } catch (error) {
      this.state = 'stopped';
      this.lastError = { code: error?.code ?? 'E_BUDGET_WRITE', message: error.message };
      this.stopReason = this.lastError.code === 'E_LEDGER_TAMPERED' ? 'ledger_tampered' : 'ledger_repair_failed';
      return {
        ok: false,
        code: this.lastError.code,
        message: error.message,
        chainBreaks: Array.isArray(error?.chainBreaks) ? error.chainBreaks.length : 0,
        alreadyRunning: false,
        replayed: 0,
      };
    }

    let read = {
      records: [],
      badLines: 0,
      unsigned: 0,
      truncated: 0,
      tamperedLines: 0,
      chainBreaks: [],
      badLineDetails: [],
    };
    try {
      read = readAudit(this.auditPath, { maxRotations: this.audit.maxRotations });
    } catch (error) {
      this.state = 'stopped';
      this.stopReason = 'audit_read_failed';
      this.lastError = { code: 'E_AUDIT_READ', message: error.message };
      return { ok: false, code: 'E_AUDIT_READ', message: error.message, alreadyRunning: false, replayed: 0 };
    }

    // P0-4：审计是证据链。整行删除 / seq 跳号 / hash 链断 = 篡改，fail-closed。
    // 无换行的半行尾是崩溃残留（truncated），不算篡改，交给账本对账兜底。
    const auditChainBreaks = read.chainBreaks?.length ?? 0;
    const auditTamperedLines = read.tamperedLines ?? 0;
    if (auditChainBreaks > 0 || auditTamperedLines > 0) {
      this.state = 'stopped';
      this.stopReason = 'ledger_tampered';
      this.lastError = {
        code: 'E_LEDGER_TAMPERED',
        message: `audit evidence chain is broken (${auditChainBreaks} chain break(s), ${auditTamperedLines} tampered line(s))`,
      };
      return {
        ok: false,
        code: 'E_LEDGER_TAMPERED',
        chainBreaks: auditChainBreaks,
        tamperedLines: auditTamperedLines,
        alreadyRunning: false,
        replayed: 0,
      };
    }

    let snapshot;
    try {
      snapshot = this.ledger.snapshot();
    } catch (error) {
      this.state = 'stopped';
      this.stopReason = 'ledger_read_failed';
      this.lastError = { code: 'E_BUDGET_READ', message: error.message };
      return { ok: false, code: 'E_BUDGET_READ', message: error.message, alreadyRunning: false, replayed: 0 };
    }
    if ((snapshot.chainBreaks?.length ?? 0) > 0) {
      this.state = 'stopped';
      this.stopReason = 'ledger_tampered';
      this.lastError = {
        code: 'E_LEDGER_TAMPERED',
        message: `budget ledger hash chain is broken (${snapshot.chainBreaks.length} break(s))`,
      };
      return {
        ok: false,
        code: 'E_LEDGER_TAMPERED',
        chainBreaks: snapshot.chainBreaks.length,
        alreadyRunning: false,
        replayed: 0,
      };
    }
    if (snapshot.badLines > 0) {
      this.state = 'stopped';
      this.stopReason = 'ledger_corrupt';
      this.lastError = { code: 'E_BUDGET_CORRUPT', message: `budget ledger has ${snapshot.badLines} bad record(s)` };
      return {
        ok: false,
        code: 'E_BUDGET_CORRUPT',
        badLines: snapshot.badLines,
        alreadyRunning: false,
        replayed: 0,
      };
    }

    const auditUsage = foldAuditUsage(read.records);
    let mismatch = null;
    let adopted = false;

    try {
      if (snapshot.records === 0) {
        // 只有旧审计（或根本没有历史）：先 fail-closed，再 bootstrap。
        if (read.badLines > 0) {
          this.state = 'stopped';
          this.stopReason = 'audit_corrupt';
          this.lastError = {
            code: 'E_AUDIT_CORRUPT',
            message: `audit has ${read.badLines} bad line(s) and no budget ledger to reconcile against`,
          };
          return {
            ok: false,
            code: 'E_AUDIT_CORRUPT',
            badLines: read.badLines,
            truncated: read.truncated,
            alreadyRunning: false,
            replayed: 0,
          };
        }
        if (auditUsage.used > 0) {
          const adopt = this.ledger.adopt({ used: auditUsage.used, reason: 'audit_bootstrap' });
          if (!adopt.ok) throw new Error(`budget ledger adopt failed: ${adopt.code}`);
          adopted = true;
        }
        snapshot = this.ledger.snapshot();
      } else if (auditUsage.settledUsed !== snapshot.used) {
        // 账本说花了 X、审计说花了 Y，且两者都在（不是 bootstrap）—— 必有一方被删/被改。
        // 这是 P0-4 的「账本/审计不一致 fail-closed」：不再只记 mismatch 继续跑。
        this.state = 'stopped';
        this.stopReason = 'ledger_tampered';
        this.lastError = {
          code: 'E_LEDGER_TAMPERED',
          message: `audit settles ${auditUsage.settledUsed} token(s) but ledger records ${snapshot.used}`,
        };
        return {
          ok: false,
          code: 'E_LEDGER_TAMPERED',
          auditUsed: auditUsage.settledUsed,
          ledgerUsed: snapshot.used,
          alreadyRunning: false,
          replayed: 0,
        };
      }
    } catch (error) {
      this.state = 'stopped';
      this.stopReason = 'ledger_init_failed';
      this.lastError = { code: error?.code ?? 'E_BUDGET_WRITE', message: error.message };
      return { ok: false, code: this.lastError.code, message: error.message, alreadyRunning: false, replayed: 0 };
    }

    // D：外部锚。账本和审计是两条可被「有写权限者」一起重算的 hash 链；
    // 锚是独立文件里的 checkpoint（只追加、带自己的 hash 链），跨进程/重启保留。
    // 单机边界：能同时改账本、审计和锚的攻击者仍可伪造，故生产应把锚放到只读目录/外部
    // checkpoint；这里给出 anchorPath 接线，并用「删锚 + 有历史」判 E_ANCHOR_MISSING。
    let anchorCheck = { ok: true, anchored: false, reason: 'no_anchor' };
    try {
      this.anchor.repairTail();
      anchorCheck = verifyAnchor(this.anchor.read().records, {
        ledgerRecords: readLedger(this.ledgerPath).records,
        ledgerState: snapshot,
        auditRecords: read.records,
        auditSettled: auditUsage.settledUsed,
        auditFile: this.auditPath,
      });
    } catch (error) {
      this.state = 'stopped';
      this.stopReason = 'anchor_read_failed';
      this.lastError = { code: error?.code ?? 'E_ANCHOR_READ', message: error.message };
      return { ok: false, code: this.lastError.code, message: error.message, alreadyRunning: false, replayed: 0 };
    }
    if (!anchorCheck.ok) {
      this.state = 'stopped';
      this.stopReason = 'ledger_tampered';
      this.lastError = {
        code: 'E_LEDGER_TAMPERED',
        message: `budget anchor mismatch (${anchorCheck.reason}): ledger/audit were rewritten outside the anchored prefix`,
      };
      return {
        ok: false,
        code: 'E_LEDGER_TAMPERED',
        anchorReason: anchorCheck.reason,
        alreadyRunning: false,
        replayed: 0,
      };
    }
    const hadRouterHistory = read.records.some((rec) => rec.kind === 'router.start');
    if (!anchorCheck.anchored && !this.allowMissingAnchor && hadRouterHistory) {
      this.state = 'stopped';
      this.stopReason = 'anchor_missing';
      this.lastError = {
        code: 'E_ANCHOR_MISSING',
        message: 'budget anchor file is missing although this directory has Router history (delete-anchor attack)',
      };
      return { ok: false, code: 'E_ANCHOR_MISSING', alreadyRunning: false, replayed: 0 };
    }

    const seen = new Set();
    for (const rec of read.records) {
      if (['action', 'action.denied', 'task.denied', 'task.error'].includes(rec.kind)
        && typeof rec.task_id === 'string') {
        seen.add(rec.task_id);
      }
    }
    this.seen = seen;
    this.tokensUsed = snapshot.used;
    this.reservedTokens = snapshot.reserved;
    this.startup = {
      adopted,
      auditBadLines: read.badLines,
      auditUnsigned: read.unsigned,
      mismatch,
      anchor: anchorCheck.anchored ? 'verified' : 'none',
      reclaimed: { released: reclaimed.released, freedTokens: reclaimed.freedTokens },
    };

    try {
      this.audit.open();
    } catch (error) {
      this.state = 'stopped';
      this.stopReason = 'audit_open_failed';
      this.lastError = { code: 'E_AUDIT_OPEN', message: error.message };
      return { ok: false, code: 'E_AUDIT_OPEN', message: error.message, alreadyRunning: false, replayed: 0 };
    }

    this.state = 'running';
    this.started = true;
    try {
      this.#emit('router.start', {
        resumed_tokens_used: snapshot.used,
        resumed_tokens_reserved: snapshot.reserved,
        max_tokens: this.maxTokens,
        call_max_tokens: this.callMaxTokens,
        replayed: seen.size,
        bad_lines: read.badLines,
        audit_unsigned: read.unsigned,
        ledger: this.ledgerPath,
        adopted_from_audit: adopted,
        reclaimed_reservations: reclaimed.released,
        provider: this.provider,
        model: this.model,
        anchor: anchorCheck.anchored ? 'verified' : 'none',
      });
      if (reclaimed.released > 0) {
        this.#emit('budget.reclaim', {
          released: reclaimed.released,
          freed_tokens: reclaimed.freedTokens,
          items: reclaimed.items.slice(0, 10),
          reason: 'startup',
        });
      }
      if (repaired.repaired) {
        // 半行尾修复也是证据：没有它，test「只删 start 的 repairTail」无法红。
        this.#emit('budget.repair', {
          file: this.ledgerPath,
          repaired: true,
          reason: 'startup_tail_repair',
        });
      }
      if (read.badLines > 0) {
        this.#emit('audit.corrupt', {
          bad_lines: read.badLines,
          truncated: read.truncated,
          items: read.badLineDetails.slice(0, 5),
        });
      }
      if (mismatch) this.#emit('audit.replay_mismatch', mismatch);
      // 启动即打一个 checkpoint：锚缺失时也能从第一次运行起留下外部证据。
      this.#sealAnchor();
    } catch (error) {
      return this.#failSafe(error);
    }
    this.#installTimer();
    return {
      ok: true,
      alreadyRunning: false,
      replayed: seen.size,
      resumedTokens: snapshot.used + snapshot.reserved,
      tokensUsed: snapshot.used,
      reservedTokens: snapshot.reserved,
      badLines: read.badLines,
      adopted,
      anchor: anchorCheck.anchored ? 'verified' : 'none',
      reclaimed,
    };
  }

  /**
   * 跑一个 tick。永不 reject：任何内部异常都转成 fail-safe 结果。
   * 并发调用只让第一个跑，其余立即 E_BUSY。
   */
  async tick() {
    if (this.state !== 'running') {
      return {
        ok: false,
        code: 'E_NOT_RUNNING',
        state: this.state,
        processed: 0,
        denied: 0,
        errors: 0,
        tokensUsed: this.tokensUsed,
      };
    }
    if (this.stopFile && fs.existsSync(this.stopFile)) {
      const stopped = await this.stop('stop_file');
      return {
        ok: true,
        stop: 'stop_file',
        state: this.state,
        auditBroken: stopped.ok === false,
        processed: 0,
        denied: 0,
        errors: 0,
        tokensUsed: this.tokensUsed,
      };
    }
    if (this.busy) {
      return {
        ok: false,
        code: 'E_BUSY',
        state: this.state,
        processed: 0,
        denied: 0,
        errors: 0,
        tokensUsed: this.tokensUsed,
      };
    }

    this.busy = true;
    const controller = new AbortController();
    const unlink = this.#linkAbort(this.#controller.signal, controller);
    const tickNo = this.ticks + 1;
    const promise = this.#runTick(tickNo, controller.signal);
    this.#inflight.add(promise);
    let result;
    try {
      result = await promise;
    } catch (error) {
      result = this.#failSafe(error);
    } finally {
      this.#inflight.delete(promise);
      this.busy = false;
      unlink();
      if (this.state === 'stopping' && this.#inflight.size === 0) {
        await this.#finalizeStop();
      }
    }
    return result;
  }

  async #runTick(tickNo, signal) {
    this.ticks = tickNo;
    const res = {
      ok: true,
      tick: tickNo,
      processed: 0,
      denied: 0,
      errors: 0,
      stop: false,
      tokensUsed: this.tokensUsed,
    };

    if (tickNo > this.maxTicks) {
      this.#beginStop('max_ticks');
      return { ...res, stop: 'max_ticks', tokensUsed: this.tokensUsed };
    }

    // P0-2：长驻进程也要回收——上一个 tick 崩溃的兄弟进程留下的预留不能一直占着预算。
    this.#reclaimDeadReservations();

    this.#emit('tick.start', {
      tick: tickNo,
      tokens_used: this.tokensUsed,
      tokens_reserved: this.reservedTokens,
      tokens_remaining: Math.max(0, this.maxTokens - this.tokensUsed - this.reservedTokens),
    });

    const memory = this.memory?.read() ?? { source: 'none', facts: [], error: null };
    this.#emit('memory.read', {
      source: memory.source,
      facts: Array.isArray(memory.facts) ? memory.facts.length : 0,
      error: memory.error ?? null,
    });

    const pending = this.queue.pending(this.seen);
    if (pending.invalid.length > 0) {
      this.#emit('queue.invalid', { count: pending.invalid.length, items: pending.invalid.slice(0, 5) });
    }
    if (pending.duplicates.length > 0) {
      this.#emit('queue.duplicates', { count: pending.duplicates.length });
    }
    if (pending.capacity?.full) {
      this.#emit('queue.full', pending.capacity);
    }

    const tasks = pending.tasks.slice(0, this.maxTasksPerTick);
    if (tasks.length === 0) {
      this.#emit('tick.idle', { tick: tickNo });
      return { ...res, tokensUsed: this.tokensUsed };
    }

    for (const task of tasks) {
      if (signal?.aborted) {
        res.stop = 'aborted';
        break;
      }
      if (this.seen.has(task.id)) continue;

      if (isRecursiveTask(task)) {
        this.denied += 1;
        res.denied += 1;
        this.seen.add(task.id);
        this.#emit('task.denied', {
          task_id: task.id,
          reason: 'recursion',
          origin: task.origin ?? null,
          depth: task.depth ?? 0,
        });
        continue;
      }

      const reservation = this.#reserveBudget(task, tickNo);
      if (!reservation.ok) {
        res.ok = false;
        res.stop = reservation.stop;
        res.code = 'E_BUDGET_EXCEEDED';
        break;
      }

      let call;
      try {
        call = await this.#callModel(task, reservation.reserved, memory, signal);
      } catch (error) {
        this.#releaseReservation(reservation);
        throw error;
      }

      const settled = this.#settleBudget(task, reservation, call);
      if (settled.stop) {
        res.stop = settled.stop;
        if (settled.code) res.code = settled.code;
        break;
      }

      if (call.aborted) {
        this.#beginStop('aborted');
        res.stop = 'aborted';
        break;
      }

      if (!call.ok) {
        this.errors += 1;
        res.errors += 1;
        this.consecutiveErrors += 1;
        this.seen.add(task.id);
        this.#emit('task.error', {
          task_id: task.id,
          code: call.failure?.code ?? 'E_LLM',
          message: call.failure?.message ?? 'llm call failed',
          attempts: call.attempts ?? 0,
        });
        if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
          this.#beginStop('error_streak');
          res.stop = 'error_streak';
          break;
        }
        continue;
      }

      this.consecutiveErrors = 0;
      const action = parseAction(call.text) ?? { type: 'noop' };
      const type = action?.type;

      if (recursiveAction(type)) {
        this.denied += 1;
        res.denied += 1;
        this.seen.add(task.id);
        this.#emit('action.denied', {
          task_id: task.id,
          reason: 'recursion',
          action,
        });
        continue;
      }

      if (!DEFAULT_ALLOWED_ACTIONS.includes(type)) {
        this.denied += 1;
        res.denied += 1;
        this.seen.add(task.id);
        this.#emit('action.denied', {
          task_id: task.id,
          reason: 'action_not_allowed',
          action,
        });
        continue;
      }

      this.processed += 1;
      res.processed += 1;
      this.seen.add(task.id);
      this.#emit('action', {
        task_id: task.id,
        action,
        attempts: call.attempts ?? 1,
        usage: call.usage ?? null,
        text: typeof call.text === 'string' ? call.text.slice(0, 500) : '',
      });
    }

    res.tokensUsed = this.tokensUsed;
    if (!res.stop && this.state === 'stopping') res.stop = this.stopReason ?? 'stopping';
    return res;
  }

  #reserveBudget(task, tickNo) {
    // B：预留必须覆盖整条重试链，否则第 2 次 attempt 的 30 会因为「只预留 30」被 clamp。
    const maxAttempts = Math.max(1, Number(this.retryOptions.maxAttempts) || 1);
    const reservedTokens = this.callMaxTokens * maxAttempts;
    let result;
    try {
      result = this.ledger.reserve({
        taskId: task.id,
        tokens: reservedTokens,
        owner: this.runId,
        tick: tickNo,
        leaseMs: this.reservationLeaseMs,
      });
    } catch (error) {
      throw error;
    }

    if (!result.ok) {
      this.#emit('budget.exceeded', {
        task_id: task.id,
        needed: reservedTokens,
        remaining: result.remaining,
        tokens_used: result.used,
        tokens_reserved: result.reserved,
        call_max_tokens: this.callMaxTokens,
        max_attempts: maxAttempts,
      });
      this.#beginStop('budget_exceeded');
      return { ok: false, stop: 'budget_exceeded' };
    }

    this.tokensUsed = result.used;
    this.reservedTokens = result.reserved;
    const reservation = {
      id: result.id,
      reserved: reservedTokens,
      taskId: task.id,
      settled: false,
    };
    this.#reservations.set(reservation.id, reservation);

    try {
      this.#emit('budget.reserve', {
        tick: tickNo,
        task_id: task.id,
        reservation_id: reservation.id,
        budgetReserved: reservation.reserved,
        tokens_used: result.used,
        tokens_remaining: result.remaining,
        tokens_reserved: result.reserved,
        call_max_tokens: this.callMaxTokens,
        max_attempts: maxAttempts,
      });
    } catch (error) {
      this.#releaseReservation(reservation);
      throw error;
    }
    return { ok: true, ...reservation };
  }

  #settleBudget(task, reservation, call) {
    const usage = call?.usage ?? null;
    const rawTotal = usage?.totalTokens;
    // 缺失 usage 按 0 处理；任何字段负数 / NaN / Infinity 都视为协议错误（F4/F12）。
    // attempt 级 invalid（retry 累加时发现某次是 NaN/-20）也 fail-closed。
    let fieldsValid = true;
    if (usage !== null) {
      if (typeof usage !== 'object' || usage.invalid) {
        fieldsValid = false;
      } else {
        for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) {
          const value = usage[field];
          if (value === undefined || value === null) continue;
          if (!Number.isFinite(Number(value)) || Number(value) < 0) fieldsValid = false;
        }
      }
    }
    const usageValid = usage === null ? true : (fieldsValid && !call?.invalidUsage);
    // F5：重试链上「前一次合法花费」必须入账。retryOnFailure 已把非法 attempt 整次剔除、
    // 且累计值单调不减，所以 invalidUsage 时 usage 里只剩已确认的合法用量（单次 NaN/-5 → 0）。
    const accumulatedValid = usage !== null && Number.isFinite(Number(rawTotal)) && Number(rawTotal) >= 0;
    const requested = usage === null ? 0 : (usageValid || call?.invalidUsage) && accumulatedValid ? Number(rawTotal) : 0;

    // P0-1：settle 只记「预留内且不超硬上限」的部分。多出来的 token 拒绝入账，
    // 但必须留下审计（requested/rejected），并让 Router 停下——不能像旧版那样先记 120 再报 overshoot。
    let snapshot;
    try {
      snapshot = this.ledger.settle({ id: reservation.id, tokens: requested });
    } catch (error) {
      this.#releaseReservation(reservation);
      throw error;
    }
    reservation.settled = true;
    this.#reservations.delete(reservation.id);

    if (snapshot.ok === false && snapshot.code === 'E_BUDGET_UNKNOWN_RESERVATION') {
      this.lastError = {
        code: snapshot.code,
        message: `reservation ${reservation.id} is not active in the budget ledger`,
      };
      this.#emit('budget.settle_failed', {
        task_id: task.id,
        reservation_id: reservation.id,
        code: snapshot.code,
      });
      this.#beginStop('ledger_unknown_reservation');
      return { stop: 'ledger_unknown_reservation', code: snapshot.code };
    }

    const applied = Number.isFinite(snapshot.applied) ? snapshot.applied : requested;
    const rejected = Number.isFinite(snapshot.rejected) ? snapshot.rejected : 0;
    this.tokensUsed = snapshot.used;
    this.reservedTokens = snapshot.reserved;

    this.#emit('budget.settle', {
      task_id: task.id,
      reservation_id: reservation.id,
      budgetReserved: reservation.reserved,
      actual_tokens: applied,
      requested_tokens: requested,
      rejected_tokens: rejected,
      usage,
      usage_valid: usageValid,
      tokens_total: this.tokensUsed,
      tokens_used: this.tokensUsed,
    });
    // settle 之后立刻把「账本+审计到哪了」钉进锚，崩溃也不会留下无锚窗口。
    this.#sealAnchor();

    if (!usageValid) {
      this.#emit('budget.usage_invalid', {
        task_id: task.id,
        code: 'E_USAGE_INVALID',
        usage,
        applied_tokens: applied,
      });
      this.lastError = { code: 'E_USAGE_INVALID', message: 'llm returned a negative or non-finite usage' };
      this.#deadLetter(task, { reason: 'usage_invalid', code: 'E_USAGE_INVALID', tokens: applied });
      this.#beginStop('usage_invalid');
      return { stop: 'usage_invalid' };
    }

    if (snapshot.ok === false && snapshot.code === 'E_BUDGET_OVERSHOOT') {
      this.lastError = {
        code: snapshot.code,
        message: `usage ${requested} exceeded the reservation (${reservation.reserved}) or the hard cap; ${rejected} token(s) rejected`,
      };
      this.#emit('budget.overshoot', {
        task_id: task.id,
        budgetReserved: reservation.reserved,
        actual_tokens: requested,
        applied_tokens: applied,
        rejected_tokens: rejected,
        tokens_total: this.tokensUsed,
      });
      // C：停机前落死信，重启后这条任务不会再被当成未处理而重跑一遍。
      this.#deadLetter(task, { reason: 'budget_overshoot', code: 'E_BUDGET_OVERSHOOT', tokens: applied });
      this.#beginStop('budget_overshoot');
      return { stop: 'budget_overshoot', code: 'E_BUDGET_OVERSHOOT' };
    }

    if (call?.attemptOverflow) {
      // B：单次 attempt 超过 callMaxTokens 是硬边界，即使总额还在整段预留内也必须 fail 任务。
      this.lastError = {
        code: 'E_USAGE_OVER_CALL_MAX',
        message: `a single attempt reported more than callMaxTokens (${this.callMaxTokens}); task failed after billing ${applied}`,
      };
      this.#emit('budget.attempt_overflow', {
        task_id: task.id,
        call_max_tokens: this.callMaxTokens,
        actual_tokens: applied,
        requested_tokens: requested,
        tokens_total: this.tokensUsed,
      });
      this.#deadLetter(task, { reason: 'attempt_usage_overflow', code: 'E_USAGE_OVER_CALL_MAX', tokens: applied });
      this.#beginStop('usage_overflow');
      return { stop: 'usage_overflow', code: 'E_USAGE_OVER_CALL_MAX' };
    }

    if (call?.stopReason) {
      if (call.failure && ['NO_ADAPTER', 'MISSING_CREDENTIAL'].includes(call.failure.code)) {
        this.#emit('llm.diagnostic', {
          task_id: task.id,
          code: call.failure.code,
          message: call.failure.message,
          provider: this.provider,
          model: this.model,
        });
      }
      this.#emit('llm.stop', {
        task_id: task.id,
        code: call.failure?.code ?? null,
        stop_reason: call.stopReason,
      });
      this.#beginStop(call.stopReason);
      return { stop: call.stopReason };
    }
    return {};
  }

  /**
   * C：停机路径上的任务必须落死信（seen），否则重启后同一条任务会被重新调度、
   * 再花一遍钱。审计里的 task.error 就是重启时的 seen 来源。
   */
  #deadLetter(task, { reason, code, tokens = 0 }) {
    if (!task || typeof task.id !== 'string') return;
    if (this.seen.has(task.id)) return;
    this.seen.add(task.id);
    this.deadLettered += 1;
    this.#emit('task.error', {
      task_id: task.id,
      code,
      message: `task dead-lettered: ${reason}; it will not be retried after restart`,
      reason,
      dead_letter: true,
      tokens: Number.isFinite(tokens) ? tokens : 0,
    });
  }

  /** 把当前账本/审计位置钉进独立锚文件（D）。 */
  #sealAnchor() {
    const snapshot = this.ledger.snapshot();
    const auditRead = readAudit(this.auditPath, { maxRotations: this.audit.maxRotations });
    const last = auditRead.records[auditRead.records.length - 1] ?? null;
    const usage = foldAuditUsage(auditRead.records);
    return this.anchor.seal({
      ledger: {
        seq: snapshot.seq,
        lastHash: snapshot.lastHash,
        used: snapshot.used,
        reserved: snapshot.reserved,
      },
      audit: {
        file: this.auditPath,
        seq: last?.seq ?? 0,
        lastHash: last?.hash ?? null,
        settledUsed: usage.settledUsed,
        records: auditRead.records.length,
      },
    });
  }

  #releaseReservation(reservation) {
    if (!reservation || reservation.settled) return;
    reservation.settled = true;
    this.#reservations.delete(reservation.id);
    try {
      const snapshot = this.ledger.release({ id: reservation.id });
      this.tokensUsed = snapshot.used;
      this.reservedTokens = snapshot.reserved;
    } catch {
      // 账本写失败时不要报一个假的“已释放”；tick 会走 fail-safe 停下。
    }
  }

  /**
   * P0-2：回收「pid 已死」或「租约过期」的 active 预留。
   * 每个 tick 都跑一次——长驻 Router 也要能接管兄弟进程崩溃后留下的预算。
   * 账本链被篡改时向上抛（fail-closed）；其它账本 IO 错误不阻断本次 tick。
   */
  #reclaimDeadReservations() {
    let snapshot;
    try {
      snapshot = this.ledger.reclaimDead({ now: Date.now() });
    } catch (error) {
      if (error?.code === 'E_LEDGER_TAMPERED') throw error;
      return null;
    }
    if (snapshot.released > 0) {
      this.tokensUsed = snapshot.used;
      this.reservedTokens = snapshot.reserved;
      this.#emit('budget.reclaim', {
        released: snapshot.released,
        freed_tokens: snapshot.freedTokens,
        items: snapshot.items.slice(0, 10),
        reason: 'tick',
      });
    }
    return snapshot;
  }

  async #callModel(task, reserved, memory, signal) {
    const system = memoryToSystemPrompt(memory.facts ?? []);
    const prompt = `Task ${task.id} (${task.type})\n${JSON.stringify(task.payload ?? {})}`;
    const messages = buildMessages({ system, prompt });
    this.lastMessages = messages;

    const result = await retryOnFailure(
      (attempt) => this.#callOnce({ task, reserved, messages, signal, attempt }),
      {
        ...this.retryOptions,
        signal,
        onRetry: ({ attempt, code, delayMs }) => {
          this.#emit('llm.retry', {
            task_id: task.id,
            attempt,
            code,
            delay_ms: delayMs,
          });
        },
      },
    );

    if (result.invalidUsage) {
      return {
        ok: false,
        aborted: false,
        invalidUsage: true,
        failure: null,
        usage: result.usage ?? null,
        attempts: result.attempts,
        attemptOverflow: result.attemptOverflow === true,
      };
    }
    if (result.aborted) {
      return {
        ok: false,
        aborted: true,
        failure: result.failure,
        usage: result.usage ?? result.result?.usage,
        attempts: result.attempts,
        attemptOverflow: result.attemptOverflow === true,
      };
    }
    if (result.failure) {
      return {
        ok: false,
        aborted: false,
        failure: result.failure,
        usage: result.usage ?? result.result?.usage,
        attempts: result.attempts,
        attemptOverflow: result.attemptOverflow === true,
        stopReason: result.stopReason,
      };
    }
    return {
      ok: true,
      text: result.text,
      usage: result.usage,
      finish: result.finish,
      attempts: result.attempts,
      attemptOverflow: result.attemptOverflow === true,
    };
  }

  async #callOnce({ task, reserved, messages, signal, attempt }) {
    const callController = new AbortController();
    const unlink = this.#linkAbort(signal, callController);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      callController.abort('timeout');
    }, this.callTimeoutMs);
    timer.unref?.();

    try {
      // 真宿主（dsh-llm README:50-57）要求 provider + model；缺了就是 NO_ADAPTER。
      const stream = this.llm.stream({
        provider: this.provider,
        model: this.model,
        messages,
        task,
        signal: callController.signal,
        // 单次调用只允许 callMaxTokens；整段预留覆盖 maxAttempts 次，不能让一次 attempt 吃掉全部。
        maxTokens: this.callMaxTokens,
        attempt,
      });
      const result = await consumeStream(stream, {
        signal: callController.signal,
        returnTimeoutMs: Math.max(50, Math.min(this.callTimeoutMs, 200)),
      });
      const withOverflow = (r) => {
        const total = Number(r?.usage?.totalTokens);
        return { ...r, attemptOverflow: Number.isFinite(total) && total > this.callMaxTokens };
      };
      if (timedOut && !result.finished && !signal?.aborted) {
        return withOverflow({
          failure: { code: 'TIMEOUT', message: `llm call timed out after ${this.callTimeoutMs}ms` },
          usage: result.usage,
          aborted: false,
          result,
        });
      }
      return withOverflow(result);
    } finally {
      clearTimeout(timer);
      unlink();
    }
  }

  /**
   * 停止：先 abort，再等在飞 tick 到边界（带超时），超时强制释放预留，最后关审计。
   * 幂等；router.stop 写不进去时返回 ok:false + E_AUDIT_WRITE。
   */
  async stop(reason = 'manual') {
    if (this.state === 'stopped' || this.#disposed) {
      return {
        ok: true,
        alreadyStopped: true,
        state: this.state,
        stopReason: this.stopReason,
        processed: this.processed,
        denied: this.denied,
        errors: this.errors,
        tokensUsed: this.tokensUsed,
      };
    }
    const wasStopping = this.state === 'stopping';
    this.#beginStop(reason);
    const timedOut = await this.#awaitInflight(this.stopTimeoutMs);
    let released = 0;
    if (timedOut) {
      try {
        const snapshot = this.ledger.releaseOwner({ owner: this.runId });
        released = snapshot.released;
        this.tokensUsed = snapshot.used;
        this.reservedTokens = snapshot.reserved;
      } catch (error) {
        this.lastError = { code: error?.code ?? 'E_BUDGET_WRITE', message: error.message };
      }
      for (const reservation of this.#reservations.values()) reservation.settled = true;
      this.#reservations.clear();
      // 僵尸 tick 不再阻塞 busy，也不再占着 stop() 的返回值。
      this.busy = false;
      try {
        this.audit.append('stop.timeout', { ms: this.stopTimeoutMs, released });
      } catch {
        this.#auditBroken = true;
      }
    }
    const finalized = await this.#finalizeStop();
    return {
      ok: finalized.ok,
      code: finalized.code,
      alreadyStopped: wasStopping,
      state: this.state,
      stopReason: this.stopReason,
      timedOut,
      released,
      auditBroken: this.#auditBroken,
      processed: this.processed,
      denied: this.denied,
      errors: this.errors,
      tokensUsed: this.tokensUsed,
    };
  }

  async dispose() {
    if (this.#disposed) return { ok: true, alreadyDisposed: true };
    let stop = null;
    if (this.started && this.state !== 'stopped') {
      stop = await this.stop('dispose');
    } else {
      this.#timerDispose?.();
      this.#timerDispose = null;
      try { this.audit.close(); } catch { /* best effort */ }
      this.state = 'disposed';
    }
    try { this.ledger.releaseOwner({ owner: this.runId }); } catch { /* best effort */ }
    this.#disposed = true;
    this.state = 'disposed';
    return { ok: true, alreadyDisposed: false, stop };
  }

  /** 需要真实 agent 路径时显式调用；Router 的普通 tick 不隐式创建 agent。 */
  async runInAgent(task, { prompt = null, setup = null, timeoutMs = 5000 } = {}) {
    if (!this.agents) {
      return { ok: false, code: 'E_NO_AGENTS', message: 'Router was constructed without ctx.agents' };
    }
    return runAgentTask({
      agents: this.agents,
      prompt: prompt ?? `Task ${task.id} (${task.type})\n${JSON.stringify(task.payload ?? {})}`,
      setup: setup ?? this.agentSetup,
      agentOptions: this.agentOptions,
      sessionId: this.sessionId ?? `${this.runId}-${task.id}`,
      signal: this.#controller.signal,
      timeoutMs,
    });
  }

  result() {
    return {
      ok: this.state === 'running',
      state: this.state,
      runId: this.runId,
      stop: this.stopReason,
      tick: this.ticks,
      processed: this.processed,
      denied: this.denied,
      errors: this.errors,
      tokensUsed: this.tokensUsed,
      busy: this.busy,
      budget: this.budget,
      lastError: this.lastError,
      auditBroken: this.#auditBroken,
      provider: this.provider,
      model: this.model,
    };
  }

  modelessResult() {
    return this.result();
  }

  #linkAbort(parent, target) {
    if (parent.aborted) {
      target.abort(parent.reason);
      return () => {};
    }
    const onAbort = () => target.abort(parent.reason);
    parent.addEventListener('abort', onAbort, { once: true });
    return () => parent.removeEventListener('abort', onAbort);
  }

  #beginStop(reason) {
    if (this.state === 'stopped') return;
    if (!this.stopReason) this.stopReason = reason;
    if (this.state === 'running') this.state = 'stopping';
    this.#controller.abort(reason);
  }

  async #awaitInflight(timeoutMs) {
    if (this.#inflight.size === 0) return false;
    let timedOut = false;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
      // E：这里绝不能 unref。裸进程中唯一的 ref 可能就是这颗定时器；
      // unref 之后 event loop 会提前退出，race 永远等不到 resolve（旧实现会挂住）。
    });
    await Promise.race([Promise.allSettled([...this.#inflight]), timeout]);
    clearTimeout(timer);
    return timedOut;
  }

  async #finalizeStop() {
    if (this.#finalized) return this.#finalResult ?? { ok: true };
    this.#finalized = true;
    this.state = 'stopped';
    this.alreadyStopped = true;
    let ok = true;
    let code;
    if (this.started) {
      try {
        this.audit.append('router.stop', {
          reason: this.stopReason,
          processed: this.processed,
          denied: this.denied,
          errors: this.errors,
          tokens_used: this.tokensUsed,
        });
      } catch (error) {
        // P12：stop 都写不进审计时不能 ok:true。状态仍然是 stopped。
        this.#auditBroken = true;
        ok = false;
        code = 'E_AUDIT_WRITE';
        this.lastError = { code, message: `cannot append router.stop: ${error.message}` };
      }
      if (ok) {
        try {
          // 停机封口：最后一次 checkpoint 覆盖 router.stop，重启时从锚校验整段历史。
          this.#sealAnchor();
        } catch (error) {
          ok = false;
          code = error?.code ?? 'E_ANCHOR_WRITE';
          this.lastError = { code, message: `cannot seal budget anchor: ${error.message}` };
        }
      }
    }
    try { this.audit.close(); } catch { /* best effort */ }
    this.#timerDispose?.();
    this.#timerDispose = null;
    this.#finalResult = { ok, code };
    return this.#finalResult;
  }

  #failSafe(error) {
    const code = error?.code ?? 'E_TICK';
    this.lastError = { code, message: error?.message ?? String(error) };
    this.#auditBroken = true;
    this.#beginStop(code === 'E_AUDIT_WRITE' ? 'audit_failed' : 'tick_crashed');
    this.state = 'stopped';
    try {
      const snapshot = this.ledger.releaseOwner({ owner: this.runId });
      this.tokensUsed = snapshot.used;
      this.reservedTokens = snapshot.reserved;
    } catch { /* ledger might itself be broken */ }
    this.#reservations.clear();
    this.busy = false;
    try { this.audit.close(); } catch { /* best effort */ }
    this.#timerDispose?.();
    this.#timerDispose = null;
    return {
      ok: false,
      code,
      message: this.lastError.message,
      state: this.state,
      stop: this.stopReason,
      processed: this.processed,
      denied: this.denied,
      errors: this.errors,
      tokensUsed: this.tokensUsed,
    };
  }

  #emit(kind, data = {}) {
    if (this.#auditBroken) {
      const error = new Error('audit is broken; refusing to continue without an evidence trail');
      error.code = 'E_AUDIT_WRITE';
      throw error;
    }
    try {
      this.audit.append(kind, data);
    } catch (cause) {
      this.#auditBroken = true;
      const error = new Error(`audit append failed: ${cause.message}`);
      error.code = 'E_AUDIT_WRITE';
      error.cause = cause;
      throw error;
    }
  }

  #installTimer() {
    if (!Number.isFinite(this.heartbeatMs) || this.heartbeatMs <= 0) return;
    let installed = null;
    const install = () => {
      const timer = setInterval(() => {
        if (this.state !== 'running') return;
        try {
          this.#emit('router.heartbeat', { tokensUsed: this.tokensUsed, tick: this.ticks });
        } catch (error) {
          this.#failSafe(error);
        }
      }, this.heartbeatMs);
      timer.unref?.();
      installed = () => clearInterval(timer);
      return installed;
    };
    try {
      if (typeof this.ctx?.effect === 'function') {
        // 宿主 effect 契约在不同版本里可能是「返回 disposer」或「调用 fn 并用其
        // 返回值做清理」；两条都接住，避免定时器泄漏。
        const ret = this.ctx.effect(install);
        this.#timerDispose = typeof ret === 'function' ? ret : installed;
        if (!this.#timerDispose) this.#timerDispose = install();
      } else {
        this.#timerDispose = install();
      }
    } catch (error) {
      this.#failSafe(error);
    }
  }
}
