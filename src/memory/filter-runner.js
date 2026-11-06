// Memory admission filter — passive runtime driver.
//
// This module is deliberately boring: it reads journal/*.md and the card
// catalog, calls the pure classifier in ./filter.js once per paragraph/bullet,
// and writes the audit trail under <memoryRoot>/.longlive/filter/. It never
// calls an LLM, never touches journal/topics/engram, and never throws into the
// plugin: every failure is a warning and the next tool call is unaffected.
//
// Layout (DESIGN.md §4.2):
//   .longlive/filter/decisions-YYYY-MM-DD.jsonl  one panel-ready row per unit
//   .longlive/filter/queue/YYYY-MM-DD.json       units that need a human
//   .longlive/filter/runs/YYYY-MM-DDTHHMM.json   full run result (maf-1)
//   .longlive/filter/state.json                  unitId -> decision + policy
//
// The panel reads decisions-*.jsonl; the other three are the audit trail.

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  POLICY_VERSION,
  THRESHOLDS,
  classifyEntry,
  normalizeText,
} from './filter.js';

const SCHEMA_VERSION = 'maf-1';
const FILTER_DIR = ['.longlive', 'filter'];
const MAX_JOURNAL_FILES = 24;
const MAX_UNITS = 500;
const DIM_NAMES = Object.freeze({
  R1: '断言性',
  R2: '复用跨度',
  R3: '禁令/偏好',
  R4: '踩坑修法',
  R5: '决策/取代',
  R6: '去重',
  R7: '关系/身份',
  R8: '产物承载',
});

function pad2(value) {
  return String(value).padStart(2, '0');
}

export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function localClock(date = new Date()) {
  return `${pad2(date.getHours())}${pad2(date.getMinutes())}`;
}

function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

