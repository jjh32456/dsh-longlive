/**
 * lifecycle 迁移（1.8.11 D1/D7）。
 *
 * 把「哪张卡是当前正典」写成卡片 frontmatter 的 lifecycle 字段
 * （canonical | historical），**绝不改 status**、绝不改 status 枚举、绝不写第二套
 * 权威/状态机（D6/E6）。旧说法原文不删：整卡能降级就整卡降级，整卡不能降级（还载着
 * 大量现行口径）就把旧段原文移入独立历史卡，原行换成回指行 —— 每一步都备份、都可回滚。
 *
 * 迁移映射文件：src/memory/lifecycle-plan.json（schema lifecycle-plan/v1）。
 * 备份与 manifest：<memoryRoot>/.longlive/lifecycle-migrations/<stamp>/。
 *
 * 真库只读：本模块只接受调用方显式给的 memoryRoot；apply/rollback 的验证只在临时副本
 * （dryRunLifecycleMigration 会自动复制）上进行，真库 apply 由上层（lead 批准后）决定。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { memoryRootFromConfig, resolveInside, relativePath } from './paths.js';
import { parseFrontmatter, serializeFrontmatter, updateExtras, normalizedBody } from './frontmatter.js';
import { memoryIndex } from './index.js';
import { memoryRecall } from './recall.js';
import { memoryReinforce } from './reinforce.js';
import { memoryConsolidate } from './consolidate.js';
import {
  LONGLIVE_DIR,
  stampToken,
  sha256File,
  sha256Text,
  ensureDir,
  backupInto,
  restoreBackup,
  writeFileAtomic,
  appendAudit,
} from './state.js';
import { readLifecycleFromText, readCardLifecycle, LIFECYCLE_VALUES } from './lifecycle.js';
import {
  edgesPaths,
  normalizeEdge,
  dedupeEdges,
  symmetrizeEdges,
  serializeEdges,
  EDGE_TYPES,
} from '../recall/edges.js';

export const MIGRATION_SCHEMA = 'lifecycle-migration/v1';
export const PLAN_SCHEMA = 'lifecycle-plan/v1';
export const MIGRATIONS_DIR = '.longlive/lifecycle-migrations';
export const LIFECYCLE_INDEX_BEGIN = '<!-- LIFECYCLE-BEGIN -->';
export const LIFECYCLE_INDEX_END = '<!-- LIFECYCLE-END -->';
export const DEFAULT_PLAN_FILE = 'lifecycle-plan.json';

/** 迁移会备份/恢复的 .longlive 状态文件（存在才备）。 */
export const STATE_FILES = Object.freeze([
  '.longlive/memory-state.json',
  '.longlive/audit.log',
  '.longlive/manifest.json',
  '.longlive/index-freshness.json',
]);

const COPY_ROOT_FILES = Object.freeze(['INDEX.md', 'STATE.md']);
// 1.8.11 D7（红队 R11 P1-5）：生产召回默认 dirs = topics + handover；副本必须带 handover，
// 否则 dry-run 的下游 recall 没有生产代表性（handover 里同样有旧口径卡）。
const COPY_ROOT_DIRS = Object.freeze(['topics', 'journal', 'procedures', 'handover']);
const COPY_LONGLIVE_FILES = Object.freeze([
  '.longlive/memory-state.json',
  '.longlive/audit.log',
  '.longlive/manifest.json',
  '.longlive/index-freshness.json',
  '.longlive/recall/links.jsonl',
  '.longlive/recall/links-audit.jsonl',
  '.longlive/recall/edges.jsonl',
]);

