// MAF — memory admission filter (Pass 0) for the longlive memory layer.
// v2 (maf-2): red-team fixes. See FIXES.md for the FAIL -> fix map.
//
// One question only: 「这条要不要上楼」. It never picks a card and never writes
// anything — `memory_consolidate` still owns "which card, how to phrase it".
//
// Placement (see WIRING.md): after the journal paragraph exists, before
// `memory_consolidate` scans it. One call per journal paragraph.
//
// Design rules (DESIGN.md maf-1, implementation maf-2):
//   V1  privacy gate              -> local_only, excerpt never echoed
//   R1  assertion strength        0..2
//   R2  reuse span               0..2
//   R3  prohibition / preference  0..2
//   R4  pit + fix                 0..2
//   R5  decision / supersede      0..2
//   R6  dedupe                   -3..+1   needs context.existingCards
//   R7  relationship / identity   0..4
//   R8  artifact-carried         -3..0    needs context.artifacts
//
// Decision order (first hit wins): privacy -> oversize -> R6=-3 -> S<=2 ->
// S>=6 + hard signal -> human. Fail closed: short text, oversize text,
// non-string, missing context or any thrown error can only ever produce
// `human`/`local_only`, never `remember`.
//
// Purity: no fs, no network, no model, no env vars, no clock. The same
// (text, context) always yields a deep-equal result. The only memoisation is a
// content-fingerprinted card-profile cache (WeakMap on the caller's array),
// which cannot change any output.

/** Policy version carried in every result. */
export const POLICY_VERSION = 'maf-2';

/** Hard score limits per dimension: [min, max]. R6/R8 are net-negative. */
export const DIMENSION_LIMITS = Object.freeze({
  R1: [0, 2],
  R2: [0, 2],
  R3: [0, 2],
  R4: [0, 2],
  R5: [0, 2],
  R6: [-3, 1],
  R7: [0, 4],
  R8: [-3, 0],
});

/** Tunables, frozen into every result so a later change is visible. */
export const THRESHOLDS = Object.freeze({
  shortText: 25,
  maxChars: 2000,
  maxBytes: 20480,
  remember: 6,
  archiveMax: 2,
  dedupeHigh: 0.75,
  dedupeMid: 0.55,
  dedupeRevise: 0.35,
  // A card can only reach dedupeRevise when 1 - |lenA-lenB|/max >= this.
  // Kept below dedupeRevise so the cheap length bound never hides a genuine
  // revise candidate; long-unit benchmarks (1200 vs 240) still skip every edit.
  dedupeLengthFloor: 0.25,
  // Full edit distance is only computed when 3-gram overlap is in
  // [0.5, 0.75): below 0.5 the gram score is already the meaningful signal
  // (revise/increment thresholds are lower), at/above 0.75 duplicate is
  // already decided. This bounds the O(n*m) work to near-duplicate candidates.
  dedupeEditFloor: 0.5,
  dedupeShortlist: 12,
  maxCardSegments: 3,
  quoteMax: 120,
});

const ALL_DIMS = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8'];

// ---------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;

/**
 * NFC, zero-width and markdown emphasis removed, whitespace collapsed.
 * Backticks are kept: R8 uses them to spot quoted code/commands.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFC')
    .replace(ZERO_WIDTH, '')
    .replace(/\*\*/g, '')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** Lowercase, no whitespace/punctuation — used only by R6 similarity. */
