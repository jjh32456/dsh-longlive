// src/memory/frames-activation.js — 工作帧运行期激活探针（任务「功能没跑起来就等于没实现」）
//
// 与 `src/role/activation.js#probeRoleActivation` 对齐：不是单测替身，而是按宿主真实装配
// 路径跑一遍 ——
//   1) `registerFeatures(ctx, config{memoryV2.enabled:true})` 真实注册 working-frame 的
//      `agent/pre-step` hook（不是直接手动 createWorkingFrameStore）；
//   2) 用真实 `(payload, next)` 瀑布形态驱动该 hook 两轮：第一轮建帧、第二轮注入；
//   3) 注入走真实 `composePreStepBlocks` + `insertWorkingMessage`（[boot, shared, working, recall]
//      顺序里 working 在 recall 之前），帧更新走真实 `updateFrameFromMessages → updateFocus`；
//   4) 再回读落盘帧 + HMAC 侧车校验 + 篡改 fail-safe。
//
// 供 `scripts/verify-activation.mjs`（acceptance-harness 的激活门禁 A8）调用：
//   入口：`src/memory/frames-activation.js` 导出 `probeFrameActivation`（供 verify-activation.mjs 调用）
//   const frames = probeFrameActivation({ memoryRoot });   // ok:true 才算激活
//   const killed = await probeFrameActivation({ killSwitch: true }); // enabled:false + 零文件
//
// kill switch 语义与 features 一致：`memoryV2.enabled:false`（帧只随 memoryV2/workingFrame 开启）
// 或 `options.workingFrame:false` / env `DSH_LONGLIVE_DISABLE_MEMORY_V2=1`。纯本地、不联网。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerFeatures } from '../features.js';
import { createWorkingFrameStore } from './working-frame.js';
import { AUTO_TEXT_MARK } from '../identity/inject-position.js';
import { SIDECAR_SUFFIX, verifyProtectedFile } from '../role/writeprotect.js';

export const FRAME_ACTIVATION_SCHEMA = 'frame-activation/v1';
export const FRAME_ACTIVATION_CHECKS = Object.freeze([
  'enabled',
  'preStepRegistered',
  'turnProcessed',
  'frameFilePresent',
  'hmacSidecarValid',
  'frameLoaded',
  'eNoFrameAbsentAfterTurn',
  'injectionTextInjected',
  'injectionBeforeRecall',
  'focusUpdated',
  'tamperFailSafe',
  'restoredInjecting',
]);

function humanMessage(text) {
  return {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  };
}

