// src/role/personality.js — 角色内核 · personality projection（v2.8 §16.3 ④）
//
// 设计口径（§16.3）：
//   - `.longlive/role/personality.json` 快照
//     `{snapshotId, version, retentionBias{kind:weight}, tone, createdAt}`；
//   - 接口：`retentionBias → 遗忘阈值`（只影响衰减偏好，**不越权 protected/forbid**）；
//   - 1.8.0 只做快照生成与只读，不改写遗忘算法本体（所以这里只导出一个
//     `applyRetentionBiasToRules()` 纯函数，forget.js 是否采用由调用方决定）。
//
// 快照来源（本地规则，不调模型）：
//   - 文件源：`role.personality.profilePaths`（默认 ['profile.md','AGENTS.md']，必须在
//     memoryRoot 内；越界/缺失只记录 skipped，不崩）；
//   - 文本源：调用方直接用 `sources:[{kind:'text',name,text}]` 传入（例如宿主 profile 文案）；
//   - 偏好源：`preferences` 参数（键值对）可显式提高某类记忆的 retentionBias。
// 每个源都进 versions 审计（name/sha256/chars），快照版本单调递增。

import path from 'node:path';

import {
  RoleError, ROLE_CODES, appendJsonl, ensureRoleDir, iso, nowMs, readInsideRoot, readJsonSafe, readJsonlSafe, rolePaths, tryRolePaths, sha256Hex, writeJsonAtomic,
} from './store.js';

export const PERSONALITY_SCHEMA = 'personality/v1';
export const RETENTION_KINDS = Object.freeze(['fact', 'preference', 'decision', 'episode', 'skill']);
export const PERSONALITY_TONES = Object.freeze(['neutral', 'warm', 'honest-direct', 'concise']);
export const PERSONALITY_DEFAULTS = Object.freeze({
  tone: 'neutral',
  retentionBias: Object.freeze({ fact: 1.0, preference: 1.0, decision: 1.0, episode: 1.0, skill: 1.0 }),
  profilePaths: Object.freeze(['profile.md', 'AGENTS.md']),
  biasMin: 0.8,
  biasMax: 1.5,
  biasPerHit: 0.1,
});
export const PERSONALITY_CODES = Object.freeze({
  PARAMS: ROLE_CODES.PARAMS,
  CORRUPT: ROLE_CODES.CORRUPT,
  PROFILE_OUTSIDE: ROLE_CODES.PATH_OUTSIDE_ROOT,
});

/** tone 本地规则（命中次数最多的 tone 胜出；同分按 TONE_RULES 顺序）。 */
export const TONE_RULES = Object.freeze([
  { tone: 'warm', keywords: ['人情味', '话可以长', '陪我', '聊天', '情绪', '不用端着', '伙伴'] },
  { tone: 'honest-direct', keywords: ['不哄', '不许骗', '不骗', '直接', '说人话', '不端着'] },
  { tone: 'concise', keywords: ['短一点', '精简', '别啰嗦', '一句话'] },
]);

/** retentionBias 关键词规则：命中次数越多，该类记忆的衰减阈值保留得越久。 */
export const RETENTION_RULES = Object.freeze({
  fact: ['事实', '数据', '来源', '出处', '证据'],
  preference: ['偏好', '喜欢', '不喜欢', '习惯', '口味'],
  decision: ['决定', '决策', '拍板', '规则', '铁律', '定下'],
  episode: ['经历', '日记', 'journal', '发生过', '那晚', '当时'],
  skill: ['方法', '流程', '步骤', 'skill', '技法', '怎么做'],
});

function clampBias(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1.0;
  return Math.min(PERSONALITY_DEFAULTS.biasMax, Math.max(PERSONALITY_DEFAULTS.biasMin, Math.round(number * 100) / 100));
}

function emptySnapshot() {
  return {
    snapshotId: null,
    version: 0,
    retentionBias: { ...PERSONALITY_DEFAULTS.retentionBias },
    tone: PERSONALITY_DEFAULTS.tone,
    createdAt: null,
    sources: [],
  };
}

function normalizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const bias = {};
  const rawBias = raw.retentionBias && typeof raw.retentionBias === 'object' ? raw.retentionBias : {};
  for (const kind of RETENTION_KINDS) bias[kind] = clampBias(rawBias[kind] ?? 1.0);
  return {
    snapshotId: typeof raw.snapshotId === 'string' ? raw.snapshotId : null,
    version: Number.isInteger(raw.version) && raw.version >= 0 ? raw.version : 0,
    retentionBias: bias,
    tone: PERSONALITY_TONES.includes(raw.tone) ? raw.tone : PERSONALITY_DEFAULTS.tone,
    createdAt: typeof raw.createdAt === 'string' && Number.isFinite(Date.parse(raw.createdAt)) ? raw.createdAt : null,
    sources: Array.isArray(raw.sources)
      ? raw.sources.filter((item) => item && typeof item === 'object').map((item) => ({
        name: typeof item.name === 'string' ? item.name : 'source',
        kind: typeof item.kind === 'string' ? item.kind : 'file',
        sha256: typeof item.sha256 === 'string' ? item.sha256 : null,
        chars: Number.isInteger(item.chars) ? item.chars : null,
        skipped: item.skipped === true ? true : undefined,
        code: typeof item.code === 'string' ? item.code : undefined,
      }))
      : [],
  };
}

/** Read-only personality view (`personality/v1`); never throws. */
export function readPersonality({ memoryRoot, now = () => new Date(), caller = null, auditKey = null } = {}) {
  const paths = tryRolePaths(memoryRoot);
  if (paths === null) {
    return {
      schema: PERSONALITY_SCHEMA,
      present: false,
      degraded: true,
      snapshot: null,
      defaults: { ...emptySnapshot() },
      code: 'E_PERSONALITY_ABSENT',
      readAt: iso(nowMs(now())),
    };
  }
  const read = readJsonSafe(paths.personality, { memoryRoot, auditKey, caller });
  if (read.tampered === true || read.denied === true) {
    return {
      schema: PERSONALITY_SCHEMA,
      present: false,
      degraded: true,
      tampered: read.tampered === true,
      denied: read.denied === true,
      subject: read.subject ?? null,
      snapshot: null,
      defaults: { ...emptySnapshot() },
      code: read.code,
      message: read.message ?? null,
      readAt: iso(nowMs(now())),
    };
  }
  if (!read.ok || !read.value || typeof read.value !== 'object') {
    return {
      schema: PERSONALITY_SCHEMA,
      present: read.present === true,
      degraded: read.present === true,
      snapshot: null,
      defaults: { ...emptySnapshot() },
      code: read.present === true ? 'E_PERSONALITY_CORRUPT' : 'E_PERSONALITY_ABSENT',
      readAt: iso(nowMs(now())),
    };
  }
  const snapshot = normalizeSnapshot(read.value);
  if (snapshot === null) {
    return {
      schema: PERSONALITY_SCHEMA,
      present: true,
      degraded: true,
      snapshot: null,
      defaults: { ...emptySnapshot() },
      code: 'E_PERSONALITY_INVALID',
      readAt: iso(nowMs(now())),
    };
  }
  return {
    schema: PERSONALITY_SCHEMA,
    present: true,
    degraded: false,
    snapshot,
    defaults: { ...emptySnapshot() },
    code: 'OK',
    readAt: iso(nowMs(now())),
  };
}

/** Derive tone by keyword hits; unknown/empty text → neutral. */
export function extractTone(text) {
  const haystack = String(text ?? '').toLowerCase();
  if (haystack.trim() === '') return PERSONALITY_DEFAULTS.tone;
  let bestTone = PERSONALITY_DEFAULTS.tone;
  let bestHits = 0;
  for (const rule of TONE_RULES) {
    let hits = 0;
    for (const keyword of rule.keywords) if (haystack.includes(keyword.toLowerCase())) hits += 1;
    if (hits > bestHits) {
      bestTone = rule.tone;
      bestHits = hits;
    }
  }
  return bestTone;
}

/** Derive retentionBias: keyword hits raise the kind's weight (bounded). */
export function extractRetentionBias(texts) {
  const haystack = (Array.isArray(texts) ? texts : [texts]).map((item) => String(item ?? '')).join('\n').toLowerCase();
  const bias = {};
  for (const kind of RETENTION_KINDS) {
    const keywords = RETENTION_RULES[kind] ?? [];
    let hits = 0;
    for (const keyword of keywords) if (haystack.includes(keyword.toLowerCase())) hits += 1;
    bias[kind] = hits === 0 ? 1.0 : clampBias(1.0 + hits * PERSONALITY_DEFAULTS.biasPerHit);
  }
  return bias;
}

