#!/usr/bin/env node
// Resident session watchdog: out-of-app, threshold-driven visible truncation.
//
// Why a second resident script exists
// ------------------------------------
// scripts/resident-watcher.ps1 + watch-loop.ps1 consume *requests* written by
// the in-app plugin. That path closes and restarts the GUI around the cut,
// because a running host keeps the old sequence in memory. This script is the
// other half: it scans session logs on a schedule (size / event count / token
// estimate), checks that the file is not owned by a live host, and then calls
// the same truncate CLI the request path uses. It never closes, starts or
// talks to the GUI; a failed cut is a log line, not a host event.
//
// Modes (mirroring autoTruncate.mode)
//   log      plan in-process; never starts the CLI; never writes the session.
//   dryrun   call `truncate-cli.mjs --dry-run`; receipt proves nothing moved.
//   request  call `truncate-cli.mjs --confirm TRUNCATE-VISIBLE`; this is the
//            real cut. It is refused while a live row / live pid / open handle
//            exists (the CLI repeats the registry + handle check itself).
//
// Kill switch: `enabled: false` in the source of truth makes the next wake-up
// inert (the loop re-reads config every few seconds). A `stop.flag` file makes
// the loop exit entirely. No config change requires restarting the task.
//
// The script is deliberately dependency-free and runs on the DSH node runtime:
//   node scripts/session-watch.mjs --config <path> --once
//   node scripts/session-watch.mjs --config <path> --loop
//   node scripts/session-watch.mjs --config <path> --check
//   node scripts/session-watch.mjs --config <path> --once --dry-run
//
// Exit codes: 0 tick completed (even when a session failed -- fail-soft is the
// point), 2 bad arguments, 3 unusable config. A scheduled task therefore sees
// "success" for a noisy but healthy watcher and "failure" only for config rot.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { parseSession } from '../src/codec.js';
import {
  INFLIGHT_FILENAME,
  inflightPathFor,
  sessionEstimate,
} from '../src/truncate-visible.js';
import { liveList, pidAlive } from '../src/live.js';
import { normalizeAutoTruncateConfig } from '../src/auto-truncate.js';

const WATCH_VERSION = '1.0.0';
const MODES = Object.freeze(['log', 'dryrun', 'request']);
const SESSION_FILE = 'session.v4.jsonl.zstd';
const MAX_SCAN_DEPTH = 4;
const MAX_STATE_SESSIONS = 500;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const DISABLED_LOG_EVERY_MS = 10 * 60 * 1000;
const STOP_CHECK_MS = 5_000;

const DEFAULTS = Object.freeze({
  enabled: true,
  mode: 'dryrun',
  intervalSeconds: 300,
  settleSeconds: 10,
  tokensThreshold: 300_000,
  minTurns: 12,
  bytesThreshold: 0,
  eventsThreshold: 0,
  keepTurns: 12,
  keepTokens: 80_000,
  firstUserCapChars: 4_000,
  boundaryRetries: 3,
  cooldownMinutes: 60,
  profileConfig: '',
  memoryRoot: '',
  sessionsRoot: '',
  dshHome: '',
  nodeExe: '',
  cliPath: '',
  logPath: '',
  statePath: '',
  receiptDir: '',
  lockPath: '',
  lastTickPath: '',
  stopFlag: '',
  scanMaxFiles: 500,
  cliTimeoutSeconds: 600,
  logMaxBytes: LOG_ROTATE_BYTES,
});

const CONFIG_KEYS = new Set(Object.keys(DEFAULTS).concat([
  'version', 'taskName', 'installDir', 'notes',
]));

function scriptDir() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function packageRoot() {
  return path.resolve(scriptDir(), '..');
}

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function badConfig(message) {
  const error = new Error(message);
  error.code = 'WATCH_BAD_CONFIG';
  return error;
}

function argError(message) {
  const error = new Error(message);
  error.code = 'WATCH_BAD_ARGUMENT';
  return error;
}

function readText(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

function resolveFrom(baseDir, value) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(baseDir, value);
}

function asObject(value, label) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw badConfig(`${label} must be a JSON object`);
  }
  return value;
}

function cfgString(raw, key, fallback) {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw badConfig(`${key} must be a string`);
  return value;
}

function cfgBool(raw, key, fallback) {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw badConfig(`${key} must be a boolean`);
  return value;
}

function cfgInt(raw, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw badConfig(`${key} must be an integer in [${min}, ${max}] (got ${JSON.stringify(value)})`);
  }
  return value;
}

// ---------------------------------------------------------------------- YAML
// cordis.patch.yml is YAML, but the watcher only needs the scalar children of
// the `autoTruncate:` block. Pulling in a YAML parser (or writing a full one)
// would add a dependency for four integers and a mode string, so this is a
// deliberately narrow indentation reader: direct children of the *last*
// autoTruncate block, scalar values only, no anchors/flow collections.
export function extractAutoTruncateBlock(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let start = -1;
  let baseIndent = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^([ \t]*)autoTruncate[ \t]*:[ \t]*(?:#.*)?$/.exec(lines[i]);
    if (match) {
      start = i;
      baseIndent = match[1].length;
    }
  }
  if (start < 0) return { found: false, raw: {} };

  const raw = {};
  let childIndent = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || /^[ \t]*#/.test(line)) continue;
    const indent = (line.match(/^[ \t]*/) ?? [''])[0].length;
    if (indent <= baseIndent) break;
    const match = /^[ \t]*([A-Za-z0-9_.-]+)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!match) continue;
    if (childIndent === null) childIndent = indent;
    if (indent !== childIndent) continue;
    const valueText = stripYamlComment(match[2]).trim();
    if (valueText === '') continue;
    const parsedValue = parseYamlScalar(valueText);
    if (parsedValue !== undefined) raw[match[1]] = parsedValue;
  }
  return { found: true, raw };
}

