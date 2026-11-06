// Portability acceptance tests (0.7.3).
//
// These cases pin the behaviour that made the package machine-specific before:
//   PORT1 a missing memory root resolves to <home>/longlive-memory and is created
//   PORT2 explicit config / alias / environment precedence is one shared chain
//   PORT3 strict mode still refuses to guess, and a configured-but-missing root
//         is never created silently
//   PORT4 the host version check parses semver, reads engines.dsh, and degrades
//         with a readable warning instead of throwing
//   PORT5 every published file is free of developer-machine paths
//   PORT6 the identity-consent rule names no assistant: consent belongs to the
//         assistant of the current session, whoever that assistant is
//
// Nothing here writes inside the package tree (P6 checks that afterwards).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MEMORY_ROOT_ENV,
  LEGACY_MEMORY_ROOT_ENV,
  DEFAULT_MEMORY_DIRNAME,
  memoryRootFromConfig,
  memoryRootSetting,
  defaultMemoryRoot,
} from '../src/memory/paths.js';
import { memRoot, TOOLS } from '../src/tools.js';
import {
  HOST_VERSION_ENV,
  DEFAULT_HOST_RANGE,
  parseVersion,
  satisfies,
  declaredHostRange,
  checkHostCompatibility,
} from '../src/host-version.js';
import { VERSION } from '../src/version.js';

const PACKAGE_ROOT = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

function readIf(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function walk(files, file) {
  const text = readIf(file);
  if (text !== null) files.push({ file, text });
}

// package.json `files` ships src/router/*.{js,mjs} plus every nested JSON, and
// only top-level .js elsewhere under src. Walk src recursively and mirror that
// shape, so a new subdirectory (src/router was the first) cannot fall out of
// the scan again.
const SRC_SHIPPED = [
  /^src\/[^/]+\.js$/,
  /^src\/memory\/[^/]+\.js$/,
  /^src\/router\/[^/]+\.(?:js|mjs)$/,
  /^src\/router\/(?:[^/]+\/)*[^/]+\.json$/,
];

function collectSrc(files, dir) {
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    if (fs.statSync(abs).isDirectory()) {
      collectSrc(files, abs);
      continue;
    }
    const rel = path.relative(PACKAGE_ROOT, abs).split(path.sep).join('/');
    if (SRC_SHIPPED.some((re) => re.test(rel))) walk(files, abs);
  }
}

function publishedFiles() {
  const files = [];
  for (const name of [
    'package.json', 'cordis.patch.yml', 'README.md', 'README.en.md', 'SPEC.md',
    'runbook.md', 'QUICKSTART.md', 'CHANGELOG.md', 'docs/ERRORS.md',
  ]) walk(files, path.join(PACKAGE_ROOT, name));
  for (const dir of ['scripts', 'test', 'locale']) {
    const abs = path.join(PACKAGE_ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      const file = path.join(abs, name);
      if (!fs.statSync(file).isFile()) continue;
      // test ships .mjs too; locale ships JSON; scripts ship both.
      const shipped = /\.m?js$/.test(name)
        || name.endsWith('.ps1')
        || /\.json$/.test(name);
      if (shipped) walk(files, file);
    }
  }
  const src = path.join(PACKAGE_ROOT, 'src');
  if (fs.existsSync(src)) collectSrc(files, src);
  return files;
}

// Patterns are assembled from pieces so this scanner does not match its own
// source text (the file itself ships and is scanned like any other).
const DRIVE = '[A-Za-z]:';
const SEP = '[\\\\/]+';
const MACHINE_PATTERNS = [
  { name: 'developer profile path', re: new RegExp(`${DRIVE}${SEP}Users${SEP}Admin` + 'istrator', 'i') },
  { name: 'private toolbox path', re: new RegExp(`${DRIVE}${SEP}` + 'dshops', 'i') },
  { name: 'personal memory drive', re: new RegExp('(?<![A-Za-z0-9_])H:' + '\\\\', 'i') },
  { name: 'developer runtime drive', re: new RegExp('(?<![A-Za-z0-9_])G:' + '\\\\', 'i') },
  { name: 'ACE Studio install path', re: new RegExp('Program Files' + SEP + 'ACE ' + 'Studio', 'i') },
  { name: 'private research path', re: new RegExp('听澜' + SEP + 'research') },
];

