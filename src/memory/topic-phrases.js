// src/memory/topic-phrases.js — S8：事件记录的主题短语（topicPhrases）。
//
// 背景：`extractTurns` 的 summary/terms 之前只做首尾截断 + 整段 CJK run 过滤，
// 长句里的主题词（「五问」「智能体工程师」）在事件层不可见，auto 卡 title/terms
// 原样拷贝事件字段，于是召回/索引找不到主题。
//
// 本模块从一轮的原文（优先用户消息）抽「用户显式标记 + 内容块 + 实体后缀短语」，
// 作为 EventRecord.topicPhrases（可选字段；老记录无此字段，读取时按 [] 处理）。
// 纯函数、无 IO、无词典文件；输出顺序稳定（同输入同输出）。

import { normalizeForExtraction, quotedPhrasesOf, cjkContentChunks, entityPhrasesOf } from './fts-query.js';

export const TOPIC_PHRASES_MAX = 12;
const MAX_PHRASE_CHARS = 40;

function toTextList(text) {
  if (Array.isArray(text)) return text.map((item) => String(item ?? '')).filter((item) => item.trim() !== '');
  return String(text ?? '').trim() === '' ? [] : [String(text)];
}

function cleanPhrase(value) {
  const phrase = normalizeForExtraction(value);
  if (phrase === '') return '';
  const chars = Array.from(phrase);
  if (chars.length < 2 || chars.length > MAX_PHRASE_CHARS) return '';
  return phrase;
}

/**
 * Extract stable, ordered topic phrases from one turn's text.
 *
 * Priority: quoted/book-title phrases → entity suffix phrases → content chunks
 * (long runs are segmented by function words instead of being dropped). Stable
 * order: source order within each tier; tiers concatenated; deduped; capped.
 *
 * @param {string|string[]} text
 * @param {{limit?:number}} [options]
 * @returns {string[]}
 */
export function extractTopicPhrases(text, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : TOPIC_PHRASES_MAX;
  const texts = toTextList(text);
  if (texts.length === 0) return [];
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const phrase = cleanPhrase(value);
    if (phrase === '' || seen.has(phrase)) return;
    seen.add(phrase);
    out.push(phrase);
  };

  const joined = texts.join('\n');

  // 1) 用户显式标记：引号 / 书名号 / 方括号 / 圆括号内短语。
  for (const phrase of quotedPhrasesOf(joined)) push(phrase);

  // 2) 实体后缀短语（智能体工程师 / 插件 / 版本 … 类名词短语）。
  for (const phrase of entityPhrasesOf(joined, { limit: limit * 2 })) push(phrase);

  // 3) 内容块（长 run 用虚词切开；2–12 字保留；更长块取 bigram 窗口意义不大，
  //    这里只保留 2–12 字块，避免 topicPhrases 变成噪声）。
  for (const text_ of texts) {
    for (const run of normalizeForExtraction(text_).match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) ?? []) {
      for (const chunk of cjkContentChunks(run)) {
        const chars = Array.from(chunk).length;
        if (chars >= 2 && chars <= 12) push(chunk);
      }
    }
  }

  return out.slice(0, limit);
}
