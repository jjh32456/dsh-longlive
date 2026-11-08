// src/lifecycle/index.js — M2-B / PLAN §2.7：宿主生命周期入账 + 双时钟空窗补记
//
// 启动时（memoryV2.enabled=true 且 host 支持）：
//   1) 读上次 boot.json / shutdown.json → 判定 prevExitForm（clean|crash|unknown）；
//   2) computeGaps() 算 host-gap / memory-gap（分别记录、不合并）；
//   3) 追加 `.longlive/board/lifecycle.jsonl` 事件行；
//   4) 原子写本次 boot.json（tmp→rename）；
//   5) 通过 capture 把两钟写进 journal（幂等 cap key）+ 索引 lifecycle 事件；
//   6) 注册退出钩子写 shutdown.json（exit form 的唯一可靠来源）。
// 任何异常只告警、不阻断插件加载（与 surgery-recovery 同款）。

import fs from 'node:fs';
import path from 'node:path';

import { createCapture, writeFileAtomic } from '../memory/capture.js';
import { acquireLease, releaseLease } from '../memory/lock.js';
import { computeGaps, renderGapLines } from './gap-clocks.js';

export const LIFECYCLE_SCHEMA = 'host-lifecycle/v1';

function nowMs(now) {
  const value = typeof now === 'function' ? now() : new Date();
  return value instanceof Date ? value.getTime() : Number(value);
}

function readJsonSafe(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true; // EPERM etc: cannot prove dead -> treat as alive (conservative)
  }
}

export function lifecyclePaths(memoryRoot) {
  const root = path.resolve(String(memoryRoot ?? ''));
  const bridge = path.join(root, '.longlive', 'bridge');
  return {
    root,
    bridge,
    boot: path.join(bridge, 'boot.json'),
    shutdown: path.join(bridge, 'shutdown.json'),
    lifecycleLog: path.join(root, '.longlive', 'board', 'lifecycle.jsonl'),
    lock: path.join(root, '.longlive', 'memory', 'lifecycle.lock'),
  };
}

/**
 * Create the host lifecycle recorder.
 *
 * @param {object} options
 * @param {string} options.memoryRoot
 * @param {() => Date} [options.now]
 * @param {string[]} [options.sessionRoots]
 * @param {object} [options.capture] injected createCapture() (tests)
 * @param {string} [options.holder]
 */
