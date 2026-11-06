#!/usr/bin/env node
// Build a self-identifying package without npm.
//
// The source tree's package.json version is a claim; this script binds that
// claim to the bytes it ships:
//   * the version is read from package.json through src/version.js and is
//     never restated here: a malformed version fails the build, and an
//     optional --expect-version pin must match package.json exactly;
//   * it applies the `files` whitelist, including explicit `!` exclusions for
//     npm's README*/LICENSE* forced-include rule;
//   * it writes `package/build-info.json` with a sha256 for every shipped file
//     and one digest over the whole payload;
//   * it writes `<archive>.sha256` next to the tarball.
//
// Only Node built-ins are used: gzip + a minimal ustar writer/reader.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { readPackageManifest, validateVersion } from '../src/version.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const P1_PROBE = 'test/p1_probe.mjs';
const BUILD_INFO = 'build-info.json';
const TAR_BLOCK = 512;
const SKIP_DIRS = new Set(['node_modules', '.git', '.longlive', 'dist', '.cache']);

function fail(message) {
  process.stderr.write(`pack: ${message}\n`);
  process.exit(1);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

/** Recursively list regular files under ROOT, skipping build/VCS directories. */
function walk(dir = ROOT, out = []) {
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (dirent.isSymbolicLink()) continue;
    const abs = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      if (SKIP_DIRS.has(dirent.name)) continue;
      walk(abs, out);
      continue;
    }
    if (!dirent.isFile()) continue;
    out.push(toPosix(path.relative(ROOT, abs)));
  }
  return out;
}

/** Minimal glob: `**` crosses directories, `*` and `?` do not. */
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

function selectFiles(pkg) {
  const patterns = Array.isArray(pkg.files) ? pkg.files : [];
  if (patterns.length === 0) fail('package.json has no files whitelist');
  const positives = patterns.filter((p) => !p.startsWith('!'));
  const negatives = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  if (negatives.length === 0) fail('package.json files must contain explicit "!" exclusions');

  const positiveMatchers = positives.map((pattern) => ({ pattern, re: globToRegExp(pattern) }));
  const negativeMatchers = negatives.map((pattern) => ({ pattern, re: globToRegExp(pattern) }));
  const all = walk();
  const selected = new Set();

  for (const rel of all) {
    if (positiveMatchers.some(({ re }) => re.test(rel))) selected.add(rel);
  }

  // npm always includes package.json plus root README*/LICENSE*/CHANGELOG*
  // even when `files` is a whitelist. Mirror that, then let `!` remove the
  // backups npm would otherwise drag in (README.md.bak-* etc.).
  selected.add('package.json');
  for (const rel of all) {
    if (rel.includes('/')) continue;
    if (/^(README|LICENSE|LICENCE|CHANGELOG|HISTORY)(\..*)?$/i.test(rel)) selected.add(rel);
  }

  for (const rel of [...selected]) {
    if (negativeMatchers.some(({ re }) => re.test(rel))) selected.delete(rel);
  }

  const files = [...selected].sort();
  const strays = files.filter((rel) => rel.includes('.bak-'));
  if (strays.length > 0) {
    fail(`backup file leaked into the package (add a "!" exclusion): ${strays.join(', ')}`);
  }
  if (!files.includes(P1_PROBE)) fail(`${P1_PROBE} is missing from the package`);
  if (!files.includes('package.json')) fail('package.json is missing from the package');
  return {
    files,
    excludedBackups: all.filter((rel) => rel.includes('.bak-')).sort(),
  };
}

function octal(value, width) {
  const text = Math.max(0, value).toString(8);
  if (text.length > width - 1) throw new Error(`octal overflow: ${value}`);
  return `${'0'.repeat(width - 1 - text.length)}${text}\0`;
}

function splitTarName(rel) {
  const full = `package/${rel}`;
  if (Buffer.byteLength(full) <= 100) return { name: full, prefix: '' };
  const parts = full.split('/');
  for (let i = parts.length - 1; i > 0; i -= 1) {
    const prefix = parts.slice(0, i).join('/');
    const name = parts.slice(i).join('/');
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`path too long for ustar: ${rel}`);
}

