// src/autoprocedure/index.js — 模块公共入口（供 src/index.js 与测试使用）。
//
// 默认关闭：`enabled:false` 时 registerAutoProcedure 立即返回，不注册 hook、
// 不建目录、不读盘（除宿主已加载配置与本模块自身的纯函数状态）。

export {
  AUTOPROCEDURE_CONFIG_SCHEMA,
  AUTOPROCEDURE_DEFAULTS,
  AUTOPROCEDURE_MAX_DECOMPRESSED_BYTES,
  AUTOPROCEDURE_MAX_DECOMPRESSED_BYTES_MIN,
  AUTOPROCEDURE_MAX_DECOMPRESSED_BYTES_HARD_CAP,
  AUTOPROCEDURE_LOCK_TTL_MS,
  AUTOPROCEDURE_LOCK_RETRIES,
  AUTOPROCEDURE_LOCK_RETRY_DELAY_MS,
  AUTOPROCEDURE_STALLED_DAYS,
  AUTOPROCEDURE_REPEAT_REJECT_DAYS,
  normalizeAutoProcedureConfig,
} from './config.js';

export { autoProcedurePaths } from './paths.js';

export {
  readSessionFile,
  parseSessionBuffer,
  findTurnSample,
  decompressSessionCapped,
  indexSessionLines,
  AutoProcedureSampleError,
  SAMPLE_CODES,
} from './session-reader.js';

export {
  registerAutoProcedure,
  createAutoProcedureRuntime,
  spotCheckCandidates,
} from './runtime.js';

export {
  appendLedgerRow,
  evaluateStalled,
  llmUsageToday,
  draftsToday,
  makeLedgerRow,
  readAutoProcedureState,
  readLedgerRows,
  summarizeLedger,
  LEDGER_KINDS,
  REJECT_REASONS,
  TERMINAL_KINDS,
} from './ledger.js';

export {
  buildSidecar,
  applyRetention,
  composeCandidateMarkdown,
  composeSectionsText,
  listStagedCandidates,
  writeCandidate,
  CANDIDATE_SCHEMA,
} from './candidate.js';

export {
  makeD2Evidence,
  makeSessionEvidence,
  sessionToolResultText,
  validateEvidenceItem,
  verifyEvidence,
  verifyEvidenceSet,
  verifyTurnDigest,
  OFFSET_SPACES,
} from './evidence.js';

export { buildRuleDraft, triggerCandidates } from './rules.js';
export { runLocalLint, LINT_RULES, diceSimilarity } from './lint.js';
export { normalizePathsInText, sanitizeFragment } from './privacy.js';
export { acquireWithRetry, autoProcedureHolder, makeRunId } from './locks.js';
export {
  buildLlmPrompt,
  callLlmOnce,
  estimateTokens,
  parseLlmCandidateOutput,
  reserveLlmBudget,
} from './llm.js';
