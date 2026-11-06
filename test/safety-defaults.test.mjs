// 1.6.0 safety defaults — hard acceptance for the pre-release merge.
//
// One suite pins the five changes that came out of the abuse assessment and
// the settings-panel contract:
//   1. autoTruncate code default is off/dryrun and matches cordis.patch.yml;
//   2. routerRuntime defaults to off (shadow is opt-in only);
//   3. worker_spawn/worker_status/worker_kill stay in the 22-tool surface but
//      every Host invocation returns "unavailable" until workers.enabled:true;
//   4. the settings client registers plugins.row.config under the renamed
//      package key `dsh-longlive#session-longlive` (row id unchanged);
//   5. README's two absolute claims are qualified, the Chinese token default is
//      300000, and the package ships a real MIT LICENSE.
//
// These are behavioural/static checks on purpose: the release gate is the
// packaged tree, not a design document.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUTO_TRUNCATE_DEFAULTS,
  normalizeAutoTruncateConfig,
} from '../src/auto-truncate.js';
import { CONFIG_SCHEMA_AVAILABLE, Config } from '../src/config.js';
import {
  TOOLS,
  WORKERS_DEFAULTS,
  WORKER_TOOL_NAMES,
  WORKERS_DISABLED_MESSAGE,
  registerTools,
} from '../src/tools.js';
import {
  FLAGS_PACKAGE,
  FLAGS_ROW_ID,
  FLAGS_SLOT_KEY,
} from '../src/ui/flags.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('autoTruncate: code default and shipped patch are both enabled:false / dryrun', () => {
  assert.equal(AUTO_TRUNCATE_DEFAULTS.enabled, false, 'AUTO_TRUNCATE_DEFAULTS.enabled 必须为 false');
  assert.equal(AUTO_TRUNCATE_DEFAULTS.mode, 'dryrun', 'AUTO_TRUNCATE_DEFAULTS.mode 必须为 dryrun');
  const normalized = normalizeAutoTruncateConfig(undefined);
  assert.equal(normalized.enabled, false, 'autoTruncate.enabled 代码默认必须为 false');
  assert.equal(normalized.mode, 'dryrun', 'autoTruncate.mode 代码默认必须为 dryrun');
  assert.equal(normalized.tokensThreshold, 300000);

  const yml = read('cordis.patch.yml');
  assert.match(
    yml,
    /autoTruncate:\s*\r?\n\s+enabled:\s*false\s*\r?\n\s+mode:\s*['"]?dryrun['"]?/,
    'cordis.patch.yml 必须显式写 autoTruncate enabled:false / mode:dryrun',
  );
  // An empty object must not silently re-enable log mode.
  const empty = normalizeAutoTruncateConfig({});
  assert.equal(empty.enabled, false);
  assert.equal(empty.mode, 'dryrun');
});

test('routerRuntime: runtime default is off, patch is explicit, shadow stays opt-in', () => {
  const index = read('src/index.js');
  assert.match(index, /const runtimeMode = config\.routerRuntime \?\? 'off';/,
    "index.js 的 routerRuntime 缺省值必须是 'off'");
  assert.equal(/: 'shadow'\);\s*\n\s*let routerRuntime/.test(index), false,
    'index.js 仍残留 shadow 作为缺省值');

  const yml = read('cordis.patch.yml');
  assert.match(yml, /routerRuntime:\s*['"]off['"]/, "cordis.patch.yml 必须显式写 routerRuntime: 'off'");

  // The schema must not materialise a default that would override the runtime
  // decision: routerRuntime intentionally has no default.
  if (CONFIG_SCHEMA_AVAILABLE) {
    assert.equal(Config({}).routerRuntime, undefined,
      'routerRuntime 在 schema 里不能有默认值（缺省=off 由 index.js 决定）');
    assert.match(Config.dict.routerRuntime.meta.description.zh, /默认 off/);
  }
});

test('workers: fan-out tools are visible but unavailable until workers.enabled:true', async () => {
  assert.equal(WORKERS_DEFAULTS.enabled, false);
  assert.deepEqual([...WORKER_TOOL_NAMES], ['worker_spawn', 'worker_status', 'worker_kill']);
  assert.equal(TOOLS.length, 22, '默认工具表仍是 22 个（开关不改变表面）');

  async function capture(config) {
    const captured = [];
    const ctx = { tools: { register: (definition) => { captured.push(definition); return () => {}; } } };
    const count = await registerTools(ctx, {
      defineTool: (definition) => definition,
      ...config,
    });
    return { captured, count };
  }
  const byName = (defs) => new Map(defs.map((definition) => [definition.name, definition]));

  const off = await capture({});
  assert.equal(off.count, 22);
  const offTools = byName(off.captured);
  for (const name of WORKER_TOOL_NAMES) {
    const result = await offTools.get(name).execute({ prompt: 'x', workerId: 'w1' }, {});
    assert.equal(result.ok, false, `${name} 默认必须不可用`);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.available, false);
    assert.match(result.message, /workers\.enabled/);
  }

  const on = await capture({ workers: { enabled: true } });
  const onTools = byName(on.captured);
  const spawn = await onTools.get('worker_spawn').execute({}, {});
  assert.match(spawn.message, /缺少必填参数 prompt/, 'workers.enabled:true 后应越过开关');
  assert.equal(spawn.message.includes(WORKERS_DISABLED_MESSAGE), false);
  const status = await onTools.get('worker_status').execute({}, {});
  assert.match(status.message, /缺少必填参数 workerId/);
});

