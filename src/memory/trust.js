// src/memory/trust.js — 1.8.0 / v2.8 §15.1-A3：trustScore（规则写死，时间可注入）
//
// 公式（写死）：
//   w_tier = { user: 1.0, host: 0.9, agent: 0.6, plugin: 0.4 }
//   trustScore = clamp(0, 1, w_tier * (1 + 0.1 * min(verifyCount, 5)) * decay)
//   decay = 0.5 ^ (ageDays / 30)          （ageDays 由注入的 now/createdAt 计算，不用真实等待）
//
// 时间注入 API（GOV-04：禁止 sleep 造假）：
//   - computeTrustScore({ sourceTier, verifyCount, ageDays })
//   - trustScoreAt({ sourceTier, verifyCount, createdAt, now })
//   - createGovTrustClock({ now })  → { at(createdAt), score(claim) }  测试显式传 now
// 低信任阈值 < 0.35 的 claim 只能进候选区、不得作为结论注入。
// legacy 迁移记录不做时间衰减（legacy:true → ageDays=0），避免把旧卡误判为低信任。

export const TRUST_TIERS = Object.freeze(['user', 'host', 'agent', 'plugin']);
export const TIER_WEIGHTS = Object.freeze({ user: 1.0, host: 0.9, agent: 0.6, plugin: 0.4 });
export const VERIFY_COUNT_CAP = 5;
export const LOW_TRUST_THRESHOLD = 0.35;
export const TRUST_SCHEMA = 'trust/v1';

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function toDateMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Pure formula (no clock): used directly by tests and by trustScoreAt. */
export function computeTrustScore({ sourceTier = 'agent', verifyCount = 0, ageDays = 0 } = {}) {
  const tier = TRUST_TIERS.includes(sourceTier) ? sourceTier : 'agent';
  const weight = TIER_WEIGHTS[tier];
  const verified = Math.max(0, Math.min(VERIFY_COUNT_CAP, Number.isInteger(verifyCount) ? verifyCount : 0));
  const days = Number.isFinite(ageDays) && ageDays > 0 ? ageDays : 0;
  const decay = Math.pow(0.5, days / 30);
  const score = weight * (1 + 0.1 * verified) * decay;
  return {
    schema: TRUST_SCHEMA,
    sourceTier: tier,
    verifyCount: verified,
    ageDays: days,
    decay,
    trustScore: clamp01(score),
  };
}

/** Time-injected score: age is computed from createdAt → now (both injectable). */
export function trustScoreAt({ sourceTier = 'agent', verifyCount = 0, createdAt = null, now = new Date(), legacy = false } = {}) {
  const nowMs = toDateMs(now) ?? Date.now();
  const createdMs = toDateMs(createdAt);
  // A backwards clock must not inflate trust: negative age clamps to 0 (CLOCK_ROLLBACK-safe).
  const rawAgeDays = createdMs === null ? 0 : (nowMs - createdMs) / (24 * 60 * 60 * 1000);
  const ageDays = legacy === true ? 0 : (Number.isFinite(rawAgeDays) && rawAgeDays > 0 ? rawAgeDays : 0);
  return computeTrustScore({ sourceTier, verifyCount, ageDays });
}

/** Time-injection seam for GOV-04 probes/tests (no sleep, no wall-clock dependency). */
export function createGovTrustClock({ now } = {}) {
  const clockNow = () => (typeof now === 'function' ? now() : now ?? new Date());
  return {
    at: (createdAt) => trustScoreAt({ sourceTier: 'host', verifyCount: 0, createdAt, now: clockNow() }),
    score: ({ sourceTier, verifyCount = 0, createdAt = null, legacy = false } = {}) => trustScoreAt({ sourceTier, verifyCount, createdAt, now: clockNow(), legacy }),
    now: clockNow,
  };
}

export function isLowTrust(trustScore) {
  return !(typeof trustScore === 'number' && trustScore >= LOW_TRUST_THRESHOLD);
}

/** 低信任不进结论注入；候选区仍可见（标 unverified）。 */
export function injectionEligibility(claim = {}) {
  const score = typeof claim.trustScore === 'number' ? claim.trustScore : 0;
  return {
    eligible: !isLowTrust(score),
    unverified: isLowTrust(score),
    trustScore: score,
  };
}
