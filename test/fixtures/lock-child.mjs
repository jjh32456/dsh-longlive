// Real subprocess used by test/router-1100/lock-crossproc.test.mjs.
//
// It waits for a shared start timestamp, then races one InstanceLock.acquire()
// with its siblings. The winner writes its result immediately and holds the lock
// for `--holdMs` so every loser observes a live holder, then releases.

import fs from 'node:fs';

import { InstanceLock } from '../../src/router/service/lock.mjs';

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
const file = args.get('--file');
const out = args.get('--out');
const runId = args.get('--runId') ?? `child-${process.pid}`;
const startAt = Number(args.get('--startAt') ?? '0');
const holdMs = Number(args.get('--holdMs') ?? '1200');
const releaseOut = `${out}.release`;

while (Date.now() < startAt) sleepSync(2);

const lock = new InstanceLock({ file, runId });
let result;
try {
  result = lock.acquire();
} catch (error) {
  result = { crash: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 800) };
}
fs.writeFileSync(out, `${JSON.stringify({
  ...result,
  pid: process.pid,
  runId,
  holderRunId: result?.holder?.runId ?? null,
  holderPid: result?.holder?.pid ?? null,
})}\n`, 'utf8');

if (result?.ok === true) {
  await sleep(holdMs);
  let released = false;
  let releaseError = null;
  try {
    released = lock.release();
  } catch (error) {
    releaseError = String(error?.message ?? error);
  }
  fs.writeFileSync(releaseOut, `${JSON.stringify({ released, releaseError })}\n`, 'utf8');
}
process.exit(0);
