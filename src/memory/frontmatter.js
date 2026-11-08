// Frontmatter parser/serializer for memory cards.
//
// The card format is deliberately tiny (SPEC §2): a leading `---` block with
// `key: value` lines and `[a, b]` arrays, then the body. No YAML dependency.
// A card without frontmatter is NOT an error — it is a legacy card, parsed
// with defaults and marked `legacy: true`, because the migration switch comes
// later and the index must still count it.

import { memoryError } from './paths.js';

export const FIELD_ORDER = Object.freeze([
  'title', 'date', 'tags', 'scope', 'status', 'salience', 'strength', 'last_used', 'revisions',
]);

/** Card lifecycle states. `active` is the default and is never written out. */
export const CARD_STATUSES = Object.freeze(['active', 'locked', 'archived']);

export const DEFAULT_FIELDS = Object.freeze({
  title: null,
  date: null,
  tags: [],
  // Declared routing vocabulary (comma-separated terms). Optional: cards
  // without it fall back to their body text for consolidation routing.
  scope: null,
  status: 'active',
  salience: 3,
  strength: 3,
  last_used: null,
  revisions: 0,
});

const KNOWN_KEYS = new Set(FIELD_ORDER);

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const rounded = Math.trunc(number);
  return Math.min(max, Math.max(min, rounded));
}

/**
 * Numeric frontmatter field. An empty or whitespace-only value is *absent*, so
 * it takes the default (salience/strength 3); it must not fall through
 * `Number('') === 0` and get clamped up to the minimum (salience 1). A
 * non-empty non-number keeps the old fallback path.
 */
function numberField(value, fallback, min, max) {
  const text = String(value ?? '').trim();
  if (text === '') return fallback;
  return clampInt(text, fallback, min, max);
}

function unquote(value) {
  const text = String(value ?? '').trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1);
    }
  }
  return text;
}

/** Validate a lifecycle status; `active` is the implicit default. */
export function parseStatus(value) {
  const text = unquote(value);
  if (text === '') return DEFAULT_FIELDS.status;
  if (!CARD_STATUSES.includes(text)) {
    throw memoryError(
      'E_CARD_STATUS_INVALID',
      `卡片 status 只能是 ${CARD_STATUSES.join(' / ')}，收到「${text}」— 改成合法值，或删掉该行（缺省 active）`,
    );
  }
  return text;
}

const SALIENCE_MIN = 0;
const SALIENCE_MAX = 9;

/**
 * salience is the forget/distill immunity weight: a strict integer 0..9.
 * Empty means "not set" and takes the default; anything else that is not an
 * integer in range is a broken card, not something to silently clamp — a
 * clamp would turn a typo into a permanent immunity or a forgotten core card.
 */
export function parseSalience(value) {
  const text = String(value ?? '').trim();
  if (text === '') return DEFAULT_FIELDS.salience;
  const number = Number(text);
  if (!Number.isInteger(number) || number < SALIENCE_MIN || number > SALIENCE_MAX) {
    throw memoryError(
      'E_CARD_SALIENCE_INVALID',
      `卡片 salience 必须是 ${SALIENCE_MIN}..${SALIENCE_MAX} 的整数，收到「${text}」— 改成合法值，或留空使用默认 ${DEFAULT_FIELDS.salience}`,
    );
  }
  return number;
}

function parseArray(value) {
  const text = String(value ?? '').trim();
  if (!text.startsWith('[') || !text.endsWith(']')) return null;
  const inner = text.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(',').map((part) => unquote(part)).filter((part) => part !== '');
}

/** `2026-11-02` from a Date, using local calendar time (when the user wrote it). */
export function dayString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** UTC ISO timestamp for audit/report stamps. */
export function isoStamp(date = new Date()) {
  return date.toISOString();
}

/** A day string is usable for decay math only when it parses as YYYY-MM-DD. */
export function isDayString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