function memoryError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function collapse(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 红队 R12 P2-2：legacyQuote 必须与来源「整行原文」逐字比对。
 * 只规范行尾（去掉 CR 与尾随空白）；行内每个字符都要相等，不看子串。
 */
function normalizeQuoteLine(value) {
  return String(value ?? '').replace(/\r$/, '').replace(/\s+$/, '');
}

function relAbs(root, rel) {
  if (typeof rel !== 'string' || rel.trim() === '') {
    throw memoryError('E_BAD_ARGUMENT', '迁移路径必须是非空字符串');
  }
  const abs = path.resolve(root, rel);
  resolveInside(root, abs);
  return abs;
}

function readTextOrNull(abs) {
  try {
    if (!fs.statSync(abs).isFile()) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function lineOfText(text, n) {
  const lines = String(text ?? '').split(/\r?\n/);
  return Number.isInteger(n) && n >= 1 && n <= lines.length ? lines[n - 1] : null;
}

function eolOf(text) {
  return String(text ?? '').includes('\r\n') ? '\r\n' : '\n';
}

/**
 * 宽容拆 frontmatter / body（不再调用 parseFrontmatter：块状列表卡会抛
 * E_FRONTMATTER_MULTILINE，迁移只做字节级改写，不需要 strict 解析）。
 * bodyStartLine 是 body 第一行在整份文件里的 1-based 行号。
 */
function splitFrontmatterText(text) {
  const value = String(text ?? '');
  const bom = value.startsWith('\uFEFF') ? '\uFEFF' : '';
  const rest = value.slice(bom.length);
  const lines = [];
  const separators = [];
  let pos = 0;
  while (pos <= rest.length) {
    const match = /([^\r\n]*)(\r\n|\n|\r)?/.exec(rest.slice(pos));
    if (!match || (match[0] === '' && pos === rest.length && lines.length > 0)) break;
    lines.push(match[1]);
    const end = pos + match[0].length;
    separators.push(match[2] ?? '');
    if (end >= rest.length) break;
    pos = end;
  }
  const crlfCount = separators.filter((sep) => sep === '\r\n').length;
  const lfCount = separators.filter((sep) => sep === '\n').length;
  const eol = crlfCount > lfCount ? '\r\n' : '\n';
  const joinFrom = (index) => lines.slice(index).map((line, offset) => `${line}${separators[index + offset] ?? ''}`).join('');
  let hasFrontmatter = false;
  let close = -1;
  if (lines[0] !== undefined && lines[0].trim() === '---') {
    for (let index = 1; index < lines.length; index += 1) {
      if (lines[index].trim() === '---') {
        close = index;
        break;
      }
    }
    hasFrontmatter = close > 0;
  }
  const bodyStartLine = hasFrontmatter ? close + 2 : 1;
  return {
    bom,
    eol,
    hasFrontmatter,
    lines,
    separators,
    fmLines: hasFrontmatter ? lines.slice(1, close) : [],
    body: hasFrontmatter ? joinFrom(close + 1) : rest,
    bodyStartLine,
  };
}

function frontmatterKeyOf(line) {
  const match = /^([A-Za-z_][\w-]*)\s*:/.exec(String(line ?? '').trim());
  return match ? match[1] : null;
}

function statusFromFmLines(fmLines) {
  for (const line of fmLines ?? []) {
    if (frontmatterKeyOf(line) !== 'status') continue;
    const value = String(line).split(':').slice(1).join(':').trim().replace(/^["']|["']$/g, '');
    return value || 'active';
  }
  return 'active';
}

/**
 * 组合目标文本：frontmatter 只允许 lifecycle 变化（无 frontmatter 的卡只写 lifecycle，
 * 不注入 salience/strength/revisions 等默认字段 —— 红队 R12-R2 P2-1），body 用快照替换结果。
 */
function composeCardText(parsed, lifecycle, body) {
  const eol = parsed.eol;
  const fmLines = parsed.fmLines.slice();
  if (lifecycle != null) {
    const index = fmLines.findIndex((line) => frontmatterKeyOf(line) === 'lifecycle');
    if (index >= 0) fmLines[index] = `lifecycle: ${lifecycle}`;
    else fmLines.push(`lifecycle: ${lifecycle}`);
  }
  const block = fmLines.length > 0 ? `---${eol}${fmLines.join(eol)}${eol}---${eol}` : '';
  const keys = fmLines.map(frontmatterKeyOf).filter(Boolean);
  return {
    text: `${parsed.bom}${block}${body}`,
    fmLines,
    keys,
    frontmatterAdded: !parsed.hasFrontmatter && lifecycle != null,
  };
}

/** 在快照 body 上按 plan 行号替换（行号是快照 body 内的 0-based 下标，保留原始行尾）。 */
function bodyLinesWithReplacements(snapshot, replacements) {
  const bodyLines = (snapshot.lines ?? []).slice(snapshot.bodyStartLine - 1);
  const separators = (snapshot.separators ?? []).slice(snapshot.bodyStartLine - 1);
  for (const rep of replacements) {
    if (!Number.isInteger(rep.bodyLineIndex) || rep.bodyLineIndex < 0 || rep.bodyLineIndex >= bodyLines.length) {
      return { ok: false, reason: `行号越界：${rep.id} bodyLineIndex=${rep.bodyLineIndex}（body 共 ${bodyLines.length} 行）` };
    }
    bodyLines[rep.bodyLineIndex] = rep.replaceWith;
  }
  const body = bodyLines.map((line, index) => `${line}${separators[index] ?? ''}`).join('');
  return { ok: true, body };
}

export function defaultPlanPath() {
  return fileURLToPath(new URL(`./${DEFAULT_PLAN_FILE}`, import.meta.url));
}

/**
 * 1.8.12 隐私修复：npm 包不再随附 lifecycle-plan.json（它逐字包含真实记忆内容）。
 * 默认计划解析顺序：显式 --plan > <memoryRoot>/.longlive/lifecycle-plan.json > 包内默认（仅仓库内存在）。
 */
export function resolveDefaultPlanPath({ memoryRoot = '', planPath = null } = {}) {
  if (planPath) return planPath;
  if (memoryRoot) {
    const rooted = path.join(memoryRoot, LONGLIVE_DIR, DEFAULT_PLAN_FILE);
    if (fs.existsSync(rooted)) return rooted;
  }
  return defaultPlanPath();
}

export function migrationsDir(root) {
  return resolveInside(root, path.join(LONGLIVE_DIR, 'lifecycle-migrations'));
}

/** 校验 plan 文件形状；只接受 lifecycle-plan/v1。 */
export function loadLifecyclePlan(planPath = defaultPlanPath()) {
  const abs = path.resolve(planPath);
  let text = null;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (error) {
    throw memoryError('E_PLAN_MISSING', `lifecycle 迁移映射文件不存在：${abs}`, error);
  }
  let plan = null;
  try {
    plan = JSON.parse(text);
  } catch (error) {
    throw memoryError('E_PLAN_INVALID', `lifecycle 迁移映射不是合法 JSON：${abs}`, error);
  }
  validatePlan(plan);
  return { plan, path: abs, sha256: sha256Text(text) };
}

function assertPlanRel(rel, label) {
  if (typeof rel !== 'string' || !rel.trim()) {
    throw memoryError('E_PLAN_INVALID', `${label} 缺失`);
  }
  const value = rel.trim();
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith('/') || value.includes('\\')) {
    throw memoryError('E_PLAN_INVALID', `${label} 必须是 posix 相对路径（不许绝对路径/反斜杠）：${rel}`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw memoryError('E_PLAN_INVALID', `${label} 含非法路径段：${rel}`);
  }
  return value;
}

function assertSingleLine(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw memoryError('E_PLAN_INVALID', `${label} 必须是非空字符串`);
  }
  if (/[\r\n]/.test(value)) throw memoryError('E_PLAN_INVALID', `${label} 必须是单行文本（不许换行）`);
  return value;
}

function assertIsoOrNull(value, label) {
  if (value == null) return;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw memoryError('E_PLAN_INVALID', `${label} 必须是 ISO 时间字符串：${value}`);
  }
}

function assertEvidenceShape(evidence, label) {
  if (!evidence || typeof evidence !== 'object') {
    throw memoryError('E_PLAN_INVALID', `${label}.evidence 缺失`);
  }
  assertPlanRel(evidence.path, `${label}.evidence.path`);
  assertSingleLine(evidence.quote, `${label}.evidence.quote`);
  if (evidence.lines != null) {
    const lines = Array.isArray(evidence.lines) ? evidence.lines.map(Number) : null;
    if (!lines || lines.length !== 2 || !Number.isInteger(lines[0]) || !Number.isInteger(lines[1]) || lines[0] < 1 || lines[1] < lines[0]) {
      throw memoryError('E_PLAN_INVALID', `${label}.evidence.lines 必须是 [start,end] 且 1 ≤ start ≤ end`);
    }
  }
  if (evidence.sha256 != null && (typeof evidence.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(evidence.sha256))) {
    throw memoryError('E_PLAN_INVALID', `${label}.evidence.sha256 必须是 64 位 hex`);
  }
}

/**
 * 校验 plan 文件形状；只接受 lifecycle-plan/v1。
 *
 * 红队 R11 P1-1：这里必须 fail-closed —— 枚举、路径、字段完整性都要在 validatePlan 就拒绝，
 * 不能等到 apply 才默认成 'historical' 或让非法 lifecycle 静默落盘。
 */
export function validatePlan(plan) {  if (!plan || typeof plan !== 'object' || plan.schema !== PLAN_SCHEMA) {
    throw memoryError('E_PLAN_INVALID', `plan.schema 必须是 ${PLAN_SCHEMA}`);
  }
  if (!Array.isArray(plan.cards)) throw memoryError('E_PLAN_INVALID', 'plan.cards 必须是数组');
  if (!Array.isArray(plan.extracts)) throw memoryError('E_PLAN_INVALID', 'plan.extracts 必须是数组');
  if (!Array.isArray(plan.edges)) throw memoryError('E_PLAN_INVALID', 'plan.edges 必须是数组');
  assertIsoOrNull(plan.generated_at, 'plan.generated_at');
  const cardRels = new Set();
  for (const card of plan.cards) {
    if (!card || typeof card !== 'object') throw memoryError('E_PLAN_INVALID', 'plan.cards[] 必须是对象');
    const rel = assertPlanRel(card.rel, 'plan.cards[].rel');
    if (cardRels.has(rel)) throw memoryError('E_PLAN_INVALID', `plan.cards rel 重复：${rel}`);
    cardRels.add(rel);
    if (!LIFECYCLE_VALUES.includes(card.lifecycle)) {
      throw memoryError('E_PLAN_INVALID', `plan.cards[${rel}].lifecycle 非法：${card.lifecycle}`);
    }
    if (card.reason != null && typeof card.reason !== 'string') {
      throw memoryError('E_PLAN_INVALID', `plan.cards[${rel}].reason 必须是字符串`);
    }
    assertEvidenceShape(card.evidence, `plan.cards[${rel}]`);
  }
  const seen = new Set();
  for (const extract of plan.extracts) {
    if (!extract || typeof extract !== 'object') throw memoryError('E_PLAN_INVALID', 'plan.extracts[] 必须是对象');
    if (typeof extract.id !== 'string' || !extract.id) {
      throw memoryError('E_PLAN_INVALID', 'plan.extracts[].id 缺失');
    }
    if (seen.has(extract.id)) throw memoryError('E_PLAN_INVALID', `plan.extracts id 重复：${extract.id}`);
    seen.add(extract.id);
    const fromRel = assertPlanRel(extract.fromRel, `plan.extracts[${extract.id}].fromRel`);
    const extractLines = Array.isArray(extract.lines) ? extract.lines.map(Number) : null;
    const singleLine = extractLines && (extractLines.length === 1
      || (extractLines.length === 2 && extractLines[0] === extractLines[1]));
    if (!singleLine || !Number.isInteger(extractLines[0]) || extractLines[0] < 1) {
      throw memoryError('E_PLAN_INVALID', `plan.extracts[${extract.id}] 需要单行 fromRel/lines（如 [65,65]）`);
    }
    assertSingleLine(extract.quote, `plan.extracts[${extract.id}].quote`);
    assertSingleLine(extract.replaceWith, `plan.extracts[${extract.id}].replaceWith`);
    if (extract.legacyQuote != null) {
      if (typeof extract.legacyQuote !== 'string' || !extract.legacyQuote.trim()) {
        throw memoryError('E_PLAN_INVALID', `plan.extracts[${extract.id}].legacyQuote 必须是非空字符串（历史卡要收录的来源整行原文）`);
      }
      if (/[\r\n]/.test(extract.legacyQuote)) {
        throw memoryError('E_PLAN_INVALID', `plan.extracts[${extract.id}].legacyQuote 必须来自单行来源（不许换行）`);
      }
    }
    if (extract.sourceHandling != null && !['pointer', 'annotated'].includes(extract.sourceHandling)) {
      throw memoryError('E_PLAN_INVALID', `plan.extracts[${extract.id}].sourceHandling 只能是 pointer / annotated`);
    }
    if (extract.legacyNote != null && typeof extract.legacyNote !== 'string') {
      throw memoryError('E_PLAN_INVALID', `plan.extracts[${extract.id}].legacyNote 必须是字符串`);
    }
    const targetRel = assertPlanRel(extract.targetCard?.rel, `plan.extracts[${extract.id}].targetCard.rel`);
    // 红队 P1-1 根因：targetCard.lifecycle 不校验枚举 → 'bogus' 也能静默落盘。
    const targetLifecycle = extract.targetCard?.lifecycle ?? 'historical';
    if (!LIFECYCLE_VALUES.includes(targetLifecycle)) {
      throw memoryError('E_PLAN_INVALID', `plan.extracts[${extract.id}].targetCard.lifecycle 非法：${extract.targetCard?.lifecycle}`);
    }
    if (targetRel === fromRel) {
      throw memoryError('E_PLAN_INVALID', `plan.extracts[${extract.id}] 的来源与目标卡相同：${fromRel}`);
    }
    void fromRel;
  }
  for (const edge of plan.edges) {
    if (!edge || typeof edge !== 'object') throw memoryError('E_PLAN_INVALID', 'plan.edges[] 必须是对象');
    assertPlanRel(edge.from, 'plan.edges[].from');
    assertPlanRel(edge.to, 'plan.edges[].to');
    if (edge.from === edge.to) throw memoryError('E_PLAN_INVALID', `plan.edges[] from === to：${edge.from}`);
    if (typeof edge.type !== 'string' || !EDGE_TYPES.includes(edge.type)) {
      throw memoryError('E_PLAN_INVALID', `plan.edges[] type 非法：${edge.type}`);
    }
    if (edge.confidence != null && (typeof edge.confidence !== 'number' || edge.confidence < 0 || edge.confidence > 1)) {
      throw memoryError('E_PLAN_INVALID', `plan.edges[] confidence 必须是 0..1 数字`);
    }
    assertIsoOrNull(edge.created_at, 'plan.edges[].created_at');
    assertEvidenceShape(edge.evidence, 'plan.edges[]');
  }
  return true;
}

/** 证据校验：路径存在、行号在范围内、引文在那些行里逐字出现（空白折叠后）。 */
/** plan 的规范序列化（与 loadLifecyclePlan 落盘格式一致：2 空格 + 结尾换行）。 */
function canonicalPlanText(plan) {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

/** 给定 plan 的合法 sha256 候选（规范序列化 / 无尾换行）。plan 文件形态一致时也接受文件 sha。 */
export function planShaCandidates(plan, planPath = null) {
  const candidates = new Set();
  const canonical = canonicalPlanText(plan);
  const compact = JSON.stringify(plan, null, 2);
  candidates.add(sha256Text(canonical));
  candidates.add(sha256Text(compact));
  // 红队 R12 P2-1：只有 plan 文件字节确实等于同一 plan 的序列化时才接受文件 sha；
  // 否则调用方可以指向任意文件、拿它的 sha 去「验证」一个被篡改过的 plan 对象。
  if (planPath != null) {
    const abs = path.resolve(planPath);
    if (fs.existsSync(abs)) {
      const fileText = fs.readFileSync(abs, 'utf8');
      if (fileText === canonical || fileText === compact) candidates.add(sha256File(abs));
    }
  }
  return candidates;
}

/**
 * 红队 R12 P2-1：传了 planSha256 就必须校验，不匹配 fail-closed。
 * 否则调用方可以传一个真 sha 却塞任意篡改过的 plan 对象（replaceWith 写任意内容）。
 */
export function assertPlanSha(plan, planSha256, planPath = null) {
  if (planSha256 == null) return null;
  if (typeof planSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(planSha256)) {
    throw memoryError('E_PLAN_SHA_MISMATCH', `planSha256 格式非法：${JSON.stringify(planSha256)}`);
  }
  const candidates = planShaCandidates(plan, planPath);
  if (!candidates.has(planSha256)) {
    throw memoryError(
      'E_PLAN_SHA_MISMATCH',
      `planSha256 与 plan 内容不匹配：传入 ${planSha256}，实算 ${[...candidates][0]}`,
    );
  }
  return planSha256;
}

export function checkEvidence(root, evidence) {
  if (!evidence || typeof evidence !== 'object' || typeof evidence.path !== 'string') {
    return { ok: false, code: 'E_EVIDENCE_MISSING', detail: 'evidence.path 缺失' };
  }
  let abs = null;
  try {
    abs = relAbs(root, evidence.path);
  } catch (error) {
    return { ok: false, code: error.code ?? 'E_EVIDENCE_PATH', detail: error.message };
  }
  const text = readTextOrNull(abs);
  if (text == null) return { ok: false, code: 'E_EVIDENCE_MISSING_FILE', detail: `证据文件不存在：${evidence.path}` };
  const lines = text.split(/\r?\n/);
  const range = Array.isArray(evidence.lines) && evidence.lines.length === 2
    ? evidence.lines.map(Number)
    : [1, lines.length];
  const [start, end] = range;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) {
    return { ok: false, code: 'E_EVIDENCE_LINES', detail: `行号越界：${evidence.path}:${start}-${end}（共 ${lines.length} 行）` };
  }
  const quote = collapse(evidence.quote);
  const hay = collapse(lines.slice(start - 1, end).join('\n'));
  if (!quote) return { ok: false, code: 'E_EVIDENCE_QUOTE', detail: 'evidence.quote 缺失' };
  if (!hay.includes(quote)) {
    return {
      ok: false,
      code: 'E_EVIDENCE_MISMATCH',
      detail: `引文未在 ${evidence.path}:${start}-${end} 逐字出现`,
      actual: hay.slice(0, 240),
    };
  }
  return { ok: true, path: evidence.path, lines: [start, end], quote, sha256: sha256Text(text) };
}

function planCardActions(root, plan) {
  const actions = [];
  for (const card of plan.cards) {
    const action = {
      rel: card.rel,
      desired: card.lifecycle,
      reason: card.reason ?? '',
      status: 'pending',
      current: null,
      sha256Before: null,
      evidence: checkEvidence(root, card.evidence),
    };
    const abs = relAbs(root, card.rel);
    const text = readTextOrNull(abs);
    if (text == null) {
      action.status = 'missing-card';
      actions.push(action);
      continue;
    }
    action.sha256Before = sha256Text(text);
    const current = readLifecycleFromText(text);
    action.current = current;
    // 红队 R12 P2-7：已迁移状态（lifecycle 已是期望值）一律 already，不再因证据行号漂移改判
    // evidence-mismatch —— 否则二次 apply 会报 blocker，迁移动词不幂等。
    if (current === card.lifecycle) action.status = 'already';
    else if (current != null && current !== card.lifecycle) action.status = 'conflict';
    else action.status = 'pending';
    if (action.status !== 'already' && !action.evidence.ok) action.status = 'evidence-mismatch';
    actions.push(action);
  }
  return actions;
}

function groupExtractTargets(plan) {
  const groups = new Map();
  for (const extract of plan.extracts) {
    const target = extract.targetCard;
    if (!groups.has(target.rel)) groups.set(target.rel, { target, extracts: [] });
    groups.get(target.rel).extracts.push(extract);
  }
  return groups;
}

/**
 * P0（R12-R2）：apply 的「一次快照」阶段。所有读写决策都基于这里拍的原始快照：
 * - cards 与 extracts 命中同一文件时，先在快照 body 上做行替换，再合成 frontmatter（只加 lifecycle）；
 * - 历史卡收录快照的原始整行与原始 sha（provenance 不许记先写 frontmatter 后的 sha）；
 * - 任何前置校验失败都进 failures，apply 直接 fail-closed（E_APPLY_VERIFY），一个字节都不写。
 */
function buildApplyFiles({ root, plan, preview }) {
  const snapshot = new Map();
  const snapOf = (rel) => {
    if (!snapshot.has(rel)) {
      const abs = relAbs(root, rel);
      const text = readTextOrNull(abs);
      snapshot.set(rel, text == null
        ? { rel, exists: false }
        : { rel, exists: true, text, sha256: sha256Text(text), ...splitFrontmatterText(text) });
    }
    return snapshot.get(rel);
  };
  const files = new Map();
  const fileOf = (rel) => {
    if (!files.has(rel)) files.set(rel, { rel, lifecycle: null, replacements: [] });
    return files.get(rel);
  };
  const archive = new Map();
  const targetGroups = groupExtractTargets(plan);
  // preview 的 extract action 只带运行状态字段；quote/reason/sourceHandling 等仍以 plan 为准。
  const extractById = new Map((plan.extracts ?? []).map((item) => [item.id, item]));
  const failures = [];
  const pendingCards = preview.cards.filter((card) => card.status === 'pending');
  const pendingExtracts = preview.extracts.filter((item) => item.status === 'pending');
  const pendingTargets = preview.targets.filter((item) => item.status === 'pending');

  for (const card of pendingCards) {
    const snap = snapOf(card.rel);
    if (!snap.exists) failures.push({ kind: 'card-missing', rel: card.rel });
    else fileOf(card.rel).lifecycle = card.desired;
  }
  for (const extract of pendingExtracts) {
    const spec = extractById.get(extract.id) ?? extract;
    const fromRel = spec.fromRel ?? extract.fromRel;
    const targetRel = extract.targetRel ?? spec.targetCard?.rel ?? null;
    const lineNumber = (spec.lines ?? extract.lines)[0];
    const snap = snapOf(fromRel);
    if (!snap.exists) {
      failures.push({ kind: 'source-missing', rel: fromRel, id: spec.id });
      continue;
    }
    const wholeLine = snap.lines[lineNumber - 1];
    if (wholeLine == null) {
      failures.push({ kind: 'source-line-out-of-range', rel: fromRel, id: spec.id, line: lineNumber });
      continue;
    }
    const archiveQuote = spec.legacyQuote ?? spec.quote;
    const verified = spec.legacyQuote != null
      ? normalizeQuoteLine(wholeLine) === normalizeQuoteLine(archiveQuote)
      : collapse(wholeLine).includes(collapse(archiveQuote));
    if (!verified) {
      failures.push({ kind: 'legacy-line-mismatch', rel: fromRel, id: spec.id, line: lineNumber, expected: collapse(archiveQuote).slice(0, 160) });
      continue;
    }
    if (wholeLine === spec.replaceWith) {
      archive.set(spec.id, { id: spec.id, extract: spec, targetRel, origSha256: snap.sha256, archiveQuote, verified, already: true });
      continue;
    }
    const bodyLineIndex = lineNumber - snap.bodyStartLine;
    if (bodyLineIndex < 0) {
      failures.push({ kind: 'source-line-before-body', rel: fromRel, id: spec.id, line: lineNumber });
      continue;
    }
    fileOf(fromRel).replacements.push({
      id: spec.id,
      bodyLineIndex,
      replaceWith: spec.replaceWith,
      wholeLine,
      oldQuote: spec.quote,
      sourceHandling: spec.sourceHandling ?? 'pointer',
    });
    archive.set(spec.id, { id: spec.id, extract: spec, targetRel, origSha256: snap.sha256, archiveQuote, verified, already: false });
  }

  const outFiles = [];
  for (const file of files.values()) {
    const snap = snapOf(file.rel);
    const replaced = bodyLinesWithReplacements(snap, file.replacements);
    if (!replaced.ok) {
      failures.push({ kind: 'body-replacement', rel: file.rel, detail: replaced.reason });
      continue;
    }
    for (const rep of file.replacements) {
      if (rep.sourceHandling !== 'annotated' && collapse(replaced.body).includes(collapse(rep.oldQuote))) {
        failures.push({ kind: 'old-quote-not-gone', rel: file.rel, id: rep.id, detail: collapse(rep.oldQuote).slice(0, 160) });
      }
    }
    const composed = composeCardText(snap, file.lifecycle, replaced.body);
    // 只允许 frontmatter 新增/改写 lifecycle；其它 key 集合变化即 fail-closed（P2-1）。
    const keysBefore = snap.fmLines.map(frontmatterKeyOf).filter(Boolean);
    const addedKeys = composed.keys.filter((key) => !keysBefore.includes(key));
    const removedKeys = keysBefore.filter((key) => !composed.keys.includes(key));
    if (addedKeys.some((key) => key !== 'lifecycle') || removedKeys.length > 0) {
      failures.push({ kind: 'frontmatter-changed', rel: file.rel, addedKeys, removedKeys });
    }
    outFiles.push({
      rel: file.rel,
      snapshot: snap,
      expectedText: composed.text,
      expectedSha256: sha256Text(composed.text),
      expectedBodySha256: sha256Text(replaced.body),
      frontmatterAdded: composed.frontmatterAdded,
      keysBefore,
      keysAfter: composed.keys,
      statusBefore: statusFromFmLines(snap.fmLines),
      lifecycleAfter: file.lifecycle,
      replacements: file.replacements.map((rep) => ({ ...rep })),
    });
  }

  const outTargets = [];
  for (const target of pendingTargets) {
    const group = targetGroups.get(target.rel);
    const extracts = [...archive.values()].filter((item) => item.targetRel === target.rel);
    if (extracts.length === 0) {
      failures.push({ kind: 'target-without-extracts', rel: target.rel });
      continue;
    }
    const text = buildLegacyCardText({ target: group.target, extracts });
    outTargets.push({
      rel: target.rel,
      lifecycle: group.target.lifecycle ?? 'historical',
      expectedText: text,
      expectedSha256: sha256Text(text),
      extracts: extracts.map((item) => ({
        id: item.id,
        fromRel: item.extract.fromRel,
        origSha256: item.origSha256,
        archiveQuote: item.archiveQuote,
        verified: item.verified,
      })),
    });
  }
  return { ok: failures.length === 0, failures, files: outFiles, targets: outTargets, archive };
}

/**
 * 历史卡正文：来源整行原文从快照取（P0：不许读已改写文件），provenance 记快照的原始 sha。
 * extracts 形如 buildApplyFiles().archive 里的条目：{extract, origSha256, archiveQuote, verified}。
 */
function buildLegacyCardText({ target, extracts }) {
  const fields = {
    title: target.title ?? target.rel,
    date: target.frontmatter?.date,
    tags: target.frontmatter?.tags,
    salience: target.frontmatter?.salience ?? 2,
    strength: target.frontmatter?.strength ?? 2,
  };
  const extras = { lifecycle: target.lifecycle ?? 'historical' };
  const block = serializeFrontmatter(fields, extras, '\n');
  const sections = [];
  for (const item of extracts) {
    const extract = item.extract;
    const handling = extract.legacyNote
      ?? (extract.sourceHandling === 'annotated'
        ? '原文行原位保留并追加更正指针（未删原文）'
        : '原文行已把旧子句换成回指行（其余文字逐字不变）');
    sections.push([
      `## 原文（${extract.fromRel}:${extract.lines[0]}）`,
      '',
      `> ${collapse(item.archiveQuote)}`,
      '',
      `- 迁移前文件 sha256：\`${item.origSha256}\``,
      `- 迁移原因：${collapse(extract.reason)}`,
      `- 原文处理：${collapse(handling)}（历史卡收录整行原文校验：${item.verified ? '通过' : '未通过（本轮校验不通过）'}）`,
    ].join('\n'));
  }
  const header = collapse(target.bodyHeader);
  const parts = [block, ''];
  if (header) parts.push(`> ${header.replace(/^>\s*/, '')}`, '');
  parts.push(sections.join('\n\n'), '');
  return parts.join('\n').replace(/\n{3,}/g, '\n\n');
}

function planExtractActions(root, plan) {
  const actions = [];
  for (const extract of plan.extracts) {
    const action = {
      id: extract.id,
      fromRel: extract.fromRel,
      lines: extract.lines,
      targetRel: extract.targetCard.rel,
      status: 'pending',
      sha256Before: null,
      legacyQuoteOk: null,
      evidence: checkEvidence(root, {
        path: extract.fromRel,
        lines: extract.lines,
        quote: extract.quote,
      }),
    };
    const abs = relAbs(root, extract.fromRel);
    const text = readTextOrNull(abs);
    if (text == null) {
      action.status = 'missing-source';
    } else {
      action.sha256Before = sha256Text(text);
      const line = lineOfText(text, extract.lines[0]);
      // 可选 legacyQuote：历史卡要收录的来源整行原文（M1：整行除旧子句外还有现行事实，
      // 历史卡保留整行原文；来源行只替换旧子句，其余逐字不动）。
      // 红队 R12 P2-2：必须「整行原文」逐字相等（只规范行尾），不再接受子串命中。
      const lineNormalized = line == null ? null : normalizeQuoteLine(line);
      const legacyNormalized = extract.legacyQuote == null ? null : normalizeQuoteLine(extract.legacyQuote);
      const legacyQuoteOk = extract.legacyQuote == null || (line != null && lineNormalized === legacyNormalized);
      action.legacyQuoteOk = extract.legacyQuote == null ? null : legacyQuoteOk;
      // 红队 R12 P2-7：已迁移（来源文件里已出现 replaceWith）时判 already，不因证据行号漂移
      // 报 blocker。P0 之后无 frontmatter 卡会多出 frontmatter 行，行号必漂，必须按内容判断。
      if (collapse(text).includes(collapse(extract.replaceWith))) action.status = 'already';
      else if (!action.evidence.ok || !legacyQuoteOk) action.status = 'evidence-mismatch';
    }
    actions.push(action);
  }
  const targets = [];
  for (const [rel, group] of groupExtractTargets(plan)) {
    const abs = relAbs(root, rel);
    const existing = readTextOrNull(abs);
    let status = 'pending';
    if (existing != null) {
      const current = readLifecycleFromText(existing);
      status = current === (group.target.lifecycle ?? 'historical') ? 'already' : 'conflict';
    }
    const planned = existing == null
      ? { rel, lifecycle: group.target.lifecycle ?? 'historical', title: group.target.title ?? rel }
      : { rel, lifecycle: readLifecycleFromText(existing), title: group.target.title ?? rel };
    targets.push({ ...planned, status, sha256Before: existing == null ? null : sha256Text(existing) });
  }
  return { actions, targets };
}

function planEdgeActions(root, plan) {
  const store = loadExistingEdges(root);
  const actions = [];
  for (const raw of plan.edges) {
    const evidence = checkEvidence(root, raw.evidence);
    const enriched = {
      ...raw,
      created_at: raw.created_at ?? plan.generated_at ?? null,
      evidence: evidence.ok ? { ...raw.evidence, sha256: evidence.sha256 } : raw.evidence,
    };
    const normalized = normalizeEdge(enriched, { memoryRoot: root });
    let status = 'pending';
    const key = normalized ? `${normalized.from}|${normalized.to}|${normalized.type}` : null;
    // 红队 R12 P2-7：plan 边已在 store 里 → already（先于证据校验），否则插入 lifecycle 行
    // 造成的证据行号漂移会让二次 apply 报 evidence-mismatch blocker。
    if (!normalized) status = 'invalid-edge';
    else if (key && store.keys.has(key)) status = 'already';
    else if (!evidence.ok) status = 'evidence-mismatch';
    actions.push({
      from: raw.from,
      to: raw.to,
      type: raw.type,
      status,
      evidence,
      normalized,
    });
  }
  return { actions, existing: store };
}

function loadExistingEdges(root) {
  const paths = edgesPaths(root);
  const text = readTextOrNull(paths.file);
  const edges = [];
  const badLines = [];
  if (text != null) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const raw = JSON.parse(line);
        const normalized = normalizeEdge(raw, { memoryRoot: root });
        if (normalized) edges.push(normalized);
        else badLines.push(line.slice(0, 120));
      } catch {
        badLines.push(line.slice(0, 120));
      }
    }
  }
  return {
    path: paths.file,
    rel: relativePath(root, paths.file),
    present: text != null,
    sha256: text == null ? null : sha256Text(text),
    edges,
    badLines,
    keys: new Set(edges.map((edge) => `${edge.from}|${edge.to}|${edge.type}`)),
  };
}

