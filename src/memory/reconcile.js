// src/memory/reconcile.js — event/card/audit/anchor reconciliation + promotion.
//
// Read-mostly maintenance:
//   * compare events.db, cards.jsonl, events.audit, card-audit, card-anchors
//   * report set differences instead of silently trusting any one layer
//   * surface "event + auto card exist, but no curated card / INDEX row" facts
//     (the e219 turn-205 "朋友五问" live case) and allow a reviewed promotion.
// Default is dry-run: nothing is written unless write:true / promote dryRun:false.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { memoryRootFromConfig, resolveInside, relativePath } from './paths.js';
import { readAutoCards, cardsPathOf } from './auto-cards.js';
import { readCardAnchors } from './card-anchors.js';
import { openEventIndex } from './event-index.js';
import { readState, writeFileAtomic } from './state.js';
import { scanCards } from './index.js';
import { memoryIndex } from './index.js';
import { priorityFor } from './card-priority.js';

export const RECONCILE_SCHEMA = 'index-reconcile/v1';
export const RECONCILE_FILE_PREFIX = 'reconcile-';

const HIGH_VALUE_KIND = new Set(['conclusion', 'decision', 'incident']);
const HIGH_VALUE_RE = /五问|智能体工程师|决定|结论|不能忘|重要|规则|承诺|教训|根因|必须|以后/iu;

function sha1(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex');
}

function readJsonl(file) {
  const rows = [];
  let badLines = 0;
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { rows, badLines, present: false }; }
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try { rows.push(JSON.parse(line)); } catch { badLines += 1; }
  }
  return { rows, badLines, present: true };
}

function readEvents(root) {
  const dbPath = resolveInside(root, path.join('.longlive', 'index', 'events.db'));
  if (!fs.existsSync(dbPath)) return { ok: false, rows: [], total: 0, code: 'E_EVENTS_INDEX_MISSING' };
  let index = null;
  try {
    index = openEventIndex({ memoryRoot: root });
    const total = index.count();
    const rows = [];
    for (let offset = 0; offset < total; offset += 500) rows.push(...index.listEvents({ limit: 500, offset }));
    return { ok: true, rows, total };
  } catch (error) {
    return { ok: false, rows: [], total: 0, code: error?.code ?? 'E_EVENTS_INDEX_READ', message: String(error?.message ?? error) };
  } finally {
    try { index?.close(); } catch { /* best effort */ }
  }
}

function curatedSourceIds(root) {
  const ids = new Set();
  const links = readCardAnchors(root).values();
  for (const link of links) {
    for (const id of Array.isArray(link.sourceEventIds) ? link.sourceEventIds : []) {
      if (typeof id === 'string' && id !== '') ids.add(id);
    }
  }
  for (const card of scanCards(root)) {
    const raw = card.fields?.sourceEventIds;
    if (Array.isArray(raw)) for (const id of raw) if (typeof id === 'string') ids.add(id);
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) for (const id of parsed) if (typeof id === 'string') ids.add(id);
      } catch { /* malformed frontmatter is reported elsewhere */ }
    }
  }
  return ids;
}

function highValue(card, event) {
  const kind = String(event?.kind ?? card?.kind ?? '').toLowerCase();
  const text = `${card?.title ?? ''} ${(card?.terms ?? []).join(' ')}`;
  return {
    value: HIGH_VALUE_KIND.has(kind) || HIGH_VALUE_RE.test(text),
    kind,
    reason: HIGH_VALUE_KIND.has(kind) ? `kind:${kind}` : (HIGH_VALUE_RE.test(text) ? 'keyword' : ''),
  };
}

/**
 * Compute a reconcile summary. Read-only except for the optional JSON report
 * (`write:true`, default false). Never promotes anything here.
 */
