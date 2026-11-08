// B3 card writer: provenance + conflict detection + `conflict` markers.
//
// Every memory card that this package writes (today `memory_procedure`, later
// A1 write-back / identityCard) should go through here or the procedure writer,
// so one place decides:
//
//   * the three provenance extras (provenance.js);
//   * whether the new card disagrees with a card already on disk
//     (`detectConflicts`);
//   * how a disagreement is recorded (`conflict` on the new card,
//     `conflict_with` on the old one).
//
// An old card's prose is never replaced. Writing the marker on the old card
// only touches its frontmatter, preserves the body byte-for-byte, and keeps a
// backup first. A new card whose `rel` already exists is refused with
// `E_CARD_EXISTS` instead of silently overwriting it.
//
// Conflict taxonomy (deliberately narrow, so unrelated conclusions do not
// light up):
//
//   same-slug                same path as an existing card, different body
//   same-title               normalized title equals, normalized body differs
//   same-key-opposite        normalized `key` equals and the two bodies have
//                            opposite polarity (one negates / disables / fails,
//                            the other does not)
//
// A same-key pair that differs but has the same polarity is NOT a conflict:
// two positive alternatives ("蓝绿" vs "滚动") are a choice, not a
// contradiction. The marker therefore means "these two cannot both be acted
// on", which is exactly what a reader needs to resolve.

import fs from 'node:fs';
import path from 'node:path';

import {
  memoryError, memoryRootFromConfig, relativePath, resolveInside,
} from './paths.js';
import {
  DEFAULT_FIELDS, FIELD_ORDER, dayString, normalizedBody, parseFrontmatter, serializeFrontmatter,
  updateExtras,
} from './frontmatter.js';
import {
  backupFile, listMarkdownFiles, restoreBackup, sha256Text, writeFileAtomic,
} from './state.js';
import { sourceStamp, stampExtras, MANUAL_SESSION } from './provenance.js';
import { CARD_DIRS, manifestPath, refreshManifest } from './manifest.js';

const REL_PATTERN = /^(topics|journal|procedures)\/[^\r\n]+\.md$/i;
// The conflict marker is a single-line list. A comma or bracket inside a path
// would make the list unreadable, so such a card path is refused up front.
const UNSAFE_REL_CHARS = /[,\[\]\r\n]/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function singleLine(field, value) {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (text === '') throw memoryError('E_BAD_ARGUMENT', `${field} 不能为空`);
  if (text.length > 500) throw memoryError('E_BAD_ARGUMENT', `${field} 过长（>500 字符）`);
  return text;
}

function normalizeKey(value) {
  if (value === undefined || value === null) return null;
  const text = singleLine('key', value);
  return text.toLowerCase();
}

/**
 * Normalize a card path to POSIX-relative form and refuse anything that is not
 * a markdown card in topics/, journal/ or procedures/.
 */
export function normalizeCardRel(root, value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '') {
    throw memoryError('E_BAD_ARGUMENT', 'writeCard 需要 rel（如 topics/结论.md）');
  }
  const rel = path.isAbsolute(raw) ? relativePath(root, raw) : raw.replace(/\\/g, '/');
  if (UNSAFE_REL_CHARS.test(rel)) {
    throw memoryError('E_BAD_ARGUMENT', `卡片路径不能包含 , [ ] 或换行（冲突标记是行内列表）：${rel}`);
  }
  if (!REL_PATTERN.test(rel)) {
    throw memoryError(
      'E_BAD_ARGUMENT',
      `卡片路径必须位于 ${CARD_DIRS.join(' / ')} 之一且以 .md 结尾：${JSON.stringify(rel)}`,
    );
  }
  // resolveInside both validates containment and proves the real path stays in
  // the store (junction/symlink guard).
  resolveInside(root, rel);
  return rel;
}

function firstHeading(body) {
  const match = /^#\s+(.+)$/m.exec(String(body ?? ''));
  return match ? match[1].trim() : null;
}

/** Compare text without case, whitespace or punctuation noise. */
function comparisonText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[。！？!?，,；;：:、.．\-—_（）()【】\[\]「」『』“”"'’‘]/g, '');
}

