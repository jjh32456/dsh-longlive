// identity-router v0 — 交接卡草稿生成
//
// 默认只写 <repo>/outbox/，绝不写 memoryRoot。
// 这里没有语义总结能力：所谓「当前进度/下一步/风险」要么由调用方显式给，
// 要么从 STATE.md 的三节原样搬运。缺就写占位，不编。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_MEMORY_ROOT,
  STATE_SECTIONS,
  charLength,
  compactSection,
  normalizeText,
  parseState,
  readTextFile,
  truncateChars,
} from './handover.js';

/** 草稿默认上限（码点）。交接卡是给人看的，1600 字足够，超出说明该拆卡。 */
export const DRAFT_MAX_CHARS = 1600;

/**
 * v0 默认 outbox：本仓库根目录下的 outbox。
 * 插件被安装到别处时，用 config.outboxDir 或 DSH_IDENTITY_OUTBOX 覆盖。
 * @returns {string}
 */
export function defaultOutboxDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'outbox');
}

/**
 * 解析 outbox：显式参数 > 环境变量 > 仓库默认。
 * @param {{outboxDir?: string}} [config]
 * @param {Record<string,string|undefined>} [env]
 * @returns {string}
 */
export function resolveOutboxDir(config = {}, env = process.env) {
  const explicit = config?.outboxDir;
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(explicit.trim());
  const fromEnv = env?.DSH_IDENTITY_OUTBOX;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim());
  return defaultOutboxDir();
}

/**
 * 把字符串/数组统一成干净的条目数组。
 * @param {unknown} input
 * @returns {string[]}
 */
export function normalizeItems(input) {
  if (Array.isArray(input)) {
    return input
      .flatMap((item) => normalizeItems(item))
      .filter((item) => item !== '');
  }
  if (typeof input !== 'string') return [];
  return normalizeText(input)
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/u, '').trim())
    .filter((line) => line !== '');
}

/**
 * 中文主题也能生成稳定文件名：只保留 ASCII 安全字符，其余丢弃。
 * 全部丢光时回退到 fallback，不会产出空 slug。
 * @param {unknown} topic
 * @param {string} [fallback]
 * @returns {string}
 */
