// src/memory/fts-query.js — M2-A/K2：FTS5 查询构造与文本预分词
//
// 依据 `evidence/FTS5-MEMGAP-EVIDENCE.md`（任务 实测）：
//   * 裸 query 直接进 MATCH 必炸（`1.6.8` → syntax error near "."、`session-c045`
//     → no such column、`- " ( ) * OR AND NOT` 各有固定语法错）；
//   * trigram tokenizer 覆盖中文 ≥3 字子串 / 版本号 / ID / 日期，但 2 字 CJK 与
//     2 字 ASCII 不命中；
//   * unicode61 只匹配完整 token，需要**预分词列**：bigram + 别名（2 字 CJK 靠它）。
//
// 本模块只做「把任意用户问题变成若干条可安全执行的 MATCH 候选」，不打开数据库：
//   buildFtsCandidates(text) → { raw: [{label, match}], terms: [{label, match}] }
// 调用方（event-index）对每条候选 try/catch + 参数绑定，全部失败/无命中 → NO_MATCH。
//
// 安全规则：NFKC → 去控制符 → 双引号剥除 → 所有候选一律「整段双引号包裹」；
// FTS 运算符词（OR/AND/NOT/NEAR）因此都按字面词处理，不进入语法层。

export const MAX_QUERY_CHARS = 200;

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const ASCII_WORD_RE = /[A-Za-z0-9_][A-Za-z0-9_.:/\\-]*/g;
const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const VERSION_RE = /\bv?\d+(?:\.\d+){1,3}\b/g;
const CJK_TOKEN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;

/** NFKC + strip control chars + drop double quotes + collapse whitespace. */
export function normalizeQuery(input) {
  return normalizeForExtraction(input).slice(0, MAX_QUERY_CHARS);
}

/**
 * S8: extraction normalizer — same folding as the query normalizer but **without
 * the 200-char query cap**. `extractTerms`/`termTextOf` used `normalizeQuery`
 * and therefore threw away every term after the first 200 chars of a turn.
 */
