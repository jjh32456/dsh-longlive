// WP5 (D-WP5-1..6) — model auto resolution, provider fallback, waiting_provider,
// and host failure mapping. No host, no network, no credentials.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { MockLlm } from '../../src/router/background/mock-llm.mjs';
import { createRouterService } from '../../src/router/service/service.mjs';
import {
  MODEL_AUTO_PICKED_LIST_ORDER,
  MODEL_UNLISTED,
  REASONING_EFFORT_UNSUPPORTED,
  mapProviderFailure,
} from '../../src/router/service/model-resolve.mjs';
import { appendTask, auditKinds, readJson, taskInput, tempRoot, writeMemory } from './helpers.mjs';

class CatalogLlm extends MockLlm {
  constructor({ providers = [{ id: 'mock', name: 'Mock' }], models = [], infos = new Map(), ...rest } = {}) {
    super(rest);
    this.providers = providers;
    this.models = models;
    this.infos = infos;
    this.listModelsCalls = [];
    this.resolveCalls = [];
    this.fullRequests = [];
  }

  listProviders() {
    return this.providers;
  }

  async listModels(provider) {
    this.listModelsCalls.push(provider);
    return this.models.map((entry) => (typeof entry === 'string'
      ? { provider, id: entry, name: entry }
      : { provider, ...entry }));
  }

  async resolveModelInfo(provider, model) {
    this.resolveCalls.push([provider, model]);
    return this.infos.get(model) ?? { provider, id: model, name: model, context: { contextWindow: 1048576 } };
  }

  stream(request) {
    this.fullRequests.push(request);
    return super.stream(request);
  }
}

function logger() {
  return { warn: () => {}, info: () => {} };
}

function build(ctx, configOverrides = {}, deps = {}) {
  const temp = tempRoot('wp5-model-');
  const memoryRoot = path.join(temp, 'memory');
  fs.mkdirSync(memoryRoot, { recursive: true });
  writeMemory(memoryRoot);
  const vaultDir = path.join(temp, 'vault');
  const config = {
    enabled: true,
    provider: 'mock',
    model: 'auto',
    memoryRoot,
    vaultDir,
    tickMs: 60000,
    maxTokensPerRun: 50000,
    maxTokensPerDay: 150000,
    callMaxTokens: 256,
    maxAttempts: 1,
    maxConsecutiveErrors: 3,
    disposeTimeoutMs: 500,
    ...configOverrides,
  };
  const service = createRouterService(ctx, config, {
    memoryRoot,
    installTimers: false,
    installListener: false,
    stability: { enabled: false, waitMs: 0, retries: 0 },
    ...deps,
  });
  return {
    service,
    temp,
    memoryRoot,
    vaultDir,
    config,
    cleanup: () => fs.rmSync(temp, { recursive: true, force: true }),
  };
}

function auditFile(vaultDir) {
  return path.join(vaultDir, 'audit.jsonl');
}

test('auto picks the first non-preview model from listModels and records the list-order warning', async () => {
  const llm = new CatalogLlm({ models: ['mock-2-preview', 'mock-3', 'mock-4-experimental'] });
  const ctx = { get: (name) => (name === 'llm' ? llm : undefined), logger };
  const env = build(ctx);
  try {
    const result = await env.service.start();
    assert.equal(result.ok, true);
    assert.equal(result.state, 'running');
    assert.equal(env.service.status().model.resolved, 'mock-3');
    assert.ok(env.service.status().warnings.includes(MODEL_AUTO_PICKED_LIST_ORDER));
    const kinds = auditKinds(auditFile(env.vaultDir));
    assert.ok(kinds.includes('model.auto_resolved'));
    assert.ok(kinds.includes('model.auto_list_order'));

    appendTask(env.service, taskInput('auto-1'));
    await env.service.tick({ manual: true });
    assert.equal(llm.fullRequests.length, 1);
    assert.equal(llm.fullRequests[0].provider, 'mock');
    assert.equal(llm.fullRequests[0].model, 'mock-3');
    assert.equal(llm.fullRequests[0].reasoningEffort, undefined);
    assert.deepEqual(llm.listModelsCalls, ['mock']);
  } finally {
    await env.service.dispose();
    env.cleanup();
  }
});

