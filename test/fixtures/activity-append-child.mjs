// Child process used by test/activity-stream.test.mjs to prove that two
// processes appending to the same board produce unique, contiguous seq values.
// Usage: node activity-append-child.mjs <memoryRoot> <sessionId> <count> <tag>

import crypto from 'node:crypto';

import { createActivityStore } from '../../src/activity/store.js';

const [memoryRoot, sessionId, countText, tag] = process.argv.slice(2);
const count = Number(countText);
if (!memoryRoot || !sessionId || !Number.isInteger(count) || count < 1) {
  console.error(JSON.stringify({ ok: false, error: 'bad-args' }));
  process.exit(2);
}
const store = createActivityStore({ memoryRoot });
for (let index = 0; index < count; index += 1) {
  const result = store.append({
    sessionId,
    kind: 'doing',
    // Deliberately dissimilar texts: this test is about append/lock, not dedupe.
    text: `${tag} 独立任务 ${index} ${crypto.randomUUID()}`,
    key: `${tag}|task-${index}`,
  });
  if (!result.ok) {
    console.error(JSON.stringify({ ok: false, index, code: result.code }));
    process.exit(3);
  }
}
console.log(JSON.stringify({ ok: true, count }));
