import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeRouterConfig,
  normalizeRouterConfigFromPlugin,
  ROUTER_CONFIG_KEYS,
  ROUTER_DEFAULTS,
} from '../../src/router/service/config.mjs';

const DESIGN_KEYS = [
  'routerEnabled',
  'routerProvider',
  'routerModel',
  'routerTickMs',
  'routerReflectOnTurn',
  'routerReflectCoalesceMs',
  'routerAutonomy',
  'routerAllowAgent',
  'routerMaxTokensPerRun',
  'routerMaxTokensPerDay',
  'routerCallMaxTokens',
  'routerMaxAttempts',
  'routerMaxConsecutiveErrors',
  'routerAnchorPath',
  'routerStopFile',
  'routerAllowMissingAnchor',
  'routerVaultDir',
  'routerAgentTimeoutMs',
  'routerDisposeTimeoutMs',
  'routerFlowSlice',
  'routerSharedBoard',
  'routerHintScope',
  'routerHintTokens',
  'routerReflectHintTokens',
  'routerInjectEveryTurns',
  'routerInjectStateMaxSessions',
  'routerInjectMaxPerSessionPerDay',
  'routerInjectMaxTotalTokens',
  'routerLiveRowsMax',
  'routerBoardMaxSessions',
  'routerProposalEnabled',
  'routerApplyEnabled',
  'routerL4MergeEnabled',
  'routerProposalMaxChars',
  'routerProposalsPerSessionHour',
  'routerMaxProposals',
  'routerAgingSeconds',
  'routerLeaseRenewMax',
  'routerLeaseWaitTimeoutMs',
  'routerBlockedOnUserTtlMs',
  'routerProposalTtlH',
  'routerWakeEnabled',
  'routerWakeCooldownMs',
  'routerWakeDailyQuota',
  'routerWakeLogMaxBytes',
  'routerStarvationAlertMs',
  'routerQueueMaxBytes',
  'routerWalMaxBytes',
  'routerWriterLeaseMs',
  'routerSnapshotKeepDays',
];

test('the 50 DESIGN §8.1 keys are all present exactly once', () => {
  assert.equal(DESIGN_KEYS.length, 50);
  assert.equal(Object.keys(ROUTER_DEFAULTS).length, 50);
  assert.deepEqual(Object.values(ROUTER_CONFIG_KEYS).sort(), [...DESIGN_KEYS].sort());
  const cfg = normalizeRouterConfig({});
  for (const [short, long] of Object.entries(ROUTER_CONFIG_KEYS)) {
    assert.ok(short in cfg, `${short} (${long}) missing from normalized config`);
  }
  for (const long of DESIGN_KEYS) assert.equal(long in cfg, false, `normalized config must not keep ${long}`);
  assert.equal('maxQueue' in cfg, false);
  assert.equal('routerMaxQueue' in cfg, false);
});

test('DESIGN defaults for budget, injection and merge are authoritative', () => {
  const cfg = normalizeRouterConfig({ routerEnabled: true });
  assert.equal(cfg.maxTokensPerRun, 80000);
  assert.equal(cfg.maxTokensPerDay, 1000000);
  assert.equal(cfg.callMaxTokens, 2048);
  assert.equal(cfg.maxAttempts, 2);
  assert.equal(cfg.injectMaxPerSessionPerDay, 24);
  assert.equal(cfg.injectMaxTotalTokens, 12000);
  assert.equal(cfg.l4MergeEnabled, false);
  assert.equal(cfg.hintTokens, 700);
  assert.equal(cfg.reflectHintTokens, 150);
  assert.equal(cfg.flowSlice, 1200);
  assert.equal(cfg.snapshotKeepDays, 30);
  assert.deepEqual(cfg.warnings, []);
});

