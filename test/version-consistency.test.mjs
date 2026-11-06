// Version-consistency gate (added for 1.6.8, see VERSION-AUDIT.md).
//
// The ONLY authority for the package version is `package.json#version`; every
// other version-bearing place is a projection of it. This suite pins each
// projection so a missed bump fails here instead of shipping an install whose
// docs/tgz/CHANGELOG still name the previous release.
//
// Rules of the house:
//   * current-version claims must equal VERSION exactly;
//   * historical mentions are allowed only in CHANGELOG.md and
//     docs/MIGRATION-1.6.0.md (plus source/test comments, which are not scanned);
//   * the panel (`@jjh32456/dsh-longlive-panel`) is an INDEPENDENT package: its
//     version must be internally consistent but not equal to VERSION.
//
// Everything is read-only file IO: no host, no network, no writes.

import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { VERSION, PACKAGE_ROOT } from '../src/version.js';

const ROOT = PACKAGE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const V = PKG.version;

// Panel is an independent package pinned to its own release 0.2.6, which ships
// together with 1.6.8; the activity panel page ("谁在干什么") is still NOT in
// 0.2.6 (deferred to panel 0.2.7). Bump only with a panel release.
const PANEL_VERSION = '0.2.6';

// Docs that carry release-facing version claims.
const DOC_FILES = [
  'README.md',
  'README.en.md',
  'QUICKSTART.md',
  'SPEC.md',
  'docs/README.en.md',
  'docs/QUICKSTART.md',
  'docs/DEV.md',
  'docs/FAQ.md',
  'docs/CONFIG.md',
  'docs/FEATURES.md',
  'docs/TROUBLESHOOTING.md',
  'docs/ARCHITECTURE.md',
  'docs/OPERATIONS.md',
];

// Files where old version numbers are history, not claims.
const HISTORY_FILES = new Set(['CHANGELOG.md', 'docs/MIGRATION-1.6.0.md']);

const SEMVER = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-rc\.(?:0|[1-9]\d*))?`;

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^\uFEFF/, '');
}

function scan(text, re) {
  const out = [];
  for (const match of text.matchAll(re)) out.push(match);
  return out;
}

// Same minimal glob semantics as scripts/pack.mjs: ** crosses directories, * does not.
function globToRegExp(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        if (pattern[i + 1] === '/') {
          i += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

function whitelisted(rel) {
  for (const entry of PKG.files) {
    if (typeof entry !== 'string' || entry.startsWith('!')) continue;
    if (globToRegExp(entry).test(rel)) return true;
  }
  return false;
}

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

test('1) authority: package.json#version is the only version literal', () => {
  assert.equal(PKG.version, VERSION, 'package.json version must be what src/version.js exports');
  // 1.6.8 is a plain release. A future -rc should change this gate deliberately.
  assert.match(V, new RegExp(String.raw`^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$`),
    `release version must be plain MAJOR.MINOR.PATCH, got ${JSON.stringify(V)}`);
});

test('2) build-info.json: if shipped in the tree it must match the package version', () => {
  const file = path.join(ROOT, 'build-info.json');
  if (!fs.existsSync(file)) {
    // npm pack does not include it (1.6.5/1.6.7 archives: 296 files, no build-info);
    // scripts/pack.mjs regenerates it inside the archive. Absent is the normal state.
    return;
  }
  const info = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(info.schema, 1, 'build-info schema must be 1');
  assert.equal(info.version, V, `build-info version must be ${V} (stale build-info is a release bug)`);
  assert.equal(info.expectedVersion, V, `build-info expectedVersion must be ${V}`);
  assert.equal(info.name, PKG.name, 'build-info name must equal package.json name');
  assert.ok(Number.isInteger(info.fileCount) && info.fileCount > 0, 'build-info fileCount must be a positive integer');
});

test('3) tgz names in docs: every install example names the current release', () => {
  const re = new RegExp(String.raw`([A-Za-z0-9@_.-]*dsh-longlive-)(${SEMVER})\.tgz`, 'g');
  for (const rel of DOC_FILES) {
    const text = readText(rel);
    for (const match of scan(text, re)) {
      const [whole, prefix, version] = match;
      assert.equal(version, V, `${rel}: tgz example ${whole} does not match version ${V}`);
      assert.ok(prefix.startsWith('jjh32456-dsh-longlive-'),
        `${rel}: tgz example must use the scoped release name jjh32456-dsh-longlive-<version>.tgz, got ${whole}`);
    }
  }
  // History may keep old tgz names, but the current release must appear somewhere real.
  assert.ok(readText('SPEC.md').includes(`jjh32456-dsh-longlive-${V}.tgz`),
    `SPEC.md must name the current install archive jjh32456-dsh-longlive-${V}.tgz`);
});

test('4) --expect-version in docs: equals the package version', () => {
  const re = new RegExp(String.raw`--expect-version\s+['"]?(${SEMVER})`, 'g');
  let seen = 0;
  for (const rel of DOC_FILES) {
    for (const match of scan(readText(rel), re)) {
      seen += 1;
      assert.equal(match[1], V, `${rel}: --expect-version ${match[1]} does not match ${V}`);
    }
  }
  assert.ok(seen >= 1, 'no --expect-version example found in published docs (QUICKSTART/DEV must keep one)');
});

