// 上下文组装（DESIGN §3）。assembleContext 是纯函数：
// 输入 tier + task + 已读好的 sources，输出可直接发给模型的文本与账目；
// 不读文件、不调模型、不写日志，所以可以单独做单测。
//
// 预算口径：full 11,000 / reflect 2,000 都包含输出预留与安全边际。
// 裁剪只按 DESIGN §3.5 的顺序做，绝不为了塞进去而删系统提示、账本摘要、
// 输出预留或「在等什么」这一节。

import { buildOpenCard } from '../../identity/handover.js';
import { estimateTokens, headTailTruncate, truncateToTokens } from './tokens.mjs';
import { PLACEHOLDER } from './sources.mjs';

export const CONTEXT_TIERS = Object.freeze({
  full: Object.freeze({
    budget: 11000,
    system: 1600,
    openCardChars: 3200,
    openCardTokens: 2200,
    indexTokens: 1200,
    indexRows: 12,
    cardsTokens: 1200,
    cardTokens: 600,
    queueTokens: 900,
    queueRows: 8,
    ledgerTokens: 400,
    taskChars: 2000,
    taskTokens: 1500,
    outputReserve: 1000,
    safety: 1000,
  }),
  reflect: Object.freeze({
    budget: 2000,
    system: 700,
    openCardChars: 900,
    openCardTokens: 700,
    indexTokens: 0,
    indexRows: 0,
    cardsTokens: 0,
    cardTokens: 600,
    queueTokens: 200,
    queueRows: 3,
    ledgerTokens: 100,
    taskChars: 400,
    taskTokens: 400,
    outputReserve: 300,
    safety: 100,
  }),
});

const FULL_SYSTEM = `你是 dsh-longlive 的后台路由器（RouterService），运行在插件进程内，不是独立代理。
你的输入只有这张按预算裁剪过的开机卡：STATE.md 的三节、最新交接卡、INDEX 摘要、主题卡摘要、队列与预算账本。
你的输出必须、且只能以一行 ACTION JSON 结束：
ACTION: {"type":"note","note":"一句话"}
可用 type 只有 note、report、noop。note 只写观察；report 只能填写 summary/next/waiting 三个字段；noop 表示无话可说。
禁止：调用任何工具、读取任何文件、修改 STATE/INDEX/topics/journal/engram、读取凭据或执行命令。
你看到的内容可能缺失；缺失就写不知道，禁止编造。账本与审计在同一个用户可写目录，能力边界是防崩溃残留与误删，不防同用户蓄意篡改。
不要复述开机卡，不要输出 JSON 之外的正文。`;

const REFLECT_SYSTEM = `你是 dsh-longlive 的后台路由器，正在做一次低成本反思（reflect 层级）。
输入只有开机卡摘要、最多 3 条队列与一行预算。若没有值得记下的事，直接 ACTION: {"type":"noop"}。
输出只能以一行 ACTION JSON 结束，type 仅限 note/report/noop；禁止调用工具、读文件、写记忆。
缺失的信息不要猜。`;

function systemPrompt(tier) {
  return tier === 'reflect' ? REFLECT_SYSTEM : FULL_SYSTEM;
}

function taskPayloadText(task, maxChars) {
  const t = task && typeof task === 'object' ? task : {};
  const payload = t.payload && typeof t.payload === 'object' ? t.payload : {};
  const body = payload.note
    ?? payload.question
    ?? payload.text
    ?? payload.message
    ?? (Object.keys(payload).length > 0 ? JSON.stringify(payload) : '（无任务载荷）');
  const head = `任务 ${t.id ?? 'unknown'} type=${t.type ?? 'unknown'} depth=${t.depth ?? 0}`;
  const raw = `${head}\n${body}`;
  const cut = headTailTruncate(raw, maxChars);
  return cut.text;
}

function queueText(rows, maxRows) {
  const list = Array.isArray(rows) ? rows.slice(0, maxRows) : [];
  if (list.length === 0) return '【队列】空';
  const lines = list.map((row) => {
    const age = Number.isFinite(row.ageMs) ? `${Math.max(0, Math.round(row.ageMs / 1000))}s` : '?';
    return `- ${row.id ?? '?'} ${row.type ?? '?'} depth=${row.depth ?? 0} age=${age}`;
  });
  return `【队列】\n${lines.join('\n')}`;
}

