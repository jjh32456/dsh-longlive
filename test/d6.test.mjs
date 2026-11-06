// D6 unit gate: the tool surface is trimmed on turn 1, frozen for the session,
// recoverable through tool_search, and never let a broken filter cost the
// session its tools.  Everything runs against a fake host shaped like the two
// system-prompt/assemble contracts (0.2.1 returns tools in the waterfall;
// 0.2.2 returns them only from the provider, after the waterfall).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assembleShape, selectAllowlist } from '../src/d6/surface.js';
import { TOOL_SEARCH_SPEC, registerD6 } from '../src/d6/runtime.js';
import { estimateToolsTokens } from '../src/metrics/estimate.mjs';
import { apply } from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_TOOLS = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'd6-header-tools.json'), 'utf8'));

function tool(name, description) {
  return {
    name,
    description,
    parameters: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false },
  };
}

const BASE = [
  tool('read', 'Read a file from the workspace.'),
  tool('write', 'Write a file in the workspace.'),
  tool('edit', 'Edit a text file by replacing literal text.'),
  tool('pwsh', 'Run a PowerShell command.'),
  tool('glob', 'Find files by glob pattern.'),
  tool('grep', 'Search file contents with a regex.'),
  tool('todo_write', 'Record a task list.'),
  tool('session_health', 'Inspect a DSH session log.'),
  tool('session_search', 'Search prior sessions.'),
  tool('memory_recall', 'Search memory cards.'),
  tool('read_image', 'Read a PNG/JPEG/WebP/GIF image.'),
  tool('send_meme', 'Send a meme image.'),
  tool('learn_meme', 'Add an image to the meme library.'),
  tool('meme_list', 'List meme images.'),
  tool('present', 'Declare existing files as final deliverables.'),
  tool('job_list', 'List background jobs.'),
  tool('job_output', 'Read a background job.'),
  tool('workflow', 'Run a JavaScript workflow of subagents.'),
  tool('subagent', 'Delegate a task to a subagent.'),
];

function makeHost({
  defs = [...BASE, TOOL_SEARCH_SPEC],
  config = { d6: { enabled: true } },
  restrictThrows = false,
} = {}) {
  const layers = [];
  const infos = [];
  const warns = [];
  const listeners = new Map();
  const tools = {
    definitions() {
      const denied = new Set(layers.flatMap((layer) => [...layer]));
      return defs.filter((entry) => !denied.has(entry.name));
    },
    view() {
      const denied = new Set(layers.flatMap((layer) => [...layer]));
      const visible = new Map();
      for (const entry of defs) {
        if (!denied.has(entry.name)) visible.set(entry.name, { definition: entry });
      }
      return { visible, restrictableNames: new Set(defs.map((entry) => entry.name)) };
    },
    restrict({ deny }) {
      if (restrictThrows) throw new Error('restrict boom');
      const layer = new Set(deny);
      layers.push(layer);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const index = layers.indexOf(layer);
        if (index >= 0) layers.splice(index, 1);
      };
    },
  };
  const ctx = {
    tools,
    on(name, listener) {
      const list = listeners.get(name) ?? [];
      list.push(listener);
      listeners.set(name, list);
      return () => {
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
      };
    },
    logger() {
      return {
        info: (text) => infos.push(text),
        warn: (text) => warns.push(text),
        debug: () => {},
      };
    },
    effect(fn) {
      try {
        fn();
      } catch {
        /* fake scope */
      }
    },
  };
  const agent = { ctx, session: { snapshotEvents: () => [] } };
  const registration = registerD6(ctx, config);
  const emitClaimed = (message, turn = 1) => {
    for (const listener of listeners.get('agent/inbox/claimed') ?? []) {
      listener({ agent, message, turn });
    }
  };
  const emitAssemble = async (assembly) => {
    let current = assembly;
    for (const listener of listeners.get('system-prompt/assemble') ?? []) {
      current = await listener(assembly, { agent, scope: agent }, async () => current);
    }
    return current;
  };
  return { ctx, agent, registration, tools, layers, infos, warns, emitClaimed, emitAssemble, defs };
}

const USER = (text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });

