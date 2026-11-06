/**
 * A3/A4 自测：向量索引（tokenizer / 增量缓存 / 融合打分）与 autoRecall 的
 * recall-log 记账。只依赖临时目录与测试 embedder，不加载真模型、不碰 profile。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EMBEDDING_VERSION,
  buildVectorIndex,
  cardChunkTexts,
  createEmbeddingRuntime,
  loadTokenizer,
  normalizeEmbeddingConfig,
} from '../src/recall/embedding.mjs';
import { chooseRecall } from '../src/recall/recall-core.mjs';
import { apply as applyAutoRecall } from '../src/recall/index.js';
import { normalizeFeatureConfig } from '../src/features.js';
import { PreStepBus, makeUserMessageFactory, textMessage } from './fixtures/pre-step-container.mjs';

function tmpRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'longlive-embed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeFile(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function makeEmbedder({ fingerprint = 'test-fp', vector = [1, 0], dim = 2 } = {}) {
  const docTexts = [];
  const embedDocument = async (text) => {
    docTexts.push(text);
    return Float32Array.from(vector);
  };
  return {
    dim,
    modelFingerprint: fingerprint,
    docTexts,
    embedQuery: async () => Float32Array.from(vector),
    embedDocument,
    embedMany: async (texts) => Promise.all(texts.map((text) => embedDocument(text))),
  };
}

function makeCtx(bus) {
  const warns = [];
  return {
    warns,
    ctx: {
      on: bus.on.bind(bus),
      logger: {
        warn: (...args) => warns.push(args.join(' ')),
        info: () => {},
      },
    },
  };
}

test('embedding 默认关闭，权重/阈值/缓存目录可配置', () => {
  const config = normalizeEmbeddingConfig({}, { memoryRoot: 'X:/mem' });
  assert.equal(config.enabled, false);
  assert.equal(config.keywordWeight, 0.6);
  assert.equal(config.vectorWeight, 0.4);
  assert.equal(config.semanticAdmit, 0.55);
  assert.equal(config.minFusedScore, 0.2);
  assert.equal(config.maxSeqLen, 256);
  assert.equal(config.cacheDir, path.join('X:/mem', '.longlive', 'embeddings'));

  const custom = normalizeEmbeddingConfig(
    { enabled: true, keywordWeight: 0.7, vectorWeight: 0.3, semanticAdmit: 0.6 },
    { memoryRoot: 'X:/mem' },
  );
  assert.equal(custom.enabled, true);
  assert.equal(custom.keywordWeight, 0.7);
  assert.equal(custom.vectorWeight, 0.3);
  assert.equal(custom.semanticAdmit, 0.6);
});

test('autoRecall 注入预算硬上限 2000 token（A4）', () => {
  const normalized = normalizeFeatureConfig({ autoRecall: { enabled: true, budgetTokens: 50000 } });
  assert.equal(normalized.autoRecall.budgetTokens, 2000);
  const small = normalizeFeatureConfig({ autoRecall: { enabled: true, budgetTokens: 400 } });
  assert.equal(small.autoRecall.budgetTokens, 400);
});

test('tokenizer.json 自解析：中文单字 + 英文 WordPiece + maxLen 截断', (t) => {
  const root = tmpRoot(t);
  const vocab = {
    '[PAD]': 0,
    '[UNK]': 1,
    '[CLS]': 2,
    '[SEP]': 3,
    '[MASK]': 4,
    你: 5,
    好: 6,
    play: 7,
    '##ing': 8,
    世: 9,
    界: 10,
  };
  const file = writeFile(root, 'tokenizer.json', JSON.stringify({
    normalizer: { type: 'BertNormalizer', clean_text: true, handle_chinese_chars: true, lowercase: false },
    pre_tokenizer: { type: 'BertPreTokenizer' },
    model: { type: 'WordPiece', unk_token: '[UNK]', continuing_subword_prefix: '##', max_input_chars_per_word: 100, vocab },
    added_tokens: [
      { id: 0, content: '[PAD]' },
      { id: 1, content: '[UNK]' },
      { id: 2, content: '[CLS]' },
      { id: 3, content: '[SEP]' },
      { id: 4, content: '[MASK]' },
    ],
  }));
  const tokenizer = loadTokenizer(file);
  assert.equal(tokenizer.vocabSize, 11);
  assert.deepEqual(tokenizer.encode('你好 playing'), [2, 5, 6, 7, 8, 3]);
  assert.deepEqual(tokenizer.encode('你好 playing', { maxLen: 4 }), [2, 5, 6, 3]);
  assert.deepEqual(tokenizer.tokensOf('playing'), ['play', '##ing']);
  assert.equal(tokenizer.decode([2, 5, 6, 3]), '[CLS] 你 好 [SEP]');
});

test('向量缓存按卡增量：未改复用、改一张只重算一张、指纹变全量', async (t) => {
  const root = tmpRoot(t);
  const cachePath = path.join(root, 'index.json');
  const config = normalizeEmbeddingConfig({}, { memoryRoot: root });
  const cards = [
    { path: 'topics/a.md', title: 'A', scopeIn: ['甲'], aliases: [], body: '甲卡的正文。' },
    { path: 'topics/b.md', title: 'B', scopeIn: ['乙'], aliases: [], body: '乙卡的正文。' },
  ];
  const embedder = makeEmbedder();

  const first = await buildVectorIndex({ cards, config, embedder, cachePath });
  assert.equal(first.stats.embeddedCards, 2);
  assert.equal(first.stats.reusedCards, 0);
  assert.equal(first.stats.written, true);
  assert.equal(first.cardVectors.get('topics/a.md')[0].length, 2);
  assert.equal(fs.existsSync(cachePath), true);
  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.equal(cache.version, EMBEDDING_VERSION);
  assert.equal(cache.modelFingerprint, 'test-fp');
  assert.deepEqual(Object.keys(cache.cards).sort(), ['topics/a.md', 'topics/b.md']);

  const second = await buildVectorIndex({ cards, config, embedder, cachePath });
  assert.equal(second.stats.embeddedCards, 0);
  assert.equal(second.stats.reusedCards, 2);

  cards[1] = { ...cards[1], body: '乙卡的正文改了。' };
  const third = await buildVectorIndex({ cards, config, embedder, cachePath });
  assert.equal(third.stats.embeddedCards, 1);
  assert.equal(third.stats.reusedCards, 1);
  assert.equal(embedder.docTexts.filter((text) => text.includes('乙卡')).length, 2);

  const other = makeEmbedder({ fingerprint: 'test-fp-2' });
  const fourth = await buildVectorIndex({ cards, config, embedder: other, cachePath });
  assert.equal(fourth.stats.embeddedCards, 2);
  assert.equal(fourth.stats.reusedCards, 0);
});

test('融合打分：关键词+向量、纯语义准入、静默不误召、权重可调', () => {
  const cards = [
    { path: 'topics/a.md', title: '沙箱卡', scopeIn: ['沙箱', 'pwsh'], aliases: [], body: '沙箱里 pwsh 起不来。' },
    { path: 'topics/b.md', title: '语义卡', scopeIn: ['量子纠缠'], aliases: [], body: '只靠语义进来的卡。' },
  ];
  const queryText = '沙箱 pwsh 起不来怎么办';
  const queryVector = Float32Array.from([1, 0]);
  const vectors = new Map([
    ['topics/a.md', [Float32Array.from([1, 0])]],
    ['topics/b.md', [Float32Array.from([0.9, 0.1])]],
  ]);

  const fused = chooseRecall({
    queryText, cards, queryVector, vectors, budget: 1200,
    options: { maxItems: 3, trace: true },
  });
  assert.equal(fused.items.length, 2);
  assert.equal(fused.items[0].path, 'topics/a.md');
  assert.equal(fused.items[0].reason, 'keyword+vector');
  assert.equal(fused.items[1].path, 'topics/b.md');
  assert.equal(fused.items[1].reason, 'vector');
  assert.ok(fused.items[1].score > 0.39 && fused.items[1].score < 0.4);
  assert.equal(fused.hits.semanticAdmitted, 2);

  // 静默样本：没有关键词命中，余弦也低于 semanticAdmit → 一张都不注入。
  const silent = chooseRecall({
    queryText: '今天天气怎么样',
    cards,
    queryVector,
    vectors: new Map([
      ['topics/a.md', [Float32Array.from([0.3, 0.9539])]],
      ['topics/b.md', [Float32Array.from([0.3, 0.9539])]],
    ]),
    budget: 1200,
  });
  assert.deepEqual(silent.items, []);
  assert.equal(silent.hits.semanticAdmitted, 0);

  // 权重可调：把向量权重压到 0，纯语义卡过不了 minFusedScore。
  const keywordOnly = chooseRecall({
    queryText, cards, queryVector, vectors, budget: 1200,
    options: { maxItems: 3, fusion: { keywordWeight: 1, vectorWeight: 0 } },
  });
  assert.deepEqual(keywordOnly.items.map((item) => item.path), ['topics/a.md']);
});

test('autoRecall：融合注入 + recall-log 行格式（含 blocked）', async (t) => {
  const root = tmpRoot(t);
  writeFile(root, 'topics/a.md', '---\ntitle: 沙箱卡\nscope_in: ["沙箱", "pwsh"]\n---\n# 沙箱卡\n- 沙箱里的 pwsh 起不来。\n');
  writeFile(root, 'topics/b.md', '---\ntitle: 语义卡甲\nscope_in: ["量子纠缠"]\n---\n# 语义卡甲\n- 只靠语义进来的甲。\n');
  writeFile(root, 'topics/c.md', '---\ntitle: 语义卡乙\nscope_in: ["黎曼猜想"]\n---\n# 语义卡乙\n- 只靠语义进来的乙。\n');

  const bus = new PreStepBus();
  const { ctx, warns } = makeCtx(bus);
  applyAutoRecall(ctx, {
    memoryRoot: root,
    dirs: ['topics'],
    budget: 1200,
    maxItems: 2,
    everyNTurns: 6,
    log: true,
    createUserMessage: makeUserMessageFactory(),
    embedding: { enabled: true, embedder: makeEmbedder() },
  });

  const { decision } = await bus.compose({
    messages: [textMessage('沙箱 pwsh 起不来怎么办')],
    agent: { session: { id: 'sess-embed', header: { origin: 'main' } } },
    turn: 1,
    step: 1,
  });
  assert.equal(decision.messages.length, 2);
  const injected = decision.messages[1];
  assert.equal(injected.source?.kind, 'session-reference');
  const text = injected.content.map((part) => part.text).join('\n');
  assert.match(text, /【自动想起】/);
  assert.match(text, /沙箱卡/);
  assert.match(text, /语义卡甲/);
  assert.doesNotMatch(text, /语义卡乙/);

  const logPath = path.join(root, '.longlive', 'recall-log.jsonl');
  const lines = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/);
  const row = JSON.parse(lines.at(-1));
  assert.deepEqual(Object.keys(row).sort(), ['at', 'blocked', 'injected', 'sessionId', 'turn']);
  assert.equal(row.sessionId, 'sess-embed');
  assert.equal(row.turn, 1);
  assert.equal(Number.isNaN(Date.parse(row.at)), false);
  assert.deepEqual(row.injected.map((item) => item.id), ['topics/a.md', 'topics/b.md']);
  for (const item of row.injected) {
    assert.equal(typeof item.title, 'string');
    assert.equal(typeof item.score, 'number');
    assert.match(item.reason, /^(keyword\+vector|vector|keyword)$/);
  }
  assert.equal(row.injected[0].reason, 'keyword+vector');
  assert.equal(row.injected[1].reason, 'vector');
  assert.equal(row.blocked.length, 1);
  assert.equal(row.blocked[0].id, 'topics/c.md');
  assert.equal(row.blocked[0].reason, 'max-items');
  assert.deepEqual(warns.filter((line) => /EMBEDDING_FALLBACK/.test(line)), []);
});

test('autoRecall：模型缺失时静默回退关键词，recall-log 照样写 reason=keyword', async (t) => {
  const root = tmpRoot(t);
  writeFile(root, 'topics/a.md', '---\ntitle: 沙箱卡\nscope_in: ["沙箱", "pwsh"]\n---\n# 沙箱卡\n- 沙箱里的 pwsh 起不来。\n');

  const bus = new PreStepBus();
  const { ctx, warns } = makeCtx(bus);
  applyAutoRecall(ctx, {
    memoryRoot: root,
    dirs: ['topics'],
    budget: 1200,
    maxItems: 2,
    log: true,
    createUserMessage: makeUserMessageFactory(),
    embedding: { enabled: true, modelPath: path.join(root, 'no-such-model') },
  });

  const { decision } = await bus.compose({
    messages: [textMessage('沙箱 pwsh 起不来怎么办')],
    agent: { session: { id: 'sess-fallback', header: { origin: 'main' } } },
    turn: 1,
    step: 1,
  });
  assert.equal(decision.messages.length, 2);
  assert.match(decision.messages[1].content[0].text, /沙箱卡/);
  assert.equal(warns.some((line) => /EMBEDDING_FALLBACK/.test(line)), true);

  const row = JSON.parse(fs.readFileSync(path.join(root, '.longlive', 'recall-log.jsonl'), 'utf8').trim());
  assert.equal(row.injected.length, 1);
  assert.equal(row.injected[0].id, 'topics/a.md');
  assert.equal(row.injected[0].reason, 'keyword');
});

test('autoRecall：embedding 关闭时不建 embeddings 目录，也不读模型', async (t) => {
  const root = tmpRoot(t);
  writeFile(root, 'topics/a.md', '---\ntitle: 沙箱卡\nscope_in: ["沙箱"]\n---\n# 沙箱卡\n- 沙箱相关。\n');
  const bus = new PreStepBus();
  const { ctx } = makeCtx(bus);
  applyAutoRecall(ctx, {
    memoryRoot: root,
    dirs: ['topics'],
    budget: 1200,
    createUserMessage: makeUserMessageFactory(),
  });
  const { decision } = await bus.compose({
    messages: [textMessage('沙箱里怎么运行')],
    agent: { session: { id: 'sess-off', header: { origin: 'main' } } },
    turn: 1,
    step: 1,
  });
  assert.equal(decision.messages.length, 2);
  assert.equal(fs.existsSync(path.join(root, '.longlive', 'embeddings')), false);
  const row = JSON.parse(fs.readFileSync(path.join(root, '.longlive', 'recall-log.jsonl'), 'utf8').trim());
  assert.equal(row.injected[0].reason, 'keyword');
});

test('createEmbeddingRuntime：ensure 失败返回结构化错误而不是抛进宿主', async (t) => {
  const root = tmpRoot(t);
  const runtime = createEmbeddingRuntime(
    { enabled: true, modelPath: path.join(root, 'missing') },
    { memoryRoot: root },
  );
  const result = await runtime.ensure([]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_EMBEDDING_MODEL_MISSING');
  assert.equal(runtime._state().ok, false);
});

test('cardChunkTexts：B 文本包含标题/关键词/正文三段', () => {
  const texts = cardChunkTexts({
    path: 'topics/a.md',
    title: '标题甲',
    scopeIn: ['词一'],
    aliases: ['别称一'],
    body: '正文第一段。',
  }, { maxChunkChars: 400, maxChunksPerCard: 6 });
  assert.equal(texts.length, 1);
  assert.match(texts[0], /【标题】标题甲/);
  assert.match(texts[0], /【关键词】词一 别称一/);
  assert.match(texts[0], /【正文】/);
});
