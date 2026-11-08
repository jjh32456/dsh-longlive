// status.json（DESIGN §3.3 / §9.2，v2）。
//
// 只读投影：provider 只给两个布尔（绝不吐端点/凭据），model 只给
// {auto,resolved,resolvedAt}，提案对象不含正文。warnings 是开放枚举：
// 已知码给文案，未知码原样保留并计入 warnings.length。
//
// 写盘 tmp + fsync + rename + 读回校验，失败不阻塞 tick。

import fs from 'node:fs';
import path from 'node:path';

export const STATUS_VERSION = 2;
export const STATUS_MAX_BYTES = 16 * 1024;
export const STATUS_QUEUE_MAX_BYTES = 2 * 1024;
export const STATUS_WARNING_LIMIT = 8;

// 已知告警码 -> {severity, message}。开放枚举：不在这里的码也允许出现。
export const WARNING_CATALOG = Object.freeze({
  BOARD_STALE: { severity: 'warn', message: '看板数据已过期。' },
  BOARD_TRUNCATED: { severity: 'warn', message: '看板内容被截断。' },
  BOARD_RESET: { severity: 'warn', message: '看板已重置或无法读取。' },
  FOCUS_LIMITED: { severity: 'warn', message: 'focus 数量超过上限。' },
  LIVE_ROWS_SATURATED: { severity: 'warn', message: 'live 注册表行数已达上限。' },
  LIVE_UNREADABLE: { severity: 'warn', message: 'live 注册表无法读取。' },
  WAL_BROKEN: { severity: 'error', message: 'WAL 损坏，需要恢复。' },
  RESTORE_REQUIRED: { severity: 'warn', message: '检测到需要恢复的状态。' },
  RESTORE_FAILED: { severity: 'error', message: '状态恢复失败。' },
  OWNER_WRITE_RACE: { severity: 'error', message: '检测到所有者写入竞争。' },
  QUEUE_STARVATION: { severity: 'warn', message: '提案队列出现饥饿。' },
  BLOCKED_ON_USER_EXPIRED: { severity: 'warn', message: '等待用户的提案已过期。' },
  WAKE_QUOTA: { severity: 'warn', message: '唤醒额度已用完。' },
  WAKE_DEGRADED: { severity: 'warn', message: '唤醒已降级。' },
  INJECT_QUOTA: { severity: 'warn', message: '注入额度已用完。' },
  TICK_RECLAIM_BUSY: { severity: 'warn', message: 'tick 回收繁忙。' },
});

export const KNOWN_WARNING_CODES = Object.freeze(Object.keys(WARNING_CATALOG));

const SEVERITY_RANK = Object.freeze({ error: 0, warn: 1, info: 2 });

export function truncateText(value, maxChars) {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= maxChars) return text;
  return `${Array.from(text).slice(0, Math.max(0, maxChars - 1)).join('')}…`;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteInt(value) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function isoOrNull(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'string') return value;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function cleanCode(value) {
  return truncateText(String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim(), 64);
}

function normalizeWarningCode(raw) {
  const code = cleanCode(raw);
  if (!code) return '';
  // 已知码统一大写；未知码原样保留（只去控制符）。
  return WARNING_CATALOG[code.toUpperCase()] ? code.toUpperCase() : code;
}

function warningSeverity(code) {
  return WARNING_CATALOG[code.toUpperCase()]?.severity ?? 'warn';
}

function warningMessage(code) {
  return WARNING_CATALOG[code.toUpperCase()]?.message ?? `未登记的告警码：${code}`;
}

/** 归一化 warnings：去控制符、去重、稳定排序、≤8；空数组不是 null。 */
export function normalizeWarnings(list, extra = []) {
  const codes = [];
  for (const item of [...(Array.isArray(list) ? list : []), ...(Array.isArray(extra) ? extra : [])]) {
    const code = normalizeWarningCode(item);
    if (code && !codes.includes(code)) codes.push(code);
  }
  codes.sort((a, b) => {
    const rank = (SEVERITY_RANK[warningSeverity(a)] ?? 9) - (SEVERITY_RANK[warningSeverity(b)] ?? 9);
    return rank !== 0 ? rank : a.localeCompare(b);
  });
  return codes.slice(0, STATUS_WARNING_LIMIT);
}