const NEGATIVE_TERMS = Object.freeze([
  '不支持', '不允许', '不使用', '不采用', '不选', '不推荐', '不建议',
  '不要', '不能', '不可', '不需要', '不必', '不用', '不做',
  '不开启', '不启用', '不保留', '不删除', '没有', '无需', '禁止', '避免', '拒绝',
  '关闭', '禁用', '停用', '取消', '删除', '移除', '放弃', '失败',
  '未使用', '未采用', '未启用', '未通过',
]);
const EN_NEGATIVE = /\b(?:not|never|no|without|disable|disabled|forbid|forbidden|avoid|reject|remove|failed|failure|off)\b/i;

/** True when a conclusion negates or disables something. */
export function isNegativeConclusion(text) {
  const source = String(text ?? '');
  if (NEGATIVE_TERMS.some((term) => source.includes(term))) return true;
  return EN_NEGATIVE.test(source);
}

function oppositePolarity(left, right) {
  return isNegativeConclusion(left) !== isNegativeConclusion(right);
}

function readCardForConflict(root, abs) {
  const rel = relativePath(root, abs);
  const text = fs.readFileSync(abs, 'utf8');
  let parsed = null;
  let parseError = null;
  try {
    parsed = parseFrontmatter(text);
  } catch (error) {
    parseError = error?.code ?? 'E_CARD_PARSE';
  }
  const fallbackTitle = path.basename(abs, '.md');
  if (parsed === null || parsed.legacy) {
    return {
      abs,
      rel,
      text,
      title: firstHeading(text) ?? fallbackTitle,
      body: text,
      key: null,
      keyNorm: null,
      parseError,
    };
  }
  const key = typeof parsed.extras.key === 'string' ? parsed.extras.key : null;
  return {
    abs,
    rel,
    text,
    title: parsed.fields.title || parsed.extras.name || firstHeading(parsed.body) || fallbackTitle,
    body: parsed.body,
    key,
    keyNorm: key === null ? null : key.trim().toLowerCase(),
    parseError,
  };
}

/**
 * Find cards that disagree with `candidate`.
 *
 * `candidate` = `{rel, title, body, key}`. Returns one row per conflicting
 * card: `{rel, title, reasons, key}`. Same-key alternatives with the same
 * polarity are not reported (see the taxonomy at the top of the file).
 */
export function detectConflicts(root, candidate = {}) {
  if (!isPlainObject(candidate)) {
    throw memoryError('E_BAD_ARGUMENT', 'detectConflicts 需要 candidate 对象');
  }
  const rel = normalizeCardRel(root, candidate.rel);
  const titleNorm = comparisonText(candidate.title);
  const bodyNorm = comparisonText(candidate.body);
  const keyNorm = candidate.key === undefined || candidate.key === null
    ? null
    : normalizeKey(candidate.key);
  const found = [];
  for (const dir of CARD_DIRS) {
    for (const abs of listMarkdownFiles(root, dir)) {
      const existing = readCardForConflict(root, abs);
      const reasons = [];
      if (existing.rel === rel) {
        if (comparisonText(existing.body) !== bodyNorm) reasons.push('same-slug');
      } else {
        if (titleNorm !== '' && comparisonText(existing.title) === titleNorm
          && comparisonText(existing.body) !== bodyNorm) {
          reasons.push('same-title');
        }
        if (keyNorm !== null && existing.keyNorm === keyNorm
          && comparisonText(existing.body) !== bodyNorm
          && oppositePolarity(candidate.body, existing.body)) {
          reasons.push('same-key-opposite-conclusion');
        }
      }
      if (reasons.length > 0) {
        found.push({ rel: existing.rel, title: existing.title, reasons, key: existing.key });
      }
    }
  }
  found.sort((left, right) => (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0));
  return found;
}

function formatCardList(rels) {
  const unique = [...new Set(rels.filter((rel) => typeof rel === 'string' && rel.trim() !== ''))];
  return `[${unique.join(', ')}]`;
}

/**
 * Append `newRel` to an existing card's `conflict_with` list.
 *
 * Only the frontmatter changes; the prose body is compared before/after and
 * restored from the pre-write backup if it moved. Returns
 * `{rel, changed, backup?, backupRel?, sha256}`.
 */
