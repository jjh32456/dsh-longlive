#!/usr/bin/env node
// RC.5 A1 legacy migration CLI.
// Dry-run by default. --apply moves legacy cards into .longlive staging, writes
// a receipt/log, then rebuilds INDEX.md. It never deletes card content.
import fs from 'node:fs';
import path from 'node:path';
import { migrateLegacyA1, preflightA1Legacy } from '../src/memory/a1-migration.js';
import { memoryIndex } from '../src/memory/index.js';

const args = process.argv.slice(2);
let memoryRoot = '';
let apply = false;
let checkOnly = false;
let out = '';
let json = false;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--memory-root' || arg === '--root') memoryRoot = args[++i] ?? '';
  else if (arg.startsWith('--memory-root=')) memoryRoot = arg.slice('--memory-root='.length);
  else if (arg.startsWith('--root=')) memoryRoot = arg.slice('--root='.length);
  else if (arg === '--apply') apply = true;
  else if (arg === '--dry-run') apply = false;
  else if (arg === '--check-only' || arg === '--preflight') checkOnly = true;
  else if (arg === '--json') json = true;
  else if (arg === '--out') out = args[++i] ?? '';
  else {
    console.error(`[migrate-a1-legacy] unknown argument: ${arg}`);
    process.exit(2);
  }
}
if (memoryRoot === '') {
  console.error('usage: node scripts/migrate-a1-legacy.mjs --memory-root <path> [--dry-run|--apply|--check-only] [--json] [--out <file>]');
  process.exit(2);
}
const root = path.resolve(memoryRoot);
const preflight = preflightA1Legacy(root);
let result;
if (checkOnly) {
  result = { ok: true, checkOnly: true, ...preflight };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(path.resolve(out), text, 'utf8'); }
  process.stdout.write(text);
  process.exit(preflight.blocking ? 2 : 0);
}
result = migrateLegacyA1({ memoryRoot: root, dryRun: !apply, now: new Date() });
result.preflight = preflight;
let index = null;
if (apply) {
  try {
    index = memoryIndex({ apply: true }, { memoryRoot: root });
    result.indexRebuilt = index.applied === true;
    result.indexCards = index.cards;
  } catch (error) {
    result.indexError = String(error?.message ?? error);
  }
}
const text = `${JSON.stringify(result, null, 2)}\n`;
if (out) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(path.resolve(out), text, 'utf8');
}
process.stdout.write(json || !out ? text : '');
