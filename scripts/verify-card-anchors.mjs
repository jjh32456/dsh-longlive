#!/usr/bin/env node
// scripts/verify-card-anchors.mjs — 1.8.0 AutoCard anchor liveness check.
//
//   node scripts/verify-card-anchors.mjs [--memory-root <dir>] [--sessions-root <dir>]
//        [--all | --sample N] [--json] [--out <file>]
//
// Reads `.longlive/index/cards.jsonl`, loads the original L0 session for every
// card anchor, recomputes turnDigest, and labels each card live / stale / missing.
// Exit 1 when any card is not live (unless --allow-stale for inspection runs).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseSession } from '../src/codec.js';
import { discoverSessionLogs, extractTurns } from '../src/memory/event-index.js';
import { readAutoCards, cardsPathOf } from '../src/memory/auto-cards.js';

function dshHome() {
  const raw = process.env.DSH_HOME;
  return typeof raw === 'string' && raw.trim() !== '' ? path.resolve(raw.trim()) : path.join(os.homedir(), '.dsh');
}

function defaultMemoryRoot() {
  for (const envName of ['DSH_LONGLIVE_MEMORY_ROOT', 'DSH_MEM']) {
    const value = process.env[envName];
    if (typeof value === 'string' && value.trim() !== '') return path.resolve(value.trim());
  }
  return path.join(dshHome(), 'longlive-memory');
}

function parseArgs(argv) {
  const out = { memoryRoot: '', sessionsRoot: '', sample: 0, json: false, out: '', allowStale: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match) continue;
    const [, key, inline] = match;
    const value = inline !== undefined ? inline : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '');
    if (key === 'memory-root') out.memoryRoot = value;
    else if (key === 'sessions-root') out.sessionsRoot = value;
    else if (key === 'sample') out.sample = Number.parseInt(value, 10) || 0;
    else if (key === 'json') out.json = true;
    else if (key === 'out') out.out = value;
    else if (key === 'allow-stale') out.allowStale = true;
  }
  return out;
}

/** Discover session files without parsing them (avoid loading 900MB at once). */
function sessionFiles(sessionsRoot) {
  const files = new Map();
  for (const item of discoverSessionLogs([sessionsRoot])) files.set(item.sessionId, item.file);
  return files;
}

export function verifyCards({ memoryRoot, sessionsRoot } = {}) {
  const root = path.resolve(String(memoryRoot ?? ''));
  const cards = readAutoCards(root);
  const files = sessionFiles(path.resolve(String(sessionsRoot ?? '')));
  const items = [];
  const bySession = new Map();
  for (const card of cards) {
    const ids = [card.sessionId, card.anchor?.sessionId].filter(Boolean);
    const sessionId = ids[0];
    if (!bySession.has(sessionId)) bySession.set(sessionId, []);
    bySession.get(sessionId).push(card);
  }
  for (const [sessionId, group] of bySession) {
    let parsed = null;
    const file = files.get(sessionId);
    if (file) {
      try { parsed = parseSession(fs.readFileSync(file)); } catch { parsed = null; }
    }
    // Use the same per-turn extraction as the index builder; turnWindowOf would
    // include preamble events differently and produce false stale digests.
    const records = new Map();
    if (parsed) {
      try {
        for (const record of extractTurns(parsed.header, parsed.events, parsed.frames, parsed.texts)) {
          records.set(record.turn, record);
        }
      } catch { /* unreadable session => missing below */ }
    }
    for (const card of group) {
      const record = records.get(card.turn);
      if (!record) {
        items.push({
          cardId: card.cardId, eventId: card.eventId, sessionId: card.sessionId, turn: card.turn,
          status: 'missing', code: parsed ? 'E_TURN_MISSING' : 'E_SESSION_MISSING',
          expectedDigest: card.anchor.digest, actualDigest: null,
        });
        continue;
      }
      const anchor = card.anchor;
      const sameWindow = anchor.seqStart === record.seqStart && anchor.seqEnd === record.seqEnd;
      const live = sameWindow && anchor.digest === record.digest;
      items.push({
        cardId: card.cardId, eventId: card.eventId, sessionId: card.sessionId, turn: card.turn,
        status: live ? 'live' : 'stale',
        code: live ? 'OK' : (sameWindow ? 'E_TURN_DIGEST_MISMATCH' : 'E_TURN_WINDOW_MISMATCH'),
        expectedDigest: anchor.digest,
        actualDigest: record.digest,
      });
    }
  }
  const counts = { total: items.length, live: 0, stale: 0, missing: 0 };
  for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;
  return { schema: 'card-anchors/v1', memoryRoot: root, cardsFile: cardsPathOf(root), sessions: files.size, counts, items };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const memoryRoot = args.memoryRoot !== '' ? args.memoryRoot : defaultMemoryRoot();
  const sessionsRoot = args.sessionsRoot !== '' ? args.sessionsRoot : path.join(dshHome(), 'sessions');
  const report = verifyCards({ memoryRoot, sessionsRoot });
  let items = report.items;
  if (args.sample > 0 && items.length > args.sample) {
    items = [...items].sort((a, b) => a.cardId.localeCompare(b.cardId)).slice(0, args.sample);
  }
  const output = { ...report, items, sampled: args.sample > 0 && args.sample < report.items.length };
  const body = args.json || args.out !== '';
  if (body) {
    const text = JSON.stringify(output, null, 2);
    if (args.json) console.log(text);
    if (args.out !== '') {
      fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
      fs.writeFileSync(path.resolve(args.out), `${text}\n`, 'utf8');
    }
  } else {
    console.log(`[verify-card-anchors] total=${output.counts.total} live=${output.counts.live} stale=${output.counts.stale} missing=${output.counts.missing}`);
    for (const item of items.filter((x) => x.status !== 'live').slice(0, 20)) {
      console.log(`  ${item.status} ${item.cardId} ${item.sessionId}#${item.turn} ${item.code}`);
    }
  }
  if ((output.counts.stale > 0 || output.counts.missing > 0) && !args.allowStale) process.exitCode = 1;
}
