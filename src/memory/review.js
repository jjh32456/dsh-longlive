// src/memory/review.js — M2-D：间隔重复（spaced repetition）调度
//
// 设计依据 §4.2/§4.5（review 调度 + promote 后可复习；不引第三方算法库，自研轻量版）：
//   * 固定阶梯 1/3/7/15/30/60/120 天（成功升一档、失败回到 1 天并降 strength）；
//   * dueAt = lastReviewedAt + intervalDays；dueRecords 只读；
//   * recordReview 写 `.longlive/review/events.jsonl`（append-only）+ 1 行统一审计；
//     不改原文/卡文件，复习结果由上层按需 promote（decay.js）。

import fs from 'node:fs';
import path from 'node:path';

import { appendAuditRecord } from './audit-records.js';
import { ensureDir } from './state.js';

export const REVIEW_SCHEMA = 'review/v1';
export const REVIEW_INTERVALS_DAYS = Object.freeze([1, 3, 7, 15, 30, 60, 120]);
export const REVIEW_PASS_GRADE = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function reviewStateOf(record = {}) {
  const review = record.review && typeof record.review === 'object' ? record.review : {};
  const streak = Number.isInteger(review.streak) && review.streak >= 0 ? review.streak : 0;
  const intervalDays = Number.isInteger(review.intervalDays) && review.intervalDays > 0
    ? review.intervalDays
    : REVIEW_INTERVALS_DAYS[0];
  return {
    streak,
    intervalDays,
    lastGrade: Number.isInteger(review.lastGrade) ? review.lastGrade : null,
    lastReviewedAt: typeof review.lastReviewedAt === 'string' ? review.lastReviewedAt : null,
    dueAt: typeof review.dueAt === 'string' ? review.dueAt : null,
  };
}

/** Pure scheduling: next review time for a record, from its current review state. */
export function nextReviewAt(record = {}, now = new Date()) {
  const state = reviewStateOf(record);
  const base = state.lastReviewedAt ?? iso(now);
  const time = Date.parse(base);
  if (Number.isNaN(time)) return null;
  const interval = REVIEW_INTERVALS_DAYS[Math.min(state.streak, REVIEW_INTERVALS_DAYS.length - 1)];
  return new Date(time + interval * DAY_MS).toISOString();
}

export function isDue(record = {}, now = new Date()) {
  const state = reviewStateOf(record);
  if (state.dueAt === null) return true; // 未排期 => 到期（首次复习）
  const due = Date.parse(state.dueAt);
  return !Number.isNaN(due) && due <= now.getTime();
}

/** Due records, most overdue first (pure; skips superseded/archived). */
export function dueRecords(records = [], now = new Date()) {
  return records
    .filter((record) => record && record.state !== 'superseded' && record.state !== 'archived')
    .filter((record) => isDue(record, now))
    .map((record) => ({ id: record.id ?? null, state: reviewStateOf(record), dueAt: reviewStateOf(record).dueAt }))
    .sort((left, right) => String(left.dueAt ?? '').localeCompare(String(right.dueAt ?? '')));
}

/**
 * Pure grade: 0..5 (0 完全遗忘 … 5 完美). Success (>=3) raises streak/interval and
 * strength; failure resets the ladder and lowers strength. Never below 0.
 */
export function gradeReview(record = {}, grade, now = new Date()) {
  const value = Math.max(0, Math.min(5, Number.isInteger(grade) ? grade : 0));
  const state = reviewStateOf(record);
  const success = value >= REVIEW_PASS_GRADE;
  const streak = success ? state.streak + 1 : 0;
  const intervalDays = REVIEW_INTERVALS_DAYS[Math.min(streak, REVIEW_INTERVALS_DAYS.length - 1)];
  const lastReviewedAt = iso(now);
  const dueAt = new Date(Date.parse(lastReviewedAt) + intervalDays * DAY_MS).toISOString();
  const strength = Math.max(0, Math.min(9, (Number.isInteger(record?.strength) ? record.strength : 0) + (success ? 1 : -1)));
  return {
    grade: value,
    success,
    strength,
    lastUsed: lastReviewedAt.slice(0, 10),
    useCount: (Number.isInteger(record?.useCount) ? record.useCount : 0) + 1,
    review: { streak, intervalDays, lastGrade: value, lastReviewedAt, dueAt },
  };
}

/** Append one review event (append-only, never rewrites the source card/record). */
export function recordReview({ root, record, grade, now = new Date(), by = 'admin' } = {}) {
  const memoryRoot = String(root ?? '');
  if (memoryRoot === '') throw new Error('E_MEMORY_ROOT: recordReview requires root');
  const id = String(record?.id ?? record?.rel ?? 'unknown');
  const result = gradeReview(record, grade, now);
  const dir = path.join(path.resolve(memoryRoot), '.longlive', 'review');
  ensureDir(memoryRoot, dir);
  const file = path.join(dir, 'events.jsonl');
  const row = {
    schema: REVIEW_SCHEMA,
    id,
    at: iso(now),
    by,
    grade: result.grade,
    success: result.success,
    review: result.review,
    strength: result.strength,
    useCount: result.useCount,
  };
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  try {
    appendAuditRecord({
      memoryRoot,
      action: 'review',
      recordId: id,
      readerTier: 'host',
      questionId: 'unknown',
      expectedTurns: null,
      answerText: null,
      at: iso(now),
      extra: { grade: result.grade, streak: result.review.streak, dueAt: result.review.dueAt },
    });
  } catch { /* audit best-effort */ }
  return { ok: true, schema: REVIEW_SCHEMA, id, file, result };
}
