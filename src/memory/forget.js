// Forgetting, with tombstones and no deletes.
//
// Proposals come from two decay rules (SPEC §3). Both compare strictly
// (`ageDays > N`), so exactly 90 or exactly 365 days does not trigger them:
//   - last_used older than 90 days AND strength <= 2 -> demote to epochs/
//   - last_used older than 365 days                  -> tombstone
// Cards with salience >= 5 are core memory and never enter the proposal list.
//
// Default is dry-run: nothing is written at all — no file, no directory, no
// audit line. The three paths an executed run needs (`epochs/`,
// `archive/tombstones/`, `.longlive/backups/`) are only *reported* by a
// dry-run and created by a confirmed run.
//
// Execution requires `confirm: "FORGET"`. Each card is backed up
// (`.longlive/backups/`, sha256-verified) BEFORE it moves; tombstones.md is
// rewritten atomically, one three-question epitaph per card (reason / affects /
// stillUseful), BEFORE that card moves; the move is rename — never unlink/rm.
// One audit line records the run.

import fs from 'node:fs';
import path from 'node:path';

import { appendAuditRecord, resolveAuditKey } from './audit-records.js';
import { isProtectedPath } from './retention.js';
import { memoryRootFromConfig, resolveInside, relativePath, memoryError } from './paths.js';
import {
  dayString, daysBetween, isoStamp, isDayString,
} from './frontmatter.js';
import {
  appendAudit, archiveDir, auditPath, backupFile, backupInto, backupsDir, epochsDir,
  ensureDir, readState, stampToken, tombstonesPath, updateState, writeFileAtomic,
} from './state.js';
import { scanCards } from './index.js';
import { manifestPath, refreshManifest } from './manifest.js';

export const CONFIRM_WORD = 'FORGET';

/**
 * SPEC §3 decay rules, exposed so a caller (and the tests) can see the exact
 * thresholds instead of trusting the prose. `strict: true` means the comparison
 * is `ageDays > minAgeDays`, not `>=`.
 */
export const DECAY_RULES = Object.freeze({
  epochs: Object.freeze({ minAgeDays: 90, maxStrength: 2, strict: true }),
  tombstone: Object.freeze({ minAgeDays: 365, strict: true }),
  immuneSalience: 5,
});

/**
 * The three paths an executed run needs. A dry-run reads them (existsSync
 * only) and never creates them; only a confirmed run calls createScaffold.
 * `audit.log` itself is created by appendAudit at the end of a run — creating
 * it up front would make a failed run look audited.
 */
const SCAFFOLD = Object.freeze([
  Object.freeze({ key: 'epochs', kind: 'dir', resolve: epochsDir }),
  Object.freeze({ key: 'archive', kind: 'dir', resolve: archiveDir }),
  Object.freeze({ key: 'backups', kind: 'dir', resolve: backupsDir }),
  Object.freeze({ key: 'audit', kind: 'file', resolve: auditPath }),
]);

/** Read-only scaffold check: no mkdir, no write, no touch. */
export function forgetScaffold(root) {
  const entries = SCAFFOLD.map((entry) => {
    const abs = entry.resolve(root);
    return {
      key: entry.key,
      kind: entry.kind,
      rel: relativePath(root, abs),
      path: abs,
      exists: fs.existsSync(abs),
    };
  });
  const missing = entries.filter((entry) => !entry.exists).map((entry) => entry.key);
  return { entries, missing, ready: missing.length === 0 };
}

/** Create only the directories an executed run needs; audit.log comes last. */
function createScaffold(root) {
  const created = [];
  for (const entry of SCAFFOLD) {
    if (entry.kind !== 'dir') continue;
    const abs = entry.resolve(root);
    if (fs.existsSync(abs)) continue;
    ensureDir(root, abs);
    created.push(entry.key);
  }
  return created;
}

function uniqueDest(dest, now) {
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(dest);
  const base = dest.slice(0, dest.length - ext.length);
  let candidate = `${base}.${stampToken(now)}${ext}`;
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = `${base}.${stampToken(now)}-${index}${ext}`;
    index += 1;
  }
  return candidate;
}

function countTombstoneLines(file) {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('- ')).length;
}

function cardTags(card) {
  const raw = card.fields.tags;
  if (!Array.isArray(raw)) return [];
  return raw.map((tag) => String(tag).trim()).filter(Boolean);
}

/**
 * Extend a proposal with the destination and the three-question epitaph
 * (reason: why it closes / affects: who or what it touches / stillUseful: can
 * it still be recovered). Read-only: uniqueDest only stats paths.
 */
