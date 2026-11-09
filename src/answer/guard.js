// answer/core.mjs — 「有据才答」的纯逻辑：会话历史检索、注入文本、生成后检测。
//
// 这里不碰 ctx / fs：输入是普通对象（事件、消息、轮次索引），输出是
// 证据包/无证据标记/审计 flags。接线在 ./index.js，落盘在 ./store.js。
//
// 三条硬约束（需求：错答率 0/100、弃答率 ≤10%、覆盖率 ≥90%、幻觉率 0）：
//   1. 历史断言必须带轮号引用；没有证据就弃答或先问清轮次；
//   2. 生成后检测只记录、不改正文；
//   3. 所有函数 fail-open：检测抛错时返回空 flags，绝不阻断回答。

export const ANSWER_GUARD_VERSION = 1;

/** 信心闸 schema 版本（审计行 gateVersion 机器可读版本号）。 */
export const GATE_VERSION = 1;

/**
 * 信心闸默认配置：M1 灰度默认关，保持 1.8.0 现状；显式开启才参与判定。
 * R3：minCoverage 0.6→0.15——A5 真实正确答案 citationCoverage 均值 0.26、
 * 70 题仅 1 题 ≥0.6；0.6 会把正常答案全判 degraded（审计噪音），0.15 只做粗筛。
 */
export const GATE_DEFAULTS = Object.freeze({
  enabled: false,
  minCoverage: 0.15,
  requireReadable: true,
  conflictPolicy: 'degrade',
});

export const EVIDENCE_MARK = '【有据才答·证据包】';
export const NO_EVIDENCE_MARK = '【有据才答·无证据】';
export const RULE_MARK = '【有据才答·规则】';

/** 系统提示里的短规则（静态；不随会话变化，KV cache 友好）。 */
export const RULE_TEXT = [
  '【有据才答】',
  '1. 回答涉及「之前/上次/那一轮/刚才」等会话历史时，必须写明具体轮号（如「第 37 轮」）；证据只能来自注入的【有据才答·证据包】或 session_original / session_search 的真实返回。',
  '2. 看到【有据才答·无证据】时，不得凭印象作答：明确说「没找到相关记录」，或先问清是哪一轮/哪次对话。',
  '3. 不得声称执行过某个工具（已读取/已运行/已调用/已保存等），除非本轮或本会话确有对应 tool call；不得编造文件路径、卡 id、轮号、数字和日期。',
  '4. 引用的轮号、卡路径必须真实存在；拿不准就弃答——弃答不扣分，编造才算错。',
].join('\n');

/**
 * M1.5 文本层硬规则（仅在 gate.enabled=true 时追加；默认关时系统提示逐字节不变）。
 * 复核归因：无证据仍答 + 伪造来源靠事后审计改不了模型行为，必须把判定写死在注入里。
 */
export const GATE_RULE_TEXT = [
  '【有据才答·信心闸·硬规则（本轮生效）】',
  '1. 无证据包时：必须明确说「没有相关记录/无法核实」，禁止给任何事实断言、数字、日期、轮号；禁止声称做过工具调用。',
  '2. 有证据包时：只能引用白名单内轮号；引用其他轮号=幻觉。',
  '3. 每个事实句必须带一个引用（「第 N 轮」）。',
  '4. 任何数字/日期必须能在证据摘录里逐字找到，否则不写。',
  '5. 不得声称做过未实际发生的工具调用；本轮工具结果才是证据。',
  '6. 推断句子必须逐条标「【推断】」；未标注的推断=幻觉。',
  '7. 有证据包时：证据已提供，请先引用再回答，不要回答「不知道」；无证据包时按第 1 条弃答。',
].join('\n');

/** 「之前/上次/那一轮/刚才」类线索。 */
// 2026-11-07 run C 修复：原表缺「上一次」，13 题「我们上一次聊到…」全部未触发
// 有据才答（VM 实测 13/13 伪 fabrication flag）。这里补齐「上一次」及同族说法；
// 顺序上把更长/更具体的词放在「上次」前后都不影响正确性（中文无词边界）。
export const HISTORY_CUE_RE = /(?:之前|上次|上回|上一次|上一回|上上回|上一轮|上上轮|上一轮那|那一轮|那轮|刚才|刚刚|此前|前面(?:说|讲|提到|那)|早先|原先|你(?:之前|上次|上一次)说|我(?:之前|上次|上一次)说|你说过|我说过|前面那(?:轮|次)|上一条|上一句|当时|那时|那次)/u;

/** 助手正文里「明确的会话历史断言」：比问题线索更窄，避免把「之前的版本」当历史。 */
export const HISTORY_CLAIM_RE = /(?:你说过|我说过|你上次|我上次|上次(?:说|讲|提到|那)|那一轮|刚才(?:说|讲|提到)|此前(?:说|讲|提到)|之前(?:说|讲|提到|那轮|那次)|前面那(?:轮|次)|当时(?:说|讲|提到|那)|那时(?:说|讲|提到|那)|那次(?:说|讲|提到|那))/u;

/** 弃答/不确定的正向表述；命中后不再要求轮号引用。 */
export const ABSTAIN_RE = /(?:没找到|没有找到|未找到|没有相关记录|没(?:有)?相关记录|不记得|记不清|无法确认|无法核实|无法确定|不确定|说不准|查不到|检索不到|没有证据|无证据|抱歉，我(?:没有|无法)|这条(?:我)?不知道)/u;

/** 反问澄清：允许「你是指哪一轮/哪一次」。 */
export const CLARIFY_RE = /(?:哪一轮|哪一次|哪次对话|哪条消息|你是说|你指的是|能否(?:说明|告诉)是哪)/u;

