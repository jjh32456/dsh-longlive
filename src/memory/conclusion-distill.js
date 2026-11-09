// conclusion-distill.js — A1 候选 → 蒸馏 → 主题卡（1.8.1）。
//
// 只有通过 distill.js 的纯抽取/L2/零新事实校验的候选才允许进入 topics/。
// 锚点必须用当前 L0 parseSession 重算 turnDigest 校验；验不过只写 draft:id。
// 所有失败只审计，不抛给 maintenance。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { appendAudit } from './state.js';
import { parseSession } from '../codec.js';
import { migrateLegacyA1, preflightA1Legacy } from './a1-migration.js';
import { memoryIndex } from './index.js';
import { extractTurns, discoverSessionLogs } from './event-index.js';
import { turnDigest } from './anchors.js';
import { buildDistillRecord } from './distill.js';
import { normalizeForMatch } from './l2-gate.js';
import { privacyScan } from '../recall/privacy.mjs';
import { serializeFrontmatter, dayString } from './frontmatter.js';
import {
  archiveExpiredDrafts, listDrafts, readDrafts, transitionDraft, DRAFT_DEFAULT_TTL_DAYS,
} from './conclusion-drafts.js';

export const DISTILL_CARD_TAG = 'auto-conclusion';
export const DISTILL_SECONDARY_TAG = 'distilled';
export const DISTILL_BULLET_LIMIT = 20;
export const DISTILL_RESULT_SCHEMA = 'conclusion-distill/v1';
// Staging lives under .longlive/ so both 1.8.0 and 1.8.1 scanCards (which only
// walk topics/journal/procedures and skip dot-directories) can never read it.
export const STAGING_REL = path.join('.longlive', 'staging', 'auto-cards');

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function normalize(value) {
  return String(value ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function slugOf(value) {
  const base = String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base === '' ? `draft-${sha256(value).slice(0, 8)}` : base;
}

function defaultSessionsRoot() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? path.resolve(process.env.DSH_HOME.trim())
    : path.join(os.homedir(), '.dsh');
  return path.join(home, 'sessions');
}

function audit(root, action, object, result, extra = {}) {
  try {
    appendAudit(root, {
      action,
      object,
      result,
      now: extra.now instanceof Date ? extra.now : new Date(),
    });
  } catch { /* audit is best-effort, never blocks distillation */ }
}

function userTextsInTurn(parsed, seqStart, seqEnd) {
  const out = [];
  for (const event of parsed.events) {
    if (!(event.seq >= seqStart && event.seq <= seqEnd)) continue;
    if (event.type !== 'user/message') continue;
    const data = event.data ?? {};
    if (data.source?.kind !== 'user') continue;
    const blocks = Array.isArray(data.content) ? data.content : [];
    for (const block of blocks) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') out.push(block.text);
    }
  }
  return out;
}

/** Find a real L0 turn and recompute its digest. Returns null when unverifiable. */
const l0Cache = new Map();
export function verifyDraftAnchor(draft, { sessionsRoot = defaultSessionsRoot() } = {}) {
  try {
    const key = `${path.resolve(sessionsRoot)}|${draft.sessionId}`;
    let cached = l0Cache.get(key);
    if (cached === undefined) {
      const logs = discoverSessionLogs([sessionsRoot]);
      const log = logs.find((item) => item.sessionId === draft.sessionId);
      if (!log) { l0Cache.set(key, null); return null; }
      const parsed = parseSession(fs.readFileSync(log.file));
      const turns = extractTurns(parsed.header, parsed.events, parsed.frames, parsed.texts);
      cached = { parsed, turns, file: log.file };
      l0Cache.set(key, cached);
    }
    if (cached === null) return null;
    const turn = cached.turns.find((row) => row.turn === draft.turn);
    if (!turn) return null;
    const digest = turnDigest(cached.parsed.events, turn.seqStart, turn.seqEnd);
    if (typeof digest !== 'string' || digest === '') return null;
    // P0-1 v3: bind the *full* user text, not just the excerpt. The draft must
    // carry userText + its hash; one L0 user message in this turn must match it
    // exactly after normalization, and title/excerpt/text must be substrings of
    // that user text. This rejects a real excerpt paired with a forged title/body.
    const userText = String(draft.userText ?? '').trim();
    if (userText === '' || draft.userTextHash !== sha256(userText)) return null;
    const normalizedUser = normalizeForMatch(userText);
    if (normalizedUser === '') return null;
    const userTexts = userTextsInTurn(cached.parsed, turn.seqStart, turn.seqEnd);
    const exact = userTexts.find((text) => normalizeForMatch(text) === normalizedUser);
    if (!exact) return null;
    for (const field of ['title', 'excerpt', 'text']) {
      let value = normalizeForMatch(draft[field] ?? '');
      if (field === 'text') value = value.replace(/^用户/u, '');
      if (value !== '' && !normalizedUser.includes(value)) return null;
    }
    return {
      kind: 'session_turn',
      sessionId: draft.sessionId,
      turn: draft.turn,
      seqStart: turn.seqStart,
      seqEnd: turn.seqEnd,
      digest,
      userText,
      file: cached.file,
    };
  } catch {
    return null;
  }
}

