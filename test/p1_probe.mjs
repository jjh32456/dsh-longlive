// P1 runtime witness. Runs the plugin's own tools inside a throwaway home and
// records EVERY file the fs layer is asked to open, so "this code never reads
// the credential file" is observed rather than asserted from source text.
//
// The parent (run.mjs) plants a decoy credential file in the fake home, sets
// HOME/USERPROFILE/DSH_HOME at it, then requires: (a) the canary read below is
// in the witness list — proof the witness is live, not silently unpatched —
// and (b) nothing the tools touched is the credential file or the real home.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const reads = [];
const calls = [];

// The fs layer accepts a path string, a Buffer, a file-descriptor number, or a
// WHATWG URL — and Node's own ESM loader passes a URL when it reads a module
// through our patched readFileSync. `path.resolve(String(url))` turns
// `file:///C:/x/y.js` into `<cwd>\file:\C:\x\y.js`: a path that does not
// exist, and that shares the real home's prefix whenever the package is
// installed under ~/.dsh. Normalise URLs to real file paths first, or the
// witness reports a phantom "the tools touched the real ~/.dsh".
const toPath = (file) => {
  if (typeof file === 'number') return `<fd ${file}>`;
  if (file instanceof URL) {
    try { return fileURLToPath(file); } catch { return String(file); }
  }
  if (Buffer.isBuffer(file)) return file.toString();
  const text = String(file);
  if (text.startsWith('file:')) {
    try { return fileURLToPath(new URL(text)); } catch { return text; }
  }
  try { return path.resolve(text); } catch { return text; }
};

const original = {
  readFileSync: fs.readFileSync,
  openSync: fs.openSync,
  readFile: fs.readFile,
  createReadStream: fs.createReadStream,
};

// Keep every wrapper bound to the ORIGINAL implementation: no wrapper may call
// another wrapper, or the same read would be recorded twice.
fs.readFileSync = function witnessReadFileSync(file, ...rest) {
  reads.push(toPath(file));
  return original.readFileSync.call(fs, file, ...rest);
};
fs.openSync = function witnessOpenSync(file, ...rest) {
  reads.push(toPath(file));
  return original.openSync.call(fs, file, ...rest);
};
fs.readFile = function witnessReadFile(file, ...rest) {
  reads.push(toPath(file));
  return original.readFile.call(fs, file, ...rest);
};
fs.createReadStream = function witnessCreateReadStream(file, ...rest) {
  reads.push(toPath(file));
  return original.createReadStream.call(fs, file, ...rest);
};

const home = process.env.P1_PROBE_HOME;
if (!home) {
  console.error('P1_PROBE_HOME is required');
  process.exit(2);
}
const memRoot = path.join(home, 'memory');
const sessionFile = path.join(home, 'sessions', '--p1--', 'session-p1', 'session.v4.jsonl.zstd');

// Canary: a read the witness MUST see. If this path is missing from `reads`,
// the instrumentation failed and the credential check below would be vacuous.
fs.readFileSync(path.join(home, 'canary.txt'), 'utf8');

const tools = await import('../src/tools.js');
const plugin = await import('../src/index.js');

const run = (name, fn) => {
  try {
    const value = fn();
    calls.push({ name, ok: true, status: value?.status ?? null, code: value?.code ?? null });
    return value;
  } catch (error) {
    calls.push({ name, ok: false, thrown: String(error?.message ?? error) });
    return null;
  }
};

run('sessionHealth(list)', () => tools.sessionHealth({}, { home }));
run('sessionHealth(latest)', () => tools.sessionHealth({ session: 'latest' }, { home }));
run('sessionHealth(sessionPath)', () => tools.sessionHealth({ sessionPath: sessionFile }, { home }));
run('sessionBackupPlan(dry)', () => tools.sessionBackupPlan({ sessionPath: sessionFile, dryRun: true }, { home }));
run('sessionWake', () => tools.sessionWake({}, { memRoot }));
run('leaseAcquire', () => tools.leaseAcquire({ holder: 'p1-probe', ttlSec: 30 }, { memRoot }));

const payload = { reads, calls, inject: plugin.inject };
// One JSON line on the last line of stdout: the parent parses this, nothing else.
console.log('P1_WITNESS ' + JSON.stringify(payload));
