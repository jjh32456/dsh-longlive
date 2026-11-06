/**
 * 自测：node --test test/
 * 只用内联卡做断言，不依赖 X:\memory-store（真实卡的集成断言会 detect 到 H: 时补跑）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DEFAULTS,
  PRIVACY_HIDDEN_MARK,
  buildQueryText,
  buildUnits,
  chooseRecall,
  clipToTokens,
  containment,
  defaultPrivacyScan,
  estimateTokens,
  phraseWeight,
  pickExcerpt,
  renderInjection,
  scoreCard,
} from '../src/recall/recall-core.mjs';
import { privacyGateStatus, privacyScan } from '../src/recall/privacy.mjs';
import {
  cardPathsInMessage,
  identityInjectedPaths,
  isRealUserMessage,
  mergeInjectionOrder,
} from '../src/recall/inject-order.mjs';

const CARD_A = {
  path: 'topics/a.md',
  title: 'A 卡',
  scopeIn: ['沙箱', '0xC0000142', 'pwsh'],
  aliases: ['工具链与沙箱'],
  body: [
    '# A 卡',
    '',
    '## 入口',
    '- **pwsh**：沙箱模式下进程起不来（0xC0000142），shell 调用需要 danger-full-access。',
    '- 另一条无关的话：今天的天气不错。',
    '',
    '## 隐私段',
    '- 本人男 32 岁。**⚠ 隐私：这两行不外传。**',
  ].join('\n'),
};

const CARD_B = {
  path: 'topics/b.md',
  title: 'B 卡',
  scopeIn: ['LUFS', '响度'],
  aliases: ['耳朵'],
  body: ['# B 卡', '- 响度 -15.24 LUFS / +0.22 dBTP 超标。'].join('\n'),
};

const CARD_LOCAL = {
  path: 'topics/secret.md',
  title: '只在本地',
  scopeIn: ['沙箱'],
  localOnly: true,
  body: '- 沙箱相关但不能外发。',
};

test('phraseWeight 与 e1 一致', () => {
  assert.equal(phraseWeight('ab'), 1);
  assert.equal(phraseWeight('abcd'), 1.5);
  assert.equal(phraseWeight('abcdef'), 2);
  assert.equal(phraseWeight('abcdefgh'), 2.5);
  assert.equal(phraseWeight('abcdefghijkl'), 2.5);
});

test('没命中就什么都不注入', () => {
  const r = chooseRecall({ queryText: '今天晚饭吃什么', cards: [CARD_A, CARD_B], budget: 1200 });
  assert.deepEqual(r.items, []);
  assert.equal(r.tokens, 0);
  assert.equal(r.hits.eligible, 0);
  assert.equal(renderInjection(r), '');
});

test('空查询 / 空卡表不报错', () => {
  assert.deepEqual(chooseRecall({ queryText: '', cards: [CARD_A] }).items, []);
  assert.deepEqual(chooseRecall({ queryText: '沙箱', cards: [] }).items, []);
  assert.deepEqual(chooseRecall().items, []);
});

test('命中后只给标题与摘要，摘要里保留命中的那一块', () => {
  const r = chooseRecall({ queryText: 'pwsh 沙箱 0xC0000142', cards: [CARD_A, CARD_B], budget: 1200 });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].path, 'topics/a.md');
  assert.match(r.items[0].excerpt, /0xC0000142/);
  assert.doesNotMatch(r.items[0].excerpt, /天气/); // 无关块不该抢预算
  assert.ok(r.tokens > 0);
});

test('隐私块整块剔除，local_only 整卡跳过', () => {
  const r = chooseRecall({ queryText: '沙箱 0xC0000142', cards: [CARD_A], budget: 1200 });
  const text = renderInjection(r);
  assert.doesNotMatch(text, /32 岁|不外传|隐私/);

  const lr = chooseRecall({ queryText: '沙箱', cards: [CARD_LOCAL], budget: 1200 });
  assert.deepEqual(lr.items, []);
  assert.equal(lr.hits.droppedLocalOnly, 1);
});

test('预算硬约束：token 不超 budget，且预算越小摘要越短', () => {
  const q = 'pwsh 沙箱 0xC0000142 LUFS 响度 耳朵';
  const big = chooseRecall({ queryText: q, cards: [CARD_A, CARD_B], budget: 400 });
  const small = chooseRecall({ queryText: q, cards: [CARD_A, CARD_B], budget: 120 });
  assert.ok(big.tokens <= 400, `big.tokens=${big.tokens}`);
  assert.ok(small.tokens <= 120, `small.tokens=${small.tokens}`);
  assert.ok(small.tokens <= big.tokens);
  assert.equal(small.items.length, 1, '预算只够一张卡时不硬塞第二张');
});

test('maxItems 生效', () => {
  const r = chooseRecall({ queryText: '沙箱 pwsh LUFS 响度', cards: [CARD_A, CARD_B], budget: 1200, options: { maxItems: 1 } });
  assert.equal(r.items.length, 1);
});

test('渲染后的 token 一定不超预算（含标题/路径/相关度元数据）', () => {
  for (const budget of [60, 120, 200, 400, 900]) {
    const r = chooseRecall({
      queryText: 'pwsh 沙箱 0xC0000142 LUFS 响度 耳朵',
      cards: [CARD_A, CARD_B],
      budget,
    });
    assert.ok(r.tokens <= budget, `budget=${budget} tokens=${r.tokens}`);
    assert.equal(r.tokens, estimateTokens(renderInjection(r)));
  }
});

test('去重：已注入过的路径 / 已注入过的同文摘要都不再注入', () => {
  const seen = chooseRecall({
    queryText: 'pwsh 沙箱 0xC0000142',
    cards: [CARD_A],
    budget: 1200,
    seenPaths: ['topics\\a.md'],
  });
  assert.deepEqual(seen.items, []);
  assert.equal(seen.hits.droppedBySeen, 1);

  const first = chooseRecall({ queryText: 'pwsh 沙箱 0xC0000142', cards: [CARD_A], budget: 1200 });
  const second = chooseRecall({
    queryText: 'pwsh 沙箱 0xC0000142',
    cards: [CARD_A],
    budget: 1200,
    injectedTexts: [renderInjection(first)],
  });
  assert.deepEqual(second.items, []);
  assert.equal(second.hits.droppedByDedupe, 1);
});

test('containment 是「候选被已注入文本覆盖的比例」', () => {
  assert.equal(containment('沙箱模式下进程起不来', '废话废话废话废话'), 0);
  assert.ok(containment('沙箱模式下进程起不来', '沙箱模式下进程起不来，需要 danger-full-access 才行') > 0.9);
});

test('排序：分数高者在前，同分按路径稳定排序', () => {
  const r = chooseRecall({ queryText: '沙箱 pwsh LUFS', cards: [CARD_B, CARD_A], budget: 1200 });
  assert.deepEqual(r.items.map((i) => i.path), ['topics/a.md', 'topics/b.md']);
  const again = chooseRecall({ queryText: '沙箱 pwsh LUFS', cards: [CARD_B, CARD_A], budget: 1200 });
  assert.deepEqual(again.items, r.items, '同样输入必须同样输出');
});

test('buildQueryText：首条 + 最近 2 条 + cwd，且总长受限', () => {
  const q = buildQueryText({
    firstUserText: '第一句',
    recentTexts: ['一', '二', '三'],
    cwd: 'C:\\work\\x',
    maxRecent: 2,
    maxChars: 200,
  });
  assert.match(q, /第一句/);
  assert.match(q, /三/);
  assert.doesNotMatch(q, /【最近第 1 条】一/);
  assert.match(q, /C:\\work\\x/);
  assert.ok(q.length <= 200);

  const capped = buildQueryText({ firstUserText: 'x'.repeat(5000), maxChars: 300 });
  assert.ok(capped.length <= 300);
});

test('estimateTokens 是上界口径、单调不降', () => {
  assert.ok(estimateTokens('中文四字') >= 4);
  assert.ok(estimateTokens('abcdefgh') >= 2);
  assert.ok(estimateTokens('中文四字 and more') >= estimateTokens('中文四字'));
  assert.equal(estimateTokens(''), 0);
});

test('clipToTokens 只裁不扩', () => {
  const s = '一二三四五六七八九十'.repeat(20);
  const clipped = clipToTokens(s, 30);
  assert.ok(estimateTokens(clipped) <= 30);
  assert.ok(clipped.endsWith('…'));
  assert.equal(clipToTokens('短句', 100), '短句');
});

test('buildUnits 丢掉标题与分隔线，保留 bullet 与续行', () => {
  const units = buildUnits('# T\n\n## S\n- a\n  续行\n---\n- b\n');
  assert.ok(units.every((u) => !u.text.startsWith('#')));
  assert.equal(units.length, 2);
  assert.match(units[0].text, /续行/);
});

test('pickExcerpt 永不返回空串（长块也会被裁进预算）', () => {
  const card = { path: 'x', title: 'x', body: '- ' + '很长的句子'.repeat(200) };
  const ex = pickExcerpt(card, [], 40);
  assert.ok(ex.length > 0);
  assert.ok(estimateTokens(ex) <= 40);
});

test('默认预算在设计的 800–2000 区间', () => {
  assert.ok(DEFAULTS.budgetTokens >= 800 && DEFAULTS.budgetTokens <= 2000);
});

test('scoreCard 只做字面包含（不做同义词）', () => {
  const hit = scoreCard('沙箱里起不来', CARD_A);
  assert.equal(hit.hitCount, 1);
  const miss = scoreCard('容器里起不来', CARD_A);
  assert.equal(miss.hitCount, 0);
});

/* 真实卡集成断言：只在 H 盘存在时跑（CI/别的机器上跳过） */
const REAL = 'X:/memory-store/topics';
test('真实 people.md 的隐私两行不会进摘要', { skip: !fs.existsSync(REAL) }, async () => {
  const { loadCards } = await import('../src/recall/cards.mjs');
  const cards = loadCards('X:/memory-store');
  const q = '他是我主人 鲸鲸 大肥鱼 伙伴 他说';
  const r = chooseRecall({ queryText: q, cards, budget: 1200 });
  const text = renderInjection(r);
  assert.doesNotMatch(text, /32 岁|湖北|不外传/);
  assert.ok(r.tokens <= 1200);
});

