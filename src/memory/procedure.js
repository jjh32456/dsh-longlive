// Procedural memory: how a task is done, not what happened.
//
// One card per procedure at `<root>/procedures/<slug>.md`. Unlike topics/ and
// journal/ cards, a procedure has a fixed shape, because a procedure is only
// usable when the model can find the trigger, follow the steps, and learn from
// the failure modes:
//
//   ---
//   name: 部署流程
//   trigger: [部署, 上线]
//   salience: 3
//   strength: 3
//   last_used: 2026-11-02
//   revisions: 0
//   ---
//   ## 何时用 … ## 怎么做 (numbered) … ## 失败模式 … ## 例子
//
// `revisions` counts CONTENT versions (a merge bumps it), while `strength`
// counts how often the procedure actually worked (a report moves it). They are
// deliberately separate: editing a card must not look like using it, and using
// it must not create a new version.
//
// This module also owns the reader the index uses, so the writer and the index
// can never disagree about what a valid procedure is. A card whose frontmatter
// is unterminated or that misses a required field is returned as `invalid`
// rather than thrown: one broken card must not take the whole index down, and
// it must not be silently overwritten either.

import fs from 'node:fs';
import path from 'node:path';

import { memoryRootFromConfig, resolveInside, relativePath, memoryError } from './paths.js';
import {
  parseFrontmatter, updateFrontmatter, appendLine, dayString,
  normalizedBody, countRevLines,
} from './frontmatter.js';
import {
  appendAudit, backupFile, restoreBackup, writeFileAtomic, listMarkdownFiles, sha256File, sha256Text,
} from './state.js';
import { sessionIdOfExec } from '../identity.js';
import { MANUAL_SESSION, stampExtras } from './provenance.js';
import { manifestPath, refreshManifest } from './manifest.js';
import { appendConflictWith, detectConflicts } from './cards.js';

export const PROCEDURES_DIR = 'procedures';
export const PROCEDURE_ACTIONS = Object.freeze(['save', 'list', 'get', 'report']);
export const MAX_STRENGTH = 9;
export const MAX_SALIENCE = 5;

/** Required frontmatter keys, in the order the writer emits them. */
export const PROCEDURE_FIELDS = Object.freeze([
  'name', 'trigger', 'salience', 'strength', 'last_used', 'revisions',
]);

/** Body section headings, in the order the writer emits them. */
export const PROCEDURE_SECTIONS = Object.freeze({
  when: '何时用',
  steps: '怎么做',
  failureModes: '失败模式',
  example: '例子',
});

const EMPTY_SECTION = '（暂无）';
const OUTCOMES = Object.freeze(['success', 'failure']);
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;
const MAX_NAME_CHARS = 120;
const MAX_TRIGGER_ITEMS = 24;
const MAX_STEPS = 50;
const MAX_STEP_CHARS = 500;
const MAX_REASON_CHARS = 120;

function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function singleLine(label, value) {
  const text = String(value ?? '').trim();
  if (/[\r\n]/.test(text)) {
    throw memoryError('E_BAD_ARGUMENT', `${label} 不能含换行 — 多行内容放进正文，frontmatter 只支持单行值`);
  }
  return text;
}

function stringArg(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstHeading(body) {
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    const match = /^\s{0,3}#{1,6}\s+(.+?)\s*$/.exec(raw);
    if (match) return collapse(match[1]);
  }
  return null;
}

/**
 * A slug is a file stem under procedures/. It may not contain a path
 * separator, a `..` run, or a leading dot: `name: "x/y"` would otherwise write
 * outside the directory the user thinks they are writing into.
 */
function slugFrom(raw, label = 'slug') {
  const text = singleLine(label, raw);
  if (!text) {
    throw memoryError('E_BAD_ARGUMENT', `${label} 不能为空 — 给一个简短的名字（会变成 procedures/<slug>.md）`);
  }
  if (text.length > MAX_NAME_CHARS) {
    throw memoryError('E_BAD_ARGUMENT', `${label} 太长（${text.length} > ${MAX_NAME_CHARS} 字符）`);
  }
  if (/[\\/:*?"<>|\0]/.test(text)) {
    throw memoryError('E_BAD_ARGUMENT', `${label} 不能含路径分隔符或以下字符：\\ / : * ? " < > | — 收到 ${JSON.stringify(text)}`);
  }
  if (text === '.' || text === '..' || text.includes('..')) {
    throw memoryError('E_BAD_ARGUMENT', `${label} 不能含 .. — 收到 ${JSON.stringify(text)}`);
  }
  if (text.startsWith('.')) {
    throw memoryError('E_BAD_ARGUMENT', `${label} 不能以 . 开头 — 收到 ${JSON.stringify(text)}`);
  }
  return text;
}

function intArg(value, label, min, max) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw memoryError('E_BAD_ARGUMENT', `${label} 必须是 ${min}..${max} 的整数 — 收到 ${JSON.stringify(value)}`);
  }
  return number;
}

