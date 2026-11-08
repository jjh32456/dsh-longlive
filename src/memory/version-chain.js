// src/memory/version-chain.js — M2-D：蒸馏版本链 / active 指针 / 回滚 / 审计
//
// 设计依据 MEMORY-RECALL-V2-PROPOSAL §4.3/§4.4：
//   * 每个蒸馏 id 一个 append-only JSONL（`.longlive/distill/<topic>-<period>.jsonl`），
//     一行一个版本，旧版本永久保留、绝不覆盖/删除；
//   * `.longlive/distill/index.json` 只存 activeVersion 指针，回滚=切指针（ms 级）；
//   * 每次 append / rollback 写 1 行 `.longlive/distill.log`（JSON，可审计）+
//     1 行 `.longlive/audit/records.jsonl`（统一审计，A5 口径）；
//   * 本模块只做“链/指针/审计”原语，不做抽取、不做保护判定（见 distill.js / l2-gate.js）。

import fs from 'node:fs';
import path from 'node:path';

import { appendAuditRecord } from './audit-records.js';
import { memoryError } from './paths.js';
import { appendAudit, ensureDir, sha256Text, writeFileAtomic } from './state.js';

export const VERSION_CHAIN_SCHEMA = 'version-chain/v1';
export const DISTILL_DIR = '.longlive/distill';
export const DISTILL_INDEX_FILE = '.longlive/distill/index.json';
export const DISTILL_LOG_FILE = '.longlive/distill.log';
export const DISTILL_INDEX_SCHEMA = 'distill-index/v1';

export function distillDirOf(root) {
  return path.join(path.resolve(String(root)), DISTILL_DIR);
}

export function chainIndexPathOf(root) {
  return path.join(path.resolve(String(root)), DISTILL_INDEX_FILE);
}

export function chainLogPathOf(root) {
  return path.join(path.resolve(String(root)), DISTILL_LOG_FILE);
}

/** File name for one chain: only [A-Za-z0-9._-] survives (path traversal impossible). */
export function chainFileName({ topic, period }) {
  const slug = (value) => String(value ?? 'unknown')
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unknown';
  return `${slug(topic)}-${slug(period)}.jsonl`;
}

export function chainFilePathOf(root, id, file = null) {
  const name = typeof file === 'string' && file !== '' ? file : chainFileName({ topic: id, period: 'chain' });
  return path.join(distillDirOf(root), path.basename(name));
}

/** Deterministic JSON: object keys sorted recursively (idempotency hashes). */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function contentHashOf(value) {
  return sha256Text(stableStringify(value));
}

export function isEmptyIndex() {
  return { schema: DISTILL_INDEX_SCHEMA, version: 1, entries: {} };
}

/** Read the active-pointer index; missing file => empty index, corrupt file => refuse (fail-safe). */
export function readChainIndex(root) {
  const file = chainIndexPathOf(root);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ...isEmptyIndex(), file };
    throw memoryError('E_CHAIN_INDEX_READ', `读不到 ${file}`, error);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw memoryError('E_CHAIN_INDEX_CORRUPT', `版本索引损坏（拒绝覆盖，先人工核对）：${file}`, error);
  }
  const entries = parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object'
    ? parsed.entries
    : {};
  return { schema: parsed?.schema ?? DISTILL_INDEX_SCHEMA, version: parsed?.version ?? 1, entries, file };
}

export function readIndexEntry(root, id) {
  const index = readChainIndex(root);
  const entry = index.entries[String(id)];
  if (!entry || typeof entry !== 'object') return null;
  return {
    id: String(id),
    file: typeof entry.file === 'string' ? entry.file : null,
    activeVersion: Number.isInteger(entry.activeVersion) ? entry.activeVersion : null,
    versionCount: Number.isInteger(entry.versionCount) ? entry.versionCount : null,
    contentHash: typeof entry.contentHash === 'string' ? entry.contentHash : null,
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
  };
}

export function listChains(root) {
  const index = readChainIndex(root);
  return Object.keys(index.entries).sort().map((id) => ({
    id,
    ...readIndexEntry(root, id),
  }));
}

/** Parse one chain file into versions (append-only order). Corrupt line => refuse. */
export function readVersions(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw memoryError('E_CHAIN_READ', `读不到版本链：${file}`, error);
  }
  const versions = [];
  raw.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') return;
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object' || !Number.isInteger(row.version)) {
        throw new Error('version is not an integer');
      }
      versions.push(row);
    } catch (error) {
      throw memoryError('E_CHAIN_CORRUPT', `版本链第 ${index + 1} 行损坏：${file}`, error);
    }
  });
  return versions;
}

