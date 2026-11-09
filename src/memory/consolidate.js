// Daily consolidation proposals.
//
// Reads journal entries dated after the last consolidation and proposes which
// card each paragraph belongs in. Cards are never edited: the only card-facing
// output is a report under `.longlive/reports/`. The state file gains stable
// proposal ids (`seenProposals`) so the same (source, paragraph) is never
// proposed twice, and `lastConsolidated` advances only after every proposal
// recorded for the newest scanned day is resolved (accepted/rejected/
// superseded). The human still decides what gets merged.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { memoryRootFromConfig, resolveInside, relativePath, memoryError } from './paths.js';
import {
  parseFrontmatter, dayString, isoStamp, isDayString,
} from './frontmatter.js';
import {
  ensureDir, reportsDir, readState, updateState, listMarkdownFiles, writeFileAtomic, appendAudit,
} from './state.js';
import { scanCards } from './index.js';
import { writeCard } from './cards.js';

const RESOLVED_STATUS = new Set(['accepted', 'rejected', 'superseded']);
const AFFECT_KEYWORD = /^affect\b/i;

function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function stripComments(text) {
  return String(text ?? '').replace(/<!--[\s\S]*?-->/g, ' ');
}

function commentsOf(text) {
  return String(text ?? '').match(/<!--[\s\S]*?-->/g) ?? [];
}

// Routing v2 vocabulary. rc.5 counted every shared token — dates, ASCII
// fragments, generic words — and weighted titles x3, so a date in a card title
// could beat the one rare term that identified the paragraph. Content tokens
// drop addresses, numbers and CJK function words first.
const STOP_BIGRAMS = new Set([
  '我们', '你们', '他们', '她们', '它们', '这个', '那个', '一个', '没有', '就是', '可以',
  '因为', '所以', '但是', '如果', '已经', '还是', '不是', '什么', '这样', '那样', '现在',
  '今天', '时候', '自己', '东西', '事情', '地方', '问题', '方法', '做法', '方式', '结果',
  '开始', '然后', '之后', '之前', '一下', '一点', '这些', '那些', '这种', '那种', '内容',
  '部分', '情况', '需要', '一定', '直接', '全部', '所有', '今日', '今晚', '同时', '以及',
]);
const STOP_CHARS = new Set('的了是在我他你她它们这那就也都很和与及把被让给对从到为以于而其之等着呢吗吧啊哦嗯个不没有会要能可还只又再才更最');
const PLAN_PATTERN = /(挂起|暂(?:时)?不|下一步再|排(?:期)?到|在他点名前)/;
const CONCLUSION_PATTERN = /(决定|取消|改成|改为|不许|不准|只能|必须|禁止|结论|教训|根因|正确做法|规矩|铁律|硬约束|遗留|未处理|不再|一律|统一|定为)/;

/** Content tokens: ASCII words and CJK bigrams, with dates/numbers/function words dropped. */
function contentTokens(text) {
  const source = String(text ?? '').toLowerCase()
    // URLs and bare domains are addresses, not topics: drop them whole so
    // `https` / `com` / `api` never become routing evidence.
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b[\w-]+\.(?:com|cn|net|org|io|dev|ai|app)\b/g, ' ');
  const map = new Map();
  const bump = (token) => map.set(token, (map.get(token) ?? 0) + 1);
  for (const word of source.match(/[a-z0-9_]{2,}/g) ?? []) {
    if (/^\d+$/.test(word) || /^(19|20)\d{2}$/.test(word)) continue;
    bump(word);
  }
  for (const run of source.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let index = 0; index + 1 < run.length; index += 1) {
      const bigram = run.slice(index, index + 2);
      if (STOP_BIGRAMS.has(bigram)) continue;
      if (STOP_CHARS.has(bigram[0]) || STOP_CHARS.has(bigram[1])) continue;
      bump(bigram);
    }
  }
  return map;
}

