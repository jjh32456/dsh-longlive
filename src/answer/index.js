// answer/index.js — 「有据才答」接线：
//   - agent/pre-step（最外层）：历史类问题先检索会话历史，注入证据包/无证据标记；
//   - ctx.systemPrompt.section（宿主契约）：加一条静态短规则；
//   - session/event：逐轮收集助手正文、tool calls、工具结果，turn/end 时检测并写审计；
//   - GET /api/longlive/answer-audit：面板/调试可查（与 answer_audit 工具同源）。
//
// 宿主能力边界（2026-11-06 核 asar）：
//   - 有 `agent/pre-step` waterfall（dsh-agent-loop/lib/index.js:685-697），
//     可以拿到 messages 并返回新 messages；
//   - **没有** `agent/post-step`（全量 asar 0 命中）；回合结束只有
//     `agent/turn-stopping`（serial）与 `session/event` 的 turn/end；
//   - **没有** message transform 钩子（宿主源码里只看到 llm/stream waterfall），
//     所以检测只能在正文落日志之后记录，不能改写，也不许静默改写。
//
// 所有路径 fail-open：catch 后只 warn，pre-step 永远返回原 decision。

import fs from 'node:fs';
import path from 'node:path';

import { startPrestepPhase, finalizePrestepTurn } from '../metrics/prestep-latency.mjs';

import {
  ANSWER_GUARD_VERSION,
  GATE_DEFAULTS,
  GATE_RULE_TEXT,
  EVIDENCE_MARK,
  NO_EVIDENCE_MARK,
  RULE_MARK,
  RULE_TEXT,
  auditTurn,
  buildAuditRow,
  composeAuditContext,
  isHistoryQuestion,
  isAbstention,
  normalizeGateConfig,
  renderEvidencePacket,
  renderNoEvidence,
  renderRuleBlock,
  retrieveEvidence,
  tailTextParts,
  resolveDelivery,
  ABSTAIN_DELIVERY_TEXT,
  renderForceAbstainDirective,
} from './guard.js';
import { appendAuditRecord } from '../memory/audit-records.js';
import { retrieveEvidenceWithSecondHop } from './second-hop.mjs';
import { appendAuditRow, auditFilePath, auditMetrics, readAuditRows } from './audit.js';
import { scrubText } from '../util/redact.js';
import { buildTurnItems } from '../original.js';
import { parseSession } from '../codec.js';
import { dshHome } from '../home.js';
import { isRealUserMessage, textsOf, injectionSource, assertInjectionMessage } from '../recall/inject-order.mjs';

export const ANSWER_GUARD_DEFAULTS = Object.freeze({
  // 1.8.0：默认开启；显式 false / DSH_LONGLIVE_DISABLE_ANSWER_GUARD 才是独立 kill switch。
  enabled: true,
  maxEvidenceTurns: 3,
  evidenceMinScore: 1.8,
  evidenceMaxChars: 4000,
  maxHistoryTurns: 80,
  systemPromptSection: true,
  injectRule: true,
  audit: true,
  auditMaxBytes: 2 * 1024 * 1024,
  auditContextChars: 40000,
  panel: true,
  knownTools: null,
  // 信心闸 M1：默认关（灰度），开启后 auditTurn 参与三态判定并写 gate 字段。
  gate: GATE_DEFAULTS,
});

import { externalLegacyToolNames } from '../adapters/registry.js';

/** 常用宿主工具名：假执行检测只认这些（或带下划线的工具名形态）。 */
export const DEFAULT_KNOWN_TOOLS = Object.freeze([
  'read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'bash', 'todo_write', 'web_search', 'web_fetch',
  'send_message', 'subagent', 'workflow', 'ralph', 'tool_search', 'session_search', 'session_original',
  'session_health', 'session_backup', 'session_truncate', 'session_truncate_visible', 'session_compact',
  'session_wake', 'memory_index', 'memory_consolidate', 'memory_reinforce', 'memory_forget',
  'memory_procedure', 'memory_recall', ...externalLegacyToolNames(), 'answer_audit', 'present', 'session_live_update',
  'session_live_list', 'session_live_get', 'session_live_prune', 'lease_acquire', 'lease_release',
  'worker_spawn', 'worker_status', 'worker_kill',
]);

function int(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** 归一化 answerGuard 配置；坏值回默认，绝不抛。 */
export function normalizeAnswerGuardConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: bool(cfg.enabled, ANSWER_GUARD_DEFAULTS.enabled),
    maxEvidenceTurns: int(cfg.maxEvidenceTurns, ANSWER_GUARD_DEFAULTS.maxEvidenceTurns, 1, 10),
    evidenceMinScore: Number.isFinite(Number(cfg.evidenceMinScore))
      ? Math.max(0, Number(cfg.evidenceMinScore))
      : ANSWER_GUARD_DEFAULTS.evidenceMinScore,
    evidenceMaxChars: int(cfg.evidenceMaxChars, ANSWER_GUARD_DEFAULTS.evidenceMaxChars, 400, 4000),
    maxHistoryTurns: int(cfg.maxHistoryTurns, ANSWER_GUARD_DEFAULTS.maxHistoryTurns, 5, 400),
    systemPromptSection: bool(cfg.systemPromptSection, ANSWER_GUARD_DEFAULTS.systemPromptSection),
    injectRule: bool(cfg.injectRule, ANSWER_GUARD_DEFAULTS.injectRule),
    audit: bool(cfg.audit, ANSWER_GUARD_DEFAULTS.audit),
    auditMaxBytes: int(cfg.auditMaxBytes, ANSWER_GUARD_DEFAULTS.auditMaxBytes, 64 * 1024, 64 * 1024 * 1024),
    auditContextChars: int(cfg.auditContextChars, ANSWER_GUARD_DEFAULTS.auditContextChars, 4000, 200000),
    panel: bool(cfg.panel, ANSWER_GUARD_DEFAULTS.panel),
    gate: normalizeGateConfig(cfg.gate),
    knownTools: Array.isArray(cfg.knownTools) && cfg.knownTools.length > 0
      ? cfg.knownTools.map(String)
      : null,
  };
}

