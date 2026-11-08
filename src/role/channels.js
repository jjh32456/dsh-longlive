// src/role/channels.js — 角色内核 · channel adapter（v2.8 §16.3 ②）
//
// 设计口径（§16.3）：
//   - 注册表 `.longlive/role/channels.json`；适配器统一接口
//     `{id, type:qq|web|tool, send(text, attachments), enabled, lastSeenAt}`；
//   - 1.8.0 只做**宿主内注册与只读状态**，不接真实 QQ 协议（QQ 侧由插件桥负责，1.8.1+）；
//   - 路由 #27 `/api/longlive/channels`（channels/v1）由 release-check 注册，本模块供
//     `readChannels()` 数据读取器。
//
// 本文件补齐任务书要求的统一消息形态与身份：`normalizeInboundMessage()` 产出
// `{v, channel:{id,type}, actor, sessionId, text, at, meta, source}`；能力协商
// （capabilities 交集）与降级（渠道缺失/禁用/无能 力/发送抛错 → 结构化失败，不崩）。
//
// 子脑渠道：v2.8 的 type 枚举是 qq|web|tool，不新增第 4 类；宿主内把子脑注册为
// tool 渠道 `id:"tool:subagent"`（meta.channelKind="subagent" 可选），保持 schema 不变。

import crypto from 'node:crypto';

import {
  RoleError, ROLE_CODES, ensureRoleDir, iso, nowMs, readJsonSafe, rolePaths, tryRolePaths, writeJsonAtomic,
} from './store.js';

export const CHANNELS_SCHEMA = 'channels/v1';
export const CHANNEL_TYPES = Object.freeze(['qq', 'web', 'tool']);
export const CHANNEL_CAPABILITIES = Object.freeze(['send', 'attachments', 'stream', 'presence']);
export const CHANNEL_DEFAULTS = Object.freeze({
  /** 内置宿主内渠道：web 与 tool 可注册；qq 只有外部桥接时才有适配器。 */
  types: CHANNEL_TYPES,
});
export const CHANNEL_CODES = Object.freeze({
  TYPE: 'E_CHANNEL_TYPE',
  ID: 'E_CHANNEL_ID',
  UNKNOWN: 'E_CHANNEL_UNKNOWN',
  DISABLED: 'E_CHANNEL_DISABLED',
  CAPABILITY: 'E_CHANNEL_CAPABILITY',
  UNAVAILABLE: 'E_CHANNEL_UNAVAILABLE',
  SEND_FAILED: 'E_CHANNEL_SEND_FAILED',
  ACTOR: 'E_CHANNEL_ACTOR',
  SESSION: 'E_CHANNEL_SESSION',
  CONTEXT: 'E_CHANNEL_CONTEXT',
});

const CHANNEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

function channelError(code, message, details = undefined) {
  const error = new RoleError(code, message, details);
  error.status = 422;
  return error;
}

export function isChannelType(value) {
  return CHANNEL_TYPES.includes(String(value ?? ''));
}

export function normalizeChannelCapabilities(value, fallback = ['send']) {
  const input = Array.isArray(value) ? value : fallback;
  const seen = [];
  for (const item of input) {
    const capability = String(item ?? '');
    if (!CHANNEL_CAPABILITIES.includes(capability)) {
      throw channelError(CHANNEL_CODES.CAPABILITY, `未知渠道能力：${JSON.stringify(item)}（允许 ${CHANNEL_CAPABILITIES.join('|')}）`);
    }
    if (!seen.includes(capability)) seen.push(capability);
  }
  return seen;
}

export function normalizeChannelId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!CHANNEL_ID_RE.test(id)) {
    throw channelError(CHANNEL_CODES.ID, `渠道 id 非法：${JSON.stringify(value)}（字母数字开头，允许 : . _ -）`);
  }
  return id;
}

/** One persisted channel record (`channels.json` row). */
export function normalizeChannelRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let id;
  try { id = normalizeChannelId(raw.id); } catch { return null; }
  if (!isChannelType(raw.type)) return null;
  let capabilities = [];
  try { capabilities = normalizeChannelCapabilities(raw.capabilities, []); } catch { capabilities = []; }
  const lastSeenAt = typeof raw.lastSeenAt === 'string' && Number.isFinite(Date.parse(raw.lastSeenAt)) ? raw.lastSeenAt : null;
  return {
    id,
    type: String(raw.type),
    enabled: raw.enabled !== false,
    lastSeenAt,
    capabilities,
    meta: raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta) ? { ...raw.meta } : {},
  };
}

