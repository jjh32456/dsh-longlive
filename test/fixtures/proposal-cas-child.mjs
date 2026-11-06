// Real subprocess used by test/router-1100/proposal-cas-crossproc.test.mjs.
//
// Each child runs the same updateProposalStrict(dir, id, expectedRev) against a
// shared proposal directory. Exactly one child may win the CAS; the rest must
// surface E_STATE_RACE after acquiring the inter-process proposal lock. Only a
// retryable E_STORAGE (lock contention) is retried.

import fs from 'node:fs';

import { updateProposalStrict } from '../../src/router/service/store.mjs';

function parse(argv) {
  const map = new Map();
  for (let i = 0; i < argv.length; i += 2) map.set(argv[i], argv[i + 1]);
  return map;
}

function sleepSync(ms) {
  if (!(ms > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* bounded fallback */ }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const args = parse(process.argv.slice(2));
const dir = args.get('--dir');
const id = args.get('--id');
const expectedRev = Number(args.get('--rev') ?? '0');
const out = args.get('--out');
const startAt = Number(args.get('--startAt') ?? '0');
const attempts = Math.max(1, Number(args.get('--attempts') ?? '4'));
const writer = args.get('--writer') ?? `writer-${process.pid}`;

while (Date.now() < startAt) sleepSync(2);

let result = null;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const next = updateProposalStrict(dir, id, expectedRev, () => ({ title: writer }), {});
    result = { ok: true, rev: next.rev, title: next.title, attempts: attempt };
    break;
  } catch (error) {
    if (error?.code === 'E_STORAGE' && error?.retryable === true && attempt < attempts) {
      await sleep(30 + Math.floor(Math.random() * 20));
      continue;
    }
    result = {
      ok: false,
      code: error?.code ?? 'E_UNKNOWN',
      retryable: error?.retryable === true,
      message: String(error?.message ?? error).slice(0, 300),
      attempts: attempt,
    };
    break;
  }
}

fs.writeFileSync(out, `${JSON.stringify({ ...result, pid: process.pid, writer })}\n`, 'utf8');
process.exit(0);
