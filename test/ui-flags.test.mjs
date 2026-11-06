// Settings panel: host model, route contract, and the browser controller.
//
// The client bundle is materialized through the same `window.__ModuleLoader__`
// contract the Host client loader uses (lib/client.js only registers a factory
// at script evaluation; the factory runs on first import), so this suite
// catches a broken wrapper without a browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

import { apply as applyPlugin } from '../src/index.js';

import {
  FLAGS,
  FLAGS_GROUPS,
  FLAGS_PACKAGE,
  FLAGS_ROW_ID,
  FLAGS_SLOT_KEY,
  FlagsError,
  createFlagsService,
  describeFlags,
  readFlagValues,
  setFlagInConfig,
} from '../src/ui/flags.js';
import {
  FLAGS_PATH,
  createFlagsRoute,
  createUiService,
  registerUiRoutes,
} from '../src/ui/routes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function readBundle() {
  const source = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');
  let captured;
  const sandbox = {
    window: { __ModuleLoader__: { load(model) { captured = model; } } },
    console,
  };
  vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' });
  assert.ok(captured, 'lib/client.js must call window.__ModuleLoader__.load({id, factory})');
  return captured;
}

const fakeReact = {
  createElement() { return { type: 'element' }; },
  useState() { return [undefined, () => {}]; },
  useEffect() {},
  useSyncExternalStore() { return {}; },
};

function materializeClient() {
  const captured = readBundle();
  const module = captured.factory((specifier) => {
    if (specifier === 'react') return fakeReact;
    throw new Error(`unexpected client require: ${specifier}`);
  });
  return { captured, module };
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(payload) {
      this.body = payload ?? '';
      this.writableEnded = true;
    },
  };
}

function fakeRequest(method, body) {
  const request = new EventEmitter();
  request.method = method;
  request.url = FLAGS_PATH;
  request.headers = { 'content-type': 'application/json' };
  process.nextTick(() => {
    if (body !== undefined) request.emit('data', Buffer.from(JSON.stringify(body)));
    request.emit('end');
  });
  return request;
}

// ---------------------------------------------------------------------------
// Host model
// ---------------------------------------------------------------------------

test('switch table covers the seven requested keys in display groups', () => {
  assert.deepEqual(FLAGS.map((flag) => flag.key), [
    'd2.enabled',
    'd6.enabled',
    'autoRecall.enabled',
    'presenceBus.enabled',
    'routerFace.enabled',
    'autoMaintenance.enabled',
    'routerEnabled',
  ]);
  assert.deepEqual(FLAGS_GROUPS.map((group) => group.id), ['tools', 'memory', 'router']);
  for (const flag of FLAGS) assert.equal(flag.fallback, false);
});

test('readFlagValues falls back to the schema default and accepts only literal true', () => {
  const values = readFlagValues({});
  for (const flag of FLAGS) assert.equal(values[flag.key], false);
  assert.equal(readFlagValues({ d2: { enabled: true } })['d2.enabled'], true);
  assert.equal(readFlagValues({ d2: { enabled: 'yes' } })['d2.enabled'], false);
  assert.equal(readFlagValues({ d2: { enabled: 1 } })['d2.enabled'], false);
});

test('setFlagInConfig writes only the whitelisted path and preserves siblings', () => {
  const raw = {
    routerEnabled: true,
    d2: { enabled: false, maxInlineChars: 4096, skipTools: ['read'] },
    custom: { keep: 1 },
  };
  const next = setFlagInConfig(raw, 'd2.enabled', true);
  assert.equal(next.d2.enabled, true);
  assert.equal(next.d2.maxInlineChars, 4096);
  assert.deepEqual(next.d2.skipTools, ['read']);
  assert.deepEqual(next.custom, { keep: 1 });
  assert.equal(next.routerEnabled, true);
  // The input object is never mutated.
  assert.equal(raw.d2.enabled, false);
});

test('setFlagInConfig rejects unknown, read-only, and non-boolean writes', () => {
  assert.throws(() => setFlagInConfig({}, 'nope.enabled', true), (error) => error instanceof FlagsError && error.code === 'E_FLAG_UNKNOWN');
  assert.throws(() => setFlagInConfig({}, 'memoryRoot', 'D:/x'), (error) => error instanceof FlagsError && error.code === 'E_FLAG_READONLY');
  assert.throws(() => setFlagInConfig({}, 'd2.enabled', 'true'), (error) => error instanceof FlagsError && error.code === 'E_FLAG_TYPE');
  assert.throws(() => setFlagInConfig({}, 'routerEnabled', 1), (error) => error instanceof FlagsError && error.code === 'E_FLAG_TYPE');
});