export function appendConflictWith(root, oldRel, newRel, { now = new Date() } = {}) {
  const abs = resolveInside(root, oldRel);
  if (!fs.existsSync(abs)) {
    throw memoryError('E_CARD_NOT_FOUND', `冲突标记目标不存在：${oldRel}`);
  }
  const text = fs.readFileSync(abs, 'utf8');
  const before = parseFrontmatter(text);
  const existing = before.extras.conflict_with ?? '';
  const current = /^\[(.*)\]$/.test(existing.trim())
    ? existing.trim().slice(1, -1).split(',').map((part) => part.trim()).filter(Boolean)
    : (existing.trim() === '' ? [] : [existing.trim()]);
  if (current.includes(newRel)) {
    return { rel: oldRel, changed: false, sha256: sha256Text(text) };
  }
  const updated = updateExtras(text, { conflict_with: formatCardList([...current, newRel]) });
  const backup = backupFile(root, abs, { now });
  try {
    writeFileAtomic(root, abs, updated, { backup: false, now });
    const readBack = fs.readFileSync(abs, 'utf8');
    if (readBack !== updated) {
      throw memoryError('E_CARD_VERIFY', `冲突标记写后校验失败：${oldRel}`);
    }
    if (normalizedBody(parseFrontmatter(readBack).body) !== normalizedBody(before.body)) {
      throw memoryError('E_CARD_VERIFY', `冲突标记改动了旧卡正文：${oldRel}`);
    }
    return {
      rel: oldRel,
      changed: true,
      backup: backup.path,
      backupRel: backup.rel,
      sha256: sha256Text(readBack),
    };
  } catch (error) {
    try {
      restoreBackup(root, backup.path, abs);
    } catch (restoreError) {
      throw memoryError('E_ROLLBACK_FAILED', `冲突标记失败且无法回滚：${oldRel}`, restoreError);
    }
    throw error instanceof Error && error.code ? error : memoryError('E_CARD_VERIFY', `冲突标记失败：${oldRel}`, error);
  }
}

function normalizeFields(root, spec, title, now) {
  const fields = { ...DEFAULT_FIELDS, ...(isPlainObject(spec.fields) ? spec.fields : {}) };
  for (const key of Object.keys(spec.fields ?? {})) {
    if (!FIELD_ORDER.includes(key)) {
      throw memoryError('E_BAD_ARGUMENT', `fields 只接受标准字段 ${FIELD_ORDER.join(', ')}；${key} 请放进 extras`);
    }
  }
  fields.title = singleLine('title', title);
  fields.date = singleLine('date', spec.date ?? fields.date ?? dayString(now));
  fields.salience = fields.salience ?? DEFAULT_FIELDS.salience;
  fields.strength = fields.strength ?? DEFAULT_FIELDS.strength;
  fields.revisions = 0;
  if (fields.tags == null) fields.tags = [];
  if (fields.status == null) fields.status = DEFAULT_FIELDS.status;
  return fields;
}

function normalizeExtras(root, spec, stamp) {
  const extras = {};
  if (isPlainObject(spec.extras)) {
    for (const [key, value] of Object.entries(spec.extras)) {
      if (FIELD_ORDER.includes(key)) {
        throw memoryError('E_BAD_ARGUMENT', `extras 不能包含标准字段 ${key} — 请用 fields`);
      }
      if (value == null) continue;
      extras[key] = singleLine(`extras.${key}`, value);
    }
  }
  if (spec.key !== undefined && spec.key !== null) {
    extras.key = singleLine('key', spec.key);
  }
  return stampExtras(extras, stamp);
}

function buildCardText(fields, extras, body) {
  const block = serializeFrontmatter(fields, extras, '\n');
  const prose = String(body).replace(/\r\n?/g, '\n').replace(/[\r\n]+$/, '');
  return `${block}\n${prose === '' ? '' : `${prose}\n`}`;
}

/**
 * Write one new card.
 *
 * Usage:
 *   writeCard(root, {rel, title?, body, key?, fields?, extras?}, {now?})
 *   writeCard({memoryRoot, rel, ...})       // config-style, for tools
 *
 * The card gets `source_session` / `source_turn` / `written_at`; conflicts are
 * detected before the write, recorded on the new card, and mirrored onto each
 * old card's `conflict_with`. The old cards' prose is never replaced.
 */