test('auto follows agentDefaultModel.currentSelection and inherits reasoningEffort', async () => {
  const llm = new CatalogLlm({ models: ['mock-3'] });
  const ctx = {
    get: (name) => {
      if (name === 'llm') return llm;
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'mock', model: 'mock-host', reasoningEffort: 'max' }) };
      }
      return undefined;
    },
    logger,
  };
  const env = build(ctx);
  try {
    const result = await env.service.start();
    assert.equal(result.state, 'running');
    assert.equal(env.service.status().model.resolved, 'mock-host');
    assert.equal(llm.listModelsCalls.length, 0, 'host selection must win without a catalog scan');

    appendTask(env.service, taskInput('host-1'));
    await env.service.tick({ manual: true });
    assert.equal(llm.fullRequests[0].model, 'mock-host');
    assert.equal(llm.fullRequests[0].reasoningEffort, 'max');
  } finally {
    await env.service.dispose();
    env.cleanup();
  }
});

test('K15: an explicit provider must be registered; an empty provider list blocks E_NO_PROVIDER', async () => {
  const twoProviders = new CatalogLlm({
    providers: [{ id: 'alpha' }, { id: 'beta' }],
    models: ['alpha-1'],
  });
  const ctx = { get: (name) => (name === 'llm' ? twoProviders : undefined), logger };
  const env = build(ctx, { provider: 'mock', model: 'mock-1' });
  try {
    const result = await env.service.start();
    assert.equal(result.state, 'blocked');
    const status = env.service.status();
    assert.equal(status.lastError.code, 'E_NO_PROVIDER');
    assert.match(status.lastError.message, /provider "mock" is not registered/);
    assert.match(status.lastError.message, /alpha, beta/);
    assert.equal(twoProviders.listModelsCalls.length, 0, 'an unregistered explicit provider must not be silently swapped');
    const blockedFile = path.join(env.vaultDir, 'status.json');
    assert.equal(fs.existsSync(blockedFile), true, 'blocked E_NO_PROVIDER must write status.json');
    assert.equal(JSON.parse(fs.readFileSync(blockedFile, 'utf8')).state, 'blocked');
  } finally {
    await env.service.dispose();
    env.cleanup();
  }

  const emptyProviders = new CatalogLlm({ providers: [], models: ['mock-1'] });
  const emptyCtx = { get: (name) => (name === 'llm' ? emptyProviders : undefined), logger };
  const emptyEnv = build(emptyCtx, { provider: 'mock', model: 'mock-1' });
  try {
    const result = await emptyEnv.service.start();
    assert.equal(result.state, 'blocked');
    assert.equal(emptyEnv.service.status().lastError.code, 'E_NO_PROVIDER');
    assert.match(emptyEnv.service.status().lastError.message, /listProviders\(\) returned no providers/);
    assert.equal(fs.existsSync(path.join(emptyEnv.vaultDir, 'status.json')), true);
  } finally {
    await emptyEnv.service.dispose();
    emptyEnv.cleanup();
  }
});

test('auto with an empty catalog blocks E_NO_PROVIDER and keeps resolved=null', async () => {
  const llm = new CatalogLlm({ models: [] });
  const ctx = { get: (name) => (name === 'llm' ? llm : undefined), logger };
  const env = build(ctx);
  try {
    const result = await env.service.start();
    assert.equal(result.state, 'blocked');
    const status = env.service.status();
    assert.equal(status.lastError.code, 'E_NO_PROVIDER');
    assert.deepEqual(status.model, { auto: true, resolved: null, resolvedAt: null });
    assert.match(status.lastError.message, /listModels\("mock"\) returned no models/);
    assert.equal(fs.existsSync(path.join(env.vaultDir, 'proposals')), false);
    assert.equal(fs.existsSync(path.join(env.vaultDir, 'status.json')), true);
  } finally {
    await env.service.dispose();
    env.cleanup();
  }
});

test('an explicit but unlisted model runs with MODEL_UNLISTED and a model.unlisted audit', async () => {
  const llm = new CatalogLlm({ models: ['mock-3'] });
  const ctx = { get: (name) => (name === 'llm' ? llm : undefined), logger };
  const env = build(ctx, { model: 'mock-unlisted' });
  try {
    const result = await env.service.start();
    assert.equal(result.state, 'running');
    assert.equal(env.service.status().model.resolved, 'mock-unlisted');
    assert.ok(env.service.status().warnings.includes(MODEL_UNLISTED));
    assert.ok(auditKinds(auditFile(env.vaultDir)).includes('model.unlisted'));
  } finally {
    await env.service.dispose();
    env.cleanup();
  }
});

