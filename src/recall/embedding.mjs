/**
 * Optional local embeddings for semantic recall (A3).
 *
 * Everything here is lazy and degradable:
 *   - importing this file never touches the filesystem and never loads ONNX;
 *   - `onnxruntime-node` is an optionalDependency, imported only when an
 *     operator turns `embedding.enabled` on;
 *   - a missing model / tokenizer / runtime is a coded error that the caller
 *     turns into "fall back to keyword recall", never a crash and never a
 *     startup failure.
 *
 * The model shape this module expects is a BERT-family encoder exported to
 * ONNX with `input_ids` / `attention_mask` / `token_type_ids` and
 * `last_hidden_state` (e.g. Xenova/bge-small-zh-v1.5). Pooling is CLS (BGE's
 * documented pooling), then L2 normalization, so cosine = dot product.
 *
 * Tokenization is implemented in-tree (BertNormalizer + BertPreTokenizer +
 * WordPiece) because pulling @xenova/transformers would add a much larger
 * dependency than the ONNX runtime itself. The tokenizer JSON is the source of
 * truth; this file does not hardcode a vocabulary.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const EMBEDDING_VERSION = 1;

export const EMBEDDING_DEFAULTS = Object.freeze({
  enabled: true,
  modelPath: '',
  maxSeqLen: 256,
  queryInstruction: '为这个句子生成表示以用于检索相关文章：',
  maxChunksPerCard: 6,
  maxChunkChars: 400,
  batchSize: 1,
});

/** Cosmetic/codec errors: each one is a reason to fall back, never to throw. */
export function embeddingError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function bool(value) {
  return value === true;
}

function positiveInt(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(number)));
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

/**
 * Normalize the operator-facing `embedding` block.
 *
 * `embedder` is a test seam: an object `{modelFingerprint, dim,
 * embedQuery(text), embedDocument(text)}` that replaces the ONNX provider.
 * Production config is plain JSON and never carries it.
 */
export function normalizeEmbeddingConfig(input, { memoryRoot = null } = {}) {
  const value = input && typeof input === 'object' ? input : {};
  const enabled = value.enabled !== false;
  const modelPath = text(value.modelPath);
  const cacheDirRaw = text(value.cacheDir);
  const cacheDir = cacheDirRaw
    ? (path.isAbsolute(cacheDirRaw) ? path.resolve(cacheDirRaw) : path.resolve(memoryRoot ?? process.cwd(), cacheDirRaw))
    : (memoryRoot ? path.join(memoryRoot, '.longlive', 'embeddings') : '');
  const embedder = value.embedder && typeof value.embedder === 'object'
    && typeof value.embedder.embedQuery === 'function'
    && typeof value.embedder.embedDocument === 'function'
    ? value.embedder
    : null;
  return {
    enabled,
    modelPath,
    cacheDir,
    maxSeqLen: positiveInt(value.maxSeqLen, EMBEDDING_DEFAULTS.maxSeqLen, 512),
    queryInstruction: typeof value.queryInstruction === 'string'
      ? value.queryInstruction
      : EMBEDDING_DEFAULTS.queryInstruction,
    maxChunksPerCard: positiveInt(value.maxChunksPerCard, EMBEDDING_DEFAULTS.maxChunksPerCard, 32),
    maxChunkChars: positiveInt(value.maxChunkChars, EMBEDDING_DEFAULTS.maxChunkChars, 4000),
    keywordWeight: Number.isFinite(Number(value.keywordWeight)) ? Math.max(0, Number(value.keywordWeight)) : 0.6,
    vectorWeight: Number.isFinite(Number(value.vectorWeight)) ? Math.max(0, Number(value.vectorWeight)) : 0.4,
    // Raw cosine needed when a card has zero keyword hits (semantic-only
    // admission). Calibrated against bge-small-zh-v1.5 on this memory tree:
    // unrelated silent queries peaked at 0.498, so 0.55 keeps them out while
    // still admitting true paraphrases around 0.58+.
    semanticAdmit: Number.isFinite(Number(value.semanticAdmit)) ? Number(value.semanticAdmit) : 0.55,
    minFusedScore: Number.isFinite(Number(value.minFusedScore)) ? Number(value.minFusedScore) : 0.2,
    embedder,
  };
}

