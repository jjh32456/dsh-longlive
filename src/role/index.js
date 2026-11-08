// src/role/index.js — 角色内核装配（v2.8 §16.3；1.8.0 默认 ON + 独立 kill switch）
//
// 1.8.0 角色内核 = attention queue + channel adapter + relationship graph +
// personality projection + 三接口（src/role/interfaces.js）。
//
// 激活纪律（任务「功能没跑起来就等于没实现」）：
//   - `role.enabled` 由 config schema 默认 **true**（1.8.0 默认 ON）；显式
//     `role.enabled === false` 是**独立 kill switch**：不注册 hook、不建目录、零 IO。
//   - 开启后按子开关注册，且每个组件都有**运行期真实调用**（不是只有测试直接调 readers）：
//       attention.enabled    -> session/event 生产者：真事件 → attention.jsonl 行（P0/P1/P2）
//       relationships.enabled-> 同一 hook 在 user/message 上真实做 tier/recall-weight 查询
//       channels.enabled     -> 同一 hook touch 宿主持久渠道（lastSeenAt 落盘）+ 注册表
//       personality.enabled  -> 首次生成快照 + systemPrompt.section 语气投影（每次取文真实读快照）
//   - registerRole 返回 `runtime` 计数器 + `probe()`：给 scripts/verify-activation.mjs 做
//     「开关 on / 真实调用 > 0 / 文件已落盘 / 注入 section 非空」的激活证据，而非单测自证。
//   - 所有 hook 内部 try/catch：角色层故障不得拖垮一个 turn。

import { createAttentionQueue, attentionPriorityOfKind, orderOpsItems, ATTENTION_DEFAULTS } from './attention.js';
import { createChannelRegistry, normalizeInboundMessage, CHANNEL_DEFAULTS } from './channels.js';
import { generatePersonalitySnapshot, readPersonality, toneProjection, PERSONALITY_DEFAULTS } from './personality.js';
import { readRelationships, RELATIONSHIP_DEFAULTS } from './relationships.js';
import { createRoleInterfaces, INTERFACE_CONTRACTS } from './interfaces.js';
import { iso, nowMs, tryRolePaths } from './store.js';
import { readAttentionView, readChannelsView } from './readers.js';
import fs from 'node:fs';

export const ROLE_FEATURE_NAME = 'role';
export const ROLE_SCHEMA_VERSION = 1;
export const ROLE_DEFAULTS = Object.freeze({
  // 1.8.0 默认 ON（任务）：功能必须真的跑起来；kill switch = 显式 false。
  enabled: true,
  attention: Object.freeze({ enabled: true, ...ATTENTION_DEFAULTS }),
  channels: Object.freeze({ enabled: true }),
  relationships: Object.freeze({ enabled: true }),
  personality: Object.freeze({ enabled: true, profilePaths: PERSONALITY_DEFAULTS.profilePaths }),
});
/** 启用角色内核时默认注册的宿主内 presence 渠道（没有 send，发送会降级）。 */
export const DEFAULT_HOST_CHANNELS = Object.freeze([
  Object.freeze({ id: 'web', type: 'web', capabilities: ['presence'] }),
  Object.freeze({ id: 'tool:host', type: 'tool', capabilities: ['presence'], meta: { channelKind: 'host-tool' } }),
]);