test('settings client: slot key is @jjh32456/dsh-longlive#session-longlive (row id unchanged)', () => {
  assert.equal(PKG.name, '@jjh32456/dsh-longlive');
  assert.equal(FLAGS_PACKAGE, '@jjh32456/dsh-longlive');
  assert.equal(FLAGS_ROW_ID, 'session-longlive');
  assert.equal(FLAGS_SLOT_KEY, '@jjh32456/dsh-longlive#session-longlive');
  assert.equal(FLAGS_SLOT_KEY, `${PKG.name}#${FLAGS_ROW_ID}`);

  const bundle = read('lib/client.js');
  assert.ok(bundle.includes('id: "@jjh32456/dsh-longlive"'), 'client 模块 id 必须与包名一致');
  assert.ok(bundle.includes('const SLOT_KEY = "@jjh32456/dsh-longlive#session-longlive";'),
    'client 注册的 slot key 必须是 @jjh32456/dsh-longlive#session-longlive');
  assert.equal(bundle.includes('dsh-session-longlive#session-longlive'), false,
    'client 仍残留旧包名 slot key');
  assert.equal(bundle.includes('"dsh-session-longlive"'), false,
    'client 仍残留旧包名 id');
  assert.equal(bundle.includes('id: "dsh-longlive"'), false,
    'client 仍残留未 scoped 的模块 id');
});

test('Config schema: 90 nodes (1.6.4 hotTruncate + sharedBrain.activity), safety defaults visible, descriptions in zh+en', { skip: !CONFIG_SCHEMA_AVAILABLE }, () => {
  function countNodes(schema) {
    const dict = schema?.dict;
    if (!dict || typeof dict !== 'object') return 1;
    let total = 1;
    for (const key of Object.keys(dict)) total += countNodes(dict[key]);
    return total;
  }
  // The schema object itself is the root, not a field: subtract it so the count
  // matches the configured nodes. 1.6.0 had 80; 1.6.4 adds the hotTruncate
  // block (1 parent + 4 leaves) = 85; the rebased activity stream adds
  // sharedBrain.activity (1 parent + 1 activity + 3 leaves) = 90.
  assert.equal(countNodes(Config) - 1, 90, 'Config schema 节点数必须保持 90');

  const parsed = Config({});
  assert.equal(parsed.autoTruncate.enabled, false);
  assert.equal(parsed.autoTruncate.mode, 'dryrun');
  assert.equal(parsed.sharedBrain.activity.enabled, false, 'activity stream is off by default');
  assert.match(Config.dict.autoTruncate.dict.enabled.meta.description.zh, /默认关闭/);
  assert.match(Config.dict.routerRuntime.meta.description.en, /default off/);
  assert.equal(Config.dict.memoryRoot.meta.disabled, true);
  assert.equal(Config.dict.memRoot.meta.disabled, true);
});

test('README claims are qualified, token default is 300000, LICENSE ships', () => {
  const zh = read('README.md');
  assert.ok(zh.includes('30 万'), '中文 README 的默认阈值必须写 30 万');
  assert.equal(zh.includes('默认 20 万 token'), false, '中文 README 仍写默认 20 万');
  assert.ok(zh.includes('默认配置不联网'), '中文 README 需要限定“不联网”');
  assert.ok(zh.includes('默认不自动杀进程'), '中文 README 需要限定“不自动杀进程”');

  const en = read('README.en.md');
  assert.ok(en.includes('network requests or telemetry in the default configuration'),
    '英文 README 需要限定 no network');
  assert.ok(en.includes('300000'), '英文 README 的恢复阈值应为 300000');
  assert.equal(en.includes('200000'), false, '英文 README 仍写 200000');

  const license = read('LICENSE');
  assert.match(license, /^MIT License/);
  assert.match(license, /Copyright \(c\) 2026 阿恒、听澜/);
  assert.ok(PKG.files.includes('LICENSE'), 'package.json files 必须显式包含 LICENSE');
});