export function writeCard(rootOrSpec, specOrOptions = {}, maybeOptions = {}) {
  let root;
  let spec;
  let options;
  if (typeof rootOrSpec === 'string') {
    root = path.resolve(rootOrSpec);
    spec = specOrOptions ?? {};
    options = maybeOptions ?? {};
  } else if (isPlainObject(rootOrSpec)) {
    spec = rootOrSpec;
    options = isPlainObject(specOrOptions) ? specOrOptions : {};
    root = memoryRootFromConfig({ ...options, memoryRoot: options.memoryRoot ?? spec.memoryRoot ?? spec.root });
  } else {
    throw memoryError('E_BAD_ARGUMENT', 'writeCard 需要 memoryRoot 字符串或一个 spec 对象');
  }
  if (!isPlainObject(spec)) throw memoryError('E_BAD_ARGUMENT', 'writeCard 的 spec 必须是普通对象');
  const now = options.now instanceof Date ? options.now : new Date();

  const rel = normalizeCardRel(root, spec.rel ?? spec.path);
  const abs = resolveInside(root, rel);
  if (fs.existsSync(abs)) {
    throw memoryError(
      'E_CARD_EXISTS',
      `卡片已存在：${rel} — B3 拒绝覆盖旧卡（旧卡一个字节都不会动）。` +
      '同一主题的新结论请用新的 rel；新旧冲突会自动写进 conflict / conflict_with 标记',
    );
  }

  const body = typeof spec.body === 'string' ? spec.body : '';
  if (body.trim() === '') throw memoryError('E_BAD_ARGUMENT', `writeCard 需要非空正文：${rel}`);
  const title = spec.title ?? (isPlainObject(spec.fields) ? spec.fields.title : null)
    ?? firstHeading(body) ?? path.basename(abs, '.md');
  const sessionId = spec.sessionId ?? spec.source?.sessionId ?? spec.session ?? null;
  const turn = spec.turn ?? spec.source?.turn ?? null;
  const stampInput = { sessionId, turn, at: now };
  const stamp = sourceStamp(stampInput);
  const candidateKey = spec.key ?? (isPlainObject(spec.extras) ? spec.extras.key : null) ?? null;

  const conflicts = detectConflicts(root, { rel, title, body, key: candidateKey });
  const conflictRels = conflicts.map((row) => row.rel);

  const fields = normalizeFields(root, spec, title, now);
  const extras = normalizeExtras(root, spec, stampInput);
  if (conflictRels.length > 0) {
    const explicit = typeof extras.conflict === 'string' && extras.conflict.trim().startsWith('[')
      ? extras.conflict.trim().slice(1, -1).split(',').map((part) => part.trim()).filter(Boolean)
      : [];
    extras.conflict = formatCardList([...explicit, ...conflictRels]);
  }

  const text = buildCardText(fields, extras, body);
  const written = writeFileAtomic(root, abs, text, { backup: false, now });
  const readBack = fs.readFileSync(abs, 'utf8');
  if (readBack !== text) {
    try { fs.unlinkSync(abs); } catch { /* the verify error is the one to report */ }
    throw memoryError('E_CARD_VERIFY', `新卡写后校验失败，已删除：${rel}`);
  }

  const marked = [];
  try {
    for (const conflict of conflicts) {
      marked.push(appendConflictWith(root, conflict.rel, rel, { now }));
    }
  } catch (error) {
    // All-or-nothing from the caller's point of view: remove the new card and
    // put back every old card whose marker was already written.
    for (const row of marked.reverse()) {
      if (!row.changed || !row.backup) continue;
      try {
        restoreBackup(root, row.backup, resolveInside(root, row.rel));
      } catch {
        /* best effort; the original error is the one to report */
      }
    }
    try { fs.unlinkSync(abs); } catch { /* best effort */ }
    throw error instanceof Error && error.code
      ? error
      : memoryError('E_CARD_VERIFY', `冲突标记失败，新卡已回滚：${rel}`, error);
  }

  let manifest = null;
  let manifestWarning = null;
  try {
    const refreshed = refreshManifest(root, { now });
    const cardCount = Array.isArray(refreshed.manifest?.cards) ? refreshed.manifest.cards.length : 0;
    manifest = {
      rel: relativePath(root, manifestPath(root)),
      cards: cardCount,
      sha256: refreshed.sha256,
    };
  } catch (error) {
    manifestWarning = error?.message ?? String(error);
  }

  return {
    ok: true,
    status: 'created',
    root,
    path: abs,
    rel,
    title: fields.title,
    sha256: written.sha256,
    bytes: written.bytes,
    source: { session: stamp.source_session, turn: stamp.source_turn, written_at: stamp.written_at },
    conflicts: conflicts.map((row) => ({ rel: row.rel, title: row.title, reasons: row.reasons })),
    conflictWith: marked.map((row) => row.rel),
    manifest,
    ...(manifestWarning === null ? {} : { manifestWarning }),
  };
}

/** The session label a direct human write gets when no host session exists. */
export const DIRECT_WRITE_SESSION = MANUAL_SESSION;
