// engines.dsh self-check data for the panel.
//
// The plugin never blocks on this: `apply()` warns once and keeps loading, and
// this module only persists the verdict to
// `<memoryRoot>/.longlive/status.json` so a read-only panel can show a red dot
// without parsing host logs. Shape (documented in docs/PANEL-INTEGRATION.md):
//
//   {
//     "engineMismatch": {
//       "hostVersion": "0.1.9",
//       "required": ">=0.2.0 <1.0.0",
//       "at": "2026-11-05T13:02:01.000Z",
//       "source": "config.hostVersion",       // how the version was found
//       "path": "..."                          // only for hostPackage
//     }
//   }
//
// Rules:
//   - mismatch -> write/update `engineMismatch`; other keys in the file survive;
//   - match    -> delete a stale `engineMismatch`; delete the file if that was
//                 the only key, so a recovered host stops showing a red dot;
//   - unknown  -> leave the file alone (no evidence either way);
//   - every disk error is returned, never thrown: a read-only memory root must
//     not become a failed plugin load.

import fs from 'node:fs';
import path from 'node:path';

export const ENGINE_STATUS_DIR = '.longlive';
export const ENGINE_STATUS_FILE = 'status.json';

/** `<memoryRoot>/.longlive/status.json`, or null when no root is configured. */
export function engineStatusPath(memoryRoot) {
  if (typeof memoryRoot !== 'string' || !memoryRoot.trim()) return null;
  return path.join(path.resolve(memoryRoot.trim()), ENGINE_STATUS_DIR, ENGINE_STATUS_FILE);
}

function timestamp(now) {
  try {
    const value = typeof now === 'function' ? now() : now;
    if (value === undefined || value === null || value === '') return new Date().toISOString();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return new Date().toISOString();
    return date.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function readStatus(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { exists: true, value: null, corrupt: true };
    }
    return { exists: true, value, corrupt: false };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, value: null, corrupt: false };
    return { exists: true, value: null, corrupt: true };
  }
}

/** Atomic enough for a single small file: tmp in the same directory, then rename. */
function writeStatus(file, value) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${ENGINE_STATUS_FILE}.tmp-${process.pid}-` +
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    return { ok: false, error };
  }
}

function mismatchRecord(compat, detection, now) {
  const record = {
    hostVersion: compat.version,
    required: compat.range,
    at: timestamp(now),
  };
  if (detection?.source) record.source = detection.source;
  if (detection?.path) record.path = detection.path;
  return record;
}

/**
 * Persist one compatibility verdict.
 *
 * @param {string|null} memoryRoot resolved memory root (null disables writes)
 * @param {{compat?: object, detection?: object, now?: Date|string|number|Function}} options
 * @returns {{ok: boolean, action: string, file?: string, error?: Error}}
 */
export function recordEngineStatus(memoryRoot, options = {}) {
  const file = engineStatusPath(memoryRoot);
  if (!file) return { ok: false, action: 'no-memory-root' };

  const compat = options.compat;
  if (!compat || typeof compat !== 'object' || typeof compat.status !== 'string') {
    return { ok: false, action: 'no-compat', file };
  }
  if (compat.status === 'unknown') {
    return { ok: true, action: 'unknown', file };
  }

  const state = readStatus(file);

  if (compat.status === 'mismatch') {
    // A corrupt file cannot be merged, so it is replaced; the panel only reads
    // this file, and a broken status.json has no usable keys to preserve.
    const status = state.corrupt || !state.value ? {} : state.value;
    status.engineMismatch = mismatchRecord(compat, options.detection, options.now);
    const written = writeStatus(file, status);
    if (!written.ok) return { ok: false, action: 'write-failed', file, error: written.error };
    return { ok: true, action: 'wrote', file };
  }

  // status === 'ok': clear a stale record. An unreadable file is left alone —
  // without parsing it we cannot tell whether it holds a mismatch.
  if (!state.exists) return { ok: true, action: 'clean', file };
  if (state.corrupt || !state.value) return { ok: true, action: 'unreadable', file };
  if (!Object.prototype.hasOwnProperty.call(state.value, 'engineMismatch')) {
    return { ok: true, action: 'clean', file };
  }
  delete state.value.engineMismatch;
  if (Object.keys(state.value).length === 0) {
    try {
      fs.unlinkSync(file);
      return { ok: true, action: 'cleared', file };
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: true, action: 'cleared', file };
      return { ok: false, action: 'cleanup-failed', file, error };
    }
  }
  const written = writeStatus(file, state.value);
  if (!written.ok) return { ok: false, action: 'write-failed', file, error: written.error };
  return { ok: true, action: 'cleared', file };
}