test('真实卡里 local_only 若有则一张都不注入', { skip: !fs.existsSync(REAL) }, async () => {
  const { loadCards } = await import('../src/recall/cards.mjs');
  const cards = loadCards('X:/memory-store');
  const locals = cards.filter((c) => c.localOnly);
  const r = chooseRecall({ queryText: cards.map((c) => [...c.scopeIn, ...c.aliases].join(' ')).join(' '), cards, budget: 1200 });
  for (const c of locals) assert.ok(!r.items.some((i) => i.path === c.path));
});

/* ================================================================== *
 * mustFix #2：插入顺序（顺序 B 也不能重复注入开机卡）
 * ================================================================== */

const BOOT_TEXT = [
  '【开机卡】上次停在 auto-recall 的隐私门。',
  '完整交接：X:\\memory-store\\handover\\2026-11-01-x.md',
].join('\n');

/* 旧版越界 source.kind 的兼容夹具：生产代码已不再写这些 kind，
   仅用于验证历史消息仍能被识别 / 合并（新契约见 integration-pre-step）。 */
function legacyBootMessage(text = BOOT_TEXT, source = {}) {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin:dsh-identity-router',
      form: 'snapshot',
      sections: [{ name: 'identity-router.open-card', text }],
      ...source,
    },
  };
}

