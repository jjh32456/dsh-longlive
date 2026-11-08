/**
 * inject-position.js — 开机卡插入位置的**纯函数**（v4）。
 *
 * 评审第三轮 mustFix #2：宿主 TurnNavigator 取该轮**第一个**可见 `kind:'user'`
 * 节点做 tooltip 的 prompt（`dsh-client-ui-chat/lib/client.js:8373-8383`），而
 * `source.kind:'user'` 的注入消息正好会变成可见 user 节点（同文件 :9887-9893）。
 * 所以开机卡不能再 unshift 到最前，否则第 1 轮 tooltip 显示【开机卡】而不是用户提问。
 *
 * v2 的 `[boot, user, runtime, auto]` 改为 v3/v4 的：
 *
 *     [user, boot, runtime, auto]
 *
 * 也就是：插到**第一条真实 user 消息之后**；auto-recall 仍在内层 append 到末尾，
 * 它照样看得到 boot（路径级去重继续生效）。
 *
 * v4 / 评审第四轮 M1：source.kind 从 'user' 改为隐藏注入 kind 'session-reference'
 * （形状 `{kind, form:'recall', version:1, references:[]}`）。宿主把它投影成 context
 * 节点，`isVisibleChatNode()` 返回 false——【开机卡】不再变成聊天里的用户气泡；
 * deriveMessages 仍含正文。代价与可见性归属见 README「可见性」。
 *
 * 识别注入消息：新版 `session-reference`、旧版 `plugin:dsh-*` source.kind，
 * 或正文首行的【开机卡】/【自动想起】标记（历史消息仍可能只有标记）。
 */

export const IDENTITY_TEXT_MARK = '【开机卡】';
export const AUTO_TEXT_MARK = '【自动想起】';

/** 本插件写入的隐藏注入 kind（宿主 MessageSourceMap 合法成员）。 */
export const INJECTED_SOURCE_KIND = 'session-reference';
export const INJECTED_SOURCE_FORM = 'recall';
export const INJECTED_SOURCE_VERSION = 1;

/** 构造开机消息的 source（每次返回新对象）。 */
export function injectionSource() {
  return {
    kind: INJECTED_SOURCE_KIND,
    form: INJECTED_SOURCE_FORM,
    version: INJECTED_SOURCE_VERSION,
    references: [],
  };
}

/**
 * append 前守卫：坏 kind / 坏形状直接拒绝，不让它写进 session 日志
 * （宿主 append 只要求非空 kind，但 adoptSessionEvent 会抛 invalid source）。
 */
export function assertInjectionSource(message) {
  const kind = String(message?.source?.kind ?? '');
  if (kind !== INJECTED_SOURCE_KIND) {
    const error = new Error(`injection source.kind ${JSON.stringify(kind)} 必须是 ${INJECTED_SOURCE_KIND}`);
    error.code = 'E_BAD_SOURCE_KIND';
    throw error;
  }
  const source = message?.source ?? {};
  if (source.form !== INJECTED_SOURCE_FORM
    || source.version !== INJECTED_SOURCE_VERSION
    || !Array.isArray(source.references)) {
    const error = new Error('session-reference 注入需要 { form:"recall", version:1, references:[] }');
    error.code = 'E_BAD_SOURCE_SHAPE';
    throw error;
  }
  return message;
}

/** 旧版越界 source.kind：只用于识别历史消息，不再写入。 */
export const LEGACY_INJECTED_KINDS = Object.freeze([
  'plugin:dsh-identity-router',
  'plugin:dsh-auto-recall',
]);

/** 一条消息的全部文本（content blocks）。 */
export function textOfMessage(message) {
  const out = [];
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') out.push(block.text);
  }
  return out.join('\n');
}

/** 是不是插件注入的消息（旧 kind 或正文首行标记）。 */
export function isInjectedMessage(message) {
  const kind = String(message?.source?.kind ?? '');
  if (kind === INJECTED_SOURCE_KIND) return true;
  if (kind !== '' && (LEGACY_INJECTED_KINDS.includes(kind) || kind.startsWith('plugin:'))) return true;
  const firstLine = textOfMessage(message).trimStart().split('\n', 1)[0]?.trim() ?? '';
  return firstLine.startsWith(IDENTITY_TEXT_MARK) || firstLine.startsWith(AUTO_TEXT_MARK);
}

/**
 * 真正的用户消息：role==='user'，source.kind 缺省或为宿主真实的 'user'，
 * 且不是本插件 / auto-recall 的注入（session-reference / runtime-context 都不算）。
 * source.form / source.sections 是插件注入的强特征（真实用户消息没有），一并排除。
 */
export function isHumanMessage(message) {
  if (message?.role !== 'user') return false;
  const kind = String(message?.source?.kind ?? '');
  if (kind !== '' && kind !== 'user') return false;
  if (message?.source?.form !== undefined || Array.isArray(message?.source?.sections)) return false;
  return !isInjectedMessage(message);
}

/**
 * 开机卡应插入的下标：第一条真实 user 消息之后；本轮没有 user 消息时退化为 0
 * （宿主 event 里没有 user 的极端情况，只能放最前）。
 * @param {object[]} messages
 * @returns {number}
 */
export function insertionIndex(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const index = list.findIndex(isHumanMessage);
  return index === -1 ? 0 : index + 1;
}

/**
 * 把 message 放到第一条真实 user 消息之后；已有同一条时先摘掉再插，保证幂等。
 * @param {object[]} messages
 * @param {object} message
 * @returns {object[]}
 */
export function placeAfterFirstHuman(messages, message) {
  const rest = (Array.isArray(messages) ? messages : []).filter((m) => m !== message);
  const at = insertionIndex(rest);
  return [...rest.slice(0, at), message, ...rest.slice(at)];
}

/** 两条消息数组是否逐项同一引用（用于「决策没变就原样返回」）。 */
export function sameMessageOrder(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  return a.length === b.length && a.every((message, index) => message === b[index]);
}
