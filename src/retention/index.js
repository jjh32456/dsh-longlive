// Unified retention engine for the long-live memory store.
//
// One planner per layer, a dry-run-first executor, and one audit manifest. The
// engine never deletes a card, a journal entry, a session log or an index main
// file: every layer has an explicit allow-list and a protected-name guard.
//
// Layers
//   hot-truncate  : capacity (default 2 GiB) + age (default 14 d); a file may
//                   only be removed after its cut turns are covered by a card
//                   or card anchor. Uncovered files are postponed, not deleted.
//   tool-output   : age (default 90 d, optional per-turn TTL metadata) + capacity.
//   index         : keep the newest N verify/build JSON artifacts (default 5).
//   handoff       : age (default 180 d) + capacity; a handoff archive manifest
//                   is written before deletion.
//   backup        : daily session dirs (14 d) and profile snapshots (7).
//   health        : .longlive size vs. budget, reported in the status JSON.

import fs from 'node:fs';
import path from 'node:path';
import { RETENTION_DEFAULTS, normalizeRetentionConfig } from './config.js';

export { RETENTION_DEFAULTS, normalizeRetentionConfig } from './config.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_SCHEMA = 'dsh-retention/v1';
const RETENTION_DIR = 'retention';
const AUDIT_DIR = 'audit';
const HANDOFF_ARCHIVE_DIR = 'handoff-archive';

const PROTECTED_BASENAMES = new Set([
  'cards.jsonl',
  'events.db',
  'events.audit.jsonl',
  'card-anchors.jsonl',
  'INDEX.md',
  'STATE.md',
  'POLICY.md',
  'memory-state.json',
  'build-state.json',
  'status.json',
  'backups.json',
  'session.v4.jsonl.zstd',
]);

function statSafe(file) {
  try {
    const s = fs.statSync(file);
    return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory() };
  } catch {
    return null;
  }
}

function isInside(root, file) {
  const r = path.resolve(root);
  const p = path.resolve(file);
  return p === r || p.startsWith(r + path.sep);
}

function relOf(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    let s;
    try {
      s = fs.statSync(file);
    } catch {
      continue;
    }
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walkFiles(file, out);
    else if (entry.isFile()) out.push({ file, size: s.size, mtimeMs: s.mtimeMs });
  }
  return out;
}

function walkDirs(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    out.push({ file: full, name: entry.name, mtimeMs: statSafe(full)?.mtimeMs ?? 0 });
    walkDirs(full, out);
  }
  return out;
}

function jsonLines(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* a partially-written row is skipped, not fatal */
    }
  }
  return rows;
}

function stamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', 'T');
}

function safeStamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function addDays(date, days) {
  return new Date(date.getTime() - days * DAY_MS);
}

function bytesSum(items) {
  return items.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
}

function protectedName(file) {
  return PROTECTED_BASENAMES.has(path.basename(file));
}

/** Redact absolute paths from the audit? No: this is a local audit and the
 * operator needs exact paths for recovery. Tests only use temp roots. */
function actionFor(file, root, layer) {
  return {
    layer,
    path: path.resolve(file),
    rel: relOf(root, file),
    size: statSafe(file)?.size ?? 0,
  };
}

function deleteFile(file, root, { dryRun, actions, errors, layer }) {
  if (!isInside(root, file)) {
    errors.push({ layer, path: file, reason: 'outside-layer-root' });
    return false;
  }
  if (protectedName(file)) {
    errors.push({ layer, path: file, reason: 'protected-basename' });
    return false;
  }
  if (dryRun) {
    actions.push({ ...actionFor(file, root, layer), dryRun: true });
    return true;
  }
  try {
    fs.rmSync(file, { force: true });
    actions.push({ ...actionFor(file, root, layer), dryRun: false });
    return true;
  } catch (error) {
    errors.push({ layer, path: file, reason: error?.code ?? error?.message ?? String(error) });
    return false;
  }
}

function pruneEmptyDirs(root, keepRoot = true) {
  const dirs = walkDirs(root).sort((a, b) => b.file.length - a.file.length);
  for (const dir of dirs) {
    if (keepRoot && path.resolve(dir.file) === path.resolve(root)) continue;
    try {
      if (fs.readdirSync(dir.file).length === 0) fs.rmdirSync(dir.file);
    } catch {
      /* best-effort */
    }
  }
}

