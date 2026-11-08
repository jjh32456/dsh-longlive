// index.mjs — public surface for the background router core.
//
// This module is intentionally side-effect free: importing it must not read or
// write the filesystem, start a router, or print anything. The runnable demo
// that used to live here was moved out of the shipped package; use the modules
// below directly (see test/router-background for usage examples).

export {
  Router,
  FORBIDDEN_ACTIONS,
  DEFAULT_ALLOWED_ACTIONS,
  isRecursiveTask,
  parseAction,
  foldAuditUsage,
} from './router.mjs';

export {
  BudgetLedger,
  LEDGER_VERSION,
  readLedger,
  foldRecords,
  verifyLedgerChain,
} from './budget-ledger.mjs';

export {
  AuditLog,
  AUDIT_VERSION,
  readAudit,
  verifyAuditChain,
  crc32,
} from './audit.mjs';

export {
  AnchorLog,
  ANCHOR_VERSION,
  verifyAnchor,
  readAnchor,
} from './anchor.mjs';

export {
  createHost,
  ToolService,
  AgentService,
  HostSimError,
} from './host-sim.mjs';

export { MemoryReader, memoryToSystemPrompt } from './memory.mjs';

export { MockLlm, MockLlmError, assertBlockMessages } from './mock-llm.mjs';

export { TaskQueue, validateTask, DEFAULT_MAX_TASKS } from './queue.mjs';

export {
  retryOnFailure,
  computeBackoff,
  classifyCode,
  stopReasonFor,
  capRetryAfter,
  sleep,
  addUsage,
  accumulateUsage,
} from './retry.mjs';

export { consumeStream, buildMessages, normalizeUsage } from './stream.mjs';

export {
  installToolPolicy,
  guardReason,
  denyReason,
  resolveRestrictableView,
  validateDenyNames,
  READ_ONLY_TOOL_ALLOWLIST,
  REGISTERED_TOOL_NAMES,
} from './tool-policy.mjs';

export {
  runAgentTask,
  createUserMessage,
  lastAssistantText,
  AGENT_RUNNER_ERRORS,
} from './agent-runner.mjs';
