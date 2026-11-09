#!/usr/bin/env node
// scripts/index-maintain.mjs — explicitly refresh INDEX.md + freshness ledger.
//
//   node scripts/index-maintain.mjs --memory-root <dir> [--apply] [--json]
//
// Default is dry-run. This is the same maintenance path captureTurn invokes
// after a successful event/card capture; it is idempotent (`ifChanged`).

import { memoryIndex } from '../src/memory/index.js';
import { getIndexFreshness, refreshIndexAfterCapture } from '../src/memory/index-freshness.js';

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
}
const argv = process.argv.slice(2);
const root = arg(argv, '--memory-root');
if (root === '') {
  console.error('[index-maintain] --memory-root is required');
  process.exit(2);
}
const apply = argv.includes('--apply');
let result;
if (apply) {
  result = refreshIndexAfterCapture({ memoryRoot: root, indexer: memoryIndex });
  result.status = result.ok ? 'applied' : 'error';
} else {
  result = memoryIndex({}, { memoryRoot: root });
  result.freshness = getIndexFreshness({ memoryRoot: root });
  result.status = 'dry-run';
}
if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`[index-maintain] status=${result.status} ok=${result.ok}`);
  console.log(`[index-maintain] cards=${result.cards ?? '-'} changed=${result.changed ?? '-'}`);
  if (result.freshness) console.log(`[index-maintain] freshness=${result.freshness.status} lagMs=${result.freshness.indexLagMs}`);
  if (result.failure) console.log(`[index-maintain] failure=${result.failure.code}`);
}
process.exitCode = result.ok === false ? 1 : 0;