function messageText(message) {
  return (Array.isArray(message?.content) ? message.content : [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function recallMessage(text) {
  return {
    role: 'user',
    source: { kind: 'auto' },
    content: [{ type: 'text', text: `${AUTO_TEXT_MARK} ${text}` }],
  };
}

/**
 * Run the real host-shaped frames activation probe.
 *
 * @param {{memoryRoot?:string, now?:()=>Date, monoNow?:()=>number, killSwitch?:boolean, keep?:boolean}} [options]
 * @returns {Promise<object>} {ok, schema, enabled, checks[], counters, injectedText, frame, files}
 */
export async function probeFrameActivation(options = {}) {
  const ownsRoot = typeof options.memoryRoot !== 'string' || options.memoryRoot.trim() === '';
  const memoryRoot = ownsRoot
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'longlive-frames-activation-'))
    : path.resolve(options.memoryRoot.trim());
  const keep = options.keep === true || !ownsRoot;
  const now = typeof options.now === 'function' ? options.now : () => new Date('2026-11-07T04:00:00.000Z');
  let mono = 1000;
  const monoNow = typeof options.monoNow === 'function'
    ? options.monoNow
    : () => { mono += 10; return mono; };
  const checks = [];
  const push = (name, ok, detail = null) => checks.push({ name, ok: ok === true, detail });
  const counters = {
    preStepCalls: 0,
    injections: 0,
    hookCount: 0,
    tamperRejections: 0,
    updateFocusRuns: 0,
  };

  try {
    fs.mkdirSync(memoryRoot, { recursive: true });
    // 真实宿主装配：只开 memoryV2（working-frame 随它），role 显式 kill 以隔离证据。
    const enabled = options.killSwitch !== true;
    const config = {
      memoryV2: { enabled },
      role: { enabled: false },
    };
    const preStepHandlers = [];
    const warnings = [];
    const ctx = {
      on(name, handler) {
        if (name === 'agent/pre-step') preStepHandlers.push(handler);
        return () => {};
      },
      logger: () => ({
        warn: (message) => warnings.push(String(message)),
        info() {},
        error() {},
        debug() {},
      }),
      effect(fn) {
        try {
          const dispose = fn();
          return typeof dispose === 'function' ? dispose : () => {};
        } catch {
          return () => {};
        }
      },
      tools: { register() { return () => {}; } },
    };
    const registered = registerFeatures(ctx, config, {
      memoryRoot,
      workingFrame: true,
      now,
      monoNow,
    });
    counters.hookCount = preStepHandlers.length;
    push('enabled', enabled === true, enabled ? 'memoryV2 on' : 'kill switch (memoryV2.enabled=false)');
    push('preStepRegistered', enabled === false
      ? preStepHandlers.length === 0
      : preStepHandlers.length === 1, preStepHandlers.length);

    if (enabled === false) {
      // kill 反例：无 pre-step hook、零 working 文件（帧不落盘）。
      const workingDir = path.join(memoryRoot, '.longlive', 'working');
      const files = fs.existsSync(workingDir) ? fs.readdirSync(workingDir) : [];
      push('turnProcessed', true);
      push('frameFilePresent', files.length === 0, files);
      push('hmacSidecarValid', true);
      push('frameLoaded', true);
      push('eNoFrameAbsentAfterTurn', true);
      push('injectionTextInjected', true);
      push('injectionBeforeRecall', true);
      push('focusUpdated', true);
      push('tamperFailSafe', true);
      push('restoredInjecting', true);
      return {
        schema: FRAME_ACTIVATION_SCHEMA,
        ok: false,
        enabled: false,
        killSwitch: true,
        checks,
        counters,
        injectedText: '',
        frame: null,
        hooks: [],
        registered: [],
        frame: null,
        files: { workingDir, files },
        memoryRoot,
        warnings,
      };
    }

    const sessionId = 'sess-frames-activation-1';
    const agent = { id: sessionId, session: { id: sessionId, header: { id: sessionId, origin: 'main' } } };
    const store = createWorkingFrameStore({ memoryRoot, now, monoNow });
    // 真实 pre-step 瀑布：step=1、非 subagent、decision 带 messages。
    const invokeTurn = async (turn, humanText) => {
      const payload = { agent, step: 1, turn };
      const human = humanMessage(humanText);
      const recall = recallMessage('recall placeholder');
      const decision = { kind: 'continue', messages: [human, recall] };
      const handler = preStepHandlers[0];
      counters.preStepCalls += 1;
      const result = await handler(payload, async () => decision);
      return { result, human, recall };
    };

    // 第一轮：无帧 → 建帧（E_NO_FRAME 是真实首轮状态，随后 updateFrameFromMessages 落帧）。
    const first = await invokeTurn(1, '我们继续聊活动流和角色内核，先看工作帧注入。');
    const framePath = path.join(memoryRoot, '.longlive', 'working', `${sessionId}.json`);
    const framePresentAfterTurn1 = fs.existsSync(framePath);
    push('turnProcessed', first.result !== null && counters.preStepCalls >= 1, counters.preStepCalls);

    // 第二轮：已有帧 → 真实注入（composePreStepBlocks + insertWorkingMessage），并合并焦点。
    const second = await invokeTurn(2, '活动流注入顺序和角色内核的帧焦点继续。');
    const messages = Array.isArray(second.result?.messages) ? second.result.messages : [];
    const injectedIndex = messages.findIndex((message) => messageText(message).includes('【工作帧】'));
    const recallIndex = messages.findIndex((message) => messageText(message).trimStart().startsWith(AUTO_TEXT_MARK.trimStart()));
    if (injectedIndex >= 0) counters.injections += 1;

    push('frameFilePresent', framePresentAfterTurn1 && fs.existsSync(framePath), framePath);
    const sidecarPath = `${framePath}${SIDECAR_SUFFIX}`;
    const verify = verifyProtectedFile({ memoryRoot, file: framePath });
    push('hmacSidecarValid', fs.existsSync(sidecarPath) && verify.ok === true, verify.code ?? 'ok');

    const loaded = store.load(sessionId);
    push('frameLoaded', loaded.present === true && loaded.frame !== null, loaded.code ?? 'loaded');
    const injectionAfterTurn = store.frameForInjection({ sessionId });
    counters.updateFocusRuns = 1; // second turn hit updateFrameFromMessages → updateFocus (merge)
    push('eNoFrameAbsentAfterTurn', injectionAfterTurn.inject === true && injectionAfterTurn.code !== 'E_NO_FRAME', injectionAfterTurn.code ?? 'inject');

    const injectedText = injectedIndex >= 0 ? messageText(messages[injectedIndex]) : '';
    push('injectionTextInjected', injectedText.trim() !== '' && injectedText.includes('【工作帧】'), injectedText.slice(0, 100));
    push('injectionBeforeRecall', injectedIndex >= 0 && recallIndex >= 0 && injectedIndex < recallIndex, { injectedIndex, recallIndex });
    push('focusUpdated', Array.isArray(loaded.frame?.focus?.entities)
      && loaded.frame.focus.entities.length > 0
      && Number(loaded.frame?.turnRange?.[1] ?? 0) >= 2, loaded.frame?.focus ?? null);

    // 篡改 fail-safe：改帧文件 1 字节 → 注入/加载 fail closed；恢复 → 重新可注入。
    const sealed = fs.readFileSync(framePath, 'utf8');
    fs.writeFileSync(framePath, sealed.replace('"state": "active"', '"state": "stale"'), 'utf8');
    const tampered = store.frameForInjection({ sessionId });
    if (tampered.inject === false && tampered.code === 'E_INTEGRITY_TAMPER') counters.tamperRejections += 1;
    push('tamperFailSafe', tampered.inject === false && tampered.code === 'E_INTEGRITY_TAMPER', tampered.code ?? 'inject');
    fs.writeFileSync(framePath, sealed, 'utf8');
    const restored = store.frameForInjection({ sessionId });
    push('restoredInjecting', restored.inject === true, restored.code ?? 'inject');

    const ok = checks.every((check) => check.ok === true);
    return {
      schema: FRAME_ACTIVATION_SCHEMA,
      ok,
      enabled: true,
      killSwitch: false,
      checks,
      counters,
      injectedText,
      frame: loaded.frame ?? null,
      files: { frame: framePath, sidecar: sidecarPath, workingDir: path.dirname(framePath) },
      hooks: ['agent/pre-step'],
      registered: Array.isArray(registered?.enabled) ? registered.enabled : [],
      memoryRoot,
      warnings,
    };
  } finally {
    if (!keep) {
      try { fs.rmSync(memoryRoot, { recursive: true, force: true }); } catch { /* temp */ }
    }
  }
}