export function slugifyTopic(topic, fallback = 'session') {
  const ascii = String(topic ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return ascii === '' ? fallback : ascii;
}

/**
 * 本地日期 `YYYY-MM-DD`。
 * @param {Date} date
 * @returns {string}
 */
export function formatDate(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 本地时间 `YYYY-MM-DD HH:mm`。
 * @param {Date} date
 * @returns {string}
 */
export function formatDateTime(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 把一节里的多行压成一行：去掉 bullet 前缀，条目之间用「；」，不留 `。；`。
 * @param {string} text
 * @returns {string}
 */
function inlineSection(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => line.replace(/^[-*+]\s+/u, '').replace(/[；;]\s*$/u, ''))
    .join('；')
    .replace(/。；/gu, '；')
    .replace(/；{2,}/gu, '；')
    .replace(/；$/u, '');
}

/**
 * 从 STATE.md 提「当前进度 / 下一步」，只搬运不总结。
 * @param {unknown} stateText
 * @param {{maxChars?: number}} [options]
 * @returns {{progress:string[], next:string[], warnings:string[]}}
 */
export function deriveFromState(stateText, options = {}) {
  const warnings = [];
  const text = normalizeText(stateText);
  if (text.trim() === '') {
    return {
      progress: ['（未提供 STATE.md，当前进度需人工补充）'],
      next: ['（未提供 STATE.md，下一步需人工补充）'],
      warnings: ['STATE_MISSING'],
    };
  }

  const parsed = parseState(text);
  const budget = Number.isFinite(options.maxChars) ? Math.max(80, options.maxChars) : 500;
  const where = compactSection(parsed.sections, STATE_SECTIONS.where, budget);
  const recent = compactSection(parsed.sections, STATE_SECTIONS.recent, budget);
  const waiting = compactSection(parsed.sections, STATE_SECTIONS.waiting, budget);

  if (!where.found) warnings.push(`SECTION_MISSING:${STATE_SECTIONS.where}`);
  if (!recent.found) warnings.push(`SECTION_MISSING:${STATE_SECTIONS.recent}`);
  if (!waiting.found) warnings.push(`SECTION_MISSING:${STATE_SECTIONS.waiting}`);

  const progress = [
    where.found ? `【我在哪】${inlineSection(where.text)}` : '',
    recent.found ? `【最近三件】${inlineSection(recent.text)}` : '',
  ].filter(Boolean);

  return {
    progress: progress.length > 0 ? progress : ['（STATE.md 的三节都缺失，请人工补充）'],
    next: waiting.found ? [inlineSection(waiting.text)] : ['（STATE.md 没有「在等什么」，请人工补充）'],
    warnings,
  };
}

/**
 * 生成交接卡草稿。纯函数，不写盘。
 * @param {{
 *   topic?: string,
 *   stateText?: string|null,
 *   progress?: string[]|string,
 *   next?: string[]|string,
 *   risks?: string[]|string,
 *   now?: Date|number|string,
 *   maxChars?: number,
 *   source?: string,
 * }} [input]
 * @returns {{text:string, filename:string, slug:string, chars:number,
 *   truncated:boolean, warnings:string[], usedFallbackState:boolean}}
 */
export function buildHandoverDraft(input = {}) {
  const maxChars = Number.isFinite(input.maxChars) && input.maxChars > 0
    ? Math.floor(input.maxChars)
    : DRAFT_MAX_CHARS;
  const now = input.now instanceof Date ? input.now : new Date(input.now ?? Date.now());
  const safeNow = Number.isFinite(now.getTime()) ? now : new Date();

  const stateText = typeof input.stateText === 'string' ? input.stateText : '';
  const warnings = [];
  const fromState = deriveFromState(stateText);
  warnings.push(...fromState.warnings);

  const progress = normalizeItems(input.progress);
  const next = normalizeItems(input.next);
  const risks = normalizeItems(input.risks);
  // 只有「STATE 根本读不到」且调用方也没给进度/下一步时，才算真的退化。
  // 正常情况下从 STATE 搬运是设计路径，不该报警。
  const stateMissing = stateText.trim() === '';
  const usedFallbackState = stateMissing && (progress.length === 0 || next.length === 0);

  const finalProgress = progress.length > 0 ? progress : fromState.progress;
  const finalNext = next.length > 0 ? next : fromState.next;
  const finalRisks = risks.length > 0
    ? risks
    : ['（本次未自动识别到新风险；请人工补充「可能坑到下一轮的地方」）'];

  const topic = typeof input.topic === 'string' && input.topic.trim() !== ''
    ? input.topic.trim()
    : '未命名会话';
  const slug = slugifyTopic(topic);
  const filename = `${formatDate(safeNow)}-${slug}.md`;
  const source = typeof input.source === 'string' && input.source.trim() !== ''
    ? input.source.trim()
    : 'STATE.md / 会话上下文';

  const bulletize = (items) => items.map((item) => `- ${item.replace(/\s*\n\s*/gu, ' ').trim()}`);

  const lines = [
    `# 交接卡草稿：${topic}`,
    '',
    `> identity-router v0 自动生成 · ${formatDateTime(safeNow)} · 来源：${source}`,
    '> 这是草稿，尚未写入 memoryRoot；由人或后续版本合并。',
    '',
    '## 当前进度',
    ...bulletize(finalProgress),
    '',
    '## 下一步',
    ...bulletize(finalNext),
    '',
    '## 风险',
    ...bulletize(finalRisks),
    '',
  ];

  let text = lines.join('\n');
  if (usedFallbackState) {
    warnings.push('DRAFT_USED_STATE_FALLBACK');
  }

  const cut = truncateChars(text, maxChars);
  if (cut.truncated) {
    warnings.push('DRAFT_TRUNCATED');
    text = `${cut.text}\n`;
  }

  return {
    text,
    filename,
    slug,
    chars: charLength(text),
    truncated: cut.truncated,
    warnings,
    usedFallbackState,
  };
}

/**
 * 原子写入草稿：先写同目录临时文件，再 rename 成目标名。
 * 目标重名时自动加 `-2`、`-3`（最多 50 次），绝不覆盖已有草稿。
 * @param {{text:string,filename:string}} draft
 * @param {{outboxDir?:string}} [options]
 * @returns {{ok:boolean,path:string|null,filename:string|null,bytes:number,error?:string}}
 */
export function writeHandoverDraft(draft, options = {}) {
  if (!draft || typeof draft.text !== 'string' || draft.text.trim() === '') {
    return { ok: false, path: null, filename: null, bytes: 0, error: 'EMPTY_DRAFT' };
  }
  const outboxDir = resolveOutboxDir(options);
  const base = String(draft.filename ?? '').trim() === ''
    ? `${formatDate(new Date())}-session.md`
    : path.basename(String(draft.filename));
  const stem = base.replace(/\.md$/iu, '');

  try {
    fs.mkdirSync(outboxDir, { recursive: true });
  } catch (error) {
    return { ok: false, path: null, filename: null, bytes: 0, error: error?.code ?? 'EMKDIR' };
  }

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? `${stem}.md` : `${stem}-${attempt + 1}.md`;
    const target = path.join(outboxDir, candidate);
    if (fs.existsSync(target)) continue;
    const tmp = path.join(
      outboxDir,
      `.${candidate}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    );
    try {
      fs.writeFileSync(tmp, draft.text, 'utf8');
      fs.renameSync(tmp, target);
      const bytes = fs.statSync(target).size;
      return { ok: true, path: target, filename: candidate, bytes };
    } catch (error) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        // 临时文件清不掉也不遮住真正的错误
      }
      return { ok: false, path: null, filename: null, bytes: 0, error: error?.code ?? 'EWRITE' };
    }
  }

  return { ok: false, path: null, filename: null, bytes: 0, error: 'ENAME_COLLISION' };
}

/**
 * 一步到位：读 STATE → 生成草稿 → 写 outbox。只读 STATE，写只落 outbox。
 * @param {{
 *   statePath?:string, memoryRoot?:string, outboxDir?:string,
 *   topic?:string, progress?:string[]|string, next?:string[]|string,
 *   risks?:string[]|string, now?:Date|number|string, maxChars?:number,
 *   source?:string, env?:Record<string,string|undefined>,
 * }} [options]
 * @returns {ReturnType<typeof buildHandoverDraft> & {
 *   ok:boolean, path:string|null, statePath:string, error?:string,
 * }}
 */
export function writeHandoverFromState(options = {}) {
  const env = options.env ?? process.env;
  const memoryRoot = typeof options.memoryRoot === 'string' && options.memoryRoot.trim() !== ''
    ? path.resolve(options.memoryRoot)
    : path.resolve(env.DSH_IDENTITY_MEMORY_ROOT || DEFAULT_MEMORY_ROOT);
  const statePath = typeof options.statePath === 'string' && options.statePath.trim() !== ''
    ? path.resolve(options.statePath)
    : path.join(memoryRoot, 'STATE.md');

  const read = readTextFile(statePath);
  const draft = buildHandoverDraft({
    topic: options.topic,
    stateText: read.ok ? read.text : '',
    progress: options.progress,
    next: options.next,
    risks: options.risks,
    now: options.now,
    maxChars: options.maxChars,
    source: options.source ?? statePath,
  });

  if (!read.ok) draft.warnings.push(`STATE_READ_FAILED:${read.error}`);

  const written = writeHandoverDraft(draft, { outboxDir: options.outboxDir });
  return {
    ...draft,
    ok: written.ok,
    path: written.path,
    statePath,
    ...(written.ok ? {} : { error: written.error }),
  };
}
