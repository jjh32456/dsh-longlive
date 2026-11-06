#!/usr/bin/env node
// Surgery helper: session inspector, post-mortem report, receipt writer.
//
// The PowerShell launcher must record before/after evidence (bytes, sha256,
// event count, message count) without implementing zstd/v4 parsing itself.
// This helper prints exactly one JSON line.
//
//   node scripts/surgery-inspect.mjs <session.v4.jsonl.zstd>
//   node scripts/surgery-inspect.mjs --recover-report [--memory-root <root>]
//   node scripts/surgery-inspect.mjs --write-receipt --session <path> [--memory-root <root>]
//
// `--status` is an alias of `--recover-report`. The report path returns the
// same read-only verdict as statusSurgery(): it reads the state, the session
// and the backup, and creates no report file, audit line or directory.
//
// `--write-receipt` is the only writing mode: the launcher calls it after a
// verified cut and before restarting the host, so the next session shows the
// verdict as ordinary conversation text. It appends exactly one user/message,
// keeps a `.bak-receipt-*` copy and records receipt evidence in the state file.
//
// Exit 0 with {ok:true,...}; exit 2 with {ok:false,code,message}.

import fs from 'node:fs';
import path from 'node:path';

import { MESSAGE_TYPES, foldSurface, parseSession, sha256 } from '../src/codec.js';
import { statusSurgery, writeSurgeryReceipt } from '../src/surgery-recovery.js';
import { dshHome } from '../src/home.js';

function emit(value, code) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exitCode = code;
}

/** The root the plugin uses, resolved without creating it. */
function defaultMemoryRoot(env = process.env) {
  for (const key of ['DSH_LONGLIVE_MEMORY_ROOT', 'DSH_MEM']) {
    const value = typeof env?.[key] === 'string' ? env[key].trim() : '';
    if (value) return path.resolve(value);
  }
  return path.join(dshHome(env), 'longlive-memory');
}

function parseReportArgs(argv) {
  const options = { memoryRoot: defaultMemoryRoot() };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--recover-report' || flag === '--status' || flag === '--write-receipt') continue;
    if (flag === '--memory-root') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw Object.assign(new Error('--memory-root needs a value'), { code: 'BAD_ARGUMENT' });
      }
      options.memoryRoot = path.resolve(value);
      i += 1;
      continue;
    }
    if (flag === '--session') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw Object.assign(new Error('--session needs a value'), { code: 'BAD_ARGUMENT' });
      }
      options.sessionPath = path.resolve(value);
      i += 1;
      continue;
    }
    throw Object.assign(new Error(`unknown argument: ${flag}`), { code: 'BAD_ARGUMENT' });
  }
  return options;
}

const argv = process.argv.slice(2);
if (argv.includes('--write-receipt')) {
  try {
    const options = parseReportArgs(argv);
    const result = writeSurgeryReceipt({
      sessionPath: options.sessionPath,
      memoryRoot: options.memoryRoot,
    });
    emit({ ...result, memoryRoot: options.memoryRoot }, result.ok ? 0 : 2);
  } catch (error) {
    emit({ ok: false, code: error?.code ?? 'RECEIPT_FAILED', message: error?.message ?? String(error) }, 2);
  }
} else if (argv.includes('--recover-report') || argv.includes('--status')) {
  try {
    emit(statusSurgery(parseReportArgs(argv)), 0);
  } catch (error) {
    emit({ ok: false, code: error?.code ?? 'RECOVER_REPORT_FAILED', message: error?.message ?? String(error) }, 2);
  }
} else {
  const file = argv[0];
  if (!file || file.startsWith('--')) {
    emit({
      ok: false,
      code: 'BAD_ARGUMENT',
      message: 'usage: surgery-inspect.mjs <session.v4.jsonl.zstd> | --recover-report [--memory-root <root>]',
    }, 2);
  } else {
    try {
      const buf = fs.readFileSync(file);
      const parsed = parseSession(buf);
      const messages = foldSurface(parsed.events).filter((node) => MESSAGE_TYPES.has(node.type)).length;
      emit({
        ok: true,
        path: file,
        bytes: buf.length,
        sha256: sha256(buf),
        events: parsed.events.length,
        messages,
        sessionId: parsed.header?.id ?? null,
        createdAt: parsed.header?.createdAt ?? null,
      }, 0);
    } catch (error) {
      emit({
        ok: false,
        code: error?.code ?? 'INSPECT_FAILED',
        message: error?.message ?? String(error),
        path: file,
      }, 2);
    }
  }
}