function nextAuditSeq(paths, options = {}) {
  const read = readJsonlSafe(paths.audit, { limit: 10_000, memoryRoot: options.memoryRoot, auditKey: options.auditKey ?? null });
  let max = 0;
  for (let index = read.rows.length - 1; index >= 0; index -= 1) {
    const seq = read.rows[index]?.seq;
    if (Number.isInteger(seq) && seq > max) max = seq;
  }
  return max + 1;
}

function collectSources({ memoryRoot, sources = [], profilePaths = PERSONALITY_DEFAULTS.profilePaths } = {}) {
  const collected = [];
  const skipped = [];
  const pushText = (name, kind, text) => {
    const normalized = typeof text === 'string' ? text : '';
    collected.push({
      name,
      kind,
      text: normalized,
      sha256: sha256Hex(normalized),
      chars: Array.from(normalized).length,
    });
  };
  for (const raw of Array.isArray(sources) ? sources : []) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.kind === 'text' || typeof raw.text === 'string') {
      pushText(typeof raw.name === 'string' ? raw.name : 'inline', 'text', raw.text);
      continue;
    }
    if (typeof raw.path === 'string') {
      const read = readInsideRoot(memoryRoot, raw.path);
      if (read.ok) pushText(typeof raw.name === 'string' ? raw.name : raw.path, 'file', read.text);
      else skipped.push({ name: raw.name ?? raw.path, kind: 'file', skipped: true, code: read.code });
    }
  }
  for (const rel of Array.isArray(profilePaths) ? profilePaths : []) {
    if (typeof rel !== 'string' || rel.trim() === '') continue;
    const read = readInsideRoot(memoryRoot, pathJoinSafe(memoryRoot, rel));
    if (read.ok) pushText(rel, 'file', read.text);
    else if (read.code !== 'ENOENT') skipped.push({ name: rel, kind: 'file', skipped: true, code: read.code });
  }
  return { collected, skipped };
}

function pathJoinSafe(memoryRoot, rel) {
  // `readInsideRoot` re-checks containment; joining here only keeps absolute
  // role file inputs out of the profile-path list.
  if (path.isAbsolute(rel)) return rel;
  return path.join(String(memoryRoot ?? ''), rel);
}

/**
 * Generate the next personality snapshot from local sources (no LLM).
 * Version is monotonic; every source is audited (name/sha256/chars).
 */
export function generatePersonalitySnapshot({
  memoryRoot,
  sources = [],
  profilePaths = PERSONALITY_DEFAULTS.profilePaths,
  preferences = undefined,
  now = () => new Date(),
  auditKey = null,
  actorKind = 'host',
  subject = undefined,
  userId = undefined,
  projectId = undefined,
  readers = undefined,
} = {}) {
  const paths = rolePaths(memoryRoot);
  const current = readPersonality({ memoryRoot, auditKey }).snapshot ?? emptySnapshot();
  const { collected, skipped } = collectSources({ memoryRoot, sources, profilePaths });
  const joined = collected.map((item) => item.text).join('\n');
  const retentionBias = extractRetentionBias([joined, preferences ? JSON.stringify(preferences) : '']);
  if (preferences && typeof preferences === 'object' && !Array.isArray(preferences)) {
    for (const kind of RETENTION_KINDS) {
      if (preferences[kind] !== undefined) retentionBias[kind] = clampBias(preferences[kind]);
    }
  }
  const tone = extractTone(joined);
  const createdAt = iso(nowMs(now()));
  const version = (current.version ?? 0) + 1;
  const sourceAudit = [
    ...collected.map((item) => ({ name: item.name, kind: item.kind, sha256: item.sha256, chars: item.chars })),
    ...skipped,
  ];
  const snapshotId = `psn_${sha256Hex(JSON.stringify({
    version,
    createdAt,
    tone,
    retentionBias,
    sources: sourceAudit.map((item) => item.sha256 ?? item.code ?? item.name),
  })).slice(0, 12)}`;
  const snapshot = { snapshotId, version, retentionBias, tone, createdAt, sources: sourceAudit };
  ensureRoleDir(memoryRoot);
  const nextSubject = (subject !== undefined || userId !== undefined || projectId !== undefined || readers !== undefined)
    ? {
      sessionId: subject?.sessionId ?? null,
      userId: subject?.userId ?? userId ?? null,
      projectId: subject?.projectId ?? projectId ?? null,
      readers: [
        ...(Array.isArray(subject?.readers) ? subject.readers : []),
        ...(Array.isArray(readers) ? readers : []),
      ],
    }
    : undefined;
  writeJsonAtomic(paths.personality, { v: 1, ...snapshot }, { memoryRoot, auditKey, actorKind, subject: nextSubject });
  const audit = {
    seq: nextAuditSeq(paths, { memoryRoot, auditKey }),
    at: createdAt,
    action: 'personality.snapshot',
    actor: 'host',
    reason: `snapshot v${version} 生成（tone=${tone}，sources=${collected.length}，skipped=${skipped.length}）`,
    before: { version: current.version ?? 0, tone: current.tone },
    after: { version, tone, retentionBias },
    undo: { previous: current.version ? { ...current } : null },
    source: 'role.personality',
  };
  appendJsonl(paths.audit, audit, { memoryRoot, auditKey, actorKind });
  return {
    ok: true,
    schema: PERSONALITY_SCHEMA,
    snapshot,
    sources: sourceAudit,
    skipped,
    auditSeq: audit.seq,
  };
}

