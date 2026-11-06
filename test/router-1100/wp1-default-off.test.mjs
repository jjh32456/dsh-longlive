import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createRouterService } from '../../src/router/service/service.mjs';
import { MockLlm } from '../../src/router/background/mock-llm.mjs';
import { apply } from '../../src/index.js';
import { tempRoot } from './helpers.mjs';

test('a disabled service installs no timers or listeners and writes nothing', async () => {
  const temp = tempRoot('longlive-router-disabled-');
  const vaultDir = path.join(temp, 'vault');
  const memoryRoot = path.join(temp, 'memory');
  fs.mkdirSync(memoryRoot, { recursive: true });
  const service = createRouterService(
    { logger: () => ({ warn: () => {}, info: () => {} }), on: () => () => {} },
    { enabled: false, provider: 'mock', model: 'mock-1', vaultDir, memoryRoot },
    { llm: new MockLlm(), installTimers: true, installListener: true },
  );
  try {
    assert.equal(service.timers.size, 0);
    const result = await service.start();
    assert.deepEqual(result, { ok: false, code: 'E_DISABLED', state: 'stopped' });
    assert.equal(service.timers.size, 0);
    assert.equal(service.tickTimer, null);
    assert.equal(service.heartbeatTimer, null);
    assert.equal(service.firstTickTimer, null);
    assert.equal(service.listenerDisposers.length, 0);
    assert.equal(fs.existsSync(vaultDir), false);
    const status = service.status();
    assert.equal(status.state, 'stopped');
    assert.equal(status.nextTickAt, null);
    assert.deepEqual(status.warnings, []);
  } finally {
    await service.dispose();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('proposal flags do not bypass the master switch: still 22 tools and no .longlive', async () => {
  const temp = tempRoot('longlive-router-off-proposals-');
  const home = path.join(temp, 'home');
  const memoryRoot = path.join(temp, 'memory');
  fs.mkdirSync(memoryRoot, { recursive: true });
  fs.writeFileSync(path.join(memoryRoot, 'STATE.md'), '## 我在哪\n测试\n', 'utf8');
  const tools = [];
  const effects = [];
  const ctx = {
    tools: { register: (definition) => { tools.push(definition); return () => {}; } },
    on: () => () => {},
    logger: () => ({ warn: () => {}, info: () => {} }),
    effect: (fn) => { const dispose = fn(); effects.push(typeof dispose === 'function' ? dispose : () => {}); return effects.at(-1); },
    get: () => undefined,
  };
  try {
    const returned = await apply(ctx, {
      home,
      memoryRoot,
      env: {},
      heartbeatMs: 0,
      recoverOnStart: false,
      defineTool: (definition) => definition,
      routerRuntime: 'off',
      routerEnabled: false,
      routerProposalEnabled: true,
      routerApplyEnabled: true,
      routerProposalsEnabled: true,
    });
    assert.equal(returned, 22);
    assert.equal(tools.some((tool) => String(tool.name).startsWith('router_')), false);
    assert.equal(fs.existsSync(path.join(memoryRoot, '.longlive')), false);
  } finally {
    for (const dispose of effects.reverse()) dispose();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
