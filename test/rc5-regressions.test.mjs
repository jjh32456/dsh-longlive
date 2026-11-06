// rc.5 — red-team regressions R4-01 .. R4-02.
//
// R4-01  two hosts that BOTH registered the fallback pre-step hook before either
//        injected used to append the receipt twice: the cross-process claim was
//        released before the second host looked, and the second host only read
//        the state at startup. Now the winner re-reads the state while holding
//        the claim, and the atomic mark is checked too; the loser records
//        `skipped-already`.
// R4-02  the receipt printed only the first 8 characters of a legal session id.
//        A legal `[a-z0-9-]` id is now echoed in full; only an id that fails the
//        whitelist is sanitised and shortened.
//
// Each case builds a throwaway memory root under os.tmpdir(); nothing here
// touches a real session, the host, a profile or the network.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { registerFeatures } from '../src/features.js';
import {
  CLASSIFICATIONS,
  RECOVERY_REASON,
  displaySessionId,
  readSurgeryState,
  receiptText,
  surgeryStatePath,
} from '../src/surgery-recovery.js';

const RECEIPT = '【手术回执】R4-01 fixture';
const PAYLOAD = { step: 1, agent: { session: { id: 'session-live', header: { origin: 'main' } } } };
const NEXT = async () => ({ kind: 'enter', messages: [] });

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'longlive-rc5-'));
}

function writeState(root, receipt = null, sessionId = 'session-live') {
  fs.mkdirSync(path.join(root, '.longlive'), { recursive: true });
  const state = {
    version: 1,
    kind: 'longlive-surgery',
    surgeryId: 'surgery-r4-01-fixture',
    phase: 'restart',
    sessionPath: null,
    sessionId,
    memoryRoot: root,
    dryRun: false,
    receipt,
    history: [],
  };
  fs.writeFileSync(surgeryStatePath(root), `${JSON.stringify(state, null, 2)}\n`);
}

/** One host process: register the feature, keep its hook list and warnings. */
function registerHost(root) {
  const hooks = [];
  const warnings = [];
  const ctx = {
    on(name, listener) {
      const entry = { name, listener };
      hooks.push(entry);
      return () => {
        const index = hooks.indexOf(entry);
        if (index >= 0) hooks.splice(index, 1);
      };
    },
    logger() {
      return {
        warn: (message) => warnings.push(String(message)),
        info: () => {},
      };
    },
    tools: {
      register() {
        return () => {};
      },
    },
  };
  const returned = registerFeatures(ctx, {}, { memoryRoot: root, surgeryReceipt: RECEIPT });
  assert.equal(hooks.length, 1, 'one receipt hook per host');
  return { hooks, warnings, returned };
}

function auditText(root) {
  const file = path.join(root, '.longlive', 'audit.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

// ---------------------------------------------------------------------------
// R4-01 — two hosts that registered first still inject only once
// ---------------------------------------------------------------------------

test('R4-01: two hosts register before either injects -> one receipt, loser records skipped-already', async () => {
  const root = makeRoot();
  try {
    writeState(root);
    // Both hosts saw "receipt missing" at startup and registered their hook
    // before either one reached step 1: exactly the R3-03 residual.
    const hostA = registerHost(root);
    const hostB = registerHost(root);

    const first = await hostA.hooks[0].listener(PAYLOAD, NEXT);
    assert.equal(first.messages.length, 1, 'the first host injects the receipt');
    assert.match(first.messages[0].id, /^surgery-receipt-/);
    assert.equal(readSurgeryState(root).state.receipt.fallbackInjected, true);

    const second = await hostB.hooks[0].listener(PAYLOAD, NEXT);
    assert.equal(second.messages.length, 0, 'the second host must not append a duplicate');
    assert.equal(hostB.hooks.length, 0, 'the losing hook unregisters itself');
    assert.match(auditText(root), /surgery-fallback-inject\tstate\tskipped-already/);
    assert.equal(
      fs.existsSync(path.join(root, '.longlive', 'surgery-fallback-inject.lock')),
      false,
      'the skipped-already path must release the claim too',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R4-01: a receipt written while the hook was registered is caught by the second state read', async () => {
  const root = makeRoot();
  try {
    writeState(root);
    const host = registerHost(root);
    // The startup check ran when receipt was null; the real receipt path (or
    // another host) finishes before this host reaches step 1.
    writeState(root, {
      written: true,
      eventId: 'surgery-receipt-early',
      seq: 12,
      at: '2026-11-04T06:40:00.000Z',
    });

    const decision = await host.hooks[0].listener(PAYLOAD, NEXT);
    assert.equal(decision.messages.length, 0, 'an already-written receipt is never injected again');
    assert.equal(host.hooks.length, 0);
    assert.match(auditText(root), /surgery-fallback-inject\tstate\tskipped-already/);
    // The real receipt marker is untouched.
    assert.equal(readSurgeryState(root).state.receipt.written, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R4-02 — a legal session id is printed in full
// ---------------------------------------------------------------------------

function reportFor(sessionId) {
  return {
    classification: CLASSIFICATIONS.APPLIED_VERIFIED,
    reasonCode: RECOVERY_REASON.OK_VERIFIED,
    statePhase: 'restart',
    sessionId,
    checks: {
      phase: 'restart',
      sessionId,
      sessionPath: 'C:\\sessions\\scope\\fixture\\session.v4.jsonl.zstd',
      sessionBytes: 1000,
      beforeBytes: 4000,
      sessionEvents: 10,
      beforeEvents: 40,
      sessionMessages: 8,
      beforeMessages: 20,
      shaMatch: true,
      expectedSha256: 'a'.repeat(64),
      backupPath: 'C:\\backups\\fixture.pre-surgery-1',
      backupExists: true,
    },
  };
}

test('R4-02: a legal 36-character session id appears in the receipt in full', () => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  assert.equal(displaySessionId(id), id);
  const text = receiptText(reportFor(id), { appendingReceipt: true, seq: 9 });
  const idLine = text.split(/\r?\n/).find((line) => line.startsWith('会话 id：'));
  assert.equal(idLine, `会话 id：${id}`, text);
  assert.ok(!/leak-root|C:\\/.test(text), text);
});

test('R4-02: an illegal id is still sanitised and shortened, and never leaks a path', () => {
  const tampered = '..\\..\\C:\\leak-root\\profiles\\Administrator';
  const text = receiptText(reportFor(tampered), { appendingReceipt: true, seq: 9 });
  assert.match(text, /会话 id：\?{6}c\?/, text);
  assert.ok(!text.includes('leak-root'), text);
  assert.ok(!text.includes('..\\'), text);
  assert.ok(!text.includes('C:'), text);
  // The whitelist still governs the helper; only legal values get the full form.
  assert.equal(displaySessionId('ABCD-1234'), 'abcd-123');
  assert.equal(displaySessionId('d2-fixture'), 'd2-fixture');
  assert.equal(displaySessionId(''), null);
});
