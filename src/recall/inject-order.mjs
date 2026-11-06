/**
 * inject-order.mjs — pre-step 注入顺序 / 去重 / 路径级排除的**纯函数**。
 *
 * 这里只处理普通对象（消息数组、卡数组），不碰 ctx、不碰 fs，方便单测。
 *
 * 真实 Cordis 合成语义（cordis/src/events.ts:234-242）：
 *   `prepend:true` 的监听器被 unshift 到最外层、最先执行；`prepend:false` 走 push，
 *   在内层执行。开机卡由 identity-router 在最外层、`next()` **之前**插进
 *   `payload.messages`，所以内层的 auto-recall 一定看得到它。最终顺序（v4）：
 *
 *     [user, boot, runtime, auto]
 *
 *   开机卡插在**第一条真实 user 消息之后**，不再 unshift 到最前：宿主 TurnNavigator
 *   取该轮第一个可见 `kind:'user'` 节点做 tooltip 的 prompt（client.js:8373-8384），
 *   boot 在最前会让第 1 轮显示【开机卡】而不是用户提问（红队第三轮 mustFix #2）。
 *
 *   auto 只负责把自己 append 到最后；不再把消息插到 boot 后面（那会得到
 *   `[boot, auto, user, runtime]`，红队 S2 的顺序问题）。
 *
 * v4 / 红队第四轮 M1（2026-11-04）：注入消息的 source.kind 从 'user' 改为
 * 'session-reference'，形状固定为
 *
 *     { kind:'session-reference', form:'recall', version:1, references:[] }
 *
 * 宿主渲染层把 `kind !== 'user'` 的 user/message 投影成 **context 节点**
 * （client.js:9887-9893），`isVisibleChatNode()` 对普通 context 返回 false
 * （client.js:8226-8228）——所以【开机卡】/【自动想起】不再变成聊天里的用户气泡。
 * 模型侧不受影响：`session.deriveMessages()` 仍包含正文；`references: []` 让
 * `recalledSessions()` 返回 null，RecallBody 退化成 opaque 行，不会抛
 * `unreachable context form`。
 *
 * 代价（已与用户确认，不阻塞本次）：用户看不到「想起了什么」。可见性改由
 * **潜望镜面板**承担（后续加页签，见 README「可见性」/ WIRING §3）；在面板上线前，
 * 注入只服务模型，不在聊天流里露脸。
 *
 * 识别契约：
 *   - 本插件 / identity-router 的注入靠 kind 直接识别（不再依赖正文标记）；
 *   - 正文标记（【自动想起】/【开机卡】）继续保留，用于识别历史消息与外部 engram
 *     风格的注入，also keeps firstUserText from eating a legacy card；
 *   - **外部插件**仍可能用 kind:'user' 把文本插到真实提问前（红队 ADV1）。识别不了
 *     任意纯文本，所以 firstUserText 的取值在 index.js 里按「第 1 轮最后一条真人
 *     消息」锁定，isRealUserMessage 只负责排掉已知注入形态。
 */

/**
 * 宿主 MessageSourceMap 的完整成员（dsh-llm/lib/typert.host.js:475-477）。
 * 注入只允许白名单内的 kind；坏 kind 会在 append 时被本插件拒绝，避免日志被
 * 毒化（append 接受任意非空字符串，但 adoptSessionEvent 会抛 invalid source）。
 */
export const HOST_SOURCE_KINDS = Object.freeze([
  'user', 'model', 'tool', 'system-prompt', 'model-selection', 'runtime-context',
  'working-directory', 'user-approval', 'ptc-mode', 'tool-registry', 'user-rpc',
  'agent-message', 'subagent-settled', 'skill-invocation', 'compact-checkpoint',
  'cordis-host-runner', 'team-message', 'user-question-reply', 'goal', 'plan-mode',
  'schedule', 'session-reference', 'webhook',
]);

/** 宿主的隐藏注入 kind：不渲染气泡、但正文仍进模型上下文。 */
export const HOST_USER_SOURCE_KIND = 'session-reference';

/** 真实的用户消息 kind（session-reference 不是）。 */
export const REAL_USER_SOURCE_KIND = 'user';

/** session-reference 的 recall 形状（见 dsh-llm 的 SessionReferenceSource）。 */
export const INJECTION_SOURCE_FORM = 'recall';
export const INJECTION_SOURCE_VERSION = 1;

