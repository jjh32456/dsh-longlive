#!/usr/bin/env node
/**
 * Offline D1/D4 sample: replay the last N turns of a real session log through
 * the same `measureTurn()` used live, then reconcile the ledger against the
 * provider's usage numbers.
 *
 * Usage:
 *   node scripts/metrics-sample.mjs --log <session.v4.jsonl.zstd> \
 *     --turns 5 --out <dir>
 *
 * Error algorithm (documented in docs/METRICS.md):
 *   1. each layer is estimated with CJK*1 + non-CJK/3.5;
 *   2. rawTotal = sum(layers) + carried;
 *   3. total = round(rawTotal * factor), with `factor` starting at 1.0;
 *   4. after the turn, if usage exists, the cumulative ratio is updated:
 *        factor = clamp(0.5, 2, (actualSum + actual) / (rawSum + rawTotal));
 *      this is NOT an EWMA: one observed turn already removes the systematic
 *      bias, later turns only refine it;
 *   5. error = total - actual; errorPct = error / actual * 100.
 * The first sample is therefore the cold estimate; samples 2..N are warm.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseSession } from '../src/codec.js';
import { measureTurn, clampFactor, DEFAULT_FACTOR } from '../src/metrics/measure.mjs';
import { findRequestHeader } from '../src/metrics/index.mjs';
import { ledgerPath, writeCalibration } from '../src/metrics/store.mjs';

function parseArgs(argv) {
  const out = { log: '', turns: 5, out: path.resolve('metrics-sample'), seed: DEFAULT_FACTOR, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--log') out.log = argv[++index] ?? '';
    else if (arg === '--turns') out.turns = Math.max(1, Number.parseInt(argv[++index] ?? '', 10) || 5);
    else if (arg === '--out') out.out = path.resolve(argv[++index] ?? out.out);
    else if (arg === '--seed') out.seed = clampFactor(Number(argv[++index] ?? DEFAULT_FACTOR));
    else if (arg.startsWith('--log=')) out.log = arg.slice('--log='.length);
    else if (arg.startsWith('--turns=')) out.turns = Math.max(1, Number.parseInt(arg.slice('--turns='.length), 10) || 5);
    else if (arg.startsWith('--out=')) out.out = path.resolve(arg.slice('--out='.length));
    else if (arg.startsWith('--seed=')) out.seed = clampFactor(Number(arg.slice('--seed='.length)));
  }
  return out;
}

function usageEvents(events) {
  const byTurn = new Map();
  for (const event of events) {
    if (event?.type !== 'assistant/message') continue;
    const turn = event.data?.turn;
    if (!Number.isInteger(turn)) continue;
    if (event.data.usage === null || typeof event.data.usage !== 'object') continue;
    byTurn.set(turn, event);
  }
  return [...byTurn.entries()].sort((a, b) => a[0] - b[0]);
}

function percent(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

function median(values) {
  const list = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 === 1 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
}

function markdownTable(rows) {
  const header = '| turn | fixed | recent | recall | conclusion | carried | total | actual | delta% | within5 | factor |';
  const divider = '|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|---:|';
  const body = rows.map((row) => (
    `| ${row.turn} | ${row.layers.fixed} | ${row.layers.recent} | ${row.layers.recall} | ` +
    `${row.layers.conclusion} | ${row.carried} | ${row.total} | ${row.actualInput ?? '-'} | ` +
    `${row.deltaPct ?? '-'} | ${row.within5pct === true ? 'yes' : row.within5pct === false ? 'no' : '-'} | ` +
    `${row.factor} |`
  ));
  return `${header}\n${divider}\n${body.join('\n')}\n`;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(
    'usage: node scripts/metrics-sample.mjs --log <session.v4.jsonl.zstd> [--turns 5] [--out <dir>] [--seed 1.0]\n',
  );
  process.exit(0);
}
if (args.log === '' || !fs.existsSync(args.log)) {
  process.stderr.write(`metrics-sample: session log not found: ${args.log || '(missing --log)'}\n`);
  process.exit(2);
}

const buffer = fs.readFileSync(args.log);
const parsed = parseSession(buffer);
const events = parsed.events;
const selected = usageEvents(events).slice(-args.turns);
if (selected.length === 0) {
  process.stderr.write('metrics-sample: no assistant usage events in this log\n');
  process.exit(2);
}

const sessionId = typeof parsed.header?.id === 'string'
  ? parsed.header.id
  : path.basename(path.dirname(args.log));
const rows = [];
const details = [];
let factor = args.seed;
let samples = 0;
let rawSum = 0;
let actualSum = 0;

for (const [turn, usageEvent] of selected) {
  const cutSeq = usageEvent.seq;
  const requestEvents = events.filter((event) => Number.isInteger(event?.seq) && event.seq < cutSeq);
  const requestHeader = findRequestHeader(events, cutSeq);
  const row = measureTurn({
    events: requestEvents,
    turn,
    sessionId,
    requestHeader,
    actualUsage: usageEvent.data.usage,
    config: { keepTurns: 12, targetTokens: 40000 },
    factor,
    calibrationSamples: samples,
    now: new Date().toISOString(),
    source: 'sample',
  });
  rows.push(row);
  const actualInput = row.reconciliation?.actualInput ?? null;
  details.push({
    turn,
    layers: row.layers,
    carried: row.carried,
    total: row.total,
    actualInput,
    deltaPct: row.reconciliation?.deltaPct ?? null,
    within5pct: row.reconciliation?.within5pct ?? null,
    factor: row.calibration.factor,
    rawTotal: row.raw.total,
  });
  if (Number.isFinite(actualInput) && actualInput > 0 && Number.isFinite(row.raw.total) && row.raw.total > 0) {
    rawSum += row.raw.total;
    actualSum += actualInput;
    factor = clampFactor(actualSum / rawSum);
    samples += 1;
  }
}

const errors = details.map((row) => row.deltaPct).filter((value) => Number.isFinite(value));
const warmErrors = errors.slice(1);
const summary = {
  samples: details.length,
  estimator: 'cjk*1+other/3.5',
  calibration: 'factor=clamp(0.5,2, actualSum/rawSum) over all sampled turns',
  coldFirstDeltaPct: details[0]?.deltaPct ?? null,
  medianAbsErrorPct: percent(median(errors.map((value) => Math.abs(value)))),
  warmMedianAbsErrorPct: percent(median(warmErrors.map((value) => Math.abs(value)))),
  within5Turns: details.filter((row) => row.within5pct === true).length,
  finalFactor: Number(factor.toFixed(4)),
};

const ledger = ledgerPath(args.out);
fs.mkdirSync(path.dirname(ledger), { recursive: true });
fs.writeFileSync(ledger, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
const calibration = writeCalibration(args.out, {
  factor,
  samples,
  rawSum,
  actualSum,
  keepTurns: 12,
  updatedAt: new Date().toISOString(),
});
const payload = {
  v: 1,
  generatedAt: new Date().toISOString(),
  log: path.resolve(args.log),
  ledger,
  calibrationPath: calibration.path ?? '',
  state: calibration.state ?? null,
  sessionId,
  turns: selected.map(([turn]) => turn),
  summary,
  rows: details,
};
fs.writeFileSync(path.join(args.out, 'reconcile.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
fs.writeFileSync(
  path.join(args.out, 'reconcile.md'),
  `# D1/D4 sample reconciliation\n\n` +
  `- log: \`${path.resolve(args.log)}\`\n` +
  `- turns: ${payload.turns.join(', ')}\n` +
  `- estimator: CJK*1 + non-CJK/3.5; total = round(rawTotal * factor)\n` +
  `- calibration: ${summary.calibration}\n` +
  `- cold first turn error: ${summary.coldFirstDeltaPct ?? '-'}%\n` +
  `- median absolute error (all): ${summary.medianAbsErrorPct ?? '-'}%\n` +
  `- median absolute error (warm, excluding first): ${summary.warmMedianAbsErrorPct ?? '-'}%\n` +
  `- turns within 5%: ${summary.within5Turns}/${summary.samples}\n` +
  `- final factor: ${summary.finalFactor}\n\n` +
  markdownTable(details),
  'utf8',
);

process.stdout.write(
  `[metrics-sample] ${details.length} turn(s) from ${path.basename(args.log)}\n` +
  `[metrics-sample] cold first error ${summary.coldFirstDeltaPct ?? '-'}% · ` +
  `warm median |error| ${summary.warmMedianAbsErrorPct ?? '-'}% · ` +
  `within5 ${summary.within5Turns}/${summary.samples}\n` +
  `[metrics-sample] wrote ${ledger}\n`,
);
for (const row of details) {
  process.stdout.write(
    `  turn ${row.turn}: total ${row.total} vs actual ${row.actualInput ?? '-'} ` +
    `(${row.deltaPct ?? '-'}%) factor ${row.factor}\n`,
  );
}