function legacyAutoMessage(text = '【自动想起】x') {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin:dsh-auto-recall', form: 'snapshot', sections: [{ name: 'auto-recall.cards', text }] },
  };
}

test('顺序：auto-recall 消息排在开机卡之后，重复合并只剩一条', () => {
  const boot = legacyBootMessage();
  const once = mergeInjectionOrder([boot], legacyAutoMessage('auto-1'));
  assert.deepEqual(once.map((m) => m.source.kind), ['plugin:dsh-identity-router', 'plugin:dsh-auto-recall']);

  // 顺序 B 的极端形态：auto 先注入过一条，identity 后跑又在末尾追加了开机卡。
  const orderB = [legacyAutoMessage('auto-1'), boot];
  const fixed = mergeInjectionOrder(orderB, legacyAutoMessage('auto-2'));
  assert.equal(fixed.filter((m) => m.source.kind === 'plugin:dsh-auto-recall').length, 1);
  assert.equal(fixed[0].source.kind, 'plugin:dsh-identity-router', '开机卡必须在前');
  assert.equal(fixed[1].source.kind, 'plugin:dsh-auto-recall');
  assert.equal(fixed.length, 2);

  // 幂等：同一消息 merge 两次，长度不变。
  assert.equal(mergeInjectionOrder(fixed, fixed[1]).length, 2);
});

test('顺序：没有开机卡时追加到末尾，不插到用户消息前面', () => {
  const userMsg = { role: 'user', content: [{ type: 'text', text: '你好' }] };
  const out = mergeInjectionOrder([userMsg], legacyAutoMessage());
  assert.deepEqual(out.map((m) => m.role), ['user', 'user']);
  assert.equal(out[1].source.kind, 'plugin:dsh-auto-recall');
});

