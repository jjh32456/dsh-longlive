// src/autoprocedure/candidate.js — 候选文件与 sidecar（D2/D3/D4）。
//
// 候选只写 `<memoryRoot>/.longlive/staging/auto-cards/procedures/<slug>.md`，
// 永不写 `procedures/`。候选正文用 procedure 卡四段格式（lead 可直接读、可抄），
// 每个候选配 `<slug>.meta.json`，schema `autoprocedure-candidate/v1`。
//
// 写入纪律（D3 c3）：禁止裸 writeFileSync 写最终文件——先写 tmp、读回校验、
// 再 rename 到最终名，最后再读回一次。过期（retentionDays 默认 30）只允许在
// staging 内移动（`procedures/archive/`）或仅在 sidecar 标记，任何情况下不得
// 移入 `procedures/`。
//
// 本模块不做删除：失败留下的 tmp 文件是可丢弃残留，不是数据。

import fs from 'node:fs';
import path from 'node:path';

import { dayString } from '../memory/frontmatter.js';
import { sha256Hex } from './session-reader.js';
import { autoProcedurePaths } from './paths.js';

export const CANDIDATE_SCHEMA = 'autoprocedure-candidate/v1';
export const CANDIDATE_SECTIONS = Object.freeze({
  when: '何时用',
  steps: '怎么做',
  failureModes: '失败模式',
  example: '例子',
});
export const OFFSET_SPACE_SUMMARY = Object.freeze({
  session: 'utf8-bytes-decompressed-session',
  d2: 'd2-redacted-file',
});

const EMPTY_SECTION = '（暂无）';

function oneLine(text) {
  return String(text ?? '').replace(/\s+/gu, ' ').trim();
}

/** YAML double-quoted scalar (JSON escaping is valid YAML); keeps ': # [ ]' safe. */
function yamlScalar(text) {
  return JSON.stringify(oneLine(text));
}

/** Four fixed body sections, in the same order as memory/procedure.js. */
export function composeSectionsText(sections) {
  const source = sections && typeof sections === 'object' ? sections : {};
  const steps = Array.isArray(source.steps) && source.steps.length > 0
    ? source.steps.map((step, index) => `${index + 1}. ${oneLine(step)}`)
    : [EMPTY_SECTION];
  const lines = [
    `## ${CANDIDATE_SECTIONS.when}`,
    '',
    String(source.when ?? '').trim() || EMPTY_SECTION,
    '',
    `## ${CANDIDATE_SECTIONS.steps}`,
    '',
    ...steps,
    '',
    `## ${CANDIDATE_SECTIONS.failureModes}`,
    '',
    String(source.failureModes ?? '').trim() || EMPTY_SECTION,
    '',
    `## ${CANDIDATE_SECTIONS.example}`,
    '',
    String(source.example ?? '').trim() || EMPTY_SECTION,
  ];
  return `${lines.join('\n')}\n`;
}

/** Candidate card text: procedure-compatible frontmatter + the four sections. */
export function composeCandidateMarkdown({ name, trigger, salience = 3, strength = 3, lastUsed, sections }) {
  const items = Array.isArray(trigger) ? trigger : [];
  const head = [
    '---',
    `name: ${yamlScalar(name)}`,
    `trigger: [${items.map((item) => yamlScalar(item)).join(', ')}]`,
    `salience: ${salience}`,
    `strength: ${strength}`,
    `last_used: ${oneLine(lastUsed)}`,
    `revisions: 0`,
    '---',
  ];
  return `${head.join('\n')}\n\n${composeSectionsText(sections)}`;
}

/** Fixed evidence field set written to the sidecar (unknown keys are dropped). */
const EVIDENCE_FIELDS = Object.freeze([
  'step', 'sessionId', 'turn', 'seqStart', 'seqEnd', 'turnDigest',
  'excerptSha256', 'excerptOffset', 'excerptLen', 'from', 'offsetSpace',
  'callId', 'd2RelPath', 'sourceSha256', 'redactedSha256',
]);

function pickEvidenceFields(evidence) {
  const out = {};
  if (!evidence || typeof evidence !== 'object') return out;
  for (const key of EVIDENCE_FIELDS) {
    if (evidence[key] !== undefined) out[key] = evidence[key];
  }
  return out;
}