function normalizeAlerts(input, warnings) {
  const byCode = new Map();
  const add = (codeRaw, severityRaw, messageRaw) => {
    const code = cleanCode(codeRaw);
    if (!code) return;
    const severity = severityRaw === 'error' || severityRaw === 'info' ? severityRaw : 'warn';
    const existing = byCode.get(code);
    const candidate = {
      code,
      severity,
      message: truncateText(String(messageRaw ?? warningMessage(code)), 300),
    };
    if (!existing) {
      byCode.set(code, candidate);
      return;
    }
    // 同 code 保留更严重的一条；同严重度保留先到的。
    if ((SEVERITY_RANK[severity] ?? 9) < (SEVERITY_RANK[existing.severity] ?? 9)) byCode.set(code, candidate);
  };

  for (const alert of Array.isArray(input.alerts) ? input.alerts : []) {
    if (!isObject(alert)) continue;
    add(alert.code, alert.severity, alert.message);
  }
  for (const code of warnings) {
    if (!byCode.has(code)) add(code, warningSeverity(code), warningMessage(code));
  }

  return [...byCode.values()]
    .sort((a, b) => {
      const rank = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
      return rank !== 0 ? rank : a.code.localeCompare(b.code);
    })
    .slice(0, 8);
}

function buildWarnings(input) {
  const raw = Array.isArray(input.warnings) ? input.warnings : [];
  const fromErrors = (Array.isArray(input.alerts) ? input.alerts : [])
    .filter((alert) => isObject(alert) && alert.severity === 'error')
    .map((alert) => alert.code);
  return normalizeWarnings(raw, fromErrors);
}

function normalizeProvider(input) {
  const source = input.provider;
  let configured;
  let missing;
  if (isObject(source)) {
    configured = source.configured === true;
    missing = source.missing === true;
    if (source.configured === undefined && source.missing === undefined) configured = false;
  } else if (typeof source === 'string') {
    configured = source.trim() !== '';
    missing = !configured;
  } else {
    configured = false;
    missing = true;
  }
  // 只吐两个布尔，绝不带 id/端点/候选。等待 provider 时额外带退避计数，
  // 仅在该字段存在时出现，避免影响 running 状态的既有形状断言（D-WP5-4）。
  const out = { configured, missing: missing || !configured };
  if (isObject(source)) {
    if (Number.isInteger(source.waitAttempts) && source.waitAttempts > 0) {
      out.waitAttempts = source.waitAttempts;
    }
    if (typeof source.lastError === 'string' && source.lastError.trim() !== '') {
      out.lastError = truncateText(source.lastError.trim(), 200);
    }
    const nextRetryAt = isoOrNull(source.nextRetryAt);
    if (nextRetryAt) out.nextRetryAt = nextRetryAt;
  }
  return out;
}

function normalizeModel(input) {
  const source = input.model;
  if (isObject(source)) {
    return {
      auto: source.auto === true,
      resolved: typeof source.resolved === 'string' && source.resolved.trim() !== '' && source.resolved !== 'auto'
        ? source.resolved
        : null,
      resolvedAt: isoOrNull(source.resolvedAt),
    };
  }
  const text = typeof source === 'string' ? source.trim() : '';
  return {
    auto: text === 'auto',
    resolved: text !== '' && text !== 'auto' ? text : null,
    resolvedAt: text !== '' && text !== 'auto' ? isoOrNull(input.now) : null,
  };
}

function normalizeFocus(list) {
  return (Array.isArray(list) ? list : [])
    .filter(isObject)
    .slice(0, 8)
    .map((item) => ({
      sessionId: truncateText(String(item.sessionId ?? ''), 120),
      goal: truncateText(String(item.goal ?? ''), 200),
      lastAction: isObject(item.lastAction)
        ? {
          kind: truncateText(String(item.lastAction.kind ?? ''), 40),
          detail: truncateText(String(item.lastAction.detail ?? ''), 60),
          at: isoOrNull(item.lastAction.at),
        }
        : null,
      queuedCount: finiteInt(item.queuedCount),
      updatedAt: isoOrNull(item.updatedAt),
    }));
}