// ---------------------------------------------------------------------------
// hot-truncate
// ---------------------------------------------------------------------------

function loadCoverage(memoryRoot) {
  const indexDir = path.join(memoryRoot, '.longlive', 'index');
  const covered = new Set();
  for (const file of [path.join(indexDir, 'cards.jsonl'), path.join(indexDir, 'card-anchors.jsonl')]) {
    for (const row of jsonLines(file)) {
      const sessionId = row?.sessionId ?? row?.anchor?.sessionId;
      const turn = row?.turn ?? row?.anchor?.turn;
      if (typeof sessionId === 'string' && Number.isFinite(Number(turn))) {
        covered.add(`${sessionId}|${Number(turn)}`);
      }
    }
  }
  return covered;
}

function hotHeader(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const line = text.split('\n').find((value) => value.trim());
  if (!line) return null;
  try {
    const row = JSON.parse(line);
    return row && row.kind === 'hot-truncate/header' ? row : null;
  } catch {
    return null;
  }
}

function hotCovered(file, covered) {
  const header = hotHeader(file);
  const turns = Array.isArray(header?.cutTurns) ? header.cutTurns : [];
  if (turns.length === 0 || typeof header?.sessionId !== 'string') return false;
  return turns.every((entry) => covered.has(`${header.sessionId}|${Number(entry.turn)}`));
}

function planHotTruncate(memoryRoot, cfg, now) {
  const root = path.join(memoryRoot, '.longlive', 'hot-truncate');
  const files = walkFiles(root).sort((a, b) => a.mtimeMs - b.mtimeMs);
  const coverage = loadCoverage(memoryRoot);
  const cutoff = addDays(now, cfg.maxAgeDays).getTime();
  let total = bytesSum(files);
  const plan = [];
  const postponed = [];
  for (const item of files) {
    const overAge = cfg.maxAgeDays >= 0 && item.mtimeMs < cutoff;
    if (!overAge && total <= cfg.maxBytes) continue;
    if (cfg.requireCoverage && !hotCovered(item.file, coverage)) {
      postponed.push({
        path: item.file,
        rel: relOf(root, item.file),
        size: item.size,
        mtimeMs: item.mtimeMs,
        reason: 'coverage-missing',
      });
      continue;
    }
    plan.push({ ...item, rel: relOf(root, item.file) });
    total -= item.size;
  }
  return { root, plan, postponed, totalBytes: bytesSum(files), capBytes: cfg.maxBytes, cutoff };
}

// ---------------------------------------------------------------------------
// tool-output
// ---------------------------------------------------------------------------

function toolTurnTtlDays(dir, now) {
  const meta = path.join(dir, 'meta.json');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(meta, 'utf8'));
  } catch {
    return null;
  }
  if (Number.isFinite(Number(parsed?.ttlDays)) && Number(parsed.ttlDays) >= 0) return Number(parsed.ttlDays);
  if (typeof parsed?.expiresAt === 'string') {
    const at = Date.parse(parsed.expiresAt);
    if (Number.isFinite(at)) return Math.max(0, (at - now.getTime()) / DAY_MS);
  }
  return null;
}

function planToolOutput(memoryRoot, cfg, now) {
  const root = path.join(memoryRoot, '.longlive', 'tool-output');
  const files = walkFiles(root).sort((a, b) => a.mtimeMs - b.mtimeMs);
  const cutoff = addDays(now, cfg.maxAgeDays).getTime();
  let total = bytesSum(files);
  const plan = [];
  for (const item of files) {
    const turnDir = path.dirname(item.file);
    const metaTtl = toolTurnTtlDays(turnDir, now);
    const effectiveDays = metaTtl === null ? cfg.maxAgeDays : Math.min(cfg.maxAgeDays, metaTtl);
    const effectiveCutoff = addDays(now, effectiveDays).getTime();
    const overAge = item.mtimeMs < effectiveCutoff || (metaTtl !== null && metaTtl === 0);
    if (!overAge && total <= cfg.maxBytes) continue;
    plan.push({ ...item, rel: relOf(root, item.file) });
    total -= item.size;
  }
  return { root, plan, totalBytes: bytesSum(files), capBytes: cfg.maxBytes, cutoff };
}

// ---------------------------------------------------------------------------
// .longlive/index artifacts
// ---------------------------------------------------------------------------

