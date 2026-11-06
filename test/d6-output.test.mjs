// D6 tool_search result-content gate.
//
// Host contract (@deepseek-ai/dsh-tools 0.2.2-rc.1, pipeline.createSuccessResult):
// the return value of `output.render(args, value)` is used VERBATIM as the
// tool-result message `content`. The model layer then walks that content as
// typed blocks: @deepseek-ai/dsh-llm contentHasImage() does
//
//     content.some((block) => block.type === 'image')
//
// so a string makes the host throw `content.some is not a function` — exactly
// the 1.5.0-rc.2 VM recheck failure (REPORT.md item 3).
//
// rc.2's TOOL_SEARCH_SPEC.output.render returned JSON.stringify(value); the
// other 22 tools in src/tools.js render through OUTPUT_TEXT ->
// [{ type: 'text', text }]. This suite pins tool_search to that host shape and
// proves the legacy string shape fails the same walk.

import assert from 'node:assert/strict';
import test from 'node:test';

import { TOOL_SEARCH_SPEC, registerD6 } from '../src/d6/runtime.js';
import { registerTools } from '../src/tools.js';

function tool(name, description) {
  return { name, description, parameters: { value: { type: 'string' } } };
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

const USER = (text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });

function makeHost({ config = { d6: { enabled: true } } } = {}) {
  const defs = [...BASE, TOOL_SEARCH_SPEC];
  const layers = [];
  const listeners = new Map();
  const ctx = {
    tools: {
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
    },
    on(name, listener) {
      const list = listeners.get(name) ?? [];
      list.push(listener);
      listeners.set(name, list);
      return () => {};
    },
    logger() {
      return { info: () => {}, warn: () => {}, debug: () => {} };
    },
    effect() {},
  };
  const agent = { ctx, session: { snapshotEvents: () => [] } };
  const registration = registerD6(ctx, config);
  const emitClaimed = (message, turn = 1) => {
    for (const listener of listeners.get('agent/inbox/claimed') ?? []) {
      listener({ agent, message, turn });
    }
  };
  return { ctx, agent, registration, emitClaimed };
}

// Literal copy of the host walk that threw in the VM
// (@deepseek-ai/dsh-llm 0.2.2-rc.1 contentHasImage). Keep `content.some(...)`
// untouched: a string must fail here with the exact TypeError text.
function contentHasImage(content) {
  return content.some((block) => block.type === 'image');
}

// Host result-content contract: the walk above must not throw, the content must
// be a non-empty array, and every block must be a typed content block with a
// string `text` when it is a text block (the shape OUTPUT_TEXT emits).
function assertHostToolResultContent(content) {
  contentHasImage(content);
  assert.ok(Array.isArray(content), 'tool result content must be an array of content blocks');
  assert.ok(content.length > 0, 'tool result content must contain at least one block');
  for (const block of content) {
    assert.ok(block !== null && typeof block === 'object' && !Array.isArray(block), 'every content block must be an object');
    assert.equal(typeof block.type, 'string', 'every content block needs a string type');
    if (block.type === 'text') assert.equal(typeof block.text, 'string', 'text blocks need a string text');
  }
  return content;
}

test('tool_search renders a legal host content-block array on list and add paths', () => {
  const host = makeHost();
  host.emitClaimed(USER('修复这个 TypeScript 编译错误，补单元测试并跑通'));
  const toolSearch = host.registration.tools[0];
  assert.equal(toolSearch.name, 'tool_search');

  const listed = toolSearch.invoke({}, { exec: { agent: host.agent }, host: () => host.ctx });
  const listedContent = toolSearch.output.render({}, listed);
  assertHostToolResultContent(listedContent);
  assert.deepEqual(JSON.parse(listedContent[0].text), listed);
  assert.match(listedContent[0].text, /"totalTrimmed"/);

  const added = toolSearch.invoke(
    { names: ['read_image'] },
    { exec: { agent: host.agent }, host: () => host.ctx },
  );
  assert.equal(added.ok, true);
  const addedContent = toolSearch.output.render({ names: ['read_image'] }, added);
  assertHostToolResultContent(addedContent);
  assert.deepEqual(JSON.parse(addedContent[0].text), added);
  assert.match(addedContent[0].text, /read_image/);
});

test('tool_search error payloads render through the same content-block shape', () => {
  const host = makeHost();
  const toolSearch = host.registration.tools[0];
  const result = toolSearch.invoke({}, { exec: { agent: host.agent } });
  assert.equal(result.error, 'D6_NOT_FROZEN');
  const content = toolSearch.output.render({}, result);
  assertHostToolResultContent(content);
  assert.deepEqual(JSON.parse(content[0].text), result);
  assert.match(content[0].text, /D6_NOT_FROZEN/);
});

test('registerTools forwards tool_search output.render untouched to the host seam', async () => {
  const host = makeHost();
  const captured = [];
  const count = await registerTools(
    {
      tools: {
        register(definition) {
          captured.push(definition);
          return () => {};
        },
      },
    },
    { defineTool: (definition) => definition, d6Tools: host.registration.tools },
  );
  assert.equal(count, 23);
  const search = captured.find((definition) => definition.name === 'tool_search');
  assert.ok(search, 'tool_search was not registered through registerTools');
  assert.equal(search.output, TOOL_SEARCH_SPEC.output, 'registerTools must forward the output contract by identity');

  const value = await search.execute({}, { agent: host.agent });
  assert.equal(value.error, 'D6_NOT_FROZEN');
  const content = search.output.render({}, value);
  assertHostToolResultContent(content);
  assert.deepEqual(JSON.parse(content[0].text), value);
});

test('the rc.2 string shape fails the same host walk (mutation guard)', () => {
  const legacyRender = (_args, value) => JSON.stringify(value);
  const legacyContent = legacyRender({}, { ok: true, added: ['read_image'] });
  assert.equal(typeof legacyContent, 'string');
  assert.equal(Array.isArray(legacyContent), false);

  // The pre-fix shape must reproduce the reported host failure verbatim.
  assert.throws(() => contentHasImage(legacyContent), /content\.some is not a function/);
  assert.throws(() => assertHostToolResultContent(legacyContent), /content\.some is not a function/);
});