function stripYamlComment(value) {
  let quote = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"') i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i);
  }
  return value;
}

function parseYamlScalar(text) {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?[0-9]+$/.test(text)) return Number(text);
  if (/^-?[0-9]+\.[0-9]+$/.test(text)) return Number(text);
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2)
    || (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    const inner = text.slice(1, -1);
    return text[0] === '"'
      ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      : inner.replace(/''/g, "'");
  }
  if (text.startsWith('{') || text.startsWith('[')) return undefined;
  return text;
}

// ------------------------------------------------------------------- config
function profileOverrides(profileConfig, baseDir) {
  const file = resolveFrom(baseDir, profileConfig);
  if (!fs.existsSync(file)) {
    throw badConfig(`profileConfig does not exist: ${file}`);
  }
  if (!fs.statSync(file).isFile()) throw badConfig(`profileConfig is not a file: ${file}`);
  let parsed;
  try {
    parsed = extractAutoTruncateBlock(readText(file));
  } catch (error) {
    throw badConfig(`cannot read profileConfig ${file}: ${error?.message ?? error}`);
  }
  let normalized;
  try {
    // Reuse the plugin's own validation: a typo in mode must fail closed here
    // exactly as it would in the app, not silently fall back to dryrun.
    normalized = normalizeAutoTruncateConfig(parsed.found ? parsed.raw : {});
  } catch (error) {
    throw badConfig(`autoTruncate block in ${file} is invalid: ${error?.message ?? error}`);
  }
  return { file, found: parsed.found, config: normalized };
}