const TURN_REF_RE = /第\s*(\d{1,5})\s*轮/gu;
const TURN_ALT_RE = /\bturn\s*[=:：#]?\s*(\d{1,5})\b/giu;

const CARD_PATH_RE = /(?:^|[\s"'`（(【\[,，;；:：])((?:topics|journal|procedures|handover|flow)\/[^\s"'`）)】\]，,;；:：]+?\.(?:md|json|mdx))/gu;
const CARD_ID_RE = /\[card:([A-Za-z0-9._/-]{2,120})\]/gu;

/** 两字虚词/高频词，做关键词时剔掉，避免每条历史都命中。 */
const STOP_TERMS = new Set([
  '之前', '上次', '上回', '刚才', '刚刚', '那一', '一轮', '那轮', '前面', '此前', '当时', '早先', '原先',
  '我们', '你们', '他们', '这个', '那个', '这些', '那些', '这里', '那里', '什么', '怎么', '为什么', '如何',
  '是不是', '有没有', '能不能', '可不可以', '是否', '可以', '现在', '今天', '昨天', '明天', '然后', '就是',
  '不是', '一个', '一下', '还有', '以及', '或者', '但是', '所以', '因为', '如果', '虽然', '不过', '而且',
  '记得', '说过', '提到', '继续', '麻烦', '帮我', '告诉', '地方', '东西', '事情', '问题', '内容', '原因',
  '结果', '意思', '具体', '直接', '大概', '好像', '应该', '可能', '需要', '进行', '关于', '对于', '通过',
  '这样', '那样', '还是', '时候', '已经', '没有', '不是', '一样', '一点', '有点', '真的', '其实', '主要',
  '其中', '之后', '以后', '以前', '现在', '目前', '上次', '那次', '这次', '哪一', '哪些', '哪个',
]);

/** 检测「我执行了 X」时的工具动词。 */
const ACTION_VERBS = '(?:读取|读|打开|查看|查|搜索|搜|运行|执行|调用|写入|写|保存|创建|删除|修改|更新|备份|截断|打包|测试|部署|安装|重启|启动|构建|编译|扫描|拉取|下载|上传|发送|跑)';
const TOOL_CLAIM_RE = new RegExp(
  `我(?:刚|刚刚|刚才|已经|已|这边|这边已经)?\\s*(?:用|通过|调用(?:了)?|执行(?:了)?|运行(?:了)?|跑(?:了)?)\\s*[\`"'「]?([A-Za-z][A-Za-z0-9_.-]{2,48})`,
  'gu',
);
const ACTION_CLAIM_RE = new RegExp(
  `我(?:刚|刚刚|刚才)?\\s*(?:已经|已)?\\s*${ACTION_VERBS}(?:了|过)`,
  'gu',
);
const ACTION_CLAIM_EN_RE = /\bI\s+(?:have\s+|just\s+)?(?:already\s+)?(?:ran|executed|called|read|opened|wrote|saved|deleted|created|modified|updated|backed\s+up|truncated|tested|installed|deployed)\b/giu;
/** 未来/条件/否定/建议：同一句出现这些词就不算「已执行」。 */
const NON_ASSERTION_RE = /(?:需要|可以|建议|如果|若|将|会|要|应该|请|是否|要不要|尚未|还没|没有|无法|不能|不会|不妨|打算|准备|下一步|接下来|以后|下次|待|先|让我|我来|我将|稍后|等你|需要我)/u;
const SENTENCE_SPLIT_RE = /[。！？!?；;\n]+/u;

/**
 * 是否是「必须回头查历史」的问题。
 * @param {string} text
 * @returns {boolean}
 */
export function isHistoryQuestion(text) {
  const raw = String(text ?? '').trim();
  if (raw.length < 4 || raw.length > 4000) return false;
  if (!HISTORY_CUE_RE.test(raw)) return false;
  // 单纯的时间副词开头（"刚才我改了…"）也是历史类；但明显的指令不查历史。
  if (/^(继续|开始|执行|运行|写|改|做)(?![了的过])/u.test(raw) && !/[?？]/u.test(raw)) return false;
  return true;
}

/** 是否明确弃答/表示没有证据。 */
export function isAbstention(text) {
  return ABSTAIN_RE.test(String(text ?? ''));
}

/** 是否在向用户反问轮次（允许不引用）。 */
export function asksClarification(text) {
  const raw = String(text ?? '');
  return CLARIFY_RE.test(raw) && /[?？]/u.test(raw);
}

/**
 * 提取文本里的轮号引用（去重、升序）。
 * @param {string} text
 * @returns {number[]}
 */
export function extractTurnRefs(text) {
  const raw = String(text ?? '');
  const out = new Set();
  for (const re of [TURN_REF_RE, TURN_ALT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n >= 1 && n <= 99999) out.add(n);
    }
  }
  return [...out].sort((a, b) => a - b);
}

export function hasTurnCitation(text) {
  return extractTurnRefs(text).length > 0;
}

/**
 * 提取卡/文件引用：topics/x.md 这一类路径 + [card:...]。
 * @param {string} text
 * @returns {string[]}
 */
export function extractCardRefs(text) {
  const raw = String(text ?? '');
  const out = new Set();
  CARD_PATH_RE.lastIndex = 0;
  let m;
  while ((m = CARD_PATH_RE.exec(raw)) !== null) out.add(m[1]);
  CARD_ID_RE.lastIndex = 0;
  while ((m = CARD_ID_RE.exec(raw)) !== null) out.add(m[1]);
  return [...out];
}

/** 去掉 fenced code（``` 块）和行内代码，避免把示例数字当断言。 */
export function stripCodeBlocks(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]{1,200}`/g, ' ');
}

/**
 * 数字/日期断言提取。
 *
 * 只把「像断言」的数字当候选：日期、时间、百分比、小数、3 位以上整数、带单位的数量。
 * 1–2 位裸数字（列表序号、轮号）不在这里处理：轮号由引用检查负责，列表序号不是事实。
 *
 * @param {string} text
 * @returns {Array<{raw:string,value:string,kind:string,index:number}>}
 */
export function extractNumberClaims(text) {
  const raw = stripCodeBlocks(text);
  // 先挖掉「第 N 轮」，轮号不是数字事实，由 FAKE_TURN_REF 负责。
  let cleaned = raw.replace(/第\s*\d{1,5}\s*轮/gu, ' ');
  const out = [];
  const seen = new Set();
  const push = (rawText, kind, index) => {
    const value = normalizeNumber(rawText);
    if (value === '' || seen.has(value)) return;
    seen.add(value);
    out.push({ raw: rawText, value, kind, index: Number.isInteger(index) ? index : 0 });
  };
  const collectAndBlank = (re, kind) => {
    const ranges = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(cleaned)) !== null) {
      if (!/\d/.test(m[0])) continue;
      const start = m.index ?? 0;
      // 跳过 SHA/十六进制串的一部分：前后紧邻 16 进制字母/数字时不算独立数字。
      if (/[0-9a-fA-F]/.test(cleaned[start - 1] ?? '') && /[0-9a-fA-F]/.test(cleaned[start + m[0].length] ?? '')) continue;
      push(m[0], kind, start);
      ranges.push([start, start + m[0].length]);
    }
    if (ranges.length === 0) return;
    // 用切片替换而不是按 code point 改数组：m.index 是 UTF-16 下标，
    // 文本里可能有 emoji（代理对），按数组下标会错位。
    for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) {
      cleaned = `${cleaned.slice(0, start)}${' '.repeat(end - start)}${cleaned.slice(end)}`;
    }
  };

  // 日期/时间整体先收，避免 2026-11-06 再被拆成裸整数 2026。
  collectAndBlank(/\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}\s*日?/gu, 'date');
  collectAndBlank(/\d{1,2}\s*月\s*\d{1,2}\s*日/gu, 'date');
  collectAndBlank(/\d{1,2}:\d{2}(?::\d{2})?/gu, 'time');

  const patterns = [
    [/\d+(?:\.\d+)?\s*[%％]/gu, 'percent'],
    [/\d+(?:\.\d+)+/gu, 'decimal'],
    [/\d{1,3}(?:,\d{3})+(?:\.\d+)?/gu, 'integer'],
    [/\d+\s*(?:ms|毫秒|秒|分钟|小时|天|周|MB|GB|KB|TB|万|亿|token|tokens|字符|字节)/gu, 'quantity'],
    [/\b\d{3,}\b/gu, 'integer'],
  ];
  for (const [re, kind] of patterns) {
    // 每个 pattern 命中后同样挖空，避免 "12.5 分钟" 里再抽出一个裸 "5"。
    collectAndBlank(re, kind);
  }
  return out;
}

/** 归一化数字：去千分位、统一日期分隔符、去百分号/单位，比较用。 */
export function normalizeNumber(raw) {
  let s = String(raw ?? '').trim();
  if (s === '') return '';
  const date = s.match(/^(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?$/u);
  if (date) return `${date[1]}-${Number(date[2])}-${Number(date[3])}`;
  const md = s.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*日$/u);
  if (md) return `${Number(md[1])}-${Number(md[2])}`;
  s = s.replace(/[%％]/gu, '').replace(/,/g, '');
  const m = s.match(/(-?\d+(?:\.\d+)?)/u);
  if (!m) return '';
  const n = m[1];
  if (n.includes('.')) return String(Number(n));
  return String(Number(n));
}

/**
 * 从一段「证据文本」里抽出所有数字值（宽松口径，只用于判断是否出现过）。
 * @param {string} text
 * @returns {Set<string>}
 */
export function numberCorpus(text) {
  const set = new Set();
  const raw = stripCodeBlocks(text);
  // 日期/时间先整体收进来，否则 2026-11-06 只会被拆成 2026 / 11 / 06，
  // 同一日期在正文里就会被误判为「找不到出处」。
  const dateRe = /\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}\s*日?/gu;
  let dm;
  while ((dm = dateRe.exec(raw)) !== null) {
    set.add(dm[0].trim());
    set.add(normalizeNumber(dm[0]));
  }
  const timeRe = /\d{1,2}:\d{2}(?::\d{2})?/gu;
  let tm;
  while ((tm = timeRe.exec(raw)) !== null) set.add(tm[0]);
  const re = /\d+(?:[.,]\d+)*/gu;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const cleaned = m[0].replace(/,/g, '');
    set.add(cleaned);
    set.add(String(Number(cleaned)));
    // 12.5% / 12.5MB：值本身也要能命中。
    const num = cleaned.match(/^-?\d+(?:\.\d+)?/u);
    if (num) set.add(String(Number(num[0])));
  }
  return set;
}

/** 数字断言是否能在语料里找到。 */
export function isGroundedNumber(claim, corpusSet) {
  const value = claim.value;
  if (value === '') return true;
  if (corpusSet.has(value)) return true;
  // 日期允许语料里以 2026-11-06 / 2026/11/6 / 2026年11月6日 任一形式出现。
  if (claim.kind === 'date') {
    const parts = value.split('-');
    if (parts.length === 3) {
      const [y, mo, d] = parts;
      const forms = [
        `${y}-${mo}-${d}`, `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
        `${y}/${mo}/${d}`, `${y}年${mo}月${d}日`, `${y}年${String(mo).padStart(2, '0')}月${String(d).padStart(2, '0')}日`,
      ];
      return forms.some((f) => corpusSet.has(f) || [...corpusSet].some((v) => v.includes(f)));
    }
  }
  // 百分比/带单位：值命中即可（12.5% 与 12.5 视为同一个数）。
  if (corpusSet.has(value)) return true;
  for (const candidate of corpusSet) {
    if (candidate === value) return true;
    if (candidate.replace(/^0+(?=\d)/u, '') === value.replace(/^0+(?=\d)/u, '')) return true;
  }
  return false;
}