test('D6 is off by default: no listener, no tool, no restriction', () => {
  const host = makeHost({ config: {} });
  assert.equal(host.registration.enabled, false);
  assert.deepEqual(host.registration.tools, []);
  host.emitClaimed(USER('修复 TypeScript 编译错误'));
  assert.equal(host.layers.length, 0);
});

test('code task keeps the core surface and trims media/job tools', async () => {
  const host = makeHost();
  host.emitClaimed(USER('修复这个 TypeScript 编译错误，补单元测试并跑通'));
  const state = host.registration.runtime.stateFor(host.agent);
  assert.equal(state.task, 'code');
  assert.equal(state.frozen, true);
  assert.equal(state.fallback, null);
  assert.ok(state.allow.has('read'));
  assert.ok(state.allow.has('pwsh'));
  assert.ok(state.allow.has('session_health'));
  assert.ok(state.allow.has('memory_recall'));
  assert.ok(state.allow.has('tool_search'));
  assert.ok(!state.allow.has('read_image'));
  assert.ok(!state.allow.has('job_list'));
  assert.equal(host.layers.length, 1);
  const denied = new Set(host.layers.flatMap((layer) => [...layer]));
  assert.ok(denied.has('read_image'));
  assert.ok(denied.has('send_meme'));
  assert.ok(!denied.has('read'));

  // 0.2.2: tools are provider-owned after the waterfall; leave it untouched.
  const assembly022 = { sections: {}, contexts: {}, variables: {} };
  assert.equal(await host.emitAssemble(assembly022), assembly022);

  // 0.2.1: the waterfall value owns tools; filter it.
  const full = { sections: {}, contexts: {}, variables: {}, tools: host.defs };
  const filtered = await host.emitAssemble(full);
  const names = filtered.tools.map((entry) => entry.name);
  assert.ok(names.includes('read'));
  assert.ok(names.includes('tool_search'));
  assert.ok(!names.includes('read_image'));
  assert.ok(!names.includes('workflow'));
  assert.equal(filtered.tools.length, names.length);
});

test('media task keeps the media tools', () => {
  const host = makeHost();
  host.emitClaimed(USER('帮我生成一张图片做封面，再配一段音乐'));
  const state = host.registration.runtime.stateFor(host.agent);
  assert.equal(state.task, 'media');
  assert.ok(state.allow.has('read_image'));
  assert.ok(state.allow.has('send_meme'));
  assert.ok(state.allow.has('present'));
  assert.ok(!state.allow.has('job_list'));
  assert.ok(!state.allow.has('workflow'));
  const denied = new Set(host.layers.flatMap((layer) => [...layer]));
  assert.ok(!denied.has('read_image'));
  assert.ok(denied.has('job_list'));
});

test('the allowlist freezes after the first claimed user message', () => {
  const host = makeHost();
  host.emitClaimed(USER('修复这个 TypeScript bug'));
  const state = host.registration.runtime.stateFor(host.agent);
  const allow = [...state.allow].sort();
  const deny = [...state.deny].sort();
  const layers = host.layers.length;

  host.emitClaimed(USER('换成视频任务，生成一张图片'), 1);
  assert.equal(state.task, 'code');
  assert.deepEqual([...state.allow].sort(), allow);
  assert.deepEqual([...state.deny].sort(), deny);
  assert.equal(host.layers.length, layers);
});

test('a session resumed after a host restart freezes on its first turn>1 claim', () => {
  // The host restarted; the restored conversation's first *new* user turn is #29.
  // Before the G3 fix `if (turn > 1) return` skipped this claim forever.
  const host = makeHost();
  host.emitClaimed(USER('继续，把剩下的测试补完并跑通'), 29);
  const state = host.registration.runtime.stateFor(host.agent);
  assert.equal(state.frozen, true);
  assert.equal(state.task, 'code');
  assert.ok(state.trimmed.length > 0);
  assert.equal(host.layers.length, 1);
  const denied = new Set(host.layers.flatMap((layer) => [...layer]));
  assert.ok(denied.has('read_image'));
  assert.ok(denied.has('send_meme'));
  assert.ok(!denied.has('read'));

  const allow = [...state.allow].sort();
  const deny = [...state.deny].sort();
  // `tool_search` is usable right away, so the resumed session can recover tools.
  const listed = host.registration.tools[0].invoke({}, { exec: { agent: host.agent } });
  assert.equal(listed.ok, true);
  assert.ok(listed.totalTrimmed > 0);

  // ...and the surface stays frozen for later turns, exactly like a turn-1 session.
  host.emitClaimed(USER('再顺手生成一张封面图'), 30);
  assert.equal(state.task, 'code');
  assert.deepEqual([...state.allow].sort(), allow);
  assert.deepEqual([...state.deny].sort(), deny);
  assert.equal(host.layers.length, 1);
});