function isIndexArtifact(file) {
  const base = path.basename(file);
  if (PROTECTED_BASENAMES.has(base)) return false;
  return /^(verify|build)[-_].+\.json$/i.test(base);
}

function planIndexArtifacts(memoryRoot, cfg) {
  const root = path.join(memoryRoot, '.longlive', 'index');
  const files = walkFiles(root)
    .filter((item) => isIndexArtifact(item.file))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
  const plan = files.slice(cfg.keep).map((item) => ({ ...item, rel: relOf(root, item.file) }));
  const keep = files.slice(0, cfg.keep);
  return { root, plan, keep, totalArtifacts: files.length, keepCount: cfg.keep };
}

// ---------------------------------------------------------------------------
// handoff
// ---------------------------------------------------------------------------

function planHandoff(memoryRoot, cfg, now) {
  const root = path.join(memoryRoot, 'handoff');
  const files = walkFiles(root)
    .filter((item) => !item.file.split(path.sep).includes('_retention'))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  const cutoff = addDays(now, cfg.maxAgeDays).getTime();
  let total = bytesSum(files);
  const plan = [];
  for (const item of files) {
    const overAge = item.mtimeMs < cutoff;
    if (!overAge && total <= cfg.maxBytes) continue;
    const rel = relOf(root, item.file);
    plan.push({
      ...item,
      rel,
      releaseEvidence: /(^|\/)(release|RELEASE|release-notes|RELEASE-NOTES)/i.test(rel),
    });
    total -= item.size;
  }
  return { root, plan, totalBytes: bytesSum(files), capBytes: cfg.maxBytes, cutoff };
}

// ---------------------------------------------------------------------------
// backup history
// ---------------------------------------------------------------------------

function planBackup(cfg) {
  const result = {
    sessionsRoot: cfg.backup.sessionsRoot,
    profileRoot: cfg.backup.profileRoot,
    sessions: { root: cfg.backup.sessionsRoot, plan: [], keepCount: cfg.backup.sessionsDays },
    profiles: { root: cfg.backup.profileRoot, plan: [], keepCount: cfg.backup.profileKeep },
  };
  if (cfg.backup.sessionsRoot) {
    const dirs = walkDirs(cfg.backup.sessionsRoot)
      .filter((dir) => path.dirname(dir.file) === path.resolve(cfg.backup.sessionsRoot))
      .filter((dir) => /^\d{4}-\d{2}-\d{2}$/.test(dir.name))
      .sort((a, b) => b.name.localeCompare(a.name));
    result.sessions.plan = dirs.slice(cfg.backup.sessionsDays).map((dir) => ({ ...dir, rel: dir.name }));
  }
  if (cfg.backup.profileRoot) {
    const dirs = walkDirs(cfg.backup.profileRoot)
      .filter((dir) => path.dirname(dir.file) === path.resolve(cfg.backup.profileRoot))
      .filter((dir) => dir.name.startsWith('snapshot-'))
      .sort((a, b) => b.name.localeCompare(a.name));
    result.profiles.plan = dirs.slice(cfg.backup.profileKeep).map((dir) => ({ ...dir, rel: dir.name }));
  }
  return result;
}

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