function bulletFor(draft, anchor, distilled) {
  const parts = [`- 自动回流（已蒸馏）[draft:${draft.id}]`];
  if (anchor) parts.push(`[session_turn: ${anchor.sessionId}#${anchor.turn} @${anchor.digest.slice(0, 16)}]`);
  parts.push(`：${String(distilled.gist ?? draft.excerpt).replace(/[\r\n]+/g, ' ').slice(0, 300)}`);
  return parts.join(' ');
}

function findMatchingCard(root, draft) {
  // v4 staging only. Staging is under .longlive/ so 1.8.0/1.8.1 scans cannot
  // reach it; promotion to topics/ is explicitly out of this job.
  const slug = slugOf(draft.title || draft.excerpt);
  const rel = path.join(STAGING_REL, `${slug}.md`);
  const abs = path.join(root, rel);
  return fs.existsSync(abs) ? { abs, rel } : null;
}

function alreadyHasDraft(text, draftId) {
  return String(text).includes(`[draft:${draftId}]`);
}

function appendBullet(file, bullet, draft) {  const text = fs.readFileSync(file, 'utf8');
  if (alreadyHasDraft(text, draft.id)) return { written: false, duplicate: true, reason: 'already-in-card' };
  const count = (text.match(/自动回流（已蒸馏）/g) ?? []).length;
  if (count >= DISTILL_BULLET_LIMIT) return { written: false, reason: 'card-full' };
  const next = `${text.replace(/\s*$/, '')}\n${bullet}\n`;
  fs.writeFileSync(file, next, 'utf8');
  return { written: true, duplicate: false };
}

