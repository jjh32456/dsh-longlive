import assert from 'node:assert/strict';
import test from 'node:test';

import { createRouterTools } from '../../src/router/service/tools.mjs';

function fakeService(overrides = {}) {
  const calls = { tick: [], ask: [], report: [] };
  const service = {
    config: { enabled: true },
    runId: 'run-test',
    panelState: 'running',
    status: () => ({
      v: 1,
      state: 'running',
      runId: 'run-test',
      today: { day: '2026-11-04', usedTokens: 10, reservedTokens: 0, capTokens: 1000 },
      run: { usedTokens: 10, reservedTokens: 0, capTokens: 5000 },
      queue: { pending: 0, invalid: 0, oldestAgeMs: 0 },
      files: { vault: 'v' },
    }),
    requestTick: (input) => {
      calls.tick.push(input);
      return overrides.tick ?? { ok: true, accepted: true };
    },
    ask: async (input) => {
      calls.ask.push(input);
      return overrides.ask ?? { ok: true, accepted: true, taskId: 'task-1' };
    },
    reportHistory: (limit) => {
      calls.report.push(limit);
      return {
        lastReport: { at: '2026-11-04T00:00:00.000Z', summary: 'ok' },
        reports: Array.from({ length: Math.min(limit, 3) }, (_, index) => ({ summary: `r${index}` })),
      };
    },
  };
  return { service, calls };
}