/**
 * 归一化信心闸配置：坏值回默认，绝不抛（与 normalizeAnswerGuardConfig 同口径）。
 * @param {object} raw
 * @returns {{enabled:boolean,minCoverage:number,requireReadable:boolean,conflictPolicy:'degrade'|'abstain'}}
 */
export function normalizeGateConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const coverage = Number(cfg.minCoverage);
  return {
    enabled: cfg.enabled === true,
    minCoverage: Number.isFinite(coverage) ? Math.max(0, Math.min(1, coverage)) : GATE_DEFAULTS.minCoverage,
    requireReadable: cfg.requireReadable !== false,
    conflictPolicy: cfg.conflictPolicy === 'abstain' ? 'abstain' : 'degrade',
  };
}

const GATE_INFERENCE_RE = /(?:推断|推测|应该是|可能|大概)/u;
const GATE_INFERENCE_MARK = '【推断】';
/** 降级答案的首句标注（与设计 §2.1 的「首句标注不确定」一致）。 */
export const GATE_DEGRADED_RE = /^(?:不确定|降级|无法确认|无法核实|【不确定】)/u;

function gateSentences(text) {
  return String(text ?? '')
    .split(/[。！？!?；;\n]+/u)
    .map((part) => part.trim())
    .filter((part) => part !== '' && /[\p{L}\p{N}]/u.test(part));
}

/**
 * 信心闸三态判定（纯函数、确定性、短路；禁止任何模型自报信心参与）。
 *
 * 输入信号全部来自可机读文本/结构：
 *   question, draft/text, evidencePacket/evidenceText, evidenceTurns,
 *   contextText, historyQuestion, zeroHit, evidenceAttempted, conflictCount
 *   （检索层可选提供的确定性冲突计数）, cfg/gateCfg。
 * 输出：{mode:'answer'|'degraded'|'abstain', reasons[], signals{}, citations[], assertions{}}
 *
 * - cfg.enabled !== true 时恒返回 answer（灰度默认关，保持 1.8.0 现状）。
 * - R2：gate 只对「历史类且确实走了证据检索」的回合生效；非历史轮恒 answer
 *   （reasons=['NOT_HISTORY']），避免正常问答被当成「无证据→abstain」误判。
 * - abstain 先于 degraded 判定（先严后宽）：零证据 / 引用不可回读 / 无源数字。
 * - fail-open 由调用方兜底：本函数只做判定，异常由 auditTurn catch 后不改变原 decision。
 *
 * @param {object} [input]
 * @returns {{mode:string,reasons:string[],signals:object,citations:object[],assertions:object}}
 */
export function decideAnswerMode(input = {}) {
  const cfg = normalizeGateConfig(input.cfg ?? input.gateCfg);
  const draft = String(input.draft ?? input.text ?? '');
  const evidencePacket = String(input.evidencePacket ?? input.evidenceText ?? '');
  const evidenceTurns = Array.isArray(input.evidenceTurns)
    ? input.evidenceTurns.map(Number).filter(Number.isInteger)
    : [];
  const question = String(input.question ?? '');
  const contextText = String(input.contextText ?? '');
  const sentences = gateSentences(draft);
  const refs = extractTurnRefs(draft);
  const citations = refs.map((turn) => ({
    turn,
    readable: evidenceTurns.includes(turn) && evidencePacket.trim() !== '',
  }));
  const evidenceCount = input.zeroHit === true
    ? 0
    : (evidenceTurns.length > 0 ? evidenceTurns.length : (evidencePacket.trim() !== '' ? 1 : 0));
  // R2 阻断 2：gate 只对「历史类 + 确实走了证据检索」的回合生效。
  // 非历史轮没有注入证据，不能按「零证据→abstain」误判正常问答。
  const historyQuestion = input.historyQuestion === true;
  const evidenceAttempted = input.evidenceAttempted === true
    || (historyQuestion && (input.zeroHit === true || evidenceCount > 0));
  const corpus = numberCorpus([contextText, evidencePacket, question].join('\n'));

  let total = 0;
  let cited = 0;
  let inferred = 0;
  let ungroundedCount = 0;
  let unmarkedInference = 0;
  let uncitedCount = 0;
  let timeConsistency = true;
  for (const sentence of sentences) {
    total += 1;
    const marked = sentence.includes(GATE_INFERENCE_MARK);
    if (marked) inferred += 1;
    const sentenceRefs = extractTurnRefs(sentence);
    if (marked || sentenceRefs.length > 0) cited += 1;
    else if (!isAbstention(sentence) && !asksClarification(sentence)) uncitedCount += 1;
    if (!marked && GATE_INFERENCE_RE.test(sentence)) unmarkedInference += 1;
    if (marked) continue; // 推断标注内容里的数字不计「无源数字」
    for (const claim of extractNumberClaims(sentence)) {
      if (isGroundedNumber(claim, corpus)) continue;
      ungroundedCount += 1;
      if (claim.kind === 'date' || claim.kind === 'time') timeConsistency = false;
    }
  }
  const citationCoverage = total === 0 ? 1 : cited / total;
  const citationReadable = refs.length === 0
    ? true
    : citations.every((item) => item.readable === true);
  // 冲突计数由检索层确定性计算后传入；模型自报不算。
  const conflictCount = Number.isInteger(input.conflictCount) && input.conflictCount > 0
    ? input.conflictCount
    : 0;
  const assertions = { total, cited, inferred, ungrounded: ungroundedCount };
  // FIX-05 C3：证据单元数独立于「证据包是否非空」计算；B 题（canAbstain=true）
  // 且 evidenceUnits=0 时，输出层必须强制 abstain（不受 gate 灰度开关影响）。
  const evidenceUnits = normalizeEvidenceUnits(input.evidenceUnits, evidenceTurns, evidencePacket);
  const canAbstain = input.canAbstain === true;
  const signals = {
    enabled: cfg.enabled,
    historyQuestion,
    evidenceAttempted,
    evidenceCount,
    evidenceUnits,
    canAbstain,
    citationReadable,
    conflictCount,
    timeConsistency,
    ungroundedCount,
    unmarkedInference,
    citationCoverage: Number(citationCoverage.toFixed(3)),
    citationCount: refs.length,
    uncitedCount,
    assertionCount: total,
  };

  // FIX-05 C3：B 题 + 0 证据单元 → 强制弃答。先于 gate 开关，保证默认关也生效。
  if (canAbstain && evidenceUnits === 0) {
    return { mode: 'abstain', reasons: ['CAN_ABSTAIN_NO_EVIDENCE'], signals, citations, assertions };
  }

  if (!cfg.enabled) {
    return { mode: 'answer', reasons: ['GATE_DISABLED'], signals, citations, assertions };
  }
  // R2：非历史回合恒 answer；历史类但检索未真正发生的回合也 fail-open answer。
  if (!historyQuestion) {
    return { mode: 'answer', reasons: ['NOT_HISTORY'], signals, citations, assertions };
  }
  if (!evidenceAttempted) {
    return { mode: 'answer', reasons: ['EVIDENCE_NOT_ATTEMPTED'], signals, citations, assertions };
  }

  // 1) abstain（先严）：零证据 / 引用不可回读 / 无源数字。
  if (evidenceCount === 0) {
    return { mode: 'abstain', reasons: ['NO_EVIDENCE'], signals, citations, assertions };
  }
  if (cfg.requireReadable && citationReadable === false) {
    return { mode: 'abstain', reasons: ['CITATION_UNREADABLE'], signals, citations, assertions };
  }
  if (ungroundedCount > 0) {
    return { mode: 'abstain', reasons: ['UNGROUNDED_NUMBER'], signals, citations, assertions };
  }

  // 2) degraded：证据冲突 / 时间不一致 / 覆盖不足 / 未标注推断。
  if (conflictCount > 0) {
    if (cfg.conflictPolicy === 'abstain') {
      return { mode: 'abstain', reasons: ['CONFLICT'], signals, citations, assertions };
    }
    return { mode: 'degraded', reasons: ['CONFLICT'], signals, citations, assertions };
  }
  if (timeConsistency === false) {
    return { mode: 'degraded', reasons: ['TIME_INCONSISTENT'], signals, citations, assertions };
  }
  if (citationCoverage < cfg.minCoverage) {
    return { mode: 'degraded', reasons: ['LOW_COVERAGE'], signals, citations, assertions };
  }
  if (unmarkedInference > 0) {
    return { mode: 'degraded', reasons: ['UNMARKED_INFERENCE'], signals, citations, assertions };
  }
  // 3) 来源闸兜底：answer 状态下存在无引用事实断言 → 强制降级。
  if (uncitedCount > 0) {
    return { mode: 'degraded', reasons: ['UNCITED_ASSERTION'], signals, citations, assertions };
  }
  return { mode: 'answer', reasons: ['OK'], signals, citations, assertions };
}