/** `trigger: [部署, 上线]` from the frontmatter is a string in `extras`. */
function parseTriggerValue(value) {
  const text = String(value ?? '').trim();
  if (text === '') return [];
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((part) => unquote(part)).filter((part) => part !== '');
  }
  return [unquote(text)];
}

function unquote(value) {
  const text = String(value ?? '').trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return text.slice(1, -1);
  }
  return text;
}

/**
 * Accept both shapes on purpose: the tool schema says array (that is what a
 * host-validated save sends), while a keyword filter is often typed as one
 * space-separated string.
 */
function keywordList(value) {
  const parts = Array.isArray(value)
    ? value.flatMap((item) => String(item ?? '').split(/[\s,，、]+/))
    : String(value ?? '').split(/[\s,，、]+/);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

function normalizeTrigger(value, label) {
  const items = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : null);
  if (!items) {
    throw memoryError('E_BAD_ARGUMENT', `${label} 必须是字符串数组 — 收到 ${JSON.stringify(value)}`);
  }
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const text = singleLine(label, item);
    if (text === '') continue;
    if (text.length > 60) throw memoryError('E_BAD_ARGUMENT', `${label} 的单个关键词太长（> 60 字符）：${JSON.stringify(text)}`);
    if (/[,\[\]，]/.test(text)) {
      throw memoryError('E_BAD_ARGUMENT', `${label} 的单个关键词不能含逗号或方括号（会破坏 frontmatter 数组）：${JSON.stringify(text)}`);
    }
    if (seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
  }
  if (out.length === 0) {
    throw memoryError('E_BAD_ARGUMENT', `${label} 至少需要一个关键词 — 空列表的程序卡永远不会被 list 找到`);
  }
  if (out.length > MAX_TRIGGER_ITEMS) {
    throw memoryError('E_BAD_ARGUMENT', `${label} 最多 ${MAX_TRIGGER_ITEMS} 个关键词（收到 ${out.length}）`);
  }
  return out;
}

function formatTrigger(trigger) {
  return `[${trigger.join(', ')}]`;
}

/** Steps may arrive as an array, or as one newline-separated string. */
function normalizeSteps(value) {
  if (value === undefined || value === null) return null;
  const raw = Array.isArray(value) ? value : String(value).split(/\r?\n/);
  const steps = raw
    .map((step) => collapse(step).replace(/^\d+[.)]\s*/, ''))
    .filter((step) => step !== '');
  if (steps.length > MAX_STEPS) {
    throw memoryError('E_BAD_ARGUMENT', `steps 最多 ${MAX_STEPS} 条（收到 ${steps.length}）`);
  }
  for (const step of steps) {
    if (step.length > MAX_STEP_CHARS) {
      throw memoryError('E_BAD_ARGUMENT', `单条步骤超过 ${MAX_STEP_CHARS} 字符 — 拆成几条，或把细节放进「失败模式」`);
    }
    if (/[\r\n]/.test(step)) throw memoryError('E_BAD_ARGUMENT', 'steps 的每一条都必须是单行');
  }
  return steps;
}

function normalizeText(label, value) {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/\r\n/g, '\n').trim();
  return text === '' ? null : text;
}

/** Split a card body into the four known sections plus anything else. */
function parseSections(body) {
  const lines = String(body ?? '').split(/\r?\n/);
  const sections = new Map();
  let current = null;
  for (const raw of lines) {
    if (/^\s*<!--\s*rev\s*:/i.test(raw)) continue; // usage history, not prose
    const match = /^\s{0,3}##\s+(.+?)\s*$/.exec(raw);
    if (match) {
      current = collapse(match[1]);
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current === null) continue;
    sections.get(current).push(raw);
  }

  const textOf = (heading) => {
    if (!sections.has(heading)) return null;
    const text = sections.get(heading).join('\n').replace(/^\s+|\s+$/g, '');
    return text === '' || text === EMPTY_SECTION ? null : text;
  };

  const stepsText = textOf(PROCEDURE_SECTIONS.steps);
  const steps = [];
  if (stepsText) {
    for (const raw of stepsText.split(/\r?\n/)) {
      const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(raw);
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(raw);
      const text = numbered?.[1] ?? bullet?.[1];
      if (text !== undefined && text.trim() !== '') steps.push(text.trim());
    }
    if (steps.length === 0) steps.push(stepsText.trim());
  }

  const known = new Set(Object.values(PROCEDURE_SECTIONS));
  const extras = [];
  for (const [heading, content] of sections) {
    if (known.has(heading)) continue;
    const text = content.join('\n').trim();
    if (text !== '') extras.push({ heading, text });
  }

  return {
    when: textOf(PROCEDURE_SECTIONS.when),
    steps,
    failureModes: textOf(PROCEDURE_SECTIONS.failureModes),
    example: textOf(PROCEDURE_SECTIONS.example),
    extraSections: extras,
  };
}

