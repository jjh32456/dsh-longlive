// identity-router v0 — 宿主插件入口
//
// 两条能力：
//   1. agent/pre-step（step === 1）把「开机卡」插到第一条真实 user 消息之后；
//   2. session/event 的 turn/end 与 session/disposed 把交接卡草稿写进 outbox。
//
// 顺序契约（复核第三轮 mustFix #2）：本插件用 `{ prepend:true }` 注册，是 Cordis
// waterfall 的最外层。开机卡必须在 `await next()` **之前** 原地插入
// `payload.messages`，因为宿主 inner 闭包引用的是同一个 claimed 数组；等 next()
// 回来再 append 会得到 `[user, runtime, auto, boot]`（auto 在内层看不到 boot）。
// 但插入位置不是最前：宿主 TurnNavigator 取该轮第一个可见 user 节点做
// tooltip（client.js:8373-8383），boot 在首位会让第 1 轮显示【开机卡】。
// 目标顺序：`[user, boot, runtime, auto]`。
//
// source.kind（复核第四轮 M1）：用宿主的隐藏注入 kind
// `{ kind:'session-reference', form:'recall', version:1, references:[] }`。
// 宿主把它投影成 context 节点，isVisibleChatNode=false：聊天里不再出现
// 【开机卡】用户气泡，但 deriveMessages 仍含正文。可见性由潜望镜面板承担
// （后续页签，见 README「可见性」）。写入前过 assertInjectionSource()：
// 坏 kind 直接拒绝，不进 session 日志（append 接受，adopt 会抛 invalid source）。
//
// 设计原则：插件失败不能拖垮会话。所有 IO 都包在 try/catch 里，注入工厂拿不到就跳过。

import { collectOpenCard } from './handover.js';
import { assertInjectionSource, injectionSource, insertionIndex, placeAfterFirstHuman, sameMessageOrder } from './inject-position.js';
import { writeHandoverFromState } from './writeback.js';
import { startPrestepPhase } from '../metrics/prestep-latency.mjs';

export const name = 'dsh-identity-router';

/** 本插件不强制依赖任何 Cordis 服务；注入的消息走动态 import，拿不到就降级。 */
export const inject = [];

const DRAFT_TOPIC_PREFIX = 'identity-router';

/**
 * 配置归一化；所有字段都有默认值，坏值不抛。
 * @param {Record<string, unknown>} [config]
 * @returns {{
 *   enabled:boolean, injectOnStart:boolean, maxChars:number,
 *   memoryRoot:string|undefined, statePath:string|undefined,
 *   handoverDir:string|undefined, outboxDir:string|undefined,
 *   writeOnTurnEnd:boolean, writeEveryTurns:number, writeOnSessionEnd:boolean,
 *   skipSubagents:boolean, log:boolean, createUserMessage:Function|null,
 * }}
 */
export function normalizeConfig(config = {}) {
  const value = config && typeof config === 'object' ? config : {};
  const clampInt = (input, fallback, min, max) => {
    const number = Number(input);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(number)));
  };
  const text = (input) => (typeof input === 'string' && input.trim() !== '' ? input.trim() : undefined);

  return {
    enabled: value.enabled !== false,
    injectOnStart: value.injectOnStart !== false,
    maxChars: clampInt(value.maxChars, 800, 120, 4000),
    memoryRoot: text(value.memoryRoot),
    statePath: text(value.statePath),
    handoverDir: text(value.handoverDir),
    outboxDir: text(value.outboxDir),
    writeOnTurnEnd: value.writeOnTurnEnd !== false,
    writeEveryTurns: clampInt(value.writeEveryTurns, 5, 0, 1000),
    writeOnSessionEnd: value.writeOnSessionEnd !== false,
    skipSubagents: value.skipSubagents !== false,
    log: value.log === true,
    createUserMessage: typeof value.createUserMessage === 'function' ? value.createUserMessage : null,
  };
}

/**
 * 会话键：优先 session.id，退 agent.id。没有稳定键时用 'unknown'（只影响缓存粒度）。
 * @param {any} agent
 * @returns {string}
 */
export function sessionKeyFor(agent) {
  const id = agent?.session?.id ?? agent?.id;
  return typeof id === 'string' && id !== '' ? id : 'unknown';
}

/**
 * 子代理判定：外部记忆插件用 header.origin === 'subagent'，这里照抄并兼容 session 参数。
 * @param {any} sessionOrAgent
 * @returns {boolean}
 */
export function isSubagentSession(sessionOrAgent) {
  const header = sessionOrAgent?.header ?? sessionOrAgent?.session?.header;
  return header?.origin === 'subagent';
}