function normalizeBoard(input) {
  const board = isObject(input.board) ? input.board : {};
  const pulse = isObject(board.pulse) ? board.pulse : (isObject(input.pulse) ? input.pulse : {});
  const focus = normalizeFocus(board.focus);
  const unknownSessions = finiteInt(board.unknownSessions ?? pulse.unknownSessions ?? input.unknownSessions);
  return {
    seq: finiteInt(board.seq),
    generatedAt: isoOrNull(board.generatedAt),
    activeSessions: finiteInt(board.activeSessions ?? pulse.active),
    unknownSessions,
    focusVisible: finiteInt(board.focusVisible ?? focus.length),
    stale: board.stale === true,
    focus,
    pulse: {
      active: finiteInt(pulse.active ?? board.activeSessions),
      running: finiteInt(pulse.running),
      blocked: finiteInt(pulse.blocked),
      unknownSessions: finiteInt(pulse.unknownSessions ?? unknownSessions),
      queuedProposals: finiteInt(pulse.queuedProposals),
      approvedProposals: finiteInt(pulse.approvedProposals),
      blockedOnUser: finiteInt(pulse.blockedOnUser),
      readyProposals: finiteInt(pulse.readyProposals),
      lastApplyAt: isoOrNull(pulse.lastApplyAt),
      lease: isObject(pulse.lease) ? {
        active: pulse.lease.active === true,
        holder: pulse.lease.holder == null ? null : truncateText(String(pulse.lease.holder), 120),
        heldMs: finiteInt(pulse.lease.heldMs),
      } : null,
    },
  };
}

function normalizeProposals(input) {
  const proposals = isObject(input.proposals) ? input.proposals : {};
  const queue = isObject(proposals.queue) ? proposals.queue : {};
  const writer = isObject(queue.writer)
    ? {
      ticket: truncateText(String(queue.writer.ticket ?? ''), 64),
      proposalId: truncateText(String(queue.writer.proposalId ?? ''), 64),
      sessionId: truncateText(String(queue.writer.sessionId ?? ''), 120),
      since: isoOrNull(queue.writer.since),
    }
    : null;
  const blocked = (Array.isArray(queue.blocked) ? queue.blocked : [])
    .filter(isObject)
    .slice(0, 8)
    .map((item) => ({
      ticket: truncateText(String(item.ticket ?? ''), 64),
      reason: truncateText(String(item.reason ?? ''), 120),
      since: isoOrNull(item.since),
    }));
  return {
    doneToday: finiteInt(proposals.doneToday),
    conflicts: finiteInt(proposals.conflicts),
    superseded: finiteInt(proposals.superseded),
    pending: finiteInt(proposals.pending ?? proposals.counts?.pending),
    approved: finiteInt(proposals.approved ?? proposals.counts?.approved ?? proposals.counts?.queued),
    queue: {
      seqCounter: finiteInt(queue.seqCounter),
      depth: finiteInt(queue.depth),
      etaMs: finiteInt(queue.etaMs),
      starvation: queue.starvation === true,
      writer,
      blocked,
    },
  };
}

function normalizeLease(input) {
  const lease = isObject(input.lease) ? input.lease : {};
  return {
    active: lease.active === true,
    holder: lease.holder == null ? null : truncateText(String(lease.holder), 120),
    since: isoOrNull(lease.since),
    renewals: finiteInt(lease.renewals),
    expiresAt: isoOrNull(lease.expiresAt),
  };
}

function normalizeWal(input) {
  const wal = isObject(input.wal) ? input.wal : {};
  return {
    lastSeq: finiteInt(wal.lastSeq),
    lastAt: isoOrNull(wal.lastAt),
    bytes: finiteInt(wal.bytes),
    segments: finiteInt(wal.segments),
    broken: wal.broken === true,
  };
}