function composeBody(sections) {
  const steps = Array.isArray(sections.steps) && sections.steps.length > 0
    ? sections.steps.map((step, index) => `${index + 1}. ${step}`)
    : [EMPTY_SECTION];
  const lines = [
    `## ${PROCEDURE_SECTIONS.when}`,
    '',
    sections.when?.trim() || EMPTY_SECTION,
    '',
    `## ${PROCEDURE_SECTIONS.steps}`,
    '',
    ...steps,
    '',
    `## ${PROCEDURE_SECTIONS.failureModes}`,
    '',
    sections.failureModes?.trim() || EMPTY_SECTION,
    '',
    `## ${PROCEDURE_SECTIONS.example}`,
    '',
    sections.example?.trim() || EMPTY_SECTION,
  ];
  for (const extra of sections.extraSections ?? []) {
    lines.push('', `## ${extra.heading}`, '', extra.text);
  }
  for (const rev of sections.revLines ?? []) {
    lines.push('', rev);
  }
  return `${lines.join('\n')}\n`;
}

function buildCardText(card) {
  const head = [
    '---',
    `name: ${card.name}`,
    `trigger: ${formatTrigger(card.trigger)}`,
    `salience: ${card.salience}`,
    `strength: ${card.strength}`,
    `last_used: ${card.last_used}`,
    `revisions: ${card.revisions}`,
  ];
  // B3 provenance and conflict markers are extras: they go after the six
  // pinned fields (M24 pins those), and are never inserted into them.
  const extras = card.extras && typeof card.extras === 'object' ? card.extras : {};
  for (const [key, value] of Object.entries(extras)) {
    if (PROCEDURE_FIELDS.includes(key) || value == null || String(value) === '') continue;
    const text = String(value);
    if (/[\r\n]/.test(text)) {
      throw memoryError(
        'E_BAD_ARGUMENT',
        `扩展字段 ${key} 的值含换行 — 该格式只支持单行值，拒绝写出（请把多行内容放进正文）`,
      );
    }
    head.push(`${key}: ${text}`);
  }
  head.push('---');
  return `${head.join('\n')}\n\n${composeBody(card.sections)}`;
}

/** Keys actually written in the frontmatter block (not the parsed defaults). */
function frontmatterKeys(parsed) {
  const head = parsed.text.slice(parsed.bom.length, parsed.bodyStart);
  const keys = new Set();
  const pattern = /^([A-Za-z_][\w-]*)\s*:/gm;
  let match = pattern.exec(head);
  while (match) {
    keys.add(match[1]);
    match = pattern.exec(head);
  }
  return keys;
}

function procedurePath(root, slug) {
  return resolveInside(root, path.join(PROCEDURES_DIR, `${slug}.md`));
}

/**
 * Read one procedure file. Never throws for bad content: an unterminated
 * frontmatter block or a missing required field comes back as `invalid: true`
 * with a reason, because the index has to keep counting the card and the tool
 * has to refuse to overwrite it.
 */