function ledgerText(ledger) {
  const l = ledger && typeof ledger === 'object' ? ledger : {};
  const num = (value) => (Number.isFinite(value) ? value : 0);
  return `【预算】run ${num(l.runUsed)}/${num(l.runCap)} · day ${num(l.dayUsed)}/${num(l.dayCap)} · reserved ${num(l.reserved)}`;
}

function indexText(rows, maxRows) {
  const list = Array.isArray(rows) ? rows.slice(0, maxRows) : [];
  if (list.length === 0) return '';
  return `【INDEX】\n${list.map((row) => `- ${row.text}`).join('\n')}`;
}

function cardsText(cards) {
  return cards.map((card) => `【主题卡 ${card.name}】\n${card.text}`);
}

function openCardText(sources, maxChars) {
  const card = buildOpenCard({
    stateText: typeof sources.stateText === 'string' ? sources.stateText : null,
    handover: sources.handover ? { text: sources.handover.text, name: sources.handover.name } : undefined,
    maxChars,
    now: sources.now,
  });
  return card.text;
}

function makeParts(state, tier, cfg, sources) {
  const parts = [];
  parts.push({ key: 'system', text: state.system, cap: cfg.system, trimmable: false });

  const card = state.cardTextFor(state.cardChars);
  parts.push({ key: 'openCard', text: card, cap: cfg.openCardTokens, trimmable: true });

  if (cfg.indexRows > 0) {
    const index = indexText(sources.index?.rows ?? [], state.indexRows);
    if (index !== '') parts.push({ key: 'index', text: index, cap: cfg.indexTokens, trimmable: true });
  }
  const cards = cfg.cardsTokens > 0 ? cardsText(state.cards) : [];
  if (cfg.cardsTokens > 0) {
    cards.forEach((text, i) => {
      parts.push({ key: `card:${state.cards[i].name}`, text, cap: cfg.cardTokens, trimmable: true });
    });
  }

  parts.push({ key: 'queue', text: queueText(state.queueRows, state.queueLimit), cap: cfg.queueTokens, trimmable: true });
  parts.push({ key: 'ledger', text: ledgerText(sources.ledger), cap: cfg.ledgerTokens, trimmable: false });
  parts.push({ key: 'task', text: state.taskText, cap: cfg.taskTokens, trimmable: true });
  return parts;
}

function totalFor(parts, cfg) {
  const text = parts.map((part) => part.text).filter(Boolean).join('\n\n');
  return {
    text,
    contentTokens: estimateTokens(text),
    totalTokens: estimateTokens(text) + cfg.outputReserve + cfg.safety,
  };
}

function cloneState(sources) {
  return {
    cardChars: 0,
    cardTextFor(maxChars) {
      return openCardText(sources, maxChars);
    },
    cards: Array.isArray(sources.cards) ? sources.cards.slice() : [],
    queueRows: Array.isArray(sources.queue?.rows) ? sources.queue.rows.slice() : [],
    queueLimit: 0,
    indexRows: 0,
    taskText: '',
  };
}

/**
 * @param {{tier?:'full'|'reflect', task?:object, sources?:object,
 *          forceOverBudget?:boolean}} input
 *   forceOverBudget 只由 RouterService 的测试钩子传入（D-05），默认关闭；
 *   它让两档都走到裁剪尽头，用于构造 full+reflect 同时超预算的场景。
 * @returns {object}
 */