/** Whole days between two `YYYY-MM-DD` strings (b - a), or null if unparsable. */
export function daysBetween(fromDay, toDay) {
  if (!isDayString(fromDay) || !isDayString(toDay)) return null;
  const from = Date.parse(`${fromDay.trim()}T00:00:00Z`);
  const to = Date.parse(`${toDay.trim()}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.floor((to - from) / 86_400_000);
}

const EMPTY_RESULT = () => ({
  text: '',
  hasFrontmatter: false,
  legacy: true,
  fields: { ...DEFAULT_FIELDS, tags: [] },
  extras: {},
  body: '',
  bodyStart: 0,
  bom: '',
  eol: '\n',
  openRaw: '',
  closeRaw: '',
});

/**
 * Parse a card. Returns `{ hasFrontmatter, legacy, fields, extras, body,
 * bodyStart, bom, eol }`. Missing frontmatter uses defaults, never throws.
 * A file that opens `---` and never closes it is malformed and throws
 * `E_FRONTMATTER_UNTERMINATED` — that is data loss waiting to happen.
 */
export function parseFrontmatter(text) {
  if (typeof text !== 'string') {
    throw memoryError('E_BAD_ARGUMENT', 'parseFrontmatter 需要字符串');
  }
  const result = EMPTY_RESULT();
  result.text = text;

  let bom = '';
  let rest = text;
  if (rest.charCodeAt(0) === 0xfeff) {
    bom = '\uFEFF';
    rest = rest.slice(1);
  }
  result.bom = bom;
  result.eol = rest.includes('\r\n') ? '\r\n' : '\n';

  const open = /^---[ \t]*(\r?\n|$)/.exec(rest);
  if (!open) {
    result.fields = { ...DEFAULT_FIELDS, tags: [] };
    result.body = text;
    result.bodyStart = 0;
    return result;
  }

  const contentStart = open[0].length;
  const closeMatch = /^---[ \t]*(\r?\n|$)/m.exec(rest.slice(contentStart));
  if (!closeMatch) {
    throw memoryError(
      'E_FRONTMATTER_UNTERMINATED',
      '卡片以 --- 开头但没有闭合的 --- 行 — 补上结束行，或删掉开头那一行',
    );
  }
  const closeStart = contentStart + closeMatch.index;
  const bodyStart = closeStart + closeMatch[0].length;
  const body = rest.slice(bodyStart);
  const lines = rest.slice(contentStart, closeStart).split(/\r?\n/);

  const fields = { ...DEFAULT_FIELDS, tags: [] };
  const extras = {};
  let lastKey = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      // The on-disk format is single-line only. A continuation line used to be
      // dropped silently, which changed the stored value without telling
      // anyone. Writers now refuse newline values (E_BAD_ARGUMENT), so a
      // multi-line value can only come from an edited/foreign card; reading it
      // as "first line only" would be data loss. Fail loudly with a coded
      // error instead, naming the key so a human can fix the card.
      if (/^[ \t]+\S/.test(rawLine)) {
        throw memoryError(
          'E_FRONTMATTER_MULTILINE',
          `frontmatter 字段 ${lastKey ?? '(未知)'} 含续行 — 该格式只支持单行值，请把值合并成一行或移进正文`,
        );
      }
      continue;
    }
    const key = match[1];
    lastKey = key;
    const value = match[2].trim();
    if (!KNOWN_KEYS.has(key)) {
      extras[key] = value;
      continue;
    }
    if (key === 'tags') {
      const parsed = parseArray(value);
      fields.tags = parsed ?? (value ? [unquote(value)] : []);
    } else if (key === 'salience') {
      fields.salience = parseSalience(value);
    } else if (key === 'status') {
      fields.status = parseStatus(value);
    } else if (key === 'strength') {
      fields.strength = numberField(value, DEFAULT_FIELDS.strength, 0, 9);
    } else if (key === 'revisions') {
      fields.revisions = numberField(value, DEFAULT_FIELDS.revisions, 0, 1_000_000);
    } else if (key === 'title') {
      fields.title = value === '' ? null : unquote(value);
    } else if (key === 'scope') {
      fields.scope = value === '' ? null : unquote(value);
    } else if (key === 'date' || key === 'last_used') {
      fields[key] = value === '' ? null : unquote(value);
    }
  }

  result.hasFrontmatter = true;
  result.legacy = false;
  result.fields = fields;
  result.extras = extras;
  result.body = body;
  result.bodyStart = bom.length + bodyStart;
  result.openRaw = rest.slice(0, contentStart);
  result.closeRaw = rest.slice(closeStart, bodyStart);
  return result;
}

/**
 * The card format is single-line per key. A value containing CR/LF cannot be
 * parsed back (the next line would be read as a new field or as an unterminated
 * continuation), so refuse it instead of writing a card that cannot round-trip.
 */
function singleLineValue(key, text) {
  if (/[\r\n]/.test(text)) {
    throw memoryError(
      'E_BAD_ARGUMENT',
      `frontmatter 字段 ${key} 的值含换行 — 该格式只支持单行值，拒绝写出（请把多行内容放进正文）`,
    );
  }
  return text;
}

function formatValue(key, value) {
  if (key === 'tags' && Array.isArray(value)) return singleLineValue(key, `[${value.join(', ')}]`);
  return singleLineValue(key, String(value));
}

/** Serialize fields into a complete `---` block (no trailing newline). */
export function serializeFrontmatter(fields = {}, extras = {}, eol = '\n') {
  const lines = ['---'];
  for (const key of FIELD_ORDER) {
    const value = fields[key];
    if (value == null) continue;
    if (key === 'tags' && Array.isArray(value) && value.length === 0) continue;
    // `active` is the default: writing it back would churn every legacy card.
    if (key === 'status') {
      if (parseStatus(value) === 'active') continue;
    }
    if (key === 'salience') parseSalience(value);
    lines.push(`${key}: ${formatValue(key, value)}`);
  }
  for (const [key, value] of Object.entries(extras ?? {})) {
    if (KNOWN_KEYS.has(key) || value == null) continue;
    lines.push(`${key}: ${singleLineValue(key, String(value))}`);
  }
  lines.push('---');
  return lines.join(eol);
}

/**
 * Change only the named frontmatter fields, preserving everything else:
 * unknown keys, line order, EOLs, and the body byte-for-byte. A legacy card
 * gets a fresh frontmatter block prepended; its original body is untouched.
 */
export function updateFrontmatter(text, updates = {}) {
  const parsed = parseFrontmatter(text);
  // Validate explicit writes before touching anything, so a rejected update is
  // a no-op rather than a half-merged block.
  if (Object.prototype.hasOwnProperty.call(updates, 'status')) parseStatus(updates.status);
  if (Object.prototype.hasOwnProperty.call(updates, 'salience')) parseSalience(updates.salience);
  const combined = { ...parsed.fields, ...updates };
  const eol = parsed.eol;

  if (!parsed.hasFrontmatter) {
    const block = serializeFrontmatter(combined, {}, eol);
    return `${parsed.bom}${block}${eol}${text.slice(parsed.bom.length)}`;
  }

  // bodyStart is a full-text index; do not add the BOM length again.
  const content = parsed.text.slice(
    parsed.bom.length + parsed.openRaw.length,
    parsed.bodyStart - parsed.closeRaw.length,
  );
  const lines = content.split(/\r?\n/);
  const seen = new Set();
  const next = [];
  for (const rawLine of lines) {
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(rawLine.trim());
    if (!match || !KNOWN_KEYS.has(match[1])) {
      next.push(rawLine);
      continue;
    }
    const key = match[1];
    seen.add(key);
    if (!(key in updates)) {
      next.push(rawLine);
      continue;
    }
    const value = combined[key];
    if (value == null || (key === 'tags' && Array.isArray(value) && value.length === 0)) continue;
    if (key === 'status' && parseStatus(value) === 'active') continue;
    if (key === 'salience') parseSalience(value);
    next.push(`${key}: ${formatValue(key, value)}`);
  }
  const missing = [];
  for (const key of FIELD_ORDER) {
    if (seen.has(key) || !(key in updates)) continue;
    const value = combined[key];
    if (value == null || (key === 'tags' && Array.isArray(value) && value.length === 0)) continue;
    if (key === 'status' && parseStatus(value) === 'active') continue;
    if (key === 'salience') parseSalience(value);
    missing.push(`${key}: ${formatValue(key, value)}`);
  }
  if (missing.length > 0) {
    // `content` ends with the EOL before the closing `---`, so split() leaves a
    // trailing empty element. The new lines must go in front of it, and the
    // block must still end with an EOL: otherwise the closing `---` is glued to
    // the last value ("revisions: 1---") and the card no longer parses.
    if (next.length > 0 && next[next.length - 1] === '') next.splice(next.length - 1, 0, ...missing);
    else next.push(...missing, '');
  }

  // bodyStart is a full-text index; do not add the BOM length again.
  const body = parsed.text.slice(parsed.bodyStart);
  return `${parsed.bom}${parsed.openRaw}${next.join(eol)}${parsed.closeRaw}${body}`;
}

/**
 * Change only extra (unknown) frontmatter keys, preserving the known fields,
 * their order, the body byte-for-byte and the file's EOL. A `null` value
 * removes the key. Known fields are refused: they have their own writer and
 * must not be smuggled through the extras path.
 *
 * This is what B3 needs for `conflict_with` / provenance markers on cards that
 * already exist: `updateFrontmatter` cannot add unknown keys by design.
 */
export function updateExtras(text, updates = {}) {
  const keys = Object.keys(updates ?? {});
  if (keys.length === 0) return text;
  const parsed = parseFrontmatter(text);
  for (const key of keys) {
    if (KNOWN_KEYS.has(key)) {
      throw memoryError('E_BAD_ARGUMENT', `updateExtras 只写扩展字段；${key} 是标准字段，请用 updateFrontmatter`);
    }
    if (!/^[A-Za-z_][\w-]*$/.test(key)) {
      throw memoryError('E_BAD_ARGUMENT', `扩展字段名不合法：${JSON.stringify(key)}`);
    }
    if (updates[key] != null) singleLineValue(key, String(updates[key]));
  }

  const eol = parsed.eol;
  if (!parsed.hasFrontmatter) {
    const extras = { ...parsed.extras };
    for (const key of keys) {
      if (updates[key] == null) delete extras[key];
      else extras[key] = String(updates[key]);
    }
    const block = serializeFrontmatter(parsed.fields, extras, eol);
    return `${parsed.bom}${block}${eol}${text.slice(parsed.bom.length)}`;
  }

  const content = parsed.text.slice(
    parsed.bom.length + parsed.openRaw.length,
    parsed.bodyStart - parsed.closeRaw.length,
  );
  const lines = content.split(/\r?\n/);
  const seen = new Set();
  const next = [];
  for (const rawLine of lines) {
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(rawLine.trim());
    if (!match || KNOWN_KEYS.has(match[1]) || !(match[1] in updates)) {
      next.push(rawLine);
      continue;
    }
    const key = match[1];
    seen.add(key);
    if (updates[key] == null) continue;
    next.push(`${key}: ${singleLineValue(key, String(updates[key]))}`);
  }
  const missing = [];
  for (const key of keys) {
    if (seen.has(key) || updates[key] == null) continue;
    missing.push(`${key}: ${singleLineValue(key, String(updates[key]))}`);
  }
  if (missing.length > 0) {
    if (next.length > 0 && next[next.length - 1] === '') next.splice(next.length - 1, 0, ...missing);
    else next.push(...missing, '');
  }

  const body = parsed.text.slice(parsed.bodyStart);
  return `${parsed.bom}${parsed.openRaw}${next.join(eol)}${parsed.closeRaw}${body}`;
}

/** Append one line at the very end without rewriting the body above it. */
export function appendLine(text, line) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const prefix = text.length === 0 || /[\r\n]$/.test(text) ? '' : eol;
  return `${text}${prefix}${line}${eol}`;
}

/** Rev comments are the one body line the tools may append. */
export function isRevLine(line) {
  return /^\s*<!--\s*rev\s*:/i.test(line);
}

export function countRevLines(body) {
  return String(body ?? '').split(/\r?\n/).filter(isRevLine).length;
}

/**
 * Body content with rev comments and trailing blank lines removed. Reinforce
 * compares this before/after: the prose must not move by a single character.
 */
export function normalizedBody(body) {
  return String(body ?? '')
    .split(/\r?\n/)
    .filter((line) => !isRevLine(line))
    .join('\n')
    .replace(/[\r\n]+$/, '');
}