/** SHA-256 (hex) of a string; used for cache keys, not for security. */
export function digest(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

/* ------------------------------------------------------------------ *
 * 1. BERT tokenizer (normalizer + pre-tokenizer + WordPiece)
 * ------------------------------------------------------------------ */

function isWhitespace(cp) {
  return cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x0c
    || cp === 0x0b || cp === 0x00a0 || cp === 0x2028 || cp === 0x2029
    || cp === 0x3000 || (cp >= 0x1680 && cp <= 0x1680) || (cp >= 0x2000 && cp <= 0x200a);
}

function isControl(cp) {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return false;
  return (cp >= 0x00 && cp <= 0x1f) || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)
    || cp === 0xad || (cp >= 0x0600 && cp <= 0x0605) || cp === 0x061c || cp === 0x06dd
    || cp === 0x070f || cp === 0x180e || (cp >= 0x200b && cp <= 0x200f)
    || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x2064)
    || (cp >= 0x2066 && cp <= 0x206f) || cp === 0xfeff || (cp >= 0xfff9 && cp <= 0xfffb)
    || (cp >= 0xfff9 && cp <= 0xfffb);
}

function isPunctuation(cp) {
  return (cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96)
    || (cp >= 123 && cp <= 126) || (cp >= 0x2000 && cp <= 0x206f)
    || (cp >= 0x2e00 && cp <= 0x2e7f) || (cp >= 0x3000 && cp <= 0x303f)
    || (cp >= 0xff00 && cp <= 0xff0f) || (cp >= 0xff1a && cp <= 0xff20)
    || (cp >= 0xff3b && cp <= 0xff40) || (cp >= 0xff5b && cp <= 0xff65);
}

/** CJK ideographs, Hiragana/Katakana, Hangul: one token per character. */
function isChineseChar(cp) {
  return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0x20000 && cp <= 0x2a6df) || (cp >= 0x2a700 && cp <= 0x2b73f)
    || (cp >= 0x2b740 && cp <= 0x2b81f) || (cp >= 0x2b820 && cp <= 0x2ceaf)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f)
    || (cp >= 0x3040 && cp <= 0x309f) || (cp >= 0x30a0 && cp <= 0x30ff)
    || (cp >= 0x31f0 && cp <= 0x31ff) || (cp >= 0xac00 && cp <= 0xd7af)
    || (cp >= 0x1100 && cp <= 0x11ff);
}