// PORT6 scans the authored policy text (routing rules + judge/router sources +
// the error catalogue) for a hardcoded assistant name. The consent holder is
// "the assistant of the current session" (consent.holder=assistant); a user's
// unilateral request is never consent, no matter what the assistant is called.
const PERSONA = '听澜';
const OPERATOR_NAME = '金嘉恒';
const PERSONA_RE = new RegExp(`${PERSONA}|${OPERATOR_NAME}`);
// Development-only absolute paths are not policy text: strip the path stem
// (`<persona>/research/...`) before looking for persona wording.
const DEV_PATH_RE = new RegExp(`${PERSONA}[\\\\/]+research`, 'g');
// An override audit records WHO overrode a rule; that is an example signature,
// not the subject of a policy.
const EXAMPLE_SIGNATURE_RE = /\bby:\s*'[^']*'/g;
// Skipped wholesale, each because its persona mentions are example data. Keep
// this list short: every other top-level src/router source is policy surface.
const EXAMPLE_DATA_FILES = new Map([
  ['src/router/design-headings.json',
    'generated verbatim snapshot of the external design doc; quoting the ruling as written is the point'],
  ['src/router/run-sim.mjs',
    'sandbox simulation driver; its literal names are example journal content and override signatures'],
]);

function policyTextFiles() {
  const files = [];
  const routerDir = path.join(PACKAGE_ROOT, 'src/router');
  const collect = (dir, prefix) => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (!/\.(?:json|m?js)$/.test(name)) continue;
      const abs = path.join(dir, name);
      if (!fs.statSync(abs).isFile()) continue;
      const rel = `${prefix}/${name}`;
      if (EXAMPLE_DATA_FILES.has(rel)) continue;
      files.push({ rel, text: fs.readFileSync(abs, 'utf8') });
    }
  };
  collect(routerDir, 'src/router');
  // 策略 profile 是可配置的家规面：generic/owner 都必须保持可移植（无个人名/本机路径）。
  const policiesDir = path.join(routerDir, 'policies');
  if (fs.existsSync(policiesDir)) collect(policiesDir, 'src/router/policies');
  files.push({
    rel: 'docs/ERRORS.md',
    text: fs.readFileSync(path.join(PACKAGE_ROOT, 'docs/ERRORS.md'), 'utf8'),
  });
  return files;
}

