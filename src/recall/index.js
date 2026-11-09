/**
 * dsh-auto-recall — 插件骨架（**未安装**，见 ../README.md 与 WIRING.md §9）。
 *
 * 与 WIRING.md §3 的差异（复核第三轮 mustFix 已修）：
 *   - 注册用显式 `{ prepend: false }`，不跟 identity-router 抢外层；
 *     identity-router 在 `next()` 之前把开机卡插到第一条真实 user 之后，auto 作为内层
 *     一定看得到它，最终顺序固定为 `[user, boot, runtime, auto]`（真实 Cordis
 *     waterfall 语义，见 plugin/src/inject-order.mjs 顶部注释）；
 *   - 合并消息用 mergeInjectionOrder()，总是 append 到末尾；
 *   - firstUserText 只认真正的用户消息：`session/event` 里跳过 `【开机卡】`/`【自动想起】`
 *     注入（它们不再是 kind:'user'，但历史消息仍可能带标记），否则开机卡会污染之后
 *     每一轮的查询词；第 1 轮内后来到达的真人消息覆盖先前候选，防外部插件用
 *     kind:'user' 把文本插到真实提问之前（复核 ADV1）；
 *   - 注入前过 privacyScan（privacy-gate 的 scanPrivacy）；标题、摘要、路径都扫，
 *     路径命中整卡丢弃；
 *   - identity-router 已注入的卡路径进 seenPaths（路径级排除），不再无条件排除
 *     首轮 handover（那会吞掉没装 identity-router 时的开机卡）；
 *   - source.kind 用 `session-reference`（隐藏注入，聊天里不出气泡，正文仍进模型
 *     上下文），形状 `{form:'recall',version:1,references:[]}`；写入前过
 *     assertInjectionMessage()，坏 kind 直接拒绝、不进 session 日志。
 *
 * 只读 memoryRoot；只往宿主 pre-step 的 messages 里加一条消息；不改 system prompt。
 */

import { loadCards } from './cards.mjs';
import { sharedVisibility } from './shared-visibility.js';
import { extractTimeRefs } from './time-normalizer.mjs';
import { readEntityAliases, resolveEntityAliases, expandQueryWithEntities } from './entities.mjs';
import { resolveAnaphora, expandQueryWithAnaphora } from './anaphora.mjs';
import { appendAuditRecord } from '../memory/audit-records.js';
import { buildEvidencePackage, writeEvidencePackage } from '../memory/evidence.js';
import { fastAnswerFromRecallItems } from '../memory/recall-v2.js';
import { buildQueryText, chooseRecall, decideTrigger, renderInjection } from './recall-core.mjs';
import { buildRecallLogRecord } from './explain.mjs';
import { createEmbeddingRuntime } from './embedding.mjs';
import { privacyScan } from './privacy.mjs';
import {
  assertInjectionMessage,
  injectionSource,
  identityInjectedPaths,
  injectedTexts as collectInjectedTexts,
  isRealUserMessage,
  mergeInjectionOrder,
} from './inject-order.mjs';
import { appendFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dshHome } from '../home.js';
import { DEFAULT_MEMORY_DIRNAME } from '../memory/paths.js';
import { startPrestepPhase, notePrestepDegrade, setPrestepMeta } from '../metrics/prestep-latency.mjs';
import { sampleContentHash } from '../memory/auto-cards.js';

export const name = 'dsh-auto-recall';
export const inject = [];

/** Env names shared with src/memory/paths.js (single naming scheme). */
const MEMORY_ROOT_ENV = 'DSH_LONGLIVE_MEMORY_ROOT';
const LEGACY_MEMORY_ROOT_ENV = 'DSH_MEM';

/**
 * Portable default for the recall store.
 * Resolution order: $DSH_LONGLIVE_MEMORY_ROOT → $DSH_MEM → <DSH home>/longlive-memory,
 * the same chain the memory_* tools use, so identity/recall can never read a second store.
 * The recall plugin is read-only, so this never creates the directory.
 */
export function defaultMemoryRoot(env = process.env) {
  const fromEnv = String(env?.[MEMORY_ROOT_ENV] ?? '').trim();
  if (fromEnv) return fromEnv;
  const fromLegacy = String(env?.[LEGACY_MEMORY_ROOT_ENV] ?? '').trim();
  if (fromLegacy) return fromLegacy;
  return join(dshHome(env), DEFAULT_MEMORY_DIRNAME);
}

