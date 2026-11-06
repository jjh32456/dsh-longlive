// routerFace v1 · 调用宿主的 LLM。
//
// 宿主 API 假设（2026-11-05，依据本仓 src/router/service/service.mjs 的既有
// 用法，不是猜的）：
//   const llm = ctx.get('llm');                       // 不能读 ctx.llm
//   llm.stream({ messages, task, signal, maxTokens,
//                provider, model, reasoningEffort? })  // 返回 AsyncIterable
//   chunk 协议 block-start / text-delta / usage / finish，由
//   src/router/background/stream.mjs 的 consumeStream 消费。
//   provider/model 由 src/router/service/model-resolve.mjs 的
//   resolveModelTarget 解析（显式配置 → 宿主当前选择 → 列表首个）。
//
// 没有 HTTP 兜底：宿主 llm 服务缺失时进入 waiting-provider（写 status，
// 不调用、不重试、不读凭据）。HTTP 直连会绕开宿主 provider 配置和审计，
// v1 明确不做。
//
// 测试注入：deps.client 支持
//   - { complete: async ({messages,...}) => "文本" | { text } }
//   - { stream: async function* ({messages,...}) { ... } }  （走 consumeStream）
//   - 直接一个 async 函数（等价于 complete）
// 注入 client 时完全不碰 ctx.get('llm')。

import { buildMessages, consumeStream } from '../background/stream.mjs';
import { resolveModelTarget } from '../service/model-resolve.mjs';
import { estimateTokens } from '../service/tokens.mjs';
import { FACE_TICK_TASK } from './config.mjs';

export const FACE_SYSTEM_PROMPT = [
  '你是 longlive 的后台面（不是前台会话，也没有任何工具）。',
  '你只能读下面给出的只读材料，写一条 journal 和最多 3 条建议。',
  '硬约束：',
  '1) 你没有工具、不能读文件、不能执行命令、不能修改任何记忆或状态、不能给前台派活；',
  '2) 建议只会写进跨会话 outbox，前台自己决定要不要看，不要把它写成命令或承诺；',
  '3) 不确定的事就说不确定，不要编数字，不要复述自己看不到的东西；',
  '4) journal ≤400 字，建议每条 ≤200 字，最多 3 条；',
  '5) 只输出一个 JSON 对象：{"journal":"...","suggestions":["..."]}，不要输出 JSON 之外的文字。',
].join('\n');

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** 把组装好的上下文包成 user prompt。 */
export function buildFacePrompt(contextText, options = {}) {
  const at = typeof options.at === 'string' ? options.at : new Date().toISOString();
  return [
    `现在：${at}`,
    '',
    contextText && String(contextText).trim() !== ''
      ? String(contextText).trim()
      : '（这个 tick 没有可读材料；请如实写一条 journal，不要编造状态。）',
    '',
    '请按要求输出 JSON：{"journal":"…","suggestions":["…"]}。',
  ].join('\n');
}

/**
 * 解析模型输出。模型不听话（输出纯文本、代码块、多个 JSON）时退回
 * 「整段当 journal、没有建议」，而不是让 tick 失败。
 */