export function runPortabilitySuite({ runCase, assert, TMP }) {
  runCase('PORT1', '缺省记忆根：派生 <home>/longlive-memory、按需创建、memRoot 同源', () => {
    const home = path.join(TMP, 'port-home-1');
    fs.rmSync(home, { recursive: true, force: true });
    const expected = path.join(home, DEFAULT_MEMORY_DIRNAME);

    const setting = memoryRootSetting({ home }, {});
    assert(setting.explicit === '', 'no explicit root expected');
    assert(setting.source === 'default', `unexpected source: ${setting.source}`);
    assert(setting.strict === false, 'strict must default off');
    assert(defaultMemoryRoot({ home }, {}) === expected, 'derived root path mismatch');

    const root = memoryRootFromConfig({ home }, {});
    assert(root === expected, `memoryRootFromConfig returned ${root}`);
    assert(fs.statSync(root).isDirectory(), 'derived root was not created');

    assert(memRoot({ home }, {}) === root, 'session_wake and memory_* disagree on the root');
    assert(fs.statSync(root).isDirectory(), 'memRoot did not keep the derived root');
  });

  runCase('PORT2', '记忆根优先级：memoryRoot > memRoot > 新环境变量 > 旧环境变量', () => {
    const a = path.join(TMP, 'port-root-a');
    const b = path.join(TMP, 'port-root-b');
    const c = path.join(TMP, 'port-root-c');
    const d = path.join(TMP, 'port-root-d');
    for (const dir of [a, b, c, d]) fs.mkdirSync(dir, { recursive: true });

    assert(memoryRootFromConfig({ memoryRoot: a, memRoot: b }, {}) === a, 'memoryRoot must win');
    assert(memoryRootFromConfig({ memRoot: b }, { [MEMORY_ROOT_ENV]: c, [LEGACY_MEMORY_ROOT_ENV]: d }) === b,
      'memRoot alias must win over the environment');
    assert(memoryRootFromConfig({}, { [MEMORY_ROOT_ENV]: c, [LEGACY_MEMORY_ROOT_ENV]: d }) === c,
      'new environment variable must win over the legacy one');
    assert(memoryRootFromConfig({}, { [LEGACY_MEMORY_ROOT_ENV]: d }) === d,
      'legacy DSH_MEM must still be honoured');
    assert(memRoot({ memRoot: b }, {}) === b, 'memRoot must honour the memoryRoot alias chain');

    const setting = memoryRootSetting({}, { [MEMORY_ROOT_ENV]: c });
    assert(setting.source === MEMORY_ROOT_ENV, `unexpected source ${setting.source}`);
    assert(setting.explicit === c, 'setting.explicit mismatch');
  });

  runCase('PORT3', 'strict 模式与显式缺失：报错可操作，且绝不创建显式配置的路径', () => {
    const home = path.join(TMP, 'port-home-3');
    fs.rmSync(home, { recursive: true, force: true });

    let strictError = null;
    try {
      memoryRootFromConfig({ home, strictMemoryRoot: true }, {});
    } catch (error) {
      strictError = error;
    }
    assert(strictError, 'strict mode must refuse to derive a root');
    assert(strictError.code === 'E_MEMORY_ROOT_UNSET', `unexpected code ${strictError.code}`);
    assert(/memoryRoot/.test(strictError.message), 'strict message must name memoryRoot');
    assert(strictError.message.includes(MEMORY_ROOT_ENV), 'strict message must name the environment variable');
    assert(strictError.message.includes('longlive-memory'), 'strict message must name the derived default');

    const missing = path.join(TMP, 'port-explicit-missing');
    let missingError = null;
    try {
      memoryRootFromConfig({ memoryRoot: missing }, {});
    } catch (error) {
      missingError = error;
    }
    assert(missingError, 'a configured root that does not exist must be reported');
    assert(missingError.code === 'E_MEMORY_ROOT_MISSING', `unexpected code ${missingError.code}`);
    assert(!fs.existsSync(missing), 'an explicitly configured path must never be created silently');
    assert(/mkdir/.test(missingError.message), 'missing-root message must tell the user how to fix it');

    const envMissing = path.join(TMP, 'port-env-missing');
    let envError = null;
    try {
      memoryRootFromConfig({}, { [LEGACY_MEMORY_ROOT_ENV]: envMissing });
    } catch (error) {
      envError = error;
    }
    assert(envError && envError.code === 'E_MEMORY_ROOT_MISSING', 'legacy env root must be validated');
    assert(!fs.existsSync(envMissing), 'environment root must never be created silently');
  });

  runCase('PORT4', '宿主版本自检：semver、engines.dsh 上界、未知不阻断、失配只降级', () => {
    const parsed = parseVersion('v0.2.1-rc.5');
    assert(parsed && parsed.major === 0 && parsed.minor === 2 && parsed.patch === 1, 'prerelease core must parse');
    assert(satisfies('0.2.1-rc.5', DEFAULT_HOST_RANGE), 'the running host must satisfy the declared range');
    assert(satisfies('0.2.0', DEFAULT_HOST_RANGE), 'lower bound is inclusive');
    assert(!satisfies('0.1.9', DEFAULT_HOST_RANGE), 'older host must be refused');
    assert(!satisfies('1.0.0', DEFAULT_HOST_RANGE), 'newer major must be refused');
    assert(satisfies('0.7.2', '^0.7.0') && !satisfies('0.8.0', '^0.7.0'), 'caret on 0.x');
    assert(satisfies('1.4.0', '>=1.0.0 || =0.9.9'), 'or-ranges');

    const range = declaredHostRange();
    assert(range === DEFAULT_HOST_RANGE, `package.json engines.dsh is ${range}`);
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    assert(pkg.engines.dsh === range, 'declared range must come from package.json');

    const good = checkHostCompatibility({ version: '0.2.1-rc.5', range, pluginVersion: VERSION });
    assert(good.ok === true && good.status === 'ok' && good.warning === null, 'matching host must pass');

    const unknown = checkHostCompatibility({ range, pluginVersion: VERSION });
    assert(unknown.ok === true && unknown.status === 'unknown', 'an unknown host must not be blocked');
    assert(unknown.warning === null, 'an unknown host must not warn until it is known');

    const bad = checkHostCompatibility({ version: '0.1.0', range, pluginVersion: VERSION });
    assert(bad.ok === false && bad.status === 'mismatch', 'old host must be a mismatch');
    assert(bad.warning.includes('0.1.0') && bad.warning.includes('engines.dsh'), 'warning must name both sides');
    assert(/降级|degraded/i.test(bad.warning), 'warning must promise degraded loading, not a crash');

    assert(typeof HOST_VERSION_ENV === 'string' && HOST_VERSION_ENV.startsWith('DSH_'), 'env name');
    const oldDrive = 'H:' + '\\dsh-memory';
    const wake = TOOLS.find((tool) => tool.name === 'session_wake');
    assert(wake && !wake.description.includes(oldDrive), 'session_wake still advertises the old drive');
    const lease = TOOLS.find((tool) => tool.name === 'lease_acquire');
    assert(lease && !lease.description.includes(oldDrive), 'lease_acquire still advertises the old drive');
  });

  runCase('PORT5', '发布文件不含本机盘符、用户目录与私有目录名', () => {
    for (const required of ['QUICKSTART.md', 'docs/ERRORS.md']) {
      assert(fs.existsSync(path.join(PACKAGE_ROOT, required)), `${required} must ship`);
    }
    const files = publishedFiles();
    const scanned = files.map(({ file }) => path.relative(PACKAGE_ROOT, file).split(path.sep).join('/'));
    // A scan that silently skips a shipped subtree proves nothing: pin the
    // files whose machine paths this case exists to catch.
    for (const required of [
      'src/router/router.mjs',
      'src/router/design-headings.json',
      'src/router/shadow.mjs',
      'scripts/pack.mjs',
    ]) {
      assert(scanned.includes(required), `PORT5 漏扫随包文件 ${required}`);
    }
    const hits = [];
    for (const { file, text } of files) {
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        for (const { name, re } of MACHINE_PATTERNS) {
          if (re.test(lines[i])) hits.push(`${path.relative(PACKAGE_ROOT, file)}:${i + 1} (${name}) ${lines[i].trim().slice(0, 100)}`);
        }
      }
    }
    assert(hits.length === 0, `machine-specific paths in published files:\n${hits.join('\n')}`);
  });

  runCase('PORT6', '身份同意规则不写死某个 agent 的名字：同意权归当前会话的助手本人', () => {
    for (const rel of EXAMPLE_DATA_FILES.keys()) {
      assert(fs.existsSync(path.join(PACKAGE_ROOT, rel)), `${rel} 被列为示例数据但文件不存在`);
    }

    const files = policyTextFiles();
    const scanned = files.map((file) => file.rel);
    for (const required of [
      'src/router/routing-rules.json',
      'src/router/judge.mjs',
      'src/router/route.js',
      'docs/ERRORS.md',
    ]) {
      assert(scanned.includes(required), `可移植性扫描漏了 ${required}`);
    }

    const hits = [];
    for (const { rel, text } of files) {
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const subject = lines[i]
          .replace(DEV_PATH_RE, '<dev-path>')
          .replace(EXAMPLE_SIGNATURE_RE, 'by: <example-signature>');
        if (PERSONA_RE.test(subject)) hits.push(`${rel}:${i + 1} ${lines[i].trim().slice(0, 120)}`);
      }
    }
    assert(hits.length === 0,
      `身份同意规则仍写死具体 agent 名（应写「当前会话的助手本人」）：\n${hits.join('\n')}`);

    // Removing the wording must not pass the scan: the rule still has to say
    // whose consent counts, and that the user's own request never does.
    const rules = files.find((file) => file.rel === 'src/router/routing-rules.json').text;
    assert(rules.includes('当前会话的助手本人（consent.holder=assistant）'),
      'whoMayConsent 未声明同意权归「当前会话的助手本人」');
    assert(rules.includes('用户单方面要求永远不构成同意'), '「用户单方面要求不算同意」的语义丢了');
    const catalogue = files.find((file) => file.rel === 'docs/ERRORS.md').text;
    assert(catalogue.includes('本规则与被判断的 agent 具体叫什么无关'),
      'ERRORS.md 缺少「本规则与 agent 具体叫什么无关」的说明');
  });
}
