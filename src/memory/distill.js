// src/memory/distill.js — M2-D：纯抽取式蒸馏器（零新事实 / 版本链 / 幂等 / 回滚）
//
// 设计依据 MEMORY-RECALL-V2-PROPOSAL §4.3（distill schema）与 §4.2.2（L2 判定）：
//   * 纯抽取式：只从源文本抽取白名单字段（who/when/decision/why/emotion/numbers/
//     facts），抽不到写 null/[]，不补；gist 只由源摘要句按时间拼接 + 截断，
//     **不得生成新句子、不得推断因果**；
//   * 零新事实：每个 fact.v 与 gist 的每个分句都必须能在源文本（或既有 summary）里
//     找到子串（允许空白/标点/大小写归一化）；任一无法回溯 → 整个版本拒收
//     （E_DISTILL_UNTRACEABLE），不落链、回退上一版；
//   * 幂等：同输入重跑 → contentHash 相同 → 返回 already-distilled，字节不新增；
//   * 版本链 append-only（version-chain.js），history/diff/rollback 入口在
//     scripts/memory-distill-admin.mjs（不注册 tools.js，避免 27/18/路由面波动）。

import {
  DISTILL_DIR,
  appendChainLog,
  appendVersionLine,
  chainFileName,
  chainFilePathOf,
  contentHashOf,
  diffVersions,
  readChainIndex,
  readIndexEntry,
  readVersions,
  rollbackVersion,
  setActiveVersion,
} from './version-chain.js';
import {
  CAUSAL_WORDS,
  DECISION_WORDS,
  EMOTION_WORDS,
  FidelityGateError,
  INCIDENT_WORDS,
  RELEASE_WORDS,
  assertDistillable,
  assertL2Gate,
  normalizeForMatch,
} from './l2-gate.js';
import { appendAuditRecord } from './audit-records.js';
import { readProtectionManifest } from './retention.js';
import { memoryError } from './paths.js';
import { sha256Text } from './state.js';

export const DISTILL_SCHEMA = 'distill/v1';

// 发布包隐私：默认不再内置任何姓名/角色。没人配置 whoCandidates 时 who 不抽取。
// 配置入口（通用）：buildDistillRecord/distillAppend 的 whoCandidates 参数，
// 或环境变量 DSH_LONGLIVE_DISTILL_WHO（逗号/换行分隔）。默认 []。
export const DISTILL_DEFAULT_WHO = Object.freeze([]);
export const DISTILL_WHO_ENV = 'DSH_LONGLIVE_DISTILL_WHO';