export function readProcedureFile(root, abs, text = null) {
  const rel = relativePath(root, abs);
  const slug = path.basename(abs, '.md');
  const source = text ?? fs.readFileSync(abs, 'utf8');
  const base = {
    abs, rel, slug, text: source,
    name: slug, trigger: [], salience: 3, strength: 3, last_used: null, revisions: 0,
    version: 1, legacy: false, invalid: false, invalidReason: null, extras: {},
    sections: { when: null, steps: [], failureModes: null, example: null, extraSections: [] },
  };

  let parsed;
  try {
    parsed = parseFrontmatter(source);
  } catch (error) {
    return {
      ...base,
      invalid: true,
      invalidReason: error?.code === 'E_FRONTMATTER_UNTERMINATED'
        ? 'frontmatter 以 --- 开头但没有闭合'
        : `frontmatter 解析失败：${error?.message ?? String(error)}`,
      sha256: sha256Text(source),
    };
  }

  const sections = parseSections(parsed.body);
  const revLines = String(parsed.body).split(/\r?\n/).filter((line) => /^\s*<!--\s*rev\s*:/i.test(line));
  sections.revLines = revLines;

  if (parsed.legacy) {
    // A card without frontmatter predates the format. It still gets a row (the
    // index must not lose it) and list/get may show it, but report refuses
    // until `save` rewrites it into the real shape.
    return {
      ...base,
      name: firstHeading(parsed.body) || slug,
      legacy: true,
      sections,
      sha256: sha256Text(source),
    };
  }

  const keys = frontmatterKeys(parsed);
  const missing = PROCEDURE_FIELDS.filter((key) => !keys.has(key));
  const name = unquote(parsed.extras.name ?? '');
  const trigger = parseTriggerValue(parsed.extras.trigger);
  if (name === '') missing.push('name');
  if (trigger.length === 0) missing.push('trigger');
  const uniqueMissing = [...new Set(missing)];
  if (uniqueMissing.length > 0) {
    return {
      ...base,
      name: name || slug,
      trigger,
      salience: parsed.fields.salience,
      strength: parsed.fields.strength,
      last_used: parsed.fields.last_used,
      revisions: parsed.fields.revisions,
      version: parsed.fields.revisions + 1,
      invalid: true,
      invalidReason: `缺少必填 frontmatter 字段：${uniqueMissing.join(', ')}`,
      extras: parsed.extras,
      sections,
      sha256: sha256Text(source),
    };
  }

  return {
    ...base,
    name,
    trigger,
    salience: parsed.fields.salience,
    strength: parsed.fields.strength,
    last_used: parsed.fields.last_used,
    revisions: parsed.fields.revisions,
    version: parsed.fields.revisions + 1,
    extras: parsed.extras,
    sections,
    sha256: sha256Text(source),
  };
}

/** Every procedure file, valid and broken, plus the broken ones separately. */
export function scanProcedures(root) {
  const cards = listMarkdownFiles(root, PROCEDURES_DIR)
    .map((abs) => readProcedureFile(root, abs));
  cards.sort((left, right) => {
    if (right.salience !== left.salience) return right.salience - left.salience;
    if (right.strength !== left.strength) return right.strength - left.strength;
    return left.slug.localeCompare(right.slug);
  });
  return { cards, invalid: cards.filter((card) => card.invalid) };
}

function listItem(card) {
  return {
    name: card.name,
    slug: card.slug,
    rel: card.rel,
    trigger: card.trigger,
    salience: card.salience,
    strength: card.strength,
    last_used: card.last_used,
    revisions: card.revisions,
    version: card.version,
    legacy: card.legacy,
    invalid: card.invalid,
    invalidReason: card.invalidReason,
  };
}

function findCard(root, args) {
  const raw = stringArg(args.slug) || stringArg(args.name);
  if (!raw) return null;
  const slug = slugFrom(raw, 'slug');
  const abs = procedurePath(root, slug);
  if (!fs.existsSync(abs)) return null;
  const stat = fs.lstatSync(abs);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw memoryError('E_PROCEDURE_INVALID', `不是普通文件，拒绝读写：${relativePath(root, abs)}`);
  }
  return readProcedureFile(root, abs);
}

/**
 * Write `card` to its file and prove the write by reading it back and parsing
 * it again. Any mismatch restores the pre-write backup; a write that cannot be
 * proven must never be reported as success.
 */
function writeVerifiedCard(root, card, { now, backupOfPrevious }) {
  const text = buildCardText(card);
  const backup = backupOfPrevious ? backupFile(root, card.abs, { now }) : null;
  let written;
  try {
    written = writeFileAtomic(root, card.abs, text, { backup: false, now });
    const readBack = fs.readFileSync(card.abs, 'utf8');
    const reparsed = readProcedureFile(root, card.abs, readBack);
    const problems = [];
    if (reparsed.name !== card.name) problems.push(`name ${reparsed.name} != ${card.name}`);
    if (JSON.stringify(reparsed.trigger) !== JSON.stringify(card.trigger)) problems.push('trigger 不一致');
    if (reparsed.revisions !== card.revisions) problems.push(`revisions ${reparsed.revisions} != ${card.revisions}`);
    if (reparsed.strength !== card.strength) problems.push(`strength ${reparsed.strength} != ${card.strength}`);
    if (reparsed.invalid) problems.push(`写出的卡不合法：${reparsed.invalidReason}`);
    const wantedExtras = card.extras && typeof card.extras === 'object' ? card.extras : {};
    for (const [key, value] of Object.entries(wantedExtras)) {
      if (PROCEDURE_FIELDS.includes(key) || value == null) continue;
      if (reparsed.extras[key] !== String(value)) problems.push(`extras ${key} 不一致`);
    }
    if (problems.length > 0) {
      throw memoryError('E_PROCEDURE_VERIFY', `写后校验失败：${problems.join('；')}`);
    }
    return { text, written, readBack, backup };
  } catch (error) {
    if (backup) {
      try {
        restoreBackup(root, backup.path, card.abs);
      } catch (restoreError) {
        throw memoryError('E_ROLLBACK_FAILED', `写后校验失败且无法回滚：${card.rel}`, restoreError);
      }
    } else if (fs.existsSync(card.abs)) {
      // A new card that failed verification is not left half-written.
      try {
        fs.unlinkSync(card.abs);
      } catch {
        /* best effort: the verification error is the one to report */
      }
    }
    throw error instanceof Error && error.code ? error : memoryError('E_PROCEDURE_VERIFY', `写入失败：${card.rel}`, error);
  }
}

