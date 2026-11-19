/**
 * v2-bridge.js · 面板 host 半边 ↔ longlive M2-F/M2-G 的内部通道
 *
 * 设计依据：PANEL-V2-PROPOSAL v2.4 §5（N38）——凭据只在宿主内存、能力令牌
 * 短 TTL 一次性 nonce、面板 server 不持有可被模型读到的 token；面板经
 * **宿主内部通道**（in-process，不落盘、不走 HTTP 凭据）按请求现签 cap，
 * 立刻交给 longlive 的 handleReadonly / handleAction，浏览器永远看不到 cap。
 *
 * 两种接线（都不写文件）：
 *   1. `options.longliveApi`：宿主在加载面板时注入的 longlive createPanelApi()
 *      实例（安装集接线；推荐）；
 *   2. 兜底：从已安装的 @jjh32456/dsh-longlive 包内动态 import
 *      `ui/panel-api.js` 并 createPanelApi({memoryRoot})。找不到就降级为
 *      unavailable（面板 UI 显示「未实装」，不崩）。
 */

import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const CAP_HEADER = 'x-longlive-cap'
export const NONCE_HEADER = 'x-longlive-nonce'

function text(value) {
  return value === null || value === undefined ? '' : String(value)
}

function safeBody(value) {
  if (value === null || value === undefined) return {}
  if (typeof value === 'object') return value
  return {}
}

/**
 * @param {object} options
 * @param {object} [options.longliveApi] host-wired createPanelApi() instance
 * @param {() => object} [options.getLongliveApi] lazy accessor (host wiring)
 * @param {string} [options.memoryRoot]
 * @param {string} [options.sessionNonce] browser-session nonce (never a credential)
 * @param {() => Date} [options.now]
 */
export function createLongliveBridge(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => new Date()
  // P1-1：sessionNonce 必须是宿主/面板实例随机会话值；缺省留空即不签发（fail closed），
  // 不再回退到公开常量 'panel-v2'。
  const sessionNonce = text(options.sessionNonce) || ''
  let api = options.longliveApi && typeof options.longliveApi.handleReadonly === 'function' ? options.longliveApi : null
  let loadError = null
  let loaded = Boolean(api)
  const stats = {
    minted: 0,
    reads: 0,
    actions: 0,
    lastStatus: null,
  }

  function getApi() {
    if (api) return api
    if (typeof options.getLongliveApi === 'function') {
      try {
        const candidate = options.getLongliveApi()
        if (candidate && typeof candidate.handleReadonly === 'function') {
          api = candidate
          loaded = true
          return api
        }
      } catch (error) {
        loadError = error
      }
    }
    return null
  }

  /** Host-internal channel: mint one short-TTL one-shot capability for one request. */
  function mintCapability() {
    // P1-1：没有宿主/面板实例注入的 per-session nonce 时不签发任何 cap（fail closed）。
    if (!sessionNonce) return null
    const instance = getApi()
    if (!instance || typeof instance.issueCapability !== 'function') return null
    let cap = null
    try {
      cap = instance.issueCapability({ sessionNonce, pid: process.pid })
    } catch (error) {
      // P0-1：外部 import 自建实例没有宿主 secret → 宿主抛 E_PANEL_HOST_ONLY(403)。
      // 面板不冒泡异常、不冒充有效 cap：返回 null，由 read() 统一降级 503/不可用。
      stats.hostOnlyRefused = (stats.hostOnlyRefused || 0) + 1
      return null
    }
    stats.minted += 1
    return cap
  }

  function headersFor(cap) {
    if (!cap) return {}
    return { [CAP_HEADER]: text(cap.token), [NONCE_HEADER]: text(cap.nonce) }
  }

  function availability() {
    const instance = getApi()
    if (!instance) return { available: false, reason: loadError ? `E_BRIDGE_LOAD:${loadError.message}` : 'E_BRIDGE_UNAVAILABLE' }
    return { available: true, reason: null, panelPresent: instance.auth ? instance.auth.panelPresent !== false : true }
  }

  /**
   * In-process read of one longlive M2-F route.
   * @returns {{status:number, body:object}}
   */
  function read(pathWithQuery, extra = {}) {
    const instance = getApi()
    if (!instance) {
      return { status: 503, body: { ok: false, error: { code: 'E_PANEL_UNAVAILABLE', message: 'longlive 面板 API 未接通（memoryV2 未开启或未安装）。' } } }
    }
    const cap = mintCapability()
    if (!cap) {
      return { status: 503, body: { ok: false, error: { code: 'E_PANEL_UNAVAILABLE', message: '宿主内部通道无法签发能力令牌。' } } }
    }
    const host = text(extra.host) || '127.0.0.1'
    const verdict = instance.handleReadonly({
      method: 'GET',
      path: `http://${host}${pathWithQuery}`,
      headers: { ...headersFor(cap), ...(extra.headers || {}) },
      source: 'http',
    })
    stats.reads += 1
    stats.lastStatus = verdict.status
    return { status: verdict.status, body: safeBody(verdict.body) }
  }

  /**
   * In-process action request (preview/apply/undo/actions list/audit).
   * @returns {{status:number, body:object}}
   */
  function action(method, pathWithQuery, body = {}) {
    const instance = getApi()
    if (!instance) {
      return { status: 503, body: { ok: false, error: { code: 'E_PANEL_UNAVAILABLE', message: 'longlive 面板 API 未接通（memoryV2 未开启或未安装）。' } } }
    }
    const cap = mintCapability()
    if (!cap) {
      return { status: 503, body: { ok: false, error: { code: 'E_PANEL_UNAVAILABLE', message: '宿主内部通道无法签发能力令牌。' } } }
    }
    const host = text(options.host) || '127.0.0.1'
    const verdict = instance.handleAction({
      method: String(method || 'POST').toUpperCase(),
      path: `http://${host}${pathWithQuery}`,
      headers: headersFor(cap),
      body: safeBody(body),
      source: 'http',
      actorKind: 'host',
      rawBodySize: Buffer.byteLength(JSON.stringify(safeBody(body))),
    })
    stats.actions += 1
    stats.lastStatus = verdict.status
    return { status: verdict.status, body: safeBody(verdict.body) }
  }

  /** Integrity status convenience (route #16), used by UI banner. */
  function integrity() {
    return read('/api/longlive/integrity')
  }

  /** Last capability token must never be exposed; tests assert this. */
  let lastCapToken = null
  function mintProbe() {
    const cap = mintCapability()
    lastCapToken = cap ? cap.token : null
    return { token: cap ? cap.token : null, nonce: cap ? cap.nonce : null, expiresAt: cap ? cap.expiresAt : null }
  }

  return {
    availability,
    read,
    action,
    integrity,
    mintProbe,
    stats,
    sessionNonce,
    get lastCapToken() {
      return lastCapToken
    },
    now,
  }
}

