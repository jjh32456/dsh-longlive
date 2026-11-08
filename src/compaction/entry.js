// Thin, fail-open entry for the hot-truncate compaction row.
//
// This file must evaluate even when the engine cannot: a throw at import time
// would leave the host's stock compaction row disabled (the bundle patch turns
// `compaction-basic` off) and `/compact` waiting forever. It follows the
// dsh-live-compact shell pattern:
//
//   1. load the host packages + engine; remember the first failure;
//   2. choose: defer to live-compact / hand back to stock / register our cut;
//   3. on any construction failure, RELEASE the just-registered ctx.compaction
//      and construct the stock BasicCompactionEngine;
//   4. if even stock cannot load, return a no-op plugin that only logs.
//
// Nothing here touches a real profile; the bundle patch that inserts this row
// is shipped separately in PATCH.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { normalizeOptions, stockConfig } from './engine-core.js';

const STOCK_PACKAGE = '@deepseek-ai/dsh-compaction-basic';
const OUR_NAME = 'hot-truncate';
const LIVE_COMPACT_PACKAGES = Object.freeze(['dsh-live-compact', '@deepseek-ai/dsh-live-compact']);

function reasonOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function log(ctx, level, message) {
  try {
    const logger = ctx?.logger;
    if (typeof logger?.[level] === 'function') logger[level](message);
    else if (level === 'warn') console.error(message);
  } catch {
    // A logger failure must never cascade into a plugin failure.
  }
}

// -- failure path: release the service this constructor registered ----------

/**
 * Undo a Cordis Service registration. The reference implementation walks both
 * symbol and string keys of the reflective store; a plain `delete
 * ctx.compaction` is not enough because Cordis keeps services behind symbols.
 */
export function releaseCompaction(ctx) {
  let released = false;
  try {
    const store = ctx?.reflect?.store;
    if (store) {
      const keys = [...Object.getOwnPropertySymbols(store), ...Object.keys(store)];
      for (const key of keys) {
        if (store[key]?.name !== 'compaction') continue;
        delete store[key];
        released = true;
      }
    }
    if (ctx?.fiber?.store && ctx.fiber.store.compaction) {
      delete ctx.fiber.store.compaction;
      released = true;
    }
  } catch {
    // Reported by the caller through the fallback; never thrown.
  }
  return released;
}

// -- coexistence -------------------------------------------------------------

/**
 * Detect an installed/live live-compact. The task requires "row id
 * compaction-spine or package name dsh-live-compact" to win by default, so
 * every probe is conservative: any positive match means defer.
 *
 * Order: explicit config/env override → an already-registered compaction
 * service → live-compact's gate service → package resolution → the active
 * profile text. The last probe is what sees a row id (`compaction-spine`) even
 * when the package is installed outside this module's resolution path.
 */
export function detectLiveCompact(ctx, options = {}, env = process.env) {
  if (options?.assumeLiveCompact === true) return 'config.assumeLiveCompact';
  if (env?.DSH_HOT_TRUNCATE_LIVE_COMPACT === '1') return 'env.DSH_HOT_TRUNCATE_LIVE_COMPACT';
  if (env?.DSH_HOT_TRUNCATE_LIVE_COMPACT === '0') return null;

  const probe = (name) => {
    try {
      return ctx?.get?.(name) ?? null;
    } catch {
      return null;
    }
  };
  if (probe('compaction') !== null) return 'ctx.compaction 已被另一个压缩引擎注册';
  if (probe('liveCompactPresetGate') !== null) return 'live-compact gate service';

  try {
    const require = createRequire(import.meta.url);
    for (const name of LIVE_COMPACT_PACKAGES) {
      try {
        require.resolve(name);
        return `已安装 ${name}`;
      } catch {
        // try the next name
      }
    }
  } catch {
    // createRequire itself failed; the profile scan below is independent.
  }

  try {
    const home = typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim()
      ? path.resolve(env.DSH_HOME.trim())
      : path.join(os.homedir(), '.dsh');
    const profiles = path.join(home, 'profiles');
    for (const name of fs.readdirSync(profiles)) {
      for (const file of ['package.json', 'cordis.patch.yml', 'cordis.yml']) {
        try {
          const text = fs.readFileSync(path.join(profiles, name, file), 'utf8');
          if (/dsh-live-compact|compaction-spine/.test(text)) return `${name}/${file} 提到 live-compact`;
        } catch {
          // Missing/unreadable file: not a match.
        }
      }
    }
  } catch {
    // No readable profiles directory is the normal test/no-host case.
  }
  return null;
}

