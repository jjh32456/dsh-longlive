// Reinforce a card because it was really used.
//
// strength +1 (capped at 9), last_used = today, revisions +1, plus one
// `<!-- rev: ... -->` line. The prose body must not move by a byte, so after
// writing we parse the file again and compare the body with rev comments
// stripped; any mismatch restores the pre-write backup and throws.

import fs from 'node:fs';

import { memoryRootFromConfig, resolveInside, relativePath, memoryError } from './paths.js';
import {
  parseFrontmatter, updateFrontmatter, appendLine, dayString,
  normalizedBody, countRevLines,
} from './frontmatter.js';
import {
  appendAudit, backupFile, restoreBackup, writeFileAtomic,
} from './state.js';
import { manifestPath, refreshManifest } from './manifest.js';

export const MAX_STRENGTH = 9;

/** memory_reinforce: `path` is required; everything else has safe defaults. */
export function memoryReinforce(args = {}, config = {}) {
  const root = memoryRootFromConfig(config);
  const now = config.now instanceof Date ? config.now : new Date();
  const today = config.today ?? dayString(now);
  const target = typeof args.path === 'string' ? args.path.trim() : '';
  if (!target) {
    throw memoryError('E_BAD_ARGUMENT', 'memory_reinforce 需要 path（记忆卡路径，相对记忆根或根内绝对路径）');
  }
  const abs = resolveInside(root, target);
  let stat = null;
  try {
    stat = fs.lstatSync(abs);
  } catch (error) {
    throw memoryError('E_CARD_NOT_FOUND', `找不到记忆卡：${abs}`, error);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw memoryError('E_NOT_A_CARD', `不是普通文件，拒绝改写：${abs}`);
  }

  const original = fs.readFileSync(abs, 'utf8');
  const parsed = parseFrontmatter(original);
  const before = {
    strength: parsed.fields.strength,
    last_used: parsed.fields.last_used,
    revisions: parsed.fields.revisions,
    salience: parsed.fields.salience,
    legacy: parsed.legacy,
  };
  const next = {
    strength: Math.min(MAX_STRENGTH, parsed.fields.strength + 1),
    last_used: today,
    revisions: parsed.fields.revisions + 1,
  };
  const reason = typeof args.reason === 'string' && args.reason.trim()
    ? args.reason.trim().replace(/[\r\n]+/g, ' ').slice(0, 120)
    : '被真实使用';
  const revLine = `<!-- rev: ${today} ${reason} -->`;
  let updated = updateFrontmatter(original, next);
  updated = appendLine(updated, revLine);

  const backup = backupFile(root, abs, { now });
  const problems = [];
  try {
    writeFileAtomic(root, abs, updated, { backup: false, now });
    const readBack = fs.readFileSync(abs, 'utf8');
    const reparsed = parseFrontmatter(readBack);
    if (reparsed.fields.strength !== next.strength) {
      problems.push(`strength ${reparsed.fields.strength} != ${next.strength}`);
    }
    if (reparsed.fields.last_used !== today) {
      problems.push(`last_used ${reparsed.fields.last_used} != ${today}`);
    }
    if (reparsed.fields.revisions !== next.revisions) {
      problems.push(`revisions ${reparsed.fields.revisions} != ${next.revisions}`);
    }
    if (normalizedBody(parsed.body) !== normalizedBody(reparsed.body)) {
      problems.push('正文段被改动');
    }
    if (countRevLines(reparsed.body) !== countRevLines(parsed.body) + 1) {
      problems.push('rev 注释没有恰好追加一行');
    }
  } catch (error) {
    // The write, the read-back and the parse are one transaction: whichever
    // step throws, the original file comes back before the caller hears about
    // it. Previously the read-back/parse sat outside this guard, so a throwing
    // read left a half-verified card on disk.
    try {
      restoreBackup(root, backup.path, abs);
    } catch (restoreError) {
      throw memoryError('E_ROLLBACK_FAILED', `写后读回/解析失败且无法从备份恢复：${abs}`, restoreError);
    }
    throw memoryError(
      'E_REINFORCE_VERIFY',
      `写后读回/解析/校验失败，已回滚：${abs}${error instanceof Error && error.code ? `（${error.code}）` : ''}`,
      error,
    );
  }
  if (problems.length > 0) {
    try {
      restoreBackup(root, backup.path, abs);
    } catch (restoreError) {
      throw memoryError('E_ROLLBACK_FAILED', `写后校验失败且回滚失败：${abs}`, restoreError);
    }
    throw memoryError('E_REINFORCE_VERIFY', `写后校验失败，已回滚：${problems.join('；')}`);
  }

  appendAudit(root, {
    action: 'memory_reinforce',
    object: relativePath(root, abs),
    result: `strength=${next.strength} revisions=${next.revisions}`,
    now,
  });

  // B3: keep an opted-in manifest honest after a legitimate card edit. The
  // manifest is derived data, so a refresh failure must not fail the memory
  // write itself; verifyManifest will report the now-stale entry instead.
  let manifest = null;
  try {
    if (fs.existsSync(manifestPath(root))) manifest = refreshManifest(root, { now });
  } catch {
    manifest = null;
  }

  return {
    ok: true,
    status: 'reinforced',
    root,
    path: abs,
    rel: relativePath(root, abs),
    before,
    after: next,
    capped: parsed.fields.strength >= MAX_STRENGTH,
    bodyIdentical: true,
    revLine,
    backup: backup.path,
    backupRel: backup.rel,
    sha256: backup.sha256,
    manifest,
    message:
      `已加固 ${relativePath(root, abs)}：strength ${before.strength}→${next.strength}` +
      `${next.strength === MAX_STRENGTH ? '（到顶 9）' : ''}，last_used=${today}，revisions ${before.revisions}→${next.revisions}；正文逐字节一致，备份 ${backup.rel}`,
  };
}