test('5) plugin version strings in docs: @jjh32456/dsh-longlive@<v> == VERSION', () => {
  const re = new RegExp(String.raw`@jjh32456/dsh-longlive@(${SEMVER})`, 'g');
  for (const rel of DOC_FILES) {
    for (const match of scan(readText(rel), re)) {
      assert.equal(match[1], V, `${rel}: plugin version string ${match[0]} does not match ${V}`);
    }
  }
  // The bare `@<version>` style used by `plugin list` examples.
  for (const [rel, anchor] of [['docs/DEV.md', `# 应显示 @${V}`], ['docs/FAQ.md', `\`plugin list\` 显示 \`@${V}\``]]) {
    assert.ok(readText(rel).includes(anchor), `${rel}: expected current-version anchor ${JSON.stringify(anchor)}`);
  }
});

test('6) current-version headers and release anchors', () => {
  const features = readText('docs/FEATURES.md');
  assert.ok(features.startsWith(`# ${V} 可选能力与开关`),
    `docs/FEATURES.md must start with "# ${V} 可选能力与开关"`);

  assert.ok(readText('docs/CONFIG.md').includes(`适用版本：**${V}**`),
    `docs/CONFIG.md must say 适用版本：**${V}**`);

  const spec = readText('SPEC.md');
  assert.ok(spec.includes(`当前版本：**${V}**`), `SPEC.md must say 当前版本：**${V}**`);
  assert.ok(spec.includes(`jjh32456-dsh-longlive-${V}.tgz`), `SPEC.md must name jjh32456-dsh-longlive-${V}.tgz`);

  assert.ok(readText('QUICKSTART.md').startsWith(`# QUICKSTART — 五步跑通（${V}）`),
    `QUICKSTART.md must start with the ${V} title`);
  assert.ok(readText('docs/TROUBLESHOOTING.md').startsWith(`# TROUBLESHOOTING.md — 按症状查（${V}）`),
    `docs/TROUBLESHOOTING.md must carry the ${V} title`);
  assert.ok(readText('README.md').includes(`本套文档对应 **${V}**`),
    `README.md must say 本套文档对应 **${V}**`);

  // The activity-stream suite label is versioned dynamically from src/version.js.
  const runRc = readText('test/run-rc.mjs');
  assert.ok(runRc.includes('${VERSION} shared-brain activity stream'),
    'test/run-rc.mjs activity suite label must use ${VERSION} instead of a hardcoded version');
  assert.ok(runRc.includes('${VERSION} version consistency'),
    'test/run-rc.mjs must register the version-consistency suite with a ${VERSION} label');
});

