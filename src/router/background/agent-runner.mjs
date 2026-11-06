// agent-runner.mjs — 后台 agent 的正确生命周期（按真宿主形状）
//
// 宿主事实（_hostsrc/dsh-agent-loop, dsh-agent）：
//   - agents.create() 返回 **{ agent, dispose }**（createAgent :1893-1913，
//     prepare().publish() :1796-1800）；它不返回带 followup/whenIdle 的富句柄。
//   - followup(input) 在 **agent** 上（:806-808），whenIdle() 也在 agent 上
//     （:870-875）；status 只有 'idle' | 'running'（:790-791），没有 result、
//     没有 'failed'/'aborted' 状态。
//   - 回答不在句柄上，在 session transcript 里；session.deriveMessages()
//     （dsh-session :1672-1687）给出按 surface 重放的消息序列。
//   - dispose 在 create() 的返回值上，走与 unload 相同的 teardown（:1740-1746）。
//
// 红队 P0-2 的教训：旧实现调 handle.followup / handle.whenIdle / handle.result，
// 在真宿主上直接 E_AGENT_IDLE（handle.followup is not a function）。
//
// 顺序仍然是 create -> followup -> whenIdle -> dispose（finally），任何一步失败
// 都不留下已发布但没人回收的 agent。dispose 超时（P20 僵尸）时：先 cancel，
// 再调用宿主可选的 forceDispose/reap 兜底，并把 disposed/forced 如实返回。

import { randomUUID } from 'node:crypto';

export const AGENT_RUNNER_ERRORS = Object.freeze({
  SETUP: 'E_AGENT_SETUP',
  CREATE: 'E_AGENT_CREATE',
  SHAPE: 'E_AGENT_SHAPE',
  FOLLOWUP: 'E_AGENT_FOLLOWUP',
  IDLE: 'E_AGENT_IDLE',
  TIMEOUT: 'E_AGENT_TIMEOUT',
  DISPOSE: 'E_AGENT_DISPOSE_TIMEOUT',
  DISPOSED: 'E_AGENT_DISPOSED',
});

/**
 * 构造宿主接受的 durable user message：content 是 block 数组，且必须有 id。
 * 真实宿主用 @deepseek-ai/dsh-llm 的 createUserMessage(input)（:58-63），
 * 它内部 createMessage 会补 id（:36-41）；这里给出同形状的 fallback，测试可以
 * 注入真实工厂来验证 id 来源。
 */
export function createUserMessage(text, source = { kind: 'router' }, factory = null) {
  const input = {
    content: [{ type: 'text', text: String(text ?? '') }],
    source,
  };
  if (typeof factory === 'function') return factory(input);
  return { id: `msg-${randomUUID()}`, role: 'user', ...input };
}

function timeoutRace(promise, timeoutMs, code, label = 'operation') {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      error.code = code;
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/** 从 session transcript 取最后一条 assistant 文本（宿主没有 handle.result）。 */
export function lastAssistantText(agent) {
  let messages = [];
  try {
    const session = agent?.session;
    if (typeof session?.deriveMessages === 'function') messages = session.deriveMessages();
    else if (Array.isArray(session?.messages)) messages = session.messages;
    else if (Array.isArray(session?.log)) {
      messages = session.log
        .filter((event) => event?.type === 'assistant/message')
        .map((event) => event.data?.message ?? event.data);
    }
  } catch {
    messages = [];
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'assistant') continue;
    const text = textFromContent(message.content);
    if (text !== null) return text;
  }
  return null;
}

/**
 * 创建一个后台 agent 跑一个 turn，等它空闲，然后无论成败都 dispose。
 *
 * @param {object} options
 * @param {object} options.agents 宿主 ctx.agents
 * @param {string} options.prompt
 * @param {(agentCtx:object, agent:object)=>any} [options.setup] 在这里安装 restrict/guard
 * @param {object} [options.agentOptions]
 * @param {string} [options.sessionId]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs=5000]
 * @param {number} [options.disposeTimeoutMs=1000]
 * @param {object} [options.source]
 * @param {Function} [options.createMessage] durable message 工厂（测试注入真实现）
 * @returns {Promise<{ok:boolean, agentId?:string, text?:string|null, code?:string, message?:string, disposed:boolean, forced?:boolean}>}
 */
