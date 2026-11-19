// src/autoprocedure/privacy.js — 两道隐私门（F9）与路径/用户名归一化。
//
// 口径（v0.3 §3.2 / D1 c4-c5）：
//   * 蒸馏前：对每个片段做「路径归一化 → privacyScan」，命中即丢弃该片段并
//     计 reject reason=privacy；
//   * 候选最终正文落盘前：对整篇正文再跑一遍同样的门，命中即整条候选丢弃并
//     计数（纵深防御，不依赖第一道门没有漏）。
//
// 归一化只做「绝对路径 → 占位符」，绝不改写用户内容里的其他东西：
//   <memoryRoot>  → <memoryRoot>
//   <home>        → <DSH_HOME>
//   盘符用户目录（Windows 账户目录） → %USERPROFILE%
//   POSIX 家目录（home/Users 下的账户目录） → %USERPROFILE%
//   其它盘符绝对路径 → <drive>:<分隔符>
// 反斜杠/正斜杠两种写法都覆盖；替换顺序是「先具体、后泛化」。
// 归一化后仍出现「裸盘符绝对路径」的片段不受信任（lint 规则 ⑤ 会记 issue），
// 因此这里同时导出 containsUnnormalizedPath() 供 lint 复用。

import { privacyScan } from '../recall/privacy.mjs';

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pathVariant(value) {
  if (value.includes('\\')) return value.replace(/\\/g, '/');
  if (value.includes('/')) return value.replace(/\//g, '\\');
  return value;
}

/** Replace literal path occurrences (both separators) without touching the rest. */
function replaceLiteral(text, literal, placeholder) {
  const value = String(literal ?? '').trim();
  if (value === '') return text;
  let out = text;
  for (const variant of [value, pathVariant(value)]) {
    if (variant === '') continue;
    out = out.replace(new RegExp(escapeRegExp(variant), 'gi'), placeholder);
  }
  return out;
}

const WINDOWS_USER_PATH = /(?<![A-Za-z0-9+.-])[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`]+/gi;
const POSIX_HOME_PATH = /(?<![A-Za-z0-9._-])\/(?:home|Users)\/[^/\s"'`]+/g;
const BARE_DRIVE = /(?<![A-Za-z0-9])[A-Za-z]:[\\/]/g;

/**
 * Normalise absolute paths / user names to placeholders. Pure, idempotent.
 * The order matters: specific (memoryRoot / home) before the generic drive rule.
 */
export function normalizePathsInText(text, { memoryRoot = '', home = '' } = {}) {
  let out = String(text ?? '');
  out = replaceLiteral(out, memoryRoot, '<memoryRoot>');
  out = replaceLiteral(out, home, '<DSH_HOME>');
  out = out.replace(WINDOWS_USER_PATH, '%USERPROFILE%');
  out = out.replace(POSIX_HOME_PATH, '%USERPROFILE%');
  // Keep the separator so a normalised path still reads like a path.
  out = out.replace(BARE_DRIVE, (match) => `<drive>:${match.slice(2, 3)}`);
  return out;
}

/** True when the text still carries an absolute drive path (lint rule ⑤). */
export function containsUnnormalizedPath(text) {
  BARE_DRIVE.lastIndex = 0;
  return BARE_DRIVE.test(String(text ?? ''));
}

/**
 * Distillation gate for one fragment.
 * @returns {{ok:boolean, text:string, reasons:string[]}}
 */
export function sanitizeFragment(text, options = {}) {
  const normalized = normalizePathsInText(text, options);
  const verdict = privacyScan(normalized);
  if (verdict.verdict !== 'none') {
    return { ok: false, text: normalized, reasons: verdict.reasons ?? [] };
  }
  return { ok: true, text: normalized, reasons: [] };
}

/**
 * Final gate for the whole candidate body (F9 second pass).
 * @returns {{ok:boolean, text:string, reasons:string[]}}
 */
export function sanitizeCandidateBody(body, options = {}) {
  return sanitizeFragment(body, options);
}
