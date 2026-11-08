// src/memory/activity-capture.js — M2-B / §2.5：活动流并入统一事件模型
//
// 映射（提案 §2.5）：
//   board/activity.jsonl 行（doing/finding/blocked/done/结论）→ EventRecord(kind=activity|conclusion)
//   结论行 → 同时写 records.jsonl(kind='conclusion')
//   .longlive/live/*.json 状态行 → EventRecord(kind=status)（时间线，默认不参与排序）
//   goal/focus → records.jsonl(kind='goal', TTL)（status=active/expired）
//
// 只读原文件、写私有 .longlive；所有写入幂等（id+digest）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { stableStringify } from '../codec.js';
import { extractTerms } from './fts-query.js';
import { appendRecordLine, makeRecordId, upsertEventRecord } from './capture.js';
import { appendClaimFromRecord } from './governance.js';
import { evaluateEvidenceForWrite } from './records.js';

function sha1Short(text, length = 12) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex').slice(0, length);
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function nowDate(now) {
  const value = typeof now === 'function' ? now() : new Date();
  return value instanceof Date ? value : new Date(value);
}

export function createActivityCapture(options = {}) {
  const memoryRoot = path.resolve(String(options.memoryRoot ?? ''));
  if (memoryRoot === '') throw new Error('E_MEMORY_ROOT: activity-capture requires memoryRoot');
  const now = typeof options.now === 'function' ? options.now : () => new Date();

  function captureBoardRow(row = {}) {
    const at = Number(row.at ?? row.ts ?? row.time);
    const text = String(row.text ?? row.message ?? row.content ?? '').trim();
    if (text === '') return { ok: false, code: 'E_ACTIVITY_TEXT' };
    const kind = row.kind === 'conclusion' ? 'conclusion' : 'activity';
    const id = `evt:activity:${row.id ?? row.seq ?? sha1Short(`${at}|${text}`)}`;
    const project = row.project ?? null;
    const terms = extractTerms(text, [kind]);
    const record = {
      id,
      sessionId: row.sessionId ?? 'activity',
      turn: Number.isInteger(row.turn) ? row.turn : 0,
      seqStart: Number.isInteger(row.seqStart) ? row.seqStart : null,
      seqEnd: Number.isInteger(row.seqEnd) ? row.seqEnd : null,
      timeStart: Number.isFinite(at) ? at : null,
      timeEnd: Number.isFinite(at) ? at : null,
      project,
      kind,
      topics: terms.filter((term) => /[\u3400-\u4dbf\u4e00-\u9fff]/.test(term)).slice(0, 5),
      terms,
      summary: text.slice(0, 400),
      counts: {},
      anchors: Array.isArray(row.anchors) ? row.anchors : [],
      digest: sha256Hex(stableStringify({ at: Number.isFinite(at) ? at : null, text, kind })),
      source: 'activity-capture',
    };
    const indexed = upsertEventRecord({ memoryRoot, now, record });
    let assertion = null;
    if (kind === 'conclusion') {
      const createdAt = new Date(Number.isFinite(at) ? at : nowDate(now).getTime()).toISOString();
      const recordId = makeRecordId({ content: text, createdAt, source: 'activity-conclusion' });
      // EA-02：结论来源由服务端判定（活动流结论 = agent），不接受行内自报。
      const sourceTier = 'agent';
      const evidence = evaluateEvidenceForWrite(Array.isArray(row.anchors) ? row.anchors : [], { verifiedAt: createdAt }).evidence.map((entry) => ({ anchorId: entry.anchorId, sha256: entry.sha256, excerptRef: entry.excerptRef, verifiedAt: entry.verifiedAt, valid: entry.valid }));
      assertion = appendRecordLine({
        memoryRoot,
        record: {
          id: recordId,
          kind: 'conclusion',
          content: text,
          subject: row.subject ?? null,
          project,
          salience: 4,
          importance: 0.6,
          status: 'active',
          createdAt,
          lastUsed: createdAt.slice(0, 10),
          useCount: 0,
          anchors: Array.isArray(row.anchors) ? row.anchors : [],
          evidence,
          sourceTier,
          conflict: false,
          conflict_with: [],
          state: 'active',
          anchorStatus: evidence.length > 0 ? 'live' : 'missing',
          supersedes: [],
          supersededBy: null,
          audit: { createdBy: 'activity-capture', source: 'board-conclusion' },
        },
      });
    }
    if (assertion && assertion.written) {
      try {
        appendClaimFromRecord({ memoryRoot, record: { id: makeRecordId({ content: text, createdAt: new Date(Number.isFinite(at) ? at : nowDate(now).getTime()).toISOString(), source: 'activity-conclusion' }), kind: 'conclusion', content: text, subject: row.subject ?? null, project, salience: 4, createdAt: new Date(Number.isFinite(at) ? at : nowDate(now).getTime()).toISOString(), evidence: evaluateEvidenceForWrite(Array.isArray(row.anchors) ? row.anchors : []).evidence, sourceTier: 'agent', state: 'active' }, now });
      } catch {
        /* claim bridge best effort; records write already succeeded */
      }
    }
    return { ok: true, id, kind, indexed, assertion };
  }

  function captureBoardFile(activityPath = path.join(memoryRoot, '.longlive', 'board', 'activity.jsonl')) {
    const out = { file: activityPath, rows: 0, inserted: 0, skipped: 0, conclusions: 0, errors: [] };
    let text = '';
    try {
      text = fs.readFileSync(activityPath, 'utf8');
    } catch {
      return { ...out, code: 'E_ACTIVITY_FILE_MISSING' };
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let row = null;
      try {
        row = JSON.parse(line);
      } catch {
        out.errors.push({ code: 'E_ACTIVITY_JSON' });
        continue;
      }
      const result = captureBoardRow(row);
      out.rows += 1;
      if (result.indexed?.inserted) out.inserted += 1;
      else out.skipped += 1;
      if (result.kind === 'conclusion') out.conclusions += 1;
    }
    return out;
  }

  function captureLiveRows(liveDir = path.join(memoryRoot, '.longlive', 'live')) {
    const out = { dir: liveDir, files: 0, inserted: 0, skipped: 0, errors: [] };
    let entries = [];
    try {
      entries = fs.readdirSync(liveDir, { withFileTypes: true });
    } catch {
      return { ...out, code: 'E_LIVE_DIR_MISSING' };
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path.join(liveDir, entry.name);
      let row = null;
      try {
        row = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        out.errors.push({ file: entry.name, code: 'E_LIVE_JSON' });
        continue;
      }
      out.files += 1;
      const sessionId = typeof row.sessionId === 'string' ? row.sessionId : entry.name.replace(/\.json$/, '');
      const updatedAt = Number(row.updatedAt ?? row.at ?? 0);
      const at = Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : fs.statSync(file).mtimeMs;
      const state = String(row.state ?? 'unknown');
      const goal = String(row.goal ?? '');
      const lastAction = row.lastAction ?? null;
      const summary = `会话 ${sessionId} state=${state}${Number.isInteger(row.turn) ? ` turn=${row.turn}` : ''}`
        + `${goal ? ` goal=${goal}` : ''}${lastAction ? ` lastAction=${lastAction.kind ?? ''}` : ''}`;
      const record = {
        id: `evt:live:${sessionId}:${Math.round(at / 1000)}`,
        sessionId,
        turn: Number.isInteger(row.turn) ? row.turn : 0,
        seqStart: null,
        seqEnd: null,
        timeStart: at,
        timeEnd: at,
        project: row.project ?? null,
        kind: 'status',
        topics: ['live', 'status'],
        terms: [state, ...(goal !== '' ? [goal] : [])].slice(0, 20),
        summary: summary.slice(0, 400),
        counts: {},
        anchors: [],
        digest: sha256Hex(stableStringify({ sessionId, state, turn: row.turn ?? null, goal, lastAction, at })),
        source: 'activity-capture',
      };
      const indexed = upsertEventRecord({ memoryRoot, now, record });
      if (indexed.inserted) out.inserted += 1;
      else out.skipped += 1;
    }
    return out;
  }

  function captureGoal(goal = {}) {
    const text = String(goal.text ?? '').trim();
    if (text === '') return { ok: false, code: 'E_GOAL_TEXT' };
    const at = Number.isFinite(goal.at) ? goal.at : nowDate(now).getTime();
    const createdAt = new Date(at).toISOString();
    const record = {
      id: makeRecordId({ content: text, createdAt, source: 'goal' }),
      kind: 'goal',
      content: text,
      subject: goal.subject ?? null,
      project: goal.project ?? null,
      salience: 4,
      importance: 0.7,
      status: goal.status === 'expired' ? 'expired' : 'active',
      createdAt,
      lastUsed: createdAt.slice(0, 10),
      useCount: 0,
      anchors: Array.isArray(goal.anchors) ? goal.anchors : [],
      evidence: evaluateEvidenceForWrite(Array.isArray(goal.anchors) ? goal.anchors : []).evidence,
      sourceTier: 'host', // EA-02：目标由宿主运行时写入，服务端判定
      conflict: false,
      conflict_with: [],
      state: 'active',
      anchorStatus: 'missing',
      supersedes: [],
      supersededBy: null,
      ttlDays: Number.isInteger(goal.ttlDays) ? goal.ttlDays : 7,
      audit: { createdBy: 'activity-capture', source: 'goal-focus' },
    };
    const written = appendRecordLine({ memoryRoot, record });
    return { ok: true, id: record.id, written: written.written };
  }

  function captureAll(input = {}) {
    return {
      board: captureBoardFile(input.activityPath),
      live: captureLiveRows(input.liveDir),
    };
  }

  return { memoryRoot, captureBoardRow, captureBoardFile, captureLiveRows, captureGoal, captureAll };
}
