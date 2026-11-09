#!/usr/bin/env node
// scripts/rescore-cards.mjs — dry-run salience/retention proposal.
//
//   node scripts/rescore-cards.mjs --memory-root <dir> [--json]
//
// Read-only: no card body/title/frontmatter is changed, no INDEX is written.

import fs from 'node:fs';
import path from 'node:path';

import { scanCards } from '../src/memory/index.js';
import { parseFrontmatter } from '../src/memory/frontmatter.js';
import { rescoreCards } from '../src/memory/card-priority.js';

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
}
const root = arg(process.argv.slice(2), '--memory-root');
if (root === '') {
  console.error('[rescore-cards] --memory-root is required');
  process.exit(2);
}
const cards = scanCards(root).map((card) => {
  let fields = card.fields ?? {};
  try { fields = parseFrontmatter(fs.readFileSync(path.join(root, card.rel), 'utf8')).fields; } catch { /* keep */ }
  return { ...card, fields };
});
const result = rescoreCards(cards);
if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`[rescore-cards] dryRun=true scanned=${result.scanned} changed=${result.changed}`);
  for (const diff of result.changes.slice(0, 30)) {
    console.log(`[rescore-cards] ${diff.path} ${diff.kind ?? '-'} salience ${diff.currentSalience ?? '-'} -> ${diff.proposedSalience}`);
  }
}