/* ---------------- FIX-05：answerMode / evidenceUnits / sourceGate / tier ---------------- */
//
// 目的：after 弃答误判修复（C1+C2+C3，确定性、无新增模型调用）。
// 五个字段是 auditTurn/buildAuditRow 的纯输出，不依赖模型自报、不改变原 flags/正文：
//   answerMode    answered | abstained | clarified（三者互斥）
//   evidenceUnits 题级证据单元数（evidenceTurns 条数，或证据包「- 第 N 轮」行数）
//   sourceGate.hard 硬来源闸（改弃答）：数字无源/假轮号/假工具/假卡/历史断言无引用/无证据硬答
//   sourceGate.soft 软降级提示（不改 mode）：gate.reasons + unsupported 级 flags
//   tier          fixture.difficulty + questionType（调用方传入，缺省 unknown/unknown）

export const ANSWER_MODE_VALUES = Object.freeze(['answered', 'abstained', 'clarified']);

/** 明确算「硬来源」的 flag code（severity=fabrication 之外的两类历史软 flag 也纳入硬挡）。 */
export const SOURCE_GATE_HARD_CODES = Object.freeze([
  'UNGROUNDED_NUMBER',
  'FAKE_TURN_REF',
  'FAKE_TOOL_CLAIM',
  'FAKE_CARD_REF',
  'HISTORY_CLAIM_NO_CITATION',
  'ANSWERED_WITHOUT_EVIDENCE',
]);

const SOURCE_GATE_SOFT_MAX = 12;

/** 归一化 evidenceUnits：显式传入优先；否则 evidenceTurns 条数；否则数证据包「- 第 N 轮」行。 */
export function normalizeEvidenceUnits(explicit, evidenceTurns, evidencePacket = '') {
  const n = Number(explicit);
  if (Number.isInteger(n) && n >= 0) return n;
  if (Array.isArray(evidenceTurns) && evidenceTurns.length > 0) return evidenceTurns.length;
  const text = String(evidencePacket ?? '');
  const matches = text.match(/^[ \t]*-\s*第\s*\d+\s*轮/gmu);
  return matches ? matches.length : 0;
}

/** 硬来源闸 code 集合（确定性、去重、保持 flags 顺序）。 */
export function collectHardFlagCodes(flags = []) {
  const out = [];
  for (const flag of Array.isArray(flags) ? flags : []) {
    const code = String(flag?.code ?? '');
    if (code === '') continue;
    const hard = flag?.severity === 'fabrication' || SOURCE_GATE_HARD_CODES.includes(code);
    if (hard && !out.includes(code)) out.push(code);
  }
  return out;
}

/**
 * 双通道来源闸：hard=硬挡（改弃答），soft=降级提示（只记录）。
 * soft 取 gate.reasons（含 OK/NOT_HISTORY/GATE_DISABLED 等诊断）+ unsupported 级 flag code。
 */
export function buildSourceGate({ flags = [], gate = null } = {}) {
  const hard = collectHardFlagCodes(flags);
  const soft = [];
  const push = (code) => {
    const c = String(code ?? '');
    if (c !== '' && !hard.includes(c) && !soft.includes(c) && soft.length < SOURCE_GATE_SOFT_MAX) soft.push(c);
  };
  const reasons = Array.isArray(gate?.reasons) ? gate.reasons : [];
  for (const reason of reasons) push(reason);
  for (const flag of Array.isArray(flags) ? flags : []) {
    if (flag?.severity !== 'fabrication') push(flag?.code);
  }
  return { hard, soft };
}

/** 答案里是否有「可在证据中回读」的实质陈述（含否定式结论）。 */
export function hasReadableSubstantiveAnswer(text, { evidenceText = '', evidenceTurns = [] } = {}) {
  const raw = String(text ?? '').trim();
  if (raw === '') return false;
  const packet = String(evidenceText ?? '');
  const turns = Array.isArray(evidenceTurns) ? evidenceTurns : [];
  // 1) 带可回读轮号的实质句：引用轮到 evidenceTurns 里，且证据包非空。
  if (packet.trim() !== '') {
    const readableRef = extractTurnRefs(raw).some((ref) => turns.includes(ref));
    if (readableRef) return true;
  }
  // 2) 无显式轮号时，用内容词与证据文本的重叠做回读判定（CJK bigram/英文词，已滤停用词）。
  //    只用权重 ≥1.15 的实词，且排除弃答套话里的元词，避免「没有找到记录」因证据里有「记录」被误判 answered。
  if (packet.trim() !== '') {
    const lowered = packet.toLowerCase();
    const metaTerms = new Set(['记录', '相关', '问题', '内容', '信息', '证据', '没有', '无法', '答案', '消息', '轮次', '会话', '东西', '事情', '东西']);
    for (const { term, weight } of extractKeywords(raw)) {
      if (term.length < 2 || weight < 1.15 || metaTerms.has(term)) continue;
      if (lowered.includes(term)) return true;
    }
  }
  // 3) 完全没有证据（非历史/未检索）时，只有「非弃答、非反问」的实质句才算 answered。
  const sentences = gateSentences(raw).filter((sentence) => !isAbstention(sentence) && !asksClarification(sentence));
  return sentences.some((sentence) => sentence.replace(/[\s\p{P}]/gu, '').length >= 4);
}

/**
 * 三态 answerMode：answered / abstained / clarified，严格互斥。
 * C1：只有无实质内容/无证据化断言才 abstained；软 flag 不改 mode；hard 才改弃答。
 * C3：B 题（canAbstain=true）且 evidenceUnits=0 → 强制 abstained。
 */
export function deriveAnswerMode({
  text = '',
  flags = [],
  gate = null,
  evidenceText = '',
  evidenceTurns = [],
  evidenceUnits = null,
  canAbstain = false,
} = {}) {
  const raw = String(text ?? '');
  const units = normalizeEvidenceUnits(evidenceUnits, evidenceTurns, evidenceText);
  const hard = collectHardFlagCodes(flags);
  const clarified = asksClarification(raw);
  if (clarified) return 'clarified';
  if (raw.trim() === '') return 'abstained';
  if (hard.length > 0) return 'abstained';
  if (canAbstain === true && units === 0) return 'abstained';
  const abstainedWording = isAbstention(raw);
  if (abstainedWording && !hasReadableSubstantiveAnswer(raw, { evidenceText, evidenceTurns })) {
    return 'abstained';
  }
  return 'answered';
}

/** 组合 FIX-05 五个字段 + 互斥布尔（供 auditTurn/buildAuditRow 直接铺进 checks/row）。 */
export function deriveAnswerModeFields(input = {}) {
  const answerMode = deriveAnswerMode(input);
  const evidenceUnits = normalizeEvidenceUnits(input.evidenceUnits, input.evidenceTurns, input.evidenceText);
  const sourceGate = buildSourceGate({ flags: input.flags, gate: input.gate });
  const difficulty = String(input.difficulty ?? '').trim() || 'unknown';
  const questionType = String(input.questionType ?? '').trim() || 'unknown';
  return {
    answerMode,
    answered: answerMode === 'answered',
    abstained: answerMode === 'abstained',
    clarified: answerMode === 'clarified',
    evidenceUnits,
    sourceGate,
    tier: `${difficulty}/${questionType}`,
  };
}

/**
 * FIX-05 投递层弃答文案：只保留弃答模板，不保留任何解释性正文。
 * 宿主没有 message transform 钩子（见 src/answer/index.js HOST_CAPABILITY），所以
 * 运行时「用户可见正文」的最终替换由渲染/投递端消费 row.delivery 实现；本函数是
 * 投递判定的单一确定性实现（无模型调用、可复算）。
 */
export const ABSTAIN_DELIVERY_TEXT = '没有找到相关记录，无法核实；不提供猜测性回答。';

/**
 * FIX-05 C3 契约层（可选补充）：B 题 0 证据时 pre-step 注入的隐藏强制弃答指令。
 * 只给指令、不保证模型服从——宿主没有 message transform，live 强制改正文做不到；
 * 与 row.delivery 兜底叠加使用。测试/审计用固定标记判存在。
 */
export const FORCE_ABSTAIN_MARK = '【有据才答·强制弃答】';
export const FORCE_ABSTAIN_TEXT = '该问题指向的条目不在历史记录中；直接回答「未出现在历史记录里」，不要编造细节。';