// WP1 任务要求把 live 注册表的只读摘要放进 status：rows 是当前行数，
// maxRows 是写侧上限（默认 128），unknown 是无 live 行的会话数。属于 §9
// 之外的 additive 字段；DESIGN 的 shared.liveRows/unknownSessions 仍保留。
function normalizeLive(input) {
  const live = isObject(input.live) ? input.live : {};
  const shared = isObject(input.shared) ? input.shared : {};
  const via = (value) => (typeof value === 'string' && value !== '' ? truncateText(value, 64) : null);
  const out = {
    rows: finiteInt(live.rows ?? shared.liveRows),
    maxRows: finiteInt(live.maxRows ?? input.liveMaxRows ?? 128),
    unknown: finiteInt(live.unknown ?? shared.unknownSessions),
  };
  // Additive WP2 diagnostics: only present when the caller actually reports
  // them, so a minimal status stays byte-identical to the v2 baseline.
  if (isObject(input.live)) {
    out.corrupt = finiteInt(live.corrupt);
    out.saturated = live.saturated === true;
    // Which host event shape actually drove the L1 write. null means "not
    // observed yet", never a silently assumed green channel.
    out.createdEventVia = via(live.createdEventVia ?? input.liveCreatedEventVia);
    out.turnEndEventVia = via(live.turnEndEventVia ?? input.liveTurnEndEventVia);
  } else {
    const createdEventVia = via(input.liveCreatedEventVia);
    if (createdEventVia) out.createdEventVia = createdEventVia;
    const turnEndEventVia = via(input.liveTurnEndEventVia);
    if (turnEndEventVia) out.turnEndEventVia = turnEndEventVia;
  }
  return out;
}

function normalizeShared(input) {
  const shared = isObject(input.shared) ? input.shared : {};
  return {
    hintTokensLast: finiteInt(shared.hintTokensLast),
    injectedTurns: finiteInt(shared.injectedTurns),
    injectedTokensToday: finiteInt(shared.injectedTokensToday),
    skipped: finiteInt(shared.skipped),
    readyProposals: finiteInt(shared.readyProposals),
    lastInjectAt: isoOrNull(shared.lastInjectAt),
    lastInjectSha256: typeof shared.lastInjectSha256 === 'string' && shared.lastInjectSha256 !== ''
      ? truncateText(shared.lastInjectSha256, 64)
      : null,
    liveRows: finiteInt(shared.liveRows),
    unknownSessions: finiteInt(shared.unknownSessions),
  };
}

function normalizeWake(input) {
  const wake = isObject(input.wake) ? input.wake : {};
  return {
    enabled: wake.enabled === true,
    lastAttemptAt: isoOrNull(wake.lastAttemptAt),
    lastError: wake.lastError == null ? null : truncateText(String(wake.lastError), 200),
    todayCount: finiteInt(wake.todayCount),
    cooldownRemainingMs: finiteInt(wake.cooldownRemainingMs),
  };
}

function normalizeLastError(input, now) {
  if (!isObject(input.lastError)) return null;
  return {
    code: cleanCode(input.lastError.code) || 'E_UNKNOWN',
    at: isoOrNull(input.lastError.at, now),
    message: truncateText(String(input.lastError.message ?? ''), 500),
  };
}

function normalizeLastReport(input, now) {
  if (!isObject(input.lastReport)) return null;
  return {
    at: isoOrNull(input.lastReport.at, now),
    summary: truncateText(String(input.lastReport.summary ?? ''), 200),
    next: truncateText(String(input.lastReport.next ?? ''), 300),
    waiting: truncateText(String(input.lastReport.waiting ?? ''), 300),
    degraded: input.lastReport.degraded === true,
  };
}