function stripAccents(value) {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function bertBasicNormalize(value, options = {}) {
  let out = '';
  const chars = Array.from(String(value ?? ''));
  for (const ch of chars) {
    const cp = ch.codePointAt(0);
    if (cp === 0 || cp === 0xfffd || isControl(cp)) continue;
    if (isWhitespace(cp)) { out += ' '; continue; }
    if (options.handleChineseChars !== false && isChineseChar(cp)) out += ` ${ch} `;
    else out += ch;
  }
  if (options.lowercase === true) out = out.toLowerCase();
  if (options.stripAccents === true) out = stripAccents(out);
  return out;
}

export function bertPreTokenize(normalized) {
  const collected = [];
  let current = '';
  const flush = () => {
    if (current !== '') { collected.push(current); current = ''; }
  };
  for (const ch of Array.from(String(normalized ?? ''))) {
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { flush(); continue; }
    const cp = ch.codePointAt(0);
    if (isPunctuation(cp)) { flush(); collected.push(ch); continue; }
    current += ch;
  }
  flush();
  return collected;
}

export function wordPiece(word, vocab, { unkToken = '[UNK]', prefix = '##', maxChars = 100 } = {}) {
  const chars = Array.from(String(word ?? ''));
  if (chars.length > maxChars) return [unkToken];
  const out = [];
  let start = 0;
  while (start < chars.length) {
    let end = chars.length;
    let piece = null;
    while (start < end) {
      const candidate = (start > 0 ? prefix : '') + chars.slice(start, end).join('');
      if (Object.prototype.hasOwnProperty.call(vocab, candidate)) { piece = candidate; break; }
      end -= 1;
    }
    if (piece === null) return [unkToken];
    out.push(piece);
    start = end;
  }
  return out;
}

/**
 * Load `tokenizer.json` and return `{encode(text, {maxLen}), decode(ids)}`.
 * The WordPiece model is read from the file, not assumed.
 */
export function loadTokenizer(tokenizerPath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(tokenizerPath, 'utf8'));
  } catch (error) {
    throw embeddingError('E_EMBEDDING_TOKENIZER', `读不到 tokenizer.json（${tokenizerPath}）：${error?.message ?? error}`);
  }
  const model = raw?.model;
  if (!model || model.type !== 'WordPiece' || !model.vocab || typeof model.vocab !== 'object') {
    throw embeddingError('E_EMBEDDING_TOKENIZER', 'tokenizer.json 不是 WordPiece 模型（需要 model.vocab）');
  }
  const vocab = model.vocab;
  const idToToken = new Array(Object.keys(vocab).length);
  for (const [token, id] of Object.entries(vocab)) {
    if (Number.isInteger(id) && id >= 0) idToToken[id] = token;
  }
  const added = new Map();
  for (const item of Array.isArray(raw?.added_tokens) ? raw.added_tokens : []) {
    if (item && Number.isInteger(item.id) && typeof item.content === 'string') added.set(item.content, item.id);
  }
  const normalizer = raw?.normalizer && typeof raw.normalizer === 'object' ? raw.normalizer : {};
  const normalizerOptions = {
    lowercase: normalizer.lowercase === true || raw?.tokenizer_config?.do_lower_case === true,
    stripAccents: normalizer.strip_accents === true
      || (normalizer.strip_accents == null && normalizer.lowercase === true),
    handleChineseChars: normalizer.handle_chinese_chars !== false,
  };
  const clsToken = added.has('[CLS]') ? '[CLS]' : '[CLS]';
  const sepToken = added.has('[SEP]') ? '[SEP]' : '[SEP]';
  const clsId = added.get('[CLS]') ?? vocab['[CLS]'];
  const sepId = added.get('[SEP]') ?? vocab['[SEP]'];
  const padId = added.get('[PAD]') ?? vocab['[PAD]'] ?? 0;
  const unkToken = typeof model.unk_token === 'string' ? model.unk_token : '[UNK]';
  const prefix = typeof model.continuing_subword_prefix === 'string' ? model.continuing_subword_prefix : '##';
  const maxChars = Number.isInteger(model.max_input_chars_per_word) ? model.max_input_chars_per_word : 100;
  if (!Number.isInteger(clsId) || !Number.isInteger(sepId)) {
    throw embeddingError('E_EMBEDDING_TOKENIZER', 'tokenizer.json 缺少 [CLS]/[SEP] id');
  }

  return {
    vocabSize: Object.keys(vocab).length,
    padId,
    clsId,
    sepId,
    encode(value, { maxLen = 512 } = {}) {
      const normalized = bertBasicNormalize(value, normalizerOptions);
      const words = bertPreTokenize(normalized);
      const ids = [clsId];
      for (const word of words) {
        const pieces = wordPiece(word, vocab, { unkToken, prefix, maxChars });
        for (const piece of pieces) {
          const id = vocab[piece];
          if (!Number.isInteger(id)) break;
          ids.push(id);
          if (ids.length >= maxLen - 1) break;
        }
        if (ids.length >= maxLen - 1) break;
      }
      ids.push(sepId);
      // 不补齐到 maxLen：补齐会让每次推理都跑满 256 token（查询只有十几个字，
      // 白烧 10 倍算力）。ONNX 图支持动态序列长度，真实长度反而更快。
      return ids;
    },
    tokensOf(value) {
      const normalized = bertBasicNormalize(value, normalizerOptions);
      return bertPreTokenize(normalized).flatMap((word) => wordPiece(word, vocab, { unkToken, prefix, maxChars }));
    },
    decode(ids) {
      return (Array.isArray(ids) ? ids : []).map((id) => idToToken[id] ?? '').filter(Boolean).join(' ');
    },
  };
}