test('describeFlags projects groups, memory root, and writability', () => {
  const view = describeFlags({ autoRecall: { enabled: true }, routerEnabled: true }, {
    memoryRoot: 'D:/memory-root',
    writable: true,
  });
  assert.equal(view.title, '久视 · 功能开关');
  assert.equal(view.memoryRoot, 'D:/memory-root');
  assert.equal(view.writable, true);
  assert.deepEqual(view.groups.map((group) => group.label), ['工具与会话', '记忆与后台', '路由']);
  const flat = view.groups.flatMap((group) => group.switches);
  assert.equal(flat.length, 7);
  assert.equal(flat.find((item) => item.key === 'autoRecall.enabled').value, true);
  assert.equal(flat.find((item) => item.key === 'd2.enabled').value, false);
  assert.equal(flat.every((item) => item.readOnly === false), true);
});

// ---------------------------------------------------------------------------
// Host service + route
// ---------------------------------------------------------------------------

test('service reads defaults and writes through the injected editor', async () => {
  let store = { routerEnabled: false, d2: { enabled: false, maxInlineChars: 4096 } };
  const writes = [];
  const service = createFlagsService({
    readConfig: () => store,
    canWrite: () => true,
    writeConfig: async (key, value) => {
      writes.push([key, value]);
      store = setFlagInConfig(store, key, value);
    },
    memoryRoot: 'D:/memory-root',
  });
  assert.equal(service.snapshot().groups.flatMap((group) => group.switches).find((item) => item.key === 'd2.enabled').value, false);
  const after = await service.setFlag('d2.enabled', true);
  assert.deepEqual(writes, [['d2.enabled', true]]);
  assert.equal(store.d2.enabled, true);
  assert.equal(store.d2.maxInlineChars, 4096);
  assert.equal(after.ok, true);
});

test('service rejects a failing write and leaves the raw config untouched', async () => {
  const store = { d2: { enabled: false } };
  const service = createFlagsService({
    readConfig: () => store,
    canWrite: () => true,
    writeConfig: async () => { throw new Error('profile patch is read-only'); },
    memoryRoot: 'D:/memory-root',
  });
  await assert.rejects(service.setFlag('d2.enabled', true), (error) => error instanceof FlagsError && error.code === 'E_FLAG_WRITE' && /read-only/.test(error.message));
  assert.equal(store.d2.enabled, false);
});

test('route answers GET with the snapshot and POST with the saved switch', async () => {
  let store = { d2: { enabled: false } };
  const service = createFlagsService({
    readConfig: () => store,
    canWrite: () => true,
    writeConfig: async (key, value) => { store = setFlagInConfig(store, key, value); },
    memoryRoot: 'D:/memory-root',
  });
  const route = createFlagsRoute(service);
  assert.equal(route.kind, 'exact');
  assert.equal(route.path, FLAGS_PATH);

  const getResponse = fakeResponse();
  await route.handler(fakeRequest('GET'), getResponse);
  assert.equal(getResponse.statusCode, 200);
  const getPayload = JSON.parse(getResponse.body);
  assert.equal(getPayload.ok, true);
  assert.equal(getPayload.groups.length, 3);

  const postResponse = fakeResponse();
  await route.handler(fakeRequest('POST', { key: 'd2.enabled', value: true }), postResponse);
  assert.equal(postResponse.statusCode, 200);
  const postPayload = JSON.parse(postResponse.body);
  assert.deepEqual(postPayload.saved, { key: 'd2.enabled', value: true });
  assert.equal(store.d2.enabled, true);
});