function tarHeader(rel, size) {
  const { name, prefix } = splitTarName(rel);
  const header = Buffer.alloc(TAR_BLOCK, 0);
  header.write(name, 0, 100, 'utf8');
  header.write(octal(0o644, 8), 100, 8, 'ascii');
  header.write(octal(0, 8), 108, 8, 'ascii');
  header.write(octal(0, 8), 116, 8, 'ascii');
  header.write(octal(size, 12), 124, 12, 'ascii');
  header.write(octal(0, 12), 136, 12, 'ascii'); // mtime 0 -> reproducible
  header.write('        ', 148, 8, 'ascii'); // checksum placeholder
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(octal(0, 8), 329, 8, 'ascii');
  header.write(octal(0, 8), 337, 8, 'ascii');
  header.write(prefix, 345, 155, 'utf8');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function makeTar(entries) {
  const chunks = [];
  for (const entry of entries) {
    chunks.push(tarHeader(entry.path, entry.bytes.length));
    chunks.push(entry.bytes);
    const pad = (TAR_BLOCK - (entry.bytes.length % TAR_BLOCK)) % TAR_BLOCK;
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(TAR_BLOCK * 2, 0));
  return Buffer.concat(chunks);
}

function parseTar(buffer) {
  const entries = [];
  for (let offset = 0; offset + TAR_BLOCK <= buffer.length;) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8);
    const type = header.subarray(156, 157).toString('ascii');
    if (!Number.isFinite(size) || size < 0) throw new Error(`bad tar size at ${offset}`);
    const start = offset + TAR_BLOCK;
    const body = buffer.subarray(start, start + size);
    if (body.length !== size) throw new Error(`truncated tar entry ${name}`);
    const full = prefix ? `${prefix}/${name}` : name;
    if (type === '0') entries.push({ path: full, bytes: body });
    offset = start + size + ((TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK);
  }
  return entries;
}