export function normalizeForExtraction(input) {
  const text = String(input ?? '');
  let out = '';
  try {
    out = text.normalize('NFKC');
  } catch {
    out = text;
  }
  return out
    .replace(CONTROL_RE, ' ')
    .replace(/["\u201c\u201d\u2018\u2019]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200_000);
}

/** All CJK bigrams of a run (2-char windows, deduped, order preserved). */
export function cjkBigrams(run) {
  const chars = Array.from(String(run ?? ''));
  const out = [];
  const seen = new Set();
  for (let i = 0; i + 1 < chars.length; i += 1) {
    const bigram = chars[i] + chars[i + 1];
    if (!seen.has(bigram)) {
      seen.add(bigram);
      out.push(bigram);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// S8：长 CJK run 不再整段丢弃。
//
// 旧实现只保留长度 2–12 的**整段** run；一段包含主题词的长句（例如「简介我准备
// 放我朋友那五问你现在根据那五问回答」）长度 >12 就被整体扔掉，留下的是标点切
// 开的短片段 → auto 卡 / 事件 terms 没有主题词。
//
// 新实现（仍然无词典、无外部依赖）：
//   1. 原 run 长度 2–12 → 保留（向后兼容）；
//   2. 用高频虚词/代词把长 run 切成「内容块」（五问 / 智能体工程师 这类词能成块）；
//   3. 内容块 2–12 → 保留；仍 >12 的块 → cjkBigrams 滑窗（限量）；
//   4. 实体后缀启发（工程师/智能体/插件/版本/…）补充「…工程师」这类名词短语；
//   5. 引号/书名号内的短语优先保留。
// 结果按优先级去重并限量（默认 120；旧默认 60 的调用行为仍可用 options.maxTerms 恢复）。
// ---------------------------------------------------------------------------

const CJK_STOP_WORDS = [
  // 多字虚词/连接词（先于单字处理）
  '我们', '你们', '他们', '她们', '它们', '自己', '大家', '什么', '怎么', '怎样', '为什么',
  '现在', '之前', '之后', '以后', '以前', '然后', '所以', '因为', '但是', '不过', '而且',
  '并且', '以及', '或者', '还是', '就是', '可能', '需要', '准备', '根据', '按照', '关于',
  '对于', '如果', '虽然', '只要', '只有', '已经', '正在', '马上', '立刻', '可以', '应该',
  '能够', '必须', '不要', '没有', '不是', '这是', '那是', '一个', '一些', '一下', '一点',
  '时候', '地方', '这里', '那里', '这个', '那个', '这些', '那些', '这样', '那样', '其实',
  '当然', '可是', '于是', '接着', '还有', '比如', '例如', '甚至', '终于', '并且', '因此',
];
const CJK_STOP_CHARS = new Set(Array.from(
  '的地得了着过是我你您他她它这那就都也和与及把被给对从到向往于而且但却又再还很太更最不没呢吧啊吗呀哦嗯哈啦嘛等些个让使请帮',
));
const CJK_SUFFIXES = [
  '工程师', '架构师', '设计师', '程序员', '开发者', '产品经理', '经理', '老师', '医生', '律师',
  '智能体', '插件', '系统', '模型', '项目', '版本', '文档', '工具', '平台', '协议', '接口',
  '算法', '模块', '服务', '应用', '流程', '规则', '方案', '问题', '卡片', '记忆', '索引',
  '召回', '截断', '测试', '审计', '脚本', '配置', '权限', '日志', '会话', '事件',
];
const CJK_STOP_RE = new RegExp(`(?:${CJK_STOP_WORDS.join('|')})`, 'g');
const CJK_STOP_CHARS_SOURCE = Array.from(CJK_STOP_CHARS).map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
const CJK_STOP_CHARS_RE = new RegExp(`[${CJK_STOP_CHARS_SOURCE}]`, 'g');

/**
 * Split one normalised CJK run into content chunks by removing high-frequency
 * function words / pronouns. Every result is at least 2 chars.
 */
export function cjkContentChunks(run) {
  const normalized = normalizeForExtraction(run);
  if (normalized === '') return [];
  return normalized
    .replace(CJK_STOP_RE, '\n')
    .replace(CJK_STOP_CHARS_RE, '\n')
    .split('\n')
    .flatMap((part) => part.split(/[\s,;，；。！？!?、]+/))
    .map((part) => part.trim())
    .filter((part) => part !== '' && Array.from(part).length >= 2);
}

/** Quoted / book-title phrases (preserved because the user marked them). */
export function quotedPhrasesOf(text) {
  const raw = String(text ?? '');
  const out = [];
  const seen = new Set();
  // 「」『』《》【】“”‘’ and ASCII quotes; NFKC folds full-width quotes.
  const re = /(?:「([^」]{1,40})」|『([^』]{1,40})』|《([^》]{1,40})》|【([^】]{1,40})】|“([^”]{1,40})”|"([^"\n]{2,40})")/g;
  for (const match of raw.matchAll(re)) {
    const phrase = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? '').trim();
    if (phrase === '' || seen.has(phrase)) continue;
    const chars = Array.from(phrase);
    if (chars.length < 2 || chars.length > 40) continue;
    seen.add(phrase);
    out.push(phrase);
  }
  return out;
}

/**
 * Entity-ish noun phrases by suffix ("智能体工程师" / "五问" 类不依赖词表：
 * 五问 靠内容分块，这里补 ...工程师/...插件 这类常见技术名词）。
 */
export function entityPhrasesOf(text, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 20;
  const normalized = normalizeForExtraction(text);
  const out = [];
  const seen = new Set();
  for (const suffix of CJK_SUFFIXES) {
    let from = 0;
    for (;;) {
      const at = normalized.indexOf(suffix, from);
      if (at < 0) break;
      let start = at;
      let span = 0;
      while (start > 0 && span < 8 && !CJK_STOP_CHARS.has(normalized[start - 1]) && !/\s/.test(normalized[start - 1])) {
        start += -1;
        span += 1;
      }
      const candidate = normalized.slice(start, at + suffix.length);
      const len = Array.from(candidate).length;
      if (len >= 2 && len <= 12 && !seen.has(candidate) && !CJK_STOP_CHARS.has(candidate[0])) {
        seen.add(candidate);
        out.push(candidate);
      }
      from = at + suffix.length;
    }
  }
  return out.slice(0, limit);
}

/**
 * Extract the meaningful CJK/ASCII terms kept in EventRecord.terms.
 *
 * S8: long CJK runs are no longer discarded; see the block comment above.
 */
export function extractTerms(text, extra = [], options = {}) {
  const maxTerms = Number.isInteger(options.maxTerms) && options.maxTerms > 0 ? options.maxTerms : 120;
  const normalized = normalizeForExtraction(text);
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const item = typeof value === 'string' ? value.trim() : '';
    if (item === '' || seen.has(item)) return false;
    seen.add(item);
    out.push(item);
    return true;
  };
  for (const value of Array.isArray(extra) ? extra : []) push(value);
  for (const match of normalized.match(VERSION_RE) ?? []) push(match);
  for (const match of normalized.match(/\d{4}-\d{2}-\d{2}/g) ?? []) push(match);
  for (const match of normalized.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g) ?? []) push(match);
  for (const match of normalized.match(/\b(?:session|task|evt|rec|rv)[-_:][A-Za-z0-9-]{2,}\b/gi) ?? []) push(match);

  // 1) 用户显式标记过的短语（引号/书名号）优先。
  for (const phrase of quotedPhrasesOf(text)) push(phrase);

  // 2) 原生 run：长度 2–12 保留（向后兼容）。
  const runs = normalized.match(CJK_TOKEN_RE) ?? [];
  for (const run of runs) {
    const len = Array.from(run).length;
    if (len >= 2 && len <= 12) push(run);
  }

  // 3) 内容分块 + 实体后缀短语（长 run 的主要修复）。
  const chunkCandidates = [];
  for (const run of runs) {
    for (const chunk of cjkContentChunks(run)) chunkCandidates.push(chunk);
    for (const phrase of entityPhrasesOf(run)) chunkCandidates.push(phrase);
  }
  for (const chunk of [...new Set(chunkCandidates)].sort((a, b) => Array.from(b).length - Array.from(a).length)) {
    const len = Array.from(chunk).length;
    if (len >= 2 && len <= 12) push(chunk);
  }

  // 4) 仍然 >12 的块用 bigram 滑窗兜底（限量，保证长 run 不会整体消失）。
  let bigramBudget = 24;
  for (const chunk of chunkCandidates) {
    if (bigramBudget <= 0) break;
    if (Array.from(chunk).length <= 12) continue;
    for (const bigram of cjkBigrams(chunk)) {
      if (bigramBudget <= 0) break;
      if (push(bigram)) bigramBudget -= 1;
    }
  }

  // 5) 只有内容词太少时才补 bigram（避免 120 条全是滑窗噪声；搜索侧本来就
  //    用 buildFtsCandidates 自己生成 bigram，不依赖 terms 数组）。
  if (out.length < 12) {
    for (const run of runs) {
      for (const bigram of cjkBigrams(run)) {
        if (out.length >= 24) break;
        push(bigram);
      }
    }
  }
  return out.slice(0, maxTerms);
}

/** Pre-tokenized term column text for the unicode61 shadow table. */
export function termTextOf(text) {
  const normalized = normalizeForExtraction(text);
  if (normalized === '') return '';
  const tokens = [];
  const seen = new Set();
  const push = (token) => {
    if (token === '' || seen.has(token)) return;
    seen.add(token);
    tokens.push(token);
  };
  for (const run of normalized.match(CJK_RUN_RE) ?? []) {
    for (const bigram of cjkBigrams(run)) push(bigram);
  }
  for (const word of normalized.match(ASCII_WORD_RE) ?? []) push(word.toLowerCase());
  return tokens.join(' ');
}

/** Alias expansions: versions get a `v`-twin, hyphen ids get their parts. */
export function aliasesOf(text) {
  const normalized = normalizeForExtraction(text);
  const out = new Set();
  for (const match of normalized.match(VERSION_RE) ?? []) {
    if (match.startsWith('v')) out.add(match.slice(1));
    else out.add(`v${match}`);
  }
  for (const word of normalized.match(ASCII_WORD_RE) ?? []) {
    const lower = word.toLowerCase();
    if (lower.length >= 3 && lower.includes('-')) {
      const parts = lower.split('-').filter((part) => part !== '');
      if (parts.length >= 2) {
        out.add(parts[parts.length - 1]);
        out.add(parts.slice(0, 2).join('-'));
      }
    }
  }
  return [...out];
}

function escapeLiteral(text) {
  return `"${String(text ?? '').replace(/"/g, '')}"`;
}

function segmentsOf(normalized) {
  return normalized
    .split(/[\s,;，；。！？!?、]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '' && part !== '"');
}

function uniqueCandidates(items) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item.match !== 'string' || item.match === '') continue;
    if (seen.has(item.match)) continue;
    seen.add(item.match);
    out.push(item);
  }
  return out;
}