test('firstUserText 口径：isRealUserMessage 排除注入消息与 runtime-context', () => {
  const userMsg = { role: 'user', content: [{ type: 'text', text: '真实提问' }], source: { kind: 'user' } };
  assert.equal(isRealUserMessage(userMsg), true);

  // v4 注入契约：kind=session-reference（隐藏上下文），不是用户的话。
  const injectedRef = {
    role: 'user',
    content: [{ type: 'text', text: BOOT_TEXT }],
    source: { kind: 'session-reference', form: 'recall', version: 1, references: [] },
  };
  assert.equal(isRealUserMessage(injectedRef), false);
  // 历史消息 / 外部注入：kind='user' + 正文标记同样排除。
  const injectedBoot = { role: 'user', content: [{ type: 'text', text: BOOT_TEXT }], source: { kind: 'user' } };
  assert.equal(isRealUserMessage(injectedBoot), false);
  const injectedAuto = { role: 'user', content: [{ type: 'text', text: '【自动想起】x' }], source: { kind: 'user' } };
  assert.equal(isRealUserMessage(injectedAuto), false);

  // 旧版 plugin:* kind 同样排除。
  assert.equal(isRealUserMessage(legacyBootMessage()), false);
  // runtime-context 是宿主上下文，不是用户输入。
  assert.equal(isRealUserMessage({ role: 'user', content: [{ type: 'text', text: 'runtime' }], source: { kind: 'runtime-context' } }), false);
  // assistant / tool 消息一律不算。
  assert.equal(isRealUserMessage({ role: 'assistant', content: [{ type: 'text', text: '回答' }] }), false);
});

test('路径级排除：开机卡里出现的 handover 路径进 seenPaths，同一张卡不再注入', () => {
  const card = {
    path: 'handover/2026-11-01-x.md',
    dir: 'handover',
    title: '接手卡',
    scopeIn: ['沙箱'],
    aliases: [],
    body: '- 沙箱备忘：auto-recall 的门已经接好。',
  };
  const boot = legacyBootMessage();
  const paths = identityInjectedPaths([boot], { cards: [card] });
  assert.deepEqual(paths, ['handover/2026-11-01-x.md']);

  const without = chooseRecall({ queryText: '沙箱', cards: [card], budget: 1200 });
  assert.equal(without.items.length, 1, '不排除时本来会注入');
  const withSeen = chooseRecall({ queryText: '沙箱', cards: [card], budget: 1200, seenPaths: paths });
  assert.deepEqual(withSeen.items, []);
  assert.equal(withSeen.hits.droppedBySeen, 1);
});

test('路径级排除三级来源：source.cardPaths / 正文路径 / 交接卡标题', () => {
  const cards = [
    { path: 'handover/2026-11-01-y.md', dir: 'handover', title: '接手卡标题够长', scopeIn: [], body: '' },
    { path: 'topics/t.md', dir: 'topics', title: '普通卡', scopeIn: [], body: '' },
  ];
  const declared = legacyBootMessage('没有路径', { cardPaths: ['handover/2026-11-01-y.md'] });
  assert.deepEqual(cardPathsInMessage(declared, { cards }), ['handover/2026-11-01-y.md']);

  const inText = legacyBootMessage('见 X:\\memory-store\\topics\\t.md 与 topics/t.md');
  assert.deepEqual(cardPathsInMessage(inText, { cards }), ['topics/t.md']);

  const byTitle = legacyBootMessage('这次的开机卡取自《接手卡标题够长》，没有写路径。');
  assert.deepEqual(cardPathsInMessage(byTitle, { cards }), ['handover/2026-11-01-y.md']);
});

/* ================================================================== *
 * mustFix #4：隐私门（PII 未标 local_only 也不能漏）
 * ================================================================== */

const CARD_PII = {
  path: 'topics/pii.md',
  title: '客户资料',
  scopeIn: ['客户资料'],
  aliases: [],
  body: '- 客户资料正文：联系人手机 13700002222，邮箱 client@example.com，按常规口径保存。',
};

test('隐私门：正文里的手机号/邮箱即使没标 local_only 也不注入', () => {
  const r = chooseRecall({ queryText: '客户资料', cards: [CARD_PII], budget: 1200 });
  assert.deepEqual(r.items, []);
  assert.equal(r.hits.droppedByPrivacy, 1);
  assert.doesNotMatch(renderInjection(r), /13700002222|client@example\.com/);
});

test('隐私门：privacyPolicy=title 时只留标题 + [已隐藏]', () => {
  const r = chooseRecall({
    queryText: '客户资料',
    cards: [CARD_PII],
    budget: 1200,
    options: { privacyPolicy: 'title' },
  });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].excerpt, PRIVACY_HIDDEN_MARK);
  assert.equal(r.items[0].privacyRedacted, true);
  assert.equal(r.hits.redactedByPrivacy, 1);
  const text = renderInjection(r);
  assert.match(text, /\[已隐藏\]/);
  assert.doesNotMatch(text, /13700002222|client@example\.com/);
});