function saveProcedure(root, args, { now, today, sessionId = null, turn = null }) {
  const nameArg = args.name === undefined ? '' : singleLine('name', args.name);
  const slugArg = args.slug === undefined || args.slug === null ? '' : singleLine('slug', args.slug);
  const slug = slugFrom(slugArg || nameArg, slugArg ? 'slug' : 'name');
  const abs = procedurePath(root, slug);

  const existing = fs.existsSync(abs) ? readProcedureFile(root, abs) : null;
  if (existing?.invalid) {
    throw memoryError(
      'E_PROCEDURE_INVALID',
      `${existing.rel} 的 frontmatter 坏了（${existing.invalidReason}）— 先手工修好或删掉它，工具拒绝静默覆盖`,
    );
  }

  const triggerArg = args.trigger === undefined ? null : normalizeTrigger(args.trigger, 'trigger');
  const salienceArg = intArg(args.salience, 'salience', 1, MAX_SALIENCE);
  const strengthArg = intArg(args.strength, 'strength', 0, MAX_STRENGTH);
  const whenArg = normalizeText('when', args.when);
  const stepsArg = normalizeSteps(args.steps);
  const failureArg = normalizeText('failureModes', args.failureModes);
  const exampleArg = normalizeText('example', args.example);

  const name = nameArg || existing?.name || '';
  if (name === '') {
    throw memoryError('E_BAD_ARGUMENT', 'save 需要 name — 或者用 slug 指向一张已存在的卡');
  }

  if (existing) {
    const sections = {
      when: whenArg ?? existing.sections.when,
      steps: stepsArg ?? existing.sections.steps,
      failureModes: failureArg ?? existing.sections.failureModes,
      example: exampleArg ?? existing.sections.example,
      extraSections: existing.sections.extraSections,
      revLines: existing.sections.revLines,
    };
    const trigger = triggerArg ?? existing.trigger;
    if (trigger.length === 0) {
      throw memoryError('E_BAD_ARGUMENT', `${existing.rel} 没有 trigger — 合并时给一个关键词，否则这张卡永远搜不到`);
    }
    if (!sections.when) {
      throw memoryError('E_BAD_ARGUMENT', `${existing.rel} 没有「何时用」— 合并时给 when，或先修卡`);
    }
    if (sections.steps.length === 0) {
      throw memoryError('E_BAD_ARGUMENT', `${existing.rel} 没有「怎么做」步骤 — 合并时给 steps，或先修卡`);
    }
    const card = {
      abs,
      rel: existing.rel,
      slug,
      name,
      trigger,
      salience: salienceArg ?? existing.salience,
      strength: strengthArg ?? existing.strength,
      last_used: existing.last_used ?? today,
      revisions: existing.revisions + 1,
      // B3: a merge keeps the original source stamps ("已有则保留"); a card
      // written before B3 gains them from this merge onward.
      extras: stampExtras(existing.extras, { sessionId, turn, at: now }),
      sections,
    };
    const { written, backup } = writeVerifiedCard(root, card, { now, backupOfPrevious: true });
    appendAudit(root, {
      action: 'memory_procedure',
      object: card.rel,
      result: `save merged version=${card.revisions + 1} revisions=${card.revisions}`,
      now,
    });
    return {
      ok: true,
      action: 'save',
      status: 'merged',
      root,
      path: abs,
      rel: card.rel,
      slug,
      name: card.name,
      trigger: card.trigger,
      salience: card.salience,
      strength: card.strength,
      last_used: card.last_used,
      revisions: card.revisions,
      version: card.revisions + 1,
      previousVersion: existing.revisions + 1,
      created: false,
      legacy: false,
      invalid: false,
      sha256: written.sha256,
      backup: backup?.path ?? null,
      backupRel: backup?.rel ?? null,
      body: card.sections,
      message:
        `已合并 ${card.rel}：版本 ${card.revisions}→${card.revisions + 1}` +
        `（revisions=${card.revisions}），上一版备份 ${backup?.rel ?? '（无）'}`,
    };
  }

  if (triggerArg === null || triggerArg.length === 0) {
    throw memoryError('E_BAD_ARGUMENT', '新程序卡需要 trigger（什么时候该用这条流程）');
  }
  if (!whenArg) {
    throw memoryError('E_BAD_ARGUMENT', '新程序卡需要 when（正文「何时用」：什么情况下该用这条流程）');
  }
  if (!stepsArg || stepsArg.length === 0) {
    throw memoryError('E_BAD_ARGUMENT', '新程序卡需要 steps（正文「怎么做」：至少一条编号步骤）');
  }

  const rel = relativePath(root, abs);
  const sections = {
    when: whenArg,
    steps: stepsArg,
    failureModes: failureArg,
    example: exampleArg,
    extraSections: [],
    revLines: [],
  };
  // B3: a new procedure is a new conclusion — check it against every existing
  // card before writing, and mirror the marker onto the old cards afterwards.
  const conflicts = detectConflicts(root, {
    rel,
    title: name,
    body: composeBody(sections),
    key: null,
  });
  const extras = stampExtras({}, { sessionId: sessionId ?? MANUAL_SESSION, turn, at: now });
  if (conflicts.length > 0) {
    extras.conflict = `[${conflicts.map((row) => row.rel).join(', ')}]`;
  }

  const card = {
    abs,
    rel,
    slug,
    name,
    trigger: triggerArg,
    salience: salienceArg ?? 3,
    strength: strengthArg ?? 3,
    last_used: today,
    revisions: 0,
    // No host session (a human calling the tool) is recorded honestly as
    // `manual`, not as a made-up id.
    extras,
    sections,
  };
  const { written } = writeVerifiedCard(root, card, { now, backupOfPrevious: false });
  const marked = [];
  try {
    for (const conflict of conflicts) {
      marked.push(appendConflictWith(root, conflict.rel, card.rel, { now }));
    }
  } catch (error) {
    for (const row of marked.reverse()) {
      if (!row.changed || !row.backup) continue;
      try {
        restoreBackup(root, row.backup, resolveInside(root, row.rel));
      } catch {
        /* the original error is the one to report */
      }
    }
    try {
      fs.unlinkSync(abs);
    } catch {
      /* best effort */
    }
    throw error;
  }
  appendAudit(root, {
    action: 'memory_procedure',
    object: card.rel,
    result: `save created revisions=0`,
    now,
  });
  return {
    ok: true,
    action: 'save',
    status: 'created',
    root,
    path: abs,
    rel: card.rel,
    slug,
    name: card.name,
    trigger: card.trigger,
    salience: card.salience,
    strength: card.strength,
    last_used: card.last_used,
    revisions: 0,
    version: 1,
    previousVersion: null,
    created: true,
    legacy: false,
    invalid: false,
    sha256: written.sha256,
    backup: null,
    backupRel: null,
    body: card.sections,
    conflicts: conflicts.map((row) => ({ rel: row.rel, title: row.title, reasons: row.reasons })),
    conflictWith: marked.map((row) => row.rel),
    message: `已新建程序卡 ${card.rel}（版本 1，revisions=0）；下次同名 save 会合并成版本 2`,
  };
}