/** 渲染隐藏强制弃答指令（纯函数，固定文本，便于测试逐字断言）。 */
export function renderForceAbstainDirective() {
  return `${FORCE_ABSTAIN_MARK}\n${FORCE_ABSTAIN_TEXT}`;
}

/**
 * 计算投递结果（C3 + C2）。
 * - hard 来源 flag（数字无源/假轮号/假工具/假卡/历史断言无引用/无证据硬答）→ 弃答文案；
 * - B 题（canAbstain=true）且 evidenceUnits=0 → 弃答文案；
 * - 元数据缺失（两者都没传）→ { mode:'not-applicable', forced:false, text:原文案 }，不猜测；
 * - 其余（含 soft flag）→ 原文案（软 flag 不阻断投递）。
 *
 * @param {{text?:string, canAbstain?:boolean|null, evidenceUnits?:number|null,
 *          evidenceTurns?:number[], evidenceText?:string, flags?:Array<object>}} [input]
 * @returns {{mode:'abstained'|'answered'|'not-applicable', forced:boolean,
 *            reason:string, metaAvailable:boolean, text:string}}
 */
export function resolveDelivery(input = {}) {
  const original = String(input.text ?? '');
  const hard = collectHardFlagCodes(input.flags);
  const metaAvailable = input.canAbstain !== undefined && input.canAbstain !== null
    || (Number.isInteger(input.evidenceUnits) && input.evidenceUnits >= 0);
  const units = normalizeEvidenceUnits(input.evidenceUnits, input.evidenceTurns, input.evidenceText);
  if (hard.length > 0) {
    return {
      mode: 'abstained',
      forced: true,
      reason: `HARD_SOURCE:${hard.join(',')}`,
      metaAvailable,
      text: ABSTAIN_DELIVERY_TEXT,
    };
  }
  if (input.canAbstain === true && units === 0) {
    return {
      mode: 'abstained',
      forced: true,
      reason: 'CAN_ABSTAIN_NO_EVIDENCE',
      metaAvailable,
      text: ABSTAIN_DELIVERY_TEXT,
    };
  }
  if (!metaAvailable) {
    return { mode: 'not-applicable', forced: false, reason: 'META_UNAVAILABLE', metaAvailable: false, text: original };
  }
  return { mode: 'answered', forced: false, reason: 'OK', metaAvailable: true, text: original };
}

/**
 * 从问题里抽检索关键词：引号内容权重最高，其次 CJK bigram 与英文词。
 * @param {string} question
 * @returns {Array<{term:string,weight:number}>}
 */
export function extractKeywords(question) {
  const raw = String(question ?? '');
  const picked = new Map();
  const add = (term, weight) => {
    const t = String(term ?? '').trim().toLowerCase();
    if (t.length < 2 || t.length > 40) return;
    if (STOP_TERMS.has(t)) return;
    if (/^\d+$/u.test(t)) return;
    picked.set(t, Math.max(picked.get(t) ?? 0, weight));
  };

  const quoted = /[「“"`]([^」”"`\n]{1,40})[」”"`]/gu;
  let m;
  while ((m = quoted.exec(raw)) !== null) add(m[1], 4);

  const cjkRuns = raw.match(/[\u4e00-\u9fff]{2,}/gu) ?? [];
  const PARTICLE_RE = /[的了吗呢吧啊个这那是和与就都还又也我你他她它]/u;
  for (const run of cjkRuns) {
    const chars = [...run];
    // 先整段（2–10 字）当候选，再补 bigram；过长整段会被 stopword 或重复压掉。
    if (chars.length >= 2 && chars.length <= 10) add(run, 1.2);
    for (let i = 0; i + 2 <= chars.length; i += 1) {
      const bigram = chars[i] + chars[i + 1];
      if (!STOP_TERMS.has(bigram) && !PARTICLE_RE.test(bigram)) add(bigram, 1);
    }
    // 三字以上专名（人名/工具名/文件名）额外加权。
    for (let i = 0; i + 3 <= chars.length; i += 1) {
      const tri = chars.slice(i, i + 3).join('');
      if (!STOP_TERMS.has(tri) && !PARTICLE_RE.test(tri)) add(tri, 1.15);
    }
  }

  const latin = raw.match(/[A-Za-z][A-Za-z0-9_./-]{2,40}/gu) ?? [];
  for (const word of latin) {
    if (/^(the|and|for|with|from|that|this|you|are|was|were|have|has|had|not|but|what|when|where|which|who|why|how)$/iu.test(word)) continue;
    add(word, 1.6);
  }

  return [...picked.entries()]
    .map(([term, weight]) => ({ term, weight }))
    .sort((a, b) => b.weight - a.weight || b.term.length - a.term.length || a.term.localeCompare(b.term))
    .slice(0, 28);
}

function countOccurrences(haystack, needle) {
  if (needle === '' || haystack === '') return 0;
  let count = 0;
  let from = 0;
  while (count < 3) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    count += 1;
    from = at + needle.length;
  }
  return count;
}

/**
 * 一轮历史的可检索文本。纯函数。
 * @param {{turn:number,user?:string,assistant?:string,tools?:string}} turn
 */
export function turnText(turn) {
  return [turn?.user ?? '', turn?.assistant ?? '', turn?.tools ?? ''].join('\n').toLowerCase();
}

/**
 * 给单个历史轮打分。
 * @param {{turn:number,user?:string,assistant?:string,tools?:string}} turn
 * @param {Array<{term:string,weight:number}>} keywords
 * @returns {{score:number,hits:string[]}}
 */
export function scoreTurn(turn, keywords) {
  const text = turnText(turn);
  const userText = String(turn?.user ?? '').toLowerCase();
  if (text === '') return { score: 0, hits: [] };
  const chars = text.length;
  const lengthPenalty = Math.sqrt(1 + chars / 1200);
  let score = 0;
  const hits = [];
  for (const { term, weight } of keywords) {
    const tf = countOccurrences(text, term);
    if (tf === 0) continue;
    const inUser = userText.includes(term) ? 2 : 1;
    score += weight * Math.min(tf, 3) * inUser;
    hits.push(term);
  }
  return { score: score / lengthPenalty, hits };
}

/**
 * 检索会话历史。
 *
 * @param {{turns:Array<{turn:number,user?:string,assistant?:string,tools?:string}>,
 *          question:string,currentTurn:number,maxItems?:number,minScore?:number}} input
 * @returns {{zeroHit:boolean,items:Array<object>,keywords:Array<object>,queryTerms:string[]}}
 */
export function retrieveEvidence({
  turns = [],
  question = '',
  currentTurn = Number.POSITIVE_INFINITY,
  maxItems = 3,
  minScore = 1.8,
} = {}) {
  const keywords = extractKeywords(question);
  const limit = Math.max(1, Math.min(10, Number(maxItems) || 3));
  const threshold = Number.isFinite(Number(minScore)) ? Number(minScore) : 1.8;
  const refs = extractTurnRefs(question);
  // 「刚才/刚刚」优先最近三轮；其余不受限。
  const recentOnly = /刚才|刚刚|上一条|上一句/u.test(String(question ?? ''));

  const candidates = [];
  for (const turn of Array.isArray(turns) ? turns : []) {
    const n = Number(turn?.turn);
    if (!Number.isInteger(n) || n < 1) continue;
    if (n >= Number(currentTurn)) continue;
    if (recentOnly && n < Number(currentTurn) - 4) continue;
    candidates.push(turn);
  }

  // 问题里点名了轮号：直接取该轮，不做关键词猜。
  if (refs.length > 0) {
    const named = refs
      .map((ref) => candidates.find((turn) => Number(turn.turn) === ref))
      .filter(Boolean)
      .map((turn) => ({ ...turn, score: 99, hits: [`turn:${turn.turn}`], namedRef: true }));
    if (named.length > 0) {
      return {
        zeroHit: false,
        items: named.slice(0, limit),
        keywords,
        queryTerms: keywords.map((k) => k.term),
        namedTurnRef: true,
      };
    }
  }

  // IDF：只按词频打分会让「问题/东西/之前」这类高频词压过专名；按在候选轮里
  // 的文档频率降权后，稀有专名（备份、音程、turnmap）才会真正决定命中。
  const df = new Map();
  for (const { term } of keywords) {
    let count = 0;
    for (const turn of candidates) {
      if (turnText(turn).includes(term)) count += 1;
    }
    df.set(term, count);
  }
  const total = Math.max(1, candidates.length);
  const weightedKeywords = keywords.map(({ term, weight }) => ({
    term,
    weight: weight * (0.5 + Math.log(1 + total / (1 + (df.get(term) ?? 0)))),
  }));

  // 稀有词加分：只出现在少数轮里的词（df ≤ max(8, 10% 候选轮)）单独再算一遍。
  // 纯 IDF 仍会让「问题/之前/东西」这类词在长会话里累积到压过专名；稀有词
  // 二次打分把专名（备份、turnmap、音程）重新顶上来。这是 2026-11-06 用
  // 100 题真实历史问题校准出来的（见 eval/REPORT）。
  const rareKeywords = weightedKeywords.filter(({ term }) => {
    const count = df.get(term) ?? 0;
    return count >= 1 && count <= Math.max(8, Math.ceil(total * 0.1));
  });

  const scored = [];
  for (const turn of candidates) {
    const { score, hits } = scoreTurn(turn, weightedKeywords);
    const rare = rareKeywords.length > 0 ? scoreTurn(turn, rareKeywords).score : 0;
    // 稀有词优先：历史检索要的是「哪一轮真的提过这个专名」，不是谁篇幅长。
    // 没有稀有词（短问题/泛问）时才退回 IDF 词频。
    const combined = rareKeywords.length >= 2 ? rare + score * 0.25 : score;
    if (combined <= 0) continue;
    scored.push({ ...turn, score: combined, hits });
  }
  scored.sort((a, b) => b.score - a.score || b.turn - a.turn);
  const chosen = scored.filter((item) => item.score >= threshold).slice(0, limit);

  return {
    zeroHit: chosen.length === 0,
    items: chosen.map((item) => ({ ...item, score: Number(item.score.toFixed(3)) })),
    keywords,
    queryTerms: keywords.map((k) => k.term),
  };
}

