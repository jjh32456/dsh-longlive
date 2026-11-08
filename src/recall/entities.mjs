// src/recall/entities.mjs — B2：实体别名表（`.longlive/entities/entities.jsonl`）
//
// 字段：{schema:'entities/v1', canonical, aliases[], kind, at}
// 只读路径给召回查询扩展用；写入口只允许宿主传入（本模块不做权限门，由调用方保证）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ENTITIES_SCHEMA = 'entities/v1';

export function entitiesPathOf(memoryRoot) {
  return path.join(path.resolve(String(memoryRoot ?? '')), '.longlive', 'entities', 'entities.jsonl');
}

function nowIso(now) {
  const value = typeof now === 'function' ? now() : new Date();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** Read alias registry (append-only; later rows add aliases). Missing file => empty map. */
export function readEntityAliases({ memoryRoot }) {
  const file = entitiesPathOf(memoryRoot);
  const byCanonical = new Map();
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { present: false, file, aliases: {}, byCanonical: {}, badLines: 0 };
  }
  let bad = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      bad += 1;
      continue;
    }
    const canonical = typeof row?.canonical === 'string' ? row.canonical.trim() : '';
    if (canonical === '') continue;
    const aliases = Array.isArray(row.aliases) ? row.aliases.map((a) => String(a).trim()).filter(Boolean) : [];
    const prev = byCanonical.get(canonical) ?? { canonical, aliases: new Set([canonical]), kind: row.kind ?? null };
    for (const alias of aliases) prev.aliases.add(alias);
    byCanonical.set(canonical, prev);
  }
  const aliases = {};
  for (const [canonical, entry] of byCanonical) aliases[canonical] = [...entry.aliases];
  return { present: true, file, aliases, byCanonical, badLines: bad };
}

/** Append one entity alias row (host/panel write path). Idempotent per canonical+alias set. */
export function appendEntityAlias({ memoryRoot, canonical, aliases = [], kind = null, now = () => new Date() }) {
  const name = typeof canonical === 'string' ? canonical.trim() : '';
  if (name === '') {
    const error = new Error('E_ENTITY_CANONICAL_REQUIRED: canonical 不能为空');
    error.code = 'E_ENTITY_CANONICAL_REQUIRED';
    throw error;
  }
  const list = [...new Set([name, ...(Array.isArray(aliases) ? aliases : [])].map((a) => String(a).trim()).filter(Boolean))];
  const file = entitiesPathOf(memoryRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = { schema: ENTITIES_SCHEMA, canonical: name, aliases: list, kind: kind ?? null, at: nowIso(now) };
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  return { ok: true, file, row };
}

/** Find canonical entities mentioned in `text` (longest alias first). */
export function resolveEntityAliases(text, aliasMap, { max = 20 } = {}) {
  const value = typeof text === 'string' ? text : '';
  const matches = [];
  const entries = [];
  for (const [canonical, aliases] of Object.entries(aliasMap ?? {})) {
    for (const alias of new Set([canonical, ...(Array.isArray(aliases) ? aliases : [])])) {
      if (typeof alias !== 'string' || alias.trim() === '') continue;
      entries.push({ canonical, alias });
    }
  }
  entries.sort((a, b) => b.alias.length - a.alias.length || a.alias.localeCompare(b.alias));
  const usedRanges = [];
  for (const entry of entries) {
    let from = 0;
    while (matches.length < max) {
      const index = value.indexOf(entry.alias, from);
      if (index === -1) break;
      from = index + entry.alias.length;
      const end = index + entry.alias.length;
      if (usedRanges.some((range) => index < range.end && end > range.start)) continue;
      usedRanges.push({ start: index, end });
      matches.push({ canonical: entry.canonical, alias: entry.alias, index });
    }
  }
  matches.sort((a, b) => a.index - b.index);
  return {
    terms: [...new Set(matches.map((match) => match.canonical))],
    matches,
  };
}

/** Deterministic expansion text: canonical names appended once. */
export function expandQueryWithEntities(queryText, resolution) {
  const terms = Array.isArray(resolution?.terms) ? resolution.terms : [];
  if (terms.length === 0) return { text: String(queryText ?? ''), changed: false, terms };
  const base = String(queryText ?? '');
  const tail = terms.filter((term) => !base.includes(term)).join(' ');
  return { text: tail === '' ? base : `${base} ${tail}`, changed: tail !== '', terms };
}

export function entityAliasDigest(aliasMap) {
  return crypto.createHash('sha1').update(JSON.stringify(aliasMap ?? {})).digest('hex').slice(0, 12);
}