function getProcedure(root, args) {
  const card = findCard(root, args);
  if (!card) {
    const target = stringArg(args.slug) || stringArg(args.name);
    throw memoryError('E_PROCEDURE_NOT_FOUND', `找不到程序卡：${target} — 用 action:"list" 看现有卡`);
  }
  if (card.invalid) {
    throw memoryError(
      'E_PROCEDURE_INVALID',
      `${card.rel} 的 frontmatter 不合法（${card.invalidReason}）— 修好它，或删掉后重新 save`,
    );
  }
  return {
    ok: true,
    action: 'get',
    root,
    path: card.abs,
    rel: card.rel,
    slug: card.slug,
    name: card.name,
    trigger: card.trigger,
    salience: card.salience,
    strength: card.strength,
    last_used: card.last_used,
    revisions: card.revisions,
    version: card.version,
    legacy: card.legacy,
    invalid: false,
    sections: {
      when: card.sections.when,
      steps: card.sections.steps,
      failureModes: card.sections.failureModes,
      example: card.sections.example,
    },
    text: card.text,
    sha256: sha256File(card.abs),
    message: `程序卡 ${card.rel}：版本 ${card.version}，strength ${card.strength}，${card.trigger.length} 个触发词`,
  };
}

function listProcedures(root, args) {
  const { cards, invalid } = scanProcedures(root);
  const keywords = keywordList(args.trigger ?? args.query ?? '');
  const lowered = keywords.map((keyword) => keyword.toLowerCase());
  const filtered = lowered.length === 0
    ? cards
    : cards.filter((card) => card.trigger.some((term) => {
      const haystack = term.toLowerCase();
      return lowered.some((keyword) => haystack.includes(keyword));
    }));

  const limit = intArg(args.limit, 'limit', 1, MAX_LIST_LIMIT) ?? DEFAULT_LIST_LIMIT;
  const page = filtered.slice(0, limit);
  return {
    ok: true,
    action: 'list',
    root,
    count: filtered.length,
    total: cards.length,
    invalidCount: invalid.length,
    truncated: filtered.length > page.length,
    limit,
    keywords,
    items: page.map(listItem),
    invalid: invalid.map((card) => ({ rel: card.rel, reason: card.invalidReason })),
    message:
      `程序卡 ${filtered.length}/${cards.length} 张` +
      `${keywords.length > 0 ? `（trigger 匹配 ${keywords.join(' / ')}）` : ''}` +
      `${invalid.length > 0 ? `；${invalid.length} 张 frontmatter 坏了，已标注` : ''}`,
  };
}