export async function runAgentTask({
  agents,
  prompt,
  setup,
  agentOptions = {},
  sessionId = `router-${Date.now().toString(36)}`,
  signal,
  timeoutMs = 5000,
  disposeTimeoutMs = 1000,
  source = { kind: 'router' },
  createMessage = null,
} = {}) {
  if (!agents || typeof agents.create !== 'function') {
    return { ok: false, code: AGENT_RUNNER_ERRORS.CREATE, message: 'ctx.agents.create() is unavailable', disposed: false };
  }
  if (signal?.aborted) {
    return { ok: false, code: 'E_ABORTED', message: 'aborted before create', disposed: false };
  }

  let created = null;
  try {
    created = await agents.create({ sessionId, agentOptions, setup, signal });
  } catch (error) {
    return {
      ok: false,
      code: error?.code ?? AGENT_RUNNER_ERRORS.SETUP,
      message: error?.message ?? String(error),
      disposed: false,
    };
  }

  if (!created || typeof created !== 'object' || !created.agent) {
    return {
      ok: false,
      code: AGENT_RUNNER_ERRORS.SHAPE,
      message: 'agents.create() must return { agent, dispose }',
      disposed: false,
    };
  }

  const agent = created.agent;
  const dispose = typeof created.dispose === 'function'
    ? created.dispose
    : (typeof agent.dispose === 'function' ? () => agent.dispose() : null);

  let outcome;
  let disposed = false;
  let forced = false;
  let disposeTimedOut = false;

  try {
    if (typeof agent.followup !== 'function') {
      const error = new Error('agent.followup() is not available');
      error.code = AGENT_RUNNER_ERRORS.FOLLOWUP;
      throw error;
    }
    if (typeof agent.whenIdle !== 'function') {
      const error = new Error('agent.whenIdle() is not available');
      error.code = AGENT_RUNNER_ERRORS.IDLE;
      throw error;
    }

    const message = createUserMessage(prompt, source, createMessage);
    await timeoutRace(
      Promise.resolve(agent.followup(message)),
      timeoutMs,
      AGENT_RUNNER_ERRORS.TIMEOUT,
      'agent.followup',
    );
    await timeoutRace(
      Promise.resolve(agent.whenIdle()),
      timeoutMs,
      AGENT_RUNNER_ERRORS.TIMEOUT,
      'agent.whenIdle',
    );

    if (signal?.aborted) {
      outcome = { ok: false, agentId: agent.id, code: 'E_ABORTED', message: 'agent turn aborted' };
    } else if (agent.status && agent.status !== 'idle') {
      // 真宿主只有 idle|running；whenIdle 之后仍非 idle 说明被再次唤醒。
      outcome = {
        ok: false,
        agentId: agent.id,
        code: AGENT_RUNNER_ERRORS.IDLE,
        message: `agent ended in status "${agent.status}"`,
      };
    } else {
      const text = lastAssistantText(agent);
      // 真 agent 没有 result 字段：回答只能从 session transcript 推导。
      outcome = { ok: true, agentId: agent.id, status: agent.status ?? 'idle', text };
    }
  } catch (error) {
    outcome = {
      ok: false,
      agentId: agent.id,
      code: error?.code ?? AGENT_RUNNER_ERRORS.IDLE,
      message: error?.message ?? String(error),
    };
    // 超时/失败时先请 agent 停下；真正的回收留给 dispose。
    try { agent.cancel?.('router_abort'); } catch { /* best effort */ }
  } finally {
    if (dispose) {
      try {
        await timeoutRace(
          Promise.resolve(dispose()),
          disposeTimeoutMs,
          AGENT_RUNNER_ERRORS.DISPOSE,
          'agent.dispose',
        );
        disposed = true;
      } catch (error) {
        disposeTimedOut = error?.code === AGENT_RUNNER_ERRORS.DISPOSE;
        try { agent.cancel?.('dispose_timeout'); } catch { /* best effort */ }
        // 宿主提供了强制清理钩子（本 spike 的 host-sim）就用它；真宿主没有这个
        // 方法，此时如实返回 disposed:false，让上层看见僵尸。
        const force = agents.forceDispose ?? agents.reap;
        if (typeof force === 'function') {
          try {
            await Promise.resolve(force.call(agents, agent.id ?? agent));
            disposed = true;
            forced = true;
          } catch { /* 强制清理也失败：保持 disposed:false */ }
        }
      }
    }
  }

  return { ...outcome, disposed, forced, disposeTimedOut };
}
