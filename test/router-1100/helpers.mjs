// Shared fixtures for the 1.1.0 RouterService tests. Everything is local temp
// storage; no host, no network, no real model.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MockLlm } from '../../src/router/background/mock-llm.mjs';
import { createRouterService } from '../../src/router/service/service.mjs';

export function tempRoot(prefix = 'longlive-router-1100-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeMemory(memoryRoot, options = {}) {
  fs.mkdirSync(path.join(memoryRoot, 'handover'), { recursive: true });
  fs.mkdirSync(path.join(memoryRoot, 'topics'), { recursive: true });
  if (options.state !== false) {
    fs.writeFileSync(path.join(memoryRoot, 'STATE.md'), [
      '# STATE',
      '',
      '## 我在哪',
      options.where ?? '在写 RouterService 测试。',
      '',
      '## 在等什么',
      options.waiting ?? '等一次 tick。',
      '',
      '## 最近三件',
      options.recent ?? '- 写完了上下文组装\n- 在跑状态机测试\n- 还没写报告',
      '',
    ].join('\n'), 'utf8');
  }
  for (const [name, body] of Object.entries(options.handovers ?? {
    '2026-11-04-router.md': '# 交接卡\n\nRouterService 第 1 阶段。\n',
  })) {
    fs.writeFileSync(path.join(memoryRoot, 'handover', name), body, 'utf8');
  }
  if (options.index !== false) {
    fs.writeFileSync(path.join(memoryRoot, 'INDEX.md'), [
      '# INDEX',
      '',
      '| 主题 | 文件 |',
      '|---|---|',
      '| 测试 | topics/test.md |',
      '',
    ].join('\n'), 'utf8');
  }
  for (const [name, body] of Object.entries(options.cards ?? {
    'test.md': '# 测试卡\n\nRouterService 的本地测试。\n',
  })) {
    fs.writeFileSync(path.join(memoryRoot, 'topics', name), body, 'utf8');
  }
  return memoryRoot;
}

export function makeService(options = {}) {
  const temp = options.temp ?? tempRoot();
  const memoryRoot = options.memoryRoot ?? path.join(temp, 'memory');
  fs.mkdirSync(memoryRoot, { recursive: true });
  if (options.memory !== false) writeMemory(memoryRoot, options.memoryOptions ?? {});
  const vaultDir = options.vaultDir ?? path.join(temp, 'vault');
  const llm = options.llm === undefined ? new MockLlm(options.llmOptions ?? {}) : options.llm;
  const config = {
    enabled: true,
    provider: 'mock',
    model: 'mock-1',
    memoryRoot,
    vaultDir,
    tickMs: 60000,
    maxTokensPerRun: 50000,
    maxTokensPerDay: 150000,
    callMaxTokens: 256,
    maxAttempts: 1,
    maxConsecutiveErrors: 3,
    disposeTimeoutMs: 500,
    ...options.config,
  };
  const service = createRouterService(
    { logger: options.logger ?? (() => ({ warn: () => {}, info: () => {} })) },
    config,
    {
      llm,
      memoryRoot,
      installTimers: false,
      installListener: false,
      now: options.now,
      stability: { enabled: false, waitMs: 0, retries: 0 },
      ...options.deps,
    },
  );
  return {
    service,
    temp,
    memoryRoot,
    vaultDir,
    llm,
    config,
    cleanup: () => fs.rmSync(temp, { recursive: true, force: true }),
  };
}

export async function startedService(options = {}) {
  const env = makeService(options);
  const result = await env.service.start();
  return { ...env, result };
}

export function taskInput(id = 't1', overrides = {}) {
  return {
    id,
    type: 'question',
    payload: { question: '现在该做什么？' },
    origin: 'tool',
    depth: 0,
    ...overrides,
  };
}

export function appendTask(service, task = taskInput()) {
  return service.queue.writer.append(task);
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function auditKinds(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).kind);
}