/** 归一化 who 名单：数组/逗号分隔字符串 → 去空、去重、去首尾空白；坏值回 []。 */
export function normalizeWhoCandidates(value) {
  const raw = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(/[,，\n]/u) : []);
  const out = [];
  for (const item of raw) {
    const name = String(item ?? '').trim();
    if (name === '' || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/** 解析通用 who 配置：显式参数/对象 config/distill.whoCandidates → 环境变量 → []。 */
export function resolveWhoCandidates(source = null) {
  const configured = source && !Array.isArray(source) && typeof source === 'object'
    ? (source.whoCandidates ?? source.distill?.whoCandidates)
    : source;
  if (configured !== undefined) return normalizeWhoCandidates(configured);
  return normalizeWhoCandidates(process.env[DISTILL_WHO_ENV]);
}

const MAX_GIST_CHARS = 240;
const MAX_FIELD_CHARS = 200;

function errorMessage(error) {
  return String(error?.code ?? error?.message ?? error);
}

function splitClauses(text) {
  return String(text ?? '')
    .split(/(?<=[。！？；!?;\n])/)
    .map((clause) => clause.trim())
    .filter((clause) => clause !== '');
}

function windowAround(text, marker, maxLen = MAX_FIELD_CHARS) {
  const raw = String(text ?? '');
  const index = raw.indexOf(marker);
  if (index < 0) return null;
  const start = Math.max(0, index - Math.floor((maxLen - marker.length) / 2));
  const end = Math.min(raw.length, start + maxLen);
  return raw.slice(start, end).trim();
}

/** Only source-anchored windows; never a paraphrase. */
function pickWindows(texts, words) {
  const picked = [];
  for (const text of texts) {
    for (const word of words) {
      if (!text.includes(word)) continue;
      const window = windowAround(text, word);
      if (window && !picked.includes(window)) picked.push(window);
    }
  }
  return picked.slice(0, 4);
}

function orNull(value) {
  return Array.isArray(value) && value.length === 0 ? null : value;
}

function pickWho(texts, candidates) {
  const found = [];
  for (const name of candidates) {
    if (texts.some((text) => text.includes(name)) && !found.includes(name)) found.push(name);
  }
  return found.length > 0 ? found : null;
}

function pickWhen(texts) {
  const found = [];
  const patterns = [
    /\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?\b/g,
    /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
    /\d{4}年\d{1,2}月\d{1,2}日/g,
  ];
  for (const text of texts) {
    for (const pattern of patterns) {
      for (const match of text.match(pattern) ?? []) {
        if (!found.includes(match)) found.push(match);
      }
    }
  }
  return found.length > 0 ? found : null;
}

function pickNumbers(texts) {
  const found = [];
  const patterns = [
    /\bv?\d+(?:\.\d+){1,3}\b/g,
    /\b[0-9a-f]{7,40}\b/g,
    /\b\d+(?:\.\d+)?\s*(?:ms|s|秒|分钟|小时|天|KB|MB|GB|%|万|k)/g,
    /\b\d{4}-\d{2}-\d{2}\b/g,
  ];
  for (const text of texts) {
    for (const pattern of patterns) {
      for (const match of text.match(pattern) ?? []) {
        const value = match.trim();
        if (!found.includes(value)) found.push(value);
      }
    }
  }
  return found.slice(0, 40);
}

const FACT_PATTERNS = Object.freeze([
  { k: 'commit', re: /\bcommit\s*[:：=]?\s*([0-9a-f]{7,40})\b/gi },
  { k: 'tag', re: /\btag\s*[:：=]?\s*(v?\d+(?:\.\d+)*)\b/gi },
  { k: 'version', re: /(?:版本|version|发布)\s*[:：=]?\s*(v?\d+\.\d+(?:\.\d+)*)\b/gi },
  { k: 'path', re: /(?:路径|文件|file)\s*[:：=]?\s*([A-Za-z]:\\[^\s，。；,;]+|\/[\w./-]+)/gi },
]);

function pickFacts(texts) {
  const facts = [];
  const seen = new Set();
  texts.forEach((text, anchor) => {
    for (const { k, re } of FACT_PATTERNS) {
      re.lastIndex = 0;
      for (const match of text.matchAll(re)) {
        const value = String(match[1] ?? '').trim();
        if (value === '') continue;
        const key = `${k}|${value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        facts.push({ k, v: value, anchor });
      }
    }
  });
  return facts.slice(0, 20);
}

function pickSummaryClauses(sources) {
  const parts = [];
  for (const source of sources) {
    const text = String(source.text ?? '');
    const clauses = splitClauses(text);
    const important = clauses.find((clause) => [...DECISION_WORDS, ...INCIDENT_WORDS, ...RELEASE_WORDS]
      .some((word) => clause.includes(word)));
    const chosen = (typeof source.summary === 'string' && source.summary.trim() !== '')
      ? source.summary.trim()
      : (important ?? clauses[0] ?? '');
    if (chosen !== '' && !parts.includes(chosen)) parts.push(chosen);
  }
  return parts;
}

function gistFrom(sources) {
  const parts = pickSummaryClauses(sources);
  let gist = '';
  for (const part of parts) {
    const next = gist === '' ? part : `${gist}；${part}`;
    if (next.length <= MAX_GIST_CHARS) gist = next;
    else if (gist === '') gist = part.slice(0, MAX_GIST_CHARS);
  }
  return gist;
}

export function gistClausesOf(gist) {
  return String(gist ?? '').split(/[；;]/).map((part) => part.trim()).filter(Boolean);
}

/**
 * Zero-new-facts validator: every extracted value must be traceable to a source
 * text or an existing summary (normalized substring). Pure, no IO.
 */
export function validateZeroNewFacts(record, sources = []) {
  const texts = sources.map((source) => String(source.text ?? ''))
    .concat(sources.map((source) => String(source.summary ?? '')).filter(Boolean));
  const normalizedTexts = texts.map(normalizeForMatch).filter((text) => text !== '');
  const untraceable = [];
  let checked = 0;
  const check = (where, value) => {
    const normalized = normalizeForMatch(value);
    checked += 1;
    if (normalized === '') return;
    if (!normalizedTexts.some((text) => text.includes(normalized))) untraceable.push({ where, value });
  };
  for (const clause of gistClausesOf(record?.gist)) check('gist', clause);
  for (const fact of Array.isArray(record?.facts) ? record.facts : []) check(`facts.${fact.k}`, fact.v);
  for (const field of ['who', 'when', 'decision', 'why', 'emotion']) {
    const value = record?.fields?.[field];
    if (value === null || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) check(`fields.${field}`, item);
  }
  for (const number of Array.isArray(record?.numbers) ? record.numbers : []) check('numbers', number);
  return { ok: untraceable.length === 0, checked, untraceable };
}

function anchorOf(source) {
  const anchor = {
    id: String(source.id ?? ''),
    sourceKind: String(source.sourceKind ?? source.kind ?? 'record'),
    eventKind: source.eventKind ?? null,
    digest: sha256Text(String(source.text ?? '')),
  };
  for (const key of ['sessionId', 'turn', 'seqStart', 'seqEnd', 'rel', 'lineStart', 'lineEnd', 'anchorId']) {
    if (source[key] !== undefined && source[key] !== null) anchor[key] = source[key];
  }
  if (typeof source.summary === 'string' && source.summary.trim() !== '') anchor.summary = source.summary.trim();
  return anchor;
}

function canonicalContent(record) {
  return {
    id: record.id,
    topic: record.topic,
    period: record.period,
    grade: record.grade,
    gist: record.gist,
    fields: record.fields,
    facts: record.facts,
    numbers: record.numbers,
    sources: record.sources,
    trigger: record.trigger,
  };
}

/**
 * Build (extract + validate) one distill version. Pure: no write. Throws
 * E_DISTILL_UNTRACEABLE / E_DISTILL_L2_GATE when the version must be rejected.
 */
export function buildDistillRecord({
  topic, period, sources, grade = 'L2', trigger = 'manual', reason = '', by = 'distiller:v1',
  now = new Date(), requiredFields = null, important = false, whoCandidates = resolveWhoCandidates(),
} = {}) {
  if (typeof topic !== 'string' || topic.trim() === '') throw memoryError('E_DISTILL_TOPIC', '蒸馏需要稳定 topic');
  if (typeof period !== 'string' || period.trim() === '') throw memoryError('E_DISTILL_PERIOD', '蒸馏需要稳定 period');
  if (!Array.isArray(sources) || sources.length === 0) throw memoryError('E_DISTILL_SOURCES', '蒸馏至少需要 1 个源锚点');
  for (const source of sources) {
    if (!source || typeof source.id !== 'string' || source.id === '') {
      throw memoryError('E_DISTILL_SOURCES', '每个源必须带稳定 id（锚点）');
    }
    if (typeof source.text !== 'string' || source.text.trim() === '') {
      throw memoryError('E_DISTILL_SOURCES', `源 ${source.id} 缺 text，无法做零新事实校验`);
    }
  }
  const texts = sources.map((source) => String(source.text));
  const facts = pickFacts(texts);
  const fields = {
    who: pickWho(texts, whoCandidates),
    when: pickWhen(texts),
    decision: orNull(pickWindows(texts, DECISION_WORDS)),
    why: orNull(pickWindows(texts, CAUSAL_WORDS)),
    emotion: orNull(pickWindows(texts, EMOTION_WORDS)),
  };
  const numbers = pickNumbers(texts);
  const gist = gistFrom(sources);
  if (gist === '') throw memoryError('E_DISTILL_GIST', '源文本抽不出任何摘要句（不生成，宁可不蒸）');
  const id = `dist:${topic.trim()}:${period.trim()}`;
  const record = {
    schema: DISTILL_SCHEMA,
    id,
    version: 1,
    prevVersion: null,
    topic: topic.trim(),
    period: period.trim(),
    sources: sources.map(anchorOf),
    grade,
    gist,
    fields,
    facts,
    numbers,
    trigger,
    audit: {
      by,
      sourceCount: sources.length,
      createdAt: now.toISOString(),
      reason,
      zeroNewFacts: null,
      l2: null,
    },
  };
  const gateText = [gist, ...(fields.decision ?? []), ...(fields.why ?? [])].join('；');
  const l2 = assertL2Gate({ record, text: gateText, requiredFields, important });
  record.audit.l2 = l2.skipped ? null : { level: l2.verdict.level, hits: l2.verdict.hits, total: l2.verdict.total };
  const zero = validateZeroNewFacts(record, sources);
  record.audit.zeroNewFacts = { ok: zero.ok, checked: zero.checked, untraceable: zero.untraceable };
  if (!zero.ok) {
    throw new FidelityGateError(
      'E_DISTILL_UNTRACEABLE',
      `零新事实校验失败（${zero.untraceable.length} 处无法回溯）→ 拒收该版本并回退上一版`,
      { id, untraceable: zero.untraceable },
    );
  }
  record.contentHash = contentHashOf(canonicalContent(record));
  return record;
}

function readManifestForGate(root) {
  return readProtectionManifest(root);
}

/**
 * distillAppend: gate -> build -> zero-new-facts -> idempotent -> append version ->
 * move active pointer -> 1 distill.log row + 1 unified audit row. Never deletes.
 */
export function distillAppend({
  root, topic, period, sources, grade = 'L2', trigger = 'manual', reason = '', by = 'distiller:v1',
  now = new Date(), requiredFields = null, important = false, gate = true, whoCandidates,
} = {}) {
  const memoryRoot = String(root ?? '');
  if (memoryRoot === '') throw memoryError('E_MEMORY_ROOT', 'distillAppend requires root');
  const manifest = readManifestForGate(memoryRoot);
  if (gate) {
    for (const source of sources ?? []) {
      assertDistillable({
        id: String(source.id ?? ''),
        kind: source.eventKind ?? source.kind,
        salience: source.salience,
        status: source.status,
        l2GatePass: source.l2GatePass,
      }, { manifest });
    }
  }
  const record = buildDistillRecord({
    topic, period, sources, grade, trigger, reason, by, now, requiredFields, important, whoCandidates,
  });
  const index = readChainIndex(memoryRoot);
  const entry = readIndexEntry(memoryRoot, record.id);
  const fileName = entry?.file ?? chainFileName({ topic, period });
  const file = chainFilePathOf(memoryRoot, record.id, fileName);
  const versions = readVersions(file);
  const last = versions.at(-1) ?? null;
  if (last && last.contentHash === record.contentHash) {
    return {
      ok: true,
      status: 'already-distilled',
      id: record.id,
      version: last.version,
      activeVersion: entry?.activeVersion ?? last.version,
      file,
      record: last,
      wrote: false,
    };
  }
  record.version = last ? last.version + 1 : 1;
  record.prevVersion = last ? `${record.id}@v${last.version}` : null;
  record.audit.createdAt = now.toISOString();
  record.contentHash = contentHashOf(canonicalContent(record));
  appendVersionLine({ file, record });
  setActiveVersion({
    root: memoryRoot,
    id: record.id,
    file,
    version: record.version,
    versionCount: versions.length + 1,
    contentHash: record.contentHash,
    now,
  });
  appendChainLog({
    root: memoryRoot,
    op: 'distill',
    id: record.id,
    file,
    fromVersion: last?.version ?? null,
    toVersion: record.version,
    by,
    reason,
    contentHash: record.contentHash,
    now,
  });
  try {
    appendAuditRecord({
      memoryRoot,
      action: 'distill',
      recordId: record.id,
      readerTier: 'host',
      questionId: 'unknown',
      expectedTurns: null,
      answerText: null,
      at: now.toISOString(),
      extra: {
        version: record.version,
        prevVersion: record.prevVersion,
        trigger,
        sourceCount: record.sources.length,
        zeroNewFacts: true,
        file: fileName,
      },
    });
  } catch {
    /* 链日志已写；统一审计 best-effort，不让失败吞掉蒸馏结果 */
  }
  return { ok: true, status: 'created', id: record.id, version: record.version, file, record, wrote: true };
}

export function distillHistory({ root, id } = {}) {
  const entry = readIndexEntry(String(root ?? ''), id);
  if (!entry || !entry.file) throw memoryError('E_CHAIN_NOT_FOUND', `没有这个蒸馏 id：${id}`);
  const file = chainFilePathOf(root, id, entry.file);
  const versions = readVersions(file);
  const active = versions.find((row) => row.version === entry.activeVersion) ?? versions.at(-1) ?? null;
  return { id, file, activeVersion: entry.activeVersion, versionCount: versions.length, versions, active };
}

export function distillActive({ root, id } = {}) {
  const history = distillHistory({ root, id });
  return { id, file: history.file, version: history.activeVersion, record: history.active };
}

export function distillDiff({ root, id, fromVersion, toVersion } = {}) {
  const history = distillHistory({ root, id });
  const from = history.versions.find((row) => row.version === fromVersion);
  const to = history.versions.find((row) => row.version === toVersion);
  if (!from || !to) throw memoryError('E_CHAIN_NO_VERSION', `diff 需要存在的 from/to 版本：${id}`);
  return { id, ...diffVersions(from, to) };
}

export function distillRollback({ root, id, toVersion, by = 'admin', reason = '', now = new Date() } = {}) {
  return rollbackVersion({ root, id, toVersion, by, reason, now });
}

export function listDistillIds({ root } = {}) {
  const index = readChainIndex(String(root ?? ''));
  return Object.keys(index.entries).sort();
}

export { DISTILL_DIR, errorMessage };