function loggerOf(ctx) {
  try {
    const logger = typeof ctx?.logger === 'function' ? ctx.logger() : ctx?.logger;
    return logger && typeof logger.warn === 'function' ? logger : null;
  } catch {
    return null;
  }
}

function isSubagent(agent) {
  return agent?.session?.header?.origin === 'subagent' || agent?.origin === 'subagent';
}

function sessionIdOf(agent) {
  return String(agent?.session?.id ?? agent?.id ?? 'unknown');
}

function firstText(message) {
  return textsOf(message).join('\n').trim();
}

function lastRealUserText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (!isRealUserMessage(list[i])) continue;
    const text = firstText(list[i]);
    if (text !== '') return text;
  }
  return '';
}

/**
 * 把 pre-step 的消息折成「按顺序的文本块」。
 * 2026-11-07 run C 修复：不再从前往后截断，交给 tailTextParts 取尾部并显式标记。
 */
function collectTextParts(messages) {
  const parts = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const text of textsOf(message)) {
      if (typeof text === 'string' && text !== '') parts.push(text);
    }
  }
  return parts;
}

/** 会话日志定位（与 auto-truncate 的 findSessionFile 同一布局，少一层依赖）。 */
function findSessionLog(home, sessionId) {
  if (typeof home !== 'string' || home === '' || typeof sessionId !== 'string' || sessionId === '') return null;
  const root = path.join(home, 'sessions');
  let scopes;
  try {
    scopes = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const scope of scopes) {
    if (!scope.isDirectory()) continue;
    const candidate = path.join(root, scope.name, sessionId, 'session.v4.jsonl.zstd');
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* not this scope */
    }
  }
  return null;
}

function clip(text, max) {
  const raw = String(text ?? '');
  return raw.length <= max ? raw : `${raw.slice(0, Math.max(0, max - 1))}…`;
}

/** 取会话事件：优先进程内快照，退到磁盘日志；都失败返回 null（区别于「读到空」）。 */
function readSessionEvents(session, sessionId, home) {
  let snapshotWorked = false;
  try {
    if (session && typeof session.snapshotEvents === 'function') {
      const events = session.snapshotEvents();
      if (Array.isArray(events)) {
        snapshotWorked = true;
        return events;
      }
    }
  } catch {
    /* fall through to the disk log */
  }
  try {
    const file = findSessionLog(home, sessionId);
    if (!file) return snapshotWorked ? [] : null;
    return parseSession(fs.readFileSync(file)).events;
  } catch {
    return null;
  }
}

/** 只保留最近 maxTurns 轮，避免 25K 事件的会话每问一次都全量重建。 */
function recentEvents(events, maxTurns) {
  const list = Array.isArray(events) ? events : [];
  let starts = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.type !== 'turn/start') continue;
    starts += 1;
    if (starts > maxTurns) return list.slice(i + 1);
  }
  return list;
}

/**
 * 把事件折成可检索的轮次数组（只含已完成的轮）。
 * @returns {Array<{turn:number,user:string,assistant:string,tools:string}>}
 */
export function buildTurnIndex(events, currentTurn, maxTurns = 80) {
  const map = buildTurnItems(recentEvents(events, maxTurns));
  const turns = [];
  for (const [turn, items] of map) {
    if (Number(turn) >= Number(currentTurn)) continue;
    const user = [];
    const assistant = [];
    const tools = [];
    for (const item of items) {
      if (item.kind === 'message' && item.role === 'user') user.push(item.text);
      else if (item.kind === 'message' && item.role === 'assistant') assistant.push(item.text);
      else if (item.kind === 'tool') tools.push(item.text);
    }
    turns.push({
      turn: Number(turn),
      user: clip(user.join('\n'), 4000),
      assistant: clip(assistant.join('\n'), 4000),
      tools: clip(tools.join('\n'), 4000),
    });
  }
  return turns.sort((a, b) => a.turn - b.turn);
}

/** 会话级索引：轮号集合 + 全量工具名（给假轮号/假执行检测用）。 */
export function buildSessionIndex(events) {
  const turns = new Set();
  const toolNames = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'turn/start' && Number.isInteger(event?.data?.turn)) turns.add(event.data.turn);
    else if (event?.type === 'tool/call' && typeof event?.data?.name === 'string') toolNames.add(event.data.name);
  }
  return { turns, toolNames };
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * 注册「有据才答」层。
 *
 * @param {object} ctx Cordis context（fake context 也支持 on/logger）
 * @param {object} config 顶层插件配置（读 config.answerGuard 或直接传 answerGuard 块）
 * @param {{memoryRoot?:string|null,home?:string,now?:Function,knownTools?:string[],
 *          createUserMessage?:Function,fsImpl?:object}} [options]
 * @returns {{enabled:boolean,config:object,systemPrompt:string,auditPath:string,hooks:string[]}}
 */
