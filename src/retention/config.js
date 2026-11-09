// Retention defaults and normalisation for the unified memory-store janitor.
//
// The defaults are deliberately conservative: even when retention is enabled,
// `dryRun` stays true until an operator explicitly opts into deletion. Every
// number is clamped here (one source of truth for config schema, docs and
// tests) so a typo can never turn a limit into a negative deletion window.

export const GIB = 1024 * 1024 * 1024;

export const RETENTION_DEFAULTS = Object.freeze({
  enabled: false,
  dryRun: true,
  intervalMs: 24 * 60 * 60 * 1000,
  runOnStart: true,
  hotTruncate: Object.freeze({
    maxBytes: 2 * GIB,
    maxAgeDays: 14,
    requireCoverage: true,
  }),
  toolOutput: Object.freeze({
    maxBytes: 2 * GIB,
    maxAgeDays: 90,
  }),
  indexArtifacts: Object.freeze({
    keep: 5,
  }),
  handoff: Object.freeze({
    maxBytes: 2 * GIB,
    maxAgeDays: 180,
  }),
  backup: Object.freeze({
    // Empty means "this layer is not configured": a unit test or an embedding
    // caller that passes only `{ enabled: true }` must never discover and
    // prune the operator's real backup tree. The host config schema carries
    // deployment-specific defaults for the operator profile.
    sessionsRoot: '',
    sessionsDays: 14,
    profileRoot: '',
    profileKeep: 7,
  }),
  health: Object.freeze({
    budgetBytes: 8 * GIB,
    warnRatio: 0.85,
  }),
});

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function int(value, fallback, min, max) {
  return Math.floor(num(value, fallback, min, max));
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function text(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

/** Pure normaliser: no I/O, no logging, never throws on hostile input. */
export function normalizeRetentionConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const hot = src.hotTruncate && typeof src.hotTruncate === 'object' ? src.hotTruncate : {};
  const tool = src.toolOutput && typeof src.toolOutput === 'object' ? src.toolOutput : {};
  const index = src.indexArtifacts && typeof src.indexArtifacts === 'object' ? src.indexArtifacts : {};
  const handoff = src.handoff && typeof src.handoff === 'object' ? src.handoff : {};
  const backup = src.backup && typeof src.backup === 'object' ? src.backup : {};
  const health = src.health && typeof src.health === 'object' ? src.health : {};
  return {
    enabled: bool(src.enabled, RETENTION_DEFAULTS.enabled),
    dryRun: bool(src.dryRun, RETENTION_DEFAULTS.dryRun),
    intervalMs: int(src.intervalMs, RETENTION_DEFAULTS.intervalMs, 60_000, 7 * 24 * 60 * 60 * 1000),
    runOnStart: bool(src.runOnStart, RETENTION_DEFAULTS.runOnStart),
    hotTruncate: {
      maxBytes: int(hot.maxBytes, RETENTION_DEFAULTS.hotTruncate.maxBytes, 0, Number.MAX_SAFE_INTEGER),
      maxAgeDays: int(hot.maxAgeDays, RETENTION_DEFAULTS.hotTruncate.maxAgeDays, 0, 3650),
      requireCoverage: bool(hot.requireCoverage, RETENTION_DEFAULTS.hotTruncate.requireCoverage),
    },
    toolOutput: {
      maxBytes: int(tool.maxBytes, RETENTION_DEFAULTS.toolOutput.maxBytes, 0, Number.MAX_SAFE_INTEGER),
      maxAgeDays: int(tool.maxAgeDays, RETENTION_DEFAULTS.toolOutput.maxAgeDays, 0, 3650),
    },
    indexArtifacts: {
      keep: int(index.keep, RETENTION_DEFAULTS.indexArtifacts.keep, 1, 1000),
    },
    handoff: {
      maxBytes: int(handoff.maxBytes, RETENTION_DEFAULTS.handoff.maxBytes, 0, Number.MAX_SAFE_INTEGER),
      maxAgeDays: int(handoff.maxAgeDays, RETENTION_DEFAULTS.handoff.maxAgeDays, 0, 3650),
    },
    backup: {
      sessionsRoot: text(backup.sessionsRoot, RETENTION_DEFAULTS.backup.sessionsRoot),
      sessionsDays: int(backup.sessionsDays, RETENTION_DEFAULTS.backup.sessionsDays, 1, 3650),
      profileRoot: text(backup.profileRoot, RETENTION_DEFAULTS.backup.profileRoot),
      profileKeep: int(backup.profileKeep, RETENTION_DEFAULTS.backup.profileKeep, 1, 1000),
    },
    health: {
      budgetBytes: int(health.budgetBytes, RETENTION_DEFAULTS.health.budgetBytes, 0, Number.MAX_SAFE_INTEGER),
      warnRatio: num(health.warnRatio, RETENTION_DEFAULTS.health.warnRatio, 0, 1),
    },
  };
}
