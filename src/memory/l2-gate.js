// src/memory/l2-gate.js — M2-D：L1/L2/L3 保真闸 + 保护谓词（fail-safe）
//
// 设计依据 MEMORY-RECALL-V2-PROPOSAL §4.1.1/§4.2.1/§4.2.2：
//   * L1 精确（原话/数字/版本/路径/时间）：摘要不保证逐字，但必须保留锚点回读入口；
//   * L2 要点（who/what/when/decision/why）：重要事件蒸馏后必须 100% 可直接答，
//     一般事件 ≥90%；不达标就“不要蒸馏”（保持原文粒度），宁多留不误蒸；
//   * L3 大意：深时记忆不许空白。
//   * 保护谓词（fail-safe 闭）：protected(x) = kind∈forbid || salience==5 ||
//     status==locked || inProtectedJson(x) || l2GatePass !== true；
//     **只有显式 l2GatePass===true 才放行**，false/undefined/缺字段/缺 manifest 全 protect。
//
// 本模块只做纯判定（无 LLM、无网络）；写盘由 distill.js / decay.js 负责。

import { readProtectionManifest } from './retention.js';

export const FORBID_KINDS = Object.freeze([
  'incident', 'decision', 'release', 'rule', 'preference', 'milestone', 'lifecycle', 'noise', 'unknown',
]);
export const ALLOW_KINDS = Object.freeze(['daily']);

/** Project vocabulary used by extraction/judging (kept in one place; no inference). */
export const CAUSAL_WORDS = Object.freeze(['因为', '所以', '由于', '原因', '导致', '为了', '因此', 'why']);
export const EMOTION_WORDS = Object.freeze(['担心', '着急', '急', '哭', '高兴', '兴奋', '难过', '焦虑', '累', '疲惫', '紧迫', '开心', '生气', '害怕', '放心']);
export const DECISION_WORDS = Object.freeze(['决定', '拍板', '定为', '冻结', '解冻', '取消', '改成', '发布', '完成', '上线', '回滚', '修好', '确认', '通过', '不许', '必须', '禁止']);
export const INCIDENT_WORDS = Object.freeze(['事故', '崩溃', '失败', '超窗', '卡死', 'ECONNRESET', 'truncat', '异常', '报错', '损坏']);
export const RULE_WORDS = Object.freeze(['纪律', '铁律', '规矩', '必须', '禁止', '不许']);
export const RELEASE_WORDS = Object.freeze(['发布', '版本', 'tag', 'npm', 'GitHub', 'commit', 'release', 'v1.', 'v2.', 'v3.']);
export const PREFERENCE_WORDS = Object.freeze(['偏好', '习惯', '喜欢', '不要', '讨厌', '爱吃']);
export const NOISE_WORDS = Object.freeze(['重复', '副本', '空操作', 'noop']);

export class FidelityGateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FidelityGateError';
    this.code = code;
    this.status = code === 'E_DISTILL_PROTECTED' ? 403 : 422;
    this.details = details;
  }
}

