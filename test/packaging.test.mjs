/**
 * 打包红线（0.9.0-rc.1 合并包版）：安装时只带走 package.json 的 files 白名单。
 * 这里按 pack.mjs 的同一套 glob 语义把白名单复制到临时目录，再按安装后的真实
 * 路径逐个 import。跨目录 re-export、漏掉新模块的 files 条目都会在这里变成
 * ERR_MODULE_NOT_FOUND 或白名单覆盖失败。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const SKIP_DIRS = new Set(['node_modules', '.git', '.longlive', 'dist', '.cache']);

/** Same minimal glob as scripts/pack.mjs: ** crosses directories, * does not. */
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

function walk(dir, out = [], base = ROOT) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(abs, out, base);
    } else if (entry.isFile()) {
      out.push(path.relative(base, abs).split(path.sep).join('/'));
    }
  }
  return out;
}

function selectPublished() {
  const positives = PKG.files.filter((entry) => !entry.startsWith('!')).map((entry) => globToRegExp(entry));
  const negatives = PKG.files.filter((entry) => entry.startsWith('!')).map((entry) => globToRegExp(entry.slice(1)));
  const selected = [];
  for (const rel of walk(ROOT)) {
    if (positives.some((re) => re.test(rel)) && !negatives.some((re) => re.test(rel))) selected.push(rel);
  }
  // npm always includes package.json plus root README*/LICENSE*/CHANGELOG*.
  selected.push('package.json');
  for (const rel of walk(ROOT)) {
    if (!rel.includes('/') && /^(README|LICENSE|CHANGELOG)/.test(rel) && !negatives.some((re) => re.test(rel))) {
      selected.push(rel);
    }
  }
  return [...new Set(selected)].sort();
}

function installShallow(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'longlive-pkg-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const rel of selectPublished()) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), target);
  }
  return root;
}

test('files 白名单覆盖每一个 src 文件与四件新能力的入口', () => {
  const published = new Set(selectPublished());
  for (const rel of walk(path.join(ROOT, 'src'))) {
    assert.ok(published.has(rel), `src 文件不在 files 白名单内：${rel}`);
  }
  for (const rel of [
    'src/identity/index.js',
    'src/identity/handover.js',
    'src/recall/index.js',
    'src/bus/bus.mjs',
    'src/router/background/index.mjs',
    'src/features.js',
    'test/auto-recall.test.mjs',
    'test/metrics.test.mjs',
    'test/bus.test.mjs',
    'test/feature-flags.test.mjs',
    'test/identity-card-marker.test.mjs',
    'test/run-rc.mjs',
    'test/rc5-regressions.test.mjs',
    'test/identity-router/run.mjs',
    'test/fixtures/pre-step-container.mjs',
    'test/fixtures/baseline-0.8.0-registration.json',
    'test/router-background/router.test.mjs',
    'scripts/resident-watcher.ps1',
    'scripts/install-resident-watcher.ps1',
    'scripts/lib/auto-truncate-run.ps1',
  ]) {
    assert.ok(published.has(rel), `files 白名单缺 ${rel}`);
  }
  assert.ok(published.has('test/p1_probe.mjs'), 'files 白名单缺 test/p1_probe.mjs');
  assert.ok(published.has('package.json'), 'files 白名单缺 package.json');
});

test('只带白名单安装后：没有 prototype，所有 src 相对 import 都留在包内', (t) => {
  const root = installShallow(t);
  assert.equal(fs.existsSync(path.join(root, 'prototype')), false, '安装包不该依赖白名单外的 prototype/');

  const offenders = [];
  for (const rel of walk(path.join(root, 'src'), [], root)) {
    if (!/\.(mjs|js)$/.test(rel)) continue;
    const file = path.join(root, rel);
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = match[1] ?? match[2];
      if (!spec.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), spec);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        offenders.push(`${rel} -> ${spec}`);
      }
      if (!fs.existsSync(resolved)) offenders.push(`${rel} -> ${spec}（不存在）`);
    }
  }
  assert.deepEqual(offenders, [], `存在跨出包目录/缺失的 import：\n${offenders.join('\n')}`);
});

test('R2-07 发布版本面：包版本 1.6.7，文档同步 D2/D6 能力集', () => {
  assert.equal(PKG.version, '1.6.7');
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const en = read('docs/README.en.md');
  assert.ok(en.includes('@jjh32456/dsh-longlive-panel@0.2.6'), '面板版本未统一到 0.2.6（scoped 包名）');
  assert.ok(en.includes('jjh32456-dsh-longlive-1.6.7.tgz'), '英文文档示例 tgz 不是 scoped 的 1.6.7');
  assert.ok(en.includes('@jjh32456/dsh-longlive'), '英文文档缺少 scoped 包名');
  assert.equal(en.includes('dsh-longlive-panel@0.1.3'), false, '英文文档仍残留 0.1.3');
  assert.equal(en.includes('0.9.0-rc.1'), false, '英文文档仍残留 rc.1');
  const features = read('docs/FEATURES.md');
  assert.ok(features.startsWith('# 1.6.7'), 'FEATURES.md 标题不是 1.6.7');
  assert.equal(features.includes('0.9.0-rc.1'), false, 'FEATURES.md 仍残留 rc.1');
});

test('R2-08 自动截断默认关闭（代码 enabled=false / mode=dryrun，patch 显式同值）', () => {
  // 1.6.0 的硬验收（滥用面评估 §4.1）：代码默认与包内 patch 对齐，都是
  // enabled:false / mode:dryrun。1.5.0 及以前代码兜底是 enabled:true /
  // mode:'log'，老配置漏写 autoTruncate 时会自动开始 log；这里钉住两者一致。
  const yml = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8');
  const block = yml.match(/autoTruncate:\s*\r?\n\s+enabled:\s*false\s*\r?\n\s+mode:\s*['"]?dryrun['"]?/);
  assert.ok(block, 'cordis.patch.yml 的 session-longlive 配置必须显式写 autoTruncate enabled:false / mode:dryrun');
});

test('只带白名单安装后每个新入口都能 import()', async (t) => {
  const root = installShallow(t);
  for (const rel of [
    'src/index.js',
    'src/features.js',
    'src/metrics/index.mjs',
    'src/identity/index.js',
    'src/recall/index.js',
    'src/bus/bus.mjs',
    'src/router/background/index.mjs',
  ]) {
    const file = path.join(root, rel);
    assert.equal(fs.existsSync(file), true, `入口不在白名单复制结果里：${rel}`);
    const mod = await import(`${pathToFileURL(file).href}?packaging=${Date.now()}-${Math.random()}`);
    assert.ok(mod && typeof mod === 'object', `${rel} 没有导出对象`);
  }
});