function planProposal(card, proposal, root, now) {
  const destDir = proposal.kind === 'tombstone' ? archiveDir(root) : epochsDir(root);
  const dest = uniqueDest(resolveInside(root, path.join(destDir, proposal.path)), now);
  const destRel = relativePath(root, dest);
  const tags = cardTags(card);
  return {
    ...proposal,
    destRel,
    epitaph: {
      reason: proposal.reason,
      affects: tags.length ? `tags: ${tags.join(', ')}` : '未标注 tags（影响面未知）',
      stillUseful: `可考古：从 ${destRel} 移回即可恢复`,
    },
  };
}

function renderTombstones(existingText, lines) {
  const block = lines.map((line) => `${line}\n`).join('');
  const head = existingText == null || existingText.trim() === ''
    ? '# Tombstones\n\n'
    : `${existingText.replace(/\s+$/, '')}\n`;
  return `${head}${block}`;
}

function tombstoneLine(now, item, backupRel) {
  const stillUseful = backupRel
    ? `${item.epitaph.stillUseful}；备份 ${backupRel}`
    : `${item.epitaph.stillUseful}；执行时先备份到 .longlive/backups/`;
  return `- ${isoStamp(now)} | ${item.path} | ${item.kind} | reason: ${item.epitaph.reason}` +
    ` | affects: ${item.epitaph.affects} | stillUseful: ${stillUseful} | recoverable: ${item.destRel}`;
}

function proposalFor(card, todayDay) {
  // A locked card is a core card: read-only memory. It is immune to decay
  // regardless of salience/strength/age, so a typo in one field can never move it.
  if ((card.fields.status ?? 'active') === 'locked') {
    return {
      skipped: true,
      reason: 'status=locked 核心卡，免疫衰减与遗忘（locked core card）',
    };
  }
  if (card.fields.salience >= DECAY_RULES.immuneSalience) {
    return {
      skipped: true,
      reason: `salience=${card.fields.salience} 核心记忆，自动免疫`,
    };
  }
  if (!isDayString(card.fields.last_used)) {
    return { skipped: true, reason: '没有可用的 last_used，无法按衰减规则判断' };
  }
  const ageDays = daysBetween(card.fields.last_used, todayDay);
  if (ageDays == null) {
    return { skipped: true, reason: `last_used 无法解析：${card.fields.last_used}` };
  }
  if (ageDays > DECAY_RULES.tombstone.minAgeDays) {
    return {
      skipped: false,
      kind: 'tombstone',
      ageDays,
      reason: `last_used=${card.fields.last_used} 已 ${ageDays} 天（>${DECAY_RULES.tombstone.minAgeDays}）→ 立碑`,
    };
  }
  if (ageDays > DECAY_RULES.epochs.minAgeDays && card.fields.strength <= DECAY_RULES.epochs.maxStrength) {
    return {
      skipped: false,
      kind: 'epochs',
      ageDays,
      reason: `last_used=${card.fields.last_used} 已 ${ageDays} 天（>${DECAY_RULES.epochs.minAgeDays}）且 strength=${card.fields.strength}<=${DECAY_RULES.epochs.maxStrength} → 降级到 epochs/`,
    };
  }
  return { skipped: false, kind: null };
}

function readProtectedEntries(root) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, '.longlive', 'protected.json'), 'utf8'));
    return Array.isArray(value?.entries) ? value.entries.filter((entry) => entry && typeof entry.id === 'string') : [];
  } catch {
    return [];
  }
}

function protectedHit(root, rel) {
  const normalized = String(rel).replace(/\\/g, '/');
  return readProtectedEntries(root).find((entry) => String(entry.id).replace(/\\/g, '/') === normalized) ?? null;
}

/**
 * memory_forget: dry-run unless `confirm === "FORGET"`. On execution each card
 * is backed up first, its tombstone line is rewritten before its move, then it
 * is moved (never deleted).
 */