/** Append one version line (fsync; never rewrites existing bytes). */
export function appendVersionLine({ file, record }) {
  if (!record || !Number.isInteger(record.version) || record.version < 1) {
    throw memoryError('E_CHAIN_VERSION', 'appendVersionLine requires record.version >= 1');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, `${JSON.stringify(record)}\n`, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return { file, version: record.version, line: JSON.stringify(record) };
}

/** Atomically set the active version pointer for one chain. */
export function setActiveVersion({ root, id, file, version, versionCount, contentHash = null, now = new Date() }) {
  const index = readChainIndex(root);
  index.entries[String(id)] = {
    file: path.basename(String(file)),
    activeVersion: version,
    versionCount,
    contentHash,
    updatedAt: now.toISOString(),
  };
  const next = { schema: DISTILL_INDEX_SCHEMA, version: 1, entries: index.entries, updatedAt: now.toISOString() };
  writeFileAtomic(root, chainIndexPathOf(root), `${JSON.stringify(next, null, 2)}\n`, { backup: false, now });
  return { file: chainIndexPathOf(root), entry: index.entries[String(id)] };
}

/** Append one structured audit line to `.longlive/distill.log` (JSONL). */
export function appendChainLog({ root, op, id = null, file = null, fromVersion = null, toVersion = null, by = 'admin', reason = '', contentHash = null, now = new Date() }) {
  const row = {
    schema: 'distill-log/v1',
    at: now.toISOString(),
    op,
    id,
    file: file === null ? null : path.basename(String(file)),
    fromVersion,
    toVersion,
    by,
    reason,
    contentHash,
  };
  const target = chainLogPathOf(root);
  ensureDir(root, path.dirname(target));
  fs.appendFileSync(target, `${JSON.stringify(row)}\n`, 'utf8');
  return { file: target, row };
}

function appendUnifiedAudit({ root, action, recordId, extra, now }) {
  try {
    appendAuditRecord({
      memoryRoot: root,
      action,
      recordId,
      readerTier: 'host',
      questionId: 'unknown',
      expectedTurns: null,
      answerText: null,
      at: now.toISOString(),
      extra,
    });
  } catch {
    /* 统一审计是 best-effort：链日志已写，不能让审计写失败吞掉回滚结果 */
  }
}

/**
 * Roll one chain back to a concrete version: only the active pointer moves;
 * every version row stays on disk. Writes 1 distill.log row + 1 unified audit row.
 */
export function rollbackVersion({ root, id, toVersion, by = 'admin', reason = '', now = new Date() }) {
  const entry = readIndexEntry(root, id);
  if (!entry || !entry.file || entry.activeVersion === null) {
    throw memoryError('E_CHAIN_NOT_FOUND', `没有这个蒸馏 id（或尚未建链）：${id}`);
  }
  const file = chainFilePathOf(root, id, entry.file);
  const versions = readVersions(file);
  const target = versions.find((row) => row.version === toVersion);
  if (!target) {
    throw memoryError('E_CHAIN_NO_VERSION', `链 ${id} 没有 v${toVersion}（现有 v${versions[0]?.version}..v${versions.at(-1)?.version}）`);
  }
  if (entry.activeVersion === toVersion) {
    return { ok: true, changed: false, id, file, fromVersion: entry.activeVersion, toVersion, versions: versions.length };
  }
  const fromVersion = entry.activeVersion;
  setActiveVersion({
    root,
    id,
    file,
    version: toVersion,
    versionCount: versions.length,
    contentHash: target.contentHash ?? null,
    now,
  });
  appendChainLog({ root, op: 'rollback', id, file, fromVersion, toVersion, by, reason, contentHash: target.contentHash ?? null, now });
  appendAudit(root, { action: 'memory_distill_rollback', object: `${id}@v${fromVersion}->v${toVersion}`, result: `by=${by} reason=${reason || '-'}`, now });
  appendUnifiedAudit({
    root,
    action: 'distill_rollback',
    recordId: id,
    extra: { fromVersion, toVersion, by, reason, file: path.basename(file) },
    now,
  });
  return { ok: true, changed: true, id, file, fromVersion, toVersion, versions: versions.length };
}

/** Field-level diff between two version rows (audit/createdAt excluded). */
export function diffVersions(from, to) {
  const changed = [];
  const keys = new Set([...Object.keys(from ?? {}), ...Object.keys(to ?? {})]);
  for (const key of [...keys].sort()) {
    if (key === 'audit' || key === 'contentHash') continue;
    const left = stableStringify(from?.[key] ?? null);
    const right = stableStringify(to?.[key] ?? null);
    if (left !== right) changed.push({ field: key, from: from?.[key] ?? null, to: to?.[key] ?? null });
  }
  return {
    changed,
    fromVersion: from?.version ?? null,
    toVersion: to?.version ?? null,
    fromGist: from?.gist ?? null,
    toGist: to?.gist ?? null,
  };
}
