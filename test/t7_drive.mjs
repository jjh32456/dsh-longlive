// T7 driver: boot the real host (sdk profile) against an isolated DSH_HOME,
// resume a persisted session, send one prompt and wait for the assistant reply.
// Usage: T7_DSH_HOME=... T7_SESSION_FILE=... node test/t7_drive.mjs <sessionId> [prompt]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { parseSession } from '../src/codec.js';

// No install path is hard-coded: a machine that does not opt in gets a clean
// skip (exit 2) instead of a driver that happens to work only on one drive.
const EXE = process.env.DSH_EXE;
const CLI = process.env.DSH_CLI_JS;
if (!EXE || !CLI) {
  console.error(JSON.stringify({
    ok: false,
    skipped: true,
    error: 'DSH_EXE and DSH_CLI_JS are required; no default install path is hard-coded',
  }));
  process.exit(2);
}
const HOME = process.env.T7_DSH_HOME;
if (!HOME || !process.env.T7_SESSION_FILE) {
  console.error(JSON.stringify({ ok: false, error: 'T7_DSH_HOME and T7_SESSION_FILE are required' }));
  process.exit(2);
}
const SESSION = process.argv[2];
const PROMPT = process.argv[3] ?? '只回两个字：收到';
const CWD = process.env.T7_CWD ?? process.cwd();
const SESSION_FILE = process.env.T7_SESSION_FILE;
const WAIT_MS = Number(process.env.T7_WAIT_MS ?? 120000);
const POLL_MS = 500;

const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const readEvents = () => parseSession(fs.readFileSync(SESSION_FILE)).events;
const before = { bytes: fs.statSync(SESSION_FILE).size, sha256: sha(SESSION_FILE), events: readEvents().length };

const child = spawn(EXE, ['--expose-internals', CLI, 'sdk'], {
  env: { ...process.env, DSH_HOME: HOME, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
const pending = new Map();
let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString(); });
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) onLine(line);
  }
});

function onLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id && !msg.method) {
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
    else waiter.resolve(msg.result);
  }
  // notifications (session/event etc.) are observed through the session file
}

let nextId = 0;
function request(method, params) {
  const id = `t7_${nextId += 1}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function assistantTexts(events, from) {
  const out = [];
  for (const e of events.slice(from)) {
    if (e.type !== 'assistant/message') continue;
    const content = e.data?.message?.content;
    const text = Array.isArray(content)
      ? content.filter((x) => x.type === 'text').map((x) => x.text).join('')
      : '';
    if (text.trim()) out.push(text.trim());
  }
  return out;
}

function seqContiguous(events) {
  for (let i = 0; i < events.length; i += 1) if (events[i].seq !== i) return false;
  return true;
}

const driverTimeout = setTimeout(() => {
  console.error(JSON.stringify({ ok: false, error: 'driver timeout', stderrTail: stderr.slice(-800) }));
  child.kill();
  process.exit(1);
}, 240000);

try {
  await request('initialize', { cwd: CWD, provider: 'deepseek-official', model: 'deepseek-chat' });
  await request('session/resume', { sessionId: SESSION });
  await request('session/prompt', { sessionId: SESSION, contentBlocks: [{ type: 'text', text: PROMPT }] });

  const deadline = Date.now() + WAIT_MS;
  let events = readEvents();
  let texts = assistantTexts(events, before.events);
  while (Date.now() < deadline && texts.length === 0) {
    const turnEnded = events.slice(before.events).some((e) => e.type === 'turn/end');
    if (turnEnded) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
    events = readEvents();
    texts = assistantTexts(events, before.events);
  }

  const after = { bytes: fs.statSync(SESSION_FILE).size, sha256: sha(SESSION_FILE), events: events.length };
  const result = {
    ok: texts.length > 0,
    assistantTexts: texts.slice(-3),
    seqContiguous: seqContiguous(events),
    eventsBefore: before.events,
    eventsAfter: after.events,
    bytesBefore: before.bytes,
    bytesAfter: after.bytes,
    sha256Before: before.sha256,
    sha256After: after.sha256,
    lastTypes: events.slice(-3).map((e) => e.type),
    stderrTail: stderr.slice(-300),
  };

  try {
    await Promise.race([request('shutdown', {}), new Promise((r) => setTimeout(r, 3000))]);
  } catch { /* ignore shutdown errors */ }
  clearTimeout(driverTimeout);
  child.stdin.end();
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    setTimeout(resolve, 5000);
  });
  result.exitCode = child.exitCode;
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok && result.seqContiguous && child.exitCode === 0 ? 0 : 3);
} catch (error) {
  clearTimeout(driverTimeout);
  console.log(JSON.stringify({ ok: false, error: String(error.message ?? error), stderrTail: stderr.slice(-1500) }, null, 2));
  child.kill();
  process.exit(2);
}
