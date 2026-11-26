/**
 * S3 · 召回可解释性（recall explainability）
 *
 * 职责边界：
 *   - 本模块只做**读**与纯函数分类/汇总；recall-log 的写在 src/recall/index.js。
 *   - 给 recall-log 每条补 why/eligible/dropped/gate/trigger/channel（审计 P1-7），
 *     并把「策略跳过」「零命中」「失败」分开计数，供最近 24h 汇总（面板/健康输出）。
 *   - 行为零改动：不改变触发规则（turn<=1 / same-as-last / quiet），
 *     只给已有决策补原因。
 *
 * why 语义（7 类，固定枚举）：
 *   - everyNTurns  历史 1.8.1 及以前的 every-n-turns 行；1.8.2 起 decideTrigger
 *                  不再产生该触发（此处只兼容读旧 recall-log，不是现行触发路径）
 *   - injected     本轮确实注入了卡片（非心跳轮）
 *   - zero-hit     本轮执行了检索但零命中（非心跳轮）
 *   - everyNTurns  本轮由 everyNTurns 心跳触发（不论最终是否有注入；用 injected 数组区分结果）
 *   - quiet        触发规则判定本轮「安静」（gate.why === 'quiet'）
 *   - policy-skip  gate 因其它策略跳过（same-as-last / empty-query 等）
 *   - user-task    1.8.8 M2：强制触发（autoRecall.forceOnUserMessage）路径。
 *                  它与静默/周期路径正交：只要本轮是「真人任务消息 → 强制召回」，
 *                  why 固定为 user-task、trigger 固定为 forced，不看最终是否注入
 *                  （是否真注入看 injected 数组与 outcome 字段，禁止用 why 冒充成功）。
 *   - error        本轮召回失败（异常 / 注入工厂不可用）
 *
 * trigger 是 gate.why 的稳定口径（turn<=1 等），与 why 正交，便于对照触发规则。
 * 1.8.8 起 trigger 多了 'forced'（强制触发），旧值一个不动。
 */

import fs from 'node:fs';
import path from 'node:path';

// 第三方记忆插件的通道 id 只从 adapters 注册表取，核心 src 不出现第三方字面量（独立性门禁）。
import { EXTERNAL_PLUGIN_IDS } from '../adapters/constants.js';
import { OUTPUT_RESERVE_NORMAL_TOKENS } from '../policy/threshold-policy.js';

export const RECALL_LOG_FILE = 'recall-log.jsonl';
export const LEGACY_RECALL_LOG_REL = path.join('recall', 'log.jsonl');
export const RECALL_EXPLAIN_SCHEMA = 'recall-explain/v1';
export const RECALL_LOG_SCHEMA = 'recall-log/v1';
export const RECALL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 固定 why 枚举；测试与面板按它校验，不许悄悄加值。 */
export const RECALL_WHY_VALUES = Object.freeze([
  'injected',
  'zero-hit',
  'everyNTurns',
  'quiet',
  'policy-skip',
  'error',
  // 1.8.8 M2：强制触发路径单列；只在 buildRecallLogRecord({forced:true}) 时出现。
  'user-task',
]);

/** gate.why → 面板可读 trigger 口径。 */
export const RECALL_TRIGGER_BY_GATE = Object.freeze({
  'new-session': 'turn<=1',
  'after-compaction': 'after-compaction',
  'every-n-turns': 'everyNTurns',
  'topic-switch': 'topic-switch',
  'same-as-last': 'same-as-last',
  'quiet': 'quiet',
  'empty-query': 'empty-query',
  'mid-turn': 'mid-turn',
  // 1.8.8 M2：强制触发（不看 everyNTurns、不被 quiet 挡）。
  'forced': 'forced',
});

export const RECALL_CHANNELS = Object.freeze(['file', ...EXTERNAL_PLUGIN_IDS, 'degraded']);

/**
 * gate.why → trigger 字段。
 * @param {string|undefined} gateWhy
 * @returns {string}
 */
export function normalizeTrigger(gateWhy) {
  if (typeof gateWhy !== 'string' || gateWhy === '') return 'unknown';
  return RECALL_TRIGGER_BY_GATE[gateWhy] ?? gateWhy;
}

