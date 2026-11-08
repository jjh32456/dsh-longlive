// answer/tool.js — `answer_audit`：只读查询生成后审计。
//
// 只在 answerGuard.enabled 时注册（tools/list 默认仍是 22 个基线工具），
// 与 routerTools / d6Tools 一样由 registerTools 追加，绝不改变默认工具面。

import { auditFilePath, auditMetrics, readAuditRows } from './audit.js';

export const ANSWER_AUDIT_TOOL_NAME = 'answer_audit';

/**
 * @param {string|null} memoryRoot
 * @returns {object} tool definition consumed by src/tools.js registerTools
 */
export function createAnswerTools(memoryRoot) {
  const root = typeof memoryRoot === 'string' && memoryRoot.trim() !== '' ? memoryRoot.trim() : null;
  return [{
    name: ANSWER_AUDIT_TOOL_NAME,
    description:
      'Query the post-generation answer audit written by the 1.6.5 answer guard ' +
      '(`<memoryRoot>/.longlive/answer-audit.jsonl`). One row per audited turn: whether a ' +
      'history question was answered without a turn citation, whether the assistant claimed a ' +
      'tool it never called, numbers/dates absent from context and tool results, and nonexistent ' +
      'turn/card references. READ-ONLY: it never edits the assistant text or the session log. ' +
      'Filters: sessionId, turn, verdict (clean|flagged), code (HISTORY_CLAIM_NO_CITATION, ' +
      'ANSWERED_WITHOUT_EVIDENCE, FAKE_TOOL_CLAIM, UNGROUNDED_NUMBER, FAKE_TURN_REF, FAKE_CARD_REF), ' +
      'since (ISO time). Default returns the newest 20 rows plus byVerdict/byCode counts.',
    parameters: {
      sessionId: {
        type: 'string',
        description: 'Only rows for this session id.',
      },
      turn: {
        type: 'integer',
        description: 'Only rows for this 1-based turn number.',
      },
      verdict: {
        type: 'string',
        enum: ['clean', 'flagged'],
        description: 'Only rows with this verdict.',
      },
      code: {
        type: 'string',
        description: 'Only rows containing this flag code.',
      },
      since: {
        type: 'string',
        description: 'Only rows at or after this ISO timestamp.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum rows returned (default 20, max 500).',
      },
      summary: {
        type: 'boolean',
        description: 'Default true: include byVerdict / byCode / metrics. false returns rows only.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
    },
    invoke: (args = {}) => answerAudit(args, { memoryRoot: root }),
  }];
}

/**
 * 工具实现（也直接给测试用）。永远不抛。
 * @param {object} args
 * @param {{memoryRoot?:string|null,limit?:number}} config
 */
export function answerAudit(args = {}, config = {}) {
  const memoryRoot = typeof config.memoryRoot === 'string' && config.memoryRoot.trim() !== ''
    ? config.memoryRoot.trim()
    : null;
  if (!memoryRoot) {
    return {
      ok: false,
      code: 'E_NO_MEMORY_ROOT',
      error: '没有可用的记忆根目录；审计文件位于 <memoryRoot>/.longlive/answer-audit.jsonl。',
      path: '',
    };
  }
  const limit = Number.isFinite(Number(args.limit))
    ? Math.max(1, Math.min(500, Number(args.limit)))
    : 20;
  const read = readAuditRows(memoryRoot, {
    limit,
    sessionId: typeof args.sessionId === 'string' ? args.sessionId : undefined,
    turn: Number.isFinite(Number(args.turn)) ? Number(args.turn) : undefined,
    verdict: typeof args.verdict === 'string' ? args.verdict : undefined,
    code: typeof args.code === 'string' ? args.code : undefined,
    since: typeof args.since === 'string' ? args.since : undefined,
  });
  const base = {
    ok: read.ok,
    path: read.path || auditFilePath(memoryRoot),
    total: read.total,
    matched: read.matched,
    corrupt: read.corrupt,
    ...(read.error ? { note: read.error } : {}),
    rows: read.rows,
  };
  if (args.summary === false) return base;
  return {
    ...base,
    byVerdict: read.byVerdict,
    byCode: read.byCode,
    sessions: read.sessions,
    metrics: auditMetrics(read.rows),
  };
}
