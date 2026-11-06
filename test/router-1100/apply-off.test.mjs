import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { apply } from '../../src/index.js';
import { MockLlm } from '../../src/router/background/mock-llm.mjs';
import { tempRoot } from './helpers.mjs';

function fakeContext({ llm = null } = {}) {
  const tools = [];
  const effects = [];
  const hooks = [];
  const warnings = [];
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {};
      },
    },
    on(name, listener) {
      hooks.push({ name, listener });
      return () => {};
    },
    logger() {
      return { warn: (message) => warnings.push(String(message)), info: () => {} };
    },
    effect(fn) {
      const dispose = fn();
      effects.push(typeof dispose === 'function' ? dispose : () => {});
      return effects[effects.length - 1];
    },
    get(name) {
      return name === 'llm' ? llm : undefined;
    },
  };
  return { ctx, tools, effects, hooks, warnings };
}

function memoryTree(root) {
  const out = [];
  const walk = (dir, rel = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      out.push(entry.isDirectory() ? `${childRel}/` : childRel);
      if (entry.isDirectory()) walk(child, childRel);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

test('routerEnabled=false is the 0.9.0 surface: 22 tools, no router_* hooks, no .longlive', async () => {
  const temp = tempRoot('longlive-router-off-');
  const home = path.join(temp, 'home');
  const memoryRoot = path.join(temp, 'memory');
  fs.mkdirSync(memoryRoot, { recursive: true });
  fs.writeFileSync(path.join(memoryRoot, 'STATE.md'), '## 我在哪\n测试\n', 'utf8');
  const before = memoryTree(memoryRoot);
  const harness = fakeContext();
  try {
    const returned = await apply(harness.ctx, {
      home,
      memoryRoot,
      env: {},
      heartbeatMs: 0,
      recoverOnStart: false,
      defineTool: (definition) => definition,
      routerRuntime: 'off',
    });
    assert.equal(typeof returned, 'number');
    assert.equal(harness.tools.length, 22);
    assert.equal(harness.tools.some((tool) => String(tool.name).startsWith('router_')), false);
    assert.deepEqual(memoryTree(memoryRoot), before);
    assert.equal(fs.existsSync(path.join(memoryRoot, '.longlive')), false);
  } finally {
    for (const dispose of harness.effects.reverse()) dispose();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('routerEnabled=true wires the service and registers exactly the four router tools', async () => {
  const temp = tempRoot('longlive-router-on-');
  const home = path.join(temp, 'home');
  const memoryRoot = path.join(temp, 'memory');
  fs.mkdirSync(memoryRoot, { recursive: true });
  fs.writeFileSync(path.join(memoryRoot, 'STATE.md'), '## 我在哪\n测试\n', 'utf8');
  const llm = new MockLlm({ usage: { inputTokens: 10, outputTokens: 5 } });
  const harness = fakeContext({ llm });
  try {
    const returned = await apply(harness.ctx, {
      home,
      memoryRoot,
      env: {},
      heartbeatMs: 0,
      recoverOnStart: false,
      defineTool: (definition) => definition,
      routerRuntime: 'off',
      routerEnabled: true,
      routerProvider: 'mock',
      routerModel: 'mock-1',
      routerTickMs: 60000,
    });
    assert.equal(returned, 26);
    const names = harness.tools.map((tool) => tool.name);
    for (const name of ['router_status', 'router_tick', 'router_ask', 'router_report']) {
      assert.ok(names.includes(name), `${name} must be registered`);
    }
    assert.equal(harness.tools.length, 26);

    const statusTool = harness.tools.find((tool) => tool.name === 'router_status');
    let status = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      status = await statusTool.execute({}, {});
      if (status?.state === 'running' || status?.state === 'blocked') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(status.ok, true);
    assert.equal(status.state, 'running');
    assert.ok(fs.existsSync(path.join(memoryRoot, '.longlive', 'router', 'status.json')));
  } finally {
    for (const dispose of harness.effects.reverse()) {
      try { await dispose(); } catch { /* best effort */ }
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('routerProposalEnabled=true adds the three proposal tools: 29', async () => {
  const temp = tempRoot('longlive-router-proposals-');
  const home = path.join(temp, 'home');
  const memoryRoot = path.join(temp, 'memory');
  fs.mkdirSync(memoryRoot, { recursive: true });
  fs.writeFileSync(path.join(memoryRoot, 'STATE.md'), '## 我在哪\n测试\n', 'utf8');
  const llm = new MockLlm({ usage: { inputTokens: 10, outputTokens: 5 } });
  const harness = fakeContext({ llm });
  try {
    const returned = await apply(harness.ctx, {
      home,
      memoryRoot,
      env: {},
      heartbeatMs: 0,
      recoverOnStart: false,
      defineTool: (definition) => definition,
      routerRuntime: 'off',
      routerEnabled: true,
      routerProvider: 'mock',
      routerModel: 'mock-1',
      routerTickMs: 60000,
      routerProposalEnabled: true,
    });
    assert.equal(returned, 29);
    const names = harness.tools.map((tool) => tool.name);
    assert.deepEqual(
      names.filter((name) => name.startsWith('router_')).sort(),
      [
        'router_apply',
        'router_ask',
        'router_proposals',
        'router_propose',
        'router_report',
        'router_status',
        'router_tick',
      ],
    );
  } finally {
    for (const dispose of harness.effects.reverse()) {
      try { await dispose(); } catch { /* best effort */ }
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