export function emptyChannelsFile() {
  return { v: 1, updatedAt: null, channels: [] };
}

/** Read-only channels projection; never throws (route #27 producer). */
export function readChannels({ memoryRoot, now = () => new Date(), caller = null, auditKey = null } = {}) {
  const paths = tryRolePaths(memoryRoot);
  if (paths === null) {
    return {
      schema: CHANNELS_SCHEMA,
      version: 1,
      present: false,
      degraded: true,
      updatedAt: null,
      count: 0,
      channels: [],
      code: 'E_CHANNELS_ABSENT',
      readAt: iso(nowMs(now())),
    };
  }
  const read = readJsonSafe(paths.channels, { memoryRoot, auditKey, caller });
  if (read.tampered === true || read.denied === true) {
    return {
      schema: CHANNELS_SCHEMA,
      version: 1,
      present: false,
      degraded: true,
      tampered: read.tampered === true,
      denied: read.denied === true,
      updatedAt: null,
      count: 0,
      channels: [],
      code: read.code,
      message: read.message ?? null,
      readAt: iso(nowMs(now())),
    };
  }
  if (!read.ok || !read.value || typeof read.value !== 'object') {
    return {
      schema: CHANNELS_SCHEMA,
      version: 1,
      present: read.present === true,
      degraded: read.present === true,
      updatedAt: null,
      count: 0,
      channels: [],
      code: read.present === true ? 'E_CHANNELS_CORRUPT' : 'E_CHANNELS_ABSENT',
      readAt: iso(nowMs(now())),
    };
  }
  const rawList = Array.isArray(read.value.channels) ? read.value.channels : [];
  const channels = [];
  let bad = 0;
  for (const raw of rawList) {
    const record = normalizeChannelRecord(raw);
    if (record === null) { bad += 1; continue; }
    channels.push({
      id: record.id,
      type: record.type,
      enabled: record.enabled,
      lastSeenAt: record.lastSeenAt,
      capabilities: record.capabilities,
    });
  }
  return {
    schema: CHANNELS_SCHEMA,
    version: 1,
    present: true,
    degraded: bad > 0,
    updatedAt: typeof read.value.updatedAt === 'string' ? read.value.updatedAt : null,
    count: channels.length,
    bad,
    channels,
    code: bad > 0 ? 'E_CHANNELS_PARTIAL' : 'OK',
    readAt: iso(nowMs(now())),
  };
}

/**
 * Host-side registry: adapters live in process memory, their metadata is
 * persisted so a panel/another session can see "which channels exist".
 */