function countByStatus(list) {
  const counts = {};
  for (const item of list) counts[item.status] = (counts[item.status] ?? 0) + 1;
  return counts;
}

/**
 * plan 模式：只读。给出每张卡/每条抽取/每条边会做什么、证据是否可核。
 * `ok` 只有在没有 conflict / missing / evidence-mismatch 时为 true。
 */
export function planLifecycleMigration({ memoryRoot, plan, planSha256 = null, planPath = null, now = new Date() } = {}) {
  const root = memoryRootFromConfig({ memoryRoot });
  if (!plan || typeof plan !== 'object') throw memoryError('E_PLAN_INVALID', 'plan 缺失');
  validatePlan(plan);
  assertPlanSha(plan, planSha256, planPath);
  const cards = planCardActions(root, plan);
  const extractPlan = planExtractActions(root, plan);
  const edgePlan = planEdgeActions(root, plan);
  const blockers = [];
  for (const list of [cards, extractPlan.actions, extractPlan.targets, edgePlan.actions]) {
    for (const item of list) {
      if (item.status !== 'pending' && item.status !== 'already') blockers.push(item);
    }
  }
  const indexPath = resolveInside(root, 'INDEX.md');
  return {
    ok: blockers.length === 0,
    schema: PLAN_SCHEMA,
    migrationSchema: MIGRATION_SCHEMA,
    mode: 'plan',
    root,
    planSha256,
    now: now.toISOString(),
    cards,
    extracts: extractPlan.actions,
    targets: extractPlan.targets,
    edges: edgePlan.actions,
    edgesStore: { rel: edgePlan.existing.rel, present: edgePlan.existing.present, count: edgePlan.existing.edges.length },
    index: { rel: 'INDEX.md', present: fs.existsSync(indexPath), sha256: fileSha(indexPath) },
    counts: {
      cards: countByStatus(cards),
      extracts: countByStatus(extractPlan.actions),
      targets: countByStatus(extractPlan.targets),
      edges: countByStatus(edgePlan.actions),
      blockers: blockers.length,
    },
    blockers,
    readOnly: true,
  };
}