export function normalizeForMatch(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[，。；：！？、,.!?;:…—–\-_/\\()()[\]{}"'"'`]+/g, '')
    .trim();
}

export function isForbiddenKind(kind) {
  if (kind === undefined || kind === null || String(kind).trim() === '') return true;
  return FORBID_KINDS.includes(String(kind));
}

/** Rule-based candidate kind (§4.2.1); human may confirm later. Unknown text => daily candidate. */
export function classifyKindV2(text) {
  const value = String(text ?? '');
  const has = (words) => words.some((word) => value.includes(word));
  if (has(NOISE_WORDS) && value.trim().length < 40) return 'noise';
  if (has(INCIDENT_WORDS)) return 'incident';
  if (has(RULE_WORDS)) return 'rule';
  if (has(RELEASE_WORDS)) return 'release';
  if (has(DECISION_WORDS)) return 'decision';
  if (has(PREFERENCE_WORDS)) return 'preference';
  if (value.trim() === '') return 'unknown';
  return 'daily';
}

function matchRequirement(field, requirement, text, normalized) {
  if (requirement === undefined || requirement === null) return true; // 未要求，不计入
  if (typeof requirement === 'function') return requirement(text) === true;
  if (requirement === true) {
    if (field === 'why') return CAUSAL_WORDS.some((word) => normalized.includes(normalizeForMatch(word)));
    if (field === 'emotion') return EMOTION_WORDS.some((word) => normalized.includes(normalizeForMatch(word)));
    return normalized.length > 0;
  }
  const list = Array.isArray(requirement) ? requirement : [requirement];
  return list.some((value) => typeof value === 'string'
    && value !== ''
    && normalized.includes(normalizeForMatch(value)));
}

/**
 * judgeL2(distillText, requiredFields) -> {level:'pass'|'partial'|'fail', hits, total, fields}
 * requiredFields 形如 {who:['用户A'], what:['发布'], when:['2026-11-06'], decision:['1.6.8'], why:true}。
 * 只有“有要求”的字段计入分母（null/undefined 跳过）；每字段任一要求命中即 HIT。
 */
export function judgeL2(text, requiredFields = {}) {
  const normalized = normalizeForMatch(text);
  const fields = {};
  let hits = 0;
  let total = 0;
  for (const [field, requirement] of Object.entries(requiredFields && typeof requiredFields === 'object' ? requiredFields : {})) {
    if (requirement === undefined || requirement === null) continue;
    total += 1;
    const hit = matchRequirement(field, requirement, String(text ?? ''), normalized);
    if (hit) hits += 1;
    fields[field] = { hit, requirement };
  }
  const level = total === 0 ? 'pass' : hits === total ? 'pass' : hits > 0 ? 'partial' : 'fail';
  return { level, hits, total, fields };
}

/**
 * Pure protection predicate (§4.2.1 fail-safe). An entity is distillable only when:
 * kind=allow, salience<5, status!=locked, manifest present, and an explicit
 * l2GatePass===true exists (entity or its manifest entry) with no default-protect block.
 */
export function protectionOf(entity = {}, { manifest = null } = {}) {
  const reasons = [];
  const kind = entity?.kind;
  if (isForbiddenKind(kind)) reasons.push(kind ? `kind=${kind}` : 'kind-missing');
  if (Number(entity?.salience) >= 5) reasons.push('salience-5');
  if (String(entity?.status ?? 'active') === 'locked') reasons.push('locked');
  const currentManifest = manifest && typeof manifest === 'object' ? manifest : readProtectionManifest(entity?.memoryRoot ?? '');
  if (currentManifest?.present !== true) {
    reasons.push('manifest-missing');
  } else {
    const id = String(entity?.id ?? entity?.rel ?? entity?.path ?? '');
    const hit = Array.isArray(currentManifest.entries)
      ? currentManifest.entries.find((entry) => entry.id === id)
      : null;
    if (hit) {
      if (hit.l2GatePass !== true) reasons.push('protected-entry');
    } else if (currentManifest.defaultProtected === true) {
      reasons.push('default-protected');
    } else if (entity?.l2GatePass !== true) {
      reasons.push('l2GatePass-not-true');
    }
  }
  return { protected: reasons.length > 0, reasons };
}

export function assertDistillable(entity, options = {}) {
  const verdict = protectionOf(entity, options);
  if (verdict.protected) {
    throw new FidelityGateError(
      'E_DISTILL_PROTECTED',
      `保护谓词拒绝蒸馏：${entity?.id ?? entity?.rel ?? 'unknown'}（${verdict.reasons.join(',')}）— 保持原文粒度，宁多留不误蒸`,
      verdict,
    );
  }
  return { ok: true, verdict };
}

/**
 * L2 gate verdict for a distill attempt. Important (protected) events must pass
 * 100%; ordinary events fail the gate only on 'fail' (partial is allowed).
 */
export function assertL2Gate({ record, text, requiredFields, important = false }) {
  if (!requiredFields) return { ok: true, skipped: true, level: null };
  const judged = judgeL2(text, requiredFields);
  if (judged.level === 'pass') return { ok: true, verdict: judged };
  if (important) {
    throw new FidelityGateError(
      'E_DISTILL_L2_GATE',
      `重要事件 L2 判定 ${judged.level}（${judged.hits}/${judged.total}）→ 禁止蒸馏，保持原文粒度`,
      { id: record?.id ?? null, judged },
    );
  }
  if (judged.level === 'fail') {
    throw new FidelityGateError(
      'E_DISTILL_L2_GATE',
      `L2 判定 fail（${judged.hits}/${judged.total}）→ 本次不蒸馏，保持 L2 原文`,
      { id: record?.id ?? null, judged },
    );
  }
  return { ok: true, verdict: judged };
}