/* ------------------------------------------------------------------ *
 * 2. ONNX provider
 * ------------------------------------------------------------------ */

/** Find `<modelPath>/onnx/model.onnx`, any `*.onnx`, or a direct file path. */
export function resolveOnnxModel(modelPath) {
  const root = path.resolve(modelPath);
  const candidates = [];
  try {
    if (fs.statSync(root).isFile()) candidates.push(root);
  } catch {
    /* not a file */
  }
  candidates.push(
    path.join(root, 'onnx', 'model.onnx'),
    path.join(root, 'onnx', 'model_quantized.onnx'),
    path.join(root, 'model.onnx'),
    path.join(root, 'model_quantized.onnx'),
  );
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function tensorFromIds(ort, ids) {
  return new ort.Tensor('int64', BigInt64Array.from(ids.map((n) => BigInt(n))), [1, ids.length]);
}

async function loadOrt() {
  try {
    const mod = await import('onnxruntime-node');
    const ort = mod?.default && typeof mod.default.InferenceSession === 'function' ? mod.default : mod;
    if (!ort?.InferenceSession) throw embeddingError('E_EMBEDDING_DEPS', 'onnxruntime-node 没有导出 InferenceSession');
    return ort;
  } catch (error) {
    if (error?.code === 'E_EMBEDDING_DEPS') throw error;
    throw embeddingError(
      'E_EMBEDDING_DEPS',
      `onnxruntime-node 未安装或加载失败（可选依赖，未装 profile 时请手动安装）：${error?.message ?? error}`,
    );
  }
}

/**
 * Create an ONNX-backed embedder.
 * @returns {Promise<{dim:number, modelFingerprint:string, embed(text:string):Promise<Float32Array>, embedMany(texts:string[]):Promise<Float32Array[]>, dispose():Promise<void>}>}
 */
export async function createOnnxEmbedder(config) {
  const modelPath = path.resolve(String(config.modelPath));
  const onnxPath = resolveOnnxModel(modelPath);
  if (!onnxPath) {
    throw embeddingError('E_EMBEDDING_MODEL_MISSING', `模型目录里没有 .onnx：${modelPath}`);
  }
  const tokenizerPath = path.join(modelPath, 'tokenizer.json');
  const tokenizer = loadTokenizer(tokenizerPath);
  const ort = await loadOrt();
  let session;
  try {
    session = await ort.InferenceSession.create(onnxPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
  } catch (error) {
    throw embeddingError('E_EMBEDDING_RUNTIME', `ONNX 模型加载失败（${onnxPath}）：${error?.message ?? error}`);
  }

  const statOf = (file) => {
    try {
      const s = fs.statSync(file);
      return { size: s.size, mtimeMs: Math.round(s.mtimeMs) };
    } catch {
      return null;
    }
  };
  const modelStat = statOf(onnxPath);
  const tokenizerStat = statOf(tokenizerPath);
  const fingerprint = digest(JSON.stringify({
    version: EMBEDDING_VERSION,
    onnx: path.basename(onnxPath),
    modelStat,
    tokenizerStat,
    maxSeqLen: config.maxSeqLen,
    instruction: config.queryInstruction,
    pooling: 'cls',
  }));

  const embedOne = async (value) => {
    const ids = tokenizer.encode(value, { maxLen: config.maxSeqLen });
    const mask = ids.map((id) => (id === tokenizer.padId ? 0 : 1));
    const feeds = {
      input_ids: tensorFromIds(ort, ids),
      attention_mask: tensorFromIds(ort, mask),
      token_type_ids: tensorFromIds(ort, ids.map(() => 0)),
    };
    let output;
    try {
      output = await session.run(feeds);
    } catch (error) {
      throw embeddingError('E_EMBEDDING_RUNTIME', `ONNX 推理失败：${error?.message ?? error}`);
    }
    const tensor = output?.last_hidden_state ?? output?.[Object.keys(output ?? {})[0]];
    if (!tensor?.data || !Array.isArray(tensor.dims) || tensor.dims.length !== 3) {
      throw embeddingError('E_EMBEDDING_RUNTIME', 'ONNX 输出不是 [1, seq, hidden] 的 last_hidden_state');
    }
    const dim = Number(tensor.dims[2]);
    const vector = new Float32Array(dim);
    let norm = 0;
    for (let i = 0; i < dim; i += 1) {
      const valueAt = Number(tensor.data[i]); // CLS pooling: position 0
      vector[i] = valueAt;
      norm += valueAt * valueAt;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < dim; i += 1) vector[i] /= norm;
    return vector;
  };

  return {
    dim: 0,
    modelFingerprint: `onnx:${fingerprint}`,
    tokenizer,
    async embed(value) {
      const vector = await embedOne(value);
      this.dim = vector.length;
      return vector;
    },
    async embedMany(texts) {
      const out = [];
      for (const value of texts) out.push(await this.embed(value));
      return out;
    },
    async dispose() {
      try {
        await session?.release?.();
      } catch {
        /* provider teardown is best effort */
      }
    },
  };
}

/** Provider selection: test embedder first, ONNX second, error otherwise. */
export async function createEmbedder(config) {
  if (config.embedder) {
    const test = config.embedder;
    return {
      dim: Number(test.dim) || 0,
      modelFingerprint: String(test.modelFingerprint ?? 'test-embedder'),
      embed: async (value) => test.embedQuery(String(value)),
      embedMany: async (texts) => Promise.all(texts.map((value) => test.embedDocument(String(value)))),
    };
  }
  return createOnnxEmbedder(config);
}

/* ------------------------------------------------------------------ *
 * 3. Chunking + vector index (incremental, atomic)
 * ------------------------------------------------------------------ */

/** Split a card body into a handful of character-bounded chunks. */
export function chunkText(value, { maxChars = 400, maxChunks = 6 } = {}) {
  const source = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if (source === '') return [];
  const paragraphs = source.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current !== '' && current.length + paragraph.length + 1 > maxChars) {
      chunks.push(current);
      current = '';
    }
    if (paragraph.length > maxChars) {
      if (current !== '') { chunks.push(current); current = ''; }
      for (let at = 0; at < paragraph.length; at += maxChars) {
        chunks.push(paragraph.slice(at, at + maxChars));
      }
    } else {
      current = current === '' ? paragraph : `${current}\n${paragraph}`;
    }
  }
  if (current !== '') chunks.push(current);
  if (chunks.length <= maxChunks) return chunks;
  // Keep the first chunk (title/abstract) and sample the rest evenly: a long
  // card must not push every other card out of the index.
  const kept = [chunks[0]];
  const rest = chunks.length - 1;
  for (let i = 1; i < maxChunks; i += 1) {
    kept.push(chunks[Math.round((i * rest) / (maxChunks - 1))]);
  }
  return [...new Set(kept)];
}