export function loadConfig(configPath, { checkOnly = false } = {}) {
  const absConfig = path.resolve(configPath);
  if (!fs.existsSync(absConfig)) throw badConfig(`config does not exist: ${absConfig}`);
  let raw;
  try {
    raw = JSON.parse(readText(absConfig));
  } catch (error) {
    throw badConfig(`config is not valid JSON: ${absConfig} (${error?.message ?? error})`);
  }
  raw = asObject(raw, 'config');
  const baseDir = path.dirname(absConfig);
  const warnings = [];
  const unknown = Object.keys(raw).filter((key) => !CONFIG_KEYS.has(key));
  if (unknown.length > 0) warnings.push(`ignoring unknown config keys: ${unknown.join(', ')}`);

  const enabled = cfgBool(raw, 'enabled', DEFAULTS.enabled);
  const fileMode = cfgString(raw, 'mode', DEFAULTS.mode).trim().toLowerCase();
  if (!MODES.includes(fileMode)) {
    throw badConfig(`mode must be one of ${MODES.join('|')} (got ${JSON.stringify(fileMode)})`);
  }

  const dshHomeInput = cfgString(raw, 'dshHome', '').trim();
  const sessionsRootInput = cfgString(raw, 'sessionsRoot', '').trim();
  let dshHomePath = resolveFrom(baseDir, dshHomeInput)
    || (process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh'));
  let sessionsRoot = resolveFrom(baseDir, sessionsRootInput);
  if (!sessionsRoot) {
    sessionsRoot = path.join(dshHomePath, 'sessions');
  } else if (!dshHomeInput && path.basename(sessionsRoot).toLowerCase() === 'sessions') {
    // The CLI proves --session is under <DSH_HOME>/sessions; infer the home
    // from a caller-supplied sessions root so the two cannot disagree.
    dshHomePath = path.dirname(sessionsRoot);
  }

  const memoryRootInput = cfgString(raw, 'memoryRoot', '').trim();
  const memoryRoot = resolveFrom(baseDir, memoryRootInput)
    || (process.env.DSH_MEM ? path.resolve(process.env.DSH_MEM) : path.join(dshHomePath, 'longlive-memory'));

  const profileConfigInput = cfgString(raw, 'profileConfig', '').trim();
  let profile = null;
  let profileFile = '';
  if (profileConfigInput) {
    profile = profileOverrides(profileConfigInput, baseDir);
    profileFile = profile.file;
    if (!profile.found) {
      // A profile without an autoTruncate block says nothing about the
      // watcher. Treating the plugin defaults as an override would silently
      // turn a dryrun install into log mode, so fall back to config.json.
      warnings.push(`profileConfig ${profile.file} has no autoTruncate block; using config.json values`);
      profile = null;
    }
  }

  let mode = fileMode;
  let modeSource = 'config';
  let auto = null;
  if (profile) {
    auto = profile.config;
    mode = auto.mode;
    modeSource = `profile:${profile.file}`;
  }
  if (!MODES.includes(mode)) throw badConfig(`resolved mode is not supported: ${JSON.stringify(mode)}`);

  // Kill switch is an AND across layers: a profile may override mode and
  // thresholds, but it must not be able to re-enable a watcher that the
  // operator disabled in config.json. Either layer false means no action.
  const effectiveEnabled = profile ? (enabled && auto.enabled) : enabled;
  const tokensThreshold = profile ? auto.tokensThreshold : cfgInt(raw, 'tokensThreshold', DEFAULTS.tokensThreshold, { min: 0 });
  const minTurns = profile ? auto.minTurns : cfgInt(raw, 'minTurns', DEFAULTS.minTurns, { min: 0 });
  const keepTurns = profile ? auto.keepTurns : cfgInt(raw, 'keepTurns', DEFAULTS.keepTurns, { min: 1 });
  const keepTokens = profile ? auto.keepTokens : cfgInt(raw, 'keepTokens', DEFAULTS.keepTokens, { min: 1 });
  const firstUserCapChars = profile
    ? auto.firstUserCapChars
    : cfgInt(raw, 'firstUserCapChars', DEFAULTS.firstUserCapChars, { min: 1 });
  const boundaryRetries = profile
    ? auto.boundaryRetries
    : cfgInt(raw, 'boundaryRetries', DEFAULTS.boundaryRetries, { min: 0 });
  const cooldownMinutes = profile
    ? auto.cooldownMinutes
    : cfgInt(raw, 'cooldownMinutes', DEFAULTS.cooldownMinutes, { min: 0 });

  const config = {
    version: cfgInt(raw, 'version', 1, { min: 1 }),
    configPath: absConfig,
    configDir: baseDir,
    enabled: effectiveEnabled,
    mode,
    modeSource,
    fileMode,
    profile,
    intervalSeconds: cfgInt(raw, 'intervalSeconds', DEFAULTS.intervalSeconds, { min: 1 }),
    settleSeconds: cfgInt(raw, 'settleSeconds', DEFAULTS.settleSeconds, { min: 0 }),
    tokensThreshold,
    minTurns,
    bytesThreshold: cfgInt(raw, 'bytesThreshold', DEFAULTS.bytesThreshold, { min: 0 }),
    eventsThreshold: cfgInt(raw, 'eventsThreshold', DEFAULTS.eventsThreshold, { min: 0 }),
    keepTurns,
    keepTokens,
    firstUserCapChars,
    boundaryRetries,
    cooldownMinutes,
    profileConfig: profileFile,
    memoryRoot,
    sessionsRoot,
    dshHome: dshHomePath,
    nodeExe: resolveFrom(baseDir, cfgString(raw, 'nodeExe', '').trim()) || process.execPath,
    cliPath: resolveFrom(baseDir, cfgString(raw, 'cliPath', '').trim())
      || path.join(packageRoot(), 'scripts', 'truncate-cli.mjs'),
    logPath: '',
    statePath: '',
    receiptDir: '',
    lockPath: '',
    lastTickPath: '',
    stopFlag: '',
    scanMaxFiles: cfgInt(raw, 'scanMaxFiles', DEFAULTS.scanMaxFiles, { min: 1 }),
    cliTimeoutSeconds: cfgInt(raw, 'cliTimeoutSeconds', DEFAULTS.cliTimeoutSeconds, { min: 10 }),
    logMaxBytes: cfgInt(raw, 'logMaxBytes', DEFAULTS.logMaxBytes, { min: 1024 }),
    taskName: cfgString(raw, 'taskName', 'DshSessionWatch'),
    installDir: cfgString(raw, 'installDir', packageRoot()),
    warnings,
  };

  const defaultsForPaths = {
    logPath: path.join(memoryRoot, '.longlive', 'logs', 'session-watch.log'),
    statePath: path.join(memoryRoot, '.longlive', 'session-watch', 'state.json'),
    receiptDir: path.join(memoryRoot, '.longlive', 'session-watch', 'receipts'),
    lockPath: path.join(memoryRoot, '.longlive', 'session-watch', 'watch.pid'),
    lastTickPath: path.join(memoryRoot, '.longlive', 'session-watch', 'last-tick.json'),
    stopFlag: path.join(memoryRoot, '.longlive', 'session-watch', 'stop.flag'),
  };
  for (const [key, fallback] of Object.entries(defaultsForPaths)) {
    config[key] = resolveFrom(baseDir, cfgString(raw, key, '').trim()) || fallback;
  }

  // "At least one threshold" is not an error: a deliberately inert install is
  // a valid way to stage the task before turning it on.
  if (config.tokensThreshold === 0 && config.bytesThreshold === 0 && config.eventsThreshold === 0) {
    config.warnings.push('all thresholds are 0: no session can ever become a candidate');
  }
  if (!fs.existsSync(config.nodeExe)) throw badConfig(`nodeExe does not exist: ${config.nodeExe}`);
  if (!fs.existsSync(config.cliPath)) throw badConfig(`cliPath does not exist: ${config.cliPath}`);
  if (!fs.existsSync(config.memoryRoot) || !fs.statSync(config.memoryRoot).isDirectory()) {
    throw badConfig(`memoryRoot does not exist or is not a directory: ${config.memoryRoot}`);
  }

  if (!checkOnly) {
    for (const dir of [path.dirname(config.logPath), path.dirname(config.statePath), config.receiptDir,
      path.dirname(config.lockPath), path.dirname(config.lastTickPath), path.dirname(config.stopFlag)]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  return config;
}

function configForCheck(config) {
  const result = { ...config };
  delete result.profile;
  result.enabled = config.enabled;
  result.paths = {
    nodeExe: config.nodeExe,
    cliPath: config.cliPath,
    logPath: config.logPath,
    statePath: config.statePath,
    receiptDir: config.receiptDir,
    lockPath: config.lockPath,
    stopFlag: config.stopFlag,
  };
  return result;
}

// --------------------------------------------------------------------- state
function readState(statePath) {
  const empty = { version: 1, updatedAt: null, sessions: {} };
  if (!fs.existsSync(statePath)) return empty;
  try {
    const parsed = JSON.parse(readText(statePath));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.sessions !== 'object' || parsed.sessions == null) {
      return empty;
    }
    return { version: 1, updatedAt: parsed.updatedAt ?? null, sessions: parsed.sessions };
  } catch {
    try {
      fs.renameSync(statePath, `${statePath}.corrupt-${Date.now()}`);
    } catch { /* read-only evidence is not worth killing the tick */ }
    return empty;
  }
}

function writeDurable(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

// A disabled or stopped tick is still a tick: record it so `status` can show
// the current kill-switch state instead of a stale last result.
function writeLastTick(config, summary) {
  try {
    writeDurable(config.lastTickPath, `${JSON.stringify(summary, null, 2)}\n`);
  } catch { /* last-tick is convenience, not evidence */ }
}

function writeState(config, state) {
  const entries = Object.entries(state.sessions ?? {});
  entries.sort((a, b) => (b[1]?.updatedAtMs ?? 0) - (a[1]?.updatedAtMs ?? 0));
  const trimmed = Object.fromEntries(entries.slice(0, MAX_STATE_SESSIONS));
  const body = {
    version: 1,
    updatedAt: nowIso(),
    sessions: trimmed,
  };
  try {
    writeDurable(config.statePath, `${JSON.stringify(body, null, 2)}\n`);
    return true;
  } catch (error) {
    log(config, { event: 'state-write-failed', error: stringifyError(error) });
    return false;
  }
}

// ------------------------------------------------------------------ logging
function rotateLog(config) {
  try {
    const stat = fs.statSync(config.logPath);
    if (stat.size <= config.logMaxBytes) return;
    const old = `${config.logPath}.1`;
    try { fs.rmSync(old, { force: true }); } catch { /* ignore */ }
    fs.renameSync(config.logPath, old);
  } catch { /* no log yet */ }
}

function log(config, record, { alsoStderr = false } = {}) {
  const line = JSON.stringify({ at: nowIso(), pid: process.pid, ...record });
  try {
    rotateLog(config);
    fs.appendFileSync(config.logPath, `${line}\n`, 'utf8');
  } catch (error) {
    process.stderr.write(`session-watch: cannot write log ${config.logPath}: ${error?.message ?? error}\n`);
  }
  if (alsoStderr) process.stderr.write(`${line}\n`);
}

function stringifyError(error) {
  return {
    code: error?.code ?? null,
    message: String(error?.message ?? error).slice(0, 2_000),
  };
}

// ----------------------------------------------------------------- scanning
function scanSessionFiles(root, maxFiles) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const walk = (dir, depth) => {
    if (out.length >= maxFiles || depth > MAX_SCAN_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name === SESSION_FILE) {
        out.push(full);
      }
    }
  };
  walk(root, 0);
  out.sort();
  return out;
}

function sessionMeta(file, config) {
  const rel = path.relative(config.sessionsRoot, file);
  const parts = rel.split(path.sep);
  const scope = parts.length >= 3 ? parts[0] : '';
  const folderId = path.basename(path.dirname(file));
  return { scope, folderId };
}

function localHostName() {
  return os.hostname();
}

function sameHost(host) {
  return typeof host === 'string' && host.toLowerCase() === localHostName().toLowerCase();
}

function readLive(config) {
  try {
    const listed = liveList({ includeDead: true }, { memoryRoot: config.memoryRoot });
    const byId = new Map();
    for (const entry of listed.entries ?? []) {
      const id = String(entry.sessionId ?? '').toLowerCase();
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(entry);
    }
    return { ok: true, byId, count: listed.count ?? 0, error: null };
  } catch (error) {
    return { ok: false, byId: new Map(), count: 0, error: stringifyError(error) };
  }
}

function healthCheck({ file, stat, ids, live, config, now }) {
  const reasons = [];
  if (!live.ok) {
    reasons.push({ signal: 'live-registry', state: 'unavailable', detail: live.error?.message ?? 'unknown' });
  } else {
    for (const id of ids) {
      for (const row of live.byId.get(id.toLowerCase()) ?? []) {
        const state = row.effectiveState ?? row.state ?? 'unknown';
        const pid = Number.isInteger(row.pid) ? row.pid : null;
        const host = row.host ?? null;
        if (state === 'corrupt') {
          reasons.push({ signal: 'live-registry', state, sessionId: row.sessionId, detail: 'row is corrupt; fail closed' });
        } else if (state === 'running' || state === 'waiting' || state === 'blocked' || state === 'idle') {
          reasons.push({
            signal: 'live-registry',
            state,
            sessionId: row.sessionId,
            pid,
            heartbeatAt: row.heartbeatAt ?? null,
            detail: 'fresh heartbeat -- the writer still owns this session',
          });
        } else if (pid != null && pid > 0 && (host == null || sameHost(host)) && pidAlive(pid)) {
          // stale/dead by heartbeat, but the recorded process is still here:
          // a heartbeat writer can pause, a pid is harder evidence.
          reasons.push({
            signal: 'pid',
            state,
            sessionId: row.sessionId,
            pid,
            detail: 'recorded process is still alive',
          });
        }
      }
    }
  }
  if (now - stat.mtimeMs < config.settleSeconds * 1000) {
    reasons.push({
      signal: 'settle',
      mtime: new Date(stat.mtimeMs).toISOString(),
      settleSeconds: config.settleSeconds,
      detail: 'file changed too recently; wait for the writer to finish',
    });
  }
  const inflight = inflightPathFor(file);
  if (fs.existsSync(inflight)) {
    reasons.push({ signal: 'inflight', path: inflight, detail: 'another truncation left an in-flight record' });
  }
  return { ok: reasons.length === 0, reasons, inflightPath: inflight };
}

function decisionFor(estimate, config) {
  const reasons = [];
  if (config.tokensThreshold > 0 && estimate.tokens >= config.tokensThreshold && estimate.turns > config.minTurns) {
    reasons.push({
      kind: 'tokens', value: estimate.tokens, threshold: config.tokensThreshold, minTurns: config.minTurns,
      turns: estimate.turns,
    });
  }
  if (config.bytesThreshold > 0 && estimate.bytes >= config.bytesThreshold) {
    reasons.push({ kind: 'bytes', value: estimate.bytes, threshold: config.bytesThreshold });
  }
  if (config.eventsThreshold > 0 && estimate.events >= config.eventsThreshold) {
    reasons.push({ kind: 'events', value: estimate.events, threshold: config.eventsThreshold });
  }
  return reasons;
}

function cooldownWait(config, record, now) {
  if (!record) return null;
  if (record.failures > 0) {
    const base = Math.max(config.cooldownMinutes, 5);
    const minutes = Math.min(60, base * 2 ** Math.min(record.failures - 1, 3));
    const until = (record.lastAttemptAtMs ?? 0) + minutes * 60_000;
    if (until > now) return { until, minutes, kind: 'backoff' };
    return null;
  }
  if (config.cooldownMinutes > 0 && record.lastAttemptAtMs) {
    const until = record.lastAttemptAtMs + config.cooldownMinutes * 60_000;
    if (until > now) return { until, minutes: config.cooldownMinutes, kind: 'cooldown' };
  }
  return null;
}

// ------------------------------------------------------------------- runner
function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function parseCliJson(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try {
      return JSON.parse(lines[i]);
    } catch { /* keep looking */ }
  }
  return null;
}