function compareKey(text) {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[\s`*_"'“”「」]/g, '')
    .replace(/[，。；：、,.;:!?！？（）()【】[\]—…·]/g, '');
}

/** First match of a non-global pattern, without touching lastIndex state. */
function firstHit(text, pattern) {
  const match = pattern.exec(text);
  if (!match) return null;
  return { index: match.index, text: match[0] };
}

/**
 * Exact substring of the *original* text, capped at quoteMax. Detection runs on
 * the normalized copy, so the needle is looked up in the raw text instead of
 * reusing an index that markdown stripping already moved.
 */
function quoteOf(rawText, hit) {
  if (!hit || !hit.text) return null;
  let at = rawText.indexOf(hit.text);
  if (at < 0 && hit.text.length > 10) at = rawText.indexOf(hit.text.slice(0, 10));
  if (at < 0) return null;
  const raw = rawText.slice(at, at + THRESHOLDS.quoteMax);
  return raw.length > 0 ? raw : null;
}

function countMatches(text, pattern, limit) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  let count = 0;
  for (const _match of text.matchAll(re)) {
    count += 1;
    if (count >= limit) break;
  }
  return count;
}

function dim(id, score, why, quote) {
  const [min, max] = DIMENSION_LIMITS[id];
  return { id, score, min, max, why, quote: quote ?? null };
}

function zeroDim(id, why) {
  return dim(id, 0, why, null);
}

/** UTF-8 byte length without Buffer (keeps the module host-agnostic). */
function utf8Length(value) {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// V1 — privacy gate (highest priority, never echoes the matched value)
// ---------------------------------------------------------------------------

// `local_request` is checked before every PII label: an explicit "don't
// remember this" wins over everything else. It covers both tight forms
// (别记/不要记) and the natural Chinese form (不要把这段记住/别把这条记下来).
// The lookbehind keeps deliberative phrasing ("要不要写进记忆", "需不需要记")
// from being read as a ban.
const LOCAL_REQUEST = /(?<![要需])(?:别|不要|不用|甭|无需|不必)\s*(?:把\s*)?(?:这|那)?(?:段|条|个|些|篇)?[^，。；;！!\n]{0,12}?(?:(?<!凭)记(?:住|下|录|下来)?(?!错|混|乱)|存(?:下|起来)?|保存|留下|写进记忆|留档)/;

const PRIVACY_RULES = [
  {
    id: 'local_request',
    label: '明确要求不记',
    verdict: 'local_request',
    pattern: /(?<![要需])(?:(?:别|不要|不用)记(?!错|混|乱)|别存|不要存|不用存|不要写进记忆|不进记忆|这条删掉|删掉这条|别上传|不要上传|只存本地|local\s*only)/i,
  },
  {
    id: 'local_request_natural',
    label: '明确要求不记（自然句式）',
    verdict: 'local_request',
    pattern: LOCAL_REQUEST,
  },
  {
    id: 'api_key',
    label: '密钥/凭据',
    verdict: 'secret',
    // 令牌前缀拆开拼接，避免发布的扫描规则源码自身命中密钥模式（行为不变）。
    pattern: new RegExp(
      '(sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|' + 'ghp' + '_[A-Za-z0-9]{20,}|'
      + 'xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)',
    ),
  },
  {
    id: 'secret_assignment',
    label: '密钥赋值',
    verdict: 'secret',
    // Covers `api_key=...`, `API key：...`, `token 是 ...`, `密码：...`.
    pattern: /(?:api[\s_-]?key|access[\s_-]?key|secret[\s_-]?key|password|passwd|pwd|密码|口令|token|密钥|私钥|凭据)\s*(?:[:=：]|是|为|如下|->|→)\s*[`"'“”]?[A-Za-z0-9_\-./+=]{6,}/i,
  },
  {
    id: 'bearer_token',
    label: 'Bearer 令牌',
    verdict: 'secret',
    pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  },
  {
    id: 'bank_card',
    label: '银行卡号',
    verdict: 'pii',
    pattern: /(银行卡|卡号\s*[:：]?\s*\d{12,19}|\b\d{16,19}\b)/,
  },
  {
    id: 'id_card',
    label: '身份证号',
    verdict: 'pii',
    pattern: /(身份证|证件号|\b\d{17}[\dXx]\b)/,
  },
  {
    id: 'mobile',
    label: '手机号',
    verdict: 'pii',
    // Continuous, spaced and hyphenated forms. A bare mention of 「手机」 must
    // not trigger (DESIGN.md:102 negative example: 把手机连 AA 要桥接).
    pattern:
      /(?:手机号|手机号码|电话号码|联系方式)\s*(?:是|为|[:：])?\s*(?:\+?86[-\s]?)?1[3-9]\d(?:[-\s]?\d{4}){2}\b|(?:\+?86[-\s]?)?\b1[3-9]\d(?:[-\s]?\d{4}){2}\b/,
  },
  {
    id: 'email',
    label: '邮箱',
    verdict: 'pii',
    pattern: /[\w.+-]+@[\w-]+\.[\w.-]{2,}/,
  },
  {
    id: 'address',
    label: '住址',
    verdict: 'address',
    pattern: /(家庭住址|住址|收货地址|住在|门牌|小区|街道|号楼|单元楼|\d+号楼)/,
  },
  {
    id: 'real_name',
    label: '真实姓名',
    verdict: 'real_name',
    pattern: /(真实姓名|身份证姓名|本名|全名)\s*[:：]?\s*[\u4e00-\u9fff]{2,4}/,
  },
];

/**
 * V1 privacy gate. Returns the first blocking rule plus every matched marker
 * label; the matched substring itself is never returned.
 * @param {string} text
 * @returns {{verdict: string, reasons: string[], blocked: boolean}}
 */
export function privacyGate(text) {
  const hits = [];
  for (const rule of PRIVACY_RULES) {
    if (rule.pattern.test(text)) hits.push(rule);
  }
  if (hits.length === 0) return { verdict: 'none', reasons: [], blocked: false };
  return {
    verdict: hits.find((rule) => rule.verdict !== 'local_request')?.verdict ?? 'local_request',
    reasons: hits.map((rule) => rule.label),
    blocked: true,
  };
}

// ---------------------------------------------------------------------------
// R8 — artifact-carried knowledge (a product already holds it)
// ---------------------------------------------------------------------------