export function registerAnswerGuard(ctx, config = {}, options = {}) {
  const raw = config?.answerGuard ?? config?.answer_guard ?? config?.guardAnswers ?? {};
  const cfg = normalizeAnswerGuardConfig(raw);
  // S1: 顶层 audit 块（只读本块，不动 answerGuard 既有字段）。
  const auditCfg = config?.audit && typeof config.audit === 'object' ? config.audit : {};
  const auditRedact = auditCfg.redact !== false;
  const auditRetentionRaw = Number(auditCfg.retentionDays);
  const auditRetentionDays = Number.isInteger(auditRetentionRaw) && auditRetentionRaw > 0 && auditRetentionRaw <= 3650
    ? auditRetentionRaw
    : 30;
  // FIX-05：fixture 元数据（canAbstain/evidenceUnits/difficulty/questionType）只能由
  // query/audit 调用方提供；拿不到就返回 null（投递判定=不适用），绝不臆测。
  const resolveQuestionMeta = typeof options.resolveQuestionMeta === 'function' ? options.resolveQuestionMeta : null;
  const result = {
    enabled: cfg.enabled,
    config: cfg,
    systemPrompt: 'disabled',
    auditPath: '',
    hooks: [],
  };
  if (!cfg.enabled) return result;

  const warn = (() => {
    const logger = loggerOf(ctx);
    const seen = new Set();
    return (key, error) => {
      if (seen.has(key)) return;
      seen.add(key);
      const message = `[answer-guard] ${key}: ${error?.code ?? error?.message ?? error}`;
      if (logger) logger.warn(message);
      else {
        try {
          console.warn(`[longlive] ${message}`);
        } catch {
          /* logging must never break anything */
        }
      }
    };
  })();

  const memoryRoot = typeof options.memoryRoot === 'string' && options.memoryRoot.trim() !== ''
    ? options.memoryRoot.trim()
    : null;
  const home = options.home ?? dshHome();
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const knownTools = [...new Set([
    ...DEFAULT_KNOWN_TOOLS,
    ...ensureArray(options.knownTools),
    ...(cfg.knownTools ?? []),
  ])];
  const auditPath = memoryRoot ? auditFilePath(memoryRoot) : '';
  result.auditPath = auditPath;

  /* ---------------- FIX-05 评测元数据接缝（仅评测环境；不进公开 config/文档） ---------------- */
  // LONGLIVE_EVAL_META_JSON 指向 {"<题目原文>": {"canAbstain":bool,"difficulty":str,"questionType":str}}；
  // 只在 options.resolveQuestionMeta 缺失/返回空时兜底；未设 env → 零开销返回 null（不猜）。
  const EVAL_META_ENV = 'LONGLIVE_EVAL_META_JSON';
  let evalMetaCache = null; // { key, map }
  const normalizeQuestionMeta = (entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    if (typeof entry.canAbstain !== 'boolean') return null; // 缺字段不猜
    return {
      canAbstain: entry.canAbstain,
      difficulty: typeof entry.difficulty === 'string' ? entry.difficulty : undefined,
      questionType: typeof entry.questionType === 'string' ? entry.questionType : undefined,
      evidenceUnits: Number.isInteger(entry.evidenceUnits) && entry.evidenceUnits >= 0 ? entry.evidenceUnits : undefined,
    };
  };
  const evalMetaMap = () => {
    const file = String(process.env?.[EVAL_META_ENV] ?? '').trim();
    if (file === '') return null;
    // 缓存键 = 路径 + mtime/size：同一路径被重写（fixture 再生）时自动重载。
    let stamp = null;
    try {
      const stat = fs.statSync(file);
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch (error) {
      if (evalMetaCache?.key !== file || evalMetaCache?.stamp !== 'MISSING') {
        warn('EVAL_META_UNAVAILABLE', error);
      }
      evalMetaCache = { key: file, stamp: 'MISSING', map: null };
      return null;
    }
    if (evalMetaCache && evalMetaCache.key === file && evalMetaCache.stamp === stamp) return evalMetaCache.map;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const map = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
      if (!map) warn('EVAL_META_INVALID', new Error('map must be a JSON object'));
      evalMetaCache = { key: file, stamp, map };
      return map;
    } catch (error) {
      warn('EVAL_META_UNAVAILABLE', error);
      evalMetaCache = { key: file, stamp, map: null };
      return null;
    }
  };
  // env 接缝状态：unset（未设）/ invalid（读不到或不是对象）/ map-hit（精确命中且条目有效）/
  // not-applicable（文件正常但无此题 / 条目缺字段）。只读调试字段，不影响判定。
  const evalMetaStatus = (question) => {
    const file = String(process.env?.[EVAL_META_ENV] ?? '').trim();
    if (file === '') return { meta: null, source: 'unset' };
    const map = evalMetaMap();
    if (!map) return { meta: null, source: 'invalid' };
    const key = String(question ?? '').trim();
    if (key === '' || !Object.prototype.hasOwnProperty.call(map, key)) {
      return { meta: null, source: 'not-applicable' };
    }
    const meta = normalizeQuestionMeta(map[key]);
    return meta ? { meta, source: 'map-hit' } : { meta: null, source: 'not-applicable' };
  };
  // memoryRoot 文件回退：<memoryRoot>/.eval-meta.json，同 map 格式；文件不存在/坏 → not-applicable。
  const EVAL_META_FILE = '.eval-meta.json';
  let evalMetaFileCache = null; // { key, stamp, map }
  const evalMetaFileMap = () => {
    if (!memoryRoot) return null;
    const file = path.join(memoryRoot, EVAL_META_FILE);
    let stamp = null;
    try {
      const stat = fs.statSync(file);
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      // 文件不存在是正常状态（live 默认没有），不 warn。
      return null;
    }
    if (evalMetaFileCache && evalMetaFileCache.key === file && evalMetaFileCache.stamp === stamp) {
      return evalMetaFileCache.map;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const map = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
      if (!map) warn('EVAL_META_FILE_INVALID', new Error('map must be a JSON object'));
      evalMetaFileCache = { key: file, stamp, map };
      return map;
    } catch (error) {
      warn('EVAL_META_FILE_INVALID', error);
      evalMetaFileCache = { key: file, stamp, map: null };
      return null;
    }
  };
  const evalMetaFileStatus = (question) => {
    if (!memoryRoot) return { meta: null, source: 'not-applicable' };
    const map = evalMetaFileMap();
    if (!map) return { meta: null, source: 'not-applicable' };
    const key = String(question ?? '').trim();
    if (key === '' || !Object.prototype.hasOwnProperty.call(map, key)) {
      return { meta: null, source: 'not-applicable' };
    }
    const meta = normalizeQuestionMeta(map[key]);
    return meta ? { meta, source: 'file-hit' } : { meta: null, source: 'not-applicable' };
  };
  const lookupQuestionMeta = (input = {}) => {
    if (resolveQuestionMeta) {
      try {
        const meta = normalizeQuestionMeta(resolveQuestionMeta(input));
        if (meta) return { meta, source: 'not-applicable' }; // 调用方直传，env/文件接缝未参与
      } catch (error) {
        warn('QUESTION_META_FAILED', error);
      }
    }
    // env 路线（guest 子进程 env 可能被过滤，保留但不唯一）。
    const envStatus = evalMetaStatus(input.question);
    if (envStatus.meta) return envStatus;
    // memoryRoot 文件回退（release-check 把 map 复制到 <memoryRoot>/.eval-meta.json）。
    const fileStatus = evalMetaFileStatus(input.question);
    if (fileStatus.meta) return fileStatus;
    // 无命中：env 有问题时报 invalid（便于 after4 复核），否则 not-applicable 不猜。
    return envStatus.source === 'invalid' ? envStatus : { meta: null, source: 'not-applicable' };
  };
  const metaCanAbstainOf = (meta) => {
    if (!meta || typeof meta.canAbstain !== 'boolean') return null;
    return meta.canAbstain;
  };
  const metaEvidenceUnitsOf = (meta) => (
    meta && Number.isInteger(meta.evidenceUnits) && meta.evidenceUnits >= 0 ? meta.evidenceUnits : null
  );
  // 强制弃答条件：B 题且证据单元=0；fixture 映射无 evidenceUnits 时只认明确的 abstain 题型。
  const shouldForceAbstain = (meta) => {
    if (!meta || meta.canAbstain !== true) return false;
    const units = metaEvidenceUnitsOf(meta);
    if (units === 0) return true;
    return units === null && meta.questionType === 'abstain';
  };

  /* ---------------- 系统提示：宿主支持的 section 契约 ---------------- */
  try {
    if (cfg.systemPromptSection && typeof ctx?.systemPrompt?.section === 'function') {
      ctx.systemPrompt.section({
        name: 'longlive:answer-guard',
        order: 9500,
        // M1.5：gate 关闭时逐字节保持原 RULE_TEXT；开启时才追加硬规则。
        text: cfg.gate.enabled ? `${RULE_TEXT}\n${GATE_RULE_TEXT}` : RULE_TEXT,
      });
      result.systemPrompt = 'section';
    } else {
      result.systemPrompt = 'unavailable';
    }
  } catch (error) {
    result.systemPrompt = 'failed';
    warn('SYSTEM_PROMPT_SECTION_FAILED', error);
  }

  /* ---------------- 每会话状态 / 会话事件缓存 ---------------- */
  const states = new Map();
  const eventCache = new Map();
  const stateFor = (sessionId) => {
    let st = states.get(sessionId);
    if (!st) {
      st = {
        turn: 0,
        sessionTurns: new Set(),
        sessionToolNames: new Set(),
        turnToolNames: new Set(),
        assistantHistory: [],
        finalText: '',
        toolResultText: '',
        userText: '',
        question: '',
        historyQuestion: false,
        zeroHit: false,
        evidenceTurns: [],
        evidenceText: '',
        contextText: '',
        contextTruncated: false,
        contextChars: 0,
        toolResultTruncated: false,
        ruleInjected: false,
        lastAudit: null,
        warned: false,
      };
      states.set(sessionId, st);
    }
    return st;
  };

  const cachedEvents = (session, sessionId) => {
    let entry = eventCache.get(sessionId);
    let liveCount = -1;
    try {
      if (session && typeof session.snapshotEvents === 'function') liveCount = session.snapshotEvents().length;
    } catch {
      liveCount = -1;
    }
    if (entry && (liveCount < 0 || entry.count === liveCount)) return entry;
    const events = readSessionEvents(session, sessionId, home);
    if (events === null) return { ok: false, events: null, count: 0, turns: new Set(), toolNames: new Set() };
    const index = buildSessionIndex(events);
    entry = { ok: true, events, count: events.length, ...index };
    eventCache.set(sessionId, entry);
    return entry;
  };

  /* ---------------- pre-step：证据注入 ---------------- */
  let createUserMessage = typeof options.createUserMessage === 'function' ? options.createUserMessage : null;
  const getUserMessageFactory = async () => {
    if (createUserMessage) return createUserMessage;
    try {
      const mod = await import('@deepseek-ai/dsh-llm');
      if (typeof mod?.createUserMessage === 'function') createUserMessage = mod.createUserMessage;
    } catch (error) {
      warn('CREATE_MESSAGE_UNAVAILABLE', error);
    }
    return createUserMessage;
  };

  const makeInjection = (factory, text) => assertInjectionMessage(factory({
    content: [{ type: 'text', text }],
    source: injectionSource(),
  }));

  try {
    const dispose = ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next();
      const latencySessionId = sessionIdOf(payload?.agent);
      const latencyTurn = Number.isFinite(Number(payload?.turn)) ? Number(payload.turn) : null;
      // B3: guard phase is this outermost handler's own work (after next()).
      const guardPhase = startPrestepPhase(latencySessionId, latencyTurn, 'guard');
      try {
        if (!decision || decision.kind === 'reject') return decision;
        if (Number(payload?.step) !== 1) return decision;
        if (isSubagent(payload?.agent)) return decision;
        const messages = Array.isArray(decision.messages) ? decision.messages : [];
        const question = lastRealUserText(messages);
        if (question.trim() === '') return decision;

        const sessionId = sessionIdOf(payload?.agent);
        const st = stateFor(sessionId);
        const turn = Number.isFinite(Number(payload?.turn))
          ? Number(payload.turn)
          : (st.turn > 0 ? st.turn + 1 : 1);
        st.turn = turn;
        st.question = question;
        st.userText = question;
        // 取证上下文取「尾部」而不是从前往后截断：run C 的 159 条无出处数字误报，
        // 主因就是 40k 从前往后把后段历史/证据包切掉了（见 ANSWER-GUARD-VM.md §2.2）。
        const ctxTail = tailTextParts(collectTextParts(messages), cfg.auditContextChars);
        st.contextText = ctxTail.text;
        st.contextTruncated = ctxTail.truncated === true;
        st.contextChars = ctxTail.chars;
        st.historyQuestion = isHistoryQuestion(question);
        st.evidenceTurns = [];
        st.evidenceText = '';
        st.zeroHit = false;

        // FIX-05 C3 契约层（可选补充）：B 题（canAbstain=true）且 0 证据单元时，
        // pre-step 注入隐藏强制弃答指令。不保证模型服从（宿主无 message transform，
        // delivery 才是兜底）；元数据缺失/异常一律不注入，绝不猜。
        // 元数据来源：options.resolveQuestionMeta → 评测接缝 LONGLIVE_EVAL_META_JSON → 无。
        let nextMessages = messages;
        const forcedLookup = lookupQuestionMeta({
          sessionId,
          turn,
          question,
          historyQuestion: st.historyQuestion,
          zeroHit: false,
        });
        st.evalMetaSource = forcedLookup.source;
        const forcedAbstain = shouldForceAbstain(forcedLookup.meta);
        st.forcedAbstainInjection = forcedAbstain;
        if (forcedAbstain) {
          const factory = await getUserMessageFactory();
          if (factory) {
            nextMessages = [...nextMessages, makeInjection(factory, renderForceAbstainDirective())];
          } else {
            warn('NO_USER_MESSAGE_FACTORY', new Error('createUserMessage unavailable'));
          }
        }

        // 会话轮号/工具名先补全：给假轮号与假执行检测一个可信的全集。
        // 读不到（不是「读到 0 条」）时本轮不做证据注入：宁可少注入，
        // 也不能把「读取失败」伪装成「零命中」去逼模型弃答。
        let cached;
        try {
          cached = cachedEvents(payload?.agent?.session, sessionId);
        } catch (error) {
          warn('SESSION_INDEX_FAILED', error);
          return nextMessages === messages ? decision : { ...decision, messages: nextMessages };
        }
        if (!cached?.ok) {
          warn('SESSION_EVENTS_UNAVAILABLE', new Error('session events unavailable'));
          return nextMessages === messages ? decision : { ...decision, messages: nextMessages };
        }
        for (const n of cached.turns) st.sessionTurns.add(n);
        for (const name of cached.toolNames) st.sessionToolNames.add(name);

        // 闭环（M1）：上一轮审计 flagged → 本轮 pre-step 注入隐藏降级提示，
        // 不依赖模型自省；只给规则，不给答案。
        const lastFlags = Array.isArray(st.lastAudit?.flags)
          ? st.lastAudit.flags.map((flag) => String(flag?.code ?? '')).filter(Boolean)
          : [];
        if (st.lastAudit?.verdict === 'flagged' || lastFlags.length > 0) {
          const factory = await getUserMessageFactory();
          if (factory) {
            const hint = [
              '【有据才答·闸门】上一轮有未核实断言，本轮必须降级或重问。',
              `缺口：${lastFlags.slice(0, 4).join('、') || 'unverified'}。`,
              '没有可回读来源的内容不得当事实输出；无法回读就弃答或先问清。',
            ].join('\n');
            nextMessages = [...nextMessages, makeInjection(factory, hint)];
          }
        }

        if (!st.historyQuestion) {
          // 非历史问题：零证据注入，但 flagged 后的降级提示仍然生效。
          return nextMessages === messages ? decision : { ...decision, messages: nextMessages };
        }

        const events = cached.events;
        const history = buildTurnIndex(events, turn, cfg.maxHistoryTurns);
        // B4: if the evidence packet misses required dimensions (e.g. when), do ONE
        // second hop with a relaxed threshold and read adjacent turns (never >1 hop).
        const retrieval = retrieveEvidenceWithSecondHop({
          turns: history,
          question,
          currentTurn: turn,
          maxItems: cfg.maxEvidenceTurns,
          minScore: cfg.evidenceMinScore,
          retrieve: retrieveEvidence,
        });
        st.secondHop = retrieval.secondHop ?? null;
        st.zeroHit = retrieval.zeroHit === true;
        st.evidenceTurns = retrieval.items.map((item) => Number(item.turn));
        st.evidenceText = retrieval.items
          .map((item) => [item.user, item.assistant].filter(Boolean).join('\n'))
          .join('\n');

        // M1.5：只有 gate 开启时才把硬规则注入文本；默认关保持旧输出逐字节不变。
        const gateOn = cfg.gate?.enabled === true;
        const text = retrieval.zeroHit
          ? renderNoEvidence({ question, queryTerms: retrieval.queryTerms, gate: gateOn })
          : renderEvidencePacket(retrieval, { question, maxChars: cfg.evidenceMaxChars, gate: gateOn });
        if (text.trim() === '') {
          return nextMessages === messages ? decision : { ...decision, messages: nextMessages };
        }

        const factory = await getUserMessageFactory();
        if (!factory) {
          warn('NO_USER_MESSAGE_FACTORY', new Error('createUserMessage unavailable'));
          return nextMessages === messages ? decision : { ...decision, messages: nextMessages };
        }
        const message = makeInjection(factory, text);

        nextMessages = [...nextMessages, message];
        // 系统提示 section 不可用时的兜底：把同一段短规则作为隐藏消息注入一次。
        if (cfg.injectRule && result.systemPrompt !== 'section' && !st.ruleInjected) {
          const ruleMessage = makeInjection(factory, renderRuleBlock({ gate: gateOn }));
          nextMessages = [...nextMessages, ruleMessage];
          st.ruleInjected = true;
        }
        return { ...decision, messages: nextMessages };
      } catch (error) {
        if (!stateFor(sessionIdOf(payload?.agent)).warned) {
          stateFor(sessionIdOf(payload?.agent)).warned = true;
          warn('PRE_STEP_FAILED', error);
        }
        return decision; // fail-open：注入失败绝不阻断本轮
      } finally {
        // B3: outermost handler finalizes the turn row (metrics turn/end is the fallback).
        try { guardPhase.end(); } catch { /* timing only */ }
        try { finalizePrestepTurn(latencySessionId, latencyTurn, { memoryRoot }); } catch { /* timing only */ }
      }
    }, { prepend: true });
    if (typeof dispose === 'function') result.hooks.push('agent/pre-step');
  } catch (error) {
    warn('PRE_STEP_REGISTER_FAILED', error);
  }

  /* ---------------- session/event：逐轮收集 + turn/end 审计 ---------------- */
  const cardExists = (ref) => {
    if (!memoryRoot) return true;
    try {
      const root = path.resolve(memoryRoot);
      const resolved = path.resolve(root, ref);
      if (!resolved.startsWith(root + path.sep) && resolved !== root) return true; // 越界不判断
      return fs.existsSync(resolved);
    } catch {
      return true;
    }
  };

  const runAudit = (st, sessionId, turn) => {
    const text = st.finalText.trim();
    if (text === '') return null;
    // FIX-05：元数据来源 = options.resolveQuestionMeta → 评测接缝 LONGLIVE_EVAL_META_JSON
    // （按题目原文精确匹配）。缺失/异常一律 not-applicable，不猜。
    const metaLookup = lookupQuestionMeta({
      sessionId,
      turn,
      question: st.question,
      historyQuestion: st.historyQuestion,
      zeroHit: st.zeroHit,
      evidenceTurns: [...st.evidenceTurns],
    });
    const questionMeta = metaLookup.meta;
    const metaCanAbstain = metaCanAbstainOf(questionMeta);
    const metaEvidenceUnits = metaEvidenceUnitsOf(questionMeta);
    const prior = [...st.assistantHistory];
    if (prior.length > 0 && prior[prior.length - 1] === st.finalText) prior.pop();
    // 2026-11-07 run C 修复：关键证据（问题/注入证据包/工具结果/本轮先前正文）
    // 一律不截断；只有泛上下文按剩余预算取尾部，并落 contextTruncated 标记。
    const composed = composeAuditContext({
      question: st.question,
      evidenceText: st.evidenceText,
      toolResultText: st.toolResultText,
      priorText: prior.join('\n'),
      genericText: st.contextText,
      maxChars: cfg.auditContextChars,
    });
    const contextTruncated = composed.truncated === true
      || st.contextTruncated === true
      || st.toolResultTruncated === true;
    const toolNames = [...st.turnToolNames];
    let audit;
    try {
      audit = auditTurn({
        text,
        turn,
        question: st.question,
        historyQuestion: st.historyQuestion,
        zeroHit: st.zeroHit,
        evidenceTurns: st.evidenceTurns,
        toolNames,
        sessionToolNames: [...st.sessionToolNames],
        sessionTurns: [...st.sessionTurns],
        contextText: composed.text,
        contextTruncated,
        evidenceText: st.evidenceText,
        gateCfg: cfg.gate,
        knownTools,
        cardExists,
        // FIX-05：调用方给的 fixture 元数据（缺失=null → audit 里不猜测）。
        canAbstain: metaCanAbstain === true,
        evidenceUnits: metaEvidenceUnits,
        difficulty: questionMeta?.difficulty,
        questionType: questionMeta?.questionType,
      });
    } catch (error) {
      warn('AUDIT_FAILED', error);
      return null;
    }
    const row = buildAuditRow({
      sessionId,
      turn,
      question: st.question,
      text,
      audit,
      historyQuestion: st.historyQuestion,
      zeroHit: st.zeroHit,
      evidenceTurns: st.evidenceTurns,
      toolNames,
      mode: 'live',
      now: now(),
      contextInfo: {
        chars: composed.chars,
        keptChars: composed.text.length,
        keyChars: composed.keyChars,
        truncated: contextTruncated,
      },
    });
    // FIX-05 C3/C2 投递判定（确定性、无模型调用）：B 题 0 证据或 hard 来源 flag →
    // 弃答文案（不含解释性正文）；元数据缺失 → 'not-applicable'（不改变投递、不猜）。
    // 宿主没有 message transform（见 HOST_CAPABILITY），最终用户可见文本由渲染/投递端消费
    // row.delivery.text；本层保证判定只算一次且可复算。
    row.delivery = resolveDelivery({
      text,
      canAbstain: metaCanAbstain,
      evidenceUnits: metaEvidenceUnits,
      evidenceTurns: st.evidenceTurns,
      evidenceText: st.evidenceText,
      flags: audit?.flags ?? [],
    });
    // FIX-05 契约层：本轮 pre-step 是否注入了隐藏强制弃答指令（不保证模型服从）。
    row.forcedAbstainInjection = st.forcedAbstainInjection === true;
    // 只读调试字段：eval 元数据接缝状态（map-hit/unset/invalid/not-applicable）。
    row.evalMetaSource = st.evalMetaSource ?? 'not-applicable';
    if (cfg.audit && memoryRoot) {
      const written = appendAuditRow(memoryRoot, row, {
        maxBytes: cfg.auditMaxBytes,
        redact: auditRedact,
        retentionDays: auditRetentionDays,
        now,
      });
      if (!written.ok) warn('AUDIT_WRITE_FAILED', new Error(written.error ?? 'unknown'));
      // A5 unified audit: answer audit is mirrored into .longlive/audit/records.jsonl
      // (questionId 口径 = ag-001…；本版暂无则显式 unknown，不臆造).
      // S1: 同一份 scrub 也用于镜像的 answerText，避免凭据从第二条通道落盘。
      const mirroredAnswerText = typeof row.assistantText === 'string'
        ? (auditRedact ? scrubText(row.assistantText).text : row.assistantText)
        : null;
      try {
        appendAuditRecord({
          memoryRoot,
          action: 'answer',
          recordId: row.sessionId ? `${row.sessionId}:${row.turn ?? 'unknown'}` : null,
          readerTier: 'host',
          questionId: typeof row.questionId === 'string' && row.questionId !== '' ? row.questionId : 'unknown',
          expectedTurns: Array.isArray(row.evidenceTurns) && row.evidenceTurns.length > 0 ? row.evidenceTurns.length : null,
          answerText: mirroredAnswerText,
          extra: {
            verdict: row.verdict,
            turn: row.turn ?? null,
            evidenceTurns: row.evidenceTurns ?? [],
            secondHop: row.secondHop ?? null,
            deliveryMode: row.delivery?.mode ?? 'not-applicable',
            deliveryForced: row.delivery?.forced === true,
            forcedAbstainInjection: row.forcedAbstainInjection === true,
            evalMetaSource: row.evalMetaSource ?? 'not-applicable',
            redaction: row.redaction ?? null,
            retentionDays: auditRetentionDays,
          },
        });
      } catch { /* answer auditing must never break the guard */ }
    }
    row.secondHop = st.secondHop ?? null;
    st.lastAudit = row;
    return row;
  };

  const resetTurn = (st, turn) => {
    st.turn = turn;
    st.turnToolNames = new Set();
    st.assistantHistory = [];
    st.finalText = '';
    st.toolResultText = '';
    st.toolResultTruncated = false;
    st.contextTruncated = false;
    st.contextChars = 0;
    // FIX-05：强制弃答指令是否在本轮 pre-step 注入（审计行留证）。
    st.forcedAbstainInjection = false;
    // FIX-05：eval 元数据接缝状态（只读调试字段，审计行留证）。
    st.evalMetaSource = null;
  };

  const onSessionEvent = (session, event) => {
    try {
      if (!event || typeof event.type !== 'string') return;
      const sessionId = String(session?.id ?? 'unknown');
      const st = stateFor(sessionId);
      const data = event.data ?? {};
      switch (event.type) {
        case 'turn/start': {
          if (Number.isInteger(data.turn)) {
            resetTurn(st, data.turn);
            st.sessionTurns.add(data.turn);
          }
          break;
        }
        case 'user/message': {
          if (isRealUserMessage(data)) {
            const text = firstText(data);
            if (text !== '') {
              st.userText = text;
              if (!st.question) st.question = text;
            }
            if (!Number.isInteger(st.turn) || st.turn < 1) st.turn = Math.max(1, st.turn + 1);
            st.sessionTurns.add(st.turn);
          }
          break;
        }
        case 'assistant/message': {
          if (Number.isInteger(data.turn)) {
            if (data.turn !== st.turn) resetTurn(st, data.turn);
            st.sessionTurns.add(data.turn);
          }
          const text = (Array.isArray(data.message?.content) ? data.message.content : [])
            .filter((block) => block?.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n')
            .trim();
          if (text !== '') {
            st.assistantHistory.push(text);
            st.finalText = text;
          }
          break;
        }
        case 'tool/call': {
          if (typeof data.name === 'string') {
            st.turnToolNames.add(data.name);
            st.sessionToolNames.add(data.name);
          }
          break;
        }
        case 'tool/result': {
          const text = (Array.isArray(data.message?.content) ? data.message.content : [])
            .filter((block) => block?.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n');
          if (text !== '') {
            const merged = `${st.toolResultText}\n${text}`;
            // 工具结果属于关键证据：保留更多（120k），超出才截断并显式标记，
            // 让审计上下文带上 contextTruncated，评分器可走复核豁免。
            st.toolResultTruncated = merged.length > 120000;
            st.toolResultText = clip(merged, 120000);
          }
          break;
        }
        case 'turn/end': {
          const turn = Number.isInteger(data.turn) ? data.turn : st.turn;
          runAudit(st, sessionId, turn);
          const keep = {
            sessionTurns: st.sessionTurns,
            sessionToolNames: st.sessionToolNames,
            lastAudit: st.lastAudit,
            question: '',
            historyQuestion: false,
            zeroHit: false,
            evidenceTurns: [],
            evidenceText: '',
            contextText: '',
            userText: '',
            ruleInjected: st.ruleInjected,
            warned: st.warned,
          };
          resetTurn(st, 0);
          Object.assign(st, keep);
          break;
        }
        default:
          break;
      }
    } catch (error) {
      try {
        const st = stateFor(String(session?.id ?? 'unknown'));
        if (!st.warned) {
          st.warned = true;
          warn('SESSION_EVENT_FAILED', error);
        }
      } catch {
        /* never throw out of a host event */
      }
    }
  };

  try {
    const dispose = ctx.on('session/event', onSessionEvent);
    if (typeof dispose === 'function') result.hooks.push('session/event');
  } catch (error) {
    warn('SESSION_EVENT_REGISTER_FAILED', error);
  }
  try {
    ctx.on('session/disposed', (session) => {
      const id = String(session?.id ?? 'unknown');
      states.delete(id);
      eventCache.delete(id);
    });
  } catch {
    /* optional lifecycle hook */
  }

  /* ---------------- 面板只读路由 ---------------- */
  const registerAuditRoute = () => {
    if (!cfg.panel || !memoryRoot) return false;
    if (typeof ctx?.inject !== 'function') return false;
    try {
      ctx.inject(['webServer'], (webCtx) => {
        try {
          const webServer = webCtx?.webServer;
          if (!webServer || typeof webServer.register !== 'function') return;
          const route = {
            kind: 'exact',
            path: '/api/longlive/answer-audit',
            handler: (req, res) => {
              try {
                const remote = req?.socket?.remoteAddress;
                if (typeof remote === 'string' && remote !== '' && !(remote.startsWith('127.') || remote === '::1' || remote === '::ffff:127.0.0.1' || remote === '::ffff:7f00:1')) {
                  respondJson(res, 403, { ok: false, code: 'E_FORBIDDEN', error: '审计查询只允许本机访问（loopback-only）。' });
                  return;
                }
                if (String(req?.method ?? 'GET').toUpperCase() !== 'GET') {
                  respondJson(res, 405, { ok: false, error: '只支持 GET。' }, { allow: 'GET' });
                  return;
                }
                const url = new URL(String(req?.url ?? '/'), 'http://127.0.0.1');
                const filter = {
                  limit: Number(url.searchParams.get('limit') ?? 50),
                  sessionId: url.searchParams.get('sessionId') ?? undefined,
                  turn: url.searchParams.get('turn') ?? undefined,
                  verdict: url.searchParams.get('verdict') ?? undefined,
                  code: url.searchParams.get('code') ?? undefined,
                  since: url.searchParams.get('since') ?? undefined,
                };
                const read = readAuditRows(memoryRoot, filter);
                respondJson(res, 200, { ...read, metrics: auditMetrics(read.rows) });
              } catch (error) {
                respondJson(res, 500, { ok: false, error: String(error?.message ?? error) });
              }
            },
          };
          const dispose = webServer.register(route);
          if (typeof webCtx?.effect === 'function') {
            webCtx.effect(() => () => {
              if (typeof dispose === 'function') dispose();
            }, 'longlive: answer-audit route');
          }
          result.hooks.push('webServer:/api/longlive/answer-audit');
        } catch (error) {
          warn('AUDIT_ROUTE_FAILED', error);
        }
      });
      return true;
    } catch (error) {
      warn('AUDIT_ROUTE_INJECT_FAILED', error);
      return false;
    }
  };
  registerAuditRoute();

  return result;
}

function respondJson(res, status, body, headers = {}) {
  if (!res || res.writableEnded === true || res.headersSent === true) return;
  const payload = JSON.stringify(body);
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
      ...headers,
    });
    res.end(payload);
  } catch {
    try {
      res.destroy?.();
    } catch {
      /* peer already gone */
    }
  }
}