export function createHostLifecycle(options = {}) {
  const memoryRoot = path.resolve(String(options.memoryRoot ?? ''));
  if (memoryRoot === '') throw new Error('E_MEMORY_ROOT: lifecycle requires memoryRoot');
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const paths = lifecyclePaths(memoryRoot);
  const sessionRoots = Array.isArray(options.sessionRoots) ? options.sessionRoots : [];
  const holder = options.holder ?? `lifecycle-${process.pid}`;
  const capture = options.capture ?? createCapture({ memoryRoot, now, sessionRoots, holder });

  function withLease(fn) {
    fs.mkdirSync(path.dirname(paths.lock), { recursive: true });
    const lease = acquireLease(paths.lock, { holder, now });
    try {
      return fn();
    } finally {
      releaseLease(paths.lock, lease.holder);
    }
  }

  function appendLifecycleLine(line) {
    fs.mkdirSync(path.dirname(paths.lifecycleLog), { recursive: true });
    fs.appendFileSync(paths.lifecycleLog, `${JSON.stringify({ schema: LIFECYCLE_SCHEMA, ...line })}\n`, 'utf8');
  }

  function prevExitFormOf(prevBoot, prevShutdown) {
    if (prevShutdown && Number.isFinite(Number(prevShutdown.at))
      && (!prevBoot || Number(prevShutdown.at) >= Number(prevBoot.bootAt ?? 0))) return 'clean';
    if (prevBoot && Number.isInteger(prevBoot.pid) && !pidAlive(prevBoot.pid)) return 'crash';
    return 'unknown';
  }

  /**
   * Record a boot: prevExitForm + gap clocks + boot.json.
   * Returns { ok, boot, gaps, lines, journal, lifecycleEvent }.
   */
  function recordBoot(input = {}) {
    const bootAtMs = Number.isFinite(input.bootAt) ? input.bootAt : nowMs(now);
    const prevBoot = readJsonSafe(paths.boot);
    const prevShutdown = readJsonSafe(paths.shutdown);
    const prevExitForm = prevExitFormOf(prevBoot, prevShutdown);
    const gaps = computeGaps({
      memoryRoot,
      bootAtMs,
      sessionRoots,
      lifecycle: {
        prevExitForm,
        lastShutdownAtMs: Number(prevShutdown?.at) > 0 ? Number(prevShutdown.at) : undefined,
        lastActivityAtMs: Number(prevBoot?.lastActivityAt) > 0 ? Number(prevBoot.lastActivityAt) : undefined,
      },
    });
    const boot = {
      schema: LIFECYCLE_SCHEMA,
      event: 'boot',
      at: nowMs(now),
      bootAt: bootAtMs,
      pid: Number.isInteger(input.pid) ? input.pid : process.pid,
      prevExitForm,
      prevBootAt: Number(prevBoot?.bootAt) > 0 ? Number(prevBoot.bootAt) : null,
      hostVersion: input.hostVersion ?? options.hostVersion ?? null,
      pluginVersion: input.pluginVersion ?? options.pluginVersion ?? null,
      hostGap: { gapMs: gaps.hostGap.gapMs, gapText: gaps.hostGap.gapText, uncertain: gaps.hostGap.uncertain },
      memoryGap: { gapMs: gaps.memoryGap.gapMs, gapSec: gaps.memoryGap.gapSec, gapText: gaps.memoryGap.gapText, kind: gaps.memoryGap.kind },
    };
    let journal = null;
    try {
      journal = capture.captureMemoryGap({ gaps });
    } catch (error) {
      journal = { ok: false, code: 'E_GAP_CAPTURE', message: String(error?.message ?? error) };
    }
    let lifecycleEvent = null;
    try {
      lifecycleEvent = capture.captureLifecycleEvent({
        event: 'boot',
        at: boot.at,
        key: `boot:${bootAtMs}`,
        text: `prevExitForm=${prevExitForm} hostGap=${gaps.hostGap.gapText} memoryGap=${gaps.memoryGap.gapText}`,
        data: { pid: boot.pid, bootAt: bootAtMs },
      });
    } catch (error) {
      lifecycleEvent = { ok: false, code: 'E_LIFECYCLE_CAPTURE', message: String(error?.message ?? error) };
    }
    const writeResult = withLease(() => {
      appendLifecycleLine(boot);
      writeFileAtomic(paths.boot, `${JSON.stringify({
        bootAt: bootAtMs,
        pid: boot.pid,
        hostVersion: boot.hostVersion,
        pluginVersion: boot.pluginVersion,
        prevExitForm,
        lastActivityAt: boot.at,
      }, null, 2)}\n`);
      return { ok: true };
    });
    return {
      ok: true,
      boot,
      gaps,
      lines: renderGapLines(gaps),
      journal,
      lifecycleEvent,
      write: writeResult,
      bootPath: paths.boot,
      lifecycleLog: paths.lifecycleLog,
    };
  }

  /** Record a clean shutdown (exit form evidence). Best effort: never throws. */
  function recordShutdown(input = {}) {
    const at = Number.isFinite(input.at) ? input.at : nowMs(now);
    const record = { schema: LIFECYCLE_SCHEMA, event: 'shutdown', at, pid: Number.isInteger(input.pid) ? input.pid : process.pid, form: input.form ?? 'clean' };
    let written = false;
    try {
      withLease(() => {
        writeFileAtomic(paths.shutdown, `${JSON.stringify(record, null, 2)}\n`);
        appendLifecycleLine(record);
        written = true;
      });
    } catch {
      written = false;
    }
    try {
      capture.captureLifecycleEvent({ event: 'shutdown', at, key: `shutdown:${at}`, text: `form=${record.form}`, data: { pid: record.pid } });
    } catch {
      /* best effort */
    }
    return { ok: written, record, shutdownPath: paths.shutdown };
  }

  function history(input = {}) {
    const limit = Number.isInteger(input.limit) ? Math.min(Math.max(input.limit, 1), 200) : 20;
    const rows = [];
    let text = '';
    try {
      text = fs.readFileSync(paths.lifecycleLog, 'utf8');
    } catch {
      return { ok: true, items: [], total: 0 };
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* skip corrupt line */
      }
    }
    return { ok: true, items: rows.slice(-limit), total: rows.length };
  }

  return { memoryRoot, paths, recordBoot, recordShutdown, history };
}

/**
 * Host wiring entry point (called from src/index.js only when memoryV2 is on).
 * Never throws: a lifecycle failure must not block plugin loading.
 */
export function registerHostLifecycle(ctx = {}, options = {}) {
  const result = { ok: false, code: null, gaps: null, lines: [], handle: null };
  try {
    const memoryRoot = options.memoryRoot ?? options.memoryRootOf?.() ?? '';
    if (typeof memoryRoot !== 'string' || memoryRoot === '') {
      result.code = 'E_MEMORY_ROOT';
      return result;
    }
    const lifecycle = createHostLifecycle({
      memoryRoot,
      now: options.now,
      sessionRoots: Array.isArray(options.sessionRoots) ? options.sessionRoots : undefined,
      hostVersion: options.hostVersion,
      pluginVersion: options.pluginVersion,
    });
    const boot = lifecycle.recordBoot({
      bootAt: options.bootAt,
      hostVersion: options.hostVersion,
      pluginVersion: options.pluginVersion,
    });
    if (options.registerExitHook === true) {
      try {
        process.once('exit', () => {
          try {
            lifecycle.recordShutdown({ form: 'clean' });
          } catch {
            /* exit hooks must never throw */
          }
        });
      } catch {
        /* best effort */
      }
    }
    Object.assign(result, {
      ok: true,
      gaps: boot.gaps,
      lines: boot.lines,
      handle: { lifecycle, boot },
    });
    return result;
  } catch (error) {
    result.code = error?.code ?? 'E_LIFECYCLE';
    result.message = String(error?.message ?? error);
    return result;
  }
}
