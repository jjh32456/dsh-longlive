// suite: host-visible Config schema (1.5.0, UI-config batch)
//
// Contract under test:
//   - the exact config block from the live desktop profile's
//     `- id: session-longlive` row parses without losing a value;
//   - every declared default equals the value the 1.5.0 runtime already
//     falls back to (compared against the normalisers, not re-typed copies);
//   - absent fields fall back, unknown keys are preserved (schemastery objects
//     merge unknown members in non-strict mode), and non-boolean switch values
//     are rejected by `~standard.validate` exactly as Cordis calls it.
//
// The fixture is a verbatim copy of the live desktop profile's
// `- id: session-longlive` config block (cordis.patch.yml lines 47-64), read
// on 2026-11-06. It has 10 top-level keys / 10 leaf settings (the task note
// said 11; the file is the authority).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Config, CONFIG_SCHEMA_AVAILABLE } from '../src/config.js';
import { D2_DEFAULTS, normalizeD2Config } from '../src/tool-output.js';
import { FEATURE_DEFAULTS, normalizeFeatureConfig } from '../src/features.js';
import { FACE_CONFIG_KEYS, normalizeFaceConfig } from '../src/router/face/config.mjs';
import { AUTO_TRUNCATE_DEFAULTS, normalizeAutoTruncateConfig } from '../src/auto-truncate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'profile-session-longlive-config.json');

const skip = CONFIG_SCHEMA_AVAILABLE
  ? false
  : 'schemastery 不可解析：安装 peer 或设置 NODE_PATH 指向含 @deepseek-ai/schemastery 的 node_modules';

/** The config block the shipped cordis.patch.yml inserts (read from the work copy). */
const SHIPPED_PATCH_CONFIG = {
  keepEvents: 20000,
  recentWriteWindowMs: 60000,
  routerPolicyProfile: 'generic',
  surgeryRecovery: true,
  routerRuntime: 'off',
  workers: { enabled: false },
  autoTruncate: { enabled: false, mode: 'dryrun' },
  filterEnabled: true,
  shadowEnabled: true,
  autoRecall: { enabled: false, topK: 3, budgetTokens: 2000, everyNTurns: 6 },
  identityCard: { enabled: false, path: '<memoryRoot>/STATE.md' },
  presenceBus: { enabled: false, pollMs: 3000 },
};

test('1.6.0 真实 profile 的 session-longlive config 原样通过校验', { skip }, () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.equal(Object.keys(fixture).length, 10, 'fixture 是 profile 的 10 个顶层键的逐字副本');
  const parsed = Config(fixture);
  for (const [key, value] of Object.entries(fixture)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [child, childValue] of Object.entries(value)) {
        assert.equal(parsed[key][child], childValue, `${key}.${child} 必须原样保留`);
      }
    } else {
      assert.equal(parsed[key], value, `${key} 必须原样保留`);
    }
  }
  // The schema fills the documented sub-defaults even when the profile only
  // wrote the switch.
  assert.deepEqual(parsed.d2, {
    enabled: true,
    maxInlineChars: D2_DEFAULTS.maxInlineChars,
    headRatio: D2_DEFAULTS.headRatio,
    skipTools: [...D2_DEFAULTS.skipTools],
    trimErrors: D2_DEFAULTS.trimErrors,
  });
  assert.equal(parsed.autoRecall.topK, 3);
  assert.equal(parsed.autoRecall.budgetTokens, 2000);
  assert.equal(parsed.autoRecall.everyNTurns, 6);
  assert.equal(parsed.presenceBus.pollMs, 3000);
  assert.equal(parsed.routerRuntime, 'shadow');
  assert.equal(parsed.routerProvider, 'deepseek-account');
  assert.equal(parsed.routerModel, 'auto');
  assert.equal(parsed.routerSharedBoard, true);
});

test('缺省字段回落到 1.6.0 运行时的默认值（对照归一化器，不重复抄常量）', { skip }, () => {
  const parsed = Config({});

  assert.deepEqual(parsed.d2, normalizeD2Config(undefined), 'd2 默认值必须等于 normalizeD2Config(undefined)');
  assert.deepEqual(parsed.d6, {
    enabled: false,
    dryRun: false,
    log: true,
    keepTools: [],
  });

  const features = normalizeFeatureConfig({});
  for (const key of ['enabled', 'topK', 'budgetTokens', 'everyNTurns']) {
    assert.equal(parsed.autoRecall[key], features.autoRecall[key], `autoRecall.${key}`);
  }
  for (const key of ['enabled', 'path', 'maxChars']) {
    assert.equal(parsed.identityCard[key], features.identityCard[key], `identityCard.${key}`);
  }
  for (const key of ['enabled', 'pollMs']) {
    assert.equal(parsed.presenceBus[key], features.presenceBus[key], `presenceBus.${key}`);
  }
  for (const key of ['enabled', 'injectMaxChars', 'maxItems']) {
    assert.equal(parsed.sharedBrain.activity[key], features.sharedBrain.activity[key], `sharedBrain.activity.${key}`);
  }
  for (const key of ['enabled', 'consolidate', 'forget', 'runOnStart', 'startDelayMs']) {
    assert.equal(parsed.autoMaintenance[key], features.autoMaintenance[key], `autoMaintenance.${key}`);
  }

  const face = normalizeFaceConfig(undefined);
  for (const key of FACE_CONFIG_KEYS) {
    assert.equal(parsed.routerFace[key], face[key], `routerFace.${key}`);
  }

  assert.deepEqual(parsed.autoTruncate, normalizeAutoTruncateConfig(undefined));

  // The fields that intentionally have no schema default because the runtime
  // distinguishes "absent" from a value.
  assert.equal(parsed.routerRuntime, undefined);
  assert.equal(parsed.routerProvider, undefined);
  assert.equal(parsed.memoryRoot, undefined);
  assert.equal(parsed.routerProposalEnabled, undefined);
  assert.equal(parsed.routerL4MergeEnabled, undefined);
  assert.equal(parsed.routerWriterLeaseMs, undefined);

  assert.equal(parsed.routerEnabled, false);
  assert.equal(parsed.routerSharedBoard, false);
  assert.equal(parsed.routerModel, 'auto');
  assert.equal(parsed.routerPolicyProfile, 'generic');
  assert.equal(parsed.filterEnabled, true);
  assert.equal(parsed.shadowEnabled, true);
  assert.equal(parsed.surgeryRecovery, true);
  assert.equal(parsed.recoverOnStart, true);
  assert.equal(parsed.autoConclusion, false);
  assert.equal(parsed.keepEvents, 20000);
  assert.equal(parsed.recentWriteWindowMs, 60000);
  assert.equal(parsed.heartbeatMs, 15000);
});

