// src/autoprocedure/rules.js — A 模式：纯本地规则蒸馏（D1，默认路径）。
//
// 零 LLM、零网络、零 provider 探测：全部四段文本来自本地模板 + 事件字段。
// 提取对象：已完成工具调用序列（工具名 + 关键参数 + 结果状态）、exit code /
// 错误行、失败错误行、验证命令。蒸馏前每个片段先过 privacy 门（F9 第一道），
// 命中即丢弃该片段并计数（由 runtime 记进账本）。
//
// 不变量：没有成功步骤 → 不产出候选（eligible:false），由 runtime 记
// terminal reject reason=ineligible；绝不为了产出而编造步骤。

import { buildTurnItems } from '../original.js';
import { dayString } from '../memory/frontmatter.js';
import { sanitizeFragment } from './privacy.js';
import { makeSessionEvidence, makeD2Evidence, sessionToolResultText } from './evidence.js';

export const RULES_MAX_STEPS = 10;
export const RULES_MAX_FAILURES = 5;
export const RULES_CLIP = 200;
export const RULES_NAME_MAX = 120;

const ERROR_LINE = /(?:^|\r?\n)\s*(?:error|ERROR|Error|错误|失败|异常|Exception|Traceback|EACCES|EPERM|ENOENT|not found|No such file|permission denied|denied|timed out|超时|exit code [1-9])[^\r\n]*/g;

function clip(text, max = RULES_CLIP) {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim();
  return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}…`;
}

function cjkToken(value) {
  return /[\u3400-\u9fff]/.test(value);
}

/** Split a task sentence into trigger-word candidates (deterministic, no deps). */
export function triggerCandidates(userText, toolNames = []) {
  const stop = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'then',
    '然后', '我们', '可以', '一个', '这个', '那个', '需要', '进行', '使用', '任务', '文件', '命令',
    '现在', '请先', '帮我', '一下', '这样', '就是', '还是', '已经', '如果', '之后', '接着',
  ]);
  const seen = new Set();
  const tokens = [];
  const push = (raw) => {
    let token = String(raw ?? '').replace(/[,\[\]，、]/g, '').trim();
    // Light segmentation for CJK run-on sentences: split on conjunctions, then
    // trim a leading polite verb. No dictionary, no dependency — deterministic.
    token = token.replace(/^[请帮给我把将再就还]+/u, '');
    if (token.length < 2 || token.length > 60) return;
    const key = token.toLowerCase();
    if (stop.has(key) || /^\d+$/.test(token) || seen.has(key)) return;
    if (!cjkToken(token) && token.length < 3) return;
    seen.add(key);
    tokens.push(token);
  };
  for (const raw of String(userText ?? '').split(/[\s,，。、；;：:!?！？（）()\[\]【】"'“”‘’`<>|/\\]+/u)) {
    for (const piece of raw.split(/并|和|与|及|然后|接着|之后|再去|还有/u)) push(piece);
  }
  for (const name of Array.isArray(toolNames) ? toolNames : []) push(name);
  // Prefer the task words (CJK) first, then tool names; the per-key cap is 3.
  const cjk = tokens.filter((token) => cjkToken(token)).slice(0, 3);
  const rest = tokens.filter((token) => !cjkToken(token)).slice(0, 3);
  return [...new Set([...cjk, ...rest])].slice(0, 5);
}

function parseCallArgs(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    /* a non-JSON argument string is still usable text */
  }
  return null;
}

function argSummary(args, rawText) {
  if (!args) return clip(rawText, 160);
  const priority = ['command', 'cmd', 'script', 'path', 'filePath', 'file_path', 'file',
    'pattern', 'query', 'url', 'target', 'name', 'prompt'];
  const parts = [];
  for (const key of priority) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') {
      parts.push(clip(value, 160));
      if (parts.length >= 2) break;
    }
  }
  if (parts.length === 0) {
    for (const [key, value] of Object.entries(args)) {
      if (parts.length >= 2) break;
      if (typeof value === 'string' && value.trim() !== '' && key !== 'description') parts.push(`${key}=${clip(value, 80)}`);
      else if (typeof value === 'number' || typeof value === 'boolean') parts.push(`${key}=${value}`);
    }
  }
  return parts.join('；') || clip(rawText, 160);
}