function fileSha(abs) {
  try {
    return sha256File(abs);
  } catch {
    return null;
  }
}

function migrationStamp(now) {
  return `${stampToken(now)}-${process.pid}`;
}

function backUpFile(root, rel, backupDirRel, backups) {
  const abs = relAbs(root, rel);
  if (!fs.existsSync(abs)) return null;
  const stored = backupInto(root, abs, backupDirRel, { now: new Date() });
  const entry = {
    rel,
    backupRel: stored.rel,
    sha256: stored.sha256,
    bytes: fs.statSync(stored.path).size,
  };
  backups.push(entry);
  return entry;
}

function writeJson(abs, value) {
  fs.writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * apply 模式：备份 → 写 lifecycle → 抽取旧段成历史卡 → 改回指行 → INDEX 注记 → 写 edges → 审计。
 * 任何一步抛错都会留下 manifest 之前的备份（manifest 先写），便于 rollback。
 */
export function applyLifecycleMigration({ memoryRoot, plan, planPath = null, planSha256 = null, now = new Date() } = {}) {
  const root = memoryRootFromConfig({ memoryRoot });
  const preview = planLifecycleMigration({ memoryRoot: root, plan, planSha256, planPath, now });
  if (!preview.ok) {
    throw memoryError('E_PLAN_UNSAFE', `plan 有 ${preview.blockers.length} 个阻塞项，拒绝 apply（先修 plan 或数据）`);
  }
  const alreadyPending = (
    preview.cards.some((card) => card.status === 'pending')
    || preview.extracts.some((item) => item.status === 'pending')
    || preview.targets.some((item) => item.status === 'pending')
    || preview.edges.some((item) => item.status === 'pending')
  );
  if (!alreadyPending) {
    return {
      ok: true,
      schema: MIGRATION_SCHEMA,
      mode: 'apply',
      memoryRoot: root,
      migrationId: null,
      planSha256,
      manifestRel: null,
      backupDirRel: null,
      backups: [],
      created: [],
      applied: { cards: [], extracts: [], targets: [], edges: 0, index: null },
      changed: false,
      alreadyApplied: true,
      readOnly: false,
    };
  }

  // P0（R12-R2）：apply 先拍一次快照、在快照上算好所有目标字节，再统一写盘；
  // 后续任何步骤都不许读已改写的文件（否则 cards+extracts 同文件会按错行替换）。
  const prepared = buildApplyFiles({ root, plan, preview });
  const migrationId = migrationStamp(now);
  const backupDirRel = `${MIGRATIONS_DIR}/${migrationId}/backup`;
  const backupDirAbs = ensureDir(root, backupDirRel);
  const backups = [];
  const created = [];

  const manifestPathAbs = resolveInside(root, `${MIGRATIONS_DIR}/${migrationId}/manifest.json`);
  fs.mkdirSync(path.dirname(manifestPathAbs), { recursive: true });

  const pendingCards = preview.cards.filter((card) => card.status === 'pending');
  const pendingExtracts = preview.extracts.filter((item) => item.status === 'pending');
  const pendingSources = [...new Set(pendingExtracts.map((item) => item.fromRel))];
  const pendingTargets = preview.targets.filter((item) => item.status === 'pending');
  const pendingEdges = preview.edges.filter((item) => item.status === 'pending');

  const manifest = {
    schema: MIGRATION_SCHEMA,
    migrationId,
    at: now.toISOString(),
    status: 'in-progress',
    backupDir: relativePath(root, backupDirAbs),
    planPath: planPath == null ? null : path.resolve(planPath),
    planSha256,
    root: relativePath(root, root) || '.',
    rootAbs: path.resolve(root),
    cards: pendingCards.map((card) => ({ rel: card.rel, lifecycle: card.desired, reason: card.reason })),
    extracts: pendingExtracts.map((item) => ({ id: item.id, fromRel: item.fromRel, lines: item.lines, targetRel: item.targetRel })),
    backups: [],
    created: [],
    createdEdges: null,
    edges: { rel: preview.edgesStore.rel, added: 0, beforeSha256: null },
    index: { rel: 'INDEX.md', beforeSha256: preview.index.sha256 },
  };

  for (const rel of [...new Set([...pendingCards.map((card) => card.rel), ...pendingSources])]) {
    backUpFile(root, rel, backupDirRel, backups);
  }
  backUpFile(root, 'INDEX.md', backupDirRel, backups);
  for (const rel of STATE_FILES) backUpFile(root, rel, backupDirRel, backups);
  if (preview.edgesStore.present) {
    const stored = backUpFile(root, preview.edgesStore.rel, backupDirRel, backups);
    manifest.edges.beforeSha256 = stored?.sha256 ?? null;
  }
  manifest.backups = backups;
  writeJson(manifestPathAbs, manifest);

  const applied = { cards: [], extracts: [], targets: [], edges: 0, index: null };
  const verificationPlan = {
    planSha256,
    files: prepared.files.map((file) => ({
      rel: file.rel,
      beforeSha256: file.snapshot.sha256,
      expectedSha256: file.expectedSha256,
      expectedBodySha256: file.expectedBodySha256,
      frontmatterAdded: file.frontmatterAdded,
      keysBefore: file.keysBefore,
      keysAfter: file.keysAfter,
      statusBefore: file.statusBefore,
      lifecycleAfter: file.lifecycleAfter,
      replacements: file.replacements.map((rep) => ({
        id: rep.id,
        bodyLineIndex: rep.bodyLineIndex,
        oldQuote: rep.oldQuote,
        replaceWith: rep.replaceWith,
        sourceHandling: rep.sourceHandling,
      })),
    })),
    targets: prepared.targets.map((target) => ({
      rel: target.rel,
      expectedSha256: target.expectedSha256,
      extracts: target.extracts,
    })),
  };

  const undo = () => {
    // fail-closed：任何校验失败都把已写的字节还原（卡/来源/INDEX/状态/edges），
    // 并删掉本次新建的历史卡与 edges 文件；审计日志 append-only 不还原。
    for (const backup of backups) {
      if (backup.rel === '.longlive/audit.log') continue;
      try {
        restoreBackup(root, backup.backupRel, backup.rel);
      } catch { /* 尽力还原 */ }
    }
    for (const item of created) {
      try {
        const abs = relAbs(root, item.rel);
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
      } catch { /* 尽力清理 */ }
    }
    if (manifest.createdEdges) {
      try {
        const abs = relAbs(root, manifest.createdEdges);
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
      } catch { /* 尽力清理 */ }
    }
  };

  try {
    if (!prepared.ok) {
      const error = memoryError('E_APPLY_VERIFY', `apply 前置快照校验失败（${prepared.failures.length} 项），未写任何文件`);
      error.failures = prepared.failures;
      throw error;
    }

    // 1) 来源卡/来源行：每份文件只写一次（frontmatter lifecycle + body 行替换在同一份快照上合成）。
    for (const file of prepared.files) {
      const abs = relAbs(root, file.rel);
      const written = writeFileAtomic(root, abs, file.expectedText, { backup: false, now });
      const readback = fs.readFileSync(abs, 'utf8');
      if (sha256Text(readback) !== file.expectedSha256) {
        throw memoryError('E_WRITE_VERIFY', `写入后字节不一致：${file.rel}`);
      }
      const parsed = splitFrontmatterText(readback);
      if (statusFromFmLines(parsed.fmLines) !== file.statusBefore) {
        throw memoryError('E_STATUS_CHANGED', `迁移意外改动了 status：${file.rel}`);
      }
      if (sha256Text(parsed.body) !== file.expectedBodySha256) {
        throw memoryError('E_BODY_CHANGED', `迁移意外改动了正文：${file.rel}`);
      }
      if (file.lifecycleAfter != null && readLifecycleFromText(readback) !== file.lifecycleAfter) {
        throw memoryError('E_WRITE_VERIFY', `lifecycle 回读不一致：${file.rel}`);
      }
      const bodyLines = parsed.lines.slice(parsed.bodyStartLine - 1);
      for (const rep of file.replacements) {
        if (bodyLines[rep.bodyLineIndex] !== rep.replaceWith) {
          throw memoryError('E_WRITE_VERIFY', `来源行回读不一致：${file.rel} bodyLineIndex=${rep.bodyLineIndex}`);
        }
        if (rep.sourceHandling !== 'annotated' && collapse(parsed.body).includes(collapse(rep.oldQuote))) {
          throw memoryError('E_APPLY_VERIFY', `旧句未消失：${file.rel}（${rep.id}）`);
        }
      }
      for (const card of pendingCards.filter((item) => item.rel === file.rel)) {
        applied.cards.push({ rel: card.rel, lifecycle: card.desired, sha256Before: card.sha256Before, sha256After: written.sha256 });
      }
      for (const extract of pendingExtracts.filter((item) => item.fromRel === file.rel)) {
        const rep = file.replacements.find((item) => item.id === extract.id);
        applied.extracts.push({
          id: extract.id,
          fromRel: extract.fromRel,
          line: extract.lines[0],
          targetRel: extract.targetRel,
          sha256After: written.sha256,
          bodyLineIndex: rep?.bodyLineIndex ?? null,
        });
      }
    }

    // 2) 历史卡：整行原文与 provenance 全部来自快照。
    for (const target of prepared.targets) {
      const abs = relAbs(root, target.rel);
      const written = writeFileAtomic(root, abs, target.expectedText, { backup: false, now });
      const readback = fs.readFileSync(abs, 'utf8');
      if (sha256Text(readback) !== target.expectedSha256) {
        throw memoryError('E_WRITE_VERIFY', `历史卡写入后字节不一致：${target.rel}`);
      }
      if (readLifecycleFromText(readback) !== target.lifecycle) {
        throw memoryError('E_WRITE_VERIFY', `历史卡 lifecycle 回读不一致：${target.rel}`);
      }
      created.push({ rel: target.rel, sha256: written.sha256 });
      applied.targets.push({ rel: target.rel, lifecycle: target.lifecycle, sha256After: written.sha256 });
    }

    // 3) INDEX.md 的历史口径注记。
    const indexNote = buildIndexNote(preview, plan);
    const indexPath = resolveInside(root, 'INDEX.md');
    if (fs.existsSync(indexPath)) {
      const before = fs.readFileSync(indexPath, 'utf8');
      const after = upsertLifecycleSection(before, indexNote);
      if (after !== before) {
        const written = writeFileAtomic(root, indexPath, after, { backup: false, now });
        applied.index = { rel: 'INDEX.md', sha256After: written.sha256 };
      }
    }

    // 4) edges.jsonl：plan 里的边 → normalize → 补反向 → 去重 → 追加写。
    const edgeStore = loadExistingEdges(root);
    const dedupedLocal = dedupeEdges([...edgeStore.edges, ...pendingEdges.map((item) => item.normalized)]);
    const symmetricLocal = symmetrizeEdges(dedupedLocal.edges);
    const merged = symmetricLocal.edges;
    const added = merged.length - edgeStore.edges.length;
    const edgesText = serializeEdges(merged);
    const edgesFileAbs = relAbs(root, relativePath(root, edgesPaths(root).file));
    const edgesWritten = writeFileAtomic(root, edgesFileAbs, edgesText, { backup: false, now });
    applied.edges = added;
    manifest.edges.afterSha256 = edgesWritten.sha256;
    manifest.edges.added = added;
    manifest.edges.total = merged.length;
    if (!preview.edgesStore.present) manifest.createdEdges = relativePath(root, edgesPaths(root).file);

    // P0/P1（R12-R2）：验证门基于「apply 前快照 vs apply 后」；失败即 fail-closed。
    manifest.verificationPlan = verificationPlan;
    const verification = verifyAppliedMigration(root, plan, { manifest });
    manifest.verification = { ok: verification.ok, failures: verification.failures, counts: verification.counts };
    if (!verification.ok) {
      const error = memoryError('E_APPLY_VERIFY', `apply 后验证失败（${verification.failures.length} 项）`);
      error.failures = verification.failures;
      throw error;
    }

    for (const entry of backups) {
      if (entry.rel === '.longlive/audit.log') {
        entry.appliedSha256 = null;
        entry.appendOnly = true;
        continue;
      }
      entry.appliedSha256 = fileSha(relAbs(root, entry.rel));
    }
    for (const item of created) item.sha256After = fileSha(relAbs(root, item.rel));

    manifest.status = 'applied';
    manifest.applied = applied;
    manifest.created = created;
    writeJson(manifestPathAbs, manifest);

    appendAudit(root, {
      action: 'lifecycle-migration',
      object: `migrations/${migrationId}`,
      result: `applied cards=${applied.cards.length} extracts=${applied.extracts.length} targets=${applied.targets.length} edges=+${added}`,
      now,
    });

    return {
      ok: true,
      schema: MIGRATION_SCHEMA,
      mode: 'apply',
      memoryRoot: root,
      migrationId,
      planSha256,
      manifestRel: relativePath(root, manifestPathAbs),
      backupDirRel,
      backups,
      created,
      applied,
      verification: { ok: true, counts: verification.counts },
      readOnly: false,
    };
  } catch (error) {
    undo();
    manifest.status = 'failed';
    manifest.created = created;
    manifest.error = { code: error.code ?? 'E_MIGRATION_FAILED', message: error.message, failures: error.failures ?? null };
    manifest.restoredOnFailure = true;
    writeJson(manifestPathAbs, manifest);
    error.manifestRel = relativePath(root, manifestPathAbs);
    throw error;
  }
}



function buildIndexNote(preview, plan = null) {
  const lines = [LIFECYCLE_INDEX_BEGIN, '', '## lifecycle 历史口径（迁移注记）', ''];
  lines.push('| 卡 | lifecycle | 原因 |', '|---|---|---|');
  for (const card of preview.cards) {
    if (card.status === 'already' && card.desired !== 'historical') continue;
    if (card.desired !== 'historical') continue;
    lines.push(`| ${card.rel} | historical | ${collapse(card.reason)} |`);
  }
  // 红队 R12 P2-4：来源行的处理方式按 sourceHandling 如实写，不许把 annotated（原位保留）也写成「已换成回指行」。
  const handlingByTarget = new Map();
  for (const extract of plan?.extracts ?? []) {
    const targetRel = extract?.targetCard?.rel;
    if (!targetRel) continue;
    const note = extract.sourceHandling === 'annotated'
      ? '来源行原位标注（原文保留）'
      : '来源行已换成回指行（其余文字逐字保留）';
    if (!handlingByTarget.has(targetRel)) handlingByTarget.set(targetRel, new Set());
    handlingByTarget.get(targetRel).add(note);
  }
  for (const target of preview.targets) {
    const notes = [...(handlingByTarget.get(target.rel) ?? [])].join('；') || '旧口径原文归档';
    lines.push(`| ${target.rel} | ${target.lifecycle} | 旧口径原文归档（${notes}） |`);
  }
  lines.push('', '> 说明：historical 只表示「不是当前正典」；status 不变（仍 active），正文不删。', '', LIFECYCLE_INDEX_END);
  return lines.join('\n');
}

function upsertLifecycleSection(existing, note) {
  const start = existing.indexOf(LIFECYCLE_INDEX_BEGIN);
  const end = existing.indexOf(LIFECYCLE_INDEX_END);
  if (start >= 0 && end > start) {
    const afterEnd = end + LIFECYCLE_INDEX_END.length;
    return `${existing.slice(0, start)}${note}${existing.slice(afterEnd)}`;
  }
  const eol = eolOf(existing);
  const trimmed = existing.replace(/[\r\n]+$/, '');
  return `${trimmed}${eol}${eol}${note}${eol}`;
}

export function listLifecycleMigrations({ memoryRoot } = {}) {
  const root = memoryRootFromConfig({ memoryRoot });
  const dir = migrationsDir(root);
  if (!fs.existsSync(dir)) return { ok: true, root, migrations: [] };
  const migrations = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    let stat = null;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const manifestAbs = path.join(abs, 'manifest.json');
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestAbs, 'utf8'));
    } catch {
      manifest = null;
    }
    migrations.push({ migrationId: name, manifestRel: relativePath(root, manifestAbs), manifest });
  }
  return { ok: true, root, migrations };
}