test('range-clamped keys clamp instead of falling back to default', () => {
  const high = normalizeRouterConfig({ routerHintTokens: 900, routerReflectHintTokens: 900, routerWriterLeaseMs: 999999 });
  assert.equal(high.hintTokens, 700);
  assert.equal(high.reflectHintTokens, 150);
  assert.equal(high.writerLeaseMs, 120000);
  assert.ok(high.warnings.includes('CONFIG_CLAMPED:hintTokens'));
  assert.ok(high.warnings.includes('CONFIG_CLAMPED:reflectHintTokens'));
  assert.ok(high.warnings.includes('CONFIG_CLAMPED:writerLeaseMs'));

  const low = normalizeRouterConfig({ routerHintTokens: 1, routerReflectHintTokens: 1, routerWriterLeaseMs: 1 });
  assert.equal(low.hintTokens, 200);
  assert.equal(low.reflectHintTokens, 50);
  assert.equal(low.writerLeaseMs, 60000);

  const notNumber = normalizeRouterConfig({ routerWriterLeaseMs: 'later' });
  assert.equal(notNumber.writerLeaseMs, 120000);
  assert.ok(notNumber.warnings.includes('CONFIG_INVALID:writerLeaseMs'));
});

test('legacy keys migrate on read, and the normalized object only carries new keys', () => {
  const merged = normalizeRouterConfig({ routerMergeEnabled: true });
  assert.equal(merged.l4MergeEnabled, true);
  assert.ok(merged.warnings.includes('CONFIG_MIGRATED:routerMergeEnabled'));

  const plural = normalizeRouterConfig({ routerProposalsEnabled: true });
  assert.equal(plural.proposalEnabled, true);
  assert.ok(plural.warnings.includes('CONFIG_MIGRATED:routerProposalsEnabled'));

  const lease = normalizeRouterConfig({ routerLeaseTtlMs: 90000 });
  assert.equal(lease.writerLeaseMs, 90000);
  assert.ok(lease.warnings.includes('CONFIG_MIGRATED:routerLeaseTtlMs'));

  // 新键优先，旧键不再写回。
  const both = normalizeRouterConfig({ routerMergeEnabled: true, routerL4MergeEnabled: false });
  assert.equal(both.l4MergeEnabled, false);
  assert.equal(both.warnings.some((warning) => warning.includes('MIGRATED')), false);
});

test('unknown router keys warn; non-router keys and removed routerMaxQueue are handled', () => {
  const cfg = normalizeRouterConfig({
    routerNope: 1,
    routerRuntime: 'off',
    routerPolicyProfile: 'x',
    unknownKey: 'ignored',
    routerMaxQueue: 999,
  });
  assert.ok(cfg.warnings.includes('CONFIG_UNKNOWN:routerNope'));
  assert.equal(cfg.warnings.some((warning) => warning.includes('unknownKey')), false);
  assert.equal(cfg.warnings.some((warning) => warning.includes('routerRuntime')), false);
  assert.ok(cfg.warnings.includes('CONFIG_DEPRECATED:routerMaxQueue'));
});

test('illegal values fall back to defaults with a warning', () => {
  const cfg = normalizeRouterConfig({
    routerFlowSlice: 'x',
    routerInjectEveryTurns: 0,
    routerHintScope: 'some',
    routerProposalMaxChars: 10,
    routerSharedBoard: 'yes',
    routerProvider: 42,
  });
  assert.equal(cfg.flowSlice, 1200);
  assert.equal(cfg.injectEveryTurns, 10);
  assert.equal(cfg.hintScope, 'root');
  assert.equal(cfg.proposalMaxChars, 4000);
  assert.equal(cfg.sharedBoard, false);
  assert.equal(cfg.provider, 'deepseek-official');
  for (const key of ['flowSlice', 'injectEveryTurns', 'hintScope', 'proposalMaxChars', 'sharedBoard', 'provider']) {
    assert.ok(cfg.warnings.includes(`CONFIG_INVALID:${key}`), `missing CONFIG_INVALID:${key}`);
  }
});

test('normalizeRouterConfigFromPlugin is the same pure normalizer', () => {
  const cfg = normalizeRouterConfigFromPlugin({ routerEnabled: true, routerProposalEnabled: true });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.proposalEnabled, true);
  assert.equal(cfg.warnings.length, 0);
});