export function reconcileIndex({ memoryRoot = '', now = new Date(), write = false } = {}) {
  const root = path.resolve(String(memoryRoot ?? ''));
  if (root === '') throw new Error('E_MEMORY_ROOT: reconcile requires memoryRoot');
  const nowDate = now instanceof Date ? now : new Date(now);
  const events = readEvents(root);
  // legacy cold-archive diagnostic only; not used by recall/INDEX/panel stats.
  // Explicit promotion review still reads the old archive; no summary is emitted.
  const cards = readAutoCards(root);
  const curated = scanCards(root);
  const eventsAudit = readJsonl(resolveInside(root, path.join('.longlive', 'index', 'events.audit.jsonl')));
  const cardAudit = readJsonl(resolveInside(root, path.join('.longlive', 'index', 'card-audit.jsonl')));
  const anchors = readCardAnchors(root);
  const curatedIds = curatedSourceIds(root);

  const eventIds = new Set(events.rows.map((row) => row.id));
  const cardEventIds = new Set(cards.map((card) => card.eventId));
  const auditIds = new Set(eventsAudit.rows.map((row) => row.id));
  const duplicateAuditRows = eventsAudit.rows.length - auditIds.size;
  const missingAudit = [...eventIds].filter((id) => !auditIds.has(id));
  const auditWithoutEvent = [...auditIds].filter((id) => !eventIds.has(id));
  const missingCard = events.rows.filter((row) => !cardEventIds.has(row.id)).map((row) => row.id);
  const cardWithoutEvent = cards.filter((card) => !eventIds.has(card.eventId)).map((card) => card.eventId);
  const dropRows = cardAudit.rows.filter((row) => row.action === 'drop');
  const dropStillCarded = [...new Set(dropRows.map((row) => row.eventId).filter((id) => cardEventIds.has(id)))];
  const anchorRows = [...anchors.values()];
  const legacyEmptyAnchors = anchorRows.filter((link) => link.legacy === true || (Array.isArray(link.anchors) && link.anchors.length === 0));
  const emptySourceEventIds = anchorRows.filter((link) => !Array.isArray(link.sourceEventIds) || link.sourceEventIds.length === 0);
  const invalidSourceEventIds = [];
  for (const link of anchorRows) for (const id of Array.isArray(link.sourceEventIds) ? link.sourceEventIds : []) {
    if (!eventIds.has(id)) invalidSourceEventIds.push({ rel: link.rel, id });
  }

  const autoCandidates = [];
  for (const card of cards) {
    if (curatedIds.has(card.eventId)) continue;
    const event = events.rows.find((row) => row.id === card.eventId) ?? null;
    const hv = highValue(card, event);
    if (!hv.value) continue;
    autoCandidates.push({
      cardId: card.cardId,
      eventId: card.eventId,
      sessionId: card.sessionId ?? card.anchor?.sessionId ?? null,
      turn: card.turn ?? card.anchor?.turn ?? null,
      title: card.title ?? '',
      terms: Array.isArray(card.terms) ? card.terms : [],
      kind: hv.kind || card.kind || null,
      reason: hv.reason,
      promotion: {
        dryRun: true,
        target: `topics/promoted-${sha1(`${card.eventId}|${card.title}`).slice(0, 12)}.md`,
        accept: `node scripts/index-reconcile.mjs --memory-root <root> --accept ${card.cardId} --apply`,
      },
    });
  }
  const summary = {
    schema: RECONCILE_SCHEMA,
    generatedAt: nowDate.toISOString(),
    memoryRoot: root,
    events: {
      ok: events.ok,
      total: events.total,
      indexFile: path.join('.longlive', 'index', 'events.db'),
      ...(events.code ? { code: events.code } : {}),
    },
    curatedCards: curated.length,
    sets: {
      eventNotAudit: { count: missingAudit.length, sample: missingAudit.slice(0, 20) },
      auditNotEvent: { count: auditWithoutEvent.length, sample: auditWithoutEvent.slice(0, 20) },
      duplicateAuditRows,
      eventNoCard: { count: missingCard.length, sample: missingCard.slice(0, 20) },
      cardNoEvent: { count: cardWithoutEvent.length, sample: cardWithoutEvent.slice(0, 20) },
      cardAuditDrops: dropRows.length,
      dropButStillCarded: { count: dropStillCarded.length, sample: dropStillCarded.slice(0, 20) },
      cardAnchors: {
        total: anchorRows.length,
        legacyOrEmptyAnchors: legacyEmptyAnchors.length,
        emptySourceEventIds: emptySourceEventIds.length,
        invalidSourceEventIds,
      },
    },
    autoCandidates: {
      count: autoCandidates.length,
      sample: autoCandidates.slice(0, 20),
      note: 'event + auto card exist, but no curated card/card-anchor sourceEventId covers them',
    },
    safeRepairs: {
      dryRunByDefault: true,
      actions: [
        'promote reviewed autoCandidates to topics/ (--accept <cardId> --apply)',
        're-run memory_index after promotion',
        'card-audit drops that are still present are reported, never silently rewritten; rebuild card-audit only after a verified card rebuild',
      ],
    },
  };
  let reportPath = null;
  if (write) {
    const reportsDir = resolveInside(root, path.join('.longlive', 'reports'));
    fs.mkdirSync(reportsDir, { recursive: true });
    const stamp = nowDate.toISOString().slice(0, 10).replace(/-/g, '');
    reportPath = path.join(reportsDir, `${RECONCILE_FILE_PREFIX}${stamp}.json`);
    writeFileAtomic(root, relativePath(root, reportPath), `${JSON.stringify(summary, null, 2)}\n`, { now: nowDate });
  }
  return { ...summary, reportPath };
}