function reportProcedure(root, args, { now, today }) {
  const target = stringArg(args.slug) || stringArg(args.name);
  if (!target) {
    throw memoryError('E_BAD_ARGUMENT', 'report 需要 slug 或 name（要报告哪张程序卡）');
  }
  const outcome = stringArg(args.outcome);
  if (!outcome) {
    throw memoryError('E_BAD_ARGUMENT', `report 需要 outcome（${OUTCOMES.join(' | ')}）`);
  }
  if (!OUTCOMES.includes(outcome)) {
    throw memoryError('E_BAD_ARGUMENT', `outcome 只能是 ${OUTCOMES.join(' | ')} — 收到 ${JSON.stringify(outcome)}`);
  }
  const card = findCard(root, args);
  if (!card) {
    throw memoryError('E_PROCEDURE_NOT_FOUND', `找不到程序卡：${target} — 用 action:"list" 看现有卡`);
  }
  if (card.invalid) {
    throw memoryError(
      'E_PROCEDURE_INVALID',
      `${card.rel} 的 frontmatter 不合法（${card.invalidReason}）— 先修好它，report 不会拿坏卡记账`,
    );
  }
  if (card.legacy) {
    throw memoryError(
      'E_PROCEDURE_INVALID',
      `${card.rel} 是没有 frontmatter 的旧卡 — 先用 action:"save" 补成 name/trigger/salience/strength/last_used 的新格式，再 report`,
    );
  }

  const before = { strength: card.strength, last_used: card.last_used, revisions: card.revisions };
  const capped = outcome === 'success' && card.strength >= MAX_STRENGTH;
  const floored = outcome === 'failure' && card.strength <= 0;
  const nextStrength = outcome === 'success'
    ? Math.min(MAX_STRENGTH, card.strength + 1)
    : Math.max(0, card.strength - 1);
  const reason = typeof args.reason === 'string' && args.reason.trim()
    ? args.reason.trim().replace(/[\r\n]+/g, ' ').slice(0, MAX_REASON_CHARS)
    : '';
  const revLine = `<!-- rev: ${today} ${outcome}${reason ? ` ${reason}` : ''} -->`;

  // revisions stays put: strength counts real uses, revisions counts content
  // versions. Bumping revisions here would make a used card look edited.
  let updated = updateFrontmatter(card.text, { strength: nextStrength, last_used: today });
  updated = appendLine(updated, revLine);

  const backup = backupFile(root, card.abs, { now });
  let problems = [];
  try {
    writeFileAtomic(root, card.abs, updated, { backup: false, now });
    const readBack = fs.readFileSync(card.abs, 'utf8');
    const reparsed = readProcedureFile(root, card.abs, readBack);
    if (reparsed.invalid) problems.push(`读回不合法：${reparsed.invalidReason}`);
    if (reparsed.strength !== nextStrength) problems.push(`strength ${reparsed.strength} != ${nextStrength}`);
    if (reparsed.last_used !== today) problems.push(`last_used ${reparsed.last_used} != ${today}`);
    if (reparsed.revisions !== card.revisions) problems.push(`revisions 被改动：${reparsed.revisions} != ${card.revisions}`);
    if (normalizedBody(parseFrontmatter(card.text).body) !== normalizedBody(parseFrontmatter(readBack).body)) {
      problems.push('正文被改动');
    }
    if (countRevLines(reparsed.text) !== countRevLines(card.text) + 1) {
      problems.push('rev 注释没有恰好追加一行');
    }
  } catch (error) {
    try {
      restoreBackup(root, backup.path, card.abs);
    } catch (restoreError) {
      throw memoryError('E_ROLLBACK_FAILED', `report 写后校验失败且无法回滚：${card.rel}`, restoreError);
    }
    throw error instanceof Error && error.code ? error : memoryError('E_PROCEDURE_VERIFY', `report 写入失败：${card.rel}`, error);
  }
  if (problems.length > 0) {
    try {
      restoreBackup(root, backup.path, card.abs);
    } catch (restoreError) {
      throw memoryError('E_ROLLBACK_FAILED', `report 写后校验失败且无法回滚：${card.rel}`, restoreError);
    }
    throw memoryError('E_PROCEDURE_VERIFY', `report 写后校验失败，已回滚：${problems.join('；')}`);
  }

  appendAudit(root, {
    action: 'memory_procedure',
    object: card.rel,
    result: `report ${outcome} strength=${nextStrength} revisions=${card.revisions}`,
    now,
  });
  return {
    ok: true,
    action: 'report',
    status: 'reported',
    root,
    path: card.abs,
    rel: card.rel,
    slug: card.slug,
    name: card.name,
    outcome,
    before,
    after: { strength: nextStrength, last_used: today },
    revisions: card.revisions,
    version: card.revisions + 1,
    capped,
    floored,
    bodyIdentical: true,
    revLine,
    backup: backup.path,
    backupRel: backup.rel,
    sha256: backup.sha256,
    message:
      `已记录 ${card.rel} ${outcome}：strength ${before.strength}→${nextStrength}` +
      `${capped ? '（到顶 9）' : ''}${floored ? '（到底 0）' : ''}，last_used=${today}，` +
      `revisions 保持 ${card.revisions}（内容版本不变），备份 ${backup.rel}`,
  };
}