/**
 * Text actually embedded for one card chunk.
 *
 * 实测对比（30 条查询，见 REPORT）：只嵌 title+body 时 top1 21/30；把
 * scope_in/aliases 的关键词也写进被嵌文本后 top1 27/30。原因：这张卡的
 * 「检索面」本来就是作者手写的 scope 词表，不该只拿给关键词打分用。
 */
export function cardChunkTexts(card, config) {
  const title = String(card?.title ?? '').trim();
  const vocab = [
    ...(Array.isArray(card?.scopeIn) ? card.scopeIn : []),
    ...(Array.isArray(card?.aliases) ? card.aliases : []),
  ].map((x) => String(x).trim()).filter(Boolean).join(' ');
  const chunks = chunkText(card?.body ?? card?.summary ?? '', {
    maxChars: config.maxChunkChars,
    maxChunks: config.maxChunksPerCard,
  });
  if (chunks.length === 0) chunks.push('');
  return chunks
    .map((chunk) => `【标题】${title}\n【关键词】${vocab}\n【正文】${chunk}`)
    .filter((t) => t.trim() !== '');
}

/** Content the vector index depends on: change any of it → re-embed that card. */
export function cardDigest(card) {
  return digest(JSON.stringify({
    title: String(card?.title ?? ''),
    body: String(card?.body ?? card?.summary ?? ''),
    scopeIn: Array.isArray(card?.scopeIn) ? card.scopeIn : [],
    aliases: Array.isArray(card?.aliases) ? card.aliases : [],
  }));
}