test('a turn>1 claim that is not a real user message still does not freeze', () => {
  const host = makeHost();
  host.emitClaimed({ role: 'assistant', content: [{ type: 'text', text: '工具输出' }] }, 29);
  const state = host.registration.runtime.stateFor(host.agent);
  assert.equal(state.frozen, false);
  assert.equal(host.layers.length, 0);
});

test('tool_search lifts one restriction and 0.2.1 appends it at the END', async () => {
  const host = makeHost();
  host.emitClaimed(USER('修复这个 TypeScript bug'));
  const before = (await host.emitAssemble({ sections: {}, contexts: {}, variables: {}, tools: host.defs })).tools
    .map((entry) => entry.name);

  assert.equal(typeof host.registration.tools[0].invoke, 'function');
  assert.equal(host.registration.tools[0].execute, undefined);

  const result = host.registration.tools[0].invoke(
    { names: ['read_image'] },
    { exec: { agent: host.agent }, host: () => host.ctx },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.added, ['read_image']);
  const denied = new Set(host.layers.flatMap((layer) => [...layer]));
  assert.ok(!denied.has('read_image'));
  assert.ok(denied.has('send_meme'));

  const after = (await host.emitAssemble({ sections: {}, contexts: {}, variables: {}, tools: host.defs })).tools
    .map((entry) => entry.name);
  assert.equal(after.at(-1), 'read_image');
  assert.deepEqual(after.slice(0, before.length), before);
  assert.ok(!after.slice(0, before.length).includes('read_image'));
});

test('tool_search lists trimmed tools and filters by query', () => {
  const host = makeHost();
  host.emitClaimed(USER('修复这个 TypeScript bug'));
  const listed = host.registration.tools[0].invoke({}, { exec: { agent: host.agent } });
  assert.equal(listed.ok, true);
  assert.equal(listed.totalTrimmed, host.registration.runtime.stateFor(host.agent).trimmed.length);
  assert.ok(listed.matched.length <= 8);
  const queried = host.registration.tools[0].invoke(
    { query: 'meme', names: [] },
    { exec: { agent: host.agent } },
  );
  assert.equal(queried.ok, true);
  assert.ok(queried.matched.some((entry) => entry.name === 'send_meme'));
});

test('a thrown restrict() falls back to the full surface', async () => {
  const host = makeHost({ restrictThrows: true });
  host.emitClaimed(USER('修复这个 TypeScript bug'));
  const state = host.registration.runtime.stateFor(host.agent);
  assert.equal(state.fallback, 'full');
  assert.equal(state.applied, false);
  assert.equal(host.layers.length, 0);
  const full = { sections: {}, contexts: {}, variables: {}, tools: host.defs };
  const result = await host.emitAssemble(full);
  assert.equal(result.tools.length, full.tools.length);
});

test('an empty surviving set falls back to the full surface', async () => {
  const host = makeHost({
    defs: [tool('run_code', 'Reserved tool.'), tool('send_meme', 'Send a meme image.')],
  });
  host.emitClaimed(USER('修复这个 TypeScript bug'));
  const state = host.registration.runtime.stateFor(host.agent);
  assert.equal(state.fallback, 'full');
  assert.equal(host.layers.length, 0);
  const full = { sections: {}, contexts: {}, variables: {}, tools: host.defs };
  const result = await host.emitAssemble(full);
  assert.equal(result.tools.length, 2);
});

