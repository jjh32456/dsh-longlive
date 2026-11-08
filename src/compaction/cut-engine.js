// Binding of the host-free cut core to the real compaction seam.
//
// This module is imported by `entry.js` inside a try/catch. Only the compaction
// package is required; `createUserMessage` is optional because engine-core.js
// has an equivalent fallback. The two module ids can be redirected by env for
// the mock-host suite (the same seam dsh-live-compact uses for its failure
// drills); production never sets them.

import { createCutEngine } from './engine-core.js';

const compactionId = process.env.DSH_HOT_TRUNCATE_HOST_COMPACTION || '@deepseek-ai/dsh-compaction';
const llmId = process.env.DSH_HOT_TRUNCATE_HOST_LLM || '@deepseek-ai/dsh-llm';

const host = await import(compactionId);
const CompactionEngine = host.CompactionEngine ?? host.default;
if (typeof CompactionEngine !== 'function') {
  throw new Error(`hot-truncate: ${compactionId} exports no CompactionEngine`);
}

let createUserMessage = null;
let contextOverflowCode = null;
try {
  const llm = await import(llmId);
  createUserMessage = llm.createUserMessage ?? null;
  contextOverflowCode = llm.CONTEXT_WINDOW_EXCEEDED_CODE ?? null;
} catch {
  // Optional: engine-core falls back to an identified frozen message object
  // and the documented literal failure code.
}

const HotTruncateEngine = createCutEngine({
  CompactionEngine,
  CompactionId: host.CompactionId,
  ManualCompactionError: host.ManualCompactionError,
  compactCheckpointSource: host.compactCheckpointSource,
  isCompactCheckpointSource: host.isCompactCheckpointSource,
  toolPairingBalancedBefore: host.toolPairingBalancedBefore,
  toolPairingBalancedAfter: host.toolPairingBalancedAfter,
  ...(contextOverflowCode === null ? {} : { contextOverflowCode }),
  createUserMessage: createUserMessage ?? undefined,
});

export default HotTruncateEngine;
export { HotTruncateEngine };