export function retentionHealth(memoryRoot, config = {}) {
  const cfg = normalizeRetentionConfig(config);
  const root = path.join(memoryRoot, '.longlive');
  const files = walkFiles(root);
  const totalBytes = bytesSum(files);
  const budgetBytes = cfg.health.budgetBytes;
  const ratio = budgetBytes > 0 ? totalBytes / budgetBytes : (totalBytes > 0 ? Infinity : 0);
  const state = ratio >= 1 ? 'exceeded' : ratio >= cfg.health.warnRatio ? 'warn' : 'ok';
  return {
    checkedAt: new Date().toISOString(),
    root,
    totalBytes,
    budgetBytes,
    ratio: Number.isFinite(ratio) ? Math.round(ratio * 10000) / 10000 : null,
    state,
    fileCount: files.length,
  };
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function retentionPaths(memoryRoot, now) {
  const dir = path.join(memoryRoot, '.longlive', RETENTION_DIR);
  return {
    dir,
    statusPath: path.join(dir, 'status.json'),
    auditPath: path.join(dir, AUDIT_DIR, `retention-${safeStamp(now)}.json`),
    handoffArchivePath: path.join(dir, HANDOFF_ARCHIVE_DIR, `handoff-${safeStamp(now)}.json`),
  };
}

function runLayer(name, planner, deleteRoot, audit, { dryRun, errors }) {
  let plan;
  try {
    plan = planner();
  } catch (error) {
    errors.push({ layer: name, reason: error?.code ?? error?.message ?? String(error) });
    return { total: 0, planned: 0, deleted: 0, bytes: 0, postponed: 0 };
  }
  let deleted = 0;
  let bytes = 0;
  for (const item of plan.plan ?? []) {
    if (deleteFile(item.file, deleteRoot, { dryRun, actions: audit.actions, errors, layer: name })) {
      deleted += 1;
      bytes += item.size;
    }
  }
  audit.layers[name] = {
    total: plan.totalBytes ?? 0,
    capBytes: plan.capBytes ?? null,
    planned: (plan.plan ?? []).length,
    deleted,
    bytes,
    postponed: (plan.postponed ?? []).length,
    details: (plan.plan ?? []).map((item) => ({
      rel: item.rel ?? item.name,
      size: item.size,
      mtimeMs: item.mtimeMs,
      releaseEvidence: Boolean(item.releaseEvidence),
    })),
  };
  if (plan.postponed?.length) {
    audit.postponed.push(...plan.postponed.map((item) => ({ layer: name, ...item })));
    for (const item of plan.postponed) {
      audit.warnings.push(`[retention] hot-truncate postponed ${item.rel}: ${item.reason}`);
    }
  }
  return audit.layers[name];
}

/**
 * Plan + optionally apply one retention pass.
 *
 * `dryRun` defaults to true. A dry run writes nothing (no audit/status file and
 * no deletion); the returned object is the plan. `apply: true` is the only way
 * to delete, and it writes an audit manifest + status JSON under
 * <memoryRoot>/.longlive/retention/.
 */
export function runRetention(options = {}) {
  const cfg = normalizeRetentionConfig(options.config ?? {});
  const memoryRoot = options.memoryRoot ? path.resolve(options.memoryRoot) : null;
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const dryRun = options.dryRun !== undefined ? Boolean(options.dryRun) : cfg.dryRun;
  const audit = {
    schema: RETENTION_SCHEMA,
    at: now.toISOString(),
    dryRun,
    status: 'ok',
    health: null,
    layers: {},
    actions: [],
    postponed: [],
    warnings: [],
    errors: [],
  };
  if (!cfg.enabled && options.force !== true) {
    return { ok: true, enabled: false, dryRun, skipped: 'disabled', audit };
  }
  if (!memoryRoot) {
    return { ok: false, enabled: true, dryRun, error: 'memory-root-missing', audit };
  }
  audit.health = retentionHealth(memoryRoot, cfg);
  if (audit.health.state !== 'ok') {
    audit.warnings.push(`[retention] .longlive health=${audit.health.state} ${audit.health.totalBytes}/${audit.health.budgetBytes} bytes`);
  }

  const layers = [];
  const hot = planHotTruncate(memoryRoot, cfg.hotTruncate, now);
  const hotAudit = runLayer('hotTruncate', () => hot, hot.root, audit, { dryRun, errors: audit.errors });
  layers.push(hotAudit);

  const tool = planToolOutput(memoryRoot, cfg.toolOutput, now);
  const toolAudit = runLayer('toolOutput', () => tool, tool.root, audit, { dryRun, errors: audit.errors });
  layers.push(toolAudit);

  const index = planIndexArtifacts(memoryRoot, cfg.indexArtifacts);
  const indexAudit = runLayer('indexArtifacts', () => index, index.root, audit, { dryRun, errors: audit.errors });
  layers.push(indexAudit);

  const handoff = planHandoff(memoryRoot, cfg.handoff, now);
  const paths = dryRun ? null : retentionPaths(memoryRoot, now);
  if (!dryRun && handoff.plan.length > 0) {
    // Archive the exact list BEFORE any handoff file is removed. A release
    // evidence file must remain recoverable from the manifest even after the
    // source file is pruned.
    writeJson(paths.handoffArchivePath, {
      schema: RETENTION_SCHEMA,
      at: now.toISOString(),
      reason: 'handoff-retention-archive-before-delete',
      files: handoff.plan.map((item) => ({
        rel: item.rel,
        size: item.size,
        mtimeMs: item.mtimeMs,
        releaseEvidence: Boolean(item.releaseEvidence),
      })),
    });
    audit.handoffArchive = paths.handoffArchivePath;
  }
  const handoffAudit = runLayer('handoff', () => handoff, handoff.root, audit, { dryRun, errors: audit.errors });
  layers.push(handoffAudit);

  const backup = planBackup(cfg);
  for (const name of ['sessions', 'profiles']) {
    const part = backup[name];
    let deleted = 0;
    let bytes = 0;
    for (const item of part.plan) {
      if (!isInside(part.root, item.file)) {
        audit.errors.push({ layer: `backup.${name}`, path: item.file, reason: 'outside-root' });
        continue;
      }
      if (dryRun) {
        audit.actions.push({ layer: `backup.${name}`, path: item.file, rel: item.rel, dryRun: true });
        deleted += 1;
        continue;
      }
      try {
        fs.rmSync(item.file, { recursive: true, force: true });
        audit.actions.push({ layer: `backup.${name}`, path: item.file, rel: item.rel, dryRun: false });
        deleted += 1;
        bytes += 0;
      } catch (error) {
        audit.errors.push({ layer: `backup.${name}`, path: item.file, reason: error?.code ?? error?.message ?? String(error) });
      }
    }
    audit.layers[`backup.${name}`] = {
      root: part.root,
      keepCount: part.keepCount,
      planned: part.plan.length,
      deleted,
      bytes,
      details: part.plan.map((item) => ({ rel: item.rel, mtimeMs: item.mtimeMs })),
    };
  }

  if (!dryRun) {
    const paths = retentionPaths(memoryRoot, now);
    writeJson(paths.auditPath, audit);
    writeJson(paths.statusPath, {
      schema: RETENTION_SCHEMA,
      at: now.toISOString(),
      lastRun: { dryRun: false, status: audit.status, deleted: audit.actions.length },
      health: audit.health,
      layers: audit.layers,
    });
    audit.auditPath = paths.auditPath;
    audit.statusPath = paths.statusPath;
  }

  if (audit.errors.length > 0) audit.status = 'partial';
  return { ok: audit.errors.length === 0, enabled: true, dryRun, audit, plans: layers };
}

// ---------------------------------------------------------------------------
// maintenance scheduler / feature registration
// ---------------------------------------------------------------------------

export function createRetentionScheduler(options = {}) {
  const cfg = normalizeRetentionConfig(options.config ?? {});
  const nowFn = typeof options.now === 'function' ? options.now : () => new Date();
  const timers = options.timers ?? globalThis;
  const logger = typeof options.logger === 'function' ? options.logger : () => {};
  let timer = null;
  let last = null;
  let stopped = false;

  const runOnce = (overrides = {}) => {
    try {
      last = runRetention({
        memoryRoot: options.memoryRoot,
        config: cfg,
        now: nowFn(),
        dryRun: cfg.dryRun,
        ...overrides,
      });
      return last;
    } catch (error) {
      last = { ok: false, error: error?.code ?? error?.message ?? String(error) };
      logger(`[retention] run failed: ${last.error}`);
      return last;
    }
  };

  const start = () => {
    if (!cfg.enabled) return { started: false, reason: 'disabled' };
    if (cfg.runOnStart) runOnce();
    if (typeof timers.setInterval === 'function') {
      timer = timers.setInterval(() => runOnce(), cfg.intervalMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
    return { started: true, intervalMs: cfg.intervalMs, timer };
  };

  const stop = () => {
    stopped = true;
    if (timer && typeof timers.clearInterval === 'function') timers.clearInterval(timer);
    timer = null;
  };

  return { enabled: cfg.enabled, config: cfg, start, stop, runOnce, get last() { return last; }, get stopped() { return stopped; } };
}

export function registerRetention(ctx, options = {}) {
  const cfg = normalizeRetentionConfig(options.config ?? {});
  if (!cfg.enabled) return { enabled: false, reason: 'disabled' };
  if (!options.memoryRoot) return { enabled: false, reason: 'no-memory-root' };
  const scheduler = createRetentionScheduler({
    memoryRoot: options.memoryRoot,
    config: cfg,
    now: options.now,
    timers: options.timers,
    logger: options.warn,
  });
  const started = scheduler.start();
  if (typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => () => scheduler.stop(), 'longlive.retention');
    } catch {
      /* fake contexts may not have an effect scope; the timer still runs */
    }
  }
  return { enabled: started.started === true, scheduler };
}