test('the live goal participates in the task class', () => {
  const host = makeHost();
  host.agent.ctx.goals = { get: () => ({ objective: '生成一段音乐视频并配封面', phase: 'active' }) };
  host.emitClaimed(USER('按这个目标开始'));
  assert.equal(host.registration.runtime.stateFor(host.agent).task, 'media');
});

test('dry-run logs the trimmed names but never restricts or adds tool_search', async () => {
  const host = makeHost({ config: { d6: { enabled: true, dryRun: true } } });
  host.emitClaimed(USER('修复这个 TypeScript bug'));
  const state = host.registration.runtime.stateFor(host.agent);
  assert.equal(state.frozen, true);
  assert.equal(state.applied, false);
  assert.deepEqual(host.registration.tools, []);
  assert.equal(host.layers.length, 0);
  assert.ok(host.infos.some((line) => line.includes('[d6] dry-run task=code')));
  assert.ok(host.infos.some((line) => line.includes('read_image')));
  const full = { sections: {}, contexts: {}, variables: {}, tools: host.defs };
  assert.equal((await host.emitAssemble(full)).tools.length, host.defs.length);
});

test('both assemble shapes are detected and handled', async () => {
  assert.equal(assembleShape({ tools: [] }), '0.2.1');
  assert.equal(assembleShape({ sections: {} }), '0.2.2');

  const host022 = makeHost();
  host022.emitClaimed(USER('修复这个 TypeScript bug'));
  const assembly022 = { sections: {} };
  assert.equal(await host022.emitAssemble(assembly022), assembly022);
  assert.equal(host022.registration.runtime.stateFor(host022.agent).shape, '0.2.2');

  const host021 = makeHost();
  host021.emitClaimed(USER('修复这个 TypeScript bug'));
  const assembly021 = { sections: {}, tools: host021.defs };
  const result = await host021.emitAssemble(assembly021);
  assert.ok(result.tools.length < host021.defs.length);
  assert.equal(host021.registration.runtime.stateFor(host021.agent).shape, '0.2.1');
});

test('budget: the code-task surface is <= 10K tokens (real 108-tool header)', () => {
  const all = [...REAL_TOOLS, TOOL_SEARCH_SPEC];
  const fullTokens = estimateToolsTokens(all);
  const selection = selectAllowlist({
    message: '修复这个 TypeScript 编译错误，补单元测试并跑通',
    tools: all,
  });
  assert.equal(selection.task, 'code');
  const kept = all.filter((entry) => selection.allow.includes(entry.name));
  const keptTokens = estimateToolsTokens(kept);
  assert.equal(kept.length, 29);
  assert.ok(fullTokens > 25000, `full surface should exceed 25K, got ${fullTokens}`);
  assert.ok(keptTokens <= 10000, `code surface must be <= 10K, got ${keptTokens}`);
  assert.ok(kept.some((entry) => entry.name === 'tool_search'));
  assert.ok(!kept.some((entry) => entry.name === 'read_image'));
});

test('apply() wires tool_search and both listeners only when d6.enabled=true', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'longlive-d6-'));
  const home = path.join(temp, 'home');
  const memoryRoot = path.join(temp, 'memory');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(memoryRoot, { recursive: true });
  const tools = [];
  const hooks = [];
  const ctx = {
    tools: { register: (definition) => { tools.push(definition); return () => {}; } },
    on(name, listener) { hooks.push({ name, listener }); return () => {}; },
    logger() { return { warn: () => {}, info: () => {}, debug: () => {} }; },
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
  };
  const count = await apply(ctx, {
    d6: { enabled: true },
    home,
    memoryRoot,
    defineTool: (definition) => definition,
    routerEnabled: false,
  });
  assert.ok(count >= 23);
  assert.ok(tools.some((definition) => definition.name === 'tool_search'));
  const search = tools.find((definition) => definition.name === 'tool_search');
  assert.equal(typeof search.execute, 'function');
  const unfrozen = await search.execute({}, { agent: {} });
  assert.equal(unfrozen.error, 'D6_NOT_FROZEN');
  assert.ok(hooks.some((hook) => hook.name === 'agent/inbox/claimed'));
  assert.ok(hooks.some((hook) => hook.name === 'system-prompt/assemble'));
  fs.rmSync(temp, { recursive: true, force: true });
});