/**
 * memory_procedure: save | list | get | report.
 *
 * All four act on the same on-disk contract. `save` is the only writer of new
 * content; `report` is the only writer of usage history. Neither touches the
 * other's field.
 */
export function memoryProcedure(args = {}, config = {}) {
  const root = memoryRootFromConfig(config);
  const now = config.now instanceof Date ? config.now : new Date();
  const today = typeof config.today === 'string' && config.today.trim() !== ''
    ? config.today.trim()
    : dayString(now);

  const action = stringArg(args.action);
  if (!action) {
    throw memoryError('E_BAD_ARGUMENT', `memory_procedure 需要 action（${PROCEDURE_ACTIONS.join(' | ')}）`);
  }
  if (!PROCEDURE_ACTIONS.includes(action)) {
    throw memoryError('E_BAD_ARGUMENT', `未知 action：${JSON.stringify(action)} — 只支持 ${PROCEDURE_ACTIONS.join(' | ')}`);
  }

  // B3: the caller's session is real host identity (`exec.agent.session...`);
  // the turn is only written when the host/caller actually supplied one.
  const exec = config.exec;
  const sessionId = sessionIdOfExec(exec);
  const turn = Number.isInteger(config.turn) && config.turn >= 0
    ? config.turn
    : (Number.isInteger(exec?.turn) && exec.turn >= 0 ? exec.turn : null);
  const context = { now, today, sessionId, turn };

  let result;
  if (action === 'save') result = saveProcedure(root, args, context);
  else if (action === 'list') return listProcedures(root, args, context);
  else if (action === 'get') return getProcedure(root, args, context);
  else result = reportProcedure(root, args, context);

  // A save/report changed a card, so the manifest baseline must move with it.
  // This is best effort: the card write already succeeded and is verified; a
  // manifest failure must be reported, not turned into a fake card failure.
  if (action === 'save' || action === 'report') {
    try {
      const refreshed = refreshManifest(root, { now });
      result.manifest = {
        rel: relativePath(root, manifestPath(root)),
        cards: refreshed.manifest.cards.length,
        sha256: refreshed.sha256,
      };
    } catch (error) {
      result.manifestWarning = error?.message ?? String(error);
    }
  }
  return result;
}