export function cosineSimilarity(left, right) {
  if (!left || !right || left.length !== right.length) return 0;
  let dot = 0;
  let a = 0;
  let b = 0;
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i] * right[i];
    a += left[i] * left[i];
    b += right[i] * right[i];
  }
  if (a === 0 || b === 0) return 0;
  return dot / Math.sqrt(a * b);
}

/** Max cosine over a card's chunks (one chunk in the common case). */
export function maxSimilarity(queryVector, vectors) {
  let best = 0;
  for (const vector of Array.isArray(vectors) ? vectors : []) {
    const score = cosineSimilarity(queryVector, vector);
    if (score > best) best = score;
  }
  return best;
}

function readCache(cachePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!raw || raw.version !== EMBEDDING_VERSION || typeof raw.cards !== 'object' || raw.cards === null) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeCacheAtomic(cachePath, payload) {
  const dir = path.dirname(cachePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, 'utf8');
  fs.renameSync(tmp, cachePath);
}

/**
 * Build (or incrementally refresh) the vector index for `cards`.
 *
 * The cache lives at `<cacheDir>/index.json` and is keyed by model fingerprint
 * + per-card content digest. A failed write never fails recall: the in-memory
 * vectors are returned regardless, the next call simply rebuilds.
 *
 * @returns {Promise<{cardVectors:Map<string,Float32Array[]>, stats:object}>}
 */
export async function buildVectorIndex({ cards, config, embedder, cachePath }) {
  const started = Date.now();
  const cache = cachePath ? readCache(cachePath) : null;
  const cachedCards = cache && cache.modelFingerprint === embedder.modelFingerprint && cache.cards
    ? cache.cards
    : {};
  const nextCards = {};
  const cardVectors = new Map();
  const stats = { cards: 0, chunks: 0, reusedCards: 0, embeddedCards: 0, embeddedChunks: 0, cacheHit: Boolean(cache), changed: false };

  for (const card of cards) {
    if (!card || typeof card.path !== 'string') continue;
    const hash = cardDigest(card);
    const cached = cachedCards[card.path];
    stats.cards += 1;
    if (cached && cached.hash === hash && Array.isArray(cached.chunks) && cached.chunks.length > 0) {
      const vectors = cached.chunks.map((chunk) => Float32Array.from(chunk));
      cardVectors.set(card.path, vectors);
      nextCards[card.path] = { hash, chunks: cached.chunks };
      stats.chunks += vectors.length;
      stats.reusedCards += 1;
      continue;
    }
    const texts = cardChunkTexts(card, config);
    const vectors = await embedder.embedMany(texts);
    const normalized = vectors.map((vector) => (vector instanceof Float32Array ? vector : Float32Array.from(vector)));
    cardVectors.set(card.path, normalized);
    nextCards[card.path] = { hash, chunks: normalized.map((vector) => Array.from(vector, (n) => Math.round(n * 1e6) / 1e6)) };
    stats.chunks += normalized.length;
    stats.embeddedCards += 1;
    stats.embeddedChunks += normalized.length;
    stats.changed = true;
  }

  if (cachePath) {
    const sameShape = cache && Object.keys(nextCards).length === Object.keys(cache.cards ?? {}).length
      && Object.entries(nextCards).every(([key, value]) => cache.cards?.[key]?.hash === value.hash);
    if (stats.changed || !sameShape) {
      try {
        writeCacheAtomic(cachePath, {
          version: EMBEDDING_VERSION,
          generatedAt: new Date().toISOString(),
          modelFingerprint: embedder.modelFingerprint,
          dim: embedder.dim || (cardVectors.values().next().value?.[0]?.length ?? 0),
          cards: nextCards,
        });
        stats.written = true;
      } catch (error) {
        stats.writeError = error?.code ?? error?.message ?? String(error);
      }
    }
  }
  stats.ms = Date.now() - started;
  return { cardVectors, stats };
}

