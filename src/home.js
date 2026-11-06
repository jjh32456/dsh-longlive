// Where DSH keeps its state on this machine.
//
// One definition, two consumers: `src/tools.js` (session logs, default memory
// store) and `src/memory/paths.js` (memory root). Keeping it here avoids a
// tools.js <-> memory/paths.js import cycle and, more importantly, keeps the
// package from ever hard-coding a drive letter: `$DSH_HOME` wins, else
// `~/.dsh`, which is what the host itself uses on every platform.

import os from 'node:os';
import path from 'node:path';

/** Resolve the DSH home: $DSH_HOME, else ~/.dsh. Never a hard-coded drive letter. */
export function dshHome(env = process.env) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return path.resolve(configured || path.join(os.homedir(), '.dsh'));
}