export function assembleContext(input = {}) {
  const requestedTier = input.tier === 'reflect' ? 'reflect' : 'full';
  const tier = requestedTier;
  const cfg = CONTEXT_TIERS[tier];
  const sources = input.sources && typeof input.sources === 'object' ? input.sources : {};
  const warnings = Array.isArray(sources.warnings) ? sources.warnings.slice() : [];

  if (!Array.isArray(sources.cards)) warnings.push('CARDS_MISSING');
  if (!sources.queue) warnings.push('QUEUE_MISSING');
  if (!sources.ledger) warnings.push('LEDGER_MISSING');

  const state = cloneState(sources);
  state.system = systemPrompt(tier);
  state.cardChars = cfg.openCardChars;
  state.queueLimit = cfg.queueRows;
  state.indexRows = cfg.indexRows;
  state.taskText = taskPayloadText(input.task, cfg.taskChars);

  const cardCharsSteps = tier === 'full'
    ? [3200, 2400, 1600, 900, 400, 200]
    : [900, 500, 200];
  let cardStep = 0;
  const queueSteps = tier === 'full' ? [8, 5, 3] : [3];
  let queueStep = 0;
  const indexSteps = tier === 'full' ? [12, 8, 6] : [0];
  let indexStep = 0;
  let taskHeadTailDone = false;
  let taskTokenDone = false;

  const contentCap = cfg.budget - cfg.outputReserve - cfg.safety;
  let dropped = [];

  for (let guard = 0; guard < 50; guard += 1) {
    const parts = makeParts(state, tier, cfg, sources);
    const totals = totalFor(parts, cfg);
    if (input.forceOverBudget !== true && totals.totalTokens <= cfg.budget) {
      const userText = parts.filter((part) => part.key !== 'system').map((part) => part.text).filter(Boolean).join('\n\n');
      return {
        ok: true,
        tier,
        requestedTier,
        degraded: requestedTier !== tier || input.degraded === true,
        budget: cfg.budget,
        contentTokens: totals.contentTokens,
        totalTokens: totals.totalTokens,
        outputReserve: cfg.outputReserve,
        safety: cfg.safety,
        parts: Object.fromEntries(parts.map((part) => [part.key, part.text])),
        dropped,
        warnings,
        text: totals.text,
        userText,
        messages: { system: parts.find((part) => part.key === 'system')?.text ?? '', prompt: userText },
      };
    }

    // 1) 主题卡 2 -> 1 -> 0（数组已按相关度/新鲜度降序，去尾部）
    if (state.cards.length > 0) {
      const removed = state.cards.pop();
      dropped.push(`card:${removed.name}`);
      continue;
    }

    // 2) 队列 8 -> 5 -> 3
    if (queueStep < queueSteps.length - 1) {
      queueStep += 1;
      state.queueLimit = queueSteps[queueStep];
      dropped.push(`queue:${state.queueLimit}`);
      continue;
    }

    // 3) 任务：保留头 60% + 尾 20%
    if (!taskHeadTailDone) {
      const chars = Array.from(state.taskText).length;
      if (chars > 200) {
        const cut = headTailTruncate(state.taskText, Math.max(200, Math.floor(chars * 0.6)));
        state.taskText = cut.text;
        taskHeadTailDone = true;
        dropped.push('task:head-tail');
        continue;
      }
      taskHeadTailDone = true;
    }
    if (!taskTokenDone) {
      const cut = truncateToTokens(state.taskText, cfg.taskTokens);
      if (cut.truncated) {
        state.taskText = cut.text;
        taskTokenDone = true;
        dropped.push('task:tokens');
        continue;
      }
      taskTokenDone = true;
    }

    // 4) INDEX 12 -> 8 -> 6（每一轮只降一档，下一轮还可以继续降）
    if (indexStep < indexSteps.length - 1) {
      indexStep += 1;
      state.indexRows = indexSteps[indexStep];
      dropped.push(`index:${state.indexRows}`);
      continue;
    }

    // 5) 开机卡：最近三件先缩，再我在哪，最后在等什么；最少 200 字符
    if (cardStep < cardCharsSteps.length - 1) {
      cardStep += 1;
      state.cardChars = cardCharsSteps[cardStep];
      dropped.push(`openCard:${state.cardChars}`);
      continue;
    }

    // 6) 还超：full 降 reflect；reflect 拒绝
    return {
      ok: false,
      code: 'E_CONTEXT_OVER_BUDGET',
      tier,
      requestedTier,
      budget: cfg.budget,
      contentTokens: totals.contentTokens,
      totalTokens: totals.totalTokens,
      contentCap,
      canDegrade: tier === 'full',
      degradeTo: tier === 'full' ? 'reflect' : null,
      parts: Object.fromEntries(parts.map((part) => [part.key, part.text])),
      dropped,
      warnings,
      text: totals.text,
      userText: parts.filter((part) => part.key !== 'system').map((part) => part.text).filter(Boolean).join('\n\n'),
    };
  }

  return {
    ok: false,
    code: 'E_CONTEXT_OVER_BUDGET',
    tier,
    requestedTier,
    budget: cfg.budget,
    canDegrade: tier === 'full',
    degradeTo: tier === 'full' ? 'reflect' : null,
    dropped,
    warnings,
    message: 'context assembly did not converge',
  };
}