export function createChannelRegistry({ memoryRoot, now = () => new Date(), auditKey = null, actorKind = 'host' } = {}) {
  const paths = rolePaths(memoryRoot);
  /** id -> {id,type,send,capabilities,enabled,meta} */
  const adapters = new Map();

  function readFile() {
    const read = readJsonSafe(paths.channels, { memoryRoot, auditKey });
    if (!read.ok || !read.value || typeof read.value !== 'object') return emptyChannelsFile();
    const channels = [];
    for (const raw of Array.isArray(read.value.channels) ? read.value.channels : []) {
      const record = normalizeChannelRecord(raw);
      if (record) channels.push(record);
    }
    return { v: 1, updatedAt: typeof read.value.updatedAt === 'string' ? read.value.updatedAt : null, channels };
  }

  function writeFile(channels) {
    ensureRoleDir(memoryRoot);
    return writeJsonAtomic(paths.channels, {
      v: 1,
      updatedAt: iso(nowMs(now())),
      channels,
    }, { memoryRoot, auditKey, actorKind });
  }

  function persist() {
    const channels = [...adapters.values()].map((adapter) => ({
      id: adapter.id,
      type: adapter.type,
      enabled: adapter.enabled !== false,
      lastSeenAt: adapter.lastSeenAt ?? null,
      capabilities: [...adapter.capabilities],
      meta: { ...(adapter.meta ?? {}) },
    })).sort((left, right) => left.id.localeCompare(right.id));
    return writeFile(channels);
  }

  /**
   * Register one adapter. `send` is optional: presence-only adapters can be
   * registered for status/negotiation but a send attempt degrades cleanly.
   */
  function registerAdapter({
    id,
    type,
    send = undefined,
    capabilities = ['send'],
    enabled = true,
    lastSeenAt = null,
    meta = {},
  } = {}) {
    const channelId = normalizeChannelId(id);
    if (!isChannelType(type)) {
      throw channelError(CHANNEL_CODES.TYPE, `渠道 type 非法：${JSON.stringify(type)}（允许 ${CHANNEL_TYPES.join('|')}）`);
    }
    const normalizedCaps = normalizeChannelCapabilities(capabilities, ['send']);
    if (normalizedCaps.includes('send') && typeof send !== 'function') {
      throw channelError(CHANNEL_CODES.CAPABILITY, `渠道 ${channelId} 声明了 send 能力但没有 send 函数`);
    }
    if (send !== undefined && typeof send !== 'function') {
      throw channelError(CHANNEL_CODES.CAPABILITY, `渠道 ${channelId} 的 send 不是函数`);
    }
    const seenMs = lastSeenAt === null ? nowMs(now()) : nowMs(lastSeenAt);
    if (!Number.isFinite(seenMs)) throw channelError(CHANNEL_CODES.CONTEXT, `渠道 ${channelId} 的 lastSeenAt 不可解析`);
    const record = {
      id: channelId,
      type: String(type),
      send: typeof send === 'function' ? send : undefined,
      capabilities: Object.freeze(normalizedCaps),
      enabled: enabled !== false,
      lastSeenAt: iso(seenMs),
      meta: meta && typeof meta === 'object' && !Array.isArray(meta) ? { ...meta } : {},
    };
    adapters.set(channelId, record);
    persist();
    return { ok: true, channel: describe(record) };
  }

  function unregisterAdapter(id) {
    const channelId = normalizeChannelId(id);
    const removed = adapters.delete(channelId);
    if (removed) persist();
    return { ok: true, removed, channelId };
  }

  function describe(record) {
    return {
      id: record.id,
      type: record.type,
      enabled: record.enabled !== false,
      lastSeenAt: record.lastSeenAt ?? null,
      capabilities: [...(record.capabilities ?? [])],
      hasSend: typeof record.send === 'function',
      meta: { ...(record.meta ?? {}) },
    };
  }

  function list() {
    return [...adapters.values()].map(describe).sort((left, right) => left.id.localeCompare(right.id));
  }

  /** Capability negotiation: returns the intersection of required ∩ offered. */
  function negotiate({ channelId, required = ['send'] } = {}) {
    const id = normalizeChannelId(channelId);
    const adapter = adapters.get(id) ?? null;
    const wanted = normalizeChannelCapabilities(required, ['send']);
    if (adapter === null) {
      return { ok: false, channelId: id, code: CHANNEL_CODES.UNKNOWN, supported: [], missing: wanted, degraded: true };
    }
    const offered = adapter.capabilities;
    const supported = wanted.filter((capability) => offered.includes(capability));
    const missing = wanted.filter((capability) => !offered.includes(capability));
    return {
      ok: missing.length === 0 && adapter.enabled !== false,
      channelId: id,
      code: adapter.enabled !== false ? (missing.length === 0 ? 'OK' : CHANNEL_CODES.CAPABILITY) : CHANNEL_CODES.DISABLED,
      supported,
      missing,
      degraded: missing.length > 0 || adapter.enabled === false,
    };
  }

  /** Send one message; every failure mode is a structured, non-throwing result. */
  async function send({ channelId, text, attachments = [] } = {}) {
    let id;
    try { id = normalizeChannelId(channelId); } catch (error) {
      return { ok: false, channelId: String(channelId ?? ''), code: error?.code ?? CHANNEL_CODES.ID, degraded: true };
    }
    const adapter = adapters.get(id) ?? null;
    if (adapter === null) return { ok: false, channelId: id, code: CHANNEL_CODES.UNKNOWN, degraded: true };
    if (adapter.enabled === false) return { ok: false, channelId: id, code: CHANNEL_CODES.DISABLED, degraded: true };
    if (!adapter.capabilities.includes('send') || typeof adapter.send !== 'function') {
      return { ok: false, channelId: id, code: CHANNEL_CODES.CAPABILITY, degraded: true };
    }
    const payload = {
      channelId: id,
      text: typeof text === 'string' ? text : String(text ?? ''),
      attachments: Array.isArray(attachments) ? attachments : [],
    };
    if (payload.attachments.length > 0 && !adapter.capabilities.includes('attachments')) {
      return { ok: false, channelId: id, code: CHANNEL_CODES.CAPABILITY, degraded: true, missing: ['attachments'] };
    }
    try {
      const result = await adapter.send(payload);
      adapter.lastSeenAt = iso(nowMs(now()));
      persist();
      return { ok: true, channelId: id, delivered: result !== false, result: result ?? null, degraded: false };
    } catch (error) {
      return {
        ok: false,
        channelId: id,
        code: CHANNEL_CODES.SEND_FAILED,
        degraded: true,
        error: String(error?.message ?? error),
      };
    }
  }

  /** Update the lastSeenAt watermark (host event integration). */
  function touch(channelId, { at = undefined } = {}) {
    const id = normalizeChannelId(channelId);
    const adapter = adapters.get(id);
    if (!adapter) return { ok: false, channelId: id, code: CHANNEL_CODES.UNKNOWN, degraded: true };
    const ms = at === undefined ? nowMs(now()) : nowMs(at);
    if (!Number.isFinite(ms)) return { ok: false, channelId: id, code: CHANNEL_CODES.CONTEXT, degraded: true };
    adapter.lastSeenAt = iso(ms);
    persist();
    return { ok: true, channelId: id, lastSeenAt: adapter.lastSeenAt };
  }

  /** Read-only view (same shape as `readChannels`, plus in-memory adapters). */
  function view({ now: nowValue = undefined } = {}) {
    const clock = typeof nowValue === 'function'
      ? nowValue
      : (nowValue === undefined ? now : () => new Date(nowValue));
    const view = readChannels({ memoryRoot, now: clock });
    const merged = new Map(view.channels.map((channel) => [channel.id, channel]));
    for (const adapter of list()) {
      merged.set(adapter.id, {
        id: adapter.id,
        type: adapter.type,
        enabled: adapter.enabled,
        lastSeenAt: adapter.lastSeenAt,
        capabilities: adapter.capabilities,
      });
    }
    const channels = [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
    return {
      schema: CHANNELS_SCHEMA,
      present: view.present || adapterCount() > 0,
      degraded: view.degraded,
      updatedAt: view.updatedAt,
      count: channels.length,
      channels,
      code: view.code,
    };
  }

  function adapterCount() {
    return adapters.size;
  }

  return { registerAdapter, unregisterAdapter, list, negotiate, send, touch, view, persist, paths };
}

/**
 * Unified inbound message identity (`QQ/Web/工具/子脑` all land in one shape).
 * `actor` is who spoke (personId / 'user' / 'host' / 'subagent'); `sessionId`
 * is the host session; `meta.channelKind` can mark a tool channel as subagent.
 */
export function normalizeInboundMessage({
  channelId,
  channelType = undefined,
  actor,
  sessionId,
  text = '',
  at = undefined,
  meta = {},
  now = () => new Date(),
} = {}) {
  const id = normalizeChannelId(channelId);
  const type = channelType === undefined ? undefined : String(channelType);
  if (type !== undefined && !isChannelType(type)) {
    throw channelError(CHANNEL_CODES.TYPE, `渠道 type 非法：${JSON.stringify(channelType)}（允许 ${CHANNEL_TYPES.join('|')}）`);
  }
  if (typeof actor !== 'string' || actor.trim() === '') {
    throw channelError(CHANNEL_CODES.ACTOR, '入站消息缺少 actor（谁说的）');
  }
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw channelError(CHANNEL_CODES.SESSION, '入站消息缺少 sessionId');
  }
  const atMs = at === undefined ? nowMs(now()) : nowMs(at);
  if (!Number.isFinite(atMs)) throw channelError(CHANNEL_CODES.CONTEXT, '入站消息 at 不可解析');
  return {
    v: 1,
    channel: { id, type: type ?? (id.startsWith('tool:') ? 'tool' : id.split(':')[0] || 'tool') },
    actor: actor.trim(),
    sessionId: sessionId.trim(),
    text: typeof text === 'string' ? text : String(text ?? ''),
    at: iso(atMs),
    meta: meta && typeof meta === 'object' && !Array.isArray(meta) ? { ...meta } : {},
    source: 'role.channel',
  };
}

export function newChannelNonce() {
  return crypto.randomBytes(6).toString('hex');
}