/**
 * 文件名用的短会话 id：只留字母数字，取后 8 位。
 * @param {any} session
 * @returns {string}
 */
export function shortSessionId(session) {
  const raw = String(session?.id ?? session?.session?.id ?? 'session');
  const lastSegment = raw.split(/[-_.:]/u).filter(Boolean).pop() ?? raw;
  const cleaned = lastSegment.replace(/[^a-zA-Z0-9]/gu, '').slice(-8);
  if (cleaned !== '') return cleaned;
  const fallback = raw.replace(/[^a-zA-Z0-9]/gu, '');
  return fallback.slice(-8) || 'session';
}

/**
 * 插件入口。
 * @param {any} ctx Cordis context
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const settings = normalizeConfig(config);
  if (!settings.enabled) return;

  const logger = ctx?.logger && typeof ctx.logger.warn === 'function' ? ctx.logger : console;
  const logInfo = (...args) => {
    if (settings.log) {
      if (typeof logger.info === 'function') logger.info('[identity-router]', ...args);
      else console.info('[identity-router]', ...args);
    }
  };
  const logWarn = (...args) => {
    if (typeof logger.warn === 'function') logger.warn('[identity-router]', ...args);
    else console.warn('[identity-router]', ...args);
  };

  /** @type {Map<string, {cardText:string, warnings:string[], opened:boolean, turns:number, lastDraftTurn:number|null, finalWritten:boolean, startSource:string|null}>} */
  const states = new Map();
  const warned = new Set();

  const stateFor = (key) => {
    let record = states.get(key);
    if (!record) {
      record = {
        cardText: '',
        warnings: [],
        opened: false,
        turns: 0,
        lastDraftTurn: null,
        finalWritten: false,
        startSource: null,
      };
      states.set(key, record);
    }
    return record;
  };

  let factory = settings.createUserMessage;
  let factoryTried = Boolean(factory);

  const getCreateUserMessage = async () => {
    if (factoryTried) return factory;
    factoryTried = true;
    try {
      const mod = await import('@deepseek-ai/dsh-llm');
      if (typeof mod?.createUserMessage === 'function') {
        factory = mod.createUserMessage;
      } else {
        logWarn('INJECT_SKIPPED: @deepseek-ai/dsh-llm 没有导出 createUserMessage');
      }
    } catch (error) {
      logWarn(`INJECT_SKIPPED: 无法加载 @deepseek-ai/dsh-llm (${error?.code ?? error?.message ?? error})`);
    }
    return factory;
  };

  const buildCardFor = (agent) => {
    const key = sessionKeyFor(agent);
    const record = stateFor(key);
    if (record.cardText !== '') return record;

    try {
      const card = collectOpenCard({
        memoryRoot: settings.memoryRoot,
        statePath: settings.statePath,
        handoverDir: settings.handoverDir,
        maxChars: settings.maxChars,
      });
      record.cardText = card.text;
      record.warnings = card.warnings ?? [];
      if (card.warnings?.length > 0) {
        logInfo(`open card warnings: ${card.warnings.join(', ')}`);
      }
    } catch (error) {
      record.cardText = '';
      record.warnings = [`CARD_BUILD_FAILED:${error?.code ?? error?.message ?? error}`];
      logWarn(`开机卡生成失败：${record.warnings[0]}`);
    }
    return record;
  };

  const writeDraft = (session, reason, turn = null) => {
    try {
      const result = writeHandoverFromState({
        memoryRoot: settings.memoryRoot,
        statePath: settings.statePath,
        outboxDir: settings.outboxDir,
        topic: `${DRAFT_TOPIC_PREFIX}-${shortSessionId(session)}`,
        source: `identity-router:${reason}${turn === null ? '' : ` turn=${turn}`}`,
        now: new Date(),
      });
      if (result.ok) logInfo(`draft written: ${result.path}`);
      else logWarn(`draft write failed: ${result.error ?? 'unknown'}`);
      return result;
    } catch (error) {
      logWarn(`draft write threw: ${error?.code ?? error?.message ?? error}`);
      return { ok: false, path: null };
    }
  };

  // 会话创建：只记录来源，真正的卡片在 pre-step 首次需要时生成。
  // （agent/created 里改不了消息；systemPrompt 的全局 context 又无法按会话区分。）
  ctx.on('agent/created', (payload) => {
    try {
      const key = sessionKeyFor(payload?.agent);
      const record = stateFor(key);
      record.startSource = typeof payload?.source === 'string' ? payload.source : null;
      logInfo(`agent created: key=${key} source=${record.startSource ?? 'unknown'}`);
    } catch (error) {
      logWarn(`agent/created handler failed: ${error?.code ?? error?.message ?? error}`);
    }
  });

  // 开机注入：waterfall。prepend:true = 最外层；开机卡必须在 next() 之前进数组，
  // 内层（auto-recall）才看得到。位置是「第一条真实 user 消息之后」，不是最前：
  // 宿主 TurnNavigator 取该轮第一个可见 user 节点做 tooltip，boot 不能抢这个位置。
  // reject / 异常时把消息撤回，保持原决策。source 用隐藏的 session-reference（M1）。
  ctx.on('agent/pre-step', async (payload, next) => {
    if (!settings.injectOnStart) return next();
    if (Number(payload?.step) !== 1) return next();

    const agent = payload?.agent;
    if (!agent) return next();
    if (settings.skipSubagents && isSubagentSession(agent)) return next();

    // B3: boot phase = card collection + in-place splice (timing only; no behavior change).
    const bootPhase = startPrestepPhase(sessionKeyFor(agent), payload?.turn, 'boot');
    const endBootPhase = () => { try { bootPhase.end(); } catch { /* timing only */ } };

    const record = buildCardFor(agent);
    if (record.opened || record.cardText.trim() === '') { endBootPhase(); return next(); }

    const createUserMessage = await getCreateUserMessage();
    if (!createUserMessage) { endBootPhase(); return next(); }

    let message;
    try {
      message = assertInjectionSource(createUserMessage({
        content: [{ type: 'text', text: record.cardText }],
        source: injectionSource(),
      }));
    } catch (error) {
      if (!warned.has('inject')) {
        warned.add('inject');
        logWarn(`INJECT_FAILED: ${error?.code ?? error?.message ?? error}`);
      }
      endBootPhase();
      return next();
    }

    // 宿主 preStep 的 inner 闭包引用 claimed 原数组；原地 splice 才能让内层看到。
    // 插到第一条真实 user 之后；本轮没有真实 user 时才退化为下标 0。
    const claimed = Array.isArray(payload?.messages) ? payload.messages : null;
    if (claimed) claimed.splice(insertionIndex(claimed), 0, message);

    const withdraw = () => {
      if (!claimed) return;
      const index = claimed.indexOf(message);
      if (index !== -1) claimed.splice(index, 1);
    };

    endBootPhase(); // boot own work done; downstream phases are attributed by their own handlers

    let decision;
    try {
      decision = await next();
    } catch (error) {
      withdraw();
      throw error;
    }

    if (!decision || decision.kind === 'reject') {
      withdraw();
      return decision;
    }

    record.opened = true;
    logInfo(`open card injected: ${record.cardText.length} chars, turn=${payload?.turn ?? '?'}`);

    const messages = Array.isArray(decision.messages) ? decision.messages : [];
    const ordered = placeAfterFirstHuman(messages, message);
    if (sameMessageOrder(messages, ordered)) return decision;
    // 兜底：宿主的 inner 没有把 claimed 原样返回时，至少保证 boot 在第一条真实 user 之后。
    return { ...decision, messages: ordered };
  }, { prepend: true });

  // 回合计数与周期性草稿。
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'turn/end') return;
      if (settings.skipSubagents && isSubagentSession(session)) return;

      const key = session?.id ?? 'unknown';
      const record = stateFor(key);
      const turn = Number(event?.data?.turn);
      if (Number.isFinite(turn)) record.turns = Math.max(record.turns, turn);
      else record.turns += 1;

      if (!settings.writeOnTurnEnd || settings.writeEveryTurns <= 0) return;
      if (record.turns === 0 || record.turns % settings.writeEveryTurns !== 0) return;
      if (record.lastDraftTurn === record.turns) return;

      record.lastDraftTurn = record.turns;
      writeDraft(session, 'turn-end', record.turns);
    } catch (error) {
      logWarn(`session/event handler failed: ${error?.code ?? error?.message ?? error}`);
    }
  });

  // 会话销毁：最后一次草稿。进程被强杀时不会触发，这一点写进 FEASIBILITY.md。
  ctx.on('session/disposed', (session) => {
    try {
      const key = session?.id ?? 'unknown';
      const record = stateFor(key);
      if (record.finalWritten) return;
      record.finalWritten = true;
      if (settings.skipSubagents && isSubagentSession(session)) return;
      if (!settings.writeOnSessionEnd) return;
      writeDraft(session, 'session-disposed', record.turns > 0 ? record.turns : null);
    } catch (error) {
      logWarn(`session/disposed handler failed: ${error?.code ?? error?.message ?? error}`);
    }
  });

  logInfo(`applied (maxChars=${settings.maxChars}, writeEveryTurns=${settings.writeEveryTurns})`);
}
