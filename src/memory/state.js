// Memory-layer filesystem state.
//
// One place owns every write into the memory root: the `.longlive` state file,
// the audit log, backups, reports, and the atomic write/verify/rollback path.
// Every path is re-checked against the root here, even when a caller already
// resolved it, so a bug upstream cannot become a write outside the store.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { memoryError, resolveInside, relativePath } from './paths.js';

export const LONGLIVE_DIR = '.longlive';
export const BACKUPS_DIR = 'backups';
export const REPORTS_DIR = 'reports';

export function longliveDir(root) {
  return resolveInside(root, LONGLIVE_DIR);
}

export function statePath(root) {
  return resolveInside(root, path.join(LONGLIVE_DIR, 'memory-state.json'));
}

export function backupsDir(root) {
  return resolveInside(root, path.join(LONGLIVE_DIR, BACKUPS_DIR));
}

export function reportsDir(root) {
  return resolveInside(root, path.join(LONGLIVE_DIR, REPORTS_DIR));
}

export function auditPath(root) {
  return resolveInside(root, path.join(LONGLIVE_DIR, 'audit.log'));
}

export function tombstonesPath(root) {
  return resolveInside(root, 'tombstones.md');
}

export function archiveDir(root) {
  return resolveInside(root, path.join('archive', 'tombstones'));
}

export function epochsDir(root) {
  return resolveInside(root, 'epochs');
}

export function stampToken(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\..+$/, '') +
    `-${String(date.getUTCMilliseconds()).padStart(3, '0')}`;
}

export function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

export function sha256Text(text) {
  return sha256Buffer(Buffer.from(String(text), 'utf8'));
}