/**
 * 单轮 why 分类（纯函数，行为语义见文件头）。
 * @param {{gate?:{recall?:boolean, why?:string}, items?:unknown[], error?:boolean, factoryUnavailable?:boolean}} input
 * @returns {'injected'|'zero-hit'|'everyNTurns'|'quiet'|'policy-skip'|'error'}
 */
export function classifyRecallWhy({ gate = null, items = [], error = false, factoryUnavailable = false } = {}) {
  if (error === true || factoryUnavailable === true) return 'error';
  const recall = gate?.recall === true;
  if (!recall) return gate?.why === 'quiet' ? 'quiet' : 'policy-skip';
  // 1.8.1 及以前的心跳行：只用于读旧日志归类，1.8.2 已没有该触发。
  if (gate?.why === 'every-n-turns') return 'everyNTurns';
  return Array.isArray(items) && items.length > 0 ? 'injected' : 'zero-hit';
}

/**
 * chooseRecall() 的 hits + rejections → 面板可读 dropped 摘要。
 * 只统计「没进本轮注入」的原因；预算内正常落选的重复项也算进去（与 blocked 对齐）。
 * @param {object|null} hits
 * @param {object[]|null} rejections
 * @returns {{budget:number,dedupe:number,seen:number,localOnly:number,privacy:number,lowTrust:number,maxItems:number,total:number}|null}
 */
export function summarizeDropped(hits = null, rejections = null) {
  if (!hits || typeof hits !== 'object') return null;
  const byReason = {};
  for (const row of Array.isArray(rejections) ? rejections : []) {
    const reason = typeof row?.reason === 'string' ? row.reason : 'unknown';
    byReason[reason] = (byReason[reason] ?? 0) + 1;
  }
  const n = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0);
  const out = {
    budget: n(hits.droppedByBudget),
    dedupe: n(hits.droppedByDedupe),
    seen: n(hits.droppedBySeen),
    localOnly: n(hits.droppedLocalOnly),
    privacy: n(hits.droppedByPrivacy),
    lowTrust: n(hits.droppedByLowTrust),
    maxItems: n(byReason['max-items']),
  };
  out.total = out.budget + out.dedupe + out.seen + out.localOnly + out.privacy + out.lowTrust + out.maxItems;
  return out;
}

/**
 * 选择本轮 channel：embedding 降级优先标注；目前召回候选只有文件卡（AutoCard 也是文件派生）。
 * 外部记忆插件通道（EXTERNAL_PLUGIN_IDS）留给后续接入：path 前缀 `<id>:` 时自动标。
 */
export function resolveChannel({ items = [], embeddingDegraded = false } = {}) {
  if (embeddingDegraded === true) return 'degraded';
  const list = Array.isArray(items) ? items : [];
  const external = EXTERNAL_PLUGIN_IDS.find((id) => list.some((item) => String(item?.path ?? '').startsWith(`${id}:`)));
  return external ?? 'file';
}

/** recall-log 里的 query 摘要上限（字符）；只留线索，不留整段对话。 */
export const RECALL_QUERY_SUMMARY_MAX = 200;

/** 日志里的敏感串：手机号 / 邮箱 / 身份证 / IPv4 / 长 token（key）。 */
const LOG_PII_PATTERNS = Object.freeze([
  /\b1[3-9]\d{9}\b/g,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\b\d{17}[\dXx]\b/g,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  /\b[A-Za-z0-9_-]{24,}\b/g,
]);

/**
 * 1.8.8 M2：recall-log 的 query 摘要（隐私友好）。
 * 只做四件事：去控制字符、折叠空白、遮蔽常见敏感串、截到 200 字符。
 * 不存整段用户消息，不做语义改写。
 * @param {unknown} text
 * @returns {string}
 */
export function summarizeQuery(text) {
  let value = String(text ?? '');
  value = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (value === '') return '';
  for (const pattern of LOG_PII_PATTERNS) value = value.replace(pattern, '[已隐去]');
  if (value.length > RECALL_QUERY_SUMMARY_MAX) value = `${value.slice(0, RECALL_QUERY_SUMMARY_MAX)}…`;
  return value;
}