test('route maps validation and write failures to typed JSON errors', async () => {
  const service = createFlagsService({
    readConfig: () => ({}),
    canWrite: () => false,
    writeConfig: undefined,
    memoryRoot: null,
  });
  const route = createFlagsRoute(service);

  const readOnly = fakeResponse();
  await route.handler(fakeRequest('POST', { key: 'memoryRoot', value: true }), readOnly);
  assert.equal(readOnly.statusCode, 400);
  assert.equal(JSON.parse(readOnly.body).code, 'E_FLAG_READONLY');

  const typeError = fakeResponse();
  await route.handler(fakeRequest('POST', { key: 'd2.enabled', value: 'true' }), typeError);
  assert.equal(typeError.statusCode, 400);
  assert.equal(JSON.parse(typeError.body).code, 'E_FLAG_BODY');

  const noEditor = fakeResponse();
  await route.handler(fakeRequest('POST', { key: 'd2.enabled', value: true }), noEditor);
  assert.equal(noEditor.statusCode, 409);
  assert.equal(JSON.parse(noEditor.body).code, 'E_FLAG_WRITE');

  const wrongMethod = fakeResponse();
  await route.handler(fakeRequest('DELETE'), wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);
  assert.equal(wrongMethod.headers.allow, 'GET, POST');

  const plainForm = fakeRequest('POST', { key: 'd2.enabled', value: true });
  plainForm.headers = { 'content-type': 'text/plain' };
  const plainFormResponse = fakeResponse();
  await route.handler(plainForm, plainFormResponse);
  assert.equal(plainFormResponse.statusCode, 400);
  assert.equal(JSON.parse(plainFormResponse.body).code, 'E_FLAG_BODY');

  const remote = fakeRequest('GET');
  remote.socket = { remoteAddress: '10.0.0.5' };
  const forbidden = fakeResponse();
  await route.handler(remote, forbidden);
  assert.equal(forbidden.statusCode, 403);
  assert.equal(JSON.parse(forbidden.body).code, 'E_FLAG_FORBIDDEN');
});

test('createUiService resolves the live configEditor row and keeps sibling fields', async () => {
  const entry = {
    options: {
      id: FLAGS_ROW_ID,
      name: FLAGS_PACKAGE,
      config: { d2: { enabled: false, maxInlineChars: 4096 } },
    },
    fiber: { state: 2 },
  };
  const editor = {
    entries: () => [entry],
    async edit(target, change) {
      target.options.config = change(structuredClone(target.options.config));
    },
  };
  const ctx = {
    fiber: { entry },
    get(name) { return name === 'configEditor' ? editor : undefined; },
  };
  const service = createUiService(ctx, { memoryRoot: 'D:/memory-root' });
  assert.equal(service.snapshot().writable, true);
  assert.equal(service.snapshot().memoryRoot, 'D:/memory-root');
  await service.setFlag('d2.enabled', true);
  assert.equal(entry.options.config.d2.enabled, true);
  assert.equal(entry.options.config.d2.maxInlineChars, 4096);
});

test('registerUiRoutes installs an exact route once webServer is available', () => {
  let registered;
  let effects = 0;
  const ctx = {
    fiber: {},
    get() { return undefined; },
    inject(names, callback) {
      assert.deepEqual(names, ['webServer']);
      callback({
        webServer: {
          register(route) { registered = route; return () => {}; },
        },
        effect() { effects += 1; },
      });
    },
  };
  assert.equal(registerUiRoutes(ctx, { config: { d2: { enabled: true } }, memoryRoot: 'H:/m' }), true);
  assert.equal(registered.path, FLAGS_PATH);
  assert.equal(effects, 1);
});

// ---------------------------------------------------------------------------
// Client bundle
// ---------------------------------------------------------------------------

test('client bundle uses the loader contract and exports apply/inject', () => {
  const { captured, module } = materializeClient();
  assert.equal(captured.id, PKG.name);
  assert.equal(typeof captured.factory, 'function');
  assert.deepEqual(Array.from(module.inject), ['slots']);
  assert.equal(typeof module.apply, 'function');
  assert.equal(module.SLOT_KEY, FLAGS_SLOT_KEY);
});

test('client apply registers plugins.row.config under <package>#<row id>', () => {
  const { module } = materializeClient();
  let watched;
  let registered;
  const ctx = {
    slots: {
      inject(slot, callback) {
        watched = slot;
        return callback();
      },
      register(options, component) {
        registered = { options, component };
        return () => {};
      },
    },
    effect() {},
  };
  module.apply(ctx);
  assert.equal(watched, 'plugins.row.config');
  assert.equal(registered.options.key, FLAGS_SLOT_KEY);
  assert.equal(registered.options.name, 'plugins.row.config');
  assert.equal(typeof registered.component, 'function');
});