/**
 * Fallback loader: import longlive's panel-api from the installed package.
 * Never throws; returns null when the package is absent/unresolvable.
 */
let defaultLoaderInFlight = null
export async function loadDefaultLongliveApi(memoryRoot) {
  if (defaultLoaderInFlight) return defaultLoaderInFlight
  defaultLoaderInFlight = (async () => {
    try {
      const entry = await import.meta.resolve('@jjh32456/dsh-longlive')
      const srcDir = dirname(fileURLToPath(entry))
      const panelApiHref = pathToFileURL(join(srcDir, 'ui', 'panel-api.js')).href
      const mod = await import(panelApiHref)
      if (typeof mod.createPanelApi !== 'function') return null
      // P0-A（1.8.0 host smoke）：兜底实例必须自带进程内 capability secret，
      // 否则 issueCapability 永远 E_PANEL_HOST_ONLY，面板动作面在真机上等于禁用。
      // secret 只在宿主进程内存里（env 注入优先；否则每进程随机 32B），不落盘。
      const hostSecret = (typeof process.env.DSH_LONGLIVE_PANEL_SECRET === 'string'
        && process.env.DSH_LONGLIVE_PANEL_SECRET.trim() !== '')
        ? process.env.DSH_LONGLIVE_PANEL_SECRET.trim()
        : randomBytes(32).toString('hex')
      // P0-B（1.8.0 host smoke）：完整性 manifest 必须有签名者，否则 #16 read-failed
      // 把动作全部 fail-closed 禁用。兜底模式由本实例用自身的 panelIntegrityKey
      // 在装载时对已安装面板包做一次签名（boot 时自签，防的是安装后文件被改）。
      const panelRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
      const api = mod.createPanelApi({ memoryRoot, panelRoot, hostSecret, panelPresent: true })
      try {
        if (api && api.integrity && typeof api.integrity.writeSignedManifest === 'function') {
          api.integrity.writeSignedManifest()
        }
      } catch {
        // 签名失败不阻塞只读面；动作面仍会按完整性 fail-closed（不会假通过）。
      }
      return api
    } catch {
      return null
    }
  })()
  return defaultLoaderInFlight
}