/** link 统计的最小化形状（只记词数/命中数，不记用户原句）。 */
function summarizeLinkStat(link) {
  if (!link || typeof link !== 'object') return null;
  const terms = Array.isArray(link.matchedTerms) ? link.matchedTerms.map((t) => String(t)).filter((t) => t !== '').slice(0, 20) : [];
  return {
    enabled: link.enabled !== false,
    matchedTerms: terms,
    injectedCount: Number.isFinite(Number(link.injectedCount)) ? Math.max(0, Number(link.injectedCount)) : 0,
    tokens: Number.isFinite(Number(link.tokens)) ? Math.max(0, Number(link.tokens)) : 0,
  };
}

/**
 * 构造一条 recall-log 行（字段纯计算，不写盘）。
 * @param {object} input
 * @param {Date|string|number} [input.at]
 * @param {string} input.sessionId
 * @param {number} input.turn
 * @param {object|null} [input.result] chooseRecall 结果（skips 传 null）
 * @param {object|null} [input.gate] decideTrigger 结果
 * @param {number} [input.everyNTurns] 历史字段兼容（1.8.2 不再触发）
 * @param {boolean} [input.error]
 * @param {boolean} [input.factoryUnavailable]
 * @param {boolean} [input.embeddingDegraded]
 * @param {unknown[]|null} [input.injectedItems] 覆盖注入项（factory 不可用时传 []）
 * @param {string} [input.query] 1.8.8 M2：触发本轮的真实用户消息摘要（summarizeQuery 后写入）
 * @param {number|null} [input.elapsedMs] 1.8.8 M2：agent/pre-step 内召回耗时（毫秒）
 * @param {boolean} [input.forced] 1.8.8 M2：是否强制触发（autoRecall.forceOnUserMessage）
 * @param {string|null} [input.why] 覆盖 why（强制路径固定 'user-task'）
 * @param {string|null} [input.trigger] 覆盖 trigger（强制路径固定 'forced'）
 * @param {boolean} [input.archiveUnavailable] 1.8.8 M2：归档兜底模块不可用/调用失败
 * @param {object|null} [input.link] 1.8.8 M2：链路命中统计 {matchedTerms,injectedCount,tokens}
 * @returns {object}
 */
