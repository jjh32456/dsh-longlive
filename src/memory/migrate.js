// src/memory/migrate.js — 1.8.0 / v2.8 §16.6（A1 分片）：records.jsonl → claims.jsonl 迁移
//
// 规则（写死）：
//   * 旧记录 sourceTier 缺失 → host（v2.8 迁移口径）；subject 缺失 → {entity: record.id}；
//     evidence 空；state 缺失 → active；隐式 evidence=[]；legacy:true + audit.migratedFrom。
//   * 迁移不增不减：records 行数 === 迁移后 claims 行数（同一批旧数据）。
//   * 幂等：同 id 的 claim 已存在 → skip（重复 apply 条数不变）。
//   * 不物理删除：apply 前把 records.jsonl 备份到 `.longlive/backups/`（sha256 记录）。
//   * 默认 dry-run；--apply 才写。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { claimFromLegacyRecord, claimsPathOf, readClaimsForHost } from './governance.js';

export function migrateBackupPath(memoryRoot, now = () => new Date()) {
  const stamp = (now instanceof Date ? now : new Date()).toISOString().replace(/[:.]/g, '-');
  return path.join(path.resolve(String(memoryRoot)), '.longlive', 'backups', `records-${stamp}.jsonl.bak`);
}

function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Migrate legacy records.jsonl into claims.jsonl.
 * @param {object} options
 * @param {string} options.memoryRoot
 * @param {boolean} [options.apply] default false (dry-run)
 * @param {() => Date} [options.now]
 * @returns {object} receipt
 */
export function migrateRecordsToClaims({ memoryRoot, apply = false, now = () => new Date() } = {}) {
  const root = path.resolve(String(memoryRoot));
  const recordsFile = path.join(root, '.longlive', 'records.jsonl');
  const claimsFile = claimsPathOf(root);
  const receipt = {
    schema: 'migrate-records-v180/v1',
    memoryRoot: root,
    mode: apply ? 'apply' : 'dry-run',
    recordsFile,
    claimsFile,
    recordsPresent: false,
    recordsTotal: 0,
    mapped: 0,
    duplicates: 0,
    unmappable: [],
    skippedExisting: 0,
    appended: 0,
    recordsSha256: null,
    backup: null,
    beforeClaims: 0,
    afterClaims: 0,
    countMatched: false,
    code: null,
    exitCode: 0,
  };
  let text = '';
  try {
    text = fs.readFileSync(recordsFile, 'utf8');
    receipt.recordsPresent = true;
  } catch {
    text = '';
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      receipt.unmappable.push({ reason: 'E_JSON', line: line.slice(0, 120) });
    }
  }
  receipt.recordsTotal = rows.length;
  receipt.recordsSha256 = receipt.recordsPresent ? sha256Buf(Buffer.from(text, 'utf8')) : null;
  // §16.6 / P0-2：没有可迁移记录不是成功 no-op。空/缺 records 必须显式
  // E_NOTHING_TO_MIGRATE（CLI exit 2），countMatched 不得为 true（假绿）。
  if (!receipt.recordsPresent || receipt.recordsTotal === 0) {
    receipt.code = 'E_NOTHING_TO_MIGRATE';
    receipt.exitCode = 2;
    receipt.countMatched = false;
    return receipt;
  }
  const existing = readClaimsForHost({ memoryRoot: root }).items;
  const existingIds = new Set(existing.map((claim) => claim.id));
  receipt.beforeClaims = existing.length;
  const claims = [];
  const seen = new Set();
  for (const row of rows) {
    try {
      const claim = claimFromLegacyRecord(row);
      if (seen.has(claim.id)) {
        receipt.duplicates += 1;
        continue;
      }
      seen.add(claim.id);
      claims.push(claim);
      receipt.mapped += 1;
    } catch (error) {
      receipt.unmappable.push({ reason: error?.code ?? 'E_MAP', message: String(error?.message ?? error) });
    }
  }
  for (const claim of claims) {
    if (existingIds.has(claim.id)) receipt.skippedExisting += 1;
  }
  if (apply && receipt.recordsPresent) {
    fs.mkdirSync(path.dirname(migrateBackupPath(root, now())), { recursive: true });
    const backupFile = migrateBackupPath(root, now());
    // 备份 + 落盘都要 fsync（迁移期间崩溃不产生半行）。
    fs.copyFileSync(recordsFile, backupFile);
    try {
      const bfd = fs.openSync(backupFile, 'r');
      fs.fsyncSync(bfd);
      fs.closeSync(bfd);
    } catch { /* best effort */ }
    receipt.backup = { path: backupFile, sha256: receipt.recordsSha256 };
    fs.mkdirSync(path.dirname(claimsFile), { recursive: true });
    const fd = fs.openSync(claimsFile, 'a');
    try {
      for (const claim of claims) {
        if (existingIds.has(claim.id)) continue;
        fs.writeSync(fd, `${JSON.stringify(claim)}\n`, null, 'utf8');
        fs.fsyncSync(fd);
        existingIds.add(claim.id);
        receipt.appended += 1;
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  const after = readClaimsForHost({ memoryRoot: root }).items;
  receipt.afterClaims = after.length;
  // count consistency: every legacy record has exactly one claim (new ones or pre-existing)
  const legacyClaimIds = new Set(claims.map((claim) => claim.id));
  const presentLegacy = after.filter((claim) => legacyClaimIds.has(claim.id)).length;
  receipt.countMatched = presentLegacy === claims.length;
  return receipt;
}