function journalDay(rel, fields) {
  if (isDayString(fields?.date)) return fields.date.trim();
  const base = path.posix.basename(rel);
  const match = /^(\d{4})[-_.](\d{1,2})(?:[-_.](\d{1,2}))?/.exec(base);
  if (!match) return null;
  const month = Number(match[2]);
  const day = match[3] ? Number(match[3]) : 1;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * A compact bullet list can pack several entries into one blank-line block:
 * a `- **YYYY-MM-DD HH:MM**` line starts a new entry, and so does a bullet that
 * opens with a conclusion word (`- 结论：…`) right after a finished sentence.
 */
const ENTRY_TIMESTAMP = /^-\s*\*\*(?:\d{4}-\d{2}-\d{2}|\d{1,2}[-–]\d{1,2}(?:\s+\d{1,2}:\d{2})?)/;
const ENTRY_CONCLUSION = /^-\s*(?:结论|决定|教训|根因|规矩|铁律|下一步|遗留|未处理|正确做法)\s*[：:]/;
const SENTENCE_END = /[。；！？;!?]$/;

function splitEntryGroups(lines) {
  const groups = [];
  let current = [];
  for (const line of lines) {
    const isEntry = /^-\s/.test(line.text)
      && (ENTRY_TIMESTAMP.test(line.text) || ENTRY_CONCLUSION.test(line.text));
    const previous = current[current.length - 1];
    if (current.length && isEntry && previous && SENTENCE_END.test(previous.text.trim())) {
      groups.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length) groups.push(current);
  return groups;
}

/**
 * Paragraphs of a journal file. Headings are dropped; a block that holds only
 * HTML comments (the usual `<!-- affect: N | reason -->` on its own line)
 * belongs to the paragraph before it, or to the next one at the top.
 *
 * Returns `{ text, startLine, endLine }` where the line numbers are 1-based
 * inside `body`, shifted by `lineOffset` when the caller wants file lines.
 * `splitEntries` (off by default) cuts a compact block into its entry units.
 */
function paragraphUnits(body, { splitEntries = false, lineOffset = 0 } = {}) {
  const lines = String(body ?? '').split(/\r?\n/);
  const blocks = [];
  let block = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      block = null;
      continue;
    }
    if (!block) {
      block = [];
      blocks.push(block);
    }
    block.push({ text: line, number: index + 1 });
  }

  const units = [];
  let pending = null;
  const attach = (target, text, lastLine) => {
    target.text = `${target.text}\n${text}`;
    target.endLine = lastLine;
  };
  for (const raw of blocks) {
    const kept = raw.filter((line) => !/^\s{0,3}#{1,6}\s/.test(line.text));
    if (!kept.length) continue;
    const cleaned = kept.map((line) => line.text).join('\n').trim();
    if (!collapse(stripComments(cleaned))) {
      const target = units[units.length - 1] ?? pending;
      if (target) attach(target, cleaned, kept[kept.length - 1].number);
      else pending = { text: cleaned, startLine: kept[0].number, endLine: kept[kept.length - 1].number };
      continue;
    }
    const groups = splitEntries ? splitEntryGroups(kept) : [kept];
    for (const group of groups) {
      const text = group.map((line) => line.text).join('\n').trim();
      if (!text) continue;
      const startLine = group[0].number;
      const endLine = group[group.length - 1].number;
      if (pending) {
        units.push({
          text: `${pending.text}\n${text}`,
          startLine: pending.startLine,
          endLine,
        });
        pending = null;
      } else {
        units.push({ text, startLine, endLine });
      }
    }
  }
  if (pending) units.push(pending);
  return units.map((unit) => ({
    text: unit.text,
    startLine: unit.startLine + lineOffset,
    endLine: unit.endLine + lineOffset,
  }));
}

function parseAffectComment(comment) {
  const inner = comment.replace(/^<!--/, '').replace(/-->$/, '').trim();
  const rest = inner.replace(/^affect\b/i, '');
  if (!/^\s*:/.test(rest)) {
    return { ok: false, code: 'E_AFFECT_FORMAT', message: '缺少冒号，应为 <!-- affect: N | 理由 -->' };
  }
  const payload = rest.replace(/^\s*:/, '');
  const bar = payload.indexOf('|');
  if (bar < 0) {
    return { ok: false, code: 'E_AFFECT_FORMAT', message: '缺少 "| 理由" 部分' };
  }
  const rawNumber = payload.slice(0, bar).trim();
  const reason = payload.slice(bar + 1).trim();
  if (!/^\d+$/.test(rawNumber)) {
    return { ok: false, code: 'E_AFFECT_FORMAT', message: `N 不是整数：${rawNumber || '(空)'}` };
  }
  const number = Number(rawNumber);
  if (number < 1 || number > 5) {
    return { ok: false, code: 'E_AFFECT_RANGE', message: `N 越界：${number}，必须在 1..5` };
  }
  if (!reason) {
    return { ok: false, code: 'E_AFFECT_FORMAT', message: '缺少理由' };
  }
  return { ok: true, number, reason: collapse(reason) };
}

/**
 * Parse the affect marker of one journal paragraph.
 *
 * `<!-- affect: N | 一句理由 -->` (N 1..5) wins. Without a marker the
 * conservative regex fallback is used. A malformed or out-of-range marker is
 * never thrown: it is returned in `bad` so a batch run can list it and move on.
 */
export function parseAffect(text) {
  const raw = String(text ?? '');
  const bad = [];
  let marked = null;
  for (const comment of commentsOf(raw)) {
    const inner = comment.replace(/^<!--/, '').replace(/-->$/, '').trim();
    if (!AFFECT_KEYWORD.test(inner)) continue;
    const parsed = parseAffectComment(comment);
    if (parsed.ok) {
      if (!marked) marked = parsed;
      else {
        bad.push({
          marker: collapse(comment),
          code: 'E_AFFECT_DUPLICATE',
          message: '同一段有多个 affect 标记，只采信第一个',
        });
      }
    } else {
      bad.push({ marker: collapse(comment), code: parsed.code, message: parsed.message });
    }
  }
  if (marked) {
    return {
      salience: marked.number,
      salienceSource: 'marked',
      affectReason: marked.reason,
      bad,
    };
  }
  const guess = salienceGuess(collapse(stripComments(raw)));
  return { salience: guess.value, salienceSource: guess.source, affectReason: null, bad };
}

function salienceGuess(paragraph) {
  if (/(铁律|永远|绝不|必须|生命|答应|死|永远记住)/.test(paragraph)) return { value: 5, source: 'heuristic' };
  if (/(决定|规则|结论|方案|方向|定下)/.test(paragraph)) return { value: 4, source: 'heuristic' };
  if (/(随手|备忘|琐事|笔记|临时)/.test(paragraph)) return { value: 2, source: 'heuristic' };
  return { value: 3, source: 'default' };
}

function suggestSalience(paragraph) {
  return salienceGuess(paragraph).value;
}

/** Stable identity of a (source, paragraph) pair: sha1(...)[:12]. */
export function proposalId(sourceRel, paragraphText) {
  return crypto.createHash('sha1')
    .update(`${sourceRel}\n${collapse(paragraphText)}`, 'utf8')
    .digest('hex')
    .slice(0, 12);
}

// Routing vocabulary is DECLARED, not inferred from body prose: title + a
// `scope:` frontmatter line (a comma-separated term list) + tags. Body text is
// only a fallback for cards that have not declared a scope yet, and carries the
// lowest weight. This is what stops "sessions" in a card body or a date in a
// title from outvoting the one term that names the paragraph's topic.
const ROUTING_TITLE_WEIGHT = 2;
const ROUTING_SCOPE_WEIGHT = 3;
const ROUTING_BODY_WEIGHT = 1;
const ROUTING_SCOPE_DISABLED = process.env.DSH_LONGLIVE_SCOPE === '0';
const ROUTING_MIN_COVERAGE = Number(process.env.DSH_LONGLIVE_MIN_COVERAGE ?? 0.03);

function stripFrontmatterText(text) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(String(text ?? ''));
  return match ? String(text).slice(match[0].length) : String(text ?? '');
}

