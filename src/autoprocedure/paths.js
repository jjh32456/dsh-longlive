// src/autoprocedure/paths.js — 全部落点路径集中在这里，禁止在业务代码里手拼。
//
// 候选只写 `.longlive/staging/auto-cards/procedures/`（A1 staging 同族子目录）；
// 账本写 `.longlive/logs/auto-procedure.jsonl`（append-store）；
// 状态写既有的 `.longlive/memory-state.json` 的 autoProcedure 字段；
// 自动流程的两把锁：staging 锁（写 staging 时持有）与 drain 第二 key
// （同一时刻只允许一个 drain）。`procedures/` 锁只约束写 procedures/ 的一方，
// 自动流程从不写 procedures/，因此不取它。

import path from 'node:path';

export const AUTOPROCEDURE_DIRNAME = 'auto-cards';
export const AUTOPROCEDURE_STAGING_SUBDIR = path.join('.longlive', 'staging', AUTOPROCEDURE_DIRNAME, 'procedures');
export const AUTOPROCEDURE_LEDGER_REL = path.join('.longlive', 'logs', 'auto-procedure.jsonl');
export const AUTOPROCEDURE_STATE_REL = path.join('.longlive', 'memory-state.json');
export const AUTOPROCEDURE_TOOL_OUTPUT_REL = path.join('.longlive', 'tool-output');

/** Where everything for one memory root lives. Pure path math, no IO. */
export function autoProcedurePaths(memoryRoot) {
  const root = path.resolve(String(memoryRoot ?? ''));
  const staging = path.join(root, AUTOPROCEDURE_STAGING_SUBDIR);
  return {
    root,
    staging,
    stagingArchive: path.join(staging, 'archive'),
    stagingLock: path.join(staging, '.autoprocedure.lock'),
    drainLock: path.join(staging, '.autoprocedure.drain.lock'),
    proceduresDir: path.join(root, 'procedures'),
    proceduresLock: path.join(root, 'procedures', '.procedures.lock'),
    ledger: path.join(root, AUTOPROCEDURE_LEDGER_REL),
    state: path.join(root, AUTOPROCEDURE_STATE_REL),
    toolOutput: path.join(root, AUTOPROCEDURE_TOOL_OUTPUT_REL),
  };
}

/** Repo-relative path with forward slashes (sidecar 用；绝不写绝对路径)。 */
export function relativeLedgerPath(rel) {
  return String(rel).split(path.sep).join('/');
}
