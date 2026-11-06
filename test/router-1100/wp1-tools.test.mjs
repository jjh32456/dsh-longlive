import assert from 'node:assert/strict';
import test from 'node:test';

import { createRouterTools } from '../../src/router/service/tools.mjs';

function fakeService(config = { enabled: true }, extra = {}) {
  const service = {
    config,
    runId: 'run-1',
    panelState: 'running',
    status: () => ({ v: 2, state: 'running' }),
    requestTick: () => ({ ok: true }),
    ask: async () => ({ ok: true }),
    reportHistory: () => ({ reports: [] }),
    ...extra,
  };
  return service;
}

function names(tools) {
  return tools.map((tool) => tool.name);
}

test('closed surface has four tools; proposal surface adds exactly three', () => {
  assert.equal(createRouterTools(fakeService()).length, 4);
  assert.deepEqual(names(createRouterTools(fakeService())), [
    'router_status',
    'router_tick',
    'router_ask',
    'router_report',
  ]);

  for (const config of [
    { enabled: true, proposalEnabled: true },
    { enabled: true, routerProposalEnabled: true },
    { enabled: true, routerProposalsEnabled: true },
  ]) {
    const tools = createRouterTools(fakeService(config));
    assert.equal(tools.length, 7);
    assert.deepEqual(names(tools), [
      'router_status',
      'router_tick',
      'router_ask',
      'router_report',
      'router_propose',
      'router_proposals',
      'router_apply',
    ]);
  }

  // 未开启时不得出现任何未定义工具，字符串 "true" 也不算开启。
  assert.equal(createRouterTools(fakeService({ enabled: true, proposalEnabled: 'true' })).length, 4);
  assert.equal(createRouterTools(fakeService({ enabled: true, proposalEnabled: 1 })).length, 4);
});

test('every router tool has a host-shaped parameter map and a text renderer', () => {
  const tools = createRouterTools(fakeService({ enabled: true, proposalEnabled: true }));
  for (const tool of tools) {
    assert.equal(typeof tool.name, 'string');
    assert.equal(typeof tool.parameters, 'object');
    assert.equal(Array.isArray(tool.parameters), false);
    // Host defineTool expects argument-name -> value schema; a full JSON Schema
    // object here crashes the host at registration time (UNSUPPORTED_SCHEMA).
    assert.equal(Object.hasOwn(tool.parameters, 'type'), false);
    assert.equal(Object.hasOwn(tool.parameters, 'properties'), false);
    assert.equal(tool.output.schema.type, 'object');
    const rendered = tool.output.render({}, { ok: true, message: 'hello' });
    assert.deepEqual(rendered, [{ type: 'text', text: 'hello' }]);
  }
});

test('proposal schemas match DESIGN §9.4 within the host value-schema DSL', () => {
  const tools = createRouterTools(fakeService({ enabled: true, proposalEnabled: true }));
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

  const propose = byName.router_propose.parameters;
  for (const required of ['op', 'target', 'title', 'content']) {
    assert.equal(propose[required].required, true);
  }
  assert.equal(propose.op.type, 'string');
  assert.equal(propose.target.type, 'string');
  assert.equal(propose.title.type, 'string');
  assert.equal(propose.content.type, 'string');
  assert.equal(propose.rationale.type, 'string');
  assert.deepEqual(propose.priority.enum, ['P0', 'P1', 'P2', 'P3', 'P4']);
  // Length caps live in service validation, not in the host schema DSL.
  assert.equal(Object.hasOwn(propose.op, 'maxLength'), false);

  const proposals = byName.router_proposals.parameters;
  assert.deepEqual(proposals.mode.enum, ['list', 'queue', 'detail']);
  assert.equal(proposals.limit.type, 'integer');

  const apply = byName.router_apply.parameters;
  assert.equal(apply.mode.required, true);
  assert.deepEqual(apply.mode.enum, ['approve', 'reject', 'apply', 'rollback', 'cancel']);
  assert.equal(apply.confirm.type, 'string');
});

test('router_propose denies P0 before touching the engine, and reports a missing engine honestly', async () => {
  const tools = createRouterTools(fakeService({ enabled: true, proposalEnabled: true }));
  const propose = tools.find((tool) => tool.name === 'router_propose');
  assert.deepEqual(await propose.invoke({ priority: 'P0' }), { ok: false, code: 'E_PRIORITY_DENIED' });
  assert.equal((await propose.invoke({ op: 'journal.append' })).code, 'E_NOT_IMPLEMENTED');

  const calls = [];
  const withEngine = createRouterTools(fakeService(
    { enabled: true, proposalEnabled: true },
    { proposeProposal: async (args) => { calls.push(args); return { ok: true, ticket: 't-1' }; } },
  ));
  const result = await withEngine.find((tool) => tool.name === 'router_propose').invoke({ op: 'journal.append', target: 'x', title: 't', content: 'c' });
  assert.equal(result.ticket, 't-1');
  assert.equal(calls.length, 1);
});

test('router_proposals and router_apply validate before delegating', async () => {
  const tools = createRouterTools(fakeService({ enabled: true, proposalEnabled: true }));
  const proposals = tools.find((tool) => tool.name === 'router_proposals');
  const apply = tools.find((tool) => tool.name === 'router_apply');

  assert.equal((await proposals.invoke({ mode: 'queue' })).code, 'E_NOT_IMPLEMENTED');
  assert.equal((await apply.invoke({ mode: 'apply' })).code, 'E_APPLY_DISABLED');
  assert.equal((await apply.invoke({ mode: 'apply', confirm: 'abcdef' })).code, 'E_APPLY_DISABLED');
  assert.equal((await apply.invoke({ mode: 'approve' })).code, 'E_CONFIRM_REQUIRED');
  assert.equal((await apply.invoke({ mode: 'rollback' })).code, 'E_APPLY_DISABLED');
  assert.equal((await apply.invoke({ mode: 'reject' })).code, 'E_NOT_IMPLEMENTED');

  const withEngine = createRouterTools(fakeService(
    { enabled: true, proposalEnabled: true, applyEnabled: true },
    {
      proposalsView: async (args) => ({ ok: true, mode: args.mode }),
      requestApply: async (args) => ({ ok: true, mode: args.mode, queued: true }),
    },
  ));
  assert.deepEqual(
    await withEngine.find((tool) => tool.name === 'router_proposals').invoke({ mode: 'queue' }),
    { ok: true, mode: 'queue' },
  );
  assert.deepEqual(
    await withEngine.find((tool) => tool.name === 'router_apply').invoke({ mode: 'apply', confirm: 'abcdef' }),
    { ok: true, mode: 'apply', queued: true },
  );
  assert.deepEqual(
    await withEngine.find((tool) => tool.name === 'router_apply').invoke({ mode: 'reject' }),
    { ok: true, mode: 'reject', queued: true },
  );
});