const DEFAULTS = Object.freeze({
  autoRecall: true,
  memoryRoot: null,
  dirs: ['topics', 'handover'],
  budget: 1200,
  maxItems: 3,
  minScore: 0.7,
  everyNTurns: 6,
  observePath: '',
  privacyPolicy: 'drop',
  skipSubagents: true,
  log: false,
  embedding: { enabled: true },
  evidencePackage: true,
});

function normalize(config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  // 复核 M1：空 / 未配置时走可移植默认链，绝不落到构建机的绝对路径。
  const root = typeof cfg.memoryRoot === 'string' ? cfg.memoryRoot.trim() : '';
  cfg.memoryRoot = root === '' ? defaultMemoryRoot() : root;
  // 注入硬上限 2K token/轮（A4）；下限保留 200，避免误配把注入挤成一条。
  cfg.budget = Math.max(200, Math.min(2000, Number(cfg.budget) || DEFAULTS.budget));
  cfg.maxItems = Math.max(1, Math.min(10, Number(cfg.maxItems) || DEFAULTS.maxItems));
  cfg.minScore = Number.isFinite(Number(cfg.minScore)) ? Number(cfg.minScore) : DEFAULTS.minScore;
  cfg.everyNTurns = Math.max(1, Number(cfg.everyNTurns) || DEFAULTS.everyNTurns);
  cfg.dirs = Array.isArray(cfg.dirs) && cfg.dirs.length > 0 ? cfg.dirs : DEFAULTS.dirs.slice();
  cfg.privacyPolicy = cfg.privacyPolicy === 'title' ? 'title' : 'drop';
  // 测试/嵌入时可注入消息工厂，避免依赖 @deepseek-ai/dsh-llm 的解析环境。
  cfg.createUserMessage = typeof config.createUserMessage === 'function' ? config.createUserMessage : null;
  // embedding 由 embedding.mjs 自己归一化（enabled 默认 false、modelPath 必填）。
  cfg.embedding = config.embedding && typeof config.embedding === 'object' ? { ...config.embedding } : { enabled: true };
  cfg.evidencePackage = cfg.evidencePackage !== false;
  cfg.evidenceAuditKey = config.evidenceAuditKey && (Buffer.isBuffer(config.evidenceAuditKey) || typeof config.evidenceAuditKey === 'string')
    ? config.evidenceAuditKey
    : null;
  return cfg;
}

function sessionKey(agent) {
  return String(agent?.session?.id ?? agent?.id ?? 'unknown');
}

function isSubagent(payload) {
  const agent = payload?.agent;
  return agent?.session?.header?.origin === 'subagent'
    || agent?.origin === 'subagent'
    || payload?.origin === 'subagent';
}

function userTexts(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!isRealUserMessage(m)) continue; // 注入消息 / runtime-context 都不是用户的话
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b?.type === 'text' && typeof b.text === 'string') out.push(b.text);
    }
  }
  return out;
}

function firstTextOf(data) {
  for (const b of Array.isArray(data?.content) ? data.content : []) {
    if (b?.type === 'text' && typeof b.text === 'string') return b.text;
  }
  return typeof data?.text === 'string' ? data.text : null;
}