/** The sidecar object; every field is written in a fixed order (schema v1). */
export function buildSidecar({
  slug,
  createdAt,
  risk = 'low',
  generator = 'rules',
  source,
  evidence,
  llm = { used: false, model: null, tokens: { in: 0, out: 0 } },
  lint,
  retentionDays = 30,
  now = new Date(),
}) {
  const created = createdAt ?? (now instanceof Date ? now.toISOString() : new Date(now).toISOString());
  const baseMs = Date.parse(created);
  const expiresAt = Number.isFinite(baseMs)
    ? new Date(baseMs + Math.max(1, retentionDays) * 24 * 60 * 60 * 1000).toISOString()
    : created;
  const ev = Array.isArray(evidence) ? evidence : [];
  const first = ev[0] ?? {};
  return {
    schema: CANDIDATE_SCHEMA,
    slug,
    createdAt: created,
    risk: risk === 'high' ? 'high' : 'low',
    generator: generator === 'llm' ? 'llm' : 'rules',
    source: {
      sessionId: source?.sessionId ?? first.sessionId ?? '',
      turn: source?.turn ?? first.turn ?? null,
      seqStart: source?.seqStart ?? first.seqStart ?? null,
      seqEnd: source?.seqEnd ?? first.seqEnd ?? null,
      turnDigest: source?.turnDigest ?? first.turnDigest ?? null,
    },
    // N5: 每条证据自带 offsetSpace；这里再显式列一次两种来源的坐标空间。
    offsetSpaces: { ...OFFSET_SPACE_SUMMARY },
    evidence: ev.map((item) => pickEvidenceFields(item)),
    llm: {
      used: llm?.used === true,
      model: typeof llm?.model === 'string' && llm.model !== '' ? llm.model : null,
      tokens: {
        in: Number.isInteger(llm?.tokens?.in) ? llm.tokens.in : 0,
        out: Number.isInteger(llm?.tokens?.out) ? llm.tokens.out : 0,
      },
    },
    lint: {
      at: lint?.at ?? created,
      verdict: lint?.verdict === 'pass' ? 'pass' : 'issues',
      issues: Array.isArray(lint?.issues)
        ? lint.issues.map((issue) => ({
          code: String(issue?.code ?? 'ISSUE'),
          step: Number.isInteger(issue?.step) ? issue.step : 0,
          reason: String(issue?.reason ?? ''),
        }))
        : [],
    },
    reviewer: { kind: 'none', at: null, verdict: 'none', issues: [] },
    expiresAt,
    promotedAt: null,
    promotedBy: null,
  };
}

const ALLOWED_OFFSET_SPACES = Object.freeze(Object.values(OFFSET_SPACE_SUMMARY));

/**
 * D3：sidecar 顶层的 offsetSpaces 汇总只允许两个已知坐标空间，且每条证据的
 * offsetSpace 必须与它的来源一致。未知值一律拒绝写候选（不静默改写）。
 */
function checkOffsetSpaces(sidecar) {
  const summary = sidecar?.offsetSpaces;
  if (!summary || typeof summary !== 'object') {
    return { ok: false, code: 'E_AP_OFFSET_SPACE', detail: 'sidecar.offsetSpaces missing' };
  }
  const keys = Object.keys(summary).sort();
  if (keys.join(',') !== 'd2,session') {
    return { ok: false, code: 'E_AP_OFFSET_SPACE', detail: `unexpected offsetSpaces keys: ${keys.join(',')}` };
  }
  for (const [from, value] of Object.entries(summary)) {
    if (!ALLOWED_OFFSET_SPACES.includes(value)) {
      return { ok: false, code: 'E_AP_OFFSET_SPACE', detail: `unknown offsetSpace for ${from}: ${JSON.stringify(value)}` };
    }
    if (value !== OFFSET_SPACE_SUMMARY[from]) {
      return { ok: false, code: 'E_AP_OFFSET_SPACE', detail: `offsetSpaces.${from} does not match the fixed summary` };
    }
  }
  const evidence = Array.isArray(sidecar?.evidence) ? sidecar.evidence : [];
  for (const item of evidence) {
    const expected = item?.from === 'session'
      ? OFFSET_SPACE_SUMMARY.session
      : item?.from === 'd2'
        ? OFFSET_SPACE_SUMMARY.d2
        : null;
    if (expected === null || item.offsetSpace !== expected) {
      return { ok: false, code: 'E_AP_OFFSET_SPACE', detail: `evidence step ${item?.step ?? '?'} offsetSpace mismatch` };
    }
  }
  return { ok: true };
}

function tmpName(file, tag = '') {
  return `${file}.tmp-${process.pid}-${Date.now().toString(36)}${tag}`;
}

