// Host half of the settings panel: one same-origin JSON route the browser
// companion calls. The write path is the Host's own `configEditor`, so the
// profile patch stays the single source of truth and a switch edit goes
// through the same validate/persist/reconcile path as any other row change.
//
// Route shape follows the Web server composition contract (`kind: 'exact'`,
// one handler per path); the handler dispatches GET/POST itself because
// duplicate (kind, path) registrations are rejected by WebServer.register.

import {
  FLAGS_PACKAGE,
  FLAGS_ROW_ID,
  FlagsError,
  createFlagsService,
  setFlagInConfig,
} from './flags.js';

/** Browser-facing endpoint of the panel. */
export const FLAGS_PATH = '/api/longlive/flags';
/** Upper bound for one switch request body. */
export const FLAGS_BODY_LIMIT = 16 * 1024;

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

function getEditor(ctx) {
  if (typeof ctx?.get !== 'function') return undefined;
  try {
    return ctx.get('configEditor') ?? undefined;
  } catch {
    return undefined;
  }
}

function findOwnEntry(ctx, editor, rowId = FLAGS_ROW_ID) {
  let entries;
  try {
    entries = editor?.entries?.() ?? [];
  } catch {
    return undefined;
  }
  if (!Array.isArray(entries)) return undefined;
  let own;
  try {
    own = ctx?.fiber?.entry;
  } catch {
    own = undefined;
  }
  if (own !== undefined && entries.includes(own)) return own;
  const named = entries.filter((entry) => entry?.options?.name === FLAGS_PACKAGE);
  return named.find((entry) => entry?.options?.id === rowId) ?? named[0];
}

function copyRaw(value) {
  if (value === null || typeof value !== 'object') return {};
  try {
    return structuredClone(value);
  } catch {
    return { ...value };
  }
}

/**
 * Build the route service over the live Host context.
 * @param ctx - the plugin context (for `ctx.fiber.entry` and `configEditor`).
 * @param options - `{ config, memoryRoot, rowId }`.
 * @returns the service consumed by {@link createFlagsRoute}.
 */
export function createUiService(ctx, options = {}) {
  const rowId = options.rowId ?? FLAGS_ROW_ID;
  const editorEntry = () => {
    const editor = getEditor(ctx);
    return editor === undefined ? undefined : findOwnEntry(ctx, editor, rowId);
  };

  return createFlagsService({
    readConfig: () => {
      const entry = editorEntry();
      if (entry !== undefined) return copyRaw(entry.options?.config);
      return copyRaw(options.config);
    },
    canWrite: () => {
      const editor = getEditor(ctx);
      return editor !== undefined && findOwnEntry(ctx, editor, rowId) !== undefined;
    },
    writeConfig: async (key, value) => {
      const editor = getEditor(ctx);
      if (editor === undefined) {
        throw new FlagsError('E_FLAG_WRITE', '当前宿主没有 configEditor 服务，无法保存插件配置。');
      }
      const entry = findOwnEntry(ctx, editor, rowId);
      if (entry === undefined) {
        throw new FlagsError('E_FLAG_WRITE', '找不到 session-longlive 的配置行，无法保存（可能由 home patch 覆盖）。');
      }
      await editor.edit(entry, (current) => setFlagInConfig(current, key, value));
    },
    memoryRoot: options.memoryRoot,
  });
}

function statusFor(error) {
  if (error instanceof FlagsError) {
    if (error.code === 'E_FLAG_WRITE') return 409;
    return 400;
  }
  return 500;
}

function writeJson(res, status, body, headers = {}) {
  if (res.writableEnded === true || res.headersSent === true) return;
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
      /* the peer is already gone */
    }
  }
}

/** Read one small JSON object from a Node request. */
export function readJsonBody(req, limit = FLAGS_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) {
        fail(new FlagsError('E_FLAG_BODY', `请求体超过 ${limit} 字节。`));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch {
        reject(new FlagsError('E_FLAG_BODY', '请求体不是合法 JSON。'));
      }
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new FlagsError('E_FLAG_BODY', '请求被中断。')));
  });
}

