import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { normalizeRouterConfig, ROUTER_DEFAULTS } from '../../src/router/service/config.mjs';
import { assembleContext, CONTEXT_TIERS } from '../../src/router/service/context.mjs';
import { LIMITS, loadContextSources, parseIndexRows, readCappedFile } from '../../src/router/service/sources.mjs';
import { estimateTokens, headTailTruncate, truncateToTokens } from '../../src/router/service/tokens.mjs';
import { tempRoot, writeMemory } from './helpers.mjs';

function minimalSources(overrides = {}) {
  return {
    stateText: '## 我在哪\n在测试。\n\n## 在等什么\n等 tick。\n\n## 最近三件\n- 一件\n',
    handover: { name: '2026-11-04-router.md', text: '# 交接卡\n\n测试。\n' },
    index: { rows: [{ text: '测试 | topics/test.md' }] },
    cards: [{ name: 'test.md', text: '# 测试卡\n\n内容。' }],
    queue: { rows: [{ id: 't1', type: 'question', depth: 0, ageMs: 1000 }] },
    ledger: { runUsed: 10, runCap: 50000, dayUsed: 20, dayCap: 150000, reserved: 0 },
    warnings: [],
    now: new Date('2026-11-04T12:00:00.000Z'),
    ...overrides,
  };
}

test('config defaults are off and match DESIGN §8.1', () => {
  const cfg = normalizeRouterConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.provider, 'deepseek-official');
  assert.equal(cfg.model, 'auto');
  assert.equal(cfg.tickMs, 60000);
  assert.equal(cfg.reflectOnTurn, true);
  assert.equal(cfg.reflectCoalesceMs, 300000);
  assert.equal(cfg.autonomy, 'report');
  assert.equal(cfg.allowAgent, false);
  assert.equal(cfg.maxTokensPerRun, 80000);
  assert.equal(cfg.maxTokensPerDay, 1000000);
  assert.equal(cfg.callMaxTokens, 2048);
  assert.equal(cfg.maxAttempts, 2);
  assert.equal(cfg.maxConsecutiveErrors, 3);
  assert.equal(cfg.injectMaxPerSessionPerDay, 24);
  assert.equal(cfg.injectMaxTotalTokens, 12000);
  assert.equal(cfg.l4MergeEnabled, false);
  assert.equal(cfg.writerLeaseMs, 120000);
  assert.equal(cfg.queueMaxBytes, 65536);
  assert.equal(cfg.proposalEnabled, false);
  assert.equal(cfg.wakeEnabled, false);
  assert.equal(cfg.disposeTimeoutMs, 2000);
  assert.equal(Object.keys(ROUTER_DEFAULTS).length, 50);
  assert.deepEqual(cfg.warnings, []);
  assert.equal(ROUTER_DEFAULTS.enabled, false);
});

test('config only enables on literal true, and invalid values fall back with warnings', () => {
  assert.equal(normalizeRouterConfig({ routerEnabled: 'true' }).enabled, false);
  assert.equal(normalizeRouterConfig({ routerEnabled: 1 }).enabled, false);
  const cfg = normalizeRouterConfig({
    routerEnabled: true,
    routerTickMs: 1,
    routerMaxAttempts: 9,
    routerAutonomy: 'everything',
    routerMaxQueue: 'lots',
    routerProvider: '  mock  ',
    unknownKey: 'ignored',
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.tickMs, 60000);
  assert.equal(cfg.maxAttempts, 2);
  assert.equal(cfg.autonomy, 'report');
  assert.equal(cfg.maxQueue, undefined);
  assert.equal(cfg.provider, 'mock');
  assert.ok(cfg.warnings.includes('CONFIG_INVALID:tickMs'));
  assert.ok(cfg.warnings.includes('CONFIG_INVALID:maxAttempts'));
  assert.ok(cfg.warnings.includes('CONFIG_INVALID:autonomy'));
  assert.ok(cfg.warnings.includes('CONFIG_DEPRECATED:routerMaxQueue'));
});

test('token estimate uses §3.6 CJK/4-chars ×1.05 and truncation respects the cap', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('中文'), 3);
  assert.equal(estimateTokens('a'.repeat(4)), 2);
  const cut = truncateToTokens('中'.repeat(100), 10);
  assert.equal(cut.truncated, true);
  assert.ok(estimateTokens(cut.text) <= 10, `got ${estimateTokens(cut.text)}`);
  assert.ok(cut.text.endsWith('…'));
  const headTail = headTailTruncate('a'.repeat(1000), 100);
  assert.equal(headTail.truncated, true);
  assert.match(headTail.text, /…\[truncated \d+ chars\]…/);
});

test('full assembly stays inside 11,000 including reserves and keeps all parts', () => {
  const result = assembleContext({ tier: 'full', task: { id: 't1', type: 'question', payload: { question: 'hi' } }, sources: minimalSources() });
  assert.equal(result.ok, true);
  assert.equal(result.tier, 'full');
  assert.ok(result.totalTokens <= CONTEXT_TIERS.full.budget);
  assert.equal(result.outputReserve, 1000);
  assert.equal(result.safety, 1000);
  assert.ok(result.parts.system.includes('后台路由器'));
  assert.ok(result.parts.openCard.includes('▍我在哪'));
  assert.match(result.messages.prompt, /【队列】/);
  assert.match(result.messages.prompt, /【预算】/);
});

