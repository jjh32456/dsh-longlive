// src/ui/panel-api.js — M2-F/M2-G 装配层（宿主接线 + HTTP 分派）
//
// 把权限门（panel-auth）、完整性（panel-integrity）、审计链（actions/audit）、
// evidence 写路径（actions/evidence）、动作面（ui/actions）与 22 条只读路由
// （ui/routes-readonly）装配成一个可测试的门面：
//   - createPanelApi(options) 纯内存/文件装配，契约测试直接驱动；
//   - registerPanelApiRoutes(ctx, options) 通过 ctx.inject(['webServer']) 注册
//     22 条只读路由 + 5 条动作路由 = 27 路由（POST preview/apply/undo、GET actions/audit 等）
//     + G3 distill 详情前缀路由。宿主没有 Web server 时注册失败只 warn，不阻塞加载。
//
// 开关：由 src/index.js 读 `memoryV2.enabled`（默认 false）决定是否调用本模块；
// 未开启时本模块不注册任何路由、不创建任何文件。

import os from 'node:os';
import path from 'node:path';

import { AuditError } from '../actions/audit.js';
import { createAuditLog } from '../actions/audit.js';
import { EvidenceError } from '../actions/evidence.js';
import { createEvidenceWriter } from '../actions/evidence.js';
import { createEventsIndexReader } from '../memory/event-index.js';
import { createActionService, PanelActionError } from './actions.js';
import { createPanelAuth } from './panel-auth.js';
import { createIntegrityGuard } from './panel-integrity.js';
import {
  DISTILL_DETAIL_PREFIX,
  READONLY_ROUTES,
  createReadonlyRouter,
  registerReadonlyRoutes,
} from './routes-readonly.js';

export const ACTIONS_BODY_LIMIT = 64 * 1024;
export const ACTION_ROUTE_PATHS = Object.freeze([
  '/api/longlive/actions/preview',
  '/api/longlive/actions/apply',
  '/api/longlive/actions/undo',
  '/api/longlive/actions',
  '/api/longlive/audit',
]);

/** Host DSH home (never a machine path literal in this published file). */
export function dshHomeDir() {
  const raw = process.env.DSH_HOME;
  if (typeof raw === 'string' && raw.trim() !== '') return path.resolve(raw.trim());
  return path.join(os.homedir(), '.dsh');
}

/**
 * Resolve the installed panel package root.
 *
 * P1-1(2): the default lives **outside** the memory root (`<DSH_HOME>/longlive-panel`)
 * so a model/agent that can write memoryRoot cannot also own the signed manifest
 * directory. Host installers may override via option/config; Gate-2 wires the
 * real installed path.
 */
function defaultPanelRoot(memoryRoot, options) {
  if (typeof options.panelRoot === 'string' && options.panelRoot.trim() !== '') return path.resolve(options.panelRoot);
  if (typeof options.config?.memoryV2?.panelRoot === 'string' && options.config.memoryV2.panelRoot.trim() !== '') {
    return path.resolve(options.config.memoryV2.panelRoot);
  }
  const candidate = path.join(dshHomeDir(), 'longlive-panel');
  const resolvedMemory = memoryRoot !== '' ? path.resolve(memoryRoot) : null;
  if (resolvedMemory !== null
    && (candidate === resolvedMemory || candidate.startsWith(`${resolvedMemory}${path.sep}`))) {
    // Never fall back inside memoryRoot; use the OS-local app data dir instead.
    const localAppData = process.env.LOCALAPPDATA;
    if (typeof localAppData === 'string' && localAppData.trim() !== '') {
      return path.join(localAppData.trim(), 'dsh-longlive', 'panel');
    }
    return path.join(os.tmpdir(), 'dsh-longlive-panel');
  }
  return candidate;
}

/**
 * Assemble the whole panel API (no host wiring).
 * @param {object} options
 * @param {string} options.memoryRoot
 * @param {string} [options.panelRoot] installed panel package root (integrity manifest base)
 * @param {() => Date} [options.now]
 * @param {(size:number)=>Buffer} [options.randomBytes] CSPRNG seam
 * @param {boolean} [options.panelPresent] false simulates uninstalled panel
 * @param {() => object} [options.flagsSnapshot]
 * @param {(query:object)=>object} [options.eventsReader]
 * @param {(anchorId:string)=>object|null} [options.anchorResolver]
 */
