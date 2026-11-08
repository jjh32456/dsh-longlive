#!/usr/bin/env node
// scripts/recall-index-build.mjs — M2-A：从 L0 会话日志重建/增量构建事件索引
//
//   node scripts/recall-index-build.mjs [--memory-root <dir>] [--sessions-root <dir>]
//        [--rebuild] [--limit-sessions N] [--search "<query>"] [--json]
//
// 只读 L0（`<sessions-root>/.../session.v4.jsonl.zstd`），所有写都落在
// `<memory-root>/.longlive/index/`（events.db / events.audit.jsonl / frames/ / build-state.json）。
// 默认 memory-root = $DSH_LONGLIVE_MEMORY_ROOT / $DSH_MEM / <DSH_HOME>/longlive-memory；
// 默认 sessions-root = <DSH_HOME>/sessions。`--rebuild` 先删派生索引（验证删库重建）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildIndexFromSessions,
  createEventsIndexReader,
  deleteIndex,
  indexPaths,
  openEventIndex,
} from '../src/memory/event-index.js';

function parseArgs(argv) {
  const out = {
    memoryRoot: '',
    sessionsRoot: '',
    rebuild: false,
    limitSessions: Number.POSITIVE_INFINITY,
    search: '',
    json: false,
    now: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match) continue;
    const [, key, inline] = match;
    const value = inline !== undefined ? inline : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '');
    if (key === 'memory-root') out.memoryRoot = value;
    else if (key === 'sessions-root') out.sessionsRoot = value;
    else if (key === 'rebuild') out.rebuild = true;
    else if (key === 'limit-sessions') out.limitSessions = Number.parseInt(value, 10);
    else if (key === 'search') out.search = value;
    else if (key === 'json') out.json = true;
  }
  return out;
}

function dshHome() {
  const raw = process.env.DSH_HOME;
  if (typeof raw === 'string' && raw.trim() !== '') return path.resolve(raw.trim());
  return path.join(os.homedir(), '.dsh');
}

function defaultMemoryRoot() {
  for (const envName of ['DSH_LONGLIVE_MEMORY_ROOT', 'DSH_MEM']) {
    const value = process.env[envName];
    if (typeof value === 'string' && value.trim() !== '') return path.resolve(value.trim());
  }
  return path.join(dshHome(), 'longlive-memory');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const memoryRoot = path.resolve(args.memoryRoot !== '' ? args.memoryRoot : defaultMemoryRoot());
  const sessionsRoot = path.resolve(args.sessionsRoot !== '' ? args.sessionsRoot : path.join(dshHome(), 'sessions'));
  if (!fs.existsSync(sessionsRoot)) {
    console.error(`[recall-index-build] sessions root not found: ${sessionsRoot}`);
    process.exitCode = 2;
    return;
  }
  const receipt = {
    schema: 'recall-index-build/v1',
    memoryRoot,
    sessionsRoot,
    rebuild: args.rebuild,
    index: indexPaths(memoryRoot),
  };
  const started = Date.now();
  if (args.rebuild) receipt.deleted = deleteIndex(memoryRoot);
  const result = buildIndexFromSessions({
    memoryRoot,
    sessionRoots: [sessionsRoot],
    rebuild: false,
    limitSessions: Number.isFinite(args.limitSessions) ? args.limitSessions : undefined,
    source: 'cli',
  });
  receipt.build = {
    sessionsScanned: result.sessionsScanned,
    sessionsBuilt: result.sessionsBuilt,
    duplicateSessions: result.duplicateSessions,
    turns: result.turns,
    inserted: result.inserted,
    skipped: result.skipped,
    errors: result.errors,
    durationMs: result.durationMs,
    dbBytes: result.dbBytes,
  };
  if (args.search !== '') {
    const index = openEventIndex({ memoryRoot });
    try {
      receipt.search = index.search(args.search, { limit: 5 });
    } finally {
      index.close();
    }
  }
  const reader = createEventsIndexReader({ memoryRoot });
  receipt.readerAvailable = typeof reader === 'function';
  receipt.elapsedMs = Date.now() - started;
  const text = JSON.stringify(receipt, null, 2);
  if (args.json) console.log(text);
  else {
    console.log(`[recall-index-build] memoryRoot=${memoryRoot}`);
    console.log(`[recall-index-build] sessions=${receipt.build.sessionsBuilt}/${receipt.build.sessionsScanned} turns=${receipt.build.turns} inserted=${receipt.build.inserted} skipped=${receipt.build.skipped} errors=${receipt.build.errors} duplicates=${receipt.build.duplicateSessions}`);
    console.log(`[recall-index-build] db=${receipt.index.db} dbBytes=${receipt.build.dbBytes} reader=${receipt.readerAvailable} elapsedMs=${receipt.elapsedMs}`);
    if (receipt.search) {
      console.log(`[recall-index-build] search strategy=${receipt.search.strategy ?? 'none'} rows=${receipt.search.rows.length} code=${receipt.search.code ?? 'OK'}`);
    }
  }
}

try {
  main();
} catch (error) {
  console.error(`[recall-index-build] FAILED: ${error?.stack ?? error}`);
  process.exitCode = 1;
}