function bool(value, fallback) {
  if (value === undefined) return fallback;
  return value === true;
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

/** Normalize the `role` config block (does not touch normalizeFeatureConfig's shape). */
export function normalizeRoleConfig(config = {}) {
  const value = config && typeof config === 'object' ? config : {};
  const role = value.role && typeof value.role === 'object' ? value.role : {};
  const attention = role.attention && typeof role.attention === 'object' ? role.attention : {};
  const channels = role.channels && typeof role.channels === 'object' ? role.channels : {};
  const relationships = role.relationships && typeof role.relationships === 'object' ? role.relationships : {};
  const personality = role.personality && typeof role.personality === 'object' ? role.personality : {};
  const profilePaths = Array.isArray(personality.profilePaths)
    ? personality.profilePaths.filter((item) => typeof item === 'string' && item.trim() !== '')
    : [...ROLE_DEFAULTS.personality.profilePaths];
  return {
    // kill switch：只有显式 false 才关闭（默认 ON；字符串/缺省一律按开）。
    enabled: role.enabled === false ? false : ROLE_DEFAULTS.enabled,
    attention: {
      enabled: bool(attention.enabled, ROLE_DEFAULTS.attention.enabled),
      maxItems: clampInt(attention.maxItems, ATTENTION_DEFAULTS.maxItems, 1, 500),
      agingMs: clampInt(attention.agingMs, ATTENTION_DEFAULTS.agingMs, 0, 7 * 24 * 60 * 60 * 1000),
      demoteSteps: clampInt(attention.demoteSteps, ATTENTION_DEFAULTS.demoteSteps, 0, 2),
      injectMaxItems: clampInt(attention.injectMaxItems, ATTENTION_DEFAULTS.injectMaxItems, 1, 20),
    },
    channels: { enabled: bool(channels.enabled, ROLE_DEFAULTS.channels.enabled) },
    relationships: { enabled: bool(relationships.enabled, ROLE_DEFAULTS.relationships.enabled) },
    personality: {
      enabled: bool(personality.enabled, ROLE_DEFAULTS.personality.enabled),
      profilePaths,
    },
  };
}

function safeMessage(event) {
  const data = event?.data ?? {};
  const message = data.message && typeof data.message === 'object' ? data.message : data;
  return { data, message };
}

/**
 * Turn one host `session/event` into an attention row. Producers (v2.8 ①):
 *   user/message      -> P1 kind=user   subject=turn:<turn>
 *   tool/result error -> P0 kind=error  subject=tool:<name>
 *   turn/end failed   -> P0 kind=ops    subject=turn:<turn>:<reason>
 *   turn/end completed-> P2 kind=session subject=turn:<turn>:completed
 * Returns the enqueue result or null when the event is not an attention event.
 */
export function ingestSessionEvent(queue, session, event, now = () => new Date()) {
  const type = event?.type;
  const turn = Number.isInteger(event?.data?.turn) ? event.data.turn : (Number.isInteger(event?.turn) ? event.turn : 0);
  const at = iso(nowMs(now()));
  const sessionId = typeof session?.id === 'string' ? session.id : (typeof session?.header?.id === 'string' ? session.header.id : '');
  if (type === 'user/message') {
    return queue.enqueue({ kind: 'user', priority: 'P1', subject: `turn:${turn}`, source: `session/user${sessionId ? `:${sessionId}` : ''}`, at });
  }
  if (type === 'tool/result') {
    const { data, message } = safeMessage(event);
    const failed = message?.isError === true || data.isError === true;
    if (!failed) return null;
    const toolName = typeof data.name === 'string' && data.name !== '' ? data.name : 'unknown';
    return queue.enqueue({ kind: 'error', priority: 'P0', subject: `tool:${toolName}`, source: `session/tool${sessionId ? `:${sessionId}` : ''}`, at });
  }
  if (type === 'turn/end') {
    const reason = event?.data?.reason?.kind ?? 'completed';
    const failed = reason !== 'completed';
    return queue.enqueue({
      kind: failed ? 'ops' : 'session',
      priority: failed ? 'P0' : 'P2',
      subject: `turn:${turn}:${reason}`,
      source: `session/turn${sessionId ? `:${sessionId}` : ''}`,
      at,
    });
  }
  return null;
}

/** Convenience producer for memory write/recall events (`kind=ops` interface). */
export function recordAttentionEvent({ memoryRoot, now = () => new Date(), config = {}, priority, kind = 'ops', subject = '', source = 'memory' } = {}) {
  const queue = createAttentionQueue({ memoryRoot, now, config });
  return queue.enqueue({ priority, kind, subject, source });
}

/** Runtime identity for the relationship bridge (host/user best effort, deterministic fallback). */
function runtimePersonId(session, event) {
  const data = event?.data ?? {};
  const candidates = [
    data.userId,
    data.personId,
    data.actor,
    session?.header?.userId,
    session?.header?.actor,
    session?.userId,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return 'user:host';
}

/**
 * Register the role kernel on a host context.
 * 1.8.0 默认 ON（Config schema role.enabled=true）；显式 false 是独立 kill switch，
 * 关闭时零 hook / 零目录 / 零 IO。runtime/probe() 提供运行期真实调用证据。
 * @returns {{enabled:boolean, hooks:string[], modules:object, config:object, reason?:string, dispose:Function}}
 */
export function registerRole(ctx, config = {}, options = {}) {
  const cfg = normalizeRoleConfig(config);
  const memoryRoot = typeof options.memoryRoot === 'string' && options.memoryRoot.trim() !== ''
    ? options.memoryRoot.trim()
    : null;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const warn = typeof options.warn === 'function' ? options.warn : () => {};
  // §16.8：role/** 宿主私有写保护（auditKey 可注入；默认走 <memoryRoot>/.longlive/.hostkey）。
  const auditKey = options.auditKey ?? null;
  const actorKind = typeof options.actorKind === 'string' ? options.actorKind : 'host';
  const caller = options.caller ?? null;
  const subject = options.subject ?? undefined;
  const hooks = [];
  const disposers = [];
  const modules = { interfaces: null, attention: null, channels: null };
  const noop = () => {};

  if (!cfg.enabled) return { enabled: false, hooks, modules, config: cfg, reason: 'disabled', dispose: noop };
  if (memoryRoot === null) {
    return { enabled: false, hooks, modules, config: cfg, reason: 'no-memory-root', dispose: noop };
  }

﻿  modules.interfaces = createRoleInterfaces({ memoryRoot, now, caller, auditKey });

  // 运行期真实调用计数器（任务 激活证据）：只由真实 hook / 注入回调递增。
  const runtime = {
    eventsSeen: 0,
    attentionEnqueued: 0,
    relationshipLookups: 0,
    channelTouches: 0,
    personalityProjections: 0,
    hooks: 0,
    lastRelationship: null,
    lastAttentionSubject: null,
    lastProducedAt: null,
  };

  // ③ relationship graph：只读装配；写入走 G7 relationship.update。
  if (cfg.relationships.enabled) {
    modules.relationships = {
      read: () => readRelationships({ memoryRoot }),
      tierFor: modules.interfaces.relationship.tierOf,
      recallWeightFor: modules.interfaces.relationship.recallWeightFor,
      multiplierForTier: modules.interfaces.relationship.multiplierForTier,
      defaults: RELATIONSHIP_DEFAULTS,
    };
  }

  // ② channel adapter：宿主内注册表 + 能力协商 + 降级。
  if (cfg.channels.enabled) {
    const registry = createChannelRegistry({ memoryRoot, now, auditKey, actorKind });
    modules.channels = registry;
    const candidates = [...DEFAULT_HOST_CHANNELS, ...(Array.isArray(options.channels) ? options.channels : [])];
    for (const candidate of candidates) {
      try {
        registry.registerAdapter(candidate);
      } catch (error) {
        warn(`[role] 渠道注册失败 ${candidate?.id ?? '?'}（${error?.code ?? error?.message ?? error}）`);
      }
    }
    if (typeof options.channelSend === 'function') {
      try {
        registry.registerAdapter({
          id: 'tool:host',
          type: 'tool',
          capabilities: ['send', 'attachments'],
          send: options.channelSend,
          meta: { channelKind: 'host-tool' },
        });
      } catch (error) {
        warn(`[role] 宿主 send 适配器注册失败（${error?.code ?? error?.message ?? error}）`);
      }
    }
  }

  // ① attention queue：真实 session/event 生产者（hook 在 unified bridge 注册）。
  if (cfg.attention.enabled) {
    modules.attention = createAttentionQueue({ memoryRoot, now, config: cfg.attention, auditKey, actorKind });
  }

  // 统一 runtime bridge：真实 session/event → attention 入队 + relationship 查询 + channel touch。
  // 「运行期真实调用」证据只在这里递增；测试直接调 readers 不计入。
  const queue = modules.attention;
  const bridgeEnabled = Boolean(queue) || Boolean(modules.relationships) || Boolean(modules.channels);
  if (bridgeEnabled) {
    const bridge = (session, event) => {
      runtime.eventsSeen += 1;
      try {
        if (queue) {
          const enqueued = ingestSessionEvent(queue, session, event, now);
          if (enqueued) {
            runtime.attentionEnqueued += 1;
            runtime.lastAttentionSubject = enqueued?.row?.subject ?? enqueued?.subject ?? null;
          }
        }
      } catch {
        /* 角色层故障不得拖垮 turn（attention 只是顺序偏好） */
      }
      try {
        // relationship → recall weight：真实 graph 读取（未知身份按 stranger 返回，仍是真调用）。
        if (modules.relationships && event?.type === 'user/message') {
          const personId = runtimePersonId(session, event);
          const weight = modules.interfaces.relationship.recallWeightFor(personId);
          runtime.relationshipLookups += 1;
          runtime.lastRelationship = { personId, tier: weight.tier, multiplier: weight.multiplier };
        }
      } catch {
        /* best effort */
      }
      try {
        // channel adapter：真实 touch 宿主持久渠道（lastSeenAt 落盘）。
        if (modules.channels && typeof modules.channels.touch === 'function'
          && (event?.type === 'user/message' || event?.type === 'turn/end')) {
          const touched = modules.channels.touch('web', { at: now() });
          if (touched?.ok === true) runtime.channelTouches += 1;
        }
      } catch {
        /* best effort */
      }
      runtime.lastProducedAt = iso(nowMs(now()));
    };
    try {
      if (ctx && typeof ctx.on === 'function') {
        const disposer = ctx.on('session/event', bridge);
        if (typeof disposer === 'function') disposers.push(disposer);
        hooks.push('session/event');
        runtime.hooks += 1;
      }
    } catch (error) {
      warn(`[role] session/event bridge 注册失败（${error?.code ?? error?.message ?? error}）`);
    }
  }

  // ④ personality projection：首次生成快照 + 语气投影（systemPrompt.section）。
  if (cfg.personality.enabled) {
    try {
      let current = readPersonality({ memoryRoot, caller, auditKey }).snapshot;
      if (current === null || (current.version ?? 0) === 0) {
        const generated = generatePersonalitySnapshot({
          memoryRoot,
          profilePaths: cfg.personality.profilePaths,
          now,
          auditKey,
          actorKind,
          subject,
        });
        current = generated.snapshot;
      }
      modules.personality = {
        snapshot: () => readPersonality({ memoryRoot, caller, auditKey }).snapshot,
        toneProjection: () => {
          runtime.personalityProjections += 1;
          return toneProjection({ snapshot: readPersonality({ memoryRoot, caller, auditKey }).snapshot });
        },
        retentionBiasFor: modules.interfaces.personality.retentionBiasFor,
        decayThresholdsFor: modules.interfaces.personality.decayThresholdsFor,
      };
      const section = ctx?.systemPrompt;
      if (section && typeof section.section === 'function') {
        const initial = toneProjection({ snapshot: current });
        if (initial.inject) {
          const order = typeof section.getSectionOrder === 'function'
            ? (section.getSectionOrder('TOOL_SUBAGENT') ?? 900)
            : 900;
          section.section({
            name: 'role:tone',
            order,
            // 每次宿主取 section 文本都真实重读快照（并计入激活证据）。
            text: () => {
              runtime.personalityProjections += 1;
              return toneProjection({ snapshot: readPersonality({ memoryRoot, caller, auditKey }).snapshot }).styleLine;
            },
          });
          hooks.push('systemPrompt.section');
          runtime.hooks += 1;
        }
      }
    } catch (error) {
      warn(`[role] personality 装配失败（${error?.code ?? error?.message ?? error}）`);
    }
  }

  /** 运行期激活证据快照：给 scripts/verify-activation.mjs / 宿主 doctor 用。 */
  function probe() {
    const attentionView = modules.attention ? readAttentionView({ memoryRoot, now }) : null;
    const relationshipGraph = readRelationships({ memoryRoot });
    const personalityRead = readPersonality({ memoryRoot, caller, auditKey });
    let channelsView = null;
    try {
      channelsView = modules.channels && typeof modules.channels.view === 'function' ? modules.channels.view({ now }) : null;
    } catch {
      channelsView = null;
    }
    const paths = tryRolePaths(memoryRoot);
    const files = paths
      ? {
        attention: fs.existsSync(paths.attention),
        relationships: fs.existsSync(paths.relationships),
        personality: fs.existsSync(paths.personality),
        channels: fs.existsSync(paths.channels),
        audit: fs.existsSync(paths.audit),
      }
      : {};
    const checks = {
      enabled: true,
      hooksRegistered: runtime.hooks > 0,
      eventsSeen: runtime.eventsSeen > 0,
      attentionIngested: runtime.attentionEnqueued > 0,
      relationshipRead: runtime.relationshipLookups > 0,
      channelTouched: runtime.channelTouches > 0,
      personalityProjected: runtime.personalityProjections > 0,
      attentionFilePresent: files.attention === true,
      channelsFilePresent: files.channels === true,
      personalityFilePresent: files.personality === true,
    };
    return {
      schema: 'role-activation/v1',
      enabled: true,
      hooks: [...hooks],
      counters: { ...runtime },
      checks,
      attention: attentionView
        ? {
          present: attentionView.present,
          count: attentionView.count,
          code: attentionView.code,
          // 前 10 行按优先级排序后的证据（verify-activation 断言 P0 先注入）。
          items: (attentionView.items ?? []).slice(0, 10).map((item) => ({
            priority: item.priority,
            effectivePriority: item.effectivePriority,
            kind: item.kind,
            subject: item.subject,
          })),
        }
        : null,
      relationships: { present: relationshipGraph.present, count: relationshipGraph.count, code: relationshipGraph.code },
      personality: {
        present: personalityRead.present,
        version: personalityRead.snapshot?.version ?? 0,
        tone: personalityRead.snapshot?.tone ?? 'neutral',
      },
      channels: channelsView ? { present: channelsView.present, count: channelsView.count, code: channelsView.code } : null,
      files,
      readAt: iso(nowMs(now())),
    };
  }

  function dispose() {
    for (const disposer of disposers) {
      try { disposer(); } catch { /* already disposed */ }
    }
    disposers.length = 0;
  }
  if (typeof ctx?.effect === 'function') {
    try { ctx.effect(() => dispose, 'longlive.role'); } catch { /* fake ctx */ }
  }
  return { enabled: true, hooks, modules, config: cfg, dispose, runtime, probe };
}

export {
  createAttentionQueue,
  createChannelRegistry,
  createRoleInterfaces,
  generatePersonalitySnapshot,
  normalizeInboundMessage,
  attentionPriorityOfKind,
  orderOpsItems,
  INTERFACE_CONTRACTS,
  CHANNEL_DEFAULTS,
};