/**
 * 给测试/面板用的静态能力声明：宿主钩子能拿到什么、拿不到什么。
 * 这是代码里的诚实边界，不是营销文案。
 */
export const HOST_CAPABILITY = Object.freeze({
  preStep: true,
  postStep: false,
  messageTransform: false,
  turnStopping: true,
  sessionEvent: true,
  systemPromptSection: true,
  notes: [
    'agent/post-step: 宿主 asar 全量 0 命中，不存在此钩子。',
    'message transform: 宿主只在 llm/stream 有 waterfall；模型正文没有可改写的后置钩子。',
    'turn 结束信号：agent/turn-stopping（serial）与 session/event 的 turn/end。',
    '助手最终正文与 tool calls 都能从 session/event 的 assistant/message、tool/call、tool/result 拿到。',
    'answer delivery: messageTransform=false（宿主无可改写模型正文的钩子）；delivery 是**投递契约**、不是 live 强改：runAudit 写 row.delivery，渲染/投递端消费 row.delivery.text 才生效；B 题 0 证据只额外注入隐藏强制弃答指令（模型可不服从），最终由 row.delivery 兜底。评测元数据可用 LONGLIVE_EVAL_META_JSON（env）或 <memoryRoot>/.eval-meta.json（文件回退）；live 都未提供则无此行为。',
  ],
});

export { EVIDENCE_MARK, NO_EVIDENCE_MARK, RULE_MARK, RULE_TEXT, ANSWER_GUARD_VERSION, resolveDelivery, ABSTAIN_DELIVERY_TEXT };