export function parseFaceOutput(text, options = {}) {
  const maxJournalChars = Number.isInteger(options.maxJournalChars) ? options.maxJournalChars : 400;
  const maxSuggestions = Number.isInteger(options.maxSuggestions) ? options.maxSuggestions : 3;
  const maxSuggestionChars = Number.isInteger(options.maxSuggestionChars) ? options.maxSuggestionChars : 200;
  const raw = String(text ?? '').trim();
  const cap = (value, max) => {
    const chars = Array.from(oneLine(value));
    return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join('')}…` : chars.join('');
  };
  if (raw === '') return { journal: '', suggestions: [], mode: 'empty' };

  let parsed = null;
  let mode = 'text';
  const unfenced = raw.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  const candidates = [unfenced];
  const first = unfenced.indexOf('{');
  const last = unfenced.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(unfenced.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object') {
        parsed = value;
        mode = 'json';
        break;
      }
    } catch {
      // 继续尝试下一个候选。
    }
  }

  if (!parsed) {
    return { journal: cap(raw, maxJournalChars), suggestions: [], mode };
  }
  const journal = cap(parsed.journal ?? parsed.text ?? parsed.summary ?? '', maxJournalChars);
  const suggestions = [];
  const list = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
  for (const item of list) {
    const value = typeof item === 'string' ? item : item && typeof item.text === 'string' ? item.text : '';
    const text = cap(value, maxSuggestionChars);
    if (text !== '') suggestions.push(text);
    if (suggestions.length >= maxSuggestions) break;
  }
  return { journal, suggestions, mode };
}

function readClient(ctx) {
  try {
    const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : null;
    return llm && typeof llm.stream === 'function' ? llm : null;
  } catch {
    return null;
  }
}

function normalizeUsage(usage, promptText, outputText) {
  if (usage && typeof usage === 'object') {
    const inputTokens = Number.isInteger(usage.inputTokens) ? usage.inputTokens : 0;
    const outputTokens = Number.isInteger(usage.outputTokens) ? usage.outputTokens : 0;
    if (inputTokens > 0 || outputTokens > 0) {
      return {
        inputTokens,
        outputTokens,
        cacheReadTokens: Number.isInteger(usage.cacheReadTokens) ? usage.cacheReadTokens : 0,
        cacheWriteTokens: Number.isInteger(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0,
        estimated: false,
      };
    }
  }
  return {
    inputTokens: estimateTokens(promptText),
    outputTokens: estimateTokens(outputText),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimated: true,
  };
}

async function callInjectedClient(client, request) {
  const complete = typeof client === 'function' ? client : client?.complete;
  if (typeof complete === 'function') {
    const value = await complete.call(client, request);
    const text = typeof value === 'string' ? value : value?.text ?? value?.content ?? '';
    return {
      ok: true,
      text: String(text ?? ''),
      usage: normalizeUsage(value?.usage, request.prompt, String(text ?? '')),
      provider: 'injected',
      model: 'injected',
    };
  }
  if (typeof client?.stream === 'function') {
    const stream = await client.stream(request);
    const result = await consumeStream(stream, { signal: request.signal });
    if (!result.ok) {
      return {
        ok: false,
        error: result.failure?.code ?? result.code ?? 'E_FACE_STREAM',
        fatal: true,
        failure: result.failure ?? null,
        text: result.text ?? '',
      };
    }
    return {
      ok: true,
      text: result.text ?? '',
      usage: normalizeUsage(result.usage, request.prompt, result.text ?? ''),
      provider: 'injected',
      model: 'injected',
    };
  }
  return { ok: false, error: 'E_FACE_CLIENT_INVALID', fatal: true };
}

/**
 * 调一次模型。
 *
 * @returns {Promise<{ok:boolean,text:string,usage?:object,provider?:string,model?:string,error?:string,reason?:string,fatal?:boolean}>}
 */
export async function callFaceModel(options = {}) {
  const { ctx, config = {}, client = null, system, prompt, signal = null, maxTokens = 1024 } = options;
  const messages = buildMessages({ system: system ?? FACE_SYSTEM_PROMPT, prompt });

  if (client) {
    try {
      return await callInjectedClient(client, { messages, system, prompt, maxTokens, signal, task: FACE_TICK_TASK });
    } catch (error) {
      return {
        ok: false,
        error: error?.code ?? 'E_FACE_CLIENT',
        reason: String(error?.message ?? error),
        fatal: false,
        text: '',
      };
    }
  }

  const llm = readClient(ctx);
  if (!llm) {
    return { ok: false, error: 'E_NO_LLM', reason: 'waiting-provider', fatal: true, text: '' };
  }
  const resolved = resolveModelTarget({
    config: {
      provider: config.provider ?? '',
      model: config.model ?? 'auto',
      providerExplicit: config.providerExplicit === true,
    },
    ctx,
    llm,
  });
  if (!resolved.ok) {
    return { ok: false, error: resolved.code ?? 'E_NO_PROVIDER', reason: resolved.reason ?? 'unresolved', fatal: true, text: '' };
  }

  try {
    const stream = llm.stream({
      messages,
      task: FACE_TICK_TASK,
      signal,
      maxTokens,
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}),
    });
    const result = await consumeStream(stream, { signal });
    if (!result.ok) {
      return {
        ok: false,
        error: result.failure?.code ?? result.code ?? 'E_FACE_STREAM',
        reason: result.failure?.message ?? null,
        fatal: true,
        failure: result.failure ?? null,
        text: result.text ?? '',
      };
    }
    return {
      ok: true,
      text: result.text ?? '',
      usage: normalizeUsage(result.usage, prompt, result.text ?? ''),
      provider: resolved.provider,
      model: resolved.model,
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.code ?? 'E_FACE_MODEL',
      reason: String(error?.message ?? error),
      fatal: false,
      text: '',
    };
  }
}