function runCli(config, file, mode) {
  const args = [
    config.cliPath,
    '--session', file,
    '--keep-turns', String(config.keepTurns),
    '--keep-tokens', String(config.keepTokens),
    '--first-user-cap', String(config.firstUserCapChars),
    '--boundary-retries', String(config.boundaryRetries),
    '--memory-root', config.memoryRoot,
  ];
  if (mode === 'dryrun') {
    args.push('--dry-run');
  } else {
    args.push('--confirm', 'TRUNCATE-VISIBLE');
  }
  const env = { ...process.env };
  delete env.DSH_SESSION_ID;
  env.DSH_HOME = config.dshHome;
  env.DSH_MEM = config.memoryRoot;

  const started = Date.now();
  let result;
  try {
    result = spawnSync(config.nodeExe, args, {
      cwd: path.dirname(config.cliPath),
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: config.cliTimeoutSeconds * 1000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    return {
      ok: false,
      exitCode: null,
      signal: null,
      durationMs: Date.now() - started,
      json: null,
      error: stringifyError(error),
      stderr: '',
      argv: args,
    };
  }
  const json = parseCliJson(result.stdout);
  const timedOut = result.error?.code === 'ETIMEDOUT';
  return {
    ok: !timedOut && result.status === 0 && json != null && json.ok !== false,
    exitCode: result.status,
    signal: result.signal ?? null,
    durationMs: Date.now() - started,
    json,
    error: result.error ? stringifyError(result.error) : null,
    timedOut,
    stderr: String(result.stderr ?? '').slice(0, 4_000),
    argv: args,
  };
}

function verifyDryRun({ file, beforeHash, archiveExistedBefore, cli }) {
  const checks = [];
  let afterHash = null;
  try {
    afterHash = sha256File(file);
  } catch (error) {
    checks.push({ name: 'session-readable-after', ok: false, detail: stringifyError(error) });
  }
  if (afterHash != null) {
    checks.push({ name: 'session-unchanged', ok: afterHash === beforeHash, beforeHash, afterHash });
  }
  checks.push({ name: 'no-backup', ok: !cli.json?.backupPath, backupPath: cli.json?.backupPath ?? null });
  const archivePath = cli.json?.archivePath ?? null;
  if (archivePath) {
    checks.push({
      name: 'no-archive-created',
      ok: archiveExistedBefore || !fs.existsSync(archivePath),
      archivePath,
      existedBefore: archiveExistedBefore,
    });
  }
  checks.push({ name: 'no-inflight', ok: !fs.existsSync(inflightPathFor(file)) });
  return { ok: checks.every((check) => check.ok), checks };
}

function verifyRequest({ file, beforeHash, beforeStat, cli }) {
  const checks = [];
  const json = cli.json;
  if (!json) return { ok: false, checks: [{ name: 'cli-json', ok: false }] };
  if (json.status === 'noop') {
    checks.push({ name: 'cli-noop', ok: true, needed: json.needed === false });
    checks.push({ name: 'session-unchanged-on-noop', ok: sha256File(file) === beforeHash });
    return { ok: checks.every((check) => check.ok), checks };
  }
  const afterStat = (() => {
    try { return fs.statSync(file); } catch { return null; }
  })();
  checks.push({
    name: 'bytes-shrunk',
    ok: Boolean(afterStat && json.bytes?.after != null && afterStat.size === json.bytes.after && afterStat.size < beforeStat.size),
    beforeBytes: beforeStat.size,
    afterBytes: afterStat?.size ?? null,
    reportedAfter: json.bytes?.after ?? null,
  });
  checks.push({
    name: 'reported-status',
    ok: json.status === 'truncated' && json.applied === true,
    status: json.status,
    applied: json.applied,
  });
  const expectedAfter = json.after?.sha256 ?? null;
  checks.push({
    name: 'session-sha-matches-plan',
    ok: expectedAfter != null && sha256File(file) === expectedAfter,
    expected: expectedAfter,
  });
  checks.push({
    name: 'snapshot-sha-matches',
    ok: json.before?.sha256 === beforeHash,
    cliSnapshot: json.before?.sha256 ?? null,
    observed: beforeHash,
  });
  const backupPath = json.backupPath ?? null;
  let backupOk = false;
  let backupHash = null;
  if (backupPath && fs.existsSync(backupPath)) {
    backupHash = sha256File(backupPath);
    backupOk = backupHash === beforeHash;
  }
  checks.push({
    name: 'backup-exists-and-matches',
    ok: backupOk,
    backupPath,
    backupHash,
    expected: beforeHash,
  });
  const archivePath = json.archivePath ?? null;
  checks.push({
    name: 'archive-exists',
    ok: Boolean(archivePath && fs.existsSync(archivePath)),
    archivePath,
  });
  checks.push({ name: 'no-inflight-left', ok: !fs.existsSync(inflightPathFor(file)) });
  return { ok: checks.every((check) => check.ok), checks };
}

function receiptPathFor(config, sessionId, mode, now) {
  const stamp = nowIso(now).replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const safe = String(sessionId || 'session').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return path.join(config.receiptDir, `${stamp}-${safe}-${mode}.json`);
}

function ensureEvidenceWritable(config) {
  fs.mkdirSync(config.receiptDir, { recursive: true });
  const probe = path.join(config.receiptDir, `.probe-${process.pid}`);
  fs.writeFileSync(probe, 'ok', 'utf8');
  fs.rmSync(probe, { force: true });
}

function makeReceiptMaybeUnique(config, sessionId, mode, now) {
  let file = receiptPathFor(config, sessionId, mode, now);
  if (fs.existsSync(file)) file = file.replace(/\.json$/, `-${process.pid}.json`);
  return file;
}

// --------------------------------------------------------------------- tick
function stopRequested(config) {
  try {
    return fs.existsSync(config.stopFlag);
  } catch {
    return false;
  }
}

function tick(config, { verbose = false } = {}) {
  const startedAt = Date.now();
  const summary = {
    ok: true,
    at: nowIso(startedAt),
    pid: process.pid,
    version: WATCH_VERSION,
    enabled: config.enabled,
    mode: config.mode,
    modeSource: config.modeSource,
    configPath: config.configPath,
    memoryRoot: config.memoryRoot,
    sessionsRoot: config.sessionsRoot,
    scanned: 0,
    candidates: 0,
    actions: [],
    blocked: [],
    errors: [],
    intervalSeconds: config.intervalSeconds,
    stop: false,
  };
  if (stopRequested(config)) {
    summary.stop = true;
    summary.status = 'stop-flag';
    writeLastTick(config, summary);
    return summary;
  }
  if (!config.enabled) {
    summary.status = 'disabled';
    writeLastTick(config, summary);
    return summary;
  }

  const live = readLive(config);
  if (!live.ok) {
    summary.errors.push({ stage: 'live-registry', ...live.error });
    // Fail closed: no cut just because the registry became unreadable.
    summary.ok = false;
    summary.status = 'live-registry-unavailable';
    writeLastTick(config, summary);
    return summary;
  }

  const state = readState(config.statePath);
  let stateDirty = false;
  let files;
  try {
    files = scanSessionFiles(config.sessionsRoot, config.scanMaxFiles);
  } catch (error) {
    summary.errors.push({ stage: 'scan', ...stringifyError(error) });
    summary.ok = false;
    summary.status = 'scan-failed';
    return summary;
  }
  summary.scanned = files.length;

  for (const file of files) {
    if (stopRequested(config)) {
      summary.stop = true;
      break;
    }
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (error) {
      summary.errors.push({ stage: 'stat', file, ...stringifyError(error) });
      continue;
    }
    if (!stat.isFile() || stat.size === 0) continue;

    const key = path.resolve(file).toLowerCase();
    const meta = sessionMeta(file, config);
    let record = state.sessions[key] ?? null;
    let ids = [meta.folderId];
    let estimate = null;
    let parseError = null;

    if (record && record.size === stat.size && record.mtimeMs === Math.trunc(stat.mtimeMs) && record.estimate) {
      estimate = record.estimate;
      ids = Array.isArray(record.ids) && record.ids.length > 0 ? record.ids : ids;
    } else {
      try {
        const parsed = parseSession(fs.readFileSync(file));
        estimate = sessionEstimate(parsed);
        const headerId = typeof parsed.header?.id === 'string' ? parsed.header.id.trim() : '';
        ids = headerId && headerId !== meta.folderId ? [meta.folderId, headerId] : [meta.folderId];
        record = {
          ...(record ?? {}),
          path: file,
          size: stat.size,
          mtimeMs: Math.trunc(stat.mtimeMs),
          estimate,
          ids,
          updatedAtMs: Date.now(),
        };
        state.sessions[key] = record;
        stateDirty = true;
      } catch (error) {
        parseError = error;
      }
    }

    if (parseError) {
      // A torn log is usually a live writer; let health decide whether it is
      // safety or just damage. Either way: never invoke the CLI on unparsed
      // bytes, and back off so a permanently corrupt file cannot spin the CPU.
      const health = healthCheck({ file, stat, ids, live, config, now: Date.now() });
      summary.errors.push({
        stage: 'parse', file, ...stringifyError(parseError),
        health: health.ok ? 'free' : 'blocked',
        healthReasons: health.reasons,
      });
      const now = Date.now();
      const failures = (record?.failures ?? 0) + 1;
      state.sessions[key] = {
        ...(record ?? { path: file }),
        failures,
        lastAttemptAtMs: now,
        lastStatus: 'parse-error',
        lastError: String(parseError.message ?? parseError).slice(0, 1_000),
        updatedAtMs: now,
      };
      stateDirty = true;
      continue;
    }

    const reasons = decisionFor(estimate, config);
    if (reasons.length === 0) continue;
    summary.candidates += 1;

    const now = Date.now();
    const wait = cooldownWait(config, record, now);
    if (wait) {
      summary.blocked.push({
        file, sessionId: ids[0], stage: 'cooldown', waitUntil: new Date(wait.until).toISOString(),
        minutes: wait.minutes, kind: wait.kind,
      });
      continue;
    }

    const health = healthCheck({ file, stat, ids, live, config, now });
    if (!health.ok) {
      summary.blocked.push({ file, sessionId: ids[0], stage: 'health', reasons: health.reasons });
      state.sessions[key] = {
        ...(record ?? { path: file }),
        lastBlockedAtMs: now,
        lastStatus: 'blocked-live',
        lastHealth: health.reasons,
        updatedAtMs: now,
      };
      stateDirty = true;
      continue;
    }

    if (config.mode === 'log') {
      summary.actions.push({
        file, sessionId: ids[0], status: 'would-truncate', mode: 'log', reasons,
        estimate: { bytes: estimate.bytes, events: estimate.events, tokens: estimate.tokens, turns: estimate.turns },
      });
      state.sessions[key] = {
        ...(record ?? { path: file }),
        lastWouldAtMs: now,
        lastStatus: 'would-truncate',
        updatedAtMs: now,
      };
      stateDirty = true;
      continue;
    }

    try {
      ensureEvidenceWritable(config);
    } catch (error) {
      summary.errors.push({ stage: 'receipt-dir', file, ...stringifyError(error) });
      state.sessions[key] = {
        ...(record ?? { path: file }),
        lastStatus: 'evidence-unwritable',
        lastError: String(error?.message ?? error).slice(0, 1_000),
        updatedAtMs: now,
      };
      stateDirty = true;
      continue;
    }

    let beforeHash;
    let beforeStat;
    let archiveExistedBefore = false;
    try {
      beforeHash = sha256File(file);
      beforeStat = fs.statSync(file);
    } catch (error) {
      summary.errors.push({ stage: 'snapshot', file, ...stringifyError(error) });
      continue;
    }

    const cli = runCli(config, file, config.mode);
    let verification;
    let status;
    if (cli.json?.code === 'SESSION_IS_RUNNING') {
      status = 'blocked-live';
      verification = { ok: false, skipped: 'session-is-running', code: cli.json.code };
    } else if (cli.exitCode !== 0 || !cli.json) {
      status = 'failed';
      verification = { ok: false, checks: [] };
    } else if (config.mode === 'dryrun') {
      // A dry-run can legitimately answer `infeasible` (keep budget too high):
      // that is a plan result, not a watcher failure. What must hold is that
      // nothing moved, so verification still checks the file bytes.
      const plannedArchive = cli.json?.archivePath ?? null;
      archiveExistedBefore = Boolean(plannedArchive && fs.existsSync(plannedArchive));
      verification = verifyDryRun({ file, beforeHash, archiveExistedBefore, cli });
      status = verification.ok
        ? (cli.json?.status === 'noop' ? 'noop' : cli.json?.status === 'infeasible' ? 'infeasible' : 'planned')
        : 'failed-verification';
    } else {
      verification = verifyRequest({ file, beforeHash, beforeStat, cli });
      status = verification.ok
        ? (cli.json?.status === 'noop' ? 'noop' : 'truncated')
        : 'failed-verification';
    }

    const receiptPath = makeReceiptMaybeUnique(config, ids[0], config.mode, now);
    const receipt = {
      version: 1,
      kind: 'session-watch',
      at: nowIso(now),
      host: localHostName(),
      watcherPid: process.pid,
      mode: config.mode,
      modeSource: config.modeSource,
      dryRun: config.mode !== 'request',
      configPath: config.configPath,
      profileConfig: config.profileConfig,
      memoryRoot: config.memoryRoot,
      session: {
        path: file,
        id: ids[0],
        ids,
        scope: meta.scope,
        sizeBefore: beforeStat.size,
        mtimeBefore: new Date(beforeStat.mtimeMs).toISOString(),
        sha256Before: beforeHash,
      },
      estimate,
      decision: reasons,
      health,
      cli,
      verification,
      status,
      wroteSession: config.mode === 'request' && status === 'truncated',
    };
    let receiptWritten = false;
    try {
      receipt.receiptPath = receiptPath;
      writeDurable(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      receiptWritten = true;
    } catch (error) {
      summary.errors.push({ stage: 'receipt-write', file, ...stringifyError(error) });
      log(config, { event: 'receipt-write-failed', file, error: stringifyError(error) });
    }

    summary.actions.push({
      file,
      sessionId: ids[0],
      status,
      mode: config.mode,
      reasons,
      cliExitCode: cli.exitCode,
      cliStatus: cli.json?.status ?? null,
      verificationOk: verification.ok,
      receiptPath,
      receiptWritten,
      bytesBefore: beforeStat.size,
      bytesAfter: cli.json?.bytes?.after ?? null,
      backupPath: cli.json?.backupPath ?? null,
    });

    record = {
      ...(record ?? { path: file }),
      path: file,
      ids,
      lastAttemptAtMs: config.mode === 'request' ? now : (record?.lastAttemptAtMs ?? null),
      lastStatus: status,
      lastMode: config.mode,
      lastReceipt: receiptPath,
      lastVerification: verification.ok,
      lastError: cli.error?.message ?? null,
      failures: (config.mode === 'request' && status !== 'truncated' && status !== 'noop' && status !== 'blocked-live')
        ? (record?.failures ?? 0) + 1
        : 0,
      updatedAtMs: now,
    };
    state.sessions[key] = record;
    stateDirty = true;
    log(config, {
      event: 'action', mode: config.mode, file, sessionId: ids[0], status,
      verificationOk: verification.ok, receipt: receiptPath, receiptWritten,
      cliExitCode: cli.exitCode, bytesBefore: beforeStat.size, bytesAfter: cli.json?.bytes?.after ?? null,
    }, { alsoStderr: verbose });

    if (verification.ok && cli.json?.status !== 'noop' && config.mode === 'request') {
      state.sessions[key].lastTruncatedAtMs = now;
      state.sessions[key].lastBackup = cli.json?.backupPath ?? null;
      state.sessions[key].lastArchive = cli.json?.archivePath ?? null;
    }
  }

  if (stateDirty) writeState(config, state);
  summary.ok = summary.errors.length === 0;
  summary.status = summary.ok ? 'ok' : 'degraded';
  writeLastTick(config, summary);
  return summary;
}

// --------------------------------------------------------------------- loop
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function acquireLock(config) {
  const lockPath = config.lockPath;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, `${process.pid}\n`, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let holder = null;
      try { holder = Number.parseInt(readText(lockPath).trim(), 10); } catch { /* unreadable */ }
      if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && pidAlive(holder)) {
        return { ok: false, holder };
      }
      try { fs.rmSync(lockPath, { force: true }); } catch { /* retry */ }
    }
  }
  return { ok: false, holder: null };
}

