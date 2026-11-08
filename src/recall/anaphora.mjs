// src/recall/anaphora.mjs — B2：指代链解析（它/这个/那个/他/她/上面/刚才）
//
// 只用上下文（焦点实体 + 最近用户文本），无候选时 resolved=null（不猜）。
// 输出可回填查询：把 resolved 实体追加进查询词，提升同实体卡片命中。

export const ANAPHORA_SCHEMA = 'anaphora/v1';

export const PRONOUN_PATTERNS = Object.freeze([
  { pronoun: '它', regex: /它/gu },
  { pronoun: '它们', regex: /它们/gu },
  { pronoun: '这个', regex: /这个/gu },
  { pronoun: '那个', regex: /那个/gu },
  { pronoun: '这些', regex: /这些/gu },
  { pronoun: '那些', regex: /那些/gu },
  { pronoun: '上面', regex: /上面|上述|前面/u },
  { pronoun: '刚才', regex: /刚才|刚刚/u },
  { pronoun: '他', regex: /他(?![们])/gu },
  { pronoun: '她', regex: /她(?![们])/gu },
  { pronoun: '他们', regex: /他们/gu },
  { pronoun: '她们', regex: /她们/gu },
]);

const STOPWORDS = new Set([
  '这个', '那个', '这些', '那些', '什么', '怎么', '可以', '我们', '你们', '他们', '她们', '自己',
  '一个', '一下', '现在', '然后', '因为', '所以', '但是', '如果', '已经', '还是', '不是', '没有',
  '没有', '就是', '这样', '那样', '这里', '那里', '时候', '东西', '事情', '问题', '继续', '开始',
]);

function normalizeToken(token) {
  return String(token ?? '').trim();
}

/** Extract plausible entity tokens from a text (CJK 2-12 chars / ASCII words), stopwords dropped. */
export function extractEntityTokens(text, { max = 12 } = {}) {
  const value = typeof text === 'string' ? text : '';
  const tokens = [];
  const seen = new Set();
  const cjk = value.match(/[\u3400-\u9fff]{2,12}/gu) ?? [];
  const ascii = value.match(/[A-Za-z][A-Za-z0-9_.-]{1,30}/gu) ?? [];
  for (const token of [...cjk, ...ascii]) {
    if (STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
    if (tokens.length >= max) break;
  }
  return tokens;
}

/**
 * Resolve pronouns in `text` against focus entities first, then recent user texts.
 * @returns {{schema,references:{pronoun,resolved,candidates}[],terms:string[],unresolved:string[]}}
 */
export function resolveAnaphora({ text = '', recentTexts = [], focusEntities = [] } = {}) {
  const query = typeof text === 'string' ? text : '';
  const focus = (Array.isArray(focusEntities) ? focusEntities : [])
    .map(normalizeToken)
    .filter((token) => token !== '' && !STOPWORDS.has(token));
  const recentTokens = [];
  for (const recent of Array.isArray(recentTexts) ? recentTexts.slice(-3) : []) {
    for (const token of extractEntityTokens(recent)) {
      if (!recentTokens.includes(token)) recentTokens.push(token);
    }
  }
  const candidates = [...new Set([...focus, ...recentTokens])];
  const references = [];
  const terms = [];
  const unresolved = [];
  for (const { pronoun, regex } of PRONOUN_PATTERNS) {
    regex.lastIndex = 0;
    if (!regex.test(query)) continue;
    // Prefer the most recent focus entity; never invent one when no candidate exists.
    const resolved = candidates.length > 0 ? candidates[0] : null;
    references.push({ pronoun, resolved, candidates: candidates.slice(0, 5) });
    if (resolved !== null && !terms.includes(resolved)) terms.push(resolved);
    if (resolved === null) unresolved.push(pronoun);
  }
  return { schema: ANAPHORA_SCHEMA, references, terms, unresolved };
}

/** Append resolved referents to the query (no-op when nothing resolved). */
export function expandQueryWithAnaphora(queryText, resolution) {
  const terms = Array.isArray(resolution?.terms) ? resolution.terms : [];
  const base = String(queryText ?? '');
  const fresh = terms.filter((term) => !base.includes(term));
  return { text: fresh.length === 0 ? base : `${base} ${fresh.join(' ')}`, changed: fresh.length > 0, terms: fresh };
}