/** 旧版越界 kind：只用于识别历史消息，不再写入。 */
export const AUTO_LEGACY_SOURCE_KIND = 'plugin:dsh-auto-recall';
export const IDENTITY_LEGACY_SOURCE_KIND = 'plugin:dsh-identity-router';

/** 旧版 source.sections 名（同样只用于识别）。 */
export const AUTO_SECTION = 'auto-recall.cards';
export const IDENTITY_SECTION = 'identity-router.open-card';

/** 正文首行标记：保留用于识别历史消息与外部注入。 */
export const AUTO_TEXT_MARK = '【自动想起】';
export const IDENTITY_TEXT_MARK = '【开机卡】';

/** 只在文本里认这两类路径；其它目录不参与（防止把任意 .md 当卡）。 */
const CARD_PATH_RE = /(?:^|[\s"'`（()【\[,，;；/])((?:topics|handover)\/[^\s"'`）)】\]，,;；]+\.md)/g;

export function isHostSourceKind(kind) {
  return typeof kind === 'string' && HOST_SOURCE_KINDS.includes(kind);
}

/** 构造一条注入消息的 source（每次返回新对象，避免引用共享）。 */
export function injectionSource() {
  return {
    kind: HOST_USER_SOURCE_KIND,
    form: INJECTION_SOURCE_FORM,
    version: INJECTION_SOURCE_VERSION,
    references: [],
  };
}

function badSource(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * append 前的守卫：坏 kind / 坏形状直接拒绝，不让它写进 session 日志。
 * 只校验本插件自己的消息；外部插件写的消息由宿主负责，我们只能在 firstUserText
 * 层面降低影响（ADV1）。
 * @param {object} message
 * @returns {object} 原消息
 */
export function assertInjectionMessage(message) {
  const kind = sourceKindOf(message);
  if (!isHostSourceKind(kind)) {
    throw badSource('E_BAD_SOURCE_KIND', `injection source.kind ${JSON.stringify(kind)} 不在宿主封闭 union（${HOST_SOURCE_KINDS.length} 个合法值）`);
  }
  if (kind !== HOST_USER_SOURCE_KIND) {
    throw badSource('E_UNEXPECTED_INJECTION_KIND', `插件注入必须用 ${HOST_USER_SOURCE_KIND}，得到 ${JSON.stringify(kind)}`);
  }
  const source = message?.source ?? {};
  if (source.form !== INJECTION_SOURCE_FORM
    || source.version !== INJECTION_SOURCE_VERSION
    || !Array.isArray(source.references)) {
    throw badSource('E_BAD_SOURCE_SHAPE', 'session-reference 注入需要 { form:"recall", version:1, references:[] }');
  }
  return message;
}

export function sourceKindOf(message) {
  return String(message?.source?.kind ?? '');
}

function startsWithMark(message, mark) {
  return textsOf(message).some((text) => String(text).trimStart().startsWith(mark));
}

export function isIdentityMessage(message) {
  const kind = sourceKindOf(message);
  if (kind === IDENTITY_LEGACY_SOURCE_KIND || kind.startsWith(`${IDENTITY_LEGACY_SOURCE_KIND}:`)) return true;
  return startsWithMark(message, IDENTITY_TEXT_MARK);
}

export function isAutoMessage(message) {
  const kind = sourceKindOf(message);
  if (kind === AUTO_LEGACY_SOURCE_KIND) {
    const sections = message?.source?.sections;
    if (!Array.isArray(sections) || sections.length === 0) return true;
    return sections.some((s) => s?.name === AUTO_SECTION);
  }
  return startsWithMark(message, AUTO_TEXT_MARK);
}

/**
 * 真正的用户消息：role==='user'、source.kind 缺省或为宿主真实的 'user'，
 * 且不是本插件 / identity-router / 已知外部注入形态。
 *
 * v4 起注入用 kind:'session-reference'，kind 本身就能挡掉；这里再按正文特征
 * 排一层（红队 ADV1）：带 `source.form` / `source.sections` 的、首行是已知标记的，
 * 都不算真人消息。无法凭正文区分「任意外部插件写的纯文本 kind:user」——那类消息
 * 由 firstUserText 的「第 1 轮最后一条」规则处理（见 index.js）。
 * @param {object} message
 * @returns {boolean}
 */
export function isRealUserMessage(message) {
  if (message?.role !== 'user') return false;
  const kind = sourceKindOf(message);
  if (kind !== '' && kind !== REAL_USER_SOURCE_KIND) return false; // session-reference / runtime-context 等
  const source = message?.source ?? {};
  if (source.form !== undefined || Array.isArray(source.sections)) return false;
  return !isIdentityMessage(message) && !isAutoMessage(message);
}

/** 一条消息里所有可读文本（content blocks + source.sections），去重后返回。 */
export function textsOf(message) {
  const out = [];
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') out.push(block.text);
  }
  for (const section of Array.isArray(message?.source?.sections) ? message.source.sections : []) {
    if (typeof section?.text === 'string' && section.text.trim() !== '') out.push(section.text);
  }
  return [...new Set(out)];
}

/**
 * 本轮已经注入的文本：identity 开机卡 + 旧 plugin:* / engram 消息。
 * 给 chooseRecall 做文本级去重；kind 合法化成 session-reference 后不能只靠 kind 判断。
 */
export function injectedTexts(messages) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (isIdentityMessage(message) || isAutoMessage(message)) {
      out.push(...textsOf(message));
      continue;
    }
    const kind = sourceKindOf(message);
    if (!kind.startsWith('plugin:') && !kind.includes('engram')) continue;
    out.push(...textsOf(message));
  }
  return out;
}

