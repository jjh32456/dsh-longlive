// src/memory/card-priority.js — default salience/retention by card kind/source.
//
// Cards already carry optional salience/strength/retention frontmatter. AutoCards
// used to hard-code salience=1/fast-30d even for user conclusions and decisions;
// this module is the single deterministic policy used by new cards and by a
// dry-run rescore of existing cards. It never edits a card body.

export const CARD_PRIORITY_SCHEMA = 'card-priority/v1';

export const CARD_KIND_PRIORITY = Object.freeze({
  decision: Object.freeze({ salience: 5, retention: Object.freeze({ decay: 'slow', ttlDays: 365 }) }),
  conclusion: Object.freeze({ salience: 5, retention: Object.freeze({ decay: 'slow', ttlDays: 365 }) }),
  fact: Object.freeze({ salience: 4, retention: Object.freeze({ decay: 'normal', ttlDays: 180 }) }),
  episode: Object.freeze({ salience: 4, retention: Object.freeze({ decay: 'normal', ttlDays: 180 }) }),
  incident: Object.freeze({ salience: 3, retention: Object.freeze({ decay: 'normal', ttlDays: 90 }) }),
  plan: Object.freeze({ salience: 3, retention: Object.freeze({ decay: 'normal', ttlDays: 90 }) }),
  chat: Object.freeze({ salience: 2, retention: Object.freeze({ decay: 'fast', ttlDays: 30 }) }),
  ops: Object.freeze({ salience: 1, retention: Object.freeze({ decay: 'fast', ttlDays: 30 }) }),
});

export const CARD_PRIORITY_DEFAULT = Object.freeze({
  salience: 2,
  retention: Object.freeze({ decay: 'fast', ttlDays: 30 }),
});

const AUTO_SOURCES = new Set(['auto', 'auto-card', 'autoCard', 'event', 'event-card', 'activity']);
const MANUAL_SOURCES = new Set(['manual', 'user', 'curated', 'conclusion', 'a1', 'handover']);

function kindOf(card) {
  return String(card?.kind ?? card?.fields?.kind ?? '').toLowerCase();
}

function sourceOf(card, explicitSource = '') {
  const source = String(explicitSource || card?.source || card?.fields?.source || '').toLowerCase();
  if (AUTO_SOURCES.has(source)) return 'auto';
  if (MANUAL_SOURCES.has(source)) return 'manual';
  return source;
}

/**
 * @param {object} input { kind, source, tags?, title? }
 * @returns {{salience:number, retention:{decay:string,ttlDays:number}, reason:string}}
 */
export function priorityFor({ kind = '', source = '', tags = [] } = {}) {
  const k = String(kind || '').trim().toLowerCase();
  const s = sourceOf({ kind: k, fields: { tags } }, source);
  const base = CARD_KIND_PRIORITY[k] ?? CARD_PRIORITY_DEFAULT;
  let salience = base.salience;
  let reason = `kind:${k || 'default'}`;
  if (s === 'auto') {
    // Auto/event cards are searchable evidence, not curated memory: keep them
    // at the bottom regardless of the event kind (user decisions are promoted
    // to a topics card first, then the manual mapping applies).
    salience = 1;
    reason += ';source:auto';
  } else if (s === 'manual' && (k === 'decision' || k === 'conclusion')) {
    salience = Math.max(salience, 5);
    reason += ';source:manual';
  }
  // User-authored decision/conclusion must never be downgraded by an auto tag.
  const tagsLower = (Array.isArray(tags) ? tags : []).map((tag) => String(tag).toLowerCase());
  if (tagsLower.includes('user') || tagsLower.includes('decision')) {
    if (k === 'decision' || k === 'conclusion' || tagsLower.includes('decision')) salience = Math.max(salience, 5);
  }
  return {
    salience,
    retention: { ...base.retention },
    reason,
  };
}

/** Pure dry-run proposal for an existing card. Body/title are not touched. */
export function rescoreCard(card, { source = '' } = {}) {
  const fields = card?.fields ?? {};
  const kind = kindOf(card);
  const currentSalience = Number(fields.salience);
  const currentRetention = fields.retention ?? card?.retention ?? null;
  const proposed = priorityFor({ kind, source: sourceOf(card, source), tags: fields.tags ?? [] });
  return {
    path: card?.rel ?? card?.path ?? null,
    title: card?.title ?? fields.title ?? null,
    kind: kind || null,
    currentSalience: Number.isFinite(currentSalience) ? currentSalience : null,
    proposedSalience: proposed.salience,
    currentRetention,
    proposedRetention: proposed.retention,
    changed: (Number.isFinite(currentSalience) ? currentSalience : null) !== proposed.salience
      || JSON.stringify(currentRetention) !== JSON.stringify(proposed.retention),
    reason: proposed.reason,
  };
}

/** Dry-run a list; never writes a card or INDEX. */
export function rescoreCards(cards = []) {
  const changes = (Array.isArray(cards) ? cards : []).map((card) => rescoreCard(card));
  const changed = changes.filter((item) => item.changed);
  return {
    schema: CARD_PRIORITY_SCHEMA,
    dryRun: true,
    scanned: changes.length,
    changed: changed.length,
    unchanged: changes.length - changed.length,
    byKind: changes.reduce((acc, item) => {
      const key = item.kind ?? 'unknown';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
    changes: changed,
  };
}