/** Build the routing vocabulary for the whole card set. */
function buildCardIndex(cards) {
  const add = (tf, tokens, weight) => {
    for (const [token, n] of tokens) tf.set(token, (tf.get(token) ?? 0) + n * weight);
  };
  const docs = cards.map((card) => {
    const raw = card.abs ? fs.readFileSync(card.abs, 'utf8') : '';
    const parsed = raw ? parseFrontmatter(raw) : { fields: {}, extras: {}, body: '' };
    // `scope` is a known field now; reading extras too keeps older cards working.
    const scope = String(parsed.fields?.scope ?? parsed.extras?.scope ?? card.fields?.scope ?? '').trim();
    const tf = new Map();
    add(tf, contentTokens(card.title), ROUTING_TITLE_WEIGHT);
    if (!ROUTING_SCOPE_DISABLED) add(tf, contentTokens(scope), ROUTING_SCOPE_WEIGHT);
    // Ablation arm (DSH_LONGLIVE_SCOPE=0): title + body prose only, i.e. what
    // rc.5 actually had. Without a declared scope the body is the only vocabulary.
    if (ROUTING_SCOPE_DISABLED || scope === '') {
      add(tf, contentTokens(parsed.body ?? stripFrontmatterText(raw)), ROUTING_BODY_WEIGHT);
    }
    return { card, scope, tf };
  });
  const df = new Map();
  for (const doc of docs) for (const token of doc.tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
  const idf = (token) => Math.log((docs.length + 1) / ((df.get(token) ?? 0) + 0.5));
  return { docs, idf, df };
}

/** Coverage: how much of the paragraph's IDF mass the card's declared scope explains. */
function coverageScore(paragraphTokens, doc, index) {
  let matched = 0;
  let total = 0;
  for (const [token, n] of paragraphTokens) {
    const w = n * index.idf(token);
    total += w;
    if (doc.tf.has(token)) matched += w;
  }
  return total ? matched / total : 0;
}

const cosineScore = coverageScore;

function splitSentences(text) {
  return String(text ?? '')
    .split(/\n|(?<=[。！？!?])/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function evidenceQuality(span) {
  const cjk = (span.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latin = (span.match(/[a-zA-Z]/g) ?? []).length;
  return cjk >= 2 || latin >= 3;
}

/** Pick the sentence sharing the most IDF mass with the chosen card; always an exact substring. */
function pickQuote(paragraph, doc, index) {
  const sentences = splitSentences(paragraph);
  let best = null;
  for (const sentence of sentences) {
    if (!evidenceQuality(sentence)) continue;
    let mass = 0;
    for (const [token, n] of contentTokens(sentence)) {
      if (doc && doc.tf.has(token)) mass += n * index.idf(token);
    }
    if (!best || mass > best.mass) best = { sentence, mass };
  }
  const raw = best?.sentence ?? sentences.find(evidenceQuality) ?? String(paragraph ?? '');
  return raw.slice(0, 120);
}

/** The conclusion/decision sentence — what the proposal should actually carry. */
function pickClaim(paragraph) {
  const sentences = splitSentences(paragraph).filter(evidenceQuality);
  let best = null;
  for (const sentence of sentences) {
    let score = 0;
    if (CONCLUSION_PATTERN.test(sentence)) score += 3;
    if (/\d/.test(sentence)) score += 1;
    if (/[：:]/.test(sentence)) score += 1;
    score += Math.min(sentence.length / 60, 1);
    if (!best || score > best.score) best = { sentence, score };
  }
  return (best?.sentence ?? sentences[0] ?? String(paragraph ?? '')).slice(0, 160);
}

function bestTarget(paragraph, index) {
  const paragraphTokens = contentTokens(paragraph);
  if (paragraphTokens.size === 0) return null;
  const claim = pickClaim(paragraph);
  // Route on the claim sentence, not the whole paragraph: a long log entry is
  // mostly symptoms and timestamps, and its last conclusion is what should pick
  // the card. Fall back to the whole paragraph when the claim is too short.
  const claimTokens = contentTokens(claim);
  const routingTokens = claimTokens.size >= 4 ? claimTokens : paragraphTokens;
  const ranked = index.docs
    .map((doc) => ({ doc, score: cosineScore(routingTokens, doc, index) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const quote = pickQuote(paragraph, best?.doc, index);

  // A plan/priority statement is not a topic fact: 13 topic cards cannot own
  // "do memory first, park music" — the honest proposal is a new card.
  if (PLAN_PATTERN.test(paragraph)) {
    return {
      card: null,
      score: best?.score ?? 0,
      quote,
      claim,
      reason: `原文引用『${quote}』；这是排期/优先级指令，没有主题卡对应，建议新建卡`,
    };
  }
  // Below the floor the best card shares only generic words; say so instead of
  // filing the paragraph into a card it has nothing to do with.
  if (!best || best.score < ROUTING_MIN_COVERAGE) {
    return {
      card: null,
      score: best?.score ?? 0,
      quote,
      claim,
      reason: `原文引用『${quote}』；没有足够的话题重合，建议新建卡（最高覆盖 ${((best?.score ?? 0) * 100).toFixed(0)}%）`,
    };
  }
  const matched = [...routingTokens.keys()]
    .filter((token) => best.doc.tf.has(token))
    .sort((a, b) => index.idf(b) - index.idf(a))
    .slice(0, 3);
  return {
    card: best.doc.card,
    score: best.score,
    quote,
    claim,
    reason: `原文引用『${quote}』；话题命中「${matched.join('、')}」`,
  };
}

function reportText({
  root, sinceDay, files, proposals, undated, badAffect, duplicates,
  stateUpdated, lastConsolidated,
}) {
  const lines = [
    '# 巩固提案',
    '',
    `- 生成时间：${isoStamp()}`,
    `- 记忆根：${root}`,
    `- 增量起点：${sinceDay ?? '（无，读全部 journal）'}`,
    `- journal 文件：${files.length}`,
    `- 提案：${proposals.length}`,
    `- 去重跳过（seenProposals 已见）：${duplicates}`,
    `- 状态：${stateUpdated ? `lastConsolidated → ${lastConsolidated}` : '未推进（仍有未决提案）'}`,
    `- badAffect：${badAffect.length}`,
    '',
  ];
  if (proposals.length === 0) {
    lines.push('本次没有需要归档的新增段落（已见提案不会重复列出）。', '');
  }
  proposals.forEach((proposal, index) => {
    lines.push(`## 提案 ${index + 1}`);
    lines.push('');
    lines.push(`- 提案 id：${proposal.id}`);
    lines.push(`- 来源：${proposal.source}`);
    if (proposal.lineStart) {
      lines.push(`- 行号：${proposal.lineStart}${proposal.lineEnd && proposal.lineEnd !== proposal.lineStart ? `-${proposal.lineEnd}` : ''}`);
    }
    lines.push(`- 摘录：${proposal.excerpt}`);
    lines.push(`- 原文引用：${proposal.quote ?? '（无）'}`);
    lines.push(`- 结论句：${proposal.claim ?? '（无）'}`);
    lines.push(`- 目标卡：${proposal.target ?? '（无匹配）'}${proposal.targetTitle ? `（${proposal.targetTitle}）` : ''}`);
    lines.push(`- 理由：${proposal.reason}`);
    lines.push(`- 建议 salience：${proposal.suggestedSalience}`);
    lines.push(`- salienceSource：${proposal.salienceSource}`);
    lines.push(`- 标记理由：${proposal.affectReason ?? '（无标记，按正则/默认）'}`);
    lines.push('');
  });
  if (badAffect.length) {
    lines.push('## badAffect（坏掉的情绪标记，已忽略）', '');
    for (const item of badAffect) {
      lines.push(`- ${item.source}：「${item.marker}」— ${item.code} ${item.message}`);
    }
    lines.push('');
  }
  if (undated.length) {
    lines.push('## 无日期的段落（未纳入增量）', '');
    for (const item of undated) lines.push(`- ${item.source}：${item.excerpt}`);
    lines.push('');
  }
  lines.push('> 本报告只提议，不改任何卡；state 只记录提案 id 与推进点。');
  return `${lines.join('\n')}\n`;
}

function lastDayOf(value) {
  if (typeof value !== 'string') return null;
  if (isDayString(value)) return value.trim();
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

function proposalBacklog(entries) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry.id === 'string') : [];
  const counts = { proposed: 0, accepted: 0, rejected: 0, superseded: 0 };
  for (const entry of list) {
    const status = RESOLVED_STATUS.has(entry.status) ? entry.status : 'proposed';
    counts[status] += 1;
  }
  const days = new Map();
  for (const entry of list) {
    const status = RESOLVED_STATUS.has(entry.status) ? entry.status : 'proposed';
    if (!days.has(entry.day)) days.set(entry.day, { proposed: 0, resolved: 0 });
    const day = days.get(entry.day);
    if (status === 'proposed') day.proposed += 1;
    else day.resolved += 1;
  }
  return {
    total: list.length,
    pending: counts.proposed,
    resolved: counts.accepted + counts.rejected + counts.superseded,
    ...counts,
    byDay: [...days.entries()].filter(([day]) => typeof day === 'string').sort(([a], [b]) => a.localeCompare(b))
      .map(([day, countsDay]) => ({ day, ...countsDay })),
  };
}

function advanceLastConsolidated(state, entries) {
  const current = lastDayOf(state.lastConsolidated);
  const days = [...new Set(entries.map((entry) => entry.day).filter((day) => typeof day === 'string'))].sort();
  let last = current;
  for (const day of days) {
    if (last !== null && day <= last) continue;
    const dayEntries = entries.filter((entry) => entry.day === day);
    if (dayEntries.length > 0 && dayEntries.every((entry) => RESOLVED_STATUS.has(entry.status))) last = day;
  }
  return last;
}

/**
 * Accept or reject one consolidation proposal.
 *
 * accept -> write a NEW topic card through the normal `writeCard` path (old
 * cards are never edited) + audit; reject -> record the operator's reason +
 * audit. Both advance lastConsolidated over fully resolved days.
 */
export function resolveConsolidationProposal(args = {}, config = {}) {
  const action = args.action;
  if (action !== 'accept' && action !== 'reject') {
    throw memoryError('E_BAD_ARGUMENT', 'consolidation resolve 需要 action=accept|reject');
  }
  const proposalIdValue = typeof args.proposalId === 'string' ? args.proposalId.trim() : '';
  if (!/^[0-9a-f]{12}$/i.test(proposalIdValue)) throw memoryError('E_BAD_ARGUMENT', '需要 12 位 proposalId');
  const root = memoryRootFromConfig(config);
  const now = config.now instanceof Date ? config.now : new Date();
  const state = readState(root);
  const entries = (Array.isArray(state.seenProposals) ? state.seenProposals : [])
    .filter((entry) => entry && typeof entry.id === 'string');
  const index = entries.findIndex((entry) => entry.id === proposalIdValue);
  if (index < 0) throw memoryError('E_PROPOSAL_NOT_FOUND', `找不到提案 ${proposalIdValue}`);
  const entry = entries[index];
  if (RESOLVED_STATUS.has(entry.status)) {
    throw memoryError('E_PROPOSAL_RESOLVED', `提案 ${proposalIdValue} 已是 ${entry.status}`);
  }
  let card = null;
  let audited = null;
  if (action === 'accept') {
    const rel = `topics/consolidated/${proposalIdValue}.md`;
    const title = collapse(entry.excerpt ?? entry.claim ?? proposalIdValue).slice(0, 80);
    const claim = collapse(entry.claim ?? entry.excerpt ?? '').slice(0, 400);
    const body = [
      `# ${title}`,
      '',
      claim,
      '',
      `- proposal: ${proposalIdValue}`,
      `- source: ${entry.source ?? 'journal'}${entry.lineStart ? `:${entry.lineStart}-${entry.lineEnd}` : ''}`,
      `- accepted_at: ${now.toISOString()}`,
    ].join('\n');
    card = writeCard(root, {
      rel,
      title,
      body,
      fields: {
        date: entry.day ?? dayString(now),
        tags: ['consolidation'],
        salience: Number.isInteger(entry.salience) ? entry.salience : 3,
      },
      extras: {
        consolidation_proposal: proposalIdValue,
        source_journal: entry.source ?? '',
        source_lines: entry.lineStart ? `${entry.lineStart}-${entry.lineEnd}` : '',
      },
    }, { now });
    entries[index] = { ...entry, status: 'accepted', resolvedAt: now.toISOString(), card: rel };
  } else {
    const reason = collapse(args.reason ?? '').slice(0, 300);
    if (reason === '') throw memoryError('E_BAD_ARGUMENT', 'reject 需要 reason');
    entries[index] = { ...entry, status: 'rejected', resolvedAt: now.toISOString(), reason };
  }
  const lastConsolidated = advanceLastConsolidated(state, entries);
  updateState(root, {
    seenProposals: entries,
    ...(lastConsolidated !== lastDayOf(state.lastConsolidated) ? { lastConsolidated } : {}),
  }, { now });
  const actionName = action === 'accept' ? 'memory_consolidate_accept' : 'memory_consolidate_reject';
  audited = appendAudit(root, {
    action: actionName,
    object: proposalIdValue,
    result: action === 'accept'
      ? `card=${card.rel}`
      : `reason=${collapse(args.reason ?? '').slice(0, 200)}`,
    now,
  });
  const backlog = proposalBacklog(entries);
  return {
    ok: true,
    status: action,
    proposalId: proposalIdValue,
    card: card ? { rel: card.rel, sha256: card.sha256 ?? null } : null,
    reason: action === 'reject' ? collapse(args.reason ?? '') : null,
    lastConsolidated,
    backlog,
    audit: audited,
    message: `${action === 'accept' ? '已接受' : '已拒绝'}提案 ${proposalIdValue}；积压 ${backlog.pending} 条，lastConsolidated=${lastConsolidated ?? 'null'}`,
  };
}

/**
 * memory_consolidate: read-only with respect to cards. Writes exactly one
 * report file; the state file gains new `seenProposals` entries and, only when
 * every proposal of the newest scanned day is resolved, a new
 * `lastConsolidated`. No card is ever edited.
 */
export function memoryConsolidate(args = {}, config = {}) {
  if (args.apply === true) {
    throw memoryError('E_READ_ONLY', 'memory_consolidate 只出提案，不支持 apply — 请人工决定后再改卡');
  }
  if (args.action === 'accept' || args.action === 'reject') return resolveConsolidationProposal({ ...args, proposalId: args.proposalId ?? args.id }, config);
  if (args.action === 'status') {
    const statusRoot = memoryRootFromConfig(config);
    const statusState = readState(statusRoot);
    return {
      ok: true,
      status: 'backlog',
      readOnly: true,
      root: statusRoot,
      backlog: proposalBacklog(statusState.seenProposals),
      lastConsolidated: statusState.lastConsolidated ?? null,
    };
  }
  if (args.action !== undefined && args.action !== 'report') {
    throw memoryError('E_BAD_ARGUMENT', `memory_consolidate 不支持的 action：${JSON.stringify(args.action)}`);
  }
  const root = memoryRootFromConfig(config);
  const now = config.now instanceof Date ? config.now : new Date();
  const day = config.today ?? dayString(now);
  const state = readState(root);
  const requestedSince = typeof args.since === 'string' && args.since.trim() ? args.since.trim() : null;
  const rawSince = requestedSince ?? state.lastConsolidated;
  const sinceDay = isDayString(rawSince)
    ? rawSince.slice(0, 10)
    : (typeof rawSince === 'string' && /^\d{4}-\d{2}-\d{2}/.test(rawSince) ? rawSince.slice(0, 10) : null);

  const seenProposals = (Array.isArray(state.seenProposals) ? state.seenProposals : [])
    .filter((entry) => entry && typeof entry.id === 'string');
  const seenById = new Map(seenProposals.map((entry) => [entry.id, entry]));
  // Entry splitting is opt-in: a blank-line block may hold several `- ` entries,
  // but cut points are only safe when the caller knows segment labels do not
  // overlap (F6 in the A-group manifest: A-14 L59-73 and A-15 L71-72 do overlap).
  const entrySplit = args.entrySplit === true;
  const newEntries = [];
  const allTopicCards = scanCards(root).filter((card) => card.rel.startsWith('topics/'));
  // Locked cards are core memory: they are never merge targets (and journal
  // paragraphs are never merged into them), so distill can not erode them.
  const lockedSkipped = allTopicCards.filter((card) => (card.fields.status ?? 'active') === 'locked').length;
  const topicCards = allTopicCards.filter((card) => (card.fields.status ?? 'active') !== 'locked');
  const cardIndex = buildCardIndex(topicCards);
  const files = listMarkdownFiles(root, 'journal');
  const proposals = [];
  const undated = [];
  const badAffect = [];
  const scannedDays = new Set();
  let entries = 0;
  let duplicates = 0;

  for (const abs of files) {
    const rel = relativePath(root, abs);
    const text = fs.readFileSync(abs, 'utf8');
    const parsed = parseFrontmatter(text);
    const fileDay = journalDay(rel, parsed.fields);
    // paragraphUnits numbers lines inside the body; shift them to file lines.
    const lineOffset = text.slice(0, parsed.bodyStart).split(/\r?\n/).length - 1;
    if (sinceDay && !fileDay) {
      for (const unit of paragraphUnits(parsed.body, { lineOffset })) {
        undated.push({ source: rel, excerpt: collapse(stripComments(unit.text)).slice(0, 120) });
      }
      continue;
    }
    if (sinceDay && fileDay <= sinceDay) continue;
    if (fileDay) scannedDays.add(fileDay);

    for (const unit of paragraphUnits(parsed.body, { splitEntries: entrySplit, lineOffset })) {
      entries += 1;
      const paragraphText = collapse(stripComments(unit.text));
      const affect = parseAffect(unit.text);
      for (const bad of affect.bad) {
        badAffect.push({
          source: rel,
          date: fileDay,
          excerpt: paragraphText.slice(0, 120),
          marker: bad.marker,
          code: bad.code,
          message: bad.message,
        });
      }
      const id = proposalId(rel, paragraphText);
      if (seenById.has(id)) {
        duplicates += 1;
        continue;
      }
      const target = bestTarget(paragraphText, cardIndex);
      const claim = target?.claim ?? paragraphText.slice(0, 160);
      const proposal = {
        id,
        source: rel,
        lineStart: unit.startLine,
        lineEnd: unit.endLine,
        date: fileDay,
        excerpt: claim.slice(0, 120),
        claim,
        quote: target?.quote ?? null,
        target: target?.card?.rel ?? null,
        targetTitle: target?.card?.title ?? null,
        reason: target?.reason ?? '没有明确匹配的主题卡，建议人工决定是否新建',
        suggestedSalience: affect.salience,
        salienceSource: affect.salienceSource,
        affectReason: affect.affectReason,
      };
      proposals.push(proposal);
      const entry = {
        id,
        status: 'proposed',
        day: fileDay ?? day,
        source: rel,
        lineStart: unit.startLine,
        lineEnd: unit.endLine,
        excerpt: proposal.excerpt,
        target: proposal.target,
        targetTitle: proposal.targetTitle,
        salience: proposal.suggestedSalience,
        salienceSource: proposal.salienceSource,
        proposedAt: day,
      };
      newEntries.push(entry);
      seenById.set(id, entry);
    }
  }

  // The newest day this run actually scanned is the only candidate for the
  // incremental pointer. It moves only when every proposal recorded for that
  // day is resolved; newly proposed ids keep it pinned, which is the point.
  const candidateDay = [...scannedDays].sort().pop() ?? null;
  const currentLastDay = lastDayOf(state.lastConsolidated);
  const allEntries = [...seenProposals, ...newEntries];
  const backlog = proposalBacklog(allEntries);
  let lastConsolidated = state.lastConsolidated ?? null;
  let stateUpdated = false;
  if (candidateDay) {
    const dayEntries = allEntries.filter((entry) => entry.day === candidateDay);
    const unresolved = dayEntries.filter((entry) => !RESOLVED_STATUS.has(entry.status));
    if (dayEntries.length > 0 && unresolved.length === 0 && (!currentLastDay || candidateDay > currentLastDay)) {
      lastConsolidated = candidateDay;
      stateUpdated = true;
    }
  }

  const stateChanged = newEntries.length > 0 || stateUpdated;
  let stateWrite = null;
  if (stateChanged) {
    stateWrite = updateState(root, {
      ...(stateUpdated ? { lastConsolidated } : {}),
      seenProposals: allEntries,
    }, { now });
  }

  const dir = reportsDir(root);
  ensureDir(root, dir);
  const reportPath = resolveInside(root, path.join('.longlive', 'reports', `consolidate-${day}.md`));
  const content = `${reportText({
    root, sinceDay, files, proposals, undated, badAffect, duplicates,
    stateUpdated, lastConsolidated: lastDayOf(lastConsolidated) ?? lastConsolidated,
  })}\n- 提案积压：${backlog.pending} 待决 / ${backlog.total} 总数（accepted ${backlog.accepted}, rejected ${backlog.rejected}）\n`;
  if (fs.existsSync(reportPath)) {
    const backupDir = resolveInside(root, path.join('.longlive', 'reports', '.backups'));
    ensureDir(root, backupDir);
    const stamp = isoStamp(now).replace(/[:.]/g, '-');
    let backupName = `consolidate-${day}.${stamp}.md`;
    // Two runs inside one millisecond used to produce the same backup name and
    // the second copy silently overwrote the first. Never reuse a name.
    for (let suffix = 2; fs.existsSync(path.join(backupDir, backupName)); suffix += 1) {
      backupName = `consolidate-${day}.${stamp}-${suffix}.md`;
    }
    fs.copyFileSync(reportPath, path.join(backupDir, backupName));
  }
  const write = writeFileAtomic(root, reportPath, content, { backup: false, now });

  return {
    ok: true,
    status: 'report',
    readOnly: true,
    stateUpdated,
    stateWritten: stateChanged,
    previousLastConsolidated: state.lastConsolidated ?? null,
    lastConsolidated: lastDayOf(lastConsolidated) ?? null,
    root,
    since: sinceDay,
    journalFiles: files.length,
    entries,
    proposals,
    duplicatesSuppressed: duplicates,
    lockedSkipped,
    seenProposals: allEntries.length,
    backlog,
    badAffect,
    undated,
    reportPath,
    reportRel: relativePath(root, reportPath),
    sha256: write.sha256,
    message:
      `只读提案：${entries} 段增量 → ${proposals.length} 个新提案（已见跳过 ${duplicates} 段），` +
      `badAffect ${badAffect.length} 条；locked 目标跳过 ${lockedSkipped} 张；报告 ${relativePath(root, reportPath)}；` +
      `${stateUpdated ? `lastConsolidated 推进到 ${lastConsolidated}` : 'lastConsolidated 未推进'}；卡未改动`,
  };
}

export {
  contentTokens, buildCardIndex, cosineScore, coverageScore, pickQuote, pickClaim, paragraphUnits,
};