export function createPanelApi(options = {}) {
  const memoryRoot = String(options.memoryRoot ?? '');
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const monoNow = typeof options.monoNow === 'function' ? options.monoNow : undefined;
  const auth = createPanelAuth({
    now,
    // P0-1: host-injected capability secret (profile-private env/file); absent => fail closed.
    hostSecret: options.hostSecret,
    monoNow,
    randomBytes: options.randomBytes,
    panelPresent: options.panelPresent,
    panelIntegrityKey: options.panelIntegrityKey,
  });
  const panelRoot = defaultPanelRoot(memoryRoot, options);
  const integrity = createIntegrityGuard({
    panelRoot,
    now,
    signKey: auth.panelIntegrityKeyBytes(),
  });
  const auditKey = auth.auditKeyBytes();
  const audit = createAuditLog({ memoryRoot, auditKey, now });
  const evidence = createEvidenceWriter({ memoryRoot, auditKey, now });
  const actions = createActionService({
    memoryRoot,
    auth,
    auditKey,
    integrity,
    audit,
    evidence,
    now,
    monoNow,
    clockToleranceMs: options.clockToleranceMs,
  });
  const readonly = createReadonlyRouter({
    memoryRoot,
    auth,
    auditKey,
    integrity,
    now,
    flagsSnapshot: options.flagsSnapshot,
    // M2-A: #11 events route reads the FTS5 event index when it has been built
    // (`.longlive/index/events.db`); without an index the honest empty state
    // (`present:false` + E_EVENTS_INDEX_NOT_BUILT) is returned unchanged.
    eventsReader: options.eventsReader ?? createEventsIndexReader({ memoryRoot, now }),
    anchorResolver: options.anchorResolver,
  });

  function handleReadonly(request = {}) {
    return readonly.handle(request);
  }

  function actionResponse(status, body) {
    return { status, body, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } };
  }

  function actionErrorResponse(error) {
    if (error instanceof PanelActionError) {
      return actionResponse(error.status, {
        ok: false,
        error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) },
      });
    }
    if (error instanceof AuditError) {
      return actionResponse(500, { ok: false, error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) } });
    }
    if (error instanceof EvidenceError) {
      return actionResponse(error.status ?? 403, { ok: false, error: { code: error.code, message: error.message } });
    }
    return actionResponse(500, { ok: false, error: { code: 'E_ACTION_FAILED', message: error?.message ?? String(error) } });
  }

  /**
   * Handle one in-process action request.
   * @param {{method?:string, path:string, headers?:object, body?:object, source?:string, actorKind?:string, rawBodySize?:number}} request
   */
  function handleAction(request = {}) {
    const method = String(request.method ?? 'POST').toUpperCase();
    let url;
    try {
      url = new URL(String(request.path ?? ''), 'http://longlive.local');
    } catch {
      return actionResponse(400, { ok: false, error: { code: 'E_PATH', message: '非法请求路径。' } });
    }
    const query = {};
    for (const [key, value] of url.searchParams.entries()) {
      query[key] = /^\d+$/.test(value) ? Number.parseInt(value, 10) : value;
    }
    const gateRequest = { source: request.source ?? 'http', headers: request.headers ?? {}, actorKind: request.actorKind ?? 'host' };
    const body = request.body !== null && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body : {};
    try {
      if (url.pathname === '/api/longlive/actions/preview') {
        if (method !== 'POST') return actionResponse(405, { ok: false, error: { code: 'E_METHOD', message: 'preview 只支持 POST。' } });
        const size = Number.isInteger(request.rawBodySize) ? request.rawBodySize : Buffer.byteLength(JSON.stringify(body));
        if (size > ACTIONS_BODY_LIMIT) return actionResponse(413, { ok: false, error: { code: 'E_BODY_TOO_LARGE', message: `请求体超过 ${ACTIONS_BODY_LIMIT} 字节。` } });
        return actionResponse(200, actions.preview(gateRequest, body));
      }
      if (url.pathname === '/api/longlive/actions/apply') {
        if (method !== 'POST') return actionResponse(405, { ok: false, error: { code: 'E_METHOD', message: 'apply 只支持 POST。' } });
        const size = Number.isInteger(request.rawBodySize) ? request.rawBodySize : Buffer.byteLength(JSON.stringify(body));
        if (size > ACTIONS_BODY_LIMIT) return actionResponse(413, { ok: false, error: { code: 'E_BODY_TOO_LARGE', message: `请求体超过 ${ACTIONS_BODY_LIMIT} 字节。` } });
        return actionResponse(200, actions.apply(gateRequest, body));
      }
      if (url.pathname === '/api/longlive/actions/undo') {
        if (method !== 'POST') return actionResponse(405, { ok: false, error: { code: 'E_METHOD', message: 'undo 只支持 POST。' } });
        const size = Number.isInteger(request.rawBodySize) ? request.rawBodySize : Buffer.byteLength(JSON.stringify(body));
        if (size > ACTIONS_BODY_LIMIT) return actionResponse(413, { ok: false, error: { code: 'E_BODY_TOO_LARGE', message: `请求体超过 ${ACTIONS_BODY_LIMIT} 字节。` } });
        return actionResponse(200, actions.undo(gateRequest, body));
      }
      if (url.pathname === '/api/longlive/actions') {
        if (method !== 'GET') return actionResponse(405, { ok: false, error: { code: 'E_METHOD', message: 'actions 列表只支持 GET。' } });
        return actionResponse(200, actions.listActions(gateRequest, query));
      }
      if (url.pathname === '/api/longlive/audit') {
        if (method !== 'GET') return actionResponse(405, { ok: false, error: { code: 'E_METHOD', message: 'audit 只支持 GET。' } });
        return actionResponse(200, actions.readAudit(gateRequest, query));
      }
      return actionResponse(404, { ok: false, error: { code: 'E_ROUTE_UNKNOWN', message: `未知动作路由：${url.pathname}` } });
    } catch (error) {
      return actionErrorResponse(error);
    }
  }

  return {
    memoryRoot,
    panelRoot,
    auth,
    integrity,
    audit,
    evidence,
    actions,
    readonly,
    handleReadonly,
    handleAction,
    /** Host-internal channel: mint a one-shot capability token for the panel. */
    issueCapability: (opts = {}) => auth.issue(opts),
  };
}