test('reflect assembly excludes INDEX and topic cards and stays inside 2,000', () => {
  const result = assembleContext({ tier: 'reflect', task: { id: 't1', type: 'question', payload: { question: 'hi' } }, sources: minimalSources() });
  assert.equal(result.ok, true);
  assert.equal(result.tier, 'reflect');
  assert.ok(result.totalTokens <= CONTEXT_TIERS.reflect.budget);
  assert.equal(result.parts.index, undefined);
  assert.equal(Object.keys(result.parts).some((key) => key.startsWith('card:')), false);
});

test('trim order starts with least-relevant topic card, then queue, then task', () => {
  const longCjk = '测'.repeat(20000);
  const sources = minimalSources({
    stateText: `## 我在哪\n${longCjk}\n\n## 在等什么\n等。\n\n## 最近三件\n- 一\n`,
    cards: [
      { name: 'a.md', text: `# A\n${'甲'.repeat(4000)}` },
      { name: 'b.md', text: `# B\n${'乙'.repeat(4000)}` },
    ],
    queue: {
      rows: Array.from({ length: 8 }, (_, i) => ({ id: `q${i}`, type: 'question', depth: 0, ageMs: 1000 * i })),
    },
    index: { rows: Array.from({ length: 12 }, (_, i) => ({ text: `行${i} | topics/t${i}.md` })) },
  });
  const result = assembleContext({
    tier: 'full',
    task: { id: 'big', type: 'question', payload: { question: '问'.repeat(5000) } },
    sources,
  });
  assert.equal(result.ok, true);
  assert.ok(result.dropped.length > 0);
  assert.equal(result.dropped[0], 'card:b.md');
  assert.ok(result.totalTokens <= 11000);
});

test('over-budget input reports E_CONTEXT_OVER_BUDGET and can degrade from full only', () => {
  const huge = minimalSources({
    stateText: `## 我在哪\n${'测'.repeat(50000)}\n\n## 在等什么\n等。\n\n## 最近三件\n- 一\n`,
    cards: [
      { name: 'a.md', text: '甲'.repeat(1200) },
      { name: 'b.md', text: '乙'.repeat(1200) },
    ],
  });
  const full = assembleContext({ tier: 'full', task: { id: 't', payload: { question: '问'.repeat(100000) } }, sources: huge });
  // Huge cards/queue/index are trimmed; if it still does not fit the contract is
  // a fail-closed E_CONTEXT_OVER_BUDGET with canDegrade=true, never a forced fit.
  if (full.ok) {
    assert.ok(full.totalTokens <= 11000);
  } else {
    assert.equal(full.code, 'E_CONTEXT_OVER_BUDGET');
    assert.equal(full.canDegrade, true);
    assert.equal(full.degradeTo, 'reflect');
    assert.ok(full.dropped.length > 0);
  }
});

test('parseIndexRows reads the first markdown table and trims cells to 80 chars', () => {
  const rows = parseIndexRows([
    '# INDEX',
    '| 主题 | 文件 |',
    '|---|---|',
    `| ${'长'.repeat(120)} | topics/a.md |`,
    '| 第二 | topics/b.md |',
  ].join('\n'));
  assert.equal(rows.length, 2);
  assert.equal(Array.from(rows[0].text).length, 80);
  assert.equal(rows[1].cells[1], 'topics/b.md');
});

test('readCappedFile never reads more than maxBytes and reports truncation', async () => {
  const temp = tempRoot();
  try {
    const file = path.join(temp, 'big.txt');
    fs.writeFileSync(file, 'a'.repeat(100000));
    const read = await readCappedFile(file, { maxBytes: 1024, stability: false });
    assert.equal(read.ok, true);
    assert.equal(read.truncated, true);
    assert.equal(Buffer.byteLength(read.text, 'utf8'), 1024);
    assert.equal(read.bytes, 100000);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('loadContextSources reads only STATE/handover/INDEX/topics and never journal or flow', async () => {
  const temp = tempRoot();
  try {
    const memoryRoot = path.join(temp, 'memory');
    writeMemory(memoryRoot);
    fs.mkdirSync(path.join(memoryRoot, 'journal'), { recursive: true });
    fs.writeFileSync(path.join(memoryRoot, 'journal', '2026-11.md'), '# journal\nSHOULD NOT BE READ\n');
    fs.mkdirSync(path.join(memoryRoot, 'flow'), { recursive: true });
    fs.writeFileSync(path.join(memoryRoot, 'flow', 'current.md'), '# flow\nSHOULD NOT BE READ\n');
    const sources = await loadContextSources({
      memoryRoot,
      task: { type: 'question', payload: { question: '测试' } },
      now: new Date('2026-11-04T12:00:00.000Z'),
      stability: { enabled: false },
    });
    assert.equal(sources.stateFound, true);
    assert.ok(Array.isArray(sources.cards));
    assert.equal(sources.cards.length <= LIMITS.cardsKeep, true);
    const serialized = JSON.stringify(sources);
    assert.equal(serialized.includes('SHOULD NOT BE READ'), false);
    assert.equal(serialized.includes('journal'), false);
    assert.equal(serialized.includes('flow/current'), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