const HOST_PARAM_KEYS = new Set([
  'description', 'title', 'default', 'examples', 'required',
  'type', 'enum', 'const', 'items', 'properties', 'additionalProperties', 'oneOf',
]);
const HOST_VALUE_TYPES = new Set(['json', 'object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const FORBIDDEN_TOP_LEVEL = ['type', 'properties', 'required', 'additionalProperties', 'items', 'oneOf', 'enum', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems'];

function assertValueSchema(schema, path) {
  assert.ok(typeof schema === 'object' && schema !== null && !Array.isArray(schema), `${path} must be a schema object`);
  for (const key of Object.keys(schema)) {
    assert.equal(HOST_PARAM_KEYS.has(key), true, `${path}.${key} is not in the host value-schema DSL`);
  }
  if (Object.hasOwn(schema, 'required')) assert.equal(schema.required, true, `${path}.required must be true`);
  if (Object.hasOwn(schema, 'oneOf')) {
    assert.equal(Object.hasOwn(schema, 'type'), false, `${path} cannot have both type and oneOf`);
    assert.ok(Array.isArray(schema.oneOf) && schema.oneOf.length >= 2, `${path}.oneOf needs >= 2 branches`);
    schema.oneOf.forEach((branch, index) => assertValueSchema(branch, `${path}.oneOf[${index}]`));
    return;
  }
  assert.equal(HOST_VALUE_TYPES.has(schema.type), true, `${path}.type must be a host value type`);
  if (Object.hasOwn(schema, 'items')) assertValueSchema(schema.items, `${path}.items`);
  if (Object.hasOwn(schema, 'properties')) {
    for (const [key, value] of Object.entries(schema.properties)) assertValueSchema(value, `${path}.properties.${key}`);
  }
}

/** Host contract: `parameters` is a map of argument name -> value schema, never a JSON Schema object. */
function assertHostParameters(parameters, name) {
  assert.ok(typeof parameters === 'object' && parameters !== null && !Array.isArray(parameters), `${name}.parameters must be a map`);
  for (const forbidden of FORBIDDEN_TOP_LEVEL) {
    assert.equal(Object.hasOwn(parameters, forbidden), false, `${name}.parameters.${forbidden} must not appear at the top level`);
  }
  for (const [key, schema] of Object.entries(parameters)) assertValueSchema(schema, `${name}.parameters.${key}`);
}

test('the four router tools have the DESIGN names, host-shaped parameter maps and a text renderer', () => {
  const { service } = fakeService();
  const tools = createRouterTools(service);
  assert.deepEqual(tools.map((tool) => tool.name), [
    'router_status',
    'router_tick',
    'router_ask',
    'router_report',
  ]);
  for (const tool of tools) {
    assertHostParameters(tool.parameters, tool.name);
    assert.equal(tool.output.schema.type, 'object');
    const rendered = tool.output.render({}, { ok: true, value: 1 });
    assert.equal(Array.isArray(rendered), true);
    assert.equal(rendered[0].type, 'text');
  }
});

test('router_status returns a read-only snapshot without waking the router', async () => {
  const { service, calls } = fakeService();
  const status = createRouterTools(service).find((tool) => tool.name === 'router_status');
  const result = await status.invoke({}, {});
  assert.equal(result.ok, true);
  assert.equal(result.state, 'running');
  assert.equal(result.run.capTokens, 5000);
  assert.equal(calls.tick.length, 0);
  assert.equal(calls.ask.length, 0);
});

test('router_tick maps the tier, forwards caller, and preserves E_BUSY', async () => {
  const { service, calls } = fakeService({ tick: { ok: false, code: 'E_BUSY', state: 'running' } });
  const tick = createRouterTools(service).find((tool) => tool.name === 'router_tick');
  const busy = await tick.invoke({ tier: 'reflect' }, { exec: { caller: 'session-1' } });
  assert.deepEqual(busy, { ok: false, code: 'E_BUSY', state: 'running' });
  assert.equal(calls.tick[0].tier, 'reflect');
  assert.equal(calls.tick[0].manual, true);
  assert.equal(calls.tick[0].reason, 'tool');
  assert.equal(calls.tick[0].caller, 'session-1');
});

test('router_ask rejects a blank question and forwards a valid one with the default tier', async () => {
  const { service, calls } = fakeService();
  const ask = createRouterTools(service).find((tool) => tool.name === 'router_ask');
  const blank = await ask.invoke({ question: '   ' }, {});
  assert.equal(blank.ok, false);
  assert.equal(blank.code, 'E_INVALID_QUESTION');
  assert.equal(calls.ask.length, 0);

  const ok = await ask.invoke({ question: '现在该做什么？' }, {});
  assert.equal(ok.ok, true);
  assert.equal(ok.taskId, 'task-1');
  assert.equal(calls.ask[0].question, '现在该做什么？');
  assert.equal(calls.ask[0].tier, 'full');
});

test('router_report defaults to 5 and passes an explicit limit through', async () => {
  const { service, calls } = fakeService();
  const report = createRouterTools(service).find((tool) => tool.name === 'router_report');
  const first = await report.invoke({}, {});
  assert.equal(first.ok, true);
  assert.equal(first.state, 'running');
  assert.equal(calls.report[0], 5);
  await report.invoke({ limit: 2 }, {});
  assert.equal(calls.report[1], 2);
});

test('all router tools (incl. proposal layer) expose host-honest value schemas', () => {
  const { service } = fakeService();
  service.config = { enabled: true, proposalEnabled: true };
  const tools = createRouterTools(service);
  assert.deepEqual(tools.map((tool) => tool.name), [
    'router_status', 'router_tick', 'router_ask', 'router_report',
    'router_propose', 'router_proposals', 'router_apply',
  ]);
  for (const tool of tools) assertHostParameters(tool.parameters, tool.name);

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const propose = byName.get('router_propose').parameters;
  for (const required of ['op', 'target', 'title', 'content']) {
    assert.equal(propose[required].required, true, `router_propose.${required} must be required`);
  }
  assert.deepEqual(propose.priority.enum, ['P0', 'P1', 'P2', 'P3', 'P4']);
  assert.equal(byName.get('router_apply').parameters.mode.required, true);
  assert.equal(byName.get('router_ask').parameters.question.required, true);
  // Length/count limits are enforced in code; the host DSL has no such keywords.
  const text = JSON.stringify(tools.map((tool) => tool.parameters));
  for (const keyword of ['minLength', 'maxLength', 'minimum', 'maximum', 'maxItems', 'minItems']) {
    assert.equal(text.includes(`"${keyword}"`), false, `${keyword} must not leak into tool schemas`);
  }
});
