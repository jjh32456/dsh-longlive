// routerFace v1 · 所有落盘位置。
//
// 固定布局（<root> = memoryRoot）：
//   <root>/IDENTITY.md                     前后台共用身份（只读）
//   <root>/STATE.md                        状态卡（只读）
//   <root>/flow/current.md                 心流快照（只读）
//   <root>/.longlive/router/board.json     共享板（只读；主路径）
//   <root>/.longlive/board.json            共享板（只读；兼容回退）
//   <root>/.longlive/live/*.json           会话心跳/队列（只读）
//   <root>/.longlive/face/journal.jsonl    后台面自己的 journal（写）
//   <root>/.longlive/face/state.json       预算/失败/刹车状态（写）
//   <root>/.longlive/face/status.json      对外的状态快照（写）
//   <root>/.longlive/face/face.lock        tick 单飞锁（写，短命）
//   <root>/.longlive/bridge/router-outbox.jsonl  跨会话通道（写）

import path from 'node:path';

export const FACE_DIR_NAME = 'face';
export const BRIDGE_DIR_NAME = 'bridge';
export const OUTBOX_FILE_NAME = 'router-outbox.jsonl';
export const FACE_JOURNAL_FILE_NAME = 'journal.jsonl';
export const FACE_STATE_FILE_NAME = 'state.json';
export const FACE_STATUS_FILE_NAME = 'status.json';
export const FACE_LOCK_FILE_NAME = 'face.lock';

/**
 * @param {string} memoryRoot
 * @returns {object|null} null when memoryRoot is not a usable path
 */
export function facePaths(memoryRoot) {
  if (typeof memoryRoot !== 'string' || memoryRoot.trim() === '') return null;
  const root = path.resolve(memoryRoot);
  const longlive = path.join(root, '.longlive');
  const dir = path.join(longlive, FACE_DIR_NAME);
  const bridgeDir = path.join(longlive, BRIDGE_DIR_NAME);
  return {
    root,
    dir,
    journalFile: path.join(dir, FACE_JOURNAL_FILE_NAME),
    stateFile: path.join(dir, FACE_STATE_FILE_NAME),
    statusFile: path.join(dir, FACE_STATUS_FILE_NAME),
    lockFile: path.join(dir, FACE_LOCK_FILE_NAME),
    identityFile: path.join(root, 'IDENTITY.md'),
    stateMdFile: path.join(root, 'STATE.md'),
    flowFile: path.join(root, 'flow', 'current.md'),
    liveDir: path.join(longlive, 'live'),
    bridgeDir,
    outboxFile: path.join(bridgeDir, OUTBOX_FILE_NAME),
    boardFile: path.join(longlive, 'router', 'board.json'),
    boardFallbackFile: path.join(longlive, 'board.json'),
    routerQueueFile: path.join(longlive, 'router', 'queue.jsonl'),
    memoryJournalDir: path.join(root, 'journal'),
  };
}
