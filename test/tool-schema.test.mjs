// Host-contract gate for tool `parameters`.
//
// 1.5.0 shipped D6's `tool_search` with a full JSON Schema object as
// `parameters`.  Host 0.2.2-rc.1's `defineTool` expects a bare property map
// (argument name -> value schema) and throws while building the tool:
//
//   JsonSchemaError: unsupported JSON schema:
//     parameters.type must be a value schema object
//
// That is a startup failure for the whole host (EXIT 1), so it must be caught
// here.  The validator below mirrors the host's author-schema compiler:
//   `_host022/lib/types/schema.js:240` compilePropertyMap(spec, 'parameters')
//   `_host022/lib/types/schema.js:76-83` every property must be a value schema
//   `_host022/lib/types/schema.js:127-205` the value-schema DSL
// It is intentionally local: plain-node suites must not require the host
// package, and the test drives the real `registerTools()` seam instead.

import assert from 'node:assert/strict';
import test from 'node:test';

import { TOOL_SEARCH_SPEC } from '../src/d6/runtime.js';
import { createRouterTools } from '../src/router/service/tools.mjs';
import { TOOLS, registerTools } from '../src/tools.js';

const VALUE_TYPES = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'null',
  'array',
  'object',
  'json',
]);
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'];

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertAllowedKeys(schema, path, allowed) {
  for (const key of Object.keys(schema)) {
    assert.ok(allowed.includes(key), `${path}.${key} is not supported by the host value schema DSL`);
  }
}

/** Compile one value schema the way `_host022/lib/types/schema.js` would. */
function assertValueSchema(schema, path, { allowRequired = false } = {}) {
  assert.ok(isPlainRecord(schema), `${path} must be a value schema object`);
  if (Object.hasOwn(schema, 'required')) {
    assert.equal(allowRequired, true, `${path}.required is only allowed on a property`);
    assert.equal(schema.required, true, `${path}.required must be true when present`);
  }
  const authorKeys = [...ANNOTATION_KEYS, ...(allowRequired ? ['required'] : [])];

  if (Object.hasOwn(schema, 'oneOf')) {
    assert.ok(!Object.hasOwn(schema, 'type'), `${path} cannot declare both type and oneOf`);
    assertAllowedKeys(schema, path, [...authorKeys, 'oneOf']);
    assert.ok(
      Array.isArray(schema.oneOf) && schema.oneOf.length >= 2,
      `${path}.oneOf must be an array of at least two value schemas`,
    );
    schema.oneOf.forEach((branch, index) => {
      assertValueSchema(branch, `${path}.oneOf[${index}]`, { allowRequired: false });
    });
    return;
  }

  assert.ok(Object.hasOwn(schema, 'type'), `${path} must declare type or oneOf`);
  const { type } = schema;
  assert.ok(
    typeof type === 'string' && VALUE_TYPES.has(type),
    `${path}.type must be string/number/integer/boolean/null/array/object/json`,
  );

  if (type === 'object') {
    assertAllowedKeys(schema, path, [...authorKeys, 'type', 'properties', 'additionalProperties']);
    assert.equal(
      typeof schema.additionalProperties,
      'boolean',
      `${path}.additionalProperties must be explicitly true or false`,
    );
    if (Object.hasOwn(schema, 'properties')) {
      const properties = schema.properties;
      assert.ok(isPlainRecord(properties), `${path}.properties must be a map of value schemas`);
      for (const [name, value] of Object.entries(properties)) {
        assertValueSchema(value, `${path}.properties.${name}`, { allowRequired: true });
      }
    }
    return;
  }

  if (type === 'array') {
    assertAllowedKeys(schema, path, [...authorKeys, 'type', 'items']);
    if (Object.hasOwn(schema, 'items')) {
      assertValueSchema(schema.items, `${path}.items`, { allowRequired: false });
    }
    return;
  }

  assertAllowedKeys(schema, path, [...authorKeys, 'type', 'enum', 'const']);
  if (Object.hasOwn(schema, 'enum')) {
    assert.ok(
      Array.isArray(schema.enum) && schema.enum.length > 0,
      `${path}.enum must be a non-empty array of scalar values`,
    );
  }
}

/**
 * The host receives `parameters` and runs `compilePropertyMap` on it.  A
 * top-level `type`/`properties`/`additionalProperties` means the caller passed
 * a wrapped JSON Schema instead of that map.
 */
function assertBareParameterMap(parameters, label) {
  assert.ok(
    isPlainRecord(parameters),
    `${label}: parameters must be an object map of argument name -> value schema`,
  );
  for (const wrapperKey of ['type', 'properties', 'required', 'additionalProperties', '$schema']) {
    assert.ok(
      !Object.hasOwn(parameters, wrapperKey),
      `${label}: parameters must not have a top-level "${wrapperKey}" ` +
        '(the host expects a bare property map, not a JSON Schema object)',
    );
  }
  for (const [name, schema] of Object.entries(parameters)) {
    assertValueSchema(schema, `${label}.${name}`, { allowRequired: true });
  }
  return parameters;
}

test('every default tool hands defineTool a bare parameter map', () => {
  for (const tool of TOOLS) {
    assertBareParameterMap(tool.parameters, tool.name);
  }
});

test('D6 tool_search parameters are a bare map, not a wrapped JSON Schema', () => {
  const parameters = assertBareParameterMap(TOOL_SEARCH_SPEC.parameters, 'tool_search');
  assert.deepEqual(Object.keys(parameters), ['names', 'query', 'limit']);
  assert.equal(parameters.names.type, 'array');
  assert.equal(parameters.names.items.type, 'string');
  assert.equal(parameters.query.type, 'string');
  assert.equal(parameters.limit.type, 'integer');
});

test('registerTools passes the host validator for every registered tool family', async () => {
  const routerTools = createRouterTools({
    status: () => ({ ok: true }),
    config: { proposalEnabled: true },
  });
  const d6Tools = [{ ...TOOL_SEARCH_SPEC, invoke: async () => ({}) }];
  // This is exactly the host seam: registerTools() calls defineTool() once per
  // tool, and defineTool() is what throws in 0.2.2-rc.1.
  const defineTool = (definition) => {
    assertBareParameterMap(definition.parameters, definition.name);
    return definition;
  };
  const captured = [];
  const ctx = {
    tools: {
      register(definition) {
        captured.push(definition);
        return () => {};
      },
    },
  };

  const count = await registerTools(ctx, { defineTool, routerTools, d6Tools });

  assert.equal(count, TOOLS.length + routerTools.length + 1);
  assert.equal(captured.length, count);
  assert.equal(captured.at(-1)?.name, 'tool_search');
  const names = captured.map((definition) => definition.name);
  assert.equal(new Set(names).size, names.length, 'registered tool names must be unique');
});