function pickRollbackMigration(root, migrationId) {
  if (migrationId) {
    const abs = resolveInside(root, `${MIGRATIONS_DIR}/${migrationId}/manifest.json`);
    if (!fs.existsSync(abs)) throw memoryError('E_MIGRATION_MISSING', `找不到迁移 manifest：${migrationId}`);
    return { abs, manifest: JSON.parse(fs.readFileSync(abs, 'utf8')) };
  }
  const listed = listLifecycleMigrations({ memoryRoot: root }).migrations.filter((item) => item.manifest?.status === 'applied');
  if (listed.length === 0) throw memoryError('E_NOTHING_TO_ROLLBACK', '没有可回滚的 applied 迁移');
  return {
    abs: resolveInside(root, listed[listed.length - 1].manifestRel),
    manifest: listed[listed.length - 1].manifest,
  };
}

/**
 * rollback：按 manifest 还原所有备份文件（卡 / INDEX.md / .longlive 状态 / edges.jsonl），
 * 删除本次新建的卡，逐字节校验 sha256。返回 countMatched / mismatched。
 */
export function rollbackLifecycleMigration({ memoryRoot, migrationId = null, now = new Date(), overrideConcurrent = false } = {}) {
  const root = memoryRootFromConfig({ memoryRoot });
  const picked = pickRollbackMigration(root, migrationId);
  const manifest = picked.manifest;
  if (manifest.schema !== MIGRATION_SCHEMA) {
    throw memoryError('E_MIGRATION_INVALID', `manifest schema 非法：${manifest.schema}`);
  }
  // 红队 R12 P2-6：恢复前逐个比对「当前 sha」与 manifest 记录的 apply 后 sha；
  // 不一致说明 apply 之后有人并发写，整文件还原会静默覆盖，必须 fail-closed（除非显式 override）。
  const conflicts = [];
  for (const backup of manifest.backups ?? []) {
    if (backup.appendOnly === true || backup.rel === '.longlive/audit.log') continue;
    const current = fileSha(relAbs(root, backup.rel));
    if (backup.appliedSha256 != null && current !== backup.appliedSha256) {
      conflicts.push({ rel: backup.rel, expected: backup.appliedSha256, actual: current, kind: 'backup' });
    }
  }
  for (const item of manifest.created ?? []) {
    const abs = relAbs(root, item.rel);
    if (!fs.existsSync(abs)) continue;
    const actual = fileSha(abs);
    if (item.sha256After != null && actual !== item.sha256After) {
      conflicts.push({ rel: item.rel, expected: item.sha256After, actual, kind: 'created' });
    }
  }
  if (manifest.createdEdges != null) {
    const abs = relAbs(root, manifest.createdEdges);
    if (fs.existsSync(abs)) {
      const actual = fileSha(abs);
      const after = manifest.edges?.afterSha256 ?? null;
      if (after != null && actual !== after) {
        conflicts.push({ rel: manifest.createdEdges, expected: after, actual, kind: 'created-edges' });
      }
    }
  }
  if (conflicts.length > 0 && overrideConcurrent !== true) {
    const error = memoryError(
      'E_ROLLBACK_CONFLICT',
      `apply 之后有 ${conflicts.length} 个文件被并发改写，拒绝覆盖式回滚（确认后用 overrideConcurrent 重试）`,
    );
    error.conflicts = conflicts;
    throw error;
  }
  const restored = [];
  const mismatched = [];
  const preserved = [];
  for (const backup of manifest.backups ?? []) {
    // 审计日志 append-only：保留 apply 审计行，不整文件还原。
    if (backup.appendOnly === true || backup.rel === '.longlive/audit.log') {
      preserved.push(backup.rel);
      continue;
    }
    const targetAbs = relAbs(root, backup.rel);
    if (!fs.existsSync(targetAbs)) {
      const dir = path.dirname(targetAbs);
      fs.mkdirSync(dir, { recursive: true });
    }
    const result = restoreBackup(root, backup.backupRel, backup.rel);
    const ok = result.sha256 === backup.sha256;
    restored.push({ rel: backup.rel, sha256: result.sha256, expected: backup.sha256, ok });
    if (!ok) mismatched.push(backup.rel);
  }
  const removed = [];
  for (const item of manifest.created ?? []) {
    const abs = relAbs(root, item.rel);
    if (fs.existsSync(abs)) {
      fs.unlinkSync(abs);
      removed.push(item.rel);
    }
  }
  if (manifest.createdEdges) {
    const abs = relAbs(root, manifest.createdEdges);
    if (fs.existsSync(abs)) {
      fs.unlinkSync(abs);
      removed.push(manifest.createdEdges);
    }
  }
  const afterIndex = fileSha(resolveInside(root, 'INDEX.md'));
  const receipt = {
    ok: mismatched.length === 0,
    schema: MIGRATION_SCHEMA,
    mode: 'rollback',
    memoryRoot: root,
    migrationId: manifest.migrationId,
    manifestRel: manifest.manifestRel ?? picked.manifest.migrationId,
    restored: restored.length,
    removed: removed.length,
    mismatched,
    indexSha256: afterIndex,
    countMatched: restored.filter((item) => item.ok).length,
    countExpected: restored.length,
    auditLogPreserved: true,
    auditLogBackedUp: preserved.length > 0,
    preserved,
    concurrentConflicts: conflicts,
    concurrentOverride: conflicts.length > 0 && overrideConcurrent === true,
    now: now.toISOString(),
  };
  // 红队 R12 P2-5：rollback 自己也要留审计（与 apply 审计行并存，不许抹掉 apply 记录）。
  appendAudit(root, {
    action: 'lifecycle-migration-rollback',
    object: `migrations/${manifest.migrationId}`,
    result: `rolled-back restored=${restored.length} removed=${removed.length}${conflicts.length ? ` overrides=${conflicts.length}` : ''}`,
    now,
  });
  const manifestAbs = picked.abs;
  const updated = {
    ...manifest,
    status: 'rolled-back',
    rolledBackAt: now.toISOString(),
    rollback: { restored: restored.length, removed: removed.length, mismatched, conflicts, overrideConcurrent: conflicts.length > 0 && overrideConcurrent === true },
  };
  writeJson(manifestAbs, updated);
  return receipt;
}