function payloadManifest(files) {
  const rows = files.map((rel) => {
    const bytes = fs.readFileSync(path.join(ROOT, rel));
    return { path: rel, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const canonical = rows.map((row) => `${row.sha256}  ${row.path}\n`).join('');
  return {
    files: rows,
    sourceTreeSha256: sha256(canonical),
  };
}

function build(options) {
  const pkg = readPackageManifest(ROOT);
  let version;
  try {
    version = validateVersion(pkg.version, path.join(ROOT, 'package.json'));
  } catch (error) {
    fail(error.message);
  }
  // An optional --expect-version pin (release scripts pass it) must agree with
  // package.json; without it the package.json version is the only authority.
  const expectedVersion = options.expectVersion ?? version;
  if (expectedVersion !== version) {
    fail(`package.json version is ${JSON.stringify(version)}, ` +
      `which does not match --expect-version ${JSON.stringify(expectedVersion)}`);
  }
  if (pkg.name !== 'dsh-longlive') {
    fail(`package name is ${JSON.stringify(pkg.name)}`);
  }
  const { files, excludedBackups } = selectFiles(pkg);
  const manifest = payloadManifest(files);
  const payload = files.map((rel) => ({
    path: rel,
    bytes: fs.readFileSync(path.join(ROOT, rel)),
  }));

  const buildInfo = {
    schema: 1,
    name: pkg.name,
    version,
    expectedVersion,
    builtBy: 'scripts/pack.mjs',
    generatedAt: process.env.SOURCE_DATE_EPOCH
      ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
      : new Date().toISOString(),
    fileCount: manifest.files.length,
    sourceTreeSha256: manifest.sourceTreeSha256,
    manifestExcludes: [BUILD_INFO],
    files: manifest.files,
  };
  const buildInfoBytes = Buffer.from(`${JSON.stringify(buildInfo, null, 2)}\n`, 'utf8');

  const entries = [
    ...payload.map((entry) => ({ path: entry.path, bytes: entry.bytes })),
    { path: BUILD_INFO, bytes: buildInfoBytes },
  ];
  const tar = makeTar(entries);
  const gz = zlib.gzipSync(tar, { level: 9 });
  const out = path.resolve(options.out ?? path.join(ROOT, 'dist', `dsh-longlive-${version}.tgz`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, gz);
  const digest = sha256(gz);
  const sidecar = `${out}.sha256`;
  fs.writeFileSync(sidecar, `${digest}  ${path.basename(out)}\n`, 'utf8');

  return {
    ok: true,
    name: pkg.name,
    version,
    archive: out,
    sha256: digest,
    bytes: gz.length,
    fileCount: files.length,
    sourceTreeSha256: manifest.sourceTreeSha256,
    p1Probe: files.includes(P1_PROBE),
    backupFiles: [],
    excludedBackups,
    sidecar,
  };
}

function verify(archivePath, options = {}) {
  const archive = path.resolve(archivePath);
  const gz = fs.readFileSync(archive);
  const digest = sha256(gz);
  const entries = parseTar(zlib.gunzipSync(gz));
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const infoEntry = byPath.get(`package/${BUILD_INFO}`);
  if (!infoEntry) throw new Error(`package/${BUILD_INFO} is missing from the archive`);
  const info = JSON.parse(infoEntry.bytes.toString('utf8'));

  if (info.version !== info.expectedVersion) {
    throw new Error(
      `build-info expectedVersion ${JSON.stringify(info.expectedVersion)} != version ${JSON.stringify(info.version)}`);
  }
  const version = validateVersion(info.version, `package/${BUILD_INFO}`);
  if (options.expectVersion && options.expectVersion !== version) {
    throw new Error(
      `archive version ${JSON.stringify(version)} does not match --expect-version ${JSON.stringify(options.expectVersion)}`);
  }
  if (info.name !== 'dsh-longlive') throw new Error(`build-info name ${JSON.stringify(info.name)}`);
  if (!Array.isArray(info.files) || info.files.length === 0) throw new Error('build-info has no file manifest');

  const paths = new Set();
  for (const row of info.files) {
    if (typeof row.path !== 'string' || row.path.includes('..') || path.isAbsolute(row.path)) {
      throw new Error(`unsafe manifest path: ${JSON.stringify(row.path)}`);
    }
    if (paths.has(row.path)) throw new Error(`duplicate manifest path: ${row.path}`);
    paths.add(row.path);
    const entry = byPath.get(`package/${row.path}`);
    if (!entry) throw new Error(`manifest file missing from archive: ${row.path}`);
    const actual = sha256(entry.bytes);
    if (actual !== row.sha256) throw new Error(`sha256 mismatch for ${row.path}: ${actual} != ${row.sha256}`);
    if (entry.bytes.length !== row.bytes) throw new Error(`size mismatch for ${row.path}`);
  }
  if (!paths.has(P1_PROBE)) throw new Error(`${P1_PROBE} missing from build-info manifest`);

  const rebuilt = info.files.map((row) => `${row.sha256}  ${row.path}\n`).join('');
  const sourceTreeSha256 = sha256(rebuilt);
  if (sourceTreeSha256 !== info.sourceTreeSha256) {
    throw new Error(`sourceTreeSha256 mismatch: ${sourceTreeSha256} != ${info.sourceTreeSha256}`);
  }

  const backupFiles = entries.map((entry) => entry.path).filter((name) => name.includes('.bak-'));
  if (backupFiles.length > 0) throw new Error(`backup files in archive: ${backupFiles.join(', ')}`);

  const extra = entries
    .map((entry) => entry.path)
    .filter((name) => name.startsWith('package/') && name !== `package/${BUILD_INFO}`)
    .filter((name) => !paths.has(name.slice('package/'.length)));
  if (extra.length > 0) throw new Error(`archive files absent from manifest: ${extra.join(', ')}`);

  const sidecarPath = `${archive}.sha256`;
  let sidecarOk = null;
  if (fs.existsSync(sidecarPath)) {
    const declared = fs.readFileSync(sidecarPath, 'utf8').trim().split(/\s+/)[0];
    sidecarOk = declared === digest;
    if (!sidecarOk) throw new Error(`sidecar sha256 mismatch: ${declared} != ${digest}`);
  }

  return {
    ok: true,
    version,
    archive,
    sha256: digest,
    bytes: gz.length,
    fileCount: info.files.length,
    sourceTreeSha256,
    p1Probe: true,
    backupFiles,
    sidecarOk,
  };
}

function takeValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail(`${flag} needs a value`);
  args.splice(index, 2);
  return value;
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const verifyPath = takeValue(args, '--verify');
const out = takeValue(args, '--out');
const expectVersion = takeValue(args, '--expect-version');
if (expectVersion !== undefined) {
  try {
    validateVersion(expectVersion, '--expect-version');
  } catch (error) {
    fail(error.message);
  }
}
for (const arg of args) {
  if (arg !== '--json') fail(`unknown argument: ${arg}`);
}

try {
  const result = verifyPath
    ? verify(verifyPath, { expectVersion })
    : build({ out, expectVersion });
  process.stdout.write(`${JSON.stringify(result, null, json ? 0 : 2)}\n`);
} catch (error) {
  fail(error?.message ?? String(error));
}