/**
 * Build safe MATCH candidates for both FTS tables.
 *
 * raw  = events_fts (trigram): 整句 phrase → 分段 AND → 分段 OR
 * terms= events_terms (unicode61): bigram/word/alias AND → OR → 整句 phrase
 */
export function buildFtsCandidates(input) {
  const normalized = normalizeQuery(input);
  if (normalized === '') return { normalized, raw: [], terms: [] };

  const segments = segmentsOf(normalized);
  const raw = uniqueCandidates([
    { label: 'phrase', match: escapeLiteral(normalized) },
    segments.length > 1
      ? { label: 'and-segments', match: segments.map(escapeLiteral).join(' AND ') }
      : null,
    segments.length > 1
      ? { label: 'or-segments', match: segments.map(escapeLiteral).join(' OR ') }
      : null,
  ]);

  const words = (normalized.match(ASCII_WORD_RE) ?? []).map((word) => word.toLowerCase());
  const bigrams = [];
  for (const run of normalized.match(CJK_RUN_RE) ?? []) bigrams.push(...cjkBigrams(run));
  const aliases = aliasesOf(normalized);
  const tokens = [...new Set([...bigrams, ...words, ...aliases])].filter((token) => token.length >= 1);
  const orderedTokens = tokens.slice(0, 24);
  const terms = uniqueCandidates([
    orderedTokens.length > 1
      ? { label: 'and-terms', match: orderedTokens.map(escapeLiteral).join(' AND ') }
      : null,
    orderedTokens.length > 0
      ? { label: 'or-terms', match: orderedTokens.map(escapeLiteral).join(' OR ') }
      : null,
    orderedTokens.length > 1
      ? { label: 'or-terms-bigram', match: bigrams.map(escapeLiteral).join(' OR ') }
      : null,
    { label: 'phrase', match: escapeLiteral(normalized) },
  ]);

  return { normalized, raw, terms };
}