test('provider: explicit wins, otherwise the host current selection is used', async () => {
  const explicitLlm = new CatalogLlm({ providers: [{ id: 'mock' }, { id: 'other' }], models: ['mock-1'] });
  const explicitCtx = {
    get: (name) => {
      if (name === 'llm') return explicitLlm;
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'other', model: 'other-1' }) };
      return undefined;
    },
    logger,
  };
  const explicitEnv = build(explicitCtx, { provider: 'mock', model: 'mock-1' });
  try {
    await explicitEnv.service.start();
    const start = explicitEnv.service.status();
    assert.equal(start.provider.configured, true);
    assert.equal(start.model.resolved, 'mock-1');
    const records = fs.readFileSync(auditFile(explicitEnv.vaultDir), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const startRecord = records.find((record) => record.kind === 'router.start');
    assert.equal(startRecord.provider, 'mock');
    assert.equal(startRecord.provider_source, 'explicit');
  } finally {
    await explicitEnv.service.dispose();
    explicitEnv.cleanup();
  }

  const inheritedLlm = new CatalogLlm({ providers: [{ id: 'mock' }, { id: 'other' }], models: ['host-1'] });
  const inheritedCtx = {
    get: (name) => {
      if (name === 'llm') return inheritedLlm;
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'other', model: 'host-1' }) };
      return undefined;
    },
    logger,
  };
  const inheritedEnv = build(inheritedCtx, { provider: 'deepseek-official', providerExplicit: false, model: 'auto' });
  try {
    await inheritedEnv.service.start();
    const records = fs.readFileSync(auditFile(inheritedEnv.vaultDir), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const startRecord = records.find((record) => record.kind === 'router.start');
    assert.equal(startRecord.provider, 'other');
    assert.equal(startRecord.provider_source, 'host-default');
    assert.equal(startRecord.model, 'host-1');
  } finally {
    await inheritedEnv.service.dispose();
    inheritedEnv.cleanup();
  }
});

test('missing llm enters waiting_provider and self-heals on retry without a permanent block', async () => {
  let current = null;
  const ctx = { get: (name) => (name === 'llm' ? current : undefined), logger };
  const env = build(ctx);
  try {
    const result = await env.service.start();
    assert.equal(result.state, 'waiting_provider');
    assert.equal(result.lastError, null);
    const waitingStatus = env.service.status();
    assert.equal(waitingStatus.provider.missing, true);
    assert.equal(typeof waitingStatus.provider.nextRetryAt, 'string');
    // 观测性：waiting_provider 也必须落 vault + status.json（面板契约 v2.3 §6.5）
    assert.equal(fs.existsSync(env.vaultDir), true);
    const waitingFile = path.join(env.vaultDir, 'status.json');
    assert.equal(fs.existsSync(waitingFile), true, 'waiting_provider must write status.json');
    const waitingOnDisk = JSON.parse(fs.readFileSync(waitingFile, 'utf8'));
    assert.equal(waitingOnDisk.state, 'waiting_provider');
    assert.equal(waitingOnDisk.provider.missing, true);
    const tick = await env.service.tick({ manual: true });
    assert.equal(tick.code, 'E_NOT_RUNNING');

    current = new CatalogLlm({ models: ['mock-3'] });
    await env.service.retryProviderNow();
    assert.equal(env.service.status().state, 'running');
    assert.equal(env.service.status().model.resolved, 'mock-3');
    assert.deepEqual(env.service.status().provider, { configured: true, missing: false });
  } finally {
    await env.service.dispose();
    env.cleanup();
  }
});

test('a throwing ctx.llm getter must not crash start; ctx.get is the only probe', async () => {
  const ctx = {
    get: (name) => (name === 'llm' ? undefined : undefined),
    logger,
    get llm() {
      throw new Error('ctx.llm must never be read');
    },
  };
  const env = build(ctx);
  try {
    const result = await env.service.start();
    assert.equal(result.state, 'waiting_provider');
  } finally {
    await env.service.dispose();
    env.cleanup();
  }
});

test('reasoningEffort is passed only when explicitly supplied and unsupported values warn', async () => {
  const unsupported = new CatalogLlm({
    models: ['mock-3'],
    infos: new Map([['mock-3', { provider: 'mock', id: 'mock-3', reasoning: { efforts: ['low', 'high'] } }]]),
  });
  const ctx = { get: (name) => (name === 'llm' ? unsupported : undefined), logger };
  const env = build(ctx, { model: 'mock-3' }, { reasoningEffort: 'max' });
  try {
    const result = await env.service.start();
    assert.equal(result.state, 'running');
    assert.ok(env.service.status().warnings.includes(REASONING_EFFORT_UNSUPPORTED));
    assert.ok(auditKinds(auditFile(env.vaultDir)).includes('model.reasoning_effort_unsupported'));

    appendTask(env.service, taskInput('effort-1'));
    await env.service.tick({ manual: true });
    assert.equal(unsupported.fullRequests[0].reasoningEffort, undefined);
  } finally {
    await env.service.dispose();
    env.cleanup();
  }
});

