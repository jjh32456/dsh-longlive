// src/answer/evidence.js — 证据注入面（1.8.0 answer-guard 合并）。
//
// 单一实现位于 guard.js（移植自 answer-guard src/answer/core.mjs）；
// 本文件只做语义分组导出，方便 feature wiring 与面板/评测按面引用。
export {
  EVIDENCE_MARK,
  NO_EVIDENCE_MARK,
  RULE_MARK,
  RULE_TEXT,
  ANSWER_GUARD_VERSION,
  extractKeywords,
  turnText,
  scoreTurn,
  retrieveEvidence,
  renderEvidencePacket,
  renderNoEvidence,
  renderRuleBlock,
  numberCorpus,
  isGroundedNumber,
  decideAnswerMode,
  // FIX-05：answerMode / evidenceUnits / sourceGate / tier 纯函数（确定性、无模型调用）。
  ANSWER_MODE_VALUES,
  SOURCE_GATE_HARD_CODES,
  normalizeEvidenceUnits,
  collectHardFlagCodes,
  buildSourceGate,
  hasReadableSubstantiveAnswer,
  deriveAnswerMode,
  deriveAnswerModeFields,
} from './guard.js';