function toPosix(value) {
  return String(value).split(sep).join('/');
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

function listMarkdown(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/** First meaningful 240 characters of a card, without frontmatter/headings. */
function cardSummary(text) {
  const lines = String(text).split(/\r?\n/);
  let index = 0;
  if (lines[0] === '---') {
    index = lines.indexOf('---', 1);
    index = index < 0 ? lines.length : index + 1;
  }
  const parts = [];
  for (; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#') || line.startsWith('<!--')) continue;
    parts.push(line.replace(/^[-*+]\s+/, '').replace(/[*`]/g, ''));
    if (parts.join(' ').length >= 240) break;
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 240);
}

/**
 * The card catalog R6 compares against: topics/ and procedures/ in stable
 * path order. Ordering is part of the determinism contract (P6).
 */
export function buildExistingCards(memoryRoot) {
  const cards = [];
  for (const room of ['topics', 'procedures']) {
    for (const file of listMarkdown(join(memoryRoot, room))) {
      const summary = cardSummary(readFileSync(file, 'utf8'));
      if (!summary) continue;
      cards.push({ cardId: toPosix(relative(memoryRoot, file)), summary });
    }
  }
  return cards.sort((a, b) => a.cardId.localeCompare(b.cardId));
}

/**
 * Split one journal file into adjudication units. A unit is one bullet or one
 * blank-line-separated paragraph; a heading only supplies the date/heading.
 */
export function parseJournal(text) {
  // Journal files are written with a UTF-8 BOM on Windows; without stripping
  // it the first line is "\uFEFF---" and the whole YAML frontmatter is scored
  // as body text (and line numbers point into the header).
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  const units = [];
  let inFrontmatter = lines[0] === '---';
  let heading = null;
  let date = null;
  let current = null;

  const flush = () => {
    if (!current) return;
    const body = current.text.replace(/\s+/g, ' ').trim();
    if (body) {
      units.push({
        text: body,
        lineStart: current.lineStart,
        lineEnd: current.lineEnd,
        heading,
        date,
        kind: current.kind,
      });
    }
    current = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trimEnd();
    if (inFrontmatter) {
      if (i > 0 && line === '---') inFrontmatter = false;
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      flush();
      if (/^##\s+/.test(line)) {
        heading = line.replace(/^##\s+/, '').trim();
        const match = heading.match(/^(\d{4}-\d{2}-\d{2})/);
        date = match ? match[1] : null;
      }
      continue;
    }
    if (/^(?:---+|\*\*\*+|___+)$/.test(line.trim())) {
      flush();
      continue;
    }
    if (/^[-*+]\s+/.test(line)) {
      flush();
      current = {
        text: line.replace(/^[-*+]\s+/, ''),
        lineStart: i + 1,
        lineEnd: i + 1,
        kind: 'bullet',
      };
      continue;
    }
    if (current) {
      // Indented continuation of the current bullet/paragraph.
      current.text += ` ${line.trim()}`;
      current.lineEnd = i + 1;
      continue;
    }
    current = { text: line.trim(), lineStart: i + 1, lineEnd: i + 1, kind: 'paragraph' };
  }
  flush();
  return units;
}

/** All journal units, newest file first, capped for a fail-open startup run. */
export function collectUnits(memoryRoot) {
  const journalDir = join(memoryRoot, 'journal');
  const files = [];
  for (const entry of (() => {
    try {
      return readdirSync(journalDir, { withFileTypes: true });
    } catch {
      return [];
    }
  })()) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    const abs = join(journalDir, entry.name);
    try {
      files.push({ abs, mtimeMs: statSync(abs).mtimeMs });
    } catch {
      /* unreadable file: skip, never fail the run */
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.abs.localeCompare(b.abs));

  const units = [];
  const seen = new Set();
  for (const file of files.slice(0, MAX_JOURNAL_FILES)) {
    let text;
    try {
      text = readFileSync(file.abs, 'utf8');
    } catch {
      continue;
    }
    const rel = toPosix(relative(memoryRoot, file.abs));
    for (const unit of parseJournal(text)) {
      if (normalizeText(unit.text).length < 8) continue;
      // A lead-in such as "关键教训：" is a label, not a statement.
      if (normalizeText(unit.text).length < 16 && /[:：]$/.test(unit.text)) continue;
      const unitId = sha256(normalizeText(unit.text)).slice(0, 16);
      if (seen.has(unitId)) continue;
      seen.add(unitId);
      units.push({ ...unit, unitId, file: rel, textSha256: sha256(unit.text) });
      if (units.length >= MAX_UNITS) return units;
    }
  }
  return units;
}

function dimMap(dims) {
  const out = {};
  for (const dim of Array.isArray(dims) ? dims : []) {
    if (dim && typeof dim.id === 'string') out[dim.id] = dim;
  }
  return out;
}

function hardSignalsOf(target, dims) {
  const map = dimMap(dims);
  const hits = [];
  const r7 = Number(map.R7?.score) || 0;
  const r1 = Number(map.R1?.score) || 0;
  if (target === 'remember' && r7 >= 2) hits.push('R7');
  if (target === 'remember' && r1 === 2) {
    hits.push('R1');
    for (const id of ['R2', 'R3', 'R4', 'R5']) {
      if (Number(map[id]?.score) === 2) hits.push(id);
    }
  }
  if (!hits.length) {
    for (const dim of dims || []) {
      if (dim && dim.max >= 2 && dim.score === dim.max && dim.score > 0) hits.push(dim.id);
    }
  }
  return [...new Set(hits)].slice(0, 8);
}

function privacyOf(result) {
  const blocked = result?.target === 'local_only' || (result?.privacy && result.privacy.verdict === 'block');
  return blocked
    ? { verdict: 'blocked', marker: 'V1_PRIVACY_BLOCK' }
    : { verdict: 'pass', marker: null };
}

function dedupOf(result) {
  const dims = dimMap(result?.dims);
  const delta = Number(dims.R6?.score) || 0;
  const nearest = result?.dedupe && typeof result.dedupe.nearestCardId === 'string'
    ? result.dedupe.nearestCardId
    : null;
  return { nearestUnitId: nearest, delta };
}

function panelDecision(unit, result, generatedAt, human) {
  const dims = (Array.isArray(result?.dims) ? result.dims : []).map((dim) => ({
    id: String(dim.id ?? ''),
    name: DIM_NAMES[dim.id] ?? String(dim.name ?? dim.id ?? ''),
    score: Number(dim.score) || 0,
    max: Number(dim.max) || 0,
    why: String(dim.why ?? ''),
  }));
  const target = ['remember', 'archive_only', 'human', 'local_only'].includes(result?.target)
    ? result.target
    : 'human';
  return {
    ts: generatedAt,
    unitId: unit.unitId,
    turn: null,
    target,
    score: Number.isFinite(Number(result?.score)) ? Number(result.score) : 0,
    dims,
    hardSignals: hardSignalsOf(target, dims),
    privacy: privacyOf(result),
    needsHuman: Boolean(result?.needsHuman) || target === 'human' || target === 'local_only',
    human: human && typeof human === 'object'
      ? { verdict: String(human.verdict ?? 'pending'), note: String(human.note ?? '') }
      : { verdict: 'pending', note: '' },
    source: {
      file: unit.file,
      lineStart: unit.lineStart,
      lineEnd: unit.lineEnd,
    },
    // DESIGN §3 V1: never echo the matched value or the offending text.
    excerpt: null,
    dedup: dedupOf(result),
  };
}

function runUnit(unit, existingCards) {
  try {
    // artifacts: [] is explicit context ("no artifact catalog supplied"),
    // not "missing": R8 may still apply and never marks the dimension skipped.
    return classifyEntry(unit.text, { existingCards, artifacts: [] });
  } catch (error) {
    return {
      target: 'human',
      score: 0,
      dims: [],
      needsHuman: true,
      privacy: { verdict: 'none', reasons: ['classifier-error'] },
      reasons: [error?.message ?? 'classifier-error'],
      policyVersion: POLICY_VERSION,
      band: 'human',
      dedupe: { verdict: 'error', similarity: null, nearestCardId: null, newInfo: [], mustKeepOld: false },
      excerpt: null,
    };
  }
}

function decisionIdsIn(file) {
  const ids = new Set();
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row.unitId === 'string') ids.add(row.unitId);
      } catch {
        /* a broken line must not block new decisions */
      }
    }
  } catch {
    /* no file yet */
  }
  return ids;
}

function logWarning(logger, message) {
  try {
    if (typeof logger === 'function') logger(message);
    else if (logger && typeof logger.warn === 'function') logger.warn(message);
  } catch {
    /* logging must never break the caller */
  }
}

function rulesSha256() {
  try {
    return sha256(readFileSync(fileURLToPath(new URL('./filter.js', import.meta.url)), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Run the filter once. Always resolves; returns a small summary for tests.
 *
 * @param {object} options
 * @param {string} options.memoryRoot
 * @param {Date|number} [options.now]
 * @param {(message:string)=>void} [options.logger]
 * @param {boolean} [options.force] append rows already present today
 */
export function runFilter(options = {}) {
  const startedAt = Date.now();
  try {
    if (!options.memoryRoot) return { ok: false, reason: 'E_MEMORY_ROOT_UNSET' };
    const memoryRoot = resolve(options.memoryRoot);
    const filterDir = join(memoryRoot, ...FILTER_DIR);
    const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
    const generatedAt = now.toISOString();
    const date = localDate(now);
    const out = {
      decisions: join(filterDir, `decisions-${date}.jsonl`),
      queue: join(filterDir, 'queue', `${date}.json`),
      run: join(filterDir, 'runs', `${date}T${localClock(now)}.json`),
      state: join(filterDir, 'state.json'),
    };

    mkdirSync(join(filterDir, 'queue'), { recursive: true });
    mkdirSync(join(filterDir, 'runs'), { recursive: true });

    const units = collectUnits(memoryRoot);
    const existingCards = buildExistingCards(memoryRoot);
    const state = readJson(out.state, {}) || {};
    const stateUnits = state && typeof state.units === 'object' && state.units ? state.units : {};
    const already = options.force ? new Set() : decisionIdsIn(out.decisions);

    const rows = [];
    const resultUnits = [];
    const queue = [];
    let fresh = 0;
    for (const unit of units) {
      const result = runUnit(unit, existingCards);
      const previous = stateUnits[unit.unitId];
      const human = previous && previous.policyVersion === POLICY_VERSION && previous.sourceSha === unit.textSha256
        ? previous.human
        : null;
      const row = panelDecision(unit, result, generatedAt, human);
      rows.push(row);
      fresh += already.has(unit.unitId) ? 0 : 1;

      stateUnits[unit.unitId] = {
        decision: row.target,
        policyVersion: POLICY_VERSION,
        decidedAt: generatedAt,
        sourceSha: unit.textSha256,
        source: row.source,
        human: row.human,
      };

      if (row.target === 'human' || row.needsHuman) {
        queue.push({
          unitId: row.unitId,
          ts: row.ts,
          score: row.score,
          target: row.target,
          reason: row.privacy.verdict === 'blocked' ? 'V1_PRIVACY_BLOCK' : 'needsHuman',
          source: row.source,
        });
      }

      resultUnits.push({
        unitId: unit.unitId,
        source: {
          path: row.source.file,
          lineStart: row.source.lineStart,
          lineEnd: row.source.lineEnd,
          heading: unit.heading,
          date: unit.date,
        },
        textSha256: unit.textSha256,
        decision: row.target,
        score: row.score,
        band: result?.band ?? row.target,
        hits: row.dims
          .filter((dim) => dim.score !== 0)
          .map((dim) => ({ ruleId: dim.id, polarity: dim.score > 0 ? '+' : '-', weight: dim.score, quote: dim.why })),
        dedupe: {
          nearest: row.dedup.nearestUnitId,
          similarity: result?.dedupe?.similarity ?? null,
          verdict: result?.dedupe?.verdict ?? 'skipped',
          newInfo: result?.dedupe?.newInfo ?? [],
        },
        privacy: {
          class: row.privacy.verdict === 'blocked' ? 'local_only' : 'none',
          markers: row.privacy.marker ? [row.privacy.marker] : [],
        },
        next: { route: row.target, requiresHuman: row.needsHuman },
        review: { human: row.human },
        policyVersion: POLICY_VERSION,
      });
    }

    const appended = options.force ? rows : rows.filter((row) => !already.has(row.unitId));
    if (appended.length) {
      appendFileSync(out.decisions, `${appended.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    }

    writeJsonAtomic(out.queue, { generatedAt, policyVersion: POLICY_VERSION, count: queue.length, items: queue });
    writeJsonAtomic(out.state, {
      schema: 1,
      policyVersion: POLICY_VERSION,
      updatedAt: generatedAt,
      units: stateUnits,
    });

    const counts = {
      remember: rows.filter((row) => row.target === 'remember').length,
      archive_only: rows.filter((row) => row.target === 'archive_only').length,
      human: rows.filter((row) => row.target === 'human').length,
      local_only: rows.filter((row) => row.target === 'local_only').length,
      humanQuotaExceeded: false,
    };
    const runId = `filter-${date.replace(/-/g, '')}-${localClock(now)}-${Math.random().toString(36).slice(2, 8)}`;
    writeJsonAtomic(out.run, {
      schemaVersion: SCHEMA_VERSION,
      runId,
      generatedAt,
      policy: {
        version: POLICY_VERSION,
        rulesSha256: rulesSha256(),
        thresholds: THRESHOLDS,
      },
      counts,
      units: resultUnits,
    });

    return {
      ok: true,
      runId,
      units: units.length,
      appended: appended.length,
      fresh,
      counts,
      dir: filterDir,
      files: out,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    logWarning(options.logger, `memory filter 运行失败（${error?.code ?? error?.message ?? error}）— 已跳过，不影响工具`);
    return { ok: false, reason: error?.code ?? 'E_FILTER_RUN_FAILED', error: String(error?.message ?? error) };
  }
}

/** Startup entry used by src/index.js; async so the plugin never waits on IO. */
export function scheduleFilterRun(memoryRoot, { logger, now, delayMs = 25 } = {}) {
  if (!memoryRoot) return null;
  try {
    const timer = setTimeout(() => {
      runFilter({ memoryRoot, logger, now });
    }, delayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  } catch (error) {
    logWarning(logger, `memory filter 定时器创建失败（${error?.message ?? error}）— 已跳过`);
    return null;
  }
}

export { POLICY_VERSION };
export const FILTER_SUBDIR = FILTER_DIR.join('/');