export function ensureDir(root, dir) {
  const abs = resolveInside(root, dir);
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

function collisionFree(dir, base, stamp, ext) {
  let candidate = path.join(dir, `${base}.${stamp}${ext}`);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}.${stamp}-${index}${ext}`);
    index += 1;
  }
  return candidate;
}

/**
 * Copy one file into a backup directory inside the root and verify the copy
 * byte-for-byte. A failed verification removes the partial copy and throws.
 */
export function backupInto(root, file, dir, { now = new Date() } = {}) {
  const abs = resolveInside(root, file);
  const targetDir = resolveInside(root, dir);
  let stat = null;
  try {
    stat = fs.lstatSync(abs);
  } catch (error) {
    throw memoryError('E_BACKUP_SOURCE', `备份源不存在：${abs}`, error);
  }
  if (!stat.isFile()) {
    throw memoryError('E_BACKUP_SOURCE', `备份源不是普通文件：${abs}`);
  }
  ensureDir(root, targetDir);
  const ext = path.extname(abs);
  const base = path.basename(abs, ext) || 'file';
  const dest = collisionFree(targetDir, base, stampToken(now), ext || '.md');
  fs.copyFileSync(abs, dest);
  const want = sha256File(abs);
  const got = sha256File(dest);
  if (want !== got) {
    try {
      fs.unlinkSync(dest);
    } catch {
      /* best effort: never mask the verification error below */
    }
    throw memoryError('E_BACKUP_VERIFY', `备份校验失败：${dest} 与源文件 sha256 不一致`);
  }
  return { path: dest, rel: relativePath(root, dest), sha256: got };
}

/** Back a file up into `<root>/.longlive/backups/`. */
export function backupFile(root, file, options = {}) {
  return backupInto(root, file, backupsDir(root), options);
}

/** Copy a verified backup back over its original, then verify again. */
export function restoreBackup(root, backup, target) {
  const from = resolveInside(root, backup);
  const to = resolveInside(root, target);
  const want = sha256File(from);
  fs.copyFileSync(from, to);
  const got = sha256File(to);
  if (got !== want) {
    throw memoryError('E_ROLLBACK_FAILED', `回滚校验失败：${to} 的 sha256 与备份不一致`);
  }
  return { path: to, sha256: got };
}

let tmpCounter = 0;

/**
 * Write `content` to `file` atomically: backup first, tmp + rename, read-back
 * verify, and restore the original bytes if the verify fails. The caller gets
 * the backup path so a later step can roll back deliberately as well.
 */
export function writeFileAtomic(root, file, content, { backup: wantBackup = true, now = new Date() } = {}) {
  const abs = resolveInside(root, file);
  ensureDir(root, path.dirname(abs));
  const existed = fs.existsSync(abs);
  const original = existed ? fs.readFileSync(abs) : null;
  const originalSha = original ? sha256Buffer(original) : null;
  const backup = existed && wantBackup ? backupFile(root, abs, { now }) : null;
  const tmp = `${abs}.tmp-${process.pid}-${(tmpCounter += 1)}`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    const staged = fs.readFileSync(tmp, 'utf8');
    if (staged !== content) {
      throw memoryError('E_WRITE_VERIFY', `写入校验失败（临时文件）：${tmp}`);
    }
    fs.renameSync(tmp, abs);
    const readBack = fs.readFileSync(abs, 'utf8');
    if (readBack !== content) {
      throw memoryError('E_WRITE_VERIFY', `写入校验失败（读回内容不一致）：${abs}`);
    }
  } catch (error) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* best effort: the error that matters is the one being rethrown */
    }
    if (originalSha != null) {
      const currentSha = fs.existsSync(abs) ? sha256File(abs) : null;
      if (currentSha !== originalSha) {
        fs.writeFileSync(abs, original);
        if (sha256File(abs) !== originalSha) {
          throw memoryError('E_ROLLBACK_FAILED', `写失败后无法恢复原文件：${abs}`, error);
        }
      }
    }
    throw error instanceof Error && error.code ? error : memoryError('E_WRITE_FAILED', `写入失败：${abs}`, error);
  }
  const sha256 = sha256Text(content);
  return {
    path: abs,
    rel: relativePath(root, abs),
    backup: backup?.path ?? null,
    backupRel: backup?.rel ?? null,
    sha256,
    bytes: Buffer.byteLength(content, 'utf8'),
    created: !existed,
  };
}

export function readJsonFile(file, code, label) {
  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw memoryError(code, `读取失败：${label ?? file}`, error);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw memoryError(code, `JSON 解析失败：${label ?? file} — 文件可能被截断，先修好它再跑工具`, error);
  }
}

const STATE_DEFAULTS = Object.freeze({
  lastConsolidated: null,
  indexBuiltAt: null,
  forgetRuns: [],
  seenProposals: [],
});

/** Read `.longlive/memory-state.json`; a missing file is an empty state. */
export function readState(root) {
  const file = statePath(root);
  const raw = readJsonFile(file, 'E_STATE_CORRUPT', file);
  if (raw == null) return { ...STATE_DEFAULTS, forgetRuns: [], seenProposals: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw memoryError('E_STATE_CORRUPT', `memory-state.json 必须是对象：${file}`);
  }
  return {
    ...STATE_DEFAULTS,
    ...raw,
    forgetRuns: Array.isArray(raw.forgetRuns) ? raw.forgetRuns : [],
    seenProposals: Array.isArray(raw.seenProposals) ? raw.seenProposals : [],
  };
}

/** Merge `patch` into the state file (backup + verify through writeFileAtomic). */
export function updateState(root, patch, { now = new Date() } = {}) {
  const current = readState(root);
  const next = { ...current, ...patch, updatedAt: now.toISOString() };
  const result = writeFileAtomic(root, statePath(root), `${JSON.stringify(next, null, 2)}\n`, { now });
  return { ...next, write: result };
}

/** Append one audit line: ISO time, action, object, result. */
export function appendAudit(root, { action, object, result, now = new Date() }) {
  const line = [
    now.toISOString(),
    String(action ?? 'unknown').replace(/[\t\r\n]+/g, ' '),
    String(object ?? '-').replace(/[\t\r\n]+/g, ' '),
    String(result ?? '-').replace(/[\t\r\n]+/g, ' '),
  ].join('\t');
  const file = auditPath(root);
  ensureDir(root, path.dirname(file));
  fs.appendFileSync(file, `${line}\n`, 'utf8');
  return { path: file, line };
}

/** Recursively list `.md` files under `subdir`; missing dir is an empty list. */
export function listMarkdownFiles(root, subdir) {
  const base = resolveInside(root, subdir);
  let stat = null;
  try {
    stat = fs.lstatSync(base);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw memoryError('E_LIST_FAILED', `读不到目录：${base}`, error);
  }
  if (stat.isSymbolicLink()) {
    throw memoryError('E_SYMLINK_REFUSED', `拒绝跟随符号链接：${base}`);
  }
  if (!stat.isDirectory()) return [];
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // never follow a link out of the store
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        found.push(abs);
      }
    }
  };
  walk(base);
  return found.sort((a, b) => a.localeCompare(b));
}