export function memoryForget(args = {}, config = {}) {
  const root = memoryRootFromConfig(config);
  const now = config.now instanceof Date ? config.now : new Date();
  const today = config.today ?? dayString(now);
  const execute = args.confirm === CONFIRM_WORD;
  if (args.confirm !== undefined && !execute) {
    throw memoryError(
      'E_CONFIRM_REQUIRED',
      `执行遗忘需要 confirm:"${CONFIRM_WORD}"，收到 ${JSON.stringify(args.confirm)} — 未执行任何操作`,
    );
  }
  // F1 (red-team P0): execution is host-key gated. Dry-run stays read-only and
  // does not need a key; an actual move must not happen without an unlock key.
  if (execute) {
    const key = resolveAuditKey(root);
    if (key.key === null) {
      try {
        appendAuditRecord({
          memoryRoot: root,
          action: 'forget-denied',
          recordId: null,
          readerTier: 'host',
          questionId: 'unknown',
          expectedTurns: null,
          answerText: null,
          at: now.toISOString(),
          extra: { code: 'E_NO_KEY', hmacResidual: 'hostkey-unavailable' },
        });
      } catch { /* denial audit best effort; fail closed below */ }
      throw memoryError('E_NO_KEY', '遗忘执行需要宿主 auditKey（env 或 .longlive/.hostkey）；未提供 key，fail-closed');
    }
  }

  const cards = scanCards(root);
  const proposals = [];
  const immune = [];
  const undated = [];
  for (const card of cards) {
    const verdict = proposalFor(card, today);
    if (verdict.skipped) {
      const locked = (card.fields.status ?? 'active') === 'locked';
      if (locked || card.fields.salience >= DECAY_RULES.immuneSalience) {
        immune.push({ path: card.rel, status: card.fields.status ?? 'active', reason: verdict.reason });
      } else {
        undated.push({ path: card.rel, reason: verdict.reason });
      }
      continue;
    }
    if (!verdict.kind) continue;
    proposals.push({
      path: card.rel,
      kind: verdict.kind,
      ageDays: verdict.ageDays,
      reason: verdict.reason,
      salience: card.fields.salience,
      strength: card.fields.strength,
      last_used: card.fields.last_used,
    });
  }
  proposals.sort((left, right) => (right.ageDays - left.ageDays) || left.path.localeCompare(right.path));

  const scaffold = forgetScaffold(root);
  const auditRel = relativePath(root, auditPath(root));

  if (!execute) {
    const planned = proposals.map((proposal) => {
      const card = cards.find((entry) => entry.rel === proposal.path);
      return planProposal(card, proposal, root, now);
    });
    return {
      ok: true,
      status: 'dry-run',
      dryRun: true,
      applied: false,
      root,
      today,
      scanned: cards.length,
      proposals: planned,
      immune,
      undated,
      rules: DECAY_RULES,
      scaffold,
      audit: { file: auditRel, appended: 0, willAppend: 1 },
      message:
        `dry-run：${cards.length} 张卡 → ${proposals.length} 个遗忘提案（立碑 ${proposals.filter((item) => item.kind === 'tombstone').length}，降级 ${proposals.filter((item) => item.kind === 'epochs').length}），` +
        `${immune.length} 张核心记忆免疫；脚手架${scaffold.missing.length ? `缺 ${scaffold.missing.join('/')}` : '齐全'}，未写任何文件（不建目录、不写 audit），执行需 confirm:"${CONFIRM_WORD}"`,
    };
  }

  if (proposals.length === 0) {
    return {
      ok: true,
      status: 'noop',
      dryRun: false,
      applied: false,
      root,
      today,
      scanned: cards.length,
      proposals: [],
      immune,
      undated,
      moved: 0,
      scaffold,
      audit: { file: auditRel, appended: 0, willAppend: 0 },
      message: `没有可执行的遗忘提案（${cards.length} 张卡，${immune.length} 张免疫）；未写任何文件，也未创建任何目录`,
    };
  }

  const planned = proposals.map((proposal) => {
    const card = cards.find((entry) => entry.rel === proposal.path);
    return planProposal(card, proposal, root, now);
  });
  // GOV-07: protected entries are never forgotten by the tool path; refusal is audited
  // in .longlive/audit/records.jsonl (single source of truth) BEFORE any scaffold write.
  for (const item of planned) {
    // A6: protected manifest + retention layering; frames/L0 are never forgettable here.
    if (!isProtectedPath({ memoryRoot: root, relPath: item.path })) continue;
    try {
      const auditDir = path.join(root, '.longlive', 'audit');
      fs.mkdirSync(auditDir, { recursive: true });
      const row = { schema: 'audit-records/v1', questionId: 'unknown', expectedTurns: null, answerText: null, recordId: item.path, readerTier: 'host', action: 'denied', at: now.toISOString(), code: 'E_PROTECTED', protectedId: item.path };
      fs.appendFileSync(path.join(auditDir, 'records.jsonl'), `${JSON.stringify(row)}\n`, 'utf8');
      appendAuditRecord({ memoryRoot: root, action: 'denied', recordId: item.path, readerTier: 'host', questionId: 'unknown', expectedTurns: null, answerText: null, extra: { code: 'E_PROTECTED', protectedId: hit.id } });
    } catch {
      /* audit write failure must not downgrade the protected refusal */
    }
    throw memoryError('E_PROTECTED', `卡片在保护名单中，memory_forget 拒绝移动/删除：${item.path}（如需处理请经面板/人判入口）`);
  }
  const created = createScaffold(root);

  const tombFile = tombstonesPath(root);
  let existingText = fs.existsSync(tombFile) ? fs.readFileSync(tombFile, 'utf8') : null;
  let tombstoneBackupRel = null;
  if (existingText != null) tombstoneBackupRel = backupFile(root, tombFile, { now }).rel;

  const moved = [];
  for (const item of planned) {
    const source = resolveInside(root, item.path);
    if (!fs.existsSync(source)) {
      throw memoryError('E_CARD_NOT_FOUND', `提案里的卡已不存在：${item.path}（已移动 ${moved.length} 张，先核对）`);
    }

    const dest = resolveInside(root, item.destRel);
    ensureDir(root, path.dirname(dest));

    // 1. Back up the card before anything moves (verified copy, never a delete).
    const backup = backupInto(root, source, backupsDir(root), { now });

    // 2. Rewrite tombstones.md with this card's three-question epitaph, still
    //    before the move, so a crash cannot leave an unrecorded disappearance.
    existingText = renderTombstones(existingText, [tombstoneLine(now, item, backup.rel)]);
    writeFileAtomic(root, tombFile, existingText, { backup: false, now });

    // 3. Move (rename) — never unlink/rm.
    try {
      fs.renameSync(source, dest);
    } catch (error) {
      throw memoryError(
        'E_FORGET_MOVE',
        `墓碑已写但移动失败：${item.path} → ${item.destRel}（已移动 ${moved.length} 张，先核对 tombstones.md）`,
        error,
      );
    }
    if (fs.existsSync(source) || !fs.existsSync(dest)) {
      throw memoryError('E_FORGET_MOVE', `移动后校验失败：${item.path} → ${item.destRel}`);
    }
    moved.push({
      ...item,
      archived: item.destRel,
      backup: backup.rel,
      backupRel: backup.rel,
      sha256: backup.sha256,
    });
  }

  // A6: executed retention moves leave one unified audit row each (write/archive).
  for (const item of moved) {
    try {
      appendAuditRecord({
        memoryRoot: root,
        action: 'archive',
        recordId: item.path,
        readerTier: 'host',
        questionId: 'unknown',
        expectedTurns: null,
        answerText: null,
        at: now.toISOString(),
        extra: { layer: 'L2', archived: item.archived, backup: item.backupRel, sha256: item.sha256, tombstone: true },
      });
    } catch {
      /* audit is best effort; executed move already recorded in audit.log */
    }
  }
  const tombstoneLines = countTombstoneLines(tombFile);
  appendAudit(root, {
    action: 'memory_forget',
    object: moved.map((item) => item.path).join(', ').slice(0, 400),
    result: `moved=${moved.length} tombstones=${tombstoneLines} backups=${moved.length} confirm=${CONFIRM_WORD}`,
    now,
  });
  const state = readState(root);
  const forgetRuns = [...state.forgetRuns, {
    at: now.toISOString(),
    moved: moved.length,
    archived: moved.map((item) => item.archived),
    backups: moved.map((item) => item.backupRel),
  }].slice(-50);
  updateState(root, { forgetRuns }, { now });

  // B3: forget moves cards out of the indexed directories, so an opted-in
  // manifest must drop them. A refresh failure never fails the forget run its
  // cards already moved; verifyManifest will report the stale row.
  let manifest = null;
  try {
    if (fs.existsSync(manifestPath(root))) manifest = refreshManifest(root, { now });
  } catch {
    manifest = null;
  }

  return {
    ok: true,
    status: 'applied',
    dryRun: false,
    applied: true,
    root,
    today,
    scanned: cards.length,
    proposals: planned,
    immune,
    undated,
    rules: DECAY_RULES,
    moved: moved.length,
    archived: moved,
    tombstones: tombFile,
    tombstoneBackup: tombstoneBackupRel,
    tombstoneLines,
    scaffold: { ...forgetScaffold(root), created },
    audit: { file: auditRel, appended: 1, willAppend: 0 },
    manifest,
    message:
      `已执行：移动 ${moved.length} 张卡（立碑 ${moved.filter((item) => item.kind === 'tombstone').length}，降级 ${moved.filter((item) => item.kind === 'epochs').length}），` +
      `每卡先备份（${moved.length} 份），墓碑共 ${tombstoneLines} 行（三问齐全），audit 记 1 行，脚手架 ${created.join('/') || '已存在'}；未删除任何文件`,
  };
}
