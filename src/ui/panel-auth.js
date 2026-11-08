// src/ui/panel-auth.js — M2-G 权限门（N38 / §12.2）
//
// 两个凭据**只存在于宿主进程内存**：capability secret 必须由宿主进程注入
// （profile 私有文件 / 宿主环境变量 DSH_LONGLIVE_PANEL_SECRET），审计 key boot 时 32B CSPRNG 生成：
//   - panelCap: 签发面板能力令牌的 HMAC key；
//   - auditKey: HMAC 链式审计 / evidence 签名 key。
// 磁盘上没有任何凭据文件，也没有任何 HTTP 路由能把它们读出来：
// 面板经宿主内部通道拿到的是**短 TTL 一次性 nonce 能力令牌**
//   capability = HMAC(panelCap, `${nonce}|${pid}|${windowNonce}|${sessionNonce}`)
// 请求头 `x-longlive-cap` + `x-longlive-nonce`；服务端内存 nonce 注册表单次消费，TTL 默认 60s。
//
// 权限三门（HTTP / 工具 / CLI）走同一个 {@link actionGate}：
//   - subagent 一律 403 `E_SUBAGENT_FORBIDDEN`（先于 token 校验）；
//   - 面板未装 → 401 `E_PANEL_ABSENT`；
//   - 无令牌 → 401 `E_NO_CAP`；错令牌 → 401 `E_CAP_INVALID`；nonce 已用/过期 → 401 `E_CAP_CONSUMED/E_CAP_EXPIRED`。
// actor 由令牌绑定为 `host`，请求体里的 actor 字段一律忽略（绝不信任请求体）。

import crypto from 'node:crypto';

export const CAP_TTL_MS = 60_000;
export const CAP_HEADER = 'x-longlive-cap';
export const NONCE_HEADER = 'x-longlive-nonce';
export const ACTOR = 'host';

/** Errors carry `{code,status}` so the HTTP layer and the contract tests agree. */
export class PanelAuthError extends Error {
  constructor(code, message, status = 401, details = undefined) {
    super(message);
    this.name = 'PanelAuthError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export function hmacHex(key, text) {
  return crypto.createHmac('sha256', key).update(String(text), 'utf8').digest('hex');
}

function normalizeHeaderValue(value) {
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : '';
  return value === undefined || value === null ? '' : String(value);
}

function headerOf(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const lower = name.toLowerCase();
  if (headers[lower] !== undefined) return normalizeHeaderValue(headers[lower]);
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return normalizeHeaderValue(value);
  }
  return '';
}

/**
 * Create the in-memory credential holder + permission gate.
 *
 * @param {object} [options]
 * @param {() => Date} [options.now] clock seam for tests.
 * @param {(size:number)=>Buffer} [options.randomBytes] CSPRNG seam for tests.
 * @param {boolean} [options.panelPresent] false simulates "panel uninstalled".
 * @returns auth facade (credentials intentionally not enumerable).
 */