/**
 * The configuration endpoint is loopback-only: writing a profile patch is a
 * local operation, and the GUI itself is served from 127.0.0.1. A paired
 * remote device is intentionally not granted this write path.
 */
export function isLoopbackRequest(req) {
  const address = req?.socket?.remoteAddress;
  if (typeof address !== 'string' || address === '') return true; // test / in-process callers
  return address.startsWith('127.')
    || address === '::1'
    || address === '::ffff:127.0.0.1'
    || address === '::ffff:7f00:1'
    || address === 'localhost';
}

/**
 * Create the exact-path route.
 * @param service - from {@link createUiService}.
 * @returns a WebServer route object.
 */
export function createFlagsRoute(service) {
  async function handle(req, res) {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { ok: false, code: 'E_FLAG_FORBIDDEN', error: '配置接口只允许本机访问（loopback-only）。' });
      return;
    }
    const method = typeof req?.method === 'string' ? req.method.toUpperCase() : 'GET';
    try {
      if (method === 'GET') {
        writeJson(res, 200, service.snapshot());
        return;
      }
      if (method === 'POST') {
        // A JSON content type is required for two reasons: the client always
        // sends it, and a cross-origin HTML form cannot set it (a cross-origin
        // JSON fetch needs a preflight this route never grants).
        const contentType = String(req?.headers?.['content-type'] ?? '').toLowerCase();
        if (!contentType.startsWith('application/json')) {
          throw new FlagsError('E_FLAG_BODY', 'POST 请求必须使用 application/json。');
        }
        const body = await readJsonBody(req);
        const key = body.key;
        const value = body.value;
        if (typeof key !== 'string' || key === '') {
          throw new FlagsError('E_FLAG_BODY', '请求缺少 key。');
        }
        if (typeof value !== 'boolean') {
          throw new FlagsError('E_FLAG_BODY', '请求的 value 必须是布尔值。');
        }
        const snapshot = await service.setFlag(key, value);
        writeJson(res, 200, { ...snapshot, saved: { key, value } });
        return;
      }
      writeJson(res, 405, { ok: false, error: `不支持的请求方法：${method}` }, { allow: 'GET, POST' });
    } catch (error) {
      writeJson(res, statusFor(error), {
        ok: false,
        code: error instanceof FlagsError ? error.code : 'E_FLAG_INTERNAL',
        error: error?.message ?? String(error),
      });
    }
  }
  return { kind: 'exact', path: FLAGS_PATH, handler: handle };
}

/**
 * Register the panel route once the Web server is available. A profile with no
 * web server (a headless boot or a test context) simply gets no route; the
 * plugin still loads.
 * @param ctx - the plugin context.
 * @param options - `{ config, memoryRoot, rowId }`.
 * @returns true when an `inject` watch was installed.
 */
export function registerUiRoutes(ctx, options = {}) {
  // EA-08: with memoryV2 enabled the cap-gated read-only #1 owns /api/longlive/flags;
  // registering the legacy loopback route on the same path would double-register.
  if (options.skipFlags === true) return true;
  if (typeof ctx?.inject !== 'function') return false;
  try {
    ctx.inject(['webServer'], (webCtx) => {
      const webServer = webCtx?.webServer;
      if (webServer === undefined || typeof webServer.register !== 'function') return;
      const service = createUiService(ctx, options);
      const route = createFlagsRoute(service);
      let dispose;
      try {
        dispose = webServer.register(route);
      } catch (error) {
        warnOnce('settings route registration failed', error);
        return;
      }
      if (typeof webCtx.effect === 'function') {
        try {
          webCtx.effect(() => () => {
            if (typeof dispose === 'function') dispose();
          }, 'longlive: settings route');
        } catch (error) {
          warnOnce('settings route effect failed', error);
        }
      }
    });
    return true;
  } catch (error) {
    warnOnce('settings route inject failed', error);
    return false;
  }
}