/** 选择性复制记忆根（真库 4.4 GB，不能整根拷）；只拷记忆模块会用到的文件。 */
export function copyMemoryRootForDryRun({ memoryRoot, destination, now = new Date() } = {}) {
  const root = memoryRootFromConfig({ memoryRoot });
  if (!destination) throw memoryError('E_BAD_ARGUMENT', 'dry-run 需要显式 destination');
  const dest = path.resolve(destination);
  if (dest === path.resolve(root)) throw memoryError('E_BAD_ARGUMENT', 'destination 不能等于源根');
  fs.mkdirSync(dest, { recursive: true });
  for (const rel of COPY_ROOT_FILES) copyIfExists(path.resolve(root, rel), path.resolve(dest, rel));
  for (const rel of COPY_ROOT_DIRS) {
    const src = path.resolve(root, rel);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.resolve(dest, rel), { recursive: true, force: true });
  }
  for (const rel of COPY_LONGLIVE_FILES) copyIfExists(path.resolve(root, rel), path.resolve(dest, rel));
  return { sourceRoot: root, copyRoot: dest, copiedAt: now.toISOString() };
}

function copyIfExists(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

function fingerprintFiles(root, rels) {
  const map = {};
  for (const rel of rels) {
    const abs = path.resolve(root, rel);
    map[rel] = fs.existsSync(abs) ? sha256File(abs) : null;
  }
  return map;
}

function plannedTouchList(preview) {
  const rels = new Set(['INDEX.md']);
  for (const card of preview.cards) rels.add(card.rel);
  for (const extract of preview.extracts) rels.add(extract.fromRel);
  for (const target of preview.targets) rels.add(target.rel);
  if (preview.edgesStore.rel) rels.add(preview.edgesStore.rel);
  for (const rel of STATE_FILES) rels.add(rel);
  return [...rels];
}

/** 下游四入口：memory_index → memory_recall → memory_reinforce → memory_consolidate。 */
export function runDownstreamLifecycleChecks({ memoryRoot, query = '六轨 分轨 现在用什么', reinforcePath = null, now = new Date() } = {}) {
  const root = memoryRootFromConfig({ memoryRoot });
  const steps = [];
  let index = null;
  try {
    index = memoryIndex({ apply: true }, { memoryRoot: root, now });
    steps.push({ name: 'memory_index', ok: index?.status !== 'error', status: index?.status, rel: index?.rel ?? index?.indexRel ?? 'INDEX.md', sha256: index?.sha256 ?? null, changed: index?.changed ?? null });
  } catch (error) {
    steps.push({ name: 'memory_index', ok: false, error: error.code ?? error.message });
  }
  let recall = null;
  try {
    recall = memoryRecall({ query, topK: 5 }, { memoryRoot: root, now });
    const ok = recall?.ok === true && Array.isArray(recall.results) && recall.results.length > 0;
    steps.push({ name: 'memory_recall', ok, count: recall?.results?.length ?? 0, titles: (recall?.results ?? []).map((item) => item.title) });
  } catch (error) {
    steps.push({ name: 'memory_recall', ok: false, error: error.code ?? error.message });
  }
  let reinforce = null;
  try {
    const target = reinforcePath ?? firstHistoricalCard(memoryRoot, root) ?? firstPendingCardRel();
    // 红队 R11 P1-1：reinforce 前后必须真读卡比对（lifecycle/status/正文），不再字面量 true。
    const before = readCardState(root, target);
    if (!before.ok) throw memoryError('E_DRYRUN_FAILED', `下游 reinforce 目标卡不可读：${target}（${before.reason}）`);
    reinforce = memoryReinforce({ path: target, why: 'lifecycle-migration dry-run downstream check' }, { memoryRoot: root, now });
    const verify = verifyLifecyclePreserved(root, target, {
      lifecycle: before.lifecycle,
      status: before.status,
      bodyNorm: before.bodyNorm,
    });
    steps.push({ name: 'memory_reinforce', ok: reinforce?.ok === true && verify.ok, path: target, strength: reinforce?.fields?.strength ?? reinforce?.strength ?? null, verify });
  } catch (error) {
    steps.push({ name: 'memory_reinforce', ok: false, error: error.code ?? error.message });
  }
  try {
    const consolidate = memoryConsolidate({ action: 'report' }, { memoryRoot: root, now });
    steps.push({ name: 'memory_consolidate', ok: consolidate?.ok === true, status: consolidate?.status, proposals: consolidate?.proposals?.length ?? 0, backlog: consolidate?.backlog ?? null, reportRel: consolidate?.reportRel ?? null });
  } catch (error) {
    steps.push({ name: 'memory_consolidate', ok: false, error: error.code ?? error.message });
  }
  return {
    ok: steps.every((step) => step.ok === true),
    root,
    query,
    steps,
  };
}

let _pendingPlan = null;

function firstPendingCardRel() {
  return _pendingPlan?.cards?.find((card) => card.status === 'pending')?.rel ?? null;
}

function firstHistoricalCard() {
  const preview = _pendingPlan;
  const historical = preview?.cards?.find((card) => card.desired === 'historical');
  if (historical) return historical.rel;
  const created = preview?.targets?.find((target) => target.lifecycle === 'historical');
  return created ? created.rel : null;
}

/** 读一张卡的真实状态（lifecycle/status/正文），供迁移前后逐字段比对。 */
export function readCardState(root, rel) {
  if (!rel) return { ok: false, rel: null, reason: 'no-rel' };
  const abs = path.resolve(root, rel);
  let text = null;
  try {
    if (!fs.statSync(abs).isFile()) return { ok: false, rel, reason: 'not-file' };
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    return { ok: false, rel, reason: 'missing' };
  }
  let parsed = null;
  try {
    parsed = parseFrontmatter(text);
  } catch (error) {
    return { ok: false, rel, reason: 'bad-frontmatter', code: error?.code ?? null };
  }
  return {
    ok: true,
    rel,
    text,
    lifecycle: readLifecycleFromText(text),
    status: parsed.fields.status ?? 'active',
    body: parsed.body,
    bodyNorm: normalizedBody(parsed.body),
    sha256: sha256Text(text),
  };
}

/**
 * 迁移后校验（红队 R11 P1-1）：不再「卡存在即 ok」。
 * - lifecycle 必须是合法枚举（null 表示没有该字段，属于普通卡，允许但要和 expected 一致）；
 * - expected 给了就必须逐项相等：lifecycle / status / 正文（去掉 rev 注释行后逐字）。
 */
export function verifyLifecyclePreserved(root, rel, expected = null) {
  const state = readCardState(root, rel);
  if (!state.ok) return { ok: false, rel, reason: state.reason, code: state.code ?? null };
  const out = {
    ok: true,
    rel,
    lifecycle: state.lifecycle,
    status: state.status,
    bodyUnchanged: null,
    lifecycleUnchanged: null,
    statusUnchanged: null,
  };
  if (state.lifecycle != null && !LIFECYCLE_VALUES.includes(state.lifecycle)) {
    out.ok = false;
    out.reason = 'invalid-lifecycle';
    return out;
  }
  if (expected) {
    out.lifecycleUnchanged = state.lifecycle === (expected.lifecycle ?? null);
    out.statusUnchanged = state.status === expected.status;
    out.bodyUnchanged = state.bodyNorm === expected.bodyNorm;
    out.ok = out.lifecycleUnchanged && out.statusUnchanged && out.bodyUnchanged;
    if (!out.ok) out.reason = 'expected-mismatch';
  }
  return out;
}

function findLatestAppliedManifest(root, planSha256 = null) {
  const dir = migrationsDir(root);
  if (!fs.existsSync(dir)) return null;
  const names = fs.readdirSync(dir).sort().reverse();
  for (const name of names) {
    const abs = path.join(dir, name, 'manifest.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(abs, 'utf8'));
      if (manifest?.status !== 'applied') continue;
      if (planSha256 != null && manifest.planSha256 != null && manifest.planSha256 !== planSha256) continue;
      return manifest;
    } catch {
      // 损坏的 manifest 跳过（fail-open 只用于发现历史记录，不作为通过依据）。
    }
  }
  return null;
}

export function verifyAppliedMigration(root, plan, options = {}) {
  validatePlan(plan);
  const manifest = options.manifest ?? (options.manifestRel
    ? (() => {
      try {
        return JSON.parse(fs.readFileSync(path.resolve(root, options.manifestRel), 'utf8'));
      } catch {
        return null;
      }
    })()
    : findLatestAppliedManifest(root, options.planSha256 ?? null));
  const failures = [];
  const counts = { cards: 0, extracts: 0, targets: 0, edges: 0, files: 0 };

  for (const card of plan.cards) {
    const state = readCardState(root, card.rel);
    if (!state.ok) {
      failures.push({ kind: 'card-missing', rel: card.rel, detail: state.reason });
      continue;
    }
    counts.cards += 1;
    if (state.lifecycle !== card.lifecycle) {
      failures.push({ kind: 'card-lifecycle', rel: card.rel, expected: card.lifecycle, actual: state.lifecycle });
    }
  }

  const verificationPlan = manifest?.verificationPlan ?? null;
  if (verificationPlan) {
    // P1（R12-R2）：有 apply 前快照时，逐份文件按「快照 + 期望字节」校验，
    // 不再按「apply 后同一行号」自洽读取（那会把错行替换也判成通过）。
    for (const file of verificationPlan.files ?? []) {
      const abs = path.resolve(root, file.rel);
      const text = readTextOrNull(abs);
      if (text == null) {
        failures.push({ kind: 'file-missing', rel: file.rel });
        continue;
      }
      counts.files += 1;
      if (file.expectedSha256 && sha256Text(text) !== file.expectedSha256) {
        failures.push({ kind: 'body-mismatch', rel: file.rel, expected: file.expectedSha256, actual: sha256Text(text) });
      }
      const parsed = splitFrontmatterText(text);
      if (file.expectedBodySha256 && sha256Text(parsed.body) !== file.expectedBodySha256) {
        failures.push({
          kind: 'body-mismatch',
          rel: file.rel,
          expectedBody: file.expectedBodySha256,
          actualBody: sha256Text(parsed.body),
        });
      }
      const keys = parsed.fmLines.map(frontmatterKeyOf).filter(Boolean);
      if (file.frontmatterAdded) {
        // P2-1：无 frontmatter 的源卡只允许加 lifecycle 一个键。
        if (keys.length !== 1 || keys[0] !== 'lifecycle') {
          failures.push({ kind: 'frontmatter-defaults', rel: file.rel, keys });
        }
      } else {
        const unexpected = keys.filter((key) => !(file.keysBefore ?? []).includes(key));
        const removed = (file.keysBefore ?? []).filter((key) => !keys.includes(key));
        const badUnexpected = unexpected.filter((key) => key !== 'lifecycle');
        if (badUnexpected.length > 0 || removed.length > 0) {
          failures.push({ kind: 'frontmatter-changed', rel: file.rel, unexpected: badUnexpected, removed });
        }
      }
      const status = statusFromFmLines(parsed.fmLines);
      if (file.statusBefore != null && status !== file.statusBefore) {
        failures.push({ kind: 'status-changed', rel: file.rel, expected: file.statusBefore, actual: status });
      }
      if (file.lifecycleAfter != null && readLifecycleFromText(text) !== file.lifecycleAfter) {
        failures.push({ kind: 'card-lifecycle', rel: file.rel, expected: file.lifecycleAfter, actual: readLifecycleFromText(text) });
      }
      const bodyLines = parsed.lines.slice(parsed.bodyStartLine - 1);
      for (const rep of file.replacements ?? []) {
        const actualLine = bodyLines[rep.bodyLineIndex];
        if (actualLine !== rep.replaceWith) {
          failures.push({
            kind: 'source-line',
            rel: file.rel,
            bodyLineIndex: rep.bodyLineIndex,
            expected: collapse(rep.replaceWith).slice(0, 160),
            actual: collapse(actualLine ?? '').slice(0, 160),
          });
        }
        if (rep.sourceHandling !== 'annotated' && collapse(parsed.body).includes(collapse(rep.oldQuote))) {
          failures.push({ kind: 'old-quote-present', rel: file.rel, id: rep.id });
        }
      }
    }
    for (const target of verificationPlan.targets ?? []) {
      const state = readCardState(root, target.rel);
      if (!state.ok) {
        failures.push({ kind: 'target-missing', rel: target.rel, detail: state.reason });
        continue;
      }
      counts.targets += 1;
      if (target.expectedSha256 && state.sha256 !== target.expectedSha256) {
        failures.push({ kind: 'target-body-mismatch', rel: target.rel, expected: target.expectedSha256, actual: state.sha256 });
      }
      const archivedLines = state.text.split(/\r?\n/).map((line) => normalizeQuoteLine(line.replace(/^\s*>\s?/, '')));
      for (const item of target.extracts ?? []) {
        if (!state.text.includes(`迁移前文件 sha256：\`${item.origSha256}\``)) {
          failures.push({ kind: 'provenance-mismatch', rel: target.rel, id: item.id, expected: item.origSha256 });
        }
        if (!archivedLines.includes(normalizeQuoteLine(item.archiveQuote))) {
          failures.push({ kind: 'target-archive-quote', rel: target.rel, id: item.id });
        }
      }
      if (state.text.includes('校验：未通过')) {
        failures.push({ kind: 'legacy-verify-failed', rel: target.rel });
      }
    }
    counts.extracts = (verificationPlan.files ?? []).reduce((sum, file) => sum + (file.replacements ?? []).length, 0);
  } else {
    // 兼容路径（没有 apply 快照）：只能做结构校验，dry-run/apply 必须走上面的快照口径。
    for (const extract of plan.extracts) {
      const text = readTextOrNull(path.resolve(root, extract.fromRel));
      if (text == null) {
        failures.push({ kind: 'source-missing', rel: extract.fromRel });
        continue;
      }
      counts.extracts += 1;
      if (!collapse(text).includes(collapse(extract.replaceWith))) {
        failures.push({ kind: 'source-line', rel: extract.fromRel });
      }
    }
    const seen = new Map();
    for (const extract of plan.extracts) {
      if (!seen.has(extract.targetCard.rel)) seen.set(extract.targetCard.rel, extract);
    }
    for (const [rel, extract] of seen) {
      const state = readCardState(root, rel);
      if (!state.ok) {
        failures.push({ kind: 'target-missing', rel, detail: state.reason });
        continue;
      }
      counts.targets += 1;
      const expected = extract.targetCard.lifecycle ?? 'historical';
      if (state.lifecycle !== expected) {
        failures.push({ kind: 'target-lifecycle', rel, expected, actual: state.lifecycle });
      }
      const archiveQuote = extract.legacyQuote ?? extract.quote;
      const archivedLines = state.text.split(/\r?\n/).map((line) => normalizeQuoteLine(line.replace(/^\s*>\s?/, '')));
      const quoteOk = extract.legacyQuote != null
        ? archivedLines.includes(normalizeQuoteLine(archiveQuote))
        : collapse(state.text).includes(collapse(archiveQuote));
      if (!quoteOk) {
        failures.push({ kind: 'target-archive-quote', rel, expected: collapse(archiveQuote).slice(0, 160) });
      }
    }
  }

  const store = loadExistingEdges(root);
  for (const edge of plan.edges) {
    counts.edges += 1;
    const key = `${edge.from}|${edge.to}|${edge.type}`;
    if (!store.keys.has(key)) {
      failures.push({ kind: 'edge-missing', from: edge.from, to: edge.to, type: edge.type, rel: store.rel });
    }
  }

  const indexPath = resolveInside(root, 'INDEX.md');
  let indexText = '';
  try {
    indexText = fs.readFileSync(indexPath, 'utf8');
  } catch {
    // INDEX.md 允许缺失；存在时必须有 lifecycle 注记段。
  }
  if (indexText && (!indexText.includes(LIFECYCLE_INDEX_BEGIN) || !indexText.includes(LIFECYCLE_INDEX_END))) {
    failures.push({ kind: 'index-note-missing', rel: 'INDEX.md' });
  }

  return { ok: failures.length === 0, failures, counts };
}

/**
 * dry-run：真库只读 → 选择性复制到临时根 → 在副本上 plan/apply/验证/下游四入口 →
 * 校验真库所有相关文件 sha256 未变。返回副本路径供检查，默认不删。
 */
export function dryRunLifecycleMigration({ memoryRoot, plan, planPath = null, planSha256 = null, now = new Date(), copyRoot = null, query = '六轨 分轨 现在用什么', cleanup = false } = {}) {
  const root = memoryRootFromConfig({ memoryRoot });
  validatePlan(plan);
  const preview = planLifecycleMigration({ memoryRoot: root, plan, planSha256, planPath, now });
  const before = fingerprintFiles(root, plannedTouchList(preview));
  const dest = copyRoot == null
    ? path.join(os.tmpdir(), `dsh-lifecycle-dryrun-${migrationStamp(now)}`)
    : path.resolve(copyRoot);
  if (fs.existsSync(dest)) {
    throw memoryError('E_COPY_EXISTS', `dry-run 副本目录已存在，请先删除或换路径：${dest}`);
  }
  const copy = copyMemoryRootForDryRun({ memoryRoot: root, destination: dest, now });
  let migration = null;
  let downstream = null;
  let verification = null;
  let error = null;
  try {
    migration = applyLifecycleMigration({ memoryRoot: copy.copyRoot, plan, planPath, planSha256, now });
    verification = verifyAppliedMigration(copy.copyRoot, plan, { manifestRel: migration?.manifestRel ?? null, planSha256 });
    _pendingPlan = preview;
    downstream = runDownstreamLifecycleChecks({
      memoryRoot: copy.copyRoot,
      query,
      reinforcePath: firstHistoricalCard(),
      now,
    });
  } catch (caught) {
    error = { code: caught.code ?? 'E_DRYRUN_FAILED', message: caught.message, manifestRel: caught.manifestRel ?? null };
  } finally {
    _pendingPlan = null;
  }
  const after = fingerprintFiles(root, plannedTouchList(preview));
  const untouched = { ok: true, changed: [], checked: Object.keys(before).length };
  for (const [rel, sha] of Object.entries(before)) {
    if (after[rel] !== sha) {
      untouched.ok = false;
      untouched.changed.push(rel);
    }
  }
  const result = {
    ok: preview.ok && !error && verification?.ok === true && downstream?.ok === true && untouched.ok,
    schema: MIGRATION_SCHEMA,
    mode: 'dry-run',
    sourceRoot: root,
    copyRoot: copy.copyRoot,
    planSha256,
    now: now.toISOString(),
    preview: {
      ok: preview.ok,
      counts: preview.counts,
      blockers: preview.blockers.map((item) => ({ status: item.status, rel: item.rel ?? item.fromRel ?? item.id ?? item.targetRel, detail: item.evidence?.detail ?? null })),
    },
    realRootUntouched: untouched,
    migration: error ? null : {
      ok: migration.ok,
      migrationId: migration.migrationId,
      manifestRel: migration.manifestRel,
      backupDirRel: migration.backupDirRel,
      applied: migration.applied,
      backups: migration.backups.map((item) => item.rel),
    },
    verification,
    downstream,
    error,
    cleanupRequested: cleanup,
  };
  if (cleanup && fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  return result;
}