test('7) CHANGELOG: first release heading is the current version, no Unreleased left', () => {
  const changelog = readText('CHANGELOG.md');
  const headings = [...changelog.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
  assert.ok(headings.length > 0, 'CHANGELOG.md has no "## " release headings');
  assert.ok(headings[0].startsWith(V),
    `CHANGELOG.md first release heading must start with the current version ${V}, got ${JSON.stringify(headings[0])}`);
  assert.ok(!/^## Unreleased/m.test(changelog), 'CHANGELOG.md must not keep an Unreleased section in a release');
});

test('8) cordis.patch.yml carries the current release marker', () => {
  const yml = readText('cordis.patch.yml');
  assert.ok(yml.includes(`# ${V}:`),
    `cordis.patch.yml must carry a "# ${V}:" release marker on the current feature block`);
  // The patch has no version field of its own; the marker is the only version projection.
  assert.ok(!/^\s*version:/m.test(yml), 'cordis.patch.yml must not invent a version field');
});

test('9) panel version is internally consistent (independent package)', () => {
  const panelRe = new RegExp(String.raw`@jjh32456/dsh-longlive-panel@(${SEMVER})`, 'g');
  const panelTgzRe = new RegExp(String.raw`jjh32456-dsh-longlive-panel-(${SEMVER})\.tgz`, 'g');
  for (const rel of DOC_FILES) {
    const text = readText(rel);
    for (const match of [...scan(text, panelRe), ...scan(text, panelTgzRe)]) {
      assert.equal(match[1], PANEL_VERSION,
        `${rel}: panel reference ${match[0]} does not match PANEL_VERSION ${PANEL_VERSION}`);
    }
  }
  assert.ok(readText('docs/README.en.md').includes(`@jjh32456/dsh-longlive-panel@${PANEL_VERSION}`),
    `docs/README.en.md must reference the scoped panel @jjh32456/dsh-longlive-panel@${PANEL_VERSION}`);
  assert.ok(readText('test/packaging.test.mjs').includes(`@jjh32456/dsh-longlive-panel@${PANEL_VERSION}`),
    `test/packaging.test.mjs must keep its scoped panel assertion on ${PANEL_VERSION}`);
});

test('10) package.json files whitelist covers every shipped test and src file', () => {
  const tests = fs.readdirSync(path.join(ROOT, 'test'))
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => `test/${name}`)
    .sort();
  assert.ok(tests.length > 20, `unexpectedly few test files: ${tests.length}`);
  for (const rel of tests) {
    assert.ok(PKG.files.includes(rel), `package.json files whitelist misses ${rel}`);
  }

  const srcFiles = walk(path.join(ROOT, 'src'), ROOT).filter((rel) => rel.endsWith('.js') || rel.endsWith('.mjs'));
  assert.ok(srcFiles.length > 50, `unexpectedly few src files: ${srcFiles.length}`);
  const uncovered = srcFiles.filter((rel) => !whitelisted(rel));
  assert.deepEqual(uncovered, [], `src files missing from package.json files whitelist:\n${uncovered.join('\n')}`);

  assert.ok(PKG.files.includes('test/version-consistency.test.mjs'),
    'package.json files must include test/version-consistency.test.mjs');
});

test('11) no workspace wording leaks into the release surface', () => {
  const forbidden = ['activity-stream-165', '本工作树', '版本号仍标', '未做发布级版本推进'];
  for (const rel of DOC_FILES) {
    const text = readText(rel);
    for (const phrase of forbidden) {
      assert.ok(!text.includes(phrase), `${rel}: release docs must not contain workspace wording ${JSON.stringify(phrase)}`);
    }
  }
  const changelog = readText('CHANGELOG.md');
  for (const phrase of forbidden) {
    assert.ok(!changelog.includes(phrase), `CHANGELOG.md must not contain workspace wording ${JSON.stringify(phrase)}`);
  }
  const description = String(PKG.description || '');
  for (const phrase of forbidden) {
    assert.ok(!description.includes(phrase), `package.json description must not contain ${JSON.stringify(phrase)}`);
  }
});

test('12) release tooling must not hardcode the version', () => {
  for (const rel of ['scripts/pack.mjs', 'src/version.js']) {
    const text = readText(rel);
    assert.ok(!/\b1\.\d+\.\d+\b/.test(text),
      `${rel} must derive the version from package.json, found a hardcoded 1.x.y literal`);
  }
});

test('13) dist archives (when present) are named after the current version', () => {
  const dist = path.join(ROOT, 'dist');
  if (!fs.existsSync(dist)) return; // release tree has no dist/; build output lives outside
  const re = new RegExp(String.raw`jjh32456-dsh-longlive-(${SEMVER})\.tgz$`);
  for (const name of fs.readdirSync(dist)) {
    const match = re.exec(name);
    if (!match) continue;
    assert.equal(match[1], V, `dist/${name} is not built from the current version ${V}`);
  }
});
