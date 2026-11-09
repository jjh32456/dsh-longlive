#!/usr/bin/env node
// scripts/index-reconcile.mjs — event/card/audit/anchor set reconciliation.
//
//   node scripts/index-reconcile.mjs --memory-root <dir> [--write] [--json]
//   node scripts/index-reconcile.mjs --memory-root <dir> --accept <cardId> [--apply] [--json]
//
// Default: summarize only. `--write` emits .longlive/reports/reconcile-<date>.json.
// Promotion is dry-run unless `--apply` AND `--accept` are both supplied.

import { promoteAutoCard, reconcileIndex } from '../src/memory/reconcile.js';

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
}
const argv = process.argv.slice(2);
const root = arg(argv, '--memory-root');
if (root === '') {
  console.error('[index-reconcile] --memory-root is required');
  process.exit(2);
}
const json = argv.includes('--json');
const accept = arg(argv, '--accept');
if (accept !== '') {
  const result = promoteAutoCard({
    memoryRoot: root,
    cardId: accept,
    dryRun: !argv.includes('--apply'),
  });
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`[index-reconcile] promote card=${result.cardId} dryRun=${result.dryRun}`);
    console.log(`[index-reconcile] target=${result.rel}`);
    if (result.index) console.log(`[index-reconcile] INDEX applied=${result.index.applied} changed=${result.index.changed}`);
  }
  process.exitCode = result.ok === false ? 1 : 0;
} else {
  const result = reconcileIndex({ memoryRoot: root, write: argv.includes('--write') });
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`[index-reconcile] candidates=${result.autoCandidates.count}`);
    console.log(`[index-reconcile] eventNotAudit=${result.sets.eventNotAudit.count} eventNoCard=${result.sets.eventNoCard.count} dropStillCarded=${result.sets.dropButStillCarded.count}`);
    console.log(`[index-reconcile] anchorLegacy/empty=${result.sets.cardAnchors.legacyOrEmptyAnchors} invalidSourceIds=${result.sets.cardAnchors.invalidSourceEventIds.length}`);
    if (result.reportPath) console.log(`[index-reconcile] report=${result.reportPath}`);
    const first = result.autoCandidates.sample[0];
    if (first) console.log(`[index-reconcile] example=${first.cardId} turn=${first.turn} title=${first.title.slice(0, 50)}`);
  }
  process.exitCode = result.events.ok === false ? 1 : 0;
}