function releaseLock(config) {
  try {
    const holder = Number.parseInt(readText(config.lockPath).trim(), 10);
    if (holder === process.pid) fs.rmSync(config.lockPath, { force: true });
  } catch { /* no lock */ }
}

async function loop(configPath, options) {
  let stop = false;
  const onSignal = () => { stop = true; };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  let lastScanAt = 0;
  let lastDisabledLogAt = 0;
  let lastErrorLogAt = 0;
  let config = null;
  let lock = null;
  try {
    config = loadConfig(configPath);
    lock = acquireLock(config);
    if (!lock.ok) {
      process.stderr.write(`session-watch: another watcher holds ${config.lockPath} (pid ${lock.holder ?? 'unknown'}); exiting\n`);
      return 0;
    }
    log(config, { event: 'loop-start', version: WATCH_VERSION, configPath: config.configPath, mode: config.mode });
    while (!stop) {
      let current;
      try {
        current = loadConfig(configPath, { checkOnly: true });
      } catch (error) {
        if (Date.now() - lastErrorLogAt > DISABLED_LOG_EVERY_MS) {
          lastErrorLogAt = Date.now();
          process.stderr.write(`session-watch: config error, not acting: ${error?.message ?? error}\n`);
          if (config) log(config, { event: 'config-error', error: stringifyError(error) });
        }
        await sleep(STOP_CHECK_MS);
        continue;
      }
      if (stopRequested(current)) {
        log(current, { event: 'stop-flag', path: current.stopFlag });
        return 0;
      }
      if (!current.enabled) {
        if (Date.now() - lastDisabledLogAt > DISABLED_LOG_EVERY_MS) {
          lastDisabledLogAt = Date.now();
          log(current, { event: 'disabled', mode: current.mode, modeSource: current.modeSource });
        }
        await sleep(STOP_CHECK_MS);
        continue;
      }
      const intervalMs = current.intervalSeconds * 1000;
      if (Date.now() - lastScanAt >= intervalMs) {
        const summary = tick(current, { verbose: options.verbose });
        lastScanAt = Date.now();
        log(current, { event: 'tick', ...summary }, { alsoStderr: options.verbose });
        if (summary.stop) return 0;
      }
      const wait = Math.max(1_000, Math.min(STOP_CHECK_MS, intervalMs - (Date.now() - lastScanAt)));
      await sleep(wait);
    }
    return 0;
  } finally {
    if (lock?.ok) {
      releaseLock(config);
      log(config, { event: 'loop-stop', version: WATCH_VERSION });
    }
  }
}

