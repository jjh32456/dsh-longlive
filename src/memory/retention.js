// src/memory/retention.js — A6：保留/删除分层（四层不删除；protected fail-safe）
//
// 层级（MEMORY-RECALL-V2-PROPOSAL §4.1/§4.2）：
//   L0 raw events   `.longlive/events/**`、session 日志复制品：通常不可变，
//                   只能经截断/手术（§4.1.1 分级）；任何常规遗忘路径不得触碰。
//   L1 distill      `.longlive/distill/**`：合并摘要，保留 gist，旧版 append 不删。
//   L2 cards/index  卡片、索引、working-frame：可归档但**必须可恢复**；
//                   working-frame 属宿主私有，永久受保护（不参与 memory_forget）。
//   L3 archive      `.longlive/archive/**`、`epochs/**`、`tombstones.md`：仅纯噪声/重复，
//                   可恢复可审计；重要事件永禁入。
//
// 保护谓词（C1 fail-safe，设计 §4.2.1）：l2GatePass !== true → protected=true，
// 即只有显式 `l2GatePass:true` 才放行，false/undefined/缺字段一律保护。
// 缺 `.longlive/protected.json` 的 legacy 行为：非 L0 普通卡仍可遗忘（M2-D 蒸馏
// 侧的 fail-safe 闸门由 src/memory/l2-gate.js 独立判定“缺 manifest=保护”）。
// 删除只能经宿主/面板动作 + 审计；本模块只提供判定，不执行删除。

import fs from 'node:fs';
import path from 'node:path';

export const RETENTION_SCHEMA = 'retention/v1';
export const RETENTION_LAYERS = Object.freeze(['L0', 'L1', 'L2', 'L3']);
export const PROTECTED_MANIFEST = '.longlive/protected.json';
export const FRAMES_DIR = '.longlive/working';

function normRel(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
}

/** Classify a path into a retention layer (pure, no IO). */
export function retentionLayerOf(relPath) {
  const rel = normRel(relPath);
  if (rel.startsWith('.longlive/working/')) return 'L2';
  if (rel.startsWith('.longlive/distill')) return 'L1';
  if (rel.startsWith('.longlive/archive/') || rel.startsWith('epochs/') || rel === 'tombstones.md') return 'L3';
  if (rel.startsWith('.longlive/events') || rel.startsWith('.longlive/index/') || rel.startsWith('.longlive/audit/')) return 'L0';
  return 'L2';
}

export function protectionManifestPathOf(memoryRoot) {
  return path.join(path.resolve(String(memoryRoot ?? '')), PROTECTED_MANIFEST);
}

/**
 * Read the protection manifest with fail-safe semantics.
 * Missing file / unparsable / entry without l2GatePass => protected on the
 * distill path; isProtectedPath keeps the legacy (pre-M2-D) missing-manifest
 * behaviour for ordinary L2/L3 cards so existing forget flows stay intact.
 */
export function readProtectionManifest(memoryRoot) {
  const file = protectionManifestPathOf(memoryRoot);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return { present: false, defaultProtected: false, entries: [], file };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { present: false, defaultProtected: false, entries: [], file };
  }
  const entries = Array.isArray(parsed?.entries)
    ? parsed.entries.filter((entry) => entry && typeof entry.id === 'string').map((entry) => ({
      id: normRel(entry.id),
      kind: typeof entry.kind === 'string' ? entry.kind : 'card',
      // C1 fail-safe (§4.2.1): only an explicit true releases protection;
      // false stays false, undefined/missing stays undefined (both protect).
      l2GatePass: entry.l2GatePass === true ? true : entry.l2GatePass === false ? false : undefined,
      source: typeof entry.source === 'string' ? entry.source : null,
      reason: typeof entry.reason === 'string' ? entry.reason : null,
    }))
    : [];
  return {
    present: true,
    defaultProtected: parsed?.default !== 'allow',
    entries,
    file,
  };
}

/**
 * Whether a card/path may be forgotten. Frames are always protected (A6: 纳入保留体系),
 * protected entries are protected unless `l2GatePass === true` (fail-safe: false/undefined
 * protect), and an unknown path under L0 is never deletable by the forget path.
 */
export function isProtectedPath({ memoryRoot, relPath }) {
  const rel = normRel(relPath);
  if (rel === '') return true;
  const layer = retentionLayerOf(rel);
  if (layer === 'L0') return true;
  if (rel.startsWith(FRAMES_DIR) || rel.endsWith('.hmac') || rel.endsWith('.lock')) return true;
  const manifest = readProtectionManifest(memoryRoot);
  const hit = manifest.entries.find((entry) => entry.id === rel);
  if (hit) return hit.l2GatePass !== true;
  // C1 fail-safe: absent manifest or protected-by-default means refuse.
  return manifest.defaultProtected === true;
}

/** Throws E_PROTECTED when deletion would violate the retention/protection layering. */
export function assertDeletable({ memoryRoot, relPath }) {
  if (!isProtectedPath({ memoryRoot, relPath })) return { ok: true, layer: retentionLayerOf(relPath) };
  const error = new Error(`保留分层/保护名单拒绝删除：${normRel(relPath)}（A6）`);
  error.code = 'E_PROTECTED';
  error.status = 403;
  throw error;
}

/** Executed deletions always leave an audit row (action=archive) in audit/records.jsonl. */
export function auditRetentionRows({ memoryRoot, moved = [], auditKey = null, questionId = 'unknown' } = {}) {
  const rows = [];
  for (const item of Array.isArray(moved) ? moved : []) {
    rows.push({
      schema: 'retention/v1',
      action: 'archive',
      recordId: item.path ?? item.id ?? null,
      layer: retentionLayerOf(item.path ?? ''),
      archived: item.archived ?? item.destRel ?? null,
      backup: item.backupRel ?? item.backup ?? null,
      sha256: item.sha256 ?? null,
      auditKeyPresent: typeof auditKey === 'string' && auditKey !== '',
      questionId,
      at: typeof item.at === 'string' ? item.at : null,
    });
  }
  return rows;
}
