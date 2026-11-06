// routerFace v1 · 公开入口（无副作用：导入不建目录、不读文件、不调模型）。

export {
  FACE_CONFIG_VERSION,
  FACE_CONFIG_KEYS,
  FACE_DEFAULTS,
  FACE_INT_SPECS,
  FACE_HARD_CONTEXT_FLOOR,
  FACE_JOURNAL_CONTEXT_ROWS,
  FACE_TODO_LIMIT,
  FACE_MAX_JOURNAL_CHARS,
  FACE_MAX_SUGGESTION_CHARS,
  FACE_MAX_HINT_CHARS,
  FACE_MAX_OUTPUT_TOKENS,
  FACE_MAX_CONSECUTIVE_FAILURES,
  FACE_FIRST_TICK_MS,
  FACE_TICK_TASK,
  FACE_SESSION_HINT,
  normalizeFaceConfig,
} from './config.mjs';

export {
  DEFAULT_IDENTITY,
  IDENTITY_FILE_NAME,
  IDENTITY_MAX_CHARS,
  IDENTITY_LINE_MAX_CHARS,
  parseIdentity,
  readIdentity,
  renderIdentityLine,
} from './identity.mjs';

export {
  BRIDGE_DIR_NAME,
  FACE_DIR_NAME,
  FACE_JOURNAL_FILE_NAME,
  FACE_LOCK_FILE_NAME,
  FACE_STATE_FILE_NAME,
  FACE_STATUS_FILE_NAME,
  OUTBOX_FILE_NAME,
  facePaths,
} from './paths.mjs';

export { JOURNAL_VERSION, JOURNAL_MAX_ROWS, appendJournalOnce, hasJournalTick, readJournal } from './journal.mjs';

export {
  OUTBOX_VERSION,
  OUTBOX_MAX_ROWS,
  BRIDGE_TEXT_MAX_CHARS,
  appendOutbox,
  markRead,
  readLatestUnread,
  readOutbox,
  renderBridgeHint,
} from './outbox.mjs';

export { buildFaceContext, excerptSections, summarizeContext } from './context.mjs';

export {
  FACE_SYSTEM_PROMPT,
  buildFacePrompt,
  callFaceModel,
  parseFaceOutput,
} from './llm.mjs';

export { FACE_STATE_VERSION, FACE_STATUS_VERSION, createRouterFace } from './face.mjs';
