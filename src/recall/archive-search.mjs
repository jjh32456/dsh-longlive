// @local/dsh-longlive — 归档可检索（archive digest，M2-A 旧记忆）
//
// 会话被**热截断**（`<memoryRoot>/.longlive/hot-truncate/*.jsonl`）或**可见截断**
// （`<sessionsRoot>/**/session.v4.jsonl.zstd.archive/*.zstd`）切掉之后，那些正文
// 不在活会话里、也不在事件索引里。`scripts/archive-digest-build.mjs` 把旧正文摘要
// 成一个只读的本地索引；本模块只读该索引，供 M2 召回按需动态调用。
//
// 契约（M2 固定，不要改签名）：
//   searchArchive({ memoryRoot, queryText, limit = 3 })
//     -> { items: [{ archivePath, sessionId, turn, seq, ts, excerpt, matchedTerms, sha256 }], stats }
//   * 任何输入都不抛；索引缺失/损坏 → items 为空、stats.indexReady === false。
//   * sha256 是**来源文件字节**的 sha256（出处可复核）；excerpt ≤ 400 字。
//
// 排序 v2（2026-11-26 修 A6）：
//   1) 精确短语命中优先 —— query 原串（去空白、小写，长度 ≥2）完整出现在正文里，
//      排在仅分词命中的条目前；多个候选短语（原串 + 按标点切的子句）按**最长匹配**优先。
//   2) 同一短语档内按「短语覆盖率」（命中短语总长 / 正文长度）降序 —— 原始短提问会压过
//      长讨论里的一笔带过；再按命中词数、时间降序、出处路径/seq 升序（确定性兜底）。
//   3) fail-safe：短语为空或单字时不启用短语规则，退回原来的分词 + 时间排序。
//
// 索引布局：`<memoryRoot>/.longlive/archive-digest/{index.jsonl,manifest.json}`。
// 兼容：直接把摘要目录本身当 memoryRoot 传（目录下就是 index.jsonl+manifest.json）
// 时回退到该目录 —— 只影响查询路径解析，不改变上面的布局约定。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export const ARCHIVE_DIGEST_SCHEMA = 'archive-digest/v1';
export const ARCHIVE_DIGEST_DIR = 'archive-digest';
export const ARCHIVE_INDEX_FILE = 'index.jsonl';
export const ARCHIVE_MANIFEST_FILE = 'manifest.json';
export const EXCERPT_MAX_CHARS = 400;
export const DEFAULT_LIMIT = 3;
export const MAX_LIMIT = 5000;
export const MAX_QUERY_TERMS = 60;
export const MIN_PHRASE_CHARS = 2;
export const MAX_PHRASE_CANDIDATES = 8;

const SHA_CACHE_MAX = 8;
const shaCache = new Map();