test('mapProviderFailure implements D-WP5-5', () => {
  assert.equal(mapProviderFailure('NO_ADAPTER').routerCode, 'E_NO_PROVIDER');
  assert.equal(mapProviderFailure('NO_ADAPTER').terminal, true);
  assert.equal(mapProviderFailure('MISSING_CREDENTIAL').routerCode, 'E_NO_PROVIDER');
  assert.equal(mapProviderFailure('INVALID_CREDENTIAL').routerCode, 'E_NO_PROVIDER');
  assert.equal(mapProviderFailure('AUTH').routerCode, 'E_NO_PROVIDER');
  assert.equal(mapProviderFailure('RATE_LIMIT').routerCode, 'E_RATE_LIMITED');
  assert.equal(mapProviderFailure('RATE_LIMIT').rateLimited, true);
  assert.equal(mapProviderFailure('ACCOUNT_QUOTA').routerCode, 'E_RATE_LIMITED');
  assert.equal(mapProviderFailure('QUOTA').routerCode, 'E_QUOTA');
  assert.equal(mapProviderFailure('QUOTA').terminal, true);
  assert.equal(mapProviderFailure('CONTEXT_WINDOW_EXCEEDED').routerCode, 'E_CONTEXT_WINDOW');
  assert.equal(mapProviderFailure('INVALID_CATALOG').routerCode, 'E_PROVIDER_FAILED');
  assert.equal(mapProviderFailure('INVALID_CATALOG').terminal, true);
  assert.equal(mapProviderFailure('TIMEOUT').routerCode, 'E_PROVIDER_FAILED');
  assert.equal(mapProviderFailure('TIMEOUT').terminal, false);
});

for (const [hostCode, expected] of [
  ['MISSING_CREDENTIAL', 'E_NO_PROVIDER'],
  ['AUTH', 'E_NO_PROVIDER'],
  ['QUOTA', 'E_QUOTA'],
  ['CONTEXT_WINDOW_EXCEEDED', 'E_CONTEXT_WINDOW'],
  ['INVALID_CATALOG', 'E_PROVIDER_FAILED'],
]) {
  test(`terminal stream failure ${hostCode} blocks with ${expected}`, async () => {
    const failOn = new Map([['t1', hostCode]]);
    const llm = new MockLlm({ failOn });
    const ctx = { get: (name) => (name === 'llm' ? llm : undefined), logger };
    const env = build(ctx, { model: 'mock-1' });
    try {
      await env.service.start();
      appendTask(env.service, taskInput('t1'));
      await env.service.tick({ manual: true });
      const status = env.service.status();
      assert.equal(status.state, 'blocked');
      assert.equal(status.lastError.code, expected);
      const record = fs.readFileSync(auditFile(env.vaultDir), 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line)).find((entry) => entry.kind === 'task.error');
      assert.equal(record.code, hostCode);
      assert.equal(record.router_code, expected);
    } finally {
      await env.service.dispose();
      env.cleanup();
    }
  });
}

for (const hostCode of ['RATE_LIMIT', 'ACCOUNT_QUOTA']) {
  test(`retryable stream failure ${hostCode} backs off as E_RATE_LIMITED without a permanent block`, async () => {
    const failOn = new Map([['t1', { code: hostCode, providerRetryAfterMs: 1 }]]);
    const llm = new MockLlm({ failOn });
    const ctx = { get: (name) => (name === 'llm' ? llm : undefined), logger };
    const env = build(ctx, { model: 'mock-1' });
    try {
      await env.service.start();
      appendTask(env.service, taskInput('t1'));
      await env.service.tick({ manual: true });
      const status = env.service.status();
      assert.equal(status.state, 'running');
      assert.equal(status.lastError, null);
      assert.equal(typeof status.nextTickAt, 'string');
      const record = fs.readFileSync(auditFile(env.vaultDir), 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line)).find((entry) => entry.kind === 'task.error');
      assert.equal(record.router_code, 'E_RATE_LIMITED');
      assert.equal(record.rate_limited, true);
    } finally {
      await env.service.dispose();
      env.cleanup();
    }
  });
}