function createOrAppendCard(root, draft, distill, anchor) {
  const existing = findMatchingCard(root, draft);
  if (existing) {
    const result = appendBullet(existing.abs, bulletFor(draft, anchor, distill), draft);
    return { ...result, card: existing.rel, matched: true };
  }
  const slug = slugOf(draft.title || draft.excerpt);
  const rel = path.join(STAGING_REL, `${slug}.md`);
  const abs = path.join(root, rel);
  if (fs.existsSync(abs)) {
    const result = appendBullet(abs, bulletFor(draft, anchor, distill), draft);
    return { ...result, card: rel, matched: true };
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const at = new Date();
  const fields = {
    title: `自动回流：${String(draft.title || draft.excerpt).slice(0, 80)}`,
    date: dayString(at),
    tags: [DISTILL_CARD_TAG, DISTILL_SECONDARY_TAG, 'staged'],
    salience: 2,
    strength: 3,
  };
  const extras = {
    source_draft: draft.id,
    auto_conclusion: true,
    distilled_at: at.toISOString(),
  };
  const body = `# ${fields.title}\n\n${bulletFor(draft, anchor, distill)}\n`;
  fs.writeFileSync(abs, `${serializeFrontmatter(fields, extras)}\n\n${body}`, 'utf8');
  return { written: true, duplicate: false, card: rel.replace(/\\/g, '/'), matched: false };
}

/**
 * One-time migration for rc.2/rc.3 trees: move legacy `topics/auto/*.md` into
 * `.longlive/staging/auto-cards/`, so a later downgrade to 1.8.0 cannot recurse
 * them into scanCards. Runs under the same memoryRoot, never deletes content.
 */
export function migrateLegacyAutoCards(root) {
  return migrateLegacyA1({ memoryRoot: root, dryRun: false });
}

/**
 * One maintenance job: expire TTL drafts, then distill all pending drafts.
 * Every per-draft failure is audited and converted into status=rejected; the
 * job itself returns a summary and never throws for draft-level errors.
 */
export function runConclusionDistillJob({
  memoryRoot, config = {}, now = new Date(), sessionsRoot = defaultSessionsRoot(),
} = {}) {
  const root = String(memoryRoot ?? '');
  if (root === '') return { ok: false, code: 'E_MEMORY_ROOT', processed: 0 };
  const draftCfg = config.conclusionDraft && typeof config.conclusionDraft === 'object' ? config.conclusionDraft : {};
  const distillCfg = config.conclusionDistill && typeof config.conclusionDistill === 'object' ? config.conclusionDistill : {};
  const ttlDays = Number.isFinite(Number(draftCfg.ttlDays)) && Number(draftCfg.ttlDays) > 0
    ? Number(draftCfg.ttlDays) : DRAFT_DEFAULT_TTL_DAYS;
  const summary = {
    ok: true, schema: DISTILL_RESULT_SCHEMA, ttlDays,
    archived: 0, processed: 0, distilled: 0, rejected: 0, skipped: 0, errors: [],
  };
  try {
    const preflight = preflightA1Legacy(root);
    summary.legacyPreflight = preflight;
    const migration = migrateLegacyAutoCards(root);
    summary.migrated = migration.moved ?? 0;
    summary.recovered = migration.recovered ?? 0;
    summary.totalLegacy = migration.totalLegacy ?? 0;
    summary.migrationReceipt = migration.receiptPath ?? null;
    if ((migration.moved ?? 0) > 0 || (migration.recovered ?? 0) > 0) {
      // A migration that leaves the old INDEX rows behind is not complete.
      // Rebuild the derived view in the same maintenance run.
      const idx = memoryIndex({ apply: true }, { memoryRoot: root, now });
      summary.indexRebuilt = idx.applied === true;
      summary.indexCards = idx.cards;
    }
  } catch (error) {
    summary.migrationError = String(error?.code ?? error?.message ?? error);
  }
  // TTL/forgetting is an independent lifecycle layer: it runs even when
  // distillation is disabled. Only the pending->card path is gated below.
  try {
    const expired = archiveExpiredDrafts(root, { ttlDays, now });
    summary.archived = expired.archived;
  } catch (error) {
    summary.errors.push({ stage: 'expire', code: String(error?.code ?? error), message: String(error?.message ?? error) });
    audit(root, 'conclusion_distill_expire', null, 'error', { now });
  }
  if (distillCfg.enabled === false) {
    return { ...summary, enabled: false, reason: 'distillation-disabled' };
  }
  summary.enabled = true;
  const read = readDrafts(root);
  if (read.corrupt) {
    summary.ok = false;
    summary.errors.push({ stage: 'read', code: 'E_DRAFT_CORRUPT', errors: read.errors });
    audit(root, 'conclusion_distill_read', null, 'corrupt', { now });
    return summary;
  }
  for (const draft of listDrafts(root, { status: 'pending' })) {
    summary.processed += 1;
    try {
      if (draft.sourceRole !== 'user') {
        throw Object.assign(new Error('E_DRAFT_NOT_USER'), { code: 'E_DRAFT_NOT_USER' });
      }
      if (draft.privacyVerdict === 'local_only') {
        throw Object.assign(new Error('E_DRAFT_PRIVACY'), { code: 'E_DRAFT_PRIVACY' });
      }
      let privacy;
      try {
        privacy = privacyScan(draft.text);
      } catch {
        throw Object.assign(new Error('E_DRAFT_PRIVACY'), { code: 'E_DRAFT_PRIVACY' });
      }
      if (!privacy || privacy.verdict === 'local_only') {
        throw Object.assign(new Error('E_DRAFT_PRIVACY'), { code: 'E_DRAFT_PRIVACY' });
      }
      // Hard v2 gate: a user decision must be anchored to the actual L0 user
      // turn; an unverifiable draft is rejected before any card is written.
      const anchor = verifyDraftAnchor(draft, { sessionsRoot });
      if (!anchor) {
        throw Object.assign(new Error('E_DRAFT_ANCHOR_UNVERIFIABLE'), { code: 'E_DRAFT_ANCHOR_UNVERIFIABLE' });
      }
      const distilled = buildDistillRecord({
        topic: slugOf(draft.title || draft.excerpt),
        period: String(draft.at ?? now.toISOString()).slice(0, 10),
        sources: [{
          id: draft.id,
          text: draft.text,
          summary: draft.excerpt,
          sessionId: draft.sessionId,
          turn: draft.turn,
          sourceKind: 'conclusion_draft_user',
        }],
        grade: 'L2',
        trigger: 'conclusion-draft-user',
        reason: 'A1 v2 user decision distillation',
        requiredFields: draft.kind === 'decision'
          ? { decision: ['改成', '决定', '定了', '拍板', '结论', '按这个', '以后都', '就这样', '就这么', '就按', '就用', '敲定', '定稿'] }
          : null,
        important: false,
        now,
      });
      const result = createOrAppendCard(root, draft, distilled, anchor);
      if (!result.written && result.reason === 'card-full') {
        summary.skipped += 1;
        transitionDraft(root, draft.id, 'rejected', { reason: 'card-full:20', now });
        audit(root, 'conclusion_distill', draft.id, 'card-full', { now });
        continue;
      }
      if (!result.written && result.duplicate) {
        summary.skipped += 1;
        transitionDraft(root, draft.id, 'distilled', { reason: 'already-in-card', now });
        audit(root, 'conclusion_distill', draft.id, 'duplicate', { now });
        continue;
      }
      transitionDraft(root, draft.id, 'distilled', { reason: `card:${result.card}`, now });
      summary.distilled += 1;
      audit(root, 'conclusion_distill', draft.id, 'distilled', { now });
    } catch (error) {
      summary.rejected += 1;
      const code = String(error?.code ?? error);
      try { transitionDraft(root, draft.id, 'rejected', { reason: code.slice(0, 300), now }); } catch { /* best effort */ }
      summary.errors.push({ id: draft.id, code });
      audit(root, 'conclusion_distill', draft.id, `rejected:${code}`, { now });
    }
  }
  return summary;
}

export { sha256 as conclusionDistillSha256 };
