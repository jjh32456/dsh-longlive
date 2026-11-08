// src/role/activation.js — 角色内核运行期激活探针（任务「功能没跑起来就等于没实现」）
//
// 这不是单测替身：它按宿主真实装配路径跑一遍 ——
//   1) Config schema 默认值（role.enabled=true）经 registerRole 注册；
//   2) 用真实 `(session, event)` 形态驱动已注册的 session/event hook（不是直接调 readers）；
//   3) 让宿主注入回调 `systemPrompt.section().text()` 真实取一次语气投影；
//   4) 然后才读回落盘数据，断言 attention/relationships/personality/channels 都有运行期证据。
//
// 供 `scripts/verify-activation.mjs`（acceptance-harness 的激活门禁）调用：
//   入口：`src/role/activation.js` 的 `probeRoleActivation`（供 verify-activation.mjs 调用）
//   const role = probeRoleActivation({ memoryRoot: <隔离目录> });
//   if (!role.ok) failure('role kernel', role);
//
// 纯本地、不联网、不碰真 memoryRoot（memoryRoot 缺省用 OS 临时目录并在结束时清理）。
// kill switch 探针：`probeRoleActivation({ killSwitch: true })` 应返回 enabled:false 且零文件。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerRole } from './index.js';
import { updateRelationship } from './relationships.js';

export const ROLE_ACTIVATION_SCHEMA = 'role-activation/v1';
export const ROLE_ACTIVATION_CHECKS = Object.freeze([
  'enabled',
  'hooksRegistered',
  'eventsSeen',
  'attentionIngested',
  'relationshipRead',
  'channelTouched',
  'personalityProjected',
  'attentionFilePresent',
  'channelsFilePresent',
  'personalityFilePresent',
  'toneSectionInjected',
  'auditFilePresent',
]);