test('发布包 cordis.patch.yml 的 config 也通过校验', { skip }, () => {
  const parsed = Config(SHIPPED_PATCH_CONFIG);
  assert.equal(parsed.routerRuntime, 'off');
  assert.equal(parsed.workers.enabled, false);
  assert.equal(parsed.autoTruncate.enabled, false);
  assert.equal(parsed.autoTruncate.mode, 'dryrun');
  assert.equal(parsed.autoTruncate.keepTurns, AUTO_TRUNCATE_DEFAULTS.keepTurns);
  assert.equal(parsed.autoTruncate.keepTokens, AUTO_TRUNCATE_DEFAULTS.keepTokens);
  assert.deepEqual(parsed.autoRecall, SHIPPED_PATCH_CONFIG.autoRecall);
  assert.deepEqual(parsed.identityCard, { ...SHIPPED_PATCH_CONFIG.identityCard, maxChars: 800 });
  assert.equal(parsed.presenceBus.enabled, false);
  assert.equal(parsed.presenceBus.pollMs, 3000);
  assert.equal('root' in parsed.presenceBus, false, '未配置的可选字段不应被凭空写出');
});

test('未知键不被拒绝：顶层、嵌套块与测试注入口都保留', { skip }, () => {
  const now = () => new Date(0);
  const parsed = Config({
    now,
    futureTopLevel: { flag: 1 },
    d2: { enabled: false, futureSubKey: 'kept' },
  });
  assert.equal(parsed.now, now, '测试注入的函数必须原样穿过 Config');
  assert.deepEqual(parsed.futureTopLevel, { flag: 1 });
  assert.equal(parsed.d2.futureSubKey, 'kept');
});

test('开关字段类型校验：非布尔被拒绝（~standard 与直接调用一致）', { skip }, () => {
  for (const config of [
    { d2: { enabled: 'true' } },
    { d6: { enabled: 1 } },
    { autoRecall: { enabled: 'yes' } },
    { presenceBus: { enabled: false, pollMs: 'soon' } },
    { autoMaintenance: { enabled: 'yes' } },
    { routerFace: { enabled: 'on' } },
    { routerEnabled: 'true' },
  ]) {
    assert.throws(() => Config(config), /expected (boolean|number)/, JSON.stringify(config));
    const result = Config['~standard'].validate(config);
    assert.ok(Array.isArray(result.issues) && result.issues.length > 0,
      `${JSON.stringify(config)} 必须被 ~standard.validate 拒绝`);
  }
  const accepted = Config['~standard'].validate({ d2: { enabled: true } });
  assert.equal(accepted.issues, undefined);
  assert.equal(accepted.value.d2.enabled, true);
});

test('schema 面：可 toJSON、描述同时有 zh/en、分组可折叠', { skip }, () => {
  assert.equal(typeof Config, 'function');
  assert.equal(Config['~standard'].version, 1);
  assert.equal(typeof Config.toJSON, 'function');
  const json = Config.toJSON();
  assert.ok(json && json.refs, 'toJSON 必须返回 schemastery 的 refs 信封');

  const d2Enabled = Config.dict.d2.dict.enabled;
  assert.equal(d2Enabled.meta.description.zh, '开启 D2 工具输出裁剪（默认关闭）。');
  assert.equal(d2Enabled.meta.description.en, 'Enable D2 tool-output trimming (off by default).');
  assert.equal(d2Enabled.meta.description[''], '开启 D2 工具输出裁剪（默认关闭）。');
  assert.equal(Config.dict.d2.meta.collapse, true, '嵌套块应可折叠');
  assert.equal(Config.dict.d6.meta.collapse, true);
  assert.equal(Config.dict.routerFace.meta.collapse, true);
  assert.equal(Config.dict.sharedBrain.meta.collapse, true, 'sharedBrain 是折叠块');
  assert.equal(Config.dict.sharedBrain.dict.activity.dict.enabled.meta.description.zh,
    '开启共享大脑活动流（默认关闭）。');

  assert.equal(Config.dict.memoryRoot.meta.disabled, true, 'memoryRoot 是只读展示字段');
  assert.equal(Config.dict.memRoot.meta.disabled, true);
});