export function buildStatus(input = {}) {
  const now = isoOrNull(input.now, new Date().toISOString());
  const warnings = buildWarnings(input);
  const alerts = normalizeAlerts(input, warnings);
  // severity=error 的 alert 必须镜像进 warnings（若 8 条上限截掉了，优先补回）。
  for (const alert of alerts) {
    if (alert.severity === 'error' && !warnings.includes(alert.code)) {
      warnings.unshift(alert.code);
      if (warnings.length > STATUS_WARNING_LIMIT) warnings.length = STATUS_WARNING_LIMIT;
    }
  }

  const tickQueue = isObject(input.tickQueue)
    ? input.tickQueue
    : (isObject(input.queue) ? input.queue : {});
  const queue = isObject(input.queueStatus) ? input.queueStatus : {};
  const files = isObject(input.files) ? input.files : {};

  return {
    v: STATUS_VERSION,
    readOnly: true,
    state: String(input.state ?? 'stopped'),
    reason: input.reason === undefined || input.reason === null || input.reason === '' ? null : truncateText(String(input.reason), 200),
    since: isoOrNull(input.since, now),
    runId: truncateText(String(input.runId ?? ''), 120),
    provider: normalizeProvider(input),
    model: normalizeModel(input),
    autonomy: String(input.autonomy ?? 'report'),
    agentMode: input.agentMode === true,
    lastTickAt: isoOrNull(input.lastTickAt),
    nextTickAt: isoOrNull(input.nextTickAt),
    heartbeatAt: isoOrNull(input.heartbeatAt, now),
    today: {
      day: String(input.today?.day ?? ''),
      usedTokens: finiteInt(input.today?.usedTokens),
      reservedTokens: finiteInt(input.today?.reservedTokens),
      capTokens: finiteInt(input.today?.capTokens),
    },
    run: {
      usedTokens: finiteInt(input.run?.usedTokens),
      capTokens: finiteInt(input.run?.capTokens),
    },
    tickQueue: {
      pending: finiteInt(tickQueue.pending),
      invalid: finiteInt(tickQueue.invalid),
      oldestAgeMs: finiteInt(tickQueue.oldestAgeMs),
    },
    queue: {
      pending: finiteInt(queue.pending),
      queued: finiteInt(queue.queued),
      applying: finiteInt(queue.applying),
      blockedOnUser: finiteInt(queue.blockedOnUser),
      expired: finiteInt(queue.expired),
    },
    board: normalizeBoard(input),
    live: normalizeLive(input),
    proposals: normalizeProposals(input),
    lease: normalizeLease(input),
    wal: normalizeWal(input),
    shared: normalizeShared(input),
    wake: normalizeWake(input),
    warnings,
    alerts,
    lastError: normalizeLastError(input, now),
    lastReport: normalizeLastReport(input, now),
    files: {
      vault: String(files.vault ?? ''),
      board: String(files.board ?? ''),
      audit: String(files.audit ?? ''),
      ledger: String(files.ledger ?? ''),
      anchor: String(files.anchor ?? ''),
      outbox: String(files.outbox ?? ''),
    },
  };
}

function serialize(value) {
  return `${JSON.stringify(value)}\n`;
}

/** 超 16KB 时的收缩顺序：alerts（保 error）→ blocked → focus/report → 其余。 */
function shrinkStatus(status) {
  const next = structuredClone(status);
  next.alerts = next.alerts.filter((alert) => alert.severity === 'error').slice(0, 8);
  next.proposals.queue.blocked = next.proposals.queue.blocked.slice(0, 2);
  next.board.focus = next.board.focus.slice(0, 4);
  next.lastReport = next.lastReport ? { ...next.lastReport, summary: truncateText(next.lastReport.summary, 120) } : null;
  if (next.lastError) next.lastError.message = truncateText(next.lastError.message, 120);
  return next;
}

export function storageErrorCode(error) {
  const code = error?.code;
  if (code === 'ENOSPC' || code === 'EROFS' || code === 'EACCES' || code === 'EPERM') return 'E_STORAGE';
  return 'E_IO';
}

/**
 * @param {string} file
 * @param {object} statusOrInput
 * @returns {{ok:boolean,bytes?:number,error?:string}}
 */
export function writeStatus(file, statusOrInput) {
  if (typeof file !== 'string' || file.trim() === '') return { ok: false, error: 'E_STATUS_PATH' };
  let tmp = '';
  try {
    let value = statusOrInput && statusOrInput.v === STATUS_VERSION
      ? statusOrInput
      : buildStatus(statusOrInput);
    let text = serialize(value);
    if (Buffer.byteLength(text) > STATUS_MAX_BYTES) {
      value = shrinkStatus(value);
      text = serialize(value);
    }
    if (Buffer.byteLength(text) > STATUS_MAX_BYTES) {
      // 最后一道：去报告、去 blocked、消息截短；starvation 永远保留。
      value = { ...value, lastReport: null, alerts: value.alerts.filter((alert) => alert.severity === 'error') };
      value.proposals = { ...value.proposals, queue: { ...value.proposals.queue, blocked: [] } };
      if (value.lastError) value.lastError = { ...value.lastError, message: truncateText(value.lastError.message, 80) };
      text = serialize(value);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    const readBack = fs.readFileSync(file, 'utf8');
    if (readBack !== text) return { ok: false, error: 'E_IO' };
    return { ok: true, bytes: Buffer.byteLength(text) };
  } catch (error) {
    try { if (tmp) fs.unlinkSync(tmp); } catch { /* best effort */ }
    return { ok: false, error: storageErrorCode(error) };
  }
}