function makeFakeHost() {
  const listeners = new Map();
  const sections = [];
  const ctx = {
    on(name, handler) {
      const list = listeners.get(name) ?? [];
      list.push(handler);
      listeners.set(name, list);
      return () => {
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    effect(fn) {
      try {
        const dispose = fn();
        return typeof dispose === 'function' ? dispose : () => {};
      } catch {
        return () => {};
      }
    },
    logger: () => ({ info() {}, warn() {}, debug() {}, error() {} }),
    systemPrompt: {
      section(spec) {
        sections.push(spec);
        return () => {};
      },
      getSectionOrder: () => 100,
    },
  };
  return {
    ctx,
    sections,
    fire(name, ...args) {
      for (const handler of [...(listeners.get(name) ?? [])]) handler(...args);
    },
    handlersOf: (name) => [...(listeners.get(name) ?? [])],
  };
}

/**
 * Run the real host-shaped activation probe.
 *
 * @param {{memoryRoot?:string, now?:()=>Date, killSwitch?:boolean, keep?:boolean, writeProfile?:boolean}} [options]
 * @returns {object} {ok, schema, enabled, checks[], counters, probe, sectionText, files, memoryRoot}
 */
export function probeRoleActivation(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => new Date('2026-11-07T04:00:00.000Z');
  const ownsRoot = typeof options.memoryRoot !== 'string' || options.memoryRoot.trim() === '';
  const memoryRoot = ownsRoot
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'longlive-role-activation-'))
    : path.resolve(options.memoryRoot.trim());
  const keep = options.keep === true || !ownsRoot;
  const checks = [];
  const push = (name, ok, detail = null) => checks.push({ name, ok: ok === true, detail });

  try {
    fs.mkdirSync(memoryRoot, { recursive: true });
    if (options.writeProfile !== false) {
      fs.writeFileSync(
        path.join(memoryRoot, 'profile.md'),
        '我们之间要有人情味，话可以长，不许骗我；决定和铁律要记住，方法流程要保留。\n',
        'utf8',
      );
    }
    // 真实数据源：宿主写一条关系等级（walk 写路径，不是 mock）。
    updateRelationship({
      memoryRoot,
      personId: 'user:jinhaiheng',
      tier: 'trusted',
      reason: '激活探针：宿主写入关系等级，用于验证运行期真实读取。',
      expectedVersion: 0,
      now,
    });

    const host = makeFakeHost();
    const config = options.killSwitch === true ? { role: { enabled: false } } : {};
    const kernel = registerRole(host.ctx, config, { memoryRoot, now });
    push('enabled', kernel.enabled === true, kernel.reason ?? null);

    if (kernel.enabled !== true) {
      // kill switch 分支：必须零 hook、零 role 新增文件（关系图是探针预写的数据源，不计入）。
      push('hooksRegistered', host.handlersOf('session/event').length === 0);
      push('eventsSeen', true);
      push('attentionIngested', true);
      push('relationshipRead', true);
      push('channelTouched', true);
      push('personalityProjected', true);
      push('attentionFilePresent', !fs.existsSync(path.join(memoryRoot, '.longlive', 'role', 'attention.jsonl')));
      push('channelsFilePresent', !fs.existsSync(path.join(memoryRoot, '.longlive', 'role', 'channels.json')));
      push('personalityFilePresent', !fs.existsSync(path.join(memoryRoot, '.longlive', 'role', 'personality.json')));
      push('toneSectionInjected', host.sections.length === 0);
      push('auditFilePresent', true);
      return {
        schema: ROLE_ACTIVATION_SCHEMA,
        ok: false,
        enabled: false,
        killSwitch: true,
        checks,
        counters: null,
        probe: null,
        sectionText: '',
        files: {},
        memoryRoot,
      };
    }

    // 真实 host 形态事件：two-arg (session, event)，带宿主身份。
    const session = {
      id: 'sess-activation-1',
      header: { id: 'sess-activation-1', userId: 'user:jinhaiheng', origin: 'main' },
    };
    host.fire('session/event', session, { type: 'user/message', data: { turn: 1 } });
    host.fire('session/event', session, { type: 'tool/result', data: { turn: 1, name: 'pwsh', message: { isError: true } } });
    host.fire('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });

    // 宿主真实取一次注入的 section 文本（执行 text()，不是只看注册表）。
    const toneSection = host.sections.find((section) => section?.name === 'role:tone') ?? null;
    const sectionText = toneSection && typeof toneSection.text === 'function' ? String(toneSection.text() ?? '') : '';

    const probe = kernel.probe();
    push('hooksRegistered', kernel.hooks.length > 0 && host.handlersOf('session/event').length === 1, kernel.hooks);
    push('eventsSeen', probe.counters.eventsSeen >= 3, probe.counters.eventsSeen);
    push('attentionIngested', probe.counters.attentionEnqueued >= 3, probe.counters.attentionEnqueued);
    push('relationshipRead', probe.counters.relationshipLookups >= 1, probe.counters.lastRelationship);
    push('channelTouched', probe.counters.channelTouches >= 1, probe.counters.channelTouches);
    push('personalityProjected', probe.counters.personalityProjections >= 1, probe.counters.personalityProjections);
    push('attentionFilePresent', probe.files.attention === true && probe.attention?.count > 0, probe.attention);
    push('channelsFilePresent', probe.files.channels === true && probe.channels?.count > 0, probe.channels);
    push('personalityFilePresent', probe.files.personality === true && probe.personality?.version >= 1, probe.personality);
    push('toneSectionInjected', toneSection !== null && sectionText.trim() !== '', sectionText.slice(0, 80));
    push('auditFilePresent', probe.files.audit === true);

    const ok = checks.every((check) => check.ok === true);
    return {
      schema: ROLE_ACTIVATION_SCHEMA,
      ok,
      enabled: true,
      killSwitch: false,
      checks,
      counters: probe.counters,
      probe,
      sectionText,
      files: probe.files,
      memoryRoot,
    };
  } finally {
    if (!keep) {
      try { fs.rmSync(memoryRoot, { recursive: true, force: true }); } catch { /* temp */ }
    }
  }
}