function writeTmp(file, text) {
  const tmp = tmpName(file);
  fs.writeFileSync(tmp, text, 'utf8');
  return tmp;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Write `.md` + `.meta.json` with tmp→rename→read-back verification.
 * Returns `{ok:true, slug, mdRel, metaRel, mdSha256, metaSha256}` or a coded
 * failure. Never deletes anything; a failed write leaves no final files.
 */
export function writeCandidate({ memoryRoot, candidate, sidecar, now = new Date() }) {
  const paths = autoProcedurePaths(memoryRoot);
  const slug = sidecar.slug;
  // A slug is a file stem: no separators, no '..', no leading dot. Derived only
  // from sessionId/turn (never user text), but validated here all the same.
  if (typeof slug !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(slug) || slug.includes('..') || slug.startsWith('.')) {
    return { ok: false, code: 'E_AP_SLUG', detail: `非法候选 slug：${JSON.stringify(slug)}` };
  }
  const spaces = checkOffsetSpaces(sidecar);
  if (!spaces.ok) return spaces;
  const mdFile = path.join(paths.staging, `${slug}.md`);
  const metaFile = path.join(paths.staging, `${slug}.meta.json`);
  const mdText = composeCandidateMarkdown({
    name: candidate.name,
    trigger: candidate.trigger,
    salience: candidate.salience ?? 3,
    strength: candidate.strength ?? 3,
    lastUsed: candidate.lastUsed ?? dayString(now instanceof Date ? now : new Date(now)),
    sections: candidate.sections,
  });
  const metaText = `${JSON.stringify(sidecar, null, 2)}\n`;
  try {
    fs.mkdirSync(paths.staging, { recursive: true });
    const mdTmp = writeTmp(mdFile, mdText);
    const metaTmp = writeTmp(metaFile, metaText);
    // Prove the tmp files before either final name exists.
    if (readText(mdTmp) !== mdText) return { ok: false, code: 'E_AP_WRITE_VERIFY', detail: 'md tmp read-back mismatch' };
    if (readText(metaTmp) !== metaText) return { ok: false, code: 'E_AP_WRITE_VERIFY', detail: 'meta tmp read-back mismatch' };
    fs.renameSync(metaTmp, metaFile);
    fs.renameSync(mdTmp, mdFile);
    // Final read-back: candidate + sidecar must parse and agree.
    const readBack = readText(mdFile);
    const metaBack = readText(metaFile);
    if (readBack !== mdText || metaBack !== metaText) return { ok: false, code: 'E_AP_WRITE_VERIFY', detail: 'final read-back mismatch' };
    const parsed = JSON.parse(metaBack);
    if (parsed?.schema !== CANDIDATE_SCHEMA || parsed?.slug !== slug || !Array.isArray(parsed?.evidence)) {
      return { ok: false, code: 'E_AP_WRITE_VERIFY', detail: 'sidecar schema mismatch' };
    }
    if (!readBack.includes(`## ${CANDIDATE_SECTIONS.when}`) || !readBack.includes(`## ${CANDIDATE_SECTIONS.steps}`)) {
      return { ok: false, code: 'E_AP_WRITE_VERIFY', detail: 'candidate body format mismatch' };
    }
    return {
      ok: true,
      slug,
      mdFile,
      metaFile,
      mdRel: path.posix.join('.longlive/staging/auto-cards/procedures', `${slug}.md`),
      metaRel: path.posix.join('.longlive/staging/auto-cards/procedures', `${slug}.meta.json`),
      mdSha256: sha256Hex(mdText),
      metaSha256: sha256Hex(metaText),
    };
  } catch (error) {
    return { ok: false, code: 'E_AP_WRITE_IO', detail: String(error?.message ?? error) };
  }
}

/** Read every staged sidecar (md may be missing if a writer failed mid-way). */
export function listStagedCandidates(memoryRoot) {
  const paths = autoProcedurePaths(memoryRoot);
  let entries;
  try {
    entries = fs.readdirSync(paths.staging, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.meta.json')) continue;
    const slug = entry.name.slice(0, -'.meta.json'.length);
    const metaFile = path.join(paths.staging, entry.name);
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (!meta || meta.schema !== CANDIDATE_SCHEMA) continue;
      out.push({
        slug,
        meta,
        mdFile: path.join(paths.staging, `${slug}.md`),
        metaFile,
        mdPresent: fs.existsSync(path.join(paths.staging, `${slug}.md`)),
      });
    } catch {
      /* a corrupt sidecar is skipped, never rewritten */
    }
  }
  out.sort((left, right) => String(left.slug).localeCompare(String(right.slug)));
  return out;
}

/**
 * Retention: expired candidates move to `procedures/archive/` INSIDE staging.
 * Never moves into `procedures/`; never deletes; corrupt sidecars are skipped.
 */
export function applyRetention({ memoryRoot, now = new Date(), retentionDays = null }) {
  const paths = autoProcedurePaths(memoryRoot);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const candidates = listStagedCandidates(memoryRoot);
  const moved = [];
  const skipped = [];
  for (const item of candidates) {
    const expiresAt = Date.parse(item.meta?.expiresAt ?? '');
    if (!Number.isFinite(expiresAt) || expiresAt > nowMs) continue;
    if (!item.mdPresent) {
      skipped.push({ slug: item.slug, reason: 'md-missing' });
      continue;
    }
    try {
      fs.mkdirSync(paths.stagingArchive, { recursive: true });
      const suffix = `.expired-${nowMs.toString(36)}`;
      const mdTarget = path.join(paths.stagingArchive, `${item.slug}${suffix}.md`);
      const metaTarget = path.join(paths.stagingArchive, `${item.slug}${suffix}.meta.json`);
      fs.renameSync(item.mdFile, mdTarget);
      fs.renameSync(item.metaFile, metaTarget);
      moved.push({ slug: item.slug, to: path.posix.join('.longlive/staging/auto-cards/procedures/archive', path.basename(mdTarget)) });
    } catch (error) {
      skipped.push({ slug: item.slug, reason: String(error?.code ?? error?.message ?? error) });
    }
  }
  return { moved, skipped, retentionDays };
}