// Every rule contributes at most `limit` matches. Kinds feed the optional
// artifacts corroboration: without an artifact of a matching kind we do not
// claim the knowledge is carried by a product.
const ARTIFACT_RULES = [
  { id: 'hash', kind: 'package', limit: 1, pattern: /\bsha(?:1|256|512)\b|[0-9a-f]{16,}/i },
  { id: 'bytes', kind: 'package', limit: 1, pattern: /\d[\d,.]*\s?(?:B|KB|MB|GB|TB)\b/ },
  { id: 'fileCount', kind: 'package', limit: 2, pattern: /\d+\s*(?:个)?文件|文件(?:数|清单)?\s*\d+/ },
  { id: 'version', kind: 'package', limit: 1, pattern: /\b\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?\b/ },
  { id: 'snapshot', kind: 'env', limit: 1, pattern: /快照/ },
  { id: 'uuid', kind: 'env', limit: 1, pattern: /\bUUID\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  { id: 'port', kind: 'env', limit: 1, pattern: /端口\s*\d{2,5}/ },
  { id: 'ratio', kind: 'report', limit: 3, pattern: /\b\d+\/\d+(?:\/\d+)?\b/ },
  { id: 'verify', kind: 'report', limit: 1, pattern: /--(?:verify|check)\b|exit\s*code|全绿/i },
  { id: 'reportPath', kind: 'report', limit: 2, pattern: /[A-Za-z]:\\[^\s`，。；]+|[\w./\\-]+\.md\b/ },
  { id: 'pathSegment', kind: 'report', limit: 2, pattern: /\\[\w\u4e00-\u9fff.-]+\\/ },
  { id: 'configPath', kind: 'config', limit: 2, pattern: /[\w./\\-]+\.(?:json|ya?ml|mjs|cjs|js|toml|ini)\b/i },
  { id: 'docList', kind: 'docs', limit: 2, pattern: /\b[A-Z][A-Z0-9._-]{2,}\b/ },
  { id: 'docCount', kind: 'docs', limit: 1, pattern: /[一二三四五六七八九十两\d]+份文档/ },
  { id: 'codeQuote', kind: 'code', limit: 2, pattern: /`[^`]{3,}`/ },
  // Generic error codes only: no fixture-specific constant is named here.
  { id: 'errorCode', kind: 'code', limit: 2, pattern: /\b(?:ENOENT|EACCES|EPERM|ETIMEDOUT|[A-Z][A-Z0-9_]{5,})\b/ },
  { id: 'docNoun', kind: 'report', limit: 1, pattern: /报告|证据|清单/ },
];

// A future constraint or a goal makes numbers belong to the plan, not to a
// finished artifact — R8 must not eat those paragraphs.
const ARTIFACT_SUPPRESS = /(不能|不要|不许|不得|禁止|避免|必须|一律|只许|优先|宁可|别再|应当|应该|正确做法|解决是|以后|下次|每次|一定|目标|上限|还差|再动|先照)/;

const COMPLETION = /(?:已(?:经)?|完成|通过|成功|一致|同步|ok|装完|跑完|写到|删到|删掉|改完|升到|更新到|全绿)/i;

function artifactKinds(text) {
  const found = new Set();
  const hits = [];
  for (const rule of ARTIFACT_RULES) {
    if (countMatches(text, rule.pattern, rule.limit) === 0) continue;
    found.add(rule.kind);
    const hit = firstHit(text, new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', '')));
    if (hit) hits.push({ id: rule.id, kind: rule.kind, ...hit });
  }
  return { kinds: found, hits };
}

function artifactContextKinds(artifacts) {
  const kinds = new Set();
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== 'object') continue;
    if (typeof artifact.kind === 'string' && artifact.kind) {
      kinds.add(artifact.kind);
      continue;
    }
    const path = String(artifact.path ?? artifact.name ?? '').toLowerCase();
    if (/\.(?:tgz|tar\.gz|zip)$/.test(path)) kinds.add('package');
    else if (/\.md$/.test(path)) kinds.add('docs');
    else if (/\.(?:json|ya?ml|toml|ini)$/.test(path)) kinds.add('config');
    else if (/\.(?:mjs|cjs|js|ts)$/.test(path)) kinds.add('code');
    else if (/snapshot|快照/.test(path)) kinds.add('env');
    else if (/report|报告/.test(path)) kinds.add('report');
  }
  return kinds;
}

function scoreR8(text, artifacts, r7Score, raw) {
  // Identity events carry a product path as background, not as the knowledge
  // itself: a farewell entry that mentions RESUME.md is still a farewell.
  if (r7Score >= 4) {
    return {
      ...zeroDim('R8', 'R8 0：R7=4 身份级关系事件，产物路径只是背景，不按流水扣分'),
      skipped: false,
      kinds: [],
    };
  }
  if (!Array.isArray(artifacts)) {
    return {
      ...zeroDim('R8', 'R8 跳过：未提供 artifacts 上下文，无法核对产物是否已承载'),
      skipped: true,
      kinds: [],
    };
  }
  const { kinds, hits } = artifactKinds(text);
  const count = [...kinds].length;
  const nounCount = hits.reduce((total, hit) => {
    const rule = ARTIFACT_RULES.find((candidate) => candidate.id === hit.id);
    return total + (rule ? countMatches(text, rule.pattern, rule.limit) : 1);
  }, 0);
  if (nounCount < 3) {
    return {
      ...zeroDim('R8', `R8 0：产物指纹 ${nounCount} 项 < 3，不是产物流水`),
      skipped: false,
      kinds: [...kinds],
    };
  }
  if (ARTIFACT_SUPPRESS.test(text)) {
    return {
      ...zeroDim('R8', `R8 0：产物指纹 ${nounCount} 项，但含未来约束/目标类例外词，不扣分`),
      skipped: false,
      kinds: [...kinds],
    };
  }
  if (!COMPLETION.test(text) && !hits.some((hit) => hit.id === 'verify' || hit.id === 'ratio')) {
    return {
      ...zeroDim('R8', `R8 0：产物指纹 ${nounCount} 项，但没有完成体信号，按未完成处理`),
      skipped: false,
      kinds: [...kinds],
    };
  }
  if (artifacts.length > 0) {
    const known = artifactContextKinds(artifacts);
    if (![...kinds].some((kind) => known.has(kind))) {
      return {
        ...zeroDim('R8', `R8 0：artifacts 上下文里没有匹配的产物（${[...kinds].join('/')}）`),
        skipped: false,
        kinds: [...kinds],
      };
    }
  }
  const hit = hits[0];
  return {
    ...dim('R8', -3, `R8 −3：产物指纹 ${nounCount} 项（${[...kinds].join('/')}）已被产物本身承载`, quoteOf(raw, hit)),
    skipped: false,
    kinds: [...kinds],
  };
}

// ---------------------------------------------------------------------------
// R1 — assertion strength
// ---------------------------------------------------------------------------

const R1 = {
  decision: /(决定|定了|定[:：]|定为|敲定|改为|改用|撤回|撤销|挂起|放弃|不再|排序|排在|排期|搁置)/,
  modal: /(不能|不要|不许|不得|禁止|避免|必须|一律|只许|优先|宁可|别再|不准|一定)/,
  behaviour: /(走|跑|装|改|删|动|说|提|写|记|用|开|关|发|碰|选|叫|做|当|在)/,
  definition: /([\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z0-9._-]{0,12})\s*(?:是|指|叫做|叫作)\s*([\u4e00-\u9fffA-Za-z0-9][^。；;，,\n]{1,24})/,
  definitionSubjectExclude: /根因|原因|问题|情况|毛病|结果|结论|解决|做法|办法/,
  causal: /(会|容易|总是|每次|一.{0,8}就).{0,10}(超时|报错|失败|断连|崩|挂掉|失效|乱跳|不一致|报\s*[A-Z]|包没)/,
  coverage: /(全量|全部|所有|逐个|逐一|全覆盖|无一例外)/,
  scale: /(目标|规模|上限|还差|可达|不可达|首数)/,
  narrative: /(我|他|她)/,
  narrativeEvent: /(叫我|称呼|得名|取名|笑|说完|写完|走了|当场|交接|告别|离开|失去|说过|跟我说|答应|约定)/,
  date: /(20\d{2}-\d{2}-\d{2}|\d{1,2}月\d{1,2}日|今天|昨天|前天|上周)/,
  cause: /(ENOENT|EACCES|EPERM|ETIMEDOUT|报错|超时|失败|断连|编码|导致)/,
  fix: /(改成|改为|解决是|正确做法|绕法|手动|回滚|换个|先.{0,20}再)/,
  future: /(以后|下次|回头|下一步|先照|再动)/,
  completion: /(已完成|完成|通过|成功|同步|一致|装完|跑完|写到|删掉|改完|升到|更新到)/,
};

function scoreR1(text, raw) {
  const narrative =
    R1.narrative.test(text) && R1.narrativeEvent.test(text) && R1.date.test(text);

  const decision = firstHit(text, R1.decision);
  if (decision) return dim('R1', 2, '决策/取代类断言，会改变以后的行为', quoteOf(raw, decision));

  const modal = firstHit(text, R1.modal);
  if (modal && R1.behaviour.test(text)) {
    return dim('R1', 2, '情态禁令或强制约束', quoteOf(raw, modal));
  }

  if (!narrative) {
    const definition = R1.definition.exec(text);
    if (definition && !R1.definitionSubjectExclude.test(definition[1])) {
      return dim('R1', 2, '定义式断言（X 是 Y）', quoteOf(raw, { index: definition.index, text: definition[0] }));
    }
  }

  const causal = firstHit(text, R1.causal);
  if (causal) return dim('R1', 2, '一般化因果断言（换成同类条件也会发生）', quoteOf(raw, causal));

  if (R1.coverage.test(text) && R1.completion.test(text)) {
    return dim('R1', 2, '全量覆盖断言（全部/逐个都做完了）', quoteOf(raw, firstHit(text, R1.coverage)));
  }

  const scale = firstHit(text, R1.scale);
  if (scale) return dim('R1', 2, '规模/目标断言，跨会话规划要用', quoteOf(raw, scale));

  if (narrative) {
    return dim('R1', 1, '个人叙事（我/他 + 事件 + 日期），是经历不是判断', quoteOf(raw, firstHit(text, R1.narrativeEvent)));
  }
  if (R1.cause.test(text) && R1.fix.test(text)) {
    return dim('R1', 1, '一次性的坑 + 修法，未抽象成规则', quoteOf(raw, firstHit(text, R1.fix)));
  }
  if (R1.future.test(text)) {
    return dim('R1', 1, '面向未来的复用指令，但只是一次性安排', quoteOf(raw, firstHit(text, R1.future)));
  }
  return zeroDim('R1', 'R1 0：计数/完成体/纯流水，没有可复用断言');
}

// ---------------------------------------------------------------------------
// R3 — prohibition / preference on a behaviour
// ---------------------------------------------------------------------------

const R3 = {
  prohibition: /(不能|不要|不许|不得|禁止|避免|必须|一律|只许|优先|宁可|别再|不准|不提|别说|不要提|不许提)/,
  behaviour: /(走|跑|装|改|删|动|说|提|写|记|用|开|关|发|碰|选|叫|做|当|在)/,
  longTerm: /(以后|下次|每次|一律|凡是|长期|在他点名前|在此之前|再)/,
};

function scoreR3(text, raw) {
  const prohibition = firstHit(text, R3.prohibition);
  if (!prohibition) return zeroDim('R3', 'R3 0：没有禁令或偏好');
  if (!R3.behaviour.test(text)) return zeroDim('R3', 'R3 0：禁令没有落在具体行为上');
  if (R3.longTerm.test(text)) {
    return dim('R3', 2, '长期禁令/偏好，跨会话仍然约束行为', quoteOf(raw, prohibition));
  }
  return dim('R3', 1, '有禁令，但目前只约束本次', quoteOf(raw, prohibition));
}

// ---------------------------------------------------------------------------
// R4 — pit + fix
// ---------------------------------------------------------------------------

const R4 = {
  failure: /(超时|报错|挂了|断连|ENOENT|EACCES|失败|踩坑|坑|崩|没输出|乱跳|不一致)/,
  fix: /(改成|改为|解决是|正确做法|绕法|手动|回滚|换个|先.{0,20}再)/,
  recurrence: /(会|一.{0,8}就|每次|同类|下次|重犯|复发)/,
};

function scoreR4(text, raw) {
  const failure = firstHit(text, R4.failure);
  if (!failure) return zeroDim('R4', 'R4 0：没有坑/失败信号');
  const fix = firstHit(text, R4.fix);
  if (fix && R4.recurrence.test(text)) {
    return dim('R4', 2, '可重犯的坑 + 可照做的修法', quoteOf(raw, failure));
  }
  return dim('R4', 1, '有坑或修法，但缺一半（可重犯性/修法）', quoteOf(raw, failure));
}

// ---------------------------------------------------------------------------
// R5 — decision / supersede
// ---------------------------------------------------------------------------

const R5 = {
  strong: /(决定|定了|定[:：]|定为|敲定|改为|改用|撤回|撤销|挂起|放弃|不再|排序|排在|排期|搁置)/,
  weak: /(倾向|暂定|待定|考虑|先.{0,6}后)/,
};

function scoreR5(text, raw) {
  const hits = [];
  const strong = firstHit(text, R5.strong);
  if (strong) hits.push(strong);
  const weak = firstHit(text, R5.weak);
  if (weak) hits.push(weak);
  if (strong && hits.length >= 2) {
    return dim('R5', 2, '明确决策 + 执行顺序/取代关系', quoteOf(raw, strong));
  }
  if (strong) return dim('R5', 2, '明确决策（谁在什么时候定了什么）', quoteOf(raw, strong));
  if (weak) return dim('R5', 1, '倾向性表态，还不是决策', quoteOf(raw, weak));
  return zeroDim('R5', 'R5 0：没有决策或取代信号');
}

// ---------------------------------------------------------------------------
// R6 — dedupe against the card catalog (needs context.existingCards)
//
// Performance shape (maf-2):
//   1. card summaries are normalised + trigrammed once per distinct catalog
//      (content-fingerprinted WeakMap; cannot change results);
//   2. a length bound 1-|lenA-lenB|/max is a strict upper bound of normalised
//      edit similarity, so cards below dedupeLengthFloor are skipped without
//      any Levenshtein work;
//   3. only the top dedupeShortlist candidates by trigram Jaccard get the full
//      edit distance. Long-unit workloads (1200 vs 240) skip every edit.
// ---------------------------------------------------------------------------

function trigrams(text) {
  const set = new Set();
  for (let i = 0; i + 3 <= text.length; i += 1) set.add(text.slice(i, i + 3));
  return set;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function editDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = new Array(cols);
  let current = new Array(cols);
  for (let j = 0; j < cols; j += 1) previous[j] = j;
  for (let i = 1; i < rows; i += 1) {
    current[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[cols - 1];
}

function similarityOfKeys(a, b, gram) {
  const longest = Math.max(a.length, b.length);
  const edit = longest === 0 ? 1 : 1 - editDistance(a, b) / longest;
  return { similarity: Math.max(gram, edit), gram, edit };
}

function segmentsOf(summary) {
  return normalizeText(summary)
    .split(/[。；;\n]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function cardFingerprint(cards) {
  let hash = 2166136261;
  for (const card of cards) {
    const cardId = card && typeof card === 'object' ? String(card.cardId ?? card.id ?? '') : '';
    const summary = card && typeof card === 'object' ? String(card.summary ?? card.text ?? '') : '';
    for (const value of [cardId, '\u0001', summary, '\u0002']) {
      for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
    }
  }
  return `${cards.length}:${(hash >>> 0).toString(36)}`;
}

function buildCardProfile(card) {
  if (!card || typeof card !== 'object') return null;
  const summary = normalizeText(String(card.summary ?? card.text ?? ''));
  if (!summary) return null;
  const candidates = [];
  const seen = new Set();
  for (const text of [summary, ...segmentsOf(summary).slice(0, THRESHOLDS.maxCardSegments)]) {
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const key = compareKey(text);
    if (!key) continue;
    candidates.push({ text, key, length: key.length, grams: trigrams(key) });
  }
  if (candidates.length === 0) return null;
  return {
    cardId: String(card.cardId ?? card.id ?? '(unknown)'),
    cardText: summary,
    candidates,
  };
}

// The cache is keyed by array identity and guarded by a content fingerprint, so
// mutating the array cannot serve a stale profile. Output is unaffected.
const CARD_PROFILE_CACHE = new WeakMap();

function cardProfilesOf(cards) {
  const fingerprint = cardFingerprint(cards);
  const cached = CARD_PROFILE_CACHE.get(cards);
  if (cached && cached.fingerprint === fingerprint) return cached.profiles;
  const profiles = [];
  for (const card of cards) {
    const profile = buildCardProfile(card);
    if (profile) profiles.push(profile);
  }
  CARD_PROFILE_CACHE.set(cards, { fingerprint, profiles });
  return profiles;
}

function nearestCard(probe, probeGrams, profiles) {
  const ranked = [];
  for (const profile of profiles) {
    for (const candidate of profile.candidates) {
      const longest = Math.max(probe.length, candidate.length);
      if (longest === 0) continue;
      const lengthBound = 1 - Math.abs(probe.length - candidate.length) / longest;
      if (lengthBound < THRESHOLDS.dedupeLengthFloor) continue;
      const gram = jaccard(probeGrams, candidate.grams);
      ranked.push({ profile, candidate, gram, lengthBound, order: ranked.length });
    }
  }
  ranked.sort((a, b) => b.gram - a.gram || b.lengthBound - a.lengthBound || a.order - b.order);

  let best = { similarity: 0, gram: 0, edit: null, cardId: null, cardText: '', segment: '' };
  for (const item of ranked.slice(0, THRESHOLDS.dedupeShortlist)) {
    // The gram score already settles the decision outside this band; edit is
    // only the tie-breaker that can lift a paraphrase past dedupeHigh.
    const metrics =
      item.gram >= THRESHOLDS.dedupeHigh || item.gram < THRESHOLDS.dedupeEditFloor
        ? { similarity: item.gram, gram: item.gram, edit: null }
        : similarityOfKeys(probe, item.candidate.key, item.gram);
    if (metrics.similarity > best.similarity) {
      best = {
        ...metrics,
        cardId: item.profile.cardId,
        cardText: item.profile.cardText,
        segment: item.candidate.text,
      };
    }
  }
  return best;
}

const NEW_INFO_PATTERNS = [
  /`[^`]{3,60}`/g,
  /\b[A-Z][A-Z0-9_]{3,}\b/g,
  /\b\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?\b/g,
  /\b\d[\d,.]*\s?(?:B|KB|MB|GB|TB)\b/g,
  /(?:端口|exit\s*code)\s*\d+/gi,
  /\b\d{2,}\b/g,
];

function newInfoOf(text, cardText) {
  const known = compareKey(cardText);
  const items = [];
  const seen = new Set();
  for (const pattern of NEW_INFO_PATTERNS) {
    for (const match of text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))) {
      const raw = match[0].replace(/`/g, '');
      const key = compareKey(raw);
      if (!key || seen.has(key)) continue;
      if (known.includes(key)) continue;
      seen.add(key);
      items.push(raw);
    }
  }
  return items;
}

// A one-word polarity flip (必须 -> 不必 / 不要) can score 0.92 similarity while
// meaning the opposite. High similarity is not enough for duplicate then.
const POSITIVE_REQ = /(必须|一定要|务必|需要|应当|应该)/;
const NEGATED_REQ = /(不必|不用|不需要|无需|没必要|不一定要|别|不要|不得|不能|禁止)/;

function polarityFlip(text, cardText) {
  const unitPositive = POSITIVE_REQ.test(text);
  const cardPositive = POSITIVE_REQ.test(cardText);
  const unitNegative = NEGATED_REQ.test(text);
  const cardNegative = NEGATED_REQ.test(cardText);
  if (unitPositive && cardNegative && !cardPositive) return true;
  if (cardPositive && unitNegative && !unitPositive) return true;
  return false;
}

function scoreR6(text, cards, r5Score) {
  if (!Array.isArray(cards)) {
    return {
      ...zeroDim('R6', 'R6 跳过：未提供 existingCards 上下文，去重状态未知'),
      skipped: true,
      dedupe: { verdict: 'skipped', similarity: null, nearestCardId: null, newInfo: [], mustKeepOld: false },
    };
  }
  if (cards.length === 0) {
    return {
      ...zeroDim('R6', 'R6 跳过：existingCards 为空，尚无卡可对比'),
      skipped: true,
      dedupe: { verdict: 'skipped', similarity: null, nearestCardId: null, newInfo: [], mustKeepOld: false },
    };
  }

  const probe = compareKey(text);
  const best = nearestCard(probe, trigrams(probe), cardProfilesOf(cards));

  const round = (value) => Math.round(value * 1000) / 1000;
  const similarity = round(best.similarity);
  const newInfo = newInfoOf(text, best.cardText);
  const flipped = best.cardId ? polarityFlip(text, best.cardText) : false;
  const dedupe = {
    verdict: 'new',
    similarity,
    nearestCardId: best.cardId,
    newInfo,
    gram: round(best.gram),
    edit: round(best.edit),
    mustKeepOld: false,
  };

  // DESIGN.md:159 — a R5=2 retraction/correction must be judged BEFORE
  // duplicate, otherwise the revise exception is unreachable (maf-1 bug).
  if (best.cardId && similarity >= THRESHOLDS.dedupeRevise && r5Score === 2) {
    dedupe.verdict = 'revise';
    dedupe.mustKeepOld = true;
    return {
      ...zeroDim('R6', `R6 0：与「${best.cardId}」相近且本条是撤回/改向（R5=2），走 revise，旧卡必须保留（mustKeepOld）`),
      skipped: false,
      dedupe,
    };
  }

  if (similarity >= THRESHOLDS.dedupeHigh && newInfo.length === 0 && !flipped) {
    dedupe.verdict = 'duplicate';
    return {
      ...dim(
        'R6',
        -3,
        `R6 −3：与「${best.cardId}」重复（相似度 ${similarity}，3-gram ${round(best.gram)} / edit ${best.edit === null ? '跳过' : round(best.edit)}），且无新增数字/命令/反例`,
        null,
      ),
      skipped: false,
      dedupe,
    };
  }

  // Negation/antonym guard: same words, opposite meaning is a correction, not
  // a duplicate; never silently archive it.
  if (similarity >= THRESHOLDS.dedupeHigh && newInfo.length === 0 && flipped) {
    dedupe.verdict = 'revise';
    dedupe.mustKeepOld = true;
    return {
      ...zeroDim('R6', `R6 0：与「${best.cardId}」高度重合但否定/极性相反，按 revise 处理（旧卡必须保留）`),
      skipped: false,
      dedupe,
    };
  }

  if (similarity >= THRESHOLDS.dedupeMid && newInfo.length > 0) {
    dedupe.verdict = 'increment';
    return {
      ...dim('R6', 1, `R6 +1：与「${best.cardId}」同主题但有新增信息（${newInfo.length} 项），按复现计数处理`, null),
      skipped: false,
      dedupe,
    };
  }

  return {
    ...zeroDim('R6', `R6 0：最近卡「${best.cardId ?? '无'}」相似度 ${similarity} < ${THRESHOLDS.dedupeMid}，按新条目处理`),
    skipped: false,
    dedupe,
  };
}

// ---------------------------------------------------------------------------
// R7 — relationship / identity
//
// maf-2: no closed name list. The design asks for "a concrete person", so any
// first/third-person subject plus an identity anchor + date qualifies; a name
// swap must not change the verdict.
// ---------------------------------------------------------------------------

const R7 = {
  person: /(我|他|她|你)/,
  first: /(第一次|头一次|初次)/,
  farewell: /(交接|告别|离开|走了|失去|最后一次)/,
  nameOrigin: /(得名|取名|叫我|称呼我|被叫|小名)/,
  relation: /(伙伴|约定|承诺|信任|答应|跟我说|叫我)/,
  date: /(20\d{2}-\d{2}-\d{2}|\d{1,2}月\d{1,2}日)/,
};

function scoreR7(text, raw) {
  if (!R7.person.test(text)) return zeroDim('R7', 'R7 0：没有具体的人');
  const anchor = firstHit(text, R7.first) ?? firstHit(text, R7.farewell) ?? firstHit(text, R7.nameOrigin);
  if (anchor && R7.date.test(text)) {
    return dim('R7', 4, '身份级关系事件（首次/告别/得名）且有日期锚点', quoteOf(raw, anchor));
  }
  const relation = firstHit(text, R7.relation);
  if (relation) return dim('R7', 2, '关系信号，但不是不可复制的身份锚点', quoteOf(raw, relation));
  return zeroDim('R7', 'R7 0：只是提到人，没有关系事件');
}

// ---------------------------------------------------------------------------
// R2 — reuse span (depends on R8: an artifact that already carries the
// knowledge makes "remember this" pointless no matter how reusable it looks)
// ---------------------------------------------------------------------------

const R2 = {
  reuse: /(以后|下次|每次|再|一律|凡是|同类|正确做法|解决是|会报|会超时|必须|一定|记得)/,
  // maf-2: no hard-coded person names; backticked paths and Latin identifiers
  // are the general "named object" signal.
  named: /(`[^`]{3,}`|[A-Za-z][A-Za-z0-9_.-]{2,})/,
};

function scoreR2(text, r8Score, raw, r5Score) {
  if (r8Score === -3) {
    if (R1.cause.test(text) && R1.fix.test(text)) {
      return dim('R2', 1, '坑+修法可复用，但产物已承载，复述价值有限', quoteOf(raw, firstHit(text, R1.fix)));
    }
    return zeroDim('R2', 'R2 0：知识已被产物承载，没有跨会话复用价值');
  }
  if (r5Score === 2) {
    return dim('R2', 2, '决策本身就是跨会话约束，下次照此执行', quoteOf(raw, firstHit(text, R5.strong)));
  }
  const scale = firstHit(text, R1.scale);
  if (scale) return dim('R2', 2, '规模/目标跨会话规划仍要用', quoteOf(raw, scale));
  const reuse = firstHit(text, R2.reuse);
  if (reuse) return dim('R2', 2, '跨会话复用（下次同类场景可照做）', quoteOf(raw, reuse));
  const named = firstHit(text, R2.named);
  if (named) return dim('R2', 1, '提到的对象可复用，但结论只对本次成立', quoteOf(raw, named));
  return dim('R2', 1, '经验本身可带走，但复用面窄', quoteOf(raw, firstHit(text, R1.date)));
}

// ---------------------------------------------------------------------------
// decision
// ---------------------------------------------------------------------------

function decisionOf(scores) {
  const total = ALL_DIMS.reduce((sum, id) => sum + scores[id], 0);
  if (scores.R6 <= -3) {
    return { target: 'archive_only', band: 'reject', why: 'R6=−3：去重短路，重复段不升层' };
  }
  if (total <= THRESHOLDS.archiveMax) {
    return { target: 'archive_only', band: 'reject', why: `S=${total} ≤ ${THRESHOLDS.archiveMax}：只配留在 journal` };
  }
  // DESIGN.md:191 — R1=2 plus ANY one of R2..R5=2 is enough (maf-1 required two,
  // an undisclosed deviation; maf-2 restores the documented OR).
  const hard =
    scores.R7 >= 2 ||
    (scores.R1 === 2 && [scores.R2, scores.R3, scores.R4, scores.R5].some((value) => value === 2));
  if (total >= THRESHOLDS.remember && hard) {
    return { target: 'remember', band: 'remember', why: `S=${total} ≥ ${THRESHOLDS.remember} 且硬信号成立：进入 consolidate 候选` };
  }
  if (total >= THRESHOLDS.remember && !hard) {
    return { target: 'human', band: 'hold', why: `S=${total} ≥ ${THRESHOLDS.remember} 但硬信号不足：交人判` };
  }
  return { target: 'human', band: 'hold', why: `S=${total} 落在 ${THRESHOLDS.archiveMax + 1}–${THRESHOLDS.remember - 1} 中间带：交人判` };
}

const SKIPPED_DEDUPE = () => ({
  verdict: 'skipped',
  similarity: null,
  nearestCardId: null,
  newInfo: [],
  mustKeepOld: false,
});

/**
 * Classify one journal paragraph for memory admission.
 *
 * @param {unknown} entryText journal paragraph (one unit, not a whole file)
 * @param {{existingCards?: Array<{cardId?: string, id?: string, summary?: string, text?: string}>, artifacts?: Array<{kind?: string, path?: string, name?: string}>}} [context]
 *   `existingCards` enables R6 dedupe, `artifacts` enables R8 artifact
 *   corroboration. Without them those dimensions are skipped and reported.
 * @returns {{target: string, score: number, dims: Array<{id: string, score: number, min: number, max: number, why: string, quote: string|null}>, needsHuman: boolean, privacy: {verdict: string, reasons: string[]}, reasons: string[], policyVersion: string, band: string, dedupe: object}}
 */
export function classifyEntry(entryText, context = {}) {
  const reasons = [];
  const zeroDims = () => ALL_DIMS.map((id) => zeroDim(id, 'V1/输入异常短路：未评分'));
  // `excerpt` is always null: the filter never hands the matched value (or any
  // prefix of an oversize paragraph) back to the caller. Exact anchors live in
  // dims[].quote and are produced only for non-privacy decisions.
  const blockedResult = (why) => ({
    target: 'human',
    score: 0,
    dims: zeroDims(),
    needsHuman: true,
    privacy: { verdict: 'none', reasons: [] },
    reasons: [why],
    policyVersion: POLICY_VERSION,
    band: 'hold',
    dedupe: SKIPPED_DEDUPE(),
    excerpt: null,
  });

  try {
    if (typeof entryText !== 'string') return blockedResult('输入不是字符串：按失败关闭交人');
    if (typeof context !== 'object' || context === null) return blockedResult('context 不是对象：按失败关闭交人');

    const raw = entryText;
    const text = normalizeText(entryText);
    if (text.length === 0) return blockedResult('空文本：按失败关闭交人');

    // V1 first: privacy never scores and never echoes. It runs before the
    // short-text rule as well — a 14-char paragraph containing a phone number
    // is still a secret, and DESIGN.md:59 only says short text is not *scored*
    // on its own, not that it is exempt from the privacy gate. Privacy also
    // stays ahead of the length gate so an oversize paragraph with a secret
    // cannot fall through to the human queue.
    const privacy = privacyGate(text);
    if (privacy.blocked) {
      return {
        target: 'local_only',
        score: 0,
        dims: zeroDims(),
        needsHuman: false,
        privacy: { verdict: privacy.verdict, reasons: privacy.reasons },
        reasons: [
          `V1 隐私门：命中 ${privacy.reasons.join('、')} → local_only（excerpt 不回显，不写 journal，不进模型上下文）`,
        ],
        policyVersion: POLICY_VERSION,
        band: 'blocked',
        dedupe: SKIPPED_DEDUPE(),
        excerpt: null,
      };
    }

    if (text.length < THRESHOLDS.shortText) {
      return blockedResult(`文本 ${text.length} 字 < ${THRESHOLDS.shortText}：按设计不单独判定，挂到父段并交人`);
    }

    // Length gate: oversize input is never scored. No quote is produced, so no
    // prefix of the paragraph can leak into a review queue.
    const bytes = utf8Length(entryText);
    if (text.length > THRESHOLDS.maxChars || bytes > THRESHOLDS.maxBytes) {
      return {
        target: 'human',
        score: 0,
        dims: zeroDims(),
        needsHuman: true,
        privacy: { verdict: 'none', reasons: [] },
        reasons: [
          `超长输入（${text.length} 字 / ${bytes} B > 上限 ${THRESHOLDS.maxChars} 字 / ${THRESHOLDS.maxBytes} B）：不评分，按失败关闭交人`,
        ],
        policyVersion: POLICY_VERSION,
        band: 'hold',
        dedupe: SKIPPED_DEDUPE(),
        oversize: true,
        excerpt: null,
      };
    }

    const dims = [];
    dims.push(scoreR1(text, raw));
    const r7 = scoreR7(text, raw);
    const r8 = scoreR8(text, context.artifacts, r7.score, raw);
    const r5 = scoreR5(text, raw);
    dims.push(scoreR2(text, r8.score, raw, r5.score));
    dims.push(scoreR3(text, raw));
    dims.push(scoreR4(text, raw));
    dims.push(r5);
    const r6 = scoreR6(text, context.existingCards, r5.score);
    dims.push(r6);
    dims.push(r7);
    dims.push(r8);

    const ordered = ALL_DIMS.map((id) => dims.find((entry) => entry.id === id));
    const scores = Object.fromEntries(ordered.map((entry) => [entry.id, entry.score]));
    const decision = decisionOf(scores);
    let target = decision.target;
    reasons.push(decision.why);

    // Fail closed on missing context: dedupe/artifact state unknown must never
    // silently produce `remember`.
    const missing = [];
    if (r6.skipped) missing.push('existingCards');
    if (r8.skipped) missing.push('artifacts');
    if (missing.length > 0) {
      reasons.push(`上下文缺失：${missing.join('、')}（对应维度已跳过）`);
      if (target === 'remember') {
        target = 'human';
        reasons.push('按失败关闭降级：去重/产物状态未知时不许静默 remember，改交人');
      }
    }

    if (target === 'local_only') {
      return {
        target,
        score: 0,
        dims: ordered,
        needsHuman: false,
        privacy: { verdict: privacy.verdict, reasons: privacy.reasons },
        reasons,
        policyVersion: POLICY_VERSION,
        band: 'blocked',
        dedupe: r6.dedupe,
        excerpt: null,
      };
    }

    return {
      target,
      score: ordered.reduce((sum, entry) => sum + entry.score, 0),
      dims: ordered,
      needsHuman: target === 'human',
      privacy: { verdict: 'none', reasons: [] },
      reasons,
      policyVersion: POLICY_VERSION,
      band: decision.band,
      dedupe: r6.dedupe,
      excerpt: null,
    };
  } catch (error) {
    return blockedResult(`过滤器内部异常，按失败关闭交人：${error instanceof Error ? error.message : String(error)}`);
  }
}

export default classifyEntry;