const EXCERPT_MAX = 420;

function clip(text, max = EXCERPT_MAX) {
  const raw = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max - 1)}…`;
}

/**
 * 渲染证据包（隐藏注入；模型可见，聊天不露脸）。
 * @param {object} result from retrieveEvidence
 * @param {{question?:string,maxChars?:number,gate?:boolean}} [options]
 * @returns {string}
 */
export function renderEvidencePacket(result, { question = '', maxChars = 4000, gate = false } = {}) {
  if (!result || !Array.isArray(result.items) || result.items.length === 0) return '';
  const gateOn = gate === true;
  const whitelist = result.items.map((item) => String(item.turn)).join(',');
  const budget = Math.max(400, Math.min(4000, Number(maxChars) || 1200));
  const lines = [
    EVIDENCE_MARK,
    `本轮问题需要回头查会话历史：${clip(question, 160)}`,
    '检索到的真实轮次（只许引用下列轮号，引用格式「第 N 轮」）：',
  ];
  // M1.5：gate 开启时先给机器可读白名单行（默认关不输出，保持逐字节兼容）。
  if (gateOn) lines.push(`允许引用的轮号白名单：${whitelist}`);
  for (const item of result.items) {
    // R1：excerpt 窗口 300→800，避免 gold 落在 300 字符外时「注入了但看不到答案」。
    const excerpt = clip(item.assistant || item.user || '', 800);
    lines.push(`- 第 ${item.turn} 轮`);
    if (item.user) lines.push(`  用户：${clip(item.user, 150)}`);
    if (excerpt) lines.push(`  助手：${excerpt}`);
  }
  lines.push('引用规则：回答第一句先写「第 N 轮：」；证据里没有的内容不许补；证据不足就弃答。');
  // M1.5：gate 开启时把硬规则写死在注入文本里；默认关时以下整段不出现。
  if (gateOn) {
    lines.push(
      '【信心闸·硬规则】',
      `1. 只能引用白名单内轮号：${whitelist}；引用其他轮号=幻觉。`,
      '2. 每个事实句必须带一个引用（「第 N 轮」）。',
      '3. 任何数字/日期必须能在上面的证据摘录里逐字找到，找不到就不许写。',
      '4. 不得声称做过未实际发生的工具调用；本轮工具结果才是证据。',
      '5. 推断句子必须逐条标「【推断】」；未标注的推断=幻觉。',
      '6. 证据已提供；请先引用再回答，不要回答「不知道」。',
    );
  }
  let text = lines.join('\n');
  if (text.length > budget) text = `${text.slice(0, Math.max(0, budget - 1))}…`;
  return text;
}

/**
 * 渲染「无证据」标记。
 * @param {{question?:string,queryTerms?:string[],gate?:boolean}} input
 * @returns {string}
 */
export function renderNoEvidence({ question = '', queryTerms = [], gate = false } = {}) {
  const terms = Array.isArray(queryTerms) && queryTerms.length > 0
    ? queryTerms.slice(0, 8).join('、')
    : '（无可用检索词）';
  const lines = [
    NO_EVIDENCE_MARK,
    `本轮问题涉及会话历史，但检索层零命中：没有找到可核实的轮次（检索词：${terms}）。`,
    '规则：不许凭印象回答，也不许猜轮号。明确说「没找到相关记录」，或先问清是哪一轮/哪次对话。',
    '弃答不扣分，编造轮号/数字/执行过程才算错。',
  ];
  // M1.5：gate 开启时从「提醒」升为「判定」；默认关时原数组逐字节不变。
  if (gate === true) {
    lines.splice(1, 0,
      '【判定·必须弃答】本轮无证据：没有相关记录/无法核实。',
      '禁止给出任何事实断言、数字、日期或轮号；禁止声称做过任何工具调用；不要猜测、不要补全。直接说「没有找到相关记录」，或问清是哪一轮/哪次对话。',
    );
  }
  return lines.join('\n');
}

/** 系统提示不可用时的兜底规则消息；gate=true 时追加 M1.5 硬规则。 */
export function renderRuleBlock({ gate = false } = {}) {
  return gate === true
    ? [RULE_MARK, RULE_TEXT, GATE_RULE_TEXT].join('\n')
    : [RULE_MARK, RULE_TEXT].join('\n');
}

/**
 * 检测「声称执行了工具」。
 * @param {string} text
 * @param {string[]} knownTools
 * @returns {Array<{kind:'tool'|'action',tool:string|null,phrase:string}>}
 */
export function detectToolClaims(text, knownTools = []) {
  const raw = stripCodeBlocks(text);
  const known = new Set((Array.isArray(knownTools) ? knownTools : []).map((name) => String(name).toLowerCase()));
  const claims = [];
  for (const sentence of raw.split(SENTENCE_SPLIT_RE)) {
    const line = sentence.trim();
    if (line === '') continue;
    if (NON_ASSERTION_RE.test(line)) continue;
    TOOL_CLAIM_RE.lastIndex = 0;
    let m;
    while ((m = TOOL_CLAIM_RE.exec(line)) !== null) {
      const tool = m[1].toLowerCase();
      // 只认已知工具名，或明显的工具名形态（含下划线/x_ 前缀）。避免把普通英文单词当工具。
      if (!known.has(tool) && !/^[a-z]+_[a-z0-9_]+$/u.test(tool)) continue;
      claims.push({ kind: 'tool', tool, phrase: line.slice(0, 160) });
    }
    if (ACTION_CLAIM_RE.test(line) || ACTION_CLAIM_EN_RE.test(line)) {
      ACTION_CLAIM_RE.lastIndex = 0;
      ACTION_CLAIM_EN_RE.lastIndex = 0;
      claims.push({ kind: 'action', tool: null, phrase: line.slice(0, 160) });
    } else {
      ACTION_CLAIM_RE.lastIndex = 0;
      ACTION_CLAIM_EN_RE.lastIndex = 0;
    }
  }
  return claims;
}

/**
 * 生成后审计：只返回 flags，不改任何正文。
 *
 * @param {{
 *   text:string, turn:number, question?:string,
 *   historyQuestion?:boolean, zeroHit?:boolean, evidenceTurns?:number[],
 *   toolNames?:string[], sessionToolNames?:string[], sessionTurns?:number[],
 *   contextText?:string, knownTools?:string[],
 *   cardExists?:(ref:string)=>boolean,
 *   evidenceText?:string, gateCfg?:object, conflictCount?:number,
 * }} input
 * @returns {{verdict:'clean'|'flagged',flags:Array<object>,checks:object}}
 */
export function auditTurn(input = {}) {
  const text = String(input.text ?? '');
  const turn = Number(input.turn);
  const question = String(input.question ?? '');
  const historyQuestion = input.historyQuestion === true;
  const zeroHit = input.zeroHit === true;
  const evidenceTurns = Array.isArray(input.evidenceTurns) ? input.evidenceTurns.map(Number).filter(Number.isInteger) : [];
  // FIX-05：evidenceUnits 主口径 = evidenceTurns 题级计数（live 恒可用，不依赖 meta）。
  // 显式传入仅作调用方覆盖（eval 映射没有该字段时绝不据此改 0）。
  const derivedEvidenceUnits = evidenceTurns.length;
  const effectiveEvidenceUnits = Number.isInteger(input.evidenceUnits) && input.evidenceUnits >= 0
    ? input.evidenceUnits
    : derivedEvidenceUnits;
  const toolNames = (Array.isArray(input.toolNames) ? input.toolNames : []).map(String);
  const sessionToolNames = (Array.isArray(input.sessionToolNames) ? input.sessionToolNames : []).map(String);
  const sessionTurns = (Array.isArray(input.sessionTurns) ? input.sessionTurns : []).map(Number).filter(Number.isInteger);
  const knownTools = Array.isArray(input.knownTools) ? input.knownTools : [];
  const cardExists = typeof input.cardExists === 'function' ? input.cardExists : () => true;
  const contextText = String(input.contextText ?? '');
  const contextTruncated = input.contextTruncated === true;
  // FIX-05：B 题标记 / 分层元数据 / 证据单元显式值（可选；缺省从 evidenceTurns/evidenceText 推导）。
  const canAbstain = input.canAbstain === true;
  const difficulty = String(input.difficulty ?? '');
  const questionType = String(input.questionType ?? '');
  const flags = [];
  const add = (code, detail, severity = 'fabrication', evidence = '') => {
    flags.push({ code, detail, severity, evidence: clip(evidence, 300) });
  };
  const checks = {
    abstained: isAbstention(text),
    askedClarification: asksClarification(text),
    turnRefs: extractTurnRefs(text),
    cardRefs: extractCardRefs(text),
    numbers: [],
    toolClaims: [],
    historyQuestion,
    zeroHit,
    evidenceTurns,
    // 2026-11-07: 取证上下文截断标记；评分器可对无出处数字走复核豁免。
    contextTruncated,
  };

  // 信心闸（M1）：纯函数三态判定；gate.enabled=false 时恒 answer（默认关=现状）。
  // fail-open：判定异常只置空、不改原 flags/decision；abstain 判定由下方 flags 兜底。
  let gate = null;
  try {
    gate = decideAnswerMode({
      question,
      draft: text,
      evidencePacket: String(input.evidenceText ?? ''),
      evidenceTurns,
      contextText,
      historyQuestion,
      zeroHit,
      // FIX-05 C3：B 题 + 0 证据单元时 gate 也判 abstain（与 answerMode 同口径）。
      canAbstain: input.canAbstain === true,
      evidenceUnits: effectiveEvidenceUnits,
      conflictCount: input.conflictCount,
      cfg: input.gateCfg,
    });
  } catch {
    gate = null;
  }
  checks.gate = gate;
  checks.citations = gate?.citations ?? extractTurnRefs(text).map((ref) => ({ turn: ref, readable: evidenceTurns.includes(ref) }));
  checks.assertions = gate?.assertions ?? { total: 0, cited: 0, inferred: 0, ungrounded: 0 };

  // FIX-05：answerMode/evidenceUnits/sourceGate/tier 是纯输出字段；早退路径也必须带上。
  const applyAnswerMode = () => {
    Object.assign(checks, deriveAnswerModeFields({
      text,
      flags,
      gate,
      evidenceText: String(input.evidenceText ?? ''),
      evidenceTurns,
      evidenceUnits: effectiveEvidenceUnits,
      canAbstain,
      difficulty,
      questionType,
    }));
  };

  // 弃答/反问：不要求轮号，也不做历史断言检查。
  if (text.trim() === '' || checks.abstained || checks.askedClarification) {
    applyAnswerMode();
    return { verdict: 'clean', flags, checks };
  }

  // (a) 历史断言但无轮号引用。
  const historyClaim = historyQuestion || HISTORY_CLAIM_RE.test(text);
  checks.historyClaim = historyClaim;
  if (historyClaim && checks.turnRefs.length === 0) {
    add(
      'HISTORY_CLAIM_NO_CITATION',
      '问题属于会话历史类，回答没有引用任何「第 N 轮」。',
      'unsupported',
      text,
    );
  }

  // 零命中仍然作答：明确违反无证据规则。
  if (zeroHit && !checks.abstained) {
    add(
      'ANSWERED_WITHOUT_EVIDENCE',
      '本轮召回零命中并注入了「无证据」标记，回答仍未弃答。',
      'unsupported',
      text,
    );
  }

  // (d) 编轮号：引用的轮号必须存在，且不能超过当前轮。
  for (const ref of checks.turnRefs) {
    if (Number.isInteger(turn) && ref > turn) {
      add('FAKE_TURN_REF', `引用了第 ${ref} 轮，但当前才进行到第 ${turn} 轮。`, 'fabrication', `第 ${ref} 轮`);
      continue;
    }
    if (sessionTurns.length > 0 && !sessionTurns.includes(ref)) {
      add('FAKE_TURN_REF', `引用了第 ${ref} 轮，但该会话不存在这一轮。`, 'fabrication', `第 ${ref} 轮`);
    }
  }

  // (d) 编卡/文件引用：路径必须真实存在（调用方给 exists；默认不拦）。
  for (const ref of checks.cardRefs) {
    let exists = true;
    try {
      exists = cardExists(ref) !== false;
    } catch {
      exists = true; // fail-open：存在性检查失败不冤枉模型
    }
    if (!exists) add('FAKE_CARD_REF', `引用了不存在的卡/文件：${ref}`, 'fabrication', ref);
  }

  // (c) 编数字/日期：上下文与工具结果里都找不到。
  const corpus = numberCorpus([contextText, question].join('\n'));
  const flaggedValues = new Set();
  for (const claim of extractNumberClaims(text)) {
    const grounded = isGroundedNumber(claim, corpus);
    checks.numbers.push({ value: claim.value, kind: claim.kind, grounded, raw: claim.raw });
    if (!grounded && !flaggedValues.has(claim.value)) {
      flaggedValues.add(claim.value);
      add('UNGROUNDED_NUMBER', `数字/日期 ${JSON.stringify(claim.raw)} 在上下文与工具结果里都找不到。`, 'fabrication', claim.raw);
    }
  }
  checks.numbers = checks.numbers.slice(0, 20);

  // (b) 假执行：被点名的工具本轮/本会话没有 tool call。
  const claims = detectToolClaims(text, knownTools);
  checks.toolClaims = claims.slice(0, 10);
  const turnSet = new Set(toolNames.map((name) => name.toLowerCase()));
  const sessionSet = new Set(sessionToolNames.map((name) => name.toLowerCase()));
  const seenClaim = new Set();
  let genericClaimed = false;
  let namedClaimFlagged = false;
  for (const claim of claims) {
    if (claim.kind === 'tool') {
      const tool = claim.tool.toLowerCase();
      const key = `tool:${tool}`;
      if (seenClaim.has(key)) continue;
      seenClaim.add(key);
      if (!turnSet.has(tool) && !sessionSet.has(tool)) {
        namedClaimFlagged = true;
        add('FAKE_TOOL_CLAIM', `声称用 ${claim.tool} 执行过操作，但本轮和该会话都没有对应 tool call。`, 'fabrication', claim.phrase);
      }
    } else {
      genericClaimed = true;
    }
  }
  if (genericClaimed && !namedClaimFlagged && turnSet.size === 0 && sessionSet.size === 0) {
    add('FAKE_TOOL_CLAIM', '声称已执行过工具操作，但本轮和该会话都没有任何 tool call。', 'fabrication', text);
  }

  // 信心闸闭环：判定应弃答却输出事实断言 / 应降级却没有首句标注。
  // R3 评分安全：gate 违规只算 unsupported（评分器只把 fabrication 计幻觉），
  // 否则「本该弃答却答」会被评分污染成幻觉（复核模拟 12→31）。
  if (gate && gate.mode === 'abstain' && !checks.abstained) {
    add(
      'GATE_ABSTAIN_VIOLATION',
      `信心闸判定应弃答（${gate.reasons.join(',')}），回答仍输出事实断言。`,
      'unsupported',
      text,
    );
  }
  if (gate && gate.mode === 'degraded' && !GATE_DEGRADED_RE.test(text.trim())) {
    add(
      'GATE_DEGRADED_MISSING',
      `信心闸判定应降级（${gate.reasons.join(',')}），回答首句缺少「不确定」标注。`,
      'unsupported',
      text,
    );
  }

  // FIX-05：所有 flag 产生后再定 answerMode（hard flag 必须能把答案改弃答）。
  applyAnswerMode();

  return {
    verdict: flags.length > 0 ? 'flagged' : 'clean',
    flags,
    checks,
  };
}

/** 把审计结果压成一行 JSONL；文本截断，避免审计文件无限膨胀。 */
export function buildAuditRow({
  sessionId,
  turn,
  question,
  text,
  audit,
  historyQuestion,
  zeroHit,
  evidenceTurns,
  toolNames,
  mode = 'live',
  now = Date.now(),
  contextInfo = null,
  answerMode: answerModeOverride = null,
  evidenceUnits: evidenceUnitsOverride = null,
  sourceGate: sourceGateOverride = null,
  tier: tierOverride = null,
}) {
  const contextTruncated = contextInfo?.truncated === true;
  // FIX-05：五个稳定字段。优先调用方显式传入（query/audit 路径补 fixture 元数据），
  // 其次取 auditTurn 写入的 checks.*，最后按旧字段回退（老行向后兼容）。
  const checks = audit?.checks ?? {};
  const answerMode = ANSWER_MODE_VALUES.includes(answerModeOverride)
    ? answerModeOverride
    : (ANSWER_MODE_VALUES.includes(checks.answerMode)
      ? checks.answerMode
      : (checks.abstained ? 'abstained' : 'answered'));
  // FIX-05：evidenceUnits 主口径 = evidenceTurns 计数（live 恒可用）；显式覆盖优先，
  // 其次从 evidenceTurns 派生，最后退回 auditTurn 的 checks。绝不让缺 meta 变成 0。
  const derivedEvidenceUnits = Array.isArray(evidenceTurns) ? evidenceTurns.length : 0;
  const resolvedEvidenceUnits = Number.isInteger(evidenceUnitsOverride) && evidenceUnitsOverride >= 0
    ? evidenceUnitsOverride
    : (derivedEvidenceUnits > 0
      ? derivedEvidenceUnits
      : (Number.isInteger(checks.evidenceUnits) && checks.evidenceUnits >= 0 ? checks.evidenceUnits : 0));
  const resolvedSourceGate = sourceGateOverride && typeof sourceGateOverride === 'object'
    ? sourceGateOverride
    : (checks.sourceGate && typeof checks.sourceGate === 'object' ? checks.sourceGate : { hard: [], soft: [] });
  const resolvedTier = typeof tierOverride === 'string' && tierOverride !== ''
    ? tierOverride
    : (typeof checks.tier === 'string' && checks.tier !== '' ? checks.tier : 'unknown/unknown');
  return {
    v: ANSWER_GUARD_VERSION,
    at: new Date(now).toISOString(),
    mode,
    sessionId: String(sessionId ?? 'unknown'),
    turn: Number.isInteger(Number(turn)) ? Number(turn) : null,
    question: clip(question, 240),
    historyQuestion: historyQuestion === true,
    zeroHit: zeroHit === true,
    evidenceTurns: Array.isArray(evidenceTurns) ? evidenceTurns.slice(0, 10) : [],
    toolCalls: Array.isArray(toolNames) ? [...new Set(toolNames)].slice(0, 20) : [],
    verdict: audit?.verdict ?? 'clean',
    flags: Array.isArray(audit?.flags) ? audit.flags.slice(0, 12) : [],
    checks: audit?.checks ?? {},
    // 信心闸（M1）机器可读字段；旧行没有这些字段仍可正常解析（向后兼容）。
    gate: audit?.checks?.gate ?? null,
    citations: Array.isArray(audit?.checks?.citations) ? audit.checks.citations.slice(0, 10) : [],
    assertions: audit?.checks?.assertions ?? { total: 0, cited: 0, inferred: 0, ungrounded: 0 },
    gateVersion: GATE_VERSION,
    // FIX-05 稳定字段（1.8.0）：answerMode 三态互斥 + 证据单元 + 双通道来源闸 + 分层。
    // answered/abstained/clarified 为互斥布尔，供评分器直接读，修 0461 同题状态冲突。
    answerMode,
    answered: answerMode === 'answered',
    abstained: answerMode === 'abstained',
    clarified: answerMode === 'clarified',
    evidenceUnits: resolvedEvidenceUnits,
    sourceGate: resolvedSourceGate,
    tier: resolvedTier,
    fix05Version: 1,
    // 2026-11-07 run C 修复：显式记录「审计上下文是否被截断」。
    // 评分器可据此对 UNGROUNDED_NUMBER 走「context-truncated」复核豁免，
    // 不再把「取证上下文被截断」误算成模型编数字（旧 run C：159→复核 10）。
    contextTruncated,
    context: contextInfo
      ? {
        chars: Math.max(0, Number(contextInfo.chars) || 0),
        keptChars: Math.max(0, Number(contextInfo.keptChars ?? contextInfo.chars) || 0),
        keyChars: Math.max(0, Number(contextInfo.keyChars) || 0),
        truncated: contextTruncated,
      }
      : null,
    assistantText: clip(text, 2000),
  };
}

/** 审计上下文被截断时插在开头的显式标记（评分器/人眼都能看到）。 */
export const AUDIT_CONTEXT_MARKER = '…[审计上下文已截断：前文省略，关键证据保留在末尾]…';

/**
 * 取文本数组的尾部，总长 ≤ maxChars；被截断时加显式标记。
 * 为什么取尾部：run C 的 40k 截断是「从前往后」，把后段历史/证据包切掉了，
 * 导致模型引用后段内容里的数字仍被判无出处（159 条误报）。审计取证应优先保留
 * 最近/最相关的文本，并显式标记截断，让评分器可以豁免。
 *
 * @param {string[]} parts 按时间顺序的文本块
 * @param {number} [maxChars]
 * @returns {{text:string, truncated:boolean, chars:number, keptChars:number}}
 */
export function tailTextParts(parts, maxChars = 40000) {
  const list = (Array.isArray(parts) ? parts : []).map((part) => String(part ?? '')).filter((part) => part !== '');
  const max = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 40000;
  const joined = list.join('\n');
  if (joined.length <= max) {
    return { text: joined, truncated: false, chars: joined.length, keptChars: joined.length };
  }
  const budget = Math.max(0, max - AUDIT_CONTEXT_MARKER.length - 1);
  const kept = [];
  let left = budget;
  for (let index = list.length - 1; index >= 0 && left > 0; index -= 1) {
    const part = list[index];
    if (part.length <= left) {
      kept.unshift(part);
      left -= part.length + 1;
    } else {
      kept.unshift(part.slice(part.length - left));
      left = 0;
    }
  }
  const text = `${AUDIT_CONTEXT_MARKER}\n${kept.join('\n')}`;
  return { text, truncated: true, chars: joined.length, keptChars: Math.max(0, text.length - AUDIT_CONTEXT_MARKER.length - 1) };
}

/**
 * 组装审计取证上下文：关键证据（问题 / 注入证据包 / 工具结果 / 本轮先前正文）
 * 一律不截断；只有「泛上下文」按剩余预算取尾部。返回结果带截断标记，
 * 供 buildAuditRow 落盘、评分器复核豁免。
 *
 * @param {{question?:string, evidenceText?:string, toolResultText?:string,
 *          priorText?:string, genericText?:string, maxChars?:number}} input
 * @returns {{text:string, truncated:boolean, keyChars:number, chars:number,
 *            genericChars:number, genericKeptChars:number}}
 */
export function composeAuditContext(input = {}) {
  const question = String(input.question ?? '').trim();
  const evidenceText = String(input.evidenceText ?? '').trim();
  const toolResultText = String(input.toolResultText ?? '').trim();
  const priorText = String(input.priorText ?? '').trim();
  const genericText = String(input.genericText ?? '');
  const maxChars = Number.isFinite(input.maxChars) && input.maxChars > 0 ? Math.floor(input.maxChars) : 40000;
  // 关键证据顺序固定：问题 → 注入证据包 → 工具结果 → 本轮先前正文。
  const keyParts = [question, evidenceText, toolResultText, priorText].filter((part) => part !== '');
  const keyText = keyParts.join('\n');
  const room = Math.max(0, maxChars - keyText.length - (keyText === '' ? 0 : 1));
  let genericKept = genericText;
  let truncated = false;
  if (genericText.length > room) {
    truncated = true;
    genericKept = room > 0 ? genericText.slice(genericText.length - room) : '';
  }
  const sections = [keyText];
  if (truncated) sections.push(AUDIT_CONTEXT_MARKER);
  if (genericKept !== '') sections.push(genericKept);
  const text = sections.filter((part) => part !== '').join('\n');
  return {
    text,
    truncated,
    keyChars: keyText.length,
    chars: keyText.length + genericText.length + (truncated ? AUDIT_CONTEXT_MARKER.length + 1 : 0) + (keyText === '' ? 0 : 1),
    genericChars: genericText.length,
    genericKeptChars: genericKept.length,
  };
}

/** 从审计行里挑出「幻觉」类（编引用/编数字/编执行）。 */
export function isFabricationRow(row) {
  return (Array.isArray(row?.flags) ? row.flags : []).some((flag) => flag?.severity === 'fabrication');
}