export function buildRecallLogRecord({
  at = new Date(),
  sessionId = 'unknown',
  turn = 0,
  result = null,
  gate = null,
  everyNTurns = null,
  error = false,
  factoryUnavailable = false,
  embeddingDegraded = false,
  injectedItems = null,
  query = '',
  elapsedMs = null,
  forced = false,
  why: whyOverride = null,
  trigger: triggerOverride = null,
  archiveUnavailable = false,
  link = null,
} = {}) {
  const items = Array.isArray(injectedItems) ? injectedItems : (Array.isArray(result?.items) ? result.items : []);
  const hits = result?.hits && typeof result.hits === 'object' ? result.hits : null;
  const why = typeof whyOverride === 'string' && whyOverride !== ''
    ? whyOverride
    : classifyRecallWhy({ gate, items, error, factoryUnavailable });
  const dropped = summarizeDropped(hits, result?.rejections);
  const gateSummary = {
    recall: gate?.recall === true,
    why: typeof gate?.why === 'string' ? gate.why : 'unknown',
    everyNTurns: Number.isFinite(Number(everyNTurns)) ? Number(everyNTurns) : null,
  };
  // 注意 Number(null) === 0：缺省（null/undefined/''）必须落 null，不能落 0。
  const elapsedRaw = elapsedMs === null || elapsedMs === undefined || elapsedMs === '' ? null : Number(elapsedMs);
  const elapsed = Number.isFinite(elapsedRaw) && elapsedRaw >= 0 ? Math.round(elapsedRaw) : null;
  let outcome = 'zero-hit';
  if (error === true) outcome = 'error';
  else if (factoryUnavailable === true) outcome = 'factory-unavailable';
  else if (items.length > 0) outcome = 'injected';
  else if (gate && gate.recall !== true) outcome = 'gate-skip';
  return {
    at: at instanceof Date ? at.toISOString() : new Date(at).toISOString(),
    sessionId: String(sessionId ?? 'unknown'),
    turn: Number.isFinite(Number(turn)) ? Number(turn) : 0,
    why,
    eligible: hits ? (Number.isFinite(Number(hits.eligible)) ? Number(hits.eligible) : 0) : null,
    dropped,
    gate: gateSummary,
    trigger: typeof triggerOverride === 'string' && triggerOverride !== ''
      ? triggerOverride
      : normalizeTrigger(gate?.why),
    // 1.8.8 M2：强制触发 / 链路直连 / 归档兜底的取证字段。
    forced: forced === true,
    query: summarizeQuery(query),
    elapsedMs: elapsed,
    outcome,
    archiveUnavailable: archiveUnavailable === true,
    link: summarizeLinkStat(link),
    // D5 forward instrumentation: the existing recall result already carries the
    // rendered token estimate; never read a session or add a new parse path.
    estimatedTokens: Number.isFinite(Number(result?.tokens)) ? Number(result.tokens) : 0,
    budgetUsed: Number.isFinite(Number(result?.tokens)) ? Number(result.tokens) : 0,
    // 1.8.3 D5 shared-window fields: forward-only. The recall path has no
    // session/input read; unavailable fields are explicitly null.
    estimatedInputTokens: null,
    estimatedOutputTokens: null,
    outputReserveTokens: OUTPUT_RESERVE_NORMAL_TOKENS,
    actual_output_tokens: null,
    finish_reason: null,
    truncated: false,
    reserve_class: 'long',
    fold_failed: null,
    fold_busy: false,
    injectedCount: items.length,
    channel: resolveChannel({ items, embeddingDegraded }),
    injected: items.map((item) => ({
      id: item.path,
      title: item.title,
      score: Number(Number(item.score ?? 0).toFixed(3)),
      reason: item.reason ?? 'keyword',
      // 1.8.8 M2：来源 file / link / archive；旧行缺该字段时按 file 读。
      source: typeof item.source === 'string' && item.source !== '' ? item.source : 'file',
    })),
    blocked: (Array.isArray(result?.rejections) ? result.rejections : []).map((item) => ({
      id: item.path,
      title: item.title,
      reason: item.reason,
    })),
  };
}

/**
 * 读取 recall-log 行。
 * 规范位置：<memoryRoot>/.longlive/recall-log.jsonl（auto-recall 写入）。
 * 兼容旧位置：<memoryRoot>/.longlive/recall/log.jsonl（M2-C 读审计）；规范文件不存在时才回退。
 * @param {{memoryRoot?:string, limit?:number}} [options]
 */
export function readRecallLogRows(options = {}) {
  const memoryRoot = typeof options.memoryRoot === 'string' ? options.memoryRoot.trim() : '';
  if (memoryRoot === '') {
    return { ok: false, code: 'E_MEMORY_ROOT_UNSET', present: false, path: '', legacyPath: false, rows: [], bad: 0, bytes: 0 };
  }
  const root = path.resolve(memoryRoot);
  const canonical = path.join(root, '.longlive', RECALL_LOG_FILE);
  const legacy = path.join(root, '.longlive', LEGACY_RECALL_LOG_REL);
  let file = canonical;
  try {
    fs.accessSync(canonical);
  } catch {
    try {
      fs.accessSync(legacy);
      file = legacy;
    } catch {
      file = canonical;
    }
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: true, present: false, path: file, legacyPath: file === legacy, rows: [], bad: 0, bytes: 0 };
    }
    return { ok: false, code: 'E_RECALL_LOG_READ', present: false, path: file, legacyPath: file === legacy, rows: [], bad: 0, bytes: 0 };
  }
  const rows = [];
  let bad = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const row = JSON.parse(trimmed);
      if (row && typeof row === 'object') rows.push(row);
      else bad += 1;
    } catch {
      bad += 1;
    }
  }
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 0;
  return {
    ok: true,
    present: rows.length > 0,
    path: file,
    legacyPath: file === legacy,
    rows: limit > 0 ? rows.slice(-limit) : rows,
    bad,
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}

/**
 * 最近 windowMs（默认 24h）的 why/trigger/channel 计数。
 * 明确把「策略跳过」与「零命中/失败」拆开：policySkipTotal / zeroHitTotal / errorTotal。
 * 旧行（没有 why 字段）单独计入 legacyRows，不猜原因。
 * @param {object[]} rows
 * @param {{now?:Date|number|string, windowMs?:number}} [options]
 */