function exitCodeOf(resultText) {
  const match = /(?:exit\s*code|退出码|\$LASTEXITCODE)[^0-9-]{0,16}(-?\d+)/i.exec(String(resultText ?? ''));
  return match ? Number(match[1]) : null;
}

function failureLinesOf(resultText) {
  const out = [];
  const text = String(resultText ?? '');
  ERROR_LINE.lastIndex = 0;
  let match = ERROR_LINE.exec(text);
  while (match !== null && out.length < 3) {
    const line = match[0].replace(/^\s+/, '').trim();
    if (line !== '') out.push(clip(line, 160));
    match = ERROR_LINE.exec(text);
  }
  return out;
}

function slugOf(sessionId, turn) {
  // Deterministic suffix: same session/turn = same candidate slug (idempotent,
  // and never derived from user text so a crafted name cannot escape staging).
  let h = 2166136261;
  const text = `${sessionId}|${turn}`;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `auto-${turn}-${(h >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Build the local (A-mode) candidate draft for one completed turn.
 *
 * @returns {{eligible:boolean, reason?:string, stats:object, draft?:object}}
 */
export function buildRuleDraft({
  sessionId,
  turn,
  parsed,
  turnSample,
  minToolCalls = 8,
  memoryRoot = '',
  home = '',
  now = new Date(),
  readFile = null,
}) {
  const stats = { completedCalls: 0, successfulCalls: 0, privacyDropped: 0, evidenceDropped: 0 };
  const turns = buildTurnItems(parsed?.events ?? []);
  const items = turns.get(turn) ?? [];
  const calls = items.filter((item) => item.kind === 'call');
  const results = new Map();
  for (const item of items) {
    if (item.kind === 'tool' && item.toolCallId) results.set(item.toolCallId, item);
  }
  const completed = calls.filter((call) => call.toolCallId && results.has(call.toolCallId));
  stats.completedCalls = completed.length;
  if (completed.length < Math.max(0, minToolCalls)) {
    return { eligible: false, reason: 'min_tool_calls', stats: { ...stats, requiredCalls: minToolCalls } };
  }
  const successful = completed.filter((call) => results.get(call.toolCallId)?.isError !== true);
  stats.successfulCalls = successful.length;
  if (successful.length === 0) {
    return { eligible: false, reason: 'no_successful_calls', stats };
  }

  const privacyOptions = { memoryRoot, home };
  const sanitize = (text, max) => {
    const result = sanitizeFragment(clip(text, max), privacyOptions);
    if (!result.ok) {
      stats.privacyDropped += 1;
      return null;
    }
    return result.text;
  };

  const userItem = items.find((item) => item.kind === 'message' && item.role === 'user' && item.text.trim() !== '');
  const rawUserText = userItem ? userItem.text : '';
  const userText = sanitize(rawUserText, 300) ?? '';

  const evidence = [];
  const steps = [];
  const calledToolNames = [];
  const failureLines = [];
  const turnSeq = { seqStart: turnSample.seqStart, seqEnd: turnSample.seqEnd, turnDigest: turnSample.digest };

  for (const call of successful) {
    const result = results.get(call.toolCallId);
    const toolName = call.toolName || result?.toolName || 'tool';
    if (!calledToolNames.includes(toolName)) calledToolNames.push(toolName);
    const args = parseCallArgs(call.text);
    const summary = argSummary(args, call.text);
    const exitCode = exitCodeOf(result?.text);
    const stepText = sanitize(
      `调用 ${toolName}：${summary}${exitCode === 0 ? '（退出码 0）' : (exitCode !== null ? `（退出码 ${exitCode}）` : '')}`,
      400,
    );
    if (stepText === null) continue;
    const stepIndex = steps.length + 1;
    steps.push(stepText);
    // Session evidence hangs on the tool/call event line (the step's own record).
    const callEvidence = makeSessionEvidence({
      step: stepIndex,
      sessionId,
      turn,
      turnSample,
      seq: call.seq,
    });
    if (callEvidence) evidence.push(callEvidence);
    else stats.evidenceDropped += 1;

    // D2 evidence is optional and additive: it anchors the archived tool output.
    if (result && typeof call.toolCallId === 'string' && call.toolCallId !== '') {
      const d2 = makeD2Evidence({
        step: stepIndex,
        memoryRoot,
        sessionId,
        turn,
        seqStart: turnSeq.seqStart,
        seqEnd: turnSeq.seqEnd,
        turnDigest: turnSeq.turnDigest,
        callId: call.toolCallId,
        sessionResultText: sessionToolResultText(parsed?.events, call.toolCallId),
        readFile,
      });
      if (d2.ok) evidence.push(d2.evidence);
      else if (d2.code !== 'E_EVIDENCE_D2_MISSING') stats.evidenceDropped += 1;
    }

    for (const line of failureLinesOf(result?.text)) {
      if (failureLines.length >= RULES_MAX_FAILURES) break;
      const clean = sanitize(line, 200);
      if (clean !== null) failureLines.push(clean);
    }
    if (steps.length >= RULES_MAX_STEPS) break;
  }
  if (steps.length === 0) {
    return { eligible: false, reason: 'no_steps', stats };
  }

  const trigger = triggerCandidates(userText, calledToolNames).slice(0, 5);
  if (trigger.length === 0) {
    return { eligible: false, reason: 'no_trigger', stats };
  }

  const toolSequence = calledToolNames.join(' → ') || '（未记录工具名）';
  const when = userText !== ''
    ? `当用户提出与「${clip(userText, 120)}」类似的任务时，按本次成功路径执行。`
    : `当需要复现本次工具链（${toolSequence}）时使用。`;
  const failureModes = failureLines.length > 0
    ? failureLines.join('\n')
    : '（本次轨迹未记录失败；成功路径见「怎么做」，复用时仍需自行验证。）';
  const example = `第 ${turn} 轮，共 ${completed.length} 次工具调用（成功 ${successful.length} 次）。`
    + `工具序列：${toolSequence}。`
    + (userText !== '' ? `触发任务：${clip(userText, 80)}。` : '');
  const cleanWhen = sanitize(when, 600) ?? `当需要复现本次工具链（${toolSequence}）时使用。`;
  const cleanFailure = sanitize(failureModes, 1000) ?? '（本次轨迹未记录失败。）';
  const cleanExample = sanitize(example, 600) ?? `第 ${turn} 轮：${toolSequence}。`;

  const baseName = userText !== '' ? clip(userText, 60) : toolSequence;
  const name = clip(`自动候选·第${turn}轮：${baseName}`, RULES_NAME_MAX);
  const slug = slugOf(sessionId, turn);

  return {
    eligible: true,
    stats,
    draft: {
      name,
      slug,
      trigger,
      salience: 3,
      strength: 3,
      lastUsed: dayString(now instanceof Date ? now : new Date(now)),
      sections: {
        when: cleanWhen,
        steps,
        failureModes: cleanFailure,
        example: cleanExample,
      },
      evidence,
      source: {
        sessionId,
        turn,
        seqStart: turnSample.seqStart,
        seqEnd: turnSample.seqEnd,
        turnDigest: turnSample.digest,
      },
      generator: 'rules',
      llm: { used: false, model: null, tokens: { in: 0, out: 0 } },
      stats,
    },
  };
}