/** message.source 里显式声明的卡路径（约定字段；当前 identity-router 还不发）。 */
function declaredPaths(message) {
  const source = message?.source;
  const out = [];
  if (Array.isArray(source?.cardPaths)) out.push(...source.cardPaths);
  for (const section of Array.isArray(source?.sections) ? source.sections : []) {
    if (Array.isArray(section?.cardPaths)) out.push(...section.cardPaths);
    if (typeof section?.path === 'string') out.push(section.path);
  }
  return out.filter((p) => typeof p === 'string' && p.trim() !== '');
}

function normalizePath(p) {
  return String(p ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * 一条消息里能识别出的卡路径。
 * @param {object} message
 * @param {{cards?:object[], titleMinChars?:number}} [opts]
 */
export function cardPathsInMessage(message, { cards = [], titleMinChars = 6 } = {}) {
  const paths = new Set(declaredPaths(message).map(normalizePath));
  const texts = textsOf(message);
  for (const raw of texts) {
    const text = raw.replace(/\\/g, '/');
    CARD_PATH_RE.lastIndex = 0;
    let m = CARD_PATH_RE.exec(text);
    while (m !== null) {
      paths.add(normalizePath(m[1]));
      if (CARD_PATH_RE.lastIndex === m.index) CARD_PATH_RE.lastIndex += 1;
      m = CARD_PATH_RE.exec(text);
    }
  }
  // identity-router 只注入 cardText（不含路径）；对**交接卡**再退一步按标题认。
  const joined = texts.join('\n');
  for (const card of cards) {
    if (!card || card.dir !== 'handover') continue;
    const title = String(card.title ?? '').trim();
    if (title.length >= titleMinChars && joined.includes(title)) paths.add(normalizePath(card.path));
  }
  return [...paths];
}

/** identity-router 已注入的卡路径（并入 chooseRecall 的 seenPaths）。 */
export function identityInjectedPaths(messages, opts = {}) {
  const out = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isIdentityMessage(message)) continue;
    for (const p of cardPathsInMessage(message, opts)) out.add(p);
  }
  return [...out];
}

/**
 * 把 auto-recall 的注入消息合并进 decision.messages：
 *   - 先移除本插件旧的消息（幂等：重复 merge 只剩一条）；
 *   - 总是 append 到末尾：identity-router 已把开机卡插在第一条真实 user 之后，
 *     auto 的目标位置就是 `[user, boot, runtime, auto]` 的最后一位；
 *   - 不再「插到 identity 后面」——那会得到 `[boot, auto, user, runtime]`。
 * @param {object[]} messages
 * @param {object} message auto-recall 的消息
 */
export function mergeInjectionOrder(messages, message) {
  const list = (Array.isArray(messages) ? messages : []).filter((m) => !isAutoMessage(m));
  return [...list, message];
}