test('隐私门：扫描器抛错按命中处理（fail-closed）', () => {
  const r = chooseRecall({
    queryText: '客户资料',
    cards: [CARD_PII],
    budget: 1200,
    options: { privacyScan: () => { throw new Error('gate down'); } },
  });
  assert.deepEqual(r.items, []);
  assert.equal(r.hits.droppedByPrivacy, 1);
});

test('隐私门：真实 privacy-gate 的 scanPrivacy 能识别手机号与邮箱', () => {
  const s = privacyGateStatus;
  assert.equal(typeof s, 'object');
  assert.equal(typeof s.loaded, 'boolean');
  if (s.loaded) assert.match(String(s.from), /privacy-gate/);
  const hit = privacyScan('联系 13700002222 或 client@example.com');
  assert.equal(hit.verdict, 'local_only');
  assert.ok(hit.spans.length >= 2);
  assert.equal(privacyScan('node --test test/auto-recall.test.mjs').verdict, 'none');
  // defaultPrivacyScan 是同一口径的兜底
  assert.equal(defaultPrivacyScan('13700002222').verdict, 'local_only');
  assert.equal(defaultPrivacyScan('第 137 行 2026-11-04').verdict, 'none');
});

const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/privacy-memory', import.meta.url));
test('隐私门：合成夹具 pii-unmarked.md 被拦住、secret-local-only.md 整卡跳过', { skip: !fs.existsSync(FIXTURE_ROOT) }, async () => {
  const { loadCards } = await import('../src/recall/cards.mjs');
  const cards = loadCards(FIXTURE_ROOT);
  const r = chooseRecall({ queryText: '客户资料 保密配方 秘密配方', cards, budget: 1200, options: { privacyScan } });
  const text = renderInjection(r);
  assert.doesNotMatch(text, /13700002222|client@example\.com/);
  assert.ok(r.hits.droppedByPrivacy >= 1, 'pii-unmarked 必须被隐私门拦下');
  assert.ok(r.hits.droppedLocalOnly >= 1, 'secret-local-only 必须整卡跳过');
  assert.ok(!r.items.some((i) => i.path.endsWith('secret-local-only.md')));
});

test('隐私门：真实 13 卡回归 0 泄漏', { skip: !fs.existsSync(REAL) }, async () => {
  const { loadCards } = await import('../src/recall/cards.mjs');
  const cards = loadCards('X:/memory-store');
  const query = cards.map((c) => [...c.scopeIn, ...c.aliases].join(' ')).join(' ');
  for (const budget of [1200, 100000]) {
    const r = chooseRecall({ queryText: query, cards, budget, options: { privacyScan } });
    const text = renderInjection(r);
    assert.equal(defaultPrivacyScan(text).verdict, 'none', `budget=${budget} 渲染文本里出现 PII`);
    assert.doesNotMatch(text, /(?<!\d)1[3-9]\d{9}(?!\d)|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  }
});

/* ================================================================== *
 * mustFix #8：文本级去重只防字面重复（不夸大成语义去重）
 * ================================================================== */

test('去重只防字面：换个说法（低 bigram 重合）仍会注入', () => {
  const first = chooseRecall({ queryText: 'pwsh 沙箱 0xC0000142', cards: [CARD_A], budget: 1200 });
  const excerpt = first.items[0].excerpt;
  const paraphrase = '工具链上 pwsh 进程起不来，需要放开权限。';
  assert.ok(containment(excerpt, paraphrase) < DEFAULTS.dedupeContainment);
  const second = chooseRecall({
    queryText: 'pwsh 沙箱 0xC0000142',
    cards: [CARD_A],
    budget: 1200,
    injectedTexts: [paraphrase],
  });
  assert.equal(second.items.length, 1, '语义同义但字面不同 → 去重不生效（已知局限）');
});

test('去重只防字面：整段被已注入文本包住时才会丢', () => {
  const first = chooseRecall({ queryText: 'pwsh 沙箱 0xC0000142', cards: [CARD_A], budget: 1200 });
  const dup = chooseRecall({
    queryText: 'pwsh 沙箱 0xC0000142',
    cards: [CARD_A],
    budget: 1200,
    injectedTexts: [`开场白\n${renderInjection(first)}\n结束语`],
  });
  assert.deepEqual(dup.items, []);
  assert.equal(dup.hits.droppedByDedupe, 1);
});