/** 三接口 #3（读侧）：retentionBias weight for one memory kind (default 1.0). */
export function retentionBiasFor(kind, { snapshot = null } = {}) {
  const key = String(kind ?? '');
  const bias = snapshot?.retentionBias ?? PERSONALITY_DEFAULTS.retentionBias;
  const value = bias[key];
  return typeof value === 'number' && Number.isFinite(value) ? clampBias(value) : 1.0;
}

/**
 * 三接口 #3（纯阈值调整器）：只调整衰减阈值，不动 immune/protected 判定。
 * base rules 形状 `{epochsMinAgeDays, tombstoneMinAgeDays, immuneSalience?}`；
 * 返回每个 kind 的调整后阈值 + 原样保留的 immuneSalience。
 */
export function applyRetentionBiasToRules(rules = {}, { snapshot = null } = {}) {
  const base = {
    epochsMinAgeDays: Number.isFinite(Number(rules.epochsMinAgeDays)) ? Math.max(1, Math.round(Number(rules.epochsMinAgeDays))) : 90,
    tombstoneMinAgeDays: Number.isFinite(Number(rules.tombstoneMinAgeDays)) ? Math.max(1, Math.round(Number(rules.tombstoneMinAgeDays))) : 365,
    immuneSalience: Number.isInteger(rules.immuneSalience) ? rules.immuneSalience : 5,
  };
  const perKind = {};
  for (const kind of RETENTION_KINDS) {
    const bias = retentionBiasFor(kind, { snapshot });
    perKind[kind] = {
      kind,
      retentionBias: bias,
      epochsMinAgeDays: Math.max(1, Math.round(base.epochsMinAgeDays * bias)),
      tombstoneMinAgeDays: Math.max(1, Math.round(base.tombstoneMinAgeDays * bias)),
    };
  }
  return {
    schema: 'retention-bias/v1',
    base,
    perKind,
    // 硬边界：protected/forbid/immune 不参与 bias（不越权）。
    immuneSalience: base.immuneSalience,
    protectedUnaffected: true,
  };
}

/** 语气投影：给 systemPrompt.section 用的一行风格指引（neutral 不注入）。 */
export function toneProjection({ snapshot = null } = {}) {
  const tone = snapshot?.tone ?? PERSONALITY_DEFAULTS.tone;
  if (tone === 'neutral') return { tone, styleLine: '', inject: false };
  const lines = {
    warm: '语气：可以长一点、带人情味，不用端着；别用假话哄人。',
    'honest-direct': '语气：直接说真话，不哄不编；不确定就明说没查。',
    concise: '语气：短、具体、先给结论，再给一两行依据。',
  };
  return { tone, styleLine: lines[tone] ?? '', inject: (lines[tone] ?? '') !== '' };
}

export { RoleError, ROLE_CODES };
