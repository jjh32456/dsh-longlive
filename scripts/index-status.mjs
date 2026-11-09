#!/usr/bin/env node
// scripts/index-status.mjs — read-only "indexed through / lag" status.
//
//   node scripts/index-status.mjs --memory-root <dir> [--json]
//
// Never writes. The status is the same object memory-state / the memory_index
// tool result exposes; a generated timestamp alone is not treated as health.

import { getIndexFreshness } from '../src/memory/index-freshness.js';

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
}
const root = arg(process.argv.slice(2), '--memory-root');
if (root === '') {
  console.error('[index-status] --memory-root is required (real memory roots are not written by this script)');
  process.exit(2);
}
const status = getIndexFreshness({ memoryRoot: root });
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(status, null, 2));
} else {
  console.log(`[index-status] status=${status.status} healthy=${status.healthy}`);
  console.log(`[index-status] generatedAt=${status.generatedAt ?? '-'} dataThroughAt=${status.dataThroughAt ?? '-'}`);
  console.log(`[index-status] indexLagMs=${status.indexLagMs ?? '-'} dataAgeMs=${status.dataAgeMs ?? '-'}`);
  if (status.lastError) console.log(`[index-status] lastError=${status.lastError}`);
}