/* ------------------------------------------------------------------ *
 * 4. Runtime facade used by autoRecall / memory_recall
 * ------------------------------------------------------------------ */

/**
 * A lazy engine: nothing loads until `ensure()` is called with the current
 * card list. Failures are returned as `{ok:false, code, message}` so callers
 * can fall back instead of throwing into the host's pre-step waterfall.
 */
export function createEmbeddingRuntime(input, { memoryRoot = null, warn = null } = {}) {
  const config = normalizeEmbeddingConfig(input, { memoryRoot });
  const cachePath = config.cacheDir ? path.join(config.cacheDir, 'index.json') : '';
  let state = null; // {ok, embedder, vectors, stats, signature} | {ok:false, code, message}
  let loading = null;

  const load = async (cards) => {
    if (!config.enabled) return { ok: false, code: 'E_EMBEDDING_DISABLED', message: 'embedding.enabled=false' };
    if (!config.modelPath && !config.embedder) {
      return { ok: false, code: 'E_EMBEDDING_MODEL_MISSING', message: 'embedding.modelPath 未配置' };
    }
    let embedder;
    try {
      embedder = await createEmbedder(config);
    } catch (error) {
      return { ok: false, code: error?.code ?? 'E_EMBEDDING_RUNTIME', message: String(error?.message ?? error) };
    }
    let index;
    try {
      index = await buildVectorIndex({ cards, config, embedder, cachePath });
    } catch (error) {
      return { ok: false, code: error?.code ?? 'E_EMBEDDING_RUNTIME', message: String(error?.message ?? error) };
    }
    return { ok: true, embedder, ...index };
  };

  return {
    config,
    get enabled() {
      return config.enabled;
    },
    /** Build/refresh once; a changed card signature rebuilds the in-memory index. */
    async ensure(cards, { refresh = false, signature = undefined } = {}) {
      if (state?.ok && !refresh && (signature === undefined || signature === state.signature)) return state;
      if (loading) return loading;
      loading = load(cards).then((value) => {
        state = { ...value, signature };
        if (!value.ok && typeof warn === 'function') {
          warn(`[embedding] ${value.code}: ${value.message} — 回退关键词召回`);
        }
        return state;
      }).finally(() => {
        loading = null;
      });
      return loading;
    },
    async embedQuery(value) {
      const current = await this.ensure([]);
      if (!current.ok) throw embeddingError(current.code, current.message);
      return current.embedder.embed(`${config.queryInstruction}${String(value ?? '')}`);
    },
    /** One-shot convenience used by the evaluation script. */
    async query(value) {
      const current = await this.ensure([]);
      if (!current.ok) throw embeddingError(current.code, current.message);
      return current.embedder.embed(`${config.queryInstruction}${String(value ?? '')}`);
    },
    dispose() {
      const current = state;
      state = null;
      if (current?.ok) {
        Promise.resolve(current.embedder.dispose?.()).catch(() => {});
      }
    },
    _state: () => state,
  };
}

/** Does this card have a vector entry? Used by tests and diagnostics. */
export function vectorCount(cardVectors) {
  return cardVectors instanceof Map ? cardVectors.size : 0;
}

export { fsp };