// -- module load (top-level await keeps a broken engine from failing import) --

let Engine = null;
let Stock = null;
let loadError = null;

if (process.env.DSH_HOT_TRUNCATE_ENGINE_FAIL !== 'import') {
  try {
    const module = await import('./cut-engine.js');
    Engine = module.default;
  } catch (error) {
    loadError = error instanceof Error ? error : new Error(String(error));
  }
} else {
  loadError = new Error('hot-truncate: engine import refused by DSH_HOT_TRUNCATE_ENGINE_FAIL');
}

try {
  const module = await import(process.env.DSH_HOT_TRUNCATE_HOST_STOCK || STOCK_PACKAGE);
  Stock = module.BasicCompactionEngine ?? module.default ?? null;
} catch (error) {
  // Stock may legitimately be absent (a profile that only uses longlive).
  loadError ??= error instanceof Error ? error : new Error(String(error));
}

function installStock(ctx, rawConfig, cause, { claimed = false } = {}) {
  // If a compaction engine was already registered by somebody else (a partly
  // applied bundle, or stock left enabled), never steal or tear it down: this
  // row is optional and the host must keep working.
  let existing = null;
  try {
    existing = ctx?.get?.('compaction') ?? null;
  } catch {
    existing = null;
  }
  if (existing !== null && !claimed) {
    log(ctx, 'warn', `${OUR_NAME}: 已有压缩引擎占据 ctx.compaction，本行不重复注册。${cause ? `原因：${cause}` : ''}`);
    return new Deferred(ctx, null);
  }
  releaseCompaction(ctx);
  if (typeof Stock !== 'function') {
    log(ctx, 'warn', `${OUR_NAME}: 引擎与 stock 压缩都不可用，本会话不接管压缩。${cause ? `原因：${cause}` : ''}`);
    return new Deferred(ctx, null);
  }
  try {
    const engine = new Stock(ctx, stockConfig(rawConfig));
    log(ctx, 'warn', `${OUR_NAME}: 回退 stock 压缩。${cause ? `原因：${cause}` : ''}`);
    return engine;
  } catch (error) {
    releaseCompaction(ctx);
    log(ctx, 'warn', `${OUR_NAME}: stock 压缩构造失败，本会话不接管压缩。原因：${reasonOf(error)}`);
    return new Deferred(ctx, null);
  }
}

/** A plugin that registers nothing; used when taking over would conflict. */
class Deferred {
  constructor(ctx, message) {
    if (message) log(ctx, 'info', message);
  }
}

export default class HotTruncateEntry {
  // Stock needs llm/tokenMeter/sessions; declare them so the fallback can be
  // constructed on the same context (Cordis treats an undeclared read as a bug).
  static inject = ['llm', 'tokenMeter', 'sessions'];

  constructor(ctx, config) {
    let options;
    try {
      options = normalizeOptions(config);
    } catch (error) {
      return installStock(ctx, config, `配置无效：${reasonOf(error)}`);
    }

    const live = detectLiveCompact(ctx, options, process.env);
    if (live !== null) {
      const label = typeof live === 'string' && live.startsWith('ctx.compaction')
        ? `检测到已有压缩引擎（${live}）`
        : `检测到 live-compact（${live}）`;
      return new Deferred(ctx, `${OUR_NAME}: ${label}，热截断让位`);
    }
    if (options.mode === 'off') {
      return installStock(ctx, config, 'mode=off');
    }
    if (typeof Engine !== 'function') {
      return installStock(ctx, config, `引擎未加载：${reasonOf(loadError)}`);
    }
    try {
      return new Engine(ctx, config);
    } catch (error) {
      return installStock(ctx, config, `引擎构造失败：${reasonOf(error)}`, { claimed: true });
    }
  }
}

export { Deferred };