test('client controller reads defaults, flips optimistically, and persists', async () => {
  const { module } = materializeClient();
  const writes = [];
  const snapshot = describeFlags({ d2: { enabled: false } }, { memoryRoot: 'D:/memory-root', writable: true });
  const controller = module.createFlagsController({
    load: async () => snapshot,
    save: async (key, value) => { writes.push([key, value]); },
  });
  await controller.refresh();
  assert.equal(controller.getSnapshot().status, 'ready');
  assert.equal(controller.getSnapshot().values['d2.enabled'], false);
  assert.equal(controller.getSnapshot().values['routerEnabled'], false);
  const result = await controller.toggle('d2.enabled');
  assert.equal(result.ok, true);
  assert.deepEqual(writes, [['d2.enabled', true]]);
  assert.equal(controller.getSnapshot().values['d2.enabled'], true);
  assert.equal(controller.getSnapshot().pending['d2.enabled'], false);
});

test('client controller rolls the UI back when the save fails', async () => {
  const { module } = materializeClient();
  const snapshot = describeFlags({ routerEnabled: false }, { memoryRoot: 'D:/memory-root', writable: true });
  const controller = module.createFlagsController({
    load: async () => snapshot,
    save: async () => { throw new Error('configEditor: profile patch is read-only'); },
  });
  await controller.refresh();
  const result = await controller.toggle('routerEnabled');
  assert.equal(result.ok, false);
  assert.equal(controller.getSnapshot().values['routerEnabled'], false);
  assert.equal(controller.getSnapshot().pending['routerEnabled'], false);
  assert.match(controller.getSnapshot().failures['routerEnabled'], /read-only/);
});

test('client controller refuses writes in a read-only snapshot', async () => {
  const { module } = materializeClient();
  let saves = 0;
  const controller = module.createFlagsController({
    load: async () => describeFlags({}, { memoryRoot: 'H:/m', writable: false }),
    save: async () => { saves += 1; },
  });
  await controller.refresh();
  const result = await controller.setFlag('d2.enabled', true);
  assert.equal(result.ok, false);
  assert.match(result.error, /只读/);
  assert.equal(saves, 0);
});

test('plugin entry mounts the route and a POST flips the live config row', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'longlive-ui-'));
  const memoryRoot = path.join(home, 'memory');
  fs.mkdirSync(memoryRoot, { recursive: true });
  const entry = {
    options: {
      id: FLAGS_ROW_ID,
      name: FLAGS_PACKAGE,
      config: { d2: { enabled: false, maxInlineChars: 4096 } },
    },
    fiber: { state: 2 },
  };
  const editor = {
    entries: () => [entry],
    async edit(target, change) {
      target.options.config = change(structuredClone(target.options.config));
    },
  };
  let mounted;
  const ctx = {
    fiber: { entry },
    tools: { register: () => () => {} },
    on: () => () => {},
    get(name) { return name === 'configEditor' ? editor : null; },
    effect(factory) { if (typeof factory === 'function') factory(); },
    inject(names, callback) {
      if (!names.includes('webServer')) return;
      callback({
        webServer: {
          register(route) { mounted = route; return () => {}; },
        },
        effect() {},
      });
    },
    logger: { warn() {}, info() {} },
  };
  await applyPlugin(ctx, {
    home,
    memoryRoot,
    env: {},
    heartbeatMs: 0,
    recoverOnStart: false,
    routerRuntime: 'off',
    defineTool: (definition) => definition,
  });
  assert.ok(mounted, 'apply() must register the settings route');
  assert.equal(mounted.path, FLAGS_PATH);

  const before = fakeResponse();
  await mounted.handler(fakeRequest('GET'), before);
  const beforePayload = JSON.parse(before.body);
  const beforeD2 = beforePayload.groups.flatMap((group) => group.switches).find((item) => item.key === 'd2.enabled');
  assert.equal(beforeD2.value, false);
  assert.equal(beforePayload.writable, true);

  const post = fakeResponse();
  await mounted.handler(fakeRequest('POST', { key: 'd2.enabled', value: true }), post);
  assert.equal(post.statusCode, 200);
  assert.equal(entry.options.config.d2.enabled, true);
  assert.equal(entry.options.config.d2.maxInlineChars, 4096);
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

test('package manifest declares ./client and dsh.client for web', () => {
  assert.equal(PKG.name, FLAGS_PACKAGE);
  assert.equal(PKG.exports['./client'], './lib/client.js');
  assert.equal(PKG.dsh.client.platform, 'web');
  assert.ok(PKG.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-plugin-manager'));
  assert.ok(PKG.files.includes('lib/client.js'));
  assert.ok(PKG.files.includes('src/ui/*.js'));
  assert.equal(FLAGS_SLOT_KEY, `${PKG.name}#${FLAGS_ROW_ID}`);
});