export function apply(ctx, config = {}) {
  const cfg = normalize(config);
  if (cfg.autoRecall === false) return; // ← 总开关：autoRecall:false 时不注册任何钩子

  const warn = (...a) => {
    if (cfg.log && ctx?.logger?.warn) ctx.logger.warn('[auto-recall]', ...a);
  };

  // A3：懒加载的本地 embedding；enabled=false 时 create 只做归一化，不碰磁盘/模型。
  const embedding = createEmbeddingRuntime(cfg.embedding, { memoryRoot: cfg.memoryRoot, warn });
  let embeddingWarned = false;
  // S3（审计 P1-7）：embedding 静默回退时把 channel 标成 degraded；只影响日志，不影响检索。
  let embeddingDegraded = false;

  // A4：「本轮想起」日志（面板读这个）。固定落在 memoryRoot/.longlive/recall-log.jsonl，
  // 一行一轮；写失败只警告一次，绝不影响注入。
  // S3：每行补 why/eligible/dropped/gate/trigger/channel，见 ./explain.mjs。
  const recallLogPath = cfg.memoryRoot ? join(cfg.memoryRoot, '.longlive', 'recall-log.jsonl') : '';
  let recallLogWarned = false;
  const logRecall = (sessionId, turn, result, explain = {}) => {
    if (!recallLogPath) return;
    try {
      const line = buildRecallLogRecord({
        sessionId,
        turn,
        result: result ?? null,
        gate: explain.gate ?? null,
        everyNTurns: explain.everyNTurns ?? cfg.everyNTurns,
        error: explain.error === true,
        factoryUnavailable: explain.factoryUnavailable === true,
        embeddingDegraded: explain.embeddingDegraded === true,
        injectedItems: explain.injectedItems,
      });
      mkdirSync(dirname(recallLogPath), { recursive: true });
      appendFileSync(recallLogPath, JSON.stringify(line) + '\n');
    } catch (error) {
      if (!recallLogWarned) {
        recallLogWarned = true;
        warn('RECALL_LOG_FAILED', error?.code ?? error?.message ?? error);
      }
    }
  };

  // B2: entity alias registry is read lazily (missing file => no-op, no latency).
  let entityAliasesCache = null;
  const getEntityAliases = () => {
    if (entityAliasesCache !== null) return entityAliasesCache;
    try {
      entityAliasesCache = readEntityAliases({ memoryRoot: cfg.memoryRoot });
    } catch {
      entityAliasesCache = { present: false, aliases: {} };
    }
    return entityAliasesCache;
  };

  const states = new Map();
  const stateFor = (key) => {
    let st = states.get(key);
    if (!st) {
      st = { turn: 0, seen: new Set(), lastQuery: '', compacted: false, warned: false, firstUserText: '', sharedInjected: false };
      states.set(key, st);
    }
    return st;
  };

  /** Cheap mtime/size signature so new or edited cards are visible next turn. */
  const cardSignature = () => {
    const parts = [];
    const walk = (dir) => {
      let entries = [];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && /\.md$/i.test(entry.name)) {
          try {
            const st = statSync(full);
            parts.push(`${full}:${st.mtimeMs}:${st.size}:${sampleContentHash(full, st.size)}`);
          } catch { /* unreadable card is not part of the signature */ }
        }
      }
    };
    for (const dir of cfg.dirs) walk(join(cfg.memoryRoot, dir));
    parts.sort();
    return parts.join('|');
  };

  let cards = null;
  let cardsSignature = '';
  const getCards = () => {
    const signature = cardSignature();
    if (cards && signature === cardsSignature) return cards;
    cardsSignature = signature;
    cards = null;
    try {
      cards = loadCards(cfg.memoryRoot, { dirs: cfg.dirs });
    } catch (error) {
      try {
        cards = loadCards(cfg.memoryRoot, { dirs: ['topics'] });
      } catch {
        cards = [];
        warn('CARDS_LOAD_FAILED', error?.code ?? error?.message ?? error);
      }
    }
    // 块状 scope_in 被解析成空（或其它 frontmatter 形态可疑）时，别静默当 noScope。
    const suspicious = cards.filter((c) => Array.isArray(c.warnings) && c.warnings.length > 0);
    if (suspicious.length > 0) {
      warn('CARD_FRONTMATTER_WARNING', suspicious.map((c) => `${c.path}: ${c.warnings.join('; ')}`).join(' | '));
    }
    return cards;
  };

  let createUserMessage = null;
  const getCreateUserMessage = async () => {
    if (cfg.createUserMessage) return cfg.createUserMessage;
    if (createUserMessage) return createUserMessage;
    try {
      const mod = await import('@deepseek-ai/dsh-llm');
      if (typeof mod?.createUserMessage === 'function') createUserMessage = mod.createUserMessage;
    } catch (error) {
      warn('CREATE_MESSAGE_UNAVAILABLE', error?.code ?? error?.message ?? error);
    }
    return createUserMessage;
  };

  const observe = (row) => {
    if (!cfg.observePath) return;
    try {
      mkdirSync(dirname(cfg.observePath), { recursive: true });
      appendFileSync(cfg.observePath, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
    } catch {
      /* 观测失败绝不影响注入 */
    }
  };

  /**
   * 显式 prepend:false —— identity-router（prepend:true）在外层先跑，并会在
   * `next()` 之前把开机卡插到第一条真实 user 消息之后（不是最前，TurnNavigator
   * 取该轮第一个 kind==='user' 节点作 prompt）；本内层 handler 通过
   * decision.messages 看到它，最后把自动想起 append 到末尾。
   */
  ctx.on('agent/pre-step', async (payload, next) => {
    const started = Date.now();
    const decision = await next(); // waterfall：先让下游决定
    if (!decision || decision.kind === 'reject') return decision;
    if (Number(payload?.step) !== 1) return decision;
    if (cfg.skipSubagents && isSubagent(payload)) return decision;

    const key = sessionKey(payload?.agent);
    const st = stateFor(key);
    const messages = Array.isArray(decision.messages) ? decision.messages : [];
    const turn = Number.isFinite(Number(payload?.turn)) ? Number(payload.turn) : st.turn + 1;
    // M2-C R1–R6: shared visibility block is injected on the FIRST turn only.
    const rawSharedNow = payload?.at ?? payload?.eventTime ?? payload?.now ?? null;
    const sharedNow = rawSharedNow === null || rawSharedNow === undefined
      ? Date.now()
      : (Number.isFinite(Number(rawSharedNow)) ? Number(rawSharedNow) : (Date.parse(String(rawSharedNow)) || Date.now()));
    let sharedMessage = null;
    let sharedVisibilityResult = null;
    const attachShared = (value) => (sharedMessage === null ? value : { ...value, messages: mergeInjectionOrder(Array.isArray(value?.messages) ? value.messages : messages, sharedMessage) });

    // B3: recall phase wraps the whole recall decision/injection (timing only).
    let gateInfo = null;
    const recallPhase = startPrestepPhase(key, turn, 'recall');
    try {
      if (turn === 1 && st.sharedInjected !== true && cfg.memoryRoot) {
        try {
          const visibility = sharedVisibility({
            memoryRoot: cfg.memoryRoot,
            currentSessionId: payload?.agent?.session?.id ?? key,
            now: sharedNow,
            privacyScan,
          });
          if (visibility && visibility.block) {
            const factory = await getCreateUserMessage();
            if (factory) {
              sharedMessage = assertInjectionMessage(factory({ content: [{ type: 'text', text: visibility.block }], source: injectionSource() }));
              sharedVisibilityResult = { count: visibility.count, chars: visibility.block.length, sessions: visibility.sessions.map((session) => session.sessionId) };
              st.sharedInjected = true;
            }
          }
        } catch { /* shared visibility must never block the turn */ }
      }
      const recentTexts = userTexts(messages).slice(-2);
      const queryText = buildQueryText({
        firstUserText: st.firstUserText,
        recentTexts,
        cwd: process.cwd(),
      });
      // B2: entity aliases + anaphora expansion run before retrieval (read-only channels).
      const aliases = getEntityAliases();
      const aliasResolution = aliases.present ? resolveEntityAliases(queryText, aliases.aliases) : { terms: [], matches: [] };
      const entityExpanded = expandQueryWithEntities(queryText, aliasResolution);
      const anaphora = resolveAnaphora({ text: queryText, recentTexts });
      const anaphoraExpanded = expandQueryWithAnaphora(entityExpanded.text, anaphora);
      const expandedQuery = anaphoraExpanded.text;
      // Event time only when the host/pre-step provides it; never Date.now() here.
      const rawEventNow = payload?.at ?? payload?.eventTime ?? payload?.now ?? null;
      const eventNow = rawEventNow === null || rawEventNow === undefined
        ? null
        : (Number.isFinite(Number(rawEventNow)) ? Number(rawEventNow) : (Date.parse(String(rawEventNow)) || null));
      const queryTimeRefs = eventNow === null ? [] : extractTimeRefs(queryText, { now: eventNow });

      const gate = decideTrigger({
        step: Number(payload?.step),
        turn,
        queryText,
        state: { lastQueryText: st.lastQuery, compactedSinceLast: st.compacted },
        options: { everyNTurns: cfg.everyNTurns },
      });
      gateInfo = gate;
      if (!gate.recall) {
        notePrestepDegrade(key, turn, { kind: 'gate-skip', phase: 'recall', detail: gate.why });
        logRecall(key, turn, null, { gate, everyNTurns: cfg.everyNTurns });
        observe({ key, turn, why: gate.why, queryChars: queryText.length, tokens: 0, ms: Date.now() - started });
        return attachShared(decision);
      }

      const loaded = getCards();
      // 1.8.2 D2: auto-cards are no longer read as recall candidates.
      const loadedForRecall = loaded;
      // 路径级排除：identity-router 本轮已经注入过的卡，不再注入第二遍。
      // 不再无条件排除首轮 handover/：没装 identity-router 时那张卡就是唯一开机卡。
      const seen = [...new Set([
        ...st.seen,
        ...identityInjectedPaths(messages, { cards: loaded }),
      ])];

      // A3：只有 embedding.enabled 且本地模型/依赖真的可用时才加向量；任何失败
      // （模型缺失、onnxruntime-node 没装、tokenizer 坏）都静默退回纯关键词。
      let queryVector = null;
      let vectors = null;
      if (embedding.enabled) {
        try {
          const ready = await embedding.ensure(loaded, { signature: cardsSignature });
          if (ready.ok) {
            queryVector = await embedding.embedQuery(queryText);
            vectors = ready.cardVectors;
          } else if (!embeddingWarned) {
            embeddingWarned = true;
            embeddingDegraded = true;
            notePrestepDegrade(key, turn, { kind: 'embedding-fallback', phase: 'recall', detail: ready.code ?? 'not-ready' });
            warn('EMBEDDING_FALLBACK', ready.code, ready.message);
          }
        } catch (error) {
          if (!embeddingWarned) {
            embeddingWarned = true;
            embeddingDegraded = true;
            notePrestepDegrade(key, turn, { kind: 'embedding-fallback', phase: 'recall', detail: String(error?.code ?? error?.message ?? error) });
            warn('EMBEDDING_FALLBACK', error?.code ?? error?.message ?? error);
          }
        }
      }

      // B3: budget phase = ranking + budget trimming inside chooseRecall.
      const budgetPhase = startPrestepPhase(key, turn, 'budget');
      const recallInput = {
        queryText: expandedQuery,
        cards: loadedForRecall,
        queryVector,
        vectors,
        budget: cfg.budget,
        seenPaths: seen,
        injectedTexts: collectInjectedTexts(messages),
        options: {
          maxItems: cfg.maxItems,
          minScore: cfg.minScore,
          privacyPolicy: cfg.privacyPolicy,
          privacyScan,
          trace: true,
          // B2 channels: neutral when empty (legacy ordering unchanged).
          queryTimeRefs,
          entityAliases: aliases.present ? aliases.aliases : undefined,
          fusion: {
            keywordWeight: embedding.config.keywordWeight,
            vectorWeight: embedding.config.vectorWeight,
            semanticAdmit: embedding.config.semanticAdmit,
            minFusedScore: embedding.config.minFusedScore,
          },
        },
      };
      let result = chooseRecall(recallInput);
      budgetPhase.end();
      // 1.8.0 two-layer quota: at most 2 curated cards + 1 AutoCard per turn;
      // curated hits always render first (tier weight 1.12 only affects order
      // inside the curated layer, so existing output stays stable).
      if (Array.isArray(result.items) && result.items.length > 0) {
        const isAuto = (item) => String(item?.path ?? '').startsWith('auto:');
        let curatedItems = result.items.filter((item) => !isAuto(item))
          .sort((a, b) => (b.score * 1.12) - (a.score * 1.12));
        const eventItems = result.items.filter(isAuto).slice(0, 1);
        // Curated floor: event cards may never squeeze curated cards out.
        if (curatedItems.length === 0 && loaded.length > 0) {
          const curatedOnly = chooseRecall({ ...recallInput, cards: loaded });
          if (curatedOnly.items.length > 0) {
            result = curatedOnly;
            curatedItems = curatedOnly.items.slice().sort((a, b) => (b.score * 1.12) - (a.score * 1.12));
          }
        }
        result.items = [...curatedItems.slice(0, 2), ...eventItems].slice(0, cfg.maxItems);
      }
      // M2-C #6: every recall decision atomically publishes .longlive/evidence/latest.json.
      let evidencePackage = null;
      if (cfg.evidencePackage && cfg.memoryRoot) {
        try {
          const nowIso = new Date().toISOString();
          const fast = fastAnswerFromRecallItems({ question: queryText, items: result.items });
          const pkg = buildEvidencePackage({
            sessionId: payload?.agent?.session?.id ?? key,
            turn,
            query: queryText,
            timings: {
              questionAt: eventNow === null ? null : new Date(eventNow).toISOString(),
              queueMs: 0,
              prefetchAt: new Date(started).toISOString(),
              retrievedAt: nowIso,
              evidenceReadyAt: nowIso,
            },
            anchors: result.items.map((item) => ({
              path: item.path,
              excerpt: `${item.title ?? ''} — ${item.excerpt ?? ''}`.trim(),
              score: Number.isFinite(Number(item.score)) ? Number(item.score) : null,
              l0Status: 'card',
            })),
            status: result.items.length > 0 ? 'ready' : 'no_evidence',
            fastAnswer: fast.fastAnswer === null ? null : { text: fast.fastAnswer.text, valueType: fast.fastAnswer.valueType, anchor: fast.fastAnswer.anchor },
            fallback: { used: false, reason: result.items.length > 0 ? null : 'zero-hit' },
          });
          const written = writeEvidencePackage({ memoryRoot: cfg.memoryRoot, pkg, auditKey: cfg.evidenceAuditKey });
          evidencePackage = { queryId: pkg.queryId, status: pkg.status, anchors: pkg.anchors.length, fastAnswer: pkg.fastAnswer !== null, packageSha256: written.packageSha256 };
        } catch (error) {
          // Write failure must never block injection.
          evidencePackage = { error: error?.code ?? 'E_EVIDENCE_WRITE' };
          notePrestepDegrade(key, turn, { kind: 'evidence-write', phase: 'recall', detail: String(error?.code ?? error?.message ?? error) });
          warn('EVIDENCE_WRITE_FAILED', error);
        }
      }
      if (Number(result?.hits?.droppedByBudget ?? 0) > 0) {
        notePrestepDegrade(key, turn, { kind: 'budget-trim', phase: 'budget', detail: `dropped=${result.hits.droppedByBudget}` });
      }
      setPrestepMeta(key, turn, {
        budget: cfg.budget,
        eligible: Number(result?.hits?.eligible ?? 0),
        tokens: Number(result?.tokens ?? 0),
      });

      // A5 unified audit: every real recall decision lands one .longlive/audit/records.jsonl row.
      try {
        appendAuditRecord({
          memoryRoot: cfg.memoryRoot,
          action: 'recall',
          recordId: result.items.length > 0 ? result.items.map((item) => item.path).join(',') : null,
          readerTier: 'host',
          questionId: 'unknown',
          expectedTurns: null,
          answerText: null,
          extra: {
            turn,
            queryChars: queryText.length,
            expanded: expandedQuery !== queryText,
            expansion: { entityTerms: aliasResolution.terms ?? [], anaphoraTerms: anaphora.terms ?? [], timeRefs: queryTimeRefs.length },
            sharedVisibility: sharedVisibilityResult,
            evidencePackage,
            eligible: result.hits.eligible,
            injected: result.items.map((item) => item.path),
            tokens: result.tokens,
          },
        });
      } catch { /* recall auditing must never block injection */ }
      if (result.items.length === 0) {
        notePrestepDegrade(key, turn, { kind: 'zero-hit', phase: 'recall', detail: `eligible=${result.hits.eligible}` });
        st.lastQuery = queryText;
        st.compacted = false;
        logRecall(key, turn, result, { gate, everyNTurns: cfg.everyNTurns, embeddingDegraded });
        observe({
          key, turn, why: gate.why, queryChars: queryText.length,
          eligible: result.hits.eligible, injected: [], tokens: 0, ms: Date.now() - started,
          dropped: {
            budget: result.hits.droppedByBudget,
            dedupe: result.hits.droppedByDedupe,
            seen: result.hits.droppedBySeen,
            localOnly: result.hits.droppedLocalOnly,
            privacy: result.hits.droppedByPrivacy,
          },
        });
        return attachShared(decision); // 无命中：什么都不注入（共享可见块仍可注入）
      }

      // B3: inject phase = render + message factory + merge into decision.messages.
      const injectPhase = startPrestepPhase(key, turn, 'inject');
      const text = renderInjection(result, { privacyScan });
      const factory = await getCreateUserMessage();
      if (!factory) {
        injectPhase.end();
        notePrestepDegrade(key, turn, { kind: 'factory-unavailable', phase: 'inject' });
        logRecall(key, turn, result, { gate, everyNTurns: cfg.everyNTurns, embeddingDegraded, factoryUnavailable: true, injectedItems: [] });
        return decision;
      }

      // M1 修法：session-reference 是宿主的隐藏注入 kind——不渲染用户气泡，
      // deriveMessages 仍含正文；references:[] 让渲染层退化成 opaque 行而不抛。
      const message = assertInjectionMessage(factory({
        content: [{ type: 'text', text }],
        source: injectionSource(),
      }));

      for (const item of result.items) st.seen.add(item.path);
      st.lastQuery = queryText;
      st.compacted = false;
      injectPhase.end();

      logRecall(key, turn, result, { gate, everyNTurns: cfg.everyNTurns, embeddingDegraded });
      observe({
        key, turn, why: gate.why, queryChars: queryText.length, eligible: result.hits.eligible,
        injected: result.items.map((i) => i.path), tokens: result.tokens, budget: cfg.budget,
        ms: Date.now() - started,
        dropped: {
          budget: result.hits.droppedByBudget,
          dedupe: result.hits.droppedByDedupe,
          seen: result.hits.droppedBySeen,
          localOnly: result.hits.droppedLocalOnly,
          privacy: result.hits.droppedByPrivacy,
        },
      });

      return { ...decision, messages: mergeInjectionOrder(sharedMessage === null ? messages : mergeInjectionOrder(messages, sharedMessage), message) };
    } catch (error) {
      if (!st.warned) {
        st.warned = true;
        warn('RECALL_FAILED', error?.code ?? error?.message ?? error);
      }
      notePrestepDegrade(key, turn, { kind: 'error', phase: 'recall', detail: String(error?.code ?? error?.message ?? error) });
      observe({ key, turn, why: 'error', error: String(error?.code ?? error?.message ?? error), tokens: 0 });
      logRecall(key, turn, null, { gate: gateInfo, everyNTurns: cfg.everyNTurns, error: true });
      return attachShared(decision); // 插件失败不许拖垮本轮
    } finally {
      try { recallPhase.end(); } catch { /* timing only */ }
    }
  }, { prepend: false });

  // 首条用户消息 + 轮数 + 压缩标记
  ctx.on('session/event', (session, event) => {
    try {
      const st = stateFor(session?.id ?? 'unknown');
      if (event?.type === 'user/message' && isRealUserMessage(event?.data)) {
        const text = firstTextOf(event?.data);
        // 复核第三轮 mustFix #1：注入的【开机卡】/【自动想起】也是 user/message，
        // 旧代码只看 type 就把它们当成 firstUserText，导致之后每轮 query 都混进开机卡。
        //
        // v4 / ADV1：外部插件仍可能用 kind:'user' 把一段上下文插到真实提问**之前**。
        // 无法凭正文识别任意外来文本，所以第 1 轮（turn/end 之前）按「最后一条真人
        // 消息」锁定：注入按惯例 prepend，排在提问前，最后一条才是本轮被回答的提问。
        if (text && (st.firstUserText === '' || st.turn === 0)) st.firstUserText = text;
      }
      if (event?.type === 'turn/end') {
        const t = Number(event?.data?.turn);
        st.turn = Number.isFinite(t) ? Math.max(st.turn, t) : st.turn + 1;
      }
      if (/compaction/i.test(String(event?.type ?? ''))) st.compacted = true; // 上线前先核事件名（WIRING §8）
    } catch (error) {
      warn('EVENT_HANDLER_FAILED', error?.message ?? error);
    }
  });

  ctx.on('session/disposed', (session) => {
    states.delete(session?.id ?? 'unknown');
  });
}
