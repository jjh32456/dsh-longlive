// src/answer/second-hop.mjs — B4：证据包字段覆盖不足 → 第二跳补读（最多 1 跳）
//
// §11.6-B4：证据包「字段覆盖检查」不足 → 补读第二跳（最多 1 跳）。
// 断言口径：构造缺 when 的证据 → 触发第二跳。本模块不猜内容：第二跳只放宽
// 证据检索阈值/条数并回读相邻轮，字段仍缺则如实返回 missingFieldsAfter。

export const SECOND_HOP_SCHEMA = 'second-hop/v1';
export const DEFAULT_REQUIRED_FIELDS = Object.freeze(['when']);

const WHEN_PATTERNS = [
  /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/u,
  /\d{4}[-/年]\d{1,2}月?/u,
  /今天|今日|昨天|昨日|前天|明天|后天|上周|本周|上周[一二三四五六日天]|周[一二三四五六日天]/u,
  /\d{1,2}\s*月\s*\d{1,2}\s*日/u,
  /\d{1,2}[:：]\d{2}/u,
  /刚才|刚刚|之前|上次|上次那回/u,
];

/** Check which required dimensions the evidence text covers. */
export function evidenceFieldCoverage(items, { requiredFields = DEFAULT_REQUIRED_FIELDS } = {}) {
  const text = (Array.isArray(items) ? items : [])
    .map((item) => [item?.user, item?.assistant].filter(Boolean).join('\n'))
    .join('\n');
  const present = {
    when: WHEN_PATTERNS.some((pattern) => pattern.test(text)),
    what: text.trim() !== '',
    who: /[\u3400-\u9fffA-Za-z]{2,}/u.test(text),
  };
  const missingFields = (Array.isArray(requiredFields) ? requiredFields : DEFAULT_REQUIRED_FIELDS)
    .filter((field) => present[field] !== true);
  return { requiredFields: [...requiredFields], present, missingFields, covered: missingFields.length === 0 };
}

function turnNumbers(items) {
  return (Array.isArray(items) ? items : []).map((item) => Number(item?.turn)).filter(Number.isFinite);
}

/**
 * First hop + at most one second hop. `retrieve` is injected (pure/testable seam).
 * Returns the first-hop result extended with `items` (first + added second-hop turns)
 * and a `secondHop` receipt. Never exceeds one extra hop.
 */
export function retrieveEvidenceWithSecondHop({
  turns = [],
  question = '',
  currentTurn = 0,
  maxItems = 3,
  minScore = 1.8,
  retrieve,
  requiredFields = DEFAULT_REQUIRED_FIELDS,
  relaxFactor = 0.6,
  maxHop = 1,
} = {}) {
  if (typeof retrieve !== 'function') throw new Error('E_SECOND_HOP_RETRIEVE: retrieve function required');
  const first = retrieve({ turns, question, currentTurn, maxItems, minScore });
  const coverageFirst = evidenceFieldCoverage(first?.items, { requiredFields });
  if (coverageFirst.covered || maxHop < 1) {
    return {
      ...first,
      secondHop: {
        schema: SECOND_HOP_SCHEMA,
        triggered: false,
        reason: coverageFirst.covered ? 'covered' : 'max-hop',
        missingFieldsFirst: coverageFirst.missingFields,
        addedTurns: [],
        missingFieldsAfter: coverageFirst.missingFields,
        hop: 1,
        maxHop,
      },
    };
  }
  const relaxedMinScore = Math.max(0, Number(minScore) * Number(relaxFactor));
  const second = retrieve({
    turns,
    question,
    currentTurn,
    maxItems: Math.max(1, Number(maxItems) + 2),
    minScore: relaxedMinScore,
  });
  const firstTurns = new Set(turnNumbers(first?.items));
  const added = (Array.isArray(second?.items) ? second.items : []).filter((item) => !firstTurns.has(Number(item?.turn)));
  const combined = [...(Array.isArray(first?.items) ? first.items : []), ...added].slice(0, Math.max(1, Number(maxItems) + 2));
  const coverageAfter = evidenceFieldCoverage(combined, { requiredFields });
  return {
    ...first,
    items: combined,
    zeroHit: combined.length === 0,
    secondHop: {
      schema: SECOND_HOP_SCHEMA,
      triggered: true,
      reason: 'field-coverage',
      missingFieldsFirst: coverageFirst.missingFields,
      addedTurns: added.map((item) => Number(item.turn)).filter(Number.isFinite),
      missingFieldsAfter: coverageAfter.missingFields,
      filled: coverageAfter.covered,
      hop: 2,
      maxHop,
      relaxedMinScore,
    },
  };
}
