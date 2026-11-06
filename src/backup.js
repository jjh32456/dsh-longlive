// @local/dsh-longlive — backup
//
// A backup is a byte-for-byte copy next to the session log:
//   session.v4.jsonl.zstd  ->  session.v4.jsonl.zstd.bak-YYYYMMDD
// plus a sha256 recorded in backups.json (the ledger lives next to the log).
// Backups are never deleted by this plugin; the ledger only marks old ones
// as deletable.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

export function statOf(file) {
  const s = fs.statSync(file);
  return { size: s.size, mtimeMs: s.mtimeMs };
}

export function ledgerPath(sessionPath) {
  return path.join(path.dirname(sessionPath), 'backups.json');
}

export function readLedger(sessionPath) {
  const file = ledgerPath(sessionPath);
  if (!fs.existsSync(file)) return { version: 1, backups: [], truncations: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      version: parsed.version ?? 1,
      backups: Array.isArray(parsed.backups) ? parsed.backups : [],
      truncations: Array.isArray(parsed.truncations) ? parsed.truncations : [],
    };
  } catch {
    return { version: 1, backups: [], truncations: [] };
  }
}

export function writeLedger(sessionPath, ledger) {
  fs.writeFileSync(ledgerPath(sessionPath), JSON.stringify(ledger, null, 2) + '\n', 'utf8');
}

export function stamp(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** All backup files that belong to this session log, oldest first. */
export function listBackups(sessionPath) {
  const dir = path.dirname(sessionPath);
  const base = path.basename(sessionPath);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(`${base}.bak-`))
    .map((name) => {
      const file = path.join(dir, name);
      const s = fs.statSync(file);
      return { file, size: s.size, mtimeMs: s.mtimeMs };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/** Pick the backup path for today, never overwriting a different existing file. */
export function nextBackupPath(sessionPath, date = new Date(), expected = null) {
  const dir = path.dirname(sessionPath);
  const base = path.basename(sessionPath);
  const day = stamp(date);
  let candidate = path.join(dir, `${base}.bak-${day}`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    const s = fs.statSync(candidate);
    // Same day, same bytes: reuse it. Different bytes: never overwrite, add -n.
    // `expected` (the caller's snapshot) is compared instead of re-reading the
    // session log, so a log that moved on cannot make two different byte sets
    // look alike mid-run.
    const same = expected
      ? s.size === expected.size && sha256File(candidate) === expected.sha256
      : s.size === fs.statSync(sessionPath).size && sha256File(candidate) === sha256File(sessionPath);
    if (same) return candidate;
    candidate = path.join(dir, `${base}.bak-${day}-${n}`);
    n += 1;
  }
  return candidate;
}

/**
 * Make sure a backup whose sha256 equals the caller's snapshot exists.
 *
 * The copy is written from those exact bytes (`sourceBuf`), never from a second
 * read of the session log, and the sha256 recorded in the ledger is recomputed
 * from the file we just wrote. A concurrent append therefore cannot slip into a
 * backup that claims to represent the bytes the plan was built from.
 */
export function ensureBackup(sessionPath, { date = new Date(), sourceBuf = null, sha256: expectedSha = null, size = null } = {}) {
  const source = sourceBuf ?? fs.readFileSync(sessionPath);
  const bytes = size ?? source.length;
  if (source.length !== bytes) {
    const error = new Error(`snapshot size mismatch: buffer is ${source.length} bytes, the plan recorded ${bytes}`);
    error.code = 'SESSION_CHANGED';
    throw error;
  }
  const sourceSha = expectedSha ?? crypto.createHash('sha256').update(source).digest('hex');
  const ledger = readLedger(sessionPath);
  const known = listBackups(sessionPath).filter((b) => b.size === bytes);
  for (const b of known) {
    if (sha256File(b.file) === sourceSha) {
      return { created: false, file: b.file, sha256: sourceSha, size: bytes };
    }
  }
  const target = nextBackupPath(sessionPath, date, { sha256: sourceSha, size: bytes });
  // 'wx': an existing file is never clobbered, so two runs cannot share a name.
  fs.writeFileSync(target, source, { flag: 'wx' });
  const copied = sha256File(target);
  if (copied !== sourceSha) {
    try { fs.unlinkSync(target); } catch { /* best effort */ }
    const error = new Error(`backup verification failed: ${target} sha256 ${copied} != source ${sourceSha}`);
    error.code = 'BACKUP_SHA256_MISMATCH';
    throw error;
  }
  ledger.backups.push({
    file: target,
    sha256: copied,
    size: bytes,
    createdAt: new Date().toISOString(),
    deletable: ledger.backups.length + 1 > 7,
  });
  writeLedger(sessionPath, ledger);
  return { created: true, file: target, sha256: copied, size: bytes };
}

/** Verify that the given backup file still matches the recorded sha256. */
export function verifyBackup(file, expectedSha256) {
  if (!fs.existsSync(file)) return { ok: false, reason: 'backup file does not exist' };
  const actual = sha256File(file);
  if (expectedSha256 && actual !== expectedSha256) {
    return { ok: false, reason: `sha256 mismatch: ${actual} != ${expectedSha256}`, sha256: actual };
  }
  return { ok: true, sha256: actual };
}