// 中日韩统一表意文字（基本区 + 扩展 A + 兼容区）——2-gram 的切分单位。
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const ASCII_WORD = /[a-z0-9]+/g;
// 候选短语的切分点：空白 + 中英文标点。
const PHRASE_SPLIT = /[\s,，。.、;；:：!！?？"'“”‘’()（）\[\]【】<>《》/\\|-]+/u;

/** 折叠空白：连续空白压成一个空格并 trim（构建与查询共用同一口径）。 */
export function foldWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** 摘要目录的三种路径；memoryRoot 不可用时返回 null。 */
export function archiveDigestPaths(memoryRoot) {
  if (typeof memoryRoot !== 'string' || memoryRoot.trim() === '') return null;
  const root = path.resolve(memoryRoot.trim());
  const dir = path.join(root, '.longlive', ARCHIVE_DIGEST_DIR);
  return {
    root,
    dir,
    indexPath: path.join(dir, ARCHIVE_INDEX_FILE),
    manifestPath: path.join(dir, ARCHIVE_MANIFEST_FILE),
  };
}

function hasDigestFiles(candidate) {
  try {
    return fs.existsSync(candidate.indexPath) && fs.existsSync(candidate.manifestPath);
  } catch {
    return false;
  }
}

/** 先按约定布局找；找不到且传入目录本身就是摘要目录时才回退。 */
function resolveDigestPaths(memoryRoot) {
  const primary = archiveDigestPaths(memoryRoot);
  if (!primary) return null;
  if (hasDigestFiles(primary)) return primary;
  const direct = {
    root: primary.root,
    dir: primary.root,
    indexPath: path.join(primary.root, ARCHIVE_INDEX_FILE),
    manifestPath: path.join(primary.root, ARCHIVE_MANIFEST_FILE),
  };
  if (hasDigestFiles(direct)) return direct;
  return primary; // 都不存在：按主布局报 index-missing
}

// ---------------------------------------------------------------------------
// 查询词切分 + 摘要切片
// ---------------------------------------------------------------------------

/**
 * queryText → 检索词：CJK 连续段按 2-gram 切，拉丁/数字词（≥2 字符、小写）。
 * 单字 CJK 查询保留单字，避免「猫」这类查询变成空词表。
 * 词表有上限（MAX_QUERY_TERMS），长 query 只取前 60 个词。
 */
export function tokenizeQuery(queryText) {
  const text = foldWhitespace(queryText);
  if (text === '') return [];
  const terms = [];
  const push = (term) => {
    if (!term || terms.length >= MAX_QUERY_TERMS) return;
    if (!terms.includes(term)) terms.push(term);
  };
  for (const match of text.matchAll(CJK_RUN)) {
    const run = match[0];
    if (run.length === 1) {
      push(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length && terms.length < MAX_QUERY_TERMS; i += 1) {
      push(run.slice(i, i + 2));
    }
  }
  const lower = text.toLowerCase();
  for (const match of lower.matchAll(ASCII_WORD)) {
    if (match[0].length >= 2) push(match[0]);
  }
  return terms;
}

/**
 * query → 候选短语：原串（折叠空白、小写）在前，再按标点/空白切出的子句；
 * 全部长度 ≥ MIN_PHRASE_CHARS，按字符长度降序（原串最长匹配优先）。
 * 空 query / 单字 query → []：短语规则 fail-safe 关闭。
 */
export function phraseCandidates(queryText) {
  const norm = foldWhitespace(queryText).toLowerCase();
  if (Array.from(norm).length < MIN_PHRASE_CHARS) return [];
  const out = [];
  const push = (value) => {
    const candidate = String(value ?? '');
    if (Array.from(candidate).length < MIN_PHRASE_CHARS) return;
    if (out.includes(candidate) || out.length >= MAX_PHRASE_CANDIDATES) return;
    out.push(candidate);
  };
  push(norm);
  for (const part of norm.split(PHRASE_SPLIT)) push(part);
  return out.sort((a, b) => Array.from(b).length - Array.from(a).length);
}

/**
 * 命中位置附近的 ≤400 字摘要窗口（不是简单截前 400 字，避免命中落在原文尾部时
 * 摘要里看不到命中词）。前后截断分别加一个省略号，总长仍 ≤ EXCERPT_MAX_CHARS。
 */
export function buildExcerpt(text, terms = [], phrase = '') {
  const full = String(text ?? '');
  const chars = Array.from(full);
  if (chars.length <= EXCERPT_MAX_CHARS) return full;

  const lower = full.toLowerCase();
  const needle = typeof phrase === 'string' ? phrase : '';
  let pos = needle.length >= 2 ? lower.indexOf(needle) : -1;
  if (pos < 0) {
    for (const term of terms) {
      const at = lower.indexOf(term);
      if (at >= 0 && (pos < 0 || at < pos)) pos = at;
    }
  }
  let cpIndex = 0;
  if (pos >= 0) {
    let codeUnits = 0;
    while (codeUnits < pos && cpIndex < chars.length) {
      codeUnits += chars[cpIndex].length;
      cpIndex += 1;
    }
  }

  // 最坏情况前后各一个省略号：窗口预算 398，加上两个省略号仍 ≤400。
  const budget = EXCERPT_MAX_CHARS - 2;
  let winStart = Math.max(0, cpIndex - Math.floor(budget / 3));
  winStart = Math.min(winStart, Math.max(0, chars.length - budget));
  const winEnd = Math.min(chars.length, winStart + budget);
  const prefix = winStart > 0 ? '…' : '';
  const suffix = winEnd < chars.length ? '…' : '';
  return prefix + chars.slice(winStart, winEnd).join('') + suffix;
}

// ---------------------------------------------------------------------------
// 索引读取
// ---------------------------------------------------------------------------

function briefError(error) {
  const message = error && typeof error.message === 'string' ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

async function fileSha256(filePath) {
  const stat = await fs.promises.stat(filePath);
  const cached = shaCache.get(filePath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.sha256;
  const sha256 = await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
  shaCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, sha256 });
  if (shaCache.size > SHA_CACHE_MAX) shaCache.delete(shaCache.keys().next().value);
  return sha256;
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

async function scanIndex(indexPath, terms, phrases) {
  const hits = [];
  let matchedEntries = 0;
  let phraseHitEntries = 0;
  let lineNo = 0;
  const stream = fs.createReadStream(indexPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      lineNo += 1;
      if (line === '') continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch (error) {
        throw new Error(`corrupt archive digest index: line ${lineNo} is not JSON (${briefError(error)})`);
      }
      if (!entry || typeof entry !== 'object' || typeof entry.t !== 'string' || typeof entry.p !== 'string') {
        throw new Error(`corrupt archive digest index: line ${lineNo} has no searchable text/path`);
      }
      const lower = entry.t.toLowerCase();
      const matched = terms.filter((term) => lower.includes(term));
      if (matched.length === 0) continue;
      matchedEntries += 1;
      // 最长候选短语优先：phrases 已按长度降序，第一个命中的就是该条目的最长匹配。
      let phraseMatch = null;
      for (const phrase of phrases) {
        if (!lower.includes(phrase)) continue;
        phraseMatch = {
          text: phrase,
          length: Array.from(phrase).length,
          count: countOccurrences(lower, phrase),
        };
        break;
      }
      if (phraseMatch) phraseHitEntries += 1;
      hits.push({
        entry,
        matchedTerms: matched,
        // 只在短语命中时才量正文长度（覆盖率分母）；无短语命中时该字段用不到。
        textLength: phraseMatch ? Math.max(1, Array.from(lower).length) : 1,
        phraseMatch,
      });
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { hits, matchedEntries, phraseHitEntries };
}

function compareHits(a, b) {
  // 1) 原串最长匹配优先（短语命中 > 仅分词命中；更长候选 > 更短候选）。
  const aLen = a.phraseMatch ? a.phraseMatch.length : 0;
  const bLen = b.phraseMatch ? b.phraseMatch.length : 0;
  if (bLen !== aLen) return bLen - aLen;
  // 2) 同短语档内按覆盖率降序：短语总长（长度 × 次数）/ 正文长度。交叉相乘避免浮点误差。
  if (aLen > 0) {
    const aNum = aLen * a.phraseMatch.count;
    const bNum = bLen * b.phraseMatch.count;
    // cross > 0 表示 b 覆盖率更高（bNum/bDen > aNum/aDen），b 排前。
    const cross = bNum * a.textLength - aNum * b.textLength;
    if (cross !== 0) return cross > 0 ? 1 : -1;
  }
  // 3) 命中词数；4) 时间降序；5) 出处路径/seq 升序（确定性兜底）。
  if (b.matchedTerms.length !== a.matchedTerms.length) return b.matchedTerms.length - a.matchedTerms.length;
  const aTs = Number.isFinite(a.entry.ts) ? a.entry.ts : 0;
  const bTs = Number.isFinite(b.entry.ts) ? b.entry.ts : 0;
  if (bTs !== aTs) return bTs - aTs;
  if (a.entry.p !== b.entry.p) return a.entry.p < b.entry.p ? -1 : 1;
  const aSeq = Number.isFinite(a.entry.seq) ? a.entry.seq : 0;
  const bSeq = Number.isFinite(b.entry.seq) ? b.entry.seq : 0;
  return aSeq - bSeq;
}

function normalizeLimit(limit) {
  const value = Number(limit);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(value)));
}

// ---------------------------------------------------------------------------
// 公开入口
// ---------------------------------------------------------------------------

/**
 * 归档摘要检索。契约见文件头；任何输入都不抛。
 * @param {{memoryRoot?: string, queryText?: string, limit?: number}} [options]
 * @returns {Promise<{items: object[], stats: object}>}
 */
export async function searchArchive(options = {}) {
  const started = Date.now();
  const stats = {
    schema: ARCHIVE_DIGEST_SCHEMA,
    indexReady: false,
    indexDir: '',
    builtAt: null,
    entryCount: 0,
    inputCount: 0,
    indexBytes: 0,
    indexSha256: '',
    queryTerms: [],
    queryPhrases: [],
    matchedEntries: 0,
    phraseHitEntries: 0,
    returned: 0,
    elapsedMs: 0,
  };
  const finish = (items, extra = {}) => {
    Object.assign(stats, extra);
    stats.returned = items.length;
    stats.elapsedMs = Date.now() - started;
    return { items, stats };
  };

  try {
    const memoryRoot = typeof options.memoryRoot === 'string' ? options.memoryRoot : '';
    const queryText = typeof options.queryText === 'string' ? options.queryText : '';
    const terms = tokenizeQuery(queryText);
    stats.queryTerms = terms;

    const paths = resolveDigestPaths(memoryRoot);
    if (!paths) return finish([], { reason: 'memoryRoot-missing' });
    stats.indexDir = paths.dir;

    let manifest;
    try {
      manifest = JSON.parse(await fs.promises.readFile(paths.manifestPath, 'utf8'));
    } catch (error) {
      return finish([], {
        reason: fs.existsSync(paths.manifestPath) ? 'manifest-unreadable' : 'index-missing',
        detail: briefError(error),
      });
    }
    if (!manifest || typeof manifest !== 'object' || manifest.schema !== ARCHIVE_DIGEST_SCHEMA) {
      return finish([], { reason: 'manifest-invalid', detail: `schema must be ${ARCHIVE_DIGEST_SCHEMA}` });
    }
    if (typeof manifest.indexSha256 !== 'string' || !Number.isInteger(manifest.indexBytes) || manifest.indexBytes < 0) {
      return finish([], { reason: 'manifest-invalid', detail: 'indexSha256/indexBytes missing' });
    }

    let stat;
    try {
      stat = await fs.promises.stat(paths.indexPath);
    } catch (error) {
      return finish([], { reason: 'index-missing', detail: briefError(error) });
    }
    stats.builtAt = typeof manifest.builtAt === 'string' ? manifest.builtAt : null;
    stats.entryCount = Number.isInteger(manifest.entryCount) ? manifest.entryCount : 0;
    stats.inputCount = Array.isArray(manifest.inputs) ? manifest.inputs.filter((input) => !input?.error).length : 0;
    stats.indexBytes = manifest.indexBytes;
    stats.indexSha256 = manifest.indexSha256;

    if (stat.size !== manifest.indexBytes) {
      return finish([], { reason: 'index-size-mismatch', detail: `size ${stat.size} != manifest ${manifest.indexBytes}` });
    }
    let actualSha;
    try {
      actualSha = await fileSha256(paths.indexPath);
    } catch (error) {
      return finish([], { reason: 'index-unreadable', detail: briefError(error) });
    }
    if (actualSha !== manifest.indexSha256) {
      return finish([], { reason: 'index-sha-mismatch', detail: `sha ${actualSha.slice(0, 12)}… != manifest` });
    }

    if (terms.length === 0) {
      return finish([], { indexReady: true, reason: 'empty-query' });
    }

    const phrase = foldWhitespace(queryText).toLowerCase();
    const phrases = phraseCandidates(queryText);
    stats.queryPhrases = phrases;
    let scanned;
    try {
      scanned = await scanIndex(paths.indexPath, terms, phrases);
    } catch (error) {
      return finish([], { reason: 'index-corrupt', detail: briefError(error) });
    }

    const limit = normalizeLimit(options.limit);
    const sorted = scanned.hits.sort(compareHits).slice(0, limit);
    const items = sorted.map(({ entry, matchedTerms, phraseMatch }) => {
      const text = String(entry.t);
      // 摘要窗口优先对最长命中的短语开窗（query 原串可能因标点差异不在正文里）。
      const excerptPhrase = phraseMatch ? phraseMatch.text : phrase;
      return {
        archivePath: entry.p,
        sessionId: typeof entry.s === 'string' ? entry.s : '',
        turn: Number.isFinite(entry.turn) ? entry.turn : null,
        seq: Number.isFinite(entry.seq) ? entry.seq : null,
        ts: Number.isFinite(entry.ts) ? entry.ts : null,
        excerpt: buildExcerpt(text, matchedTerms, excerptPhrase),
        matchedTerms,
        sha256: typeof entry.h === 'string' ? entry.h : '',
      };
    });
    return finish(items, {
      indexReady: true,
      reason: 'ok',
      matchedEntries: scanned.matchedEntries,
      phraseHitEntries: scanned.phraseHitEntries,
    });
  } catch (error) {
    // 最后一道防线：契约规定任何情况下不得抛。
    return finish([], { reason: 'search-error', detail: briefError(error) });
  }
}