export function createPanelAuth(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;
  // Monotonic clock: capability TTL must not stretch when the wall clock rolls
  // back (N38: TTL ≤60s is enforced against elapsed process time).
  const monoNow = typeof options.monoNow === 'function' ? options.monoNow : () => process.uptime() * 1000;
  const panelPresent = options.panelPresent !== false;
  // P0-1: capability secret is HOST-INJECTED. A module that merely imports this
  // file cannot mint a usable capability: without the host secret, issue()/gate
  // fail closed with E_PANEL_HOST_ONLY. The secret is never written to disk.
  function decodeSecret(value) {
    if (Buffer.isBuffer(value) && value.length >= 32) return Buffer.from(value);
    if (typeof value === 'string' && value.trim() !== '') {
      const raw = value.trim();
      const hex = /^[0-9a-f]{64,}$/i.test(raw) ? Buffer.from(raw, 'hex') : null;
      if (hex && hex.length >= 32) return hex;
      try {
        const b64 = Buffer.from(raw, 'base64');
        if (b64.length >= 32) return b64;
      } catch {
        /* fallthrough */
      }
    }
    return null;
  }
  const hostSecret = decodeSecret(options.hostSecret) ?? decodeSecret(process.env.DSH_LONGLIVE_PANEL_SECRET);
  const hostCapable = hostSecret !== null;
  const capabilitySecret = hostSecret ?? randomBytes(32); // host memory only
  const auditKey = randomBytes(32); // host memory only
  // R8/P1-1: independent in-memory key that anchors the panel integrity manifest.
  // Tests may inject a fixed Buffer through options.panelIntegrityKey (host-side
  // seam only); production always generates a fresh boot-scoped key.
  const panelIntegrityKey = Buffer.isBuffer(options.panelIntegrityKey) && options.panelIntegrityKey.length >= 16
    ? Buffer.from(options.panelIntegrityKey)
    : randomBytes(32);
  /** nonce → { pid, windowNonce, sessionNonce, expiresAt, consumed } */
  const nonces = new Map();
  const stats = { issued: 0, verified: 0, rejected: 0, consumedReplays: 0 };

  function currentMs() {
    return now().getTime();
  }

  function prune(nowMono) {
    for (const [nonce, entry] of nonces) {
      if (entry.consumed || nowMono - entry.expiresMono > CAP_TTL_MS) nonces.delete(nonce);
    }
  }

  /**
   * Host-internal channel mints a one-shot capability token for the panel.
   * Never exposed over HTTP; never written to disk.
   */
  function issue(opts = {}) {
    if (!hostCapable) {
      stats.rejected += 1;
      throw new PanelAuthError('E_PANEL_HOST_ONLY', '能力签发只允许宿主进程（host-injected secret 缺失）：外部 import 不得发 cap。', 403);
    }
    const pid = Number.isInteger(opts.pid) ? opts.pid : process.pid;
    const windowNonce = typeof opts.windowNonce === 'string' && opts.windowNonce !== '' ? opts.windowNonce : 'boot';
    const sessionNonce = typeof opts.sessionNonce === 'string' ? opts.sessionNonce : '';
    const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? Math.min(opts.ttlMs, CAP_TTL_MS) : CAP_TTL_MS;
    const nonce = randomBytes(16).toString('hex');
    const mac = hmacHex(capabilitySecret, `${nonce}|${pid}|${windowNonce}|${sessionNonce}`);
    const token = `${nonce}.${mac}`;
    const nowMs = currentMs();
    const nowMono = monoNow();
    prune(nowMono);
    nonces.set(nonce, {
      pid,
      windowNonce,
      sessionNonce,
      expiresAt: nowMs + ttlMs,
      expiresMono: nowMono + ttlMs,
      consumed: false,
    });
    stats.issued += 1;
    return { token, nonce, expiresAt: new Date(nowMs + ttlMs).toISOString(), actor: ACTOR };
  }

  function verifyToken(headers) {
    if (!panelPresent) {
      stats.rejected += 1;
      throw new PanelAuthError('E_PANEL_ABSENT', '面板未安装：所有面板接口暂停（长活核心不受影响）。');
    }
    const token = headerOf(headers, CAP_HEADER);
    const nonceHeader = headerOf(headers, NONCE_HEADER);
    if (token === '') {
      stats.rejected += 1;
      throw new PanelAuthError('E_NO_CAP', '缺少能力令牌（x-longlive-cap）：动作与只读接口一律拒绝。');
    }
    const dot = token.indexOf('.');
    if (dot <= 0 || dot === token.length - 1) {
      stats.rejected += 1;
      throw new PanelAuthError('E_CAP_INVALID', '能力令牌格式非法。');
    }
    const tokenNonce = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    if (nonceHeader !== '' && nonceHeader !== tokenNonce) {
      stats.rejected += 1;
      throw new PanelAuthError('E_CAP_INVALID', '能力令牌与 nonce 请求头不匹配。');
    }
    const entry = nonces.get(tokenNonce);
    if (entry === undefined) {
      stats.rejected += 1;
      throw new PanelAuthError('E_CAP_CONSUMED', 'nonce 不存在或已被消费（能力令牌一次性）。');
    }
    if (entry.consumed) {
      stats.consumedReplays += 1;
      stats.rejected += 1;
      throw new PanelAuthError('E_CAP_CONSUMED', 'nonce 已被消费（重放被拒绝）。');
    }
    // TTL is enforced on the monotonic clock: a wall-clock rollback cannot
    // extend a capability token's lifetime.
    if (monoNow() > entry.expiresMono) {
      stats.rejected += 1;
      throw new PanelAuthError('E_CAP_EXPIRED', '能力令牌已过期（TTL ≤60s）。');
    }
    const expected = hmacHex(
      capabilitySecret,
      `${tokenNonce}|${entry.pid}|${entry.windowNonce}|${entry.sessionNonce}`,
    );
    const expectedBuf = Buffer.from(expected, 'utf8');
    const macBuf = Buffer.from(mac, 'utf8');
    // EA-12: timingSafeEqual throws RangeError on unequal lengths -> compare lengths first.
    if (expectedBuf.length !== macBuf.length || !crypto.timingSafeEqual(expectedBuf, macBuf)) {
      stats.rejected += 1;
      throw new PanelAuthError('E_CAP_INVALID', '能力令牌验签失败。');
    }
    entry.consumed = true;
    stats.verified += 1;
    return { ok: true, actor: ACTOR, actorId: ACTOR, pid: entry.pid, nonce: tokenNonce };
  }

  /**
   * The single permission door for HTTP routes, tools and the CLI.
   * `source` only changes the audit label — the checks are identical by design.
   * The request body is never consulted for identity.
   */
  function actionGate({ source = 'http', headers = {}, actorKind = 'host' } = {}) {
    if (!hostCapable) {
      stats.rejected += 1;
      throw new PanelAuthError('E_PANEL_HOST_ONLY', '权限门只允许宿主进程（host-injected secret 缺失）。', 403);
    }
    if (source !== 'http' && source !== 'tool' && source !== 'cli') {
      throw new PanelAuthError('E_SOURCE_INVALID', `未知入口：${source}`, 400);
    }
    if (actorKind === 'subagent') {
      stats.rejected += 1;
      throw new PanelAuthError('E_SUBAGENT_FORBIDDEN', 'subagent 不具有面板动作权限（一律 403）。', 403);
    }
    const verdict = verifyToken(headers);
    // P1-2: actor is injected by the host (token-bound); request bodies are never
    // consulted. A verdict with no actor is refused instead of defaulting silently.
    if (typeof verdict?.actor !== 'string' || verdict.actor === '') {
      stats.rejected += 1;
      throw new PanelAuthError('E_ACTOR_REQUIRED', 'actor 必须由宿主注入（令牌绑定），缺省拒绝。', 401);
    }
    return { ...verdict, source };
  }

  /** Host-internal accessor for the audit/evidence signer. Not exposed to the panel. */
  function auditKeyBytes() {
    return auditKey;
  }

  /** Host-internal accessor for the R8 manifest HMAC anchor (boot-scoped). */
  function panelIntegrityKeyBytes() {
    return panelIntegrityKey;
  }

  function hasCapabilitySecret() {
    return hostCapable && Buffer.isBuffer(capabilitySecret) && capabilitySecret.length >= 32;
  }

  return {
    panelPresent,
    hostCapable,
    issue,
    verifyToken,
    actionGate,
    auditKeyBytes,
    panelIntegrityKeyBytes,
    hasCapabilitySecret,
    stats,
    CAP_TTL_MS,
  };
}