export function summarizeRecallRows(rows = [], options = {}) {
  const rawNow = options.now;
  const nowMs = rawNow instanceof Date ? rawNow.getTime()
    : Number.isFinite(Number(rawNow)) ? Number(rawNow)
      : Date.now();
  const windowMs = Number.isFinite(Number(options.windowMs)) && Number(options.windowMs) > 0
    ? Number(options.windowMs)
    : RECALL_WINDOW_MS;
  const cutoff = nowMs - windowMs;
  const byWhy = Object.fromEntries(RECALL_WHY_VALUES.map((why) => [why, 0]));
  const byTrigger = {};
  const byChannel = {};
  const dropped = { budget: 0, dedupe: 0, seen: 0, localOnly: 0, privacy: 0, lowTrust: 0, maxItems: 0, total: 0 };
  let totalRows = 0;
  let inWindow = 0;
  let legacyRows = 0;
  let injectedRounds = 0;
  let emptyInjections = 0;
  let forcedTotal = 0;
  let archiveUnavailableTotal = 0;
  let linkInjectedTotal = 0;
  const byOutcome = {};
  let lastAt = null;

  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    totalRows += 1;
    const atMs = Date.parse(String(row.at ?? ''));
    const inWindowRow = Number.isFinite(atMs) ? atMs >= cutoff : false;
    if (!inWindowRow) continue;
    inWindow += 1;
    if (lastAt === null || (Number.isFinite(atMs) && atMs > Date.parse(lastAt))) lastAt = String(row.at);
    const why = RECALL_WHY_VALUES.includes(row.why) ? row.why : null;
    if (why === null) legacyRows += 1;
    else byWhy[why] += 1;
    const trigger = typeof row.trigger === 'string' && row.trigger !== '' ? row.trigger : 'unknown';
    byTrigger[trigger] = (byTrigger[trigger] ?? 0) + 1;
    const channel = RECALL_CHANNELS.includes(row.channel) ? row.channel : 'file';
    byChannel[channel] = (byChannel[channel] ?? 0) + 1;
    const injected = Array.isArray(row.injected) ? row.injected : [];
    if (injected.length > 0) injectedRounds += 1;
    else emptyInjections += 1;
    // 1.8.8 M2：强制触发 / 归档不可用 / 链路来源计数（只读已有字段，不猜）。
    if (row.forced === true) forcedTotal += 1;
    if (row.archiveUnavailable === true) archiveUnavailableTotal += 1;
    if (injected.some((item) => item?.source === 'link')) linkInjectedTotal += 1;
    const outcome = typeof row.outcome === 'string' && row.outcome !== '' ? row.outcome : 'unknown';
    byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1;
    if (row.dropped && typeof row.dropped === 'object') {
      for (const key of Object.keys(dropped)) {
        if (key === 'total') continue;
        dropped[key] += Number.isFinite(Number(row.dropped[key])) ? Math.max(0, Number(row.dropped[key])) : 0;
      }
    }
  }
  dropped.total = dropped.budget + dropped.dedupe + dropped.seen + dropped.localOnly
    + dropped.privacy + dropped.lowTrust + dropped.maxItems;
  return {
    schema: RECALL_EXPLAIN_SCHEMA,
    windowHours: Math.round((windowMs / (60 * 60 * 1000)) * 100) / 100,
    windowMs,
    totalRows,
    inWindow,
    legacyRows,
    byWhy,
    byTrigger,
    byChannel,
    byOutcome,
    injectedRounds,
    emptyInjections,
    policySkipTotal: byWhy['policy-skip'] + byWhy.quiet,
    policySkip: { other: byWhy['policy-skip'], quiet: byWhy.quiet },
    zeroHitTotal: byWhy['zero-hit'],
    errorTotal: byWhy.error,
    everyNTurnsTotal: byWhy.everyNTurns,
    forcedTotal,
    userTaskTotal: byWhy['user-task'],
    archiveUnavailableTotal,
    linkInjectedTotal,
    dropped,
    lastAt,
  };
}