/**
 * Promote one reviewed auto card to a topics card. The card body is newly
 * written; the source auto card is never edited. Default dryRun=true.
 */
export function promoteAutoCard({ memoryRoot = '', cardId = '', eventId = '', now = new Date(), dryRun = true } = {}) {
  const root = path.resolve(String(memoryRoot ?? ''));
  if (root === '') throw new Error('E_MEMORY_ROOT: promote requires memoryRoot');
  const nowDate = now instanceof Date ? now : new Date(now);
  // legacy cold-archive diagnostic only; not used by recall/INDEX/panel stats.
  const card = readAutoCards(root).find((item) => (cardId && item.cardId === cardId) || (eventId && item.eventId === eventId));
  if (!card) throw new Error('E_AUTO_CARD_NOT_FOUND');
  const index = openEventIndex({ memoryRoot: root });
  let event = null;
  try { event = index.getEvent(card.eventId); } finally { index.close(); }
  if (!event) throw new Error('E_EVENT_NOT_FOUND');
  const target = `topics/promoted-${sha1(`${card.eventId}|${card.title}`).slice(0, 12)}.md`;
  const abs = resolveInside(root, target);
  const kind = ['conclusion', 'decision'].includes(String(event.kind)) ? event.kind : 'fact';
  const priority = priorityFor({ kind, source: 'manual' });
  const title = String(card.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'promoted event';
  const terms = Array.isArray(card.terms) ? card.terms.filter((term) => typeof term === 'string') : [];
  const body = [
    '---',
    `title: ${title}`,
    `date: ${nowDate.toISOString().slice(0, 10)}`,
    'tags: [promoted, auto-card]',
    `salience: ${priority.salience}`,
    `retention: ${JSON.stringify(priority.retention)}`,
    `kind: ${kind}`,
    `source_session: ${card.sessionId ?? card.anchor?.sessionId ?? ''}`,
    `source_turn: ${card.turn ?? card.anchor?.turn ?? ''}`,
    `sourceEventIds: [${JSON.stringify(card.eventId)}]`,
    `promoted_from_card: ${card.cardId}`,
    '---',
    '',
    title,
    '',
    `原文锚点：session=${card.sessionId ?? card.anchor?.sessionId ?? ''} turn=${card.turn ?? card.anchor?.turn ?? ''}`,
    terms.length > 0 ? `检索词：${terms.join(' / ')}` : '',
    '',
  ].join('\n');
  const result = {
    ok: true,
    dryRun: dryRun !== false,
    cardId: card.cardId,
    eventId: card.eventId,
    rel: target,
    path: abs,
    title,
    kind,
    salience: priority.salience,
    body,
    sourceAnchor: card.anchor ?? null,
  };
  if (dryRun !== false) return result;
  if (fs.existsSync(abs)) throw new Error(`E_PROMOTE_EXISTS: ${target}`);
  writeFileAtomic(root, target, body, { backup: false, now: nowDate });
  const indexResult = memoryIndex({ apply: true }, { memoryRoot: root, now: nowDate });
  return { ...result, dryRun: false, written: true, index: indexResult };
}

export function reconcileRootFromConfig(config = {}) {
  return memoryRootFromConfig(config);
}
