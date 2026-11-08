#!/usr/bin/env node
// scripts/backfill-auto-cards.mjs — 1.8.0 one-shot AutoCard backfill.
//
//   node scripts/backfill-auto-cards.mjs [--memory-root <dir>] [--dry-run] [--json]
//
// Reads every EventRecord already in `.longlive/index/events.db` and appends one
// AutoCard per event to `.longlive/index/cards.jsonl` (idempotent by eventId).
// --dry-run only counts what would be written; it never touches cards.jsonl.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openEventIndex } from '../src/memory/event-index.js';
import { appendAutoCards, cardsPathOf } from '../src/memory/auto-cards.js';

export function defaultMemoryRoot() {
  for (const envName of ['DSH_LONGLIVE_MEMORY_ROOT', 'DSH_MEM']) {
    const value = process.env[envName];
    if (typeof value === 'string' && value.trim() !== '') return path.resolve(value.trim());
  }
  const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? path.resolve(process.env.DSH_HOME.trim())
    : path.join(os.homedir(), '.dsh');
  return path.join(dshHome, 'longlive-memory');
}

function parseArgs(argv) {
  const out = { memoryRoot: '', dryRun: false, json: false, pageSize: 500, resign: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match) continue;
    const [, key, inline] = match;
    const value = inline !== undefined ? inline : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '');
    if (key === 'memory-root') out.memoryRoot = value;
    else if (key === 'dry-run') out.dryRun = true;
    else if (key === 'json') out.json = true;
    else if (key === 'resign') out.resign = true;
    else if (key === 'page-size') out.pageSize = Math.max(1, Math.min(500, Number.parseInt(value, 10) || 500));
  }
  return out;
}

export function backfillAutoCards({ memoryRoot, dryRun = false, pageSize = 500, resign = false } = {}) {
  const root = path.resolve(String(memoryRoot ?? ''));
  if (root === '') throw new Error('E_MEMORY_ROOT: backfill requires memoryRoot');
  const dbPath = path.join(root, '.longlive', 'index', 'events.db');
  if (!fs.existsSync(dbPath)) {
    return { ok: false, code: 'E_EVENTS_INDEX_NOT_BUILT', memoryRoot: root, dbPath, totalEvents: 0, written: 0, skipped: 0, dryRun };
  }
  const index = openEventIndex({ memoryRoot: root });
  let offset = 0;
  let totalEvents = 0;
  let written = 0;
  let skipped = 0;
  const writtenCards = [];
  try {
    for (;;) {
      const rows = index.listEvents({ limit: pageSize, offset });
      if (rows.length === 0) break;
      totalEvents += rows.length;
      const result = appendAutoCards({ memoryRoot: root, records: rows, dryRun, resign });
      written += result.written;
      skipped += result.skipped;
      writtenCards.push(...result.cards.map((card) => card.cardId));
      offset += rows.length;
      if (rows.length < pageSize) break;
    }
  } finally {
    index.close();
  }
  return {
    ok: true,
    memoryRoot: root,
    cardsFile: cardsPathOf(root),
    dryRun,
    totalEvents,
    written,
    skipped,
    sampleCardIds: writtenCards.slice(0, 10),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const memoryRoot = args.memoryRoot !== '' ? args.memoryRoot : defaultMemoryRoot();
  const result = backfillAutoCards({ memoryRoot, dryRun: args.dryRun, resign: args.resign });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[backfill-auto-cards] ${result.ok ? 'ok' : result.code} events=${result.totalEvents} wouldWrite=${result.written} skipped=${result.skipped}${args.dryRun ? ' (dry-run)' : ''}`);
    console.log(`[backfill-auto-cards] cards: ${result.cardsFile}`);
  }
  if (!result.ok) process.exitCode = 2;
}