const warned = new Set();
function warnOnce(key, error) {
  if (warned.has(key)) return;
  warned.add(key);
  try {
    console.warn(`[longlive] ${key}: ${error?.stack ?? error?.message ?? String(error)}`);
  } catch {
    /* logging must never break activation */
  }
}

function makeResponder(handler) {
  return (req, res) => {
    let body = {};
    (async () => {
      if (req?.method === 'POST') {
        const chunks = [];
        let size = 0;
        let tooLarge = false;
        await new Promise((resolve) => {
          req.on('data', (chunk) => {
            if (tooLarge) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.length;
            if (size > ACTIONS_BODY_LIMIT) {
              tooLarge = true;
              resolve();
              return;
            }
            chunks.push(buffer);
          });
          req.on('end', resolve);
          req.on('error', resolve);
        });
        if (tooLarge) {
          const payload = JSON.stringify({ ok: false, error: { code: 'E_BODY_TOO_LARGE', message: `请求体超过 ${ACTIONS_BODY_LIMIT} 字节。` } });
          try {
            res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
            res.end(payload);
          } catch {
            /* peer gone */
          }
          return;
        }
        try {
          body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          body = {};
        }
      }
      const host = String(req?.headers?.host ?? 'longlive.local');
      const verdict = handler({
        method: req?.method ?? 'GET',
        path: `http://${host}${String(req?.url ?? '/')}`,
        headers: req?.headers ?? {},
        body,
        source: 'http',
      });
      const payload = JSON.stringify(verdict.body ?? {});
      try {
        res.writeHead(verdict.status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          ...(verdict.headers ?? {}),
          'content-length': Buffer.byteLength(payload),
        });
        res.end(payload);
      } catch {
        try {
          res.destroy?.();
        } catch {
          /* peer gone */
        }
      }
    })().catch((error) => warnOnce('panel api responder failed', error));
  };
}

/**
 * Register the panel API routes on the host Web server (memoryV2.enabled only).
 * @returns {Promise<{api:object|null, registered:number}>} resolved after inject callback
 *   is set up (the actual registration happens when the web server is available).
 */
export function registerPanelApiRoutes(ctx, options = {}) {
  if (typeof ctx?.inject !== 'function') return false;
  try {
    ctx.inject(['webServer'], (webCtx) => {
      const webServer = webCtx?.webServer;
      if (webServer === undefined || typeof webServer.register !== 'function') return;
      let api;
      try {
        api = createPanelApi(options);
      } catch (error) {
        warnOnce('panel api create failed', error);
        return;
      }
      const readonlyResponder = makeResponder(api.handleReadonly);
      const actionResponder = makeResponder(api.handleAction);
      let registered = 0;
      const register = (registration, label) => {
        try {
          const dispose = webServer.register(registration);
          registered += 1;
          if (typeof dispose === 'function' && typeof webCtx.effect === 'function') {
            try {
              webCtx.effect(() => () => dispose(), `longlive: panel api ${label}`);
            } catch {
              /* fake context without an effect scope */
            }
          }
        } catch (error) {
          warnOnce(`panel api route ${label} registration failed`, error);
        }
      };
      for (const route of READONLY_ROUTES) {
        register(
          route.dynamic
            ? { kind: 'prefix', path: route.path.replace(/\/:anchorId$/, '/'), handler: readonlyResponder }
            : { kind: 'exact', path: route.path, handler: readonlyResponder },
          `readonly ${route.id}`,
        );
      }
      register({ kind: 'prefix', path: DISTILL_DETAIL_PREFIX, handler: readonlyResponder }, 'distill detail');
      for (const routePath of ACTION_ROUTE_PATHS) {
        register({ kind: 'exact', path: routePath, handler: actionResponder }, `action ${routePath}`);
      }
      if (typeof webCtx.effect === 'function') {
        try {
          webCtx.effect(() => () => { api = null; }, 'longlive: panel api scope');
        } catch {
          /* fake context */
        }
      }
      warnOnce('panel api registration summary', { registered });
    });
    return true;
  } catch (error) {
    warnOnce('panel api inject failed', error);
    return false;
  }
}

export { registerReadonlyRoutes };