// --------------------------------------------------------------------- main
function parseArgs(argv) {
  const options = {
    configPath: path.resolve(scriptDir(), '..', 'session-watch.config.json'),
    once: false,
    loop: false,
    dryRun: false,
    check: false,
    verbose: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw argError(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--config') options.configPath = path.resolve(take());
    else if (arg === '--once') options.once = true;
    else if (arg === '--loop') options.loop = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw argError(`unknown argument: ${arg}`);
  }
  if (options.once && options.loop) throw argError('--once and --loop are mutually exclusive');
  if (!options.once && !options.loop && !options.check && !options.help) options.once = true;
  return options;
}

function usage() {
  return [
    'session-watch: resident threshold watchdog for visible truncation',
    '',
    '  node scripts/session-watch.mjs --config <config.json> --check',
    '  node scripts/session-watch.mjs --config <config.json> --once [--dry-run]',
    '  node scripts/session-watch.mjs --config <config.json> --loop',
    '',
    '  --dry-run   force mode=dryrun for this run (never upgrades to a write)',
    '  --verbose   mirror log lines to stderr',
  ].join('\n');
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  let config;
  try {
    config = loadConfig(options.configPath, { checkOnly: options.check });
  } catch (error) {
    const body = { ok: false, code: error?.code ?? 'WATCH_CONFIG_FAILED', message: String(error?.message ?? error) };
    process.stdout.write(`${JSON.stringify(body)}\n`);
    process.exitCode = 3;
    return;
  }
  if (options.dryRun) {
    config.mode = 'dryrun';
    config.modeSource = `${config.modeSource}+cli:--dry-run`;
  }

  if (options.check) {
    const body = { ok: true, status: 'checked', ...configForCheck(config) };
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    process.exitCode = 0;
    return;
  }

  if (options.loop) {
    const code = await loop(options.configPath, { verbose: options.verbose });
    process.exitCode = code;
    return;
  }

  // --once: one tick, fail-soft. A session-level failure is reported in the
  // JSON but does not become a non-zero exit, so a scheduler/manual run does
  // not conflate "the watcher is broken" with "one log is corrupt".
  const summary = tick(config, { verbose: options.verbose });
  const body = { ok: summary.ok, ...summary, configPath: config.configPath };
  log(config, { event: 'tick-once', ...body }, { alsoStderr: options.verbose });
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  process.exitCode = 0;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((error) => {
    const body = { ok: false, code: error?.code ?? 'WATCH_FATAL', message: String(error?.message ?? error) };
    try { process.stderr.write(`${JSON.stringify(body)}\n`); } catch { /* ignore */ }
    process.exitCode = 3;
  });
}

export { DEFAULTS, MODES, tick, decisionFor, healthCheck, cooldownWait };
