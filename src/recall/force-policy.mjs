/**
 * 1.8.8 M2 强制触发策略（纯函数，无 IO、无随机、无时钟）。
 *
 * 用户原话（1.8.8 需求）：触发太钝、不够强制——「我说我要做什么，就直连老记忆」。
 * 所以 M2 在 `agent/pre-step` 的第 1 步加一条**用户任务消息**的强制通道：
 *
 *   step===1 且最后一条消息是真实 user 消息（isRealUserMessage）
 *   且这条消息**不是纯应答** → 强制召回一次，不再看 everyNTurns、不被 quiet 挡。
 *
 * 纯应答的机械判据（规格 §2.2，可复算、不是语义猜测）：
 *   去掉空白/标点/emoji 后，长度 ≤ ACK_MAX_CHARS 且不含任何任务动词。
 *   例：好 / 嗯 / ok / 继续 / 谢谢 / 收到 / 好的，继续。
 *   「继续」被用户列为纯应答样例，所以它**不在**任务动词表里。
 *
 * 问句例外（1.8.11 R11 P1-4 修订，SPEC §3 验收 #4）：
 *   短问句（如「五问是哪五问？」）虽然 ≤ ACK_MAX_CHARS，但它是提问、不是应答，
 *   必须进强制召回通道。机械判据（不看语义）：
 *     原文含问号（？/?）或含疑问词（哪/什么/怎么/为什么/吗/呢/是否/几）。
 *   这条规则**先于长度判定**：命中即非纯应答，不看字数。
 *   「好了吗」「收到？？」这类也会被当问句，属于机械规则的既定取舍（宁可多插一次）。
 *
 * 边界（写进 docs/AUTO-RECALL.md，别当秘密）：
 *   - 长度 ≤6 且没有任务动词、也没有问句信号的真实短任务（如「v39战役」）会被当纯应答跳过；
 *     这是按规格的机械规则执行的既定取舍，宁可少插一次，也不在每句应答后灌上下文。
 *   - 任务动词表/疑问词表是固定常量，不从记忆/配置里学；改词表会改行为，属于版本变更。
 */

/** 纯应答的最大「去空白/标点后」字符数（规格 §2.2）。 */
export const ACK_MAX_CHARS = 6;

/**
 * 问号字符：原文里出现任意一个就按问句处理（不需要成对判断）。
 * 用原文判断而不是 compactText，因为标点会被 compactText 去掉。
 */
export const QUESTION_MARKS = Object.freeze(['？', '?']);

/**
 * 疑问词：原文包含任意一个就按问句处理（机械规则，不做语法判断）。
 * 覆盖 SPEC §3 验收 #4 的实际问句「五问是哪五问？」（命中「哪」）。
 */
export const QUESTION_WORDS = Object.freeze(['哪', '什么', '怎么', '为什么', '吗', '呢', '是否', '几']);

/**
 * 任务动词：出现任意一个就说明这条消息在派活/改方向，不是纯应答。
 * 注意：`继续`、`好`、`行`、`可以`、`收到`、`谢谢`、`嗯`、`ok` 都不在这里
 * （它们是用户明确列出的纯应答样例）。
 */
export const TASK_VERBS = Object.freeze([
  // 动作类
  '做', '搞', '弄', '办', '干', '改', '修', '写', '读', '看', '查', '找', '搜',
  '跑', '测', '试', '装', '卸', '删', '加', '换', '发', '停', '开', '关', '搬',
  // 交付类
  '发布', '部署', '上线', '重启', '启动', '同步', '更新', '升级', '整理', '清理',
  '推进', '继续做', '接着做', '帮我', '检查', '确认', '核对',
  '对比', '分析', '实现', '补齐', '补', '迁移', '回滚', '恢复', '备份', '导出',
  '导入', '生成', '识别', '扒', '编', '混', '配', '调', '渲染', '验收', '签字',
  '审', '下载', '上传', '安装', '提交', '推送', '合并', '建', '拆', '编译', '打包',
  '优化', '排查', '定位', '复现', '跑一遍', '来一份', '来一段', '来一个',
]);

/** 纯应答示例（给测试/文档对齐用；判定本身不依赖这个表）。 */
export const ACK_EXAMPLES = Object.freeze(['好', '嗯', 'ok', '继续', '谢谢', '收到', '好的', '行', '可以']);

/**
 * 只保留「真正的字」：去掉空白、标点、符号、emoji、markdown 记号。
 * 与 recall-core 的 norm 不同：这里只用于长度/词表判定，不参与打分。
 * @param {string} text
 * @returns {string}
 */
export function compactText(text) {
  return String(text ?? '').replace(/[\s\p{P}\p{S}\p{Extended_Pictographic}]+/gu, '');
}

/**
 * 消息是否含任务动词（在**原文**里找；动词本身可能被标点隔开）。
 * @param {string} text
 * @returns {boolean}
 */
export function hasTaskVerb(text) {
  const compact = compactText(text);
  if (compact === '') return false;
  return TASK_VERBS.some((verb) => compact.includes(verb));
}

/**
 * 消息是否带问句信号（原文判断：问号或疑问词）。
 * @param {string} text
 * @returns {boolean}
 */
export function hasQuestionSignal(text) {
  const raw = String(text ?? '');
  if (raw === '') return false;
  if (QUESTION_MARKS.some((mark) => raw.includes(mark))) return true;
  return QUESTION_WORDS.some((word) => raw.includes(word));
}

/**
 * 纯应答判定：去空白/标点后长度 ≤ ACK_MAX_CHARS 且不含任务动词、且无问句信号。
 * 空消息按纯应答处理（不触发强制召回）。
 * 问句信号优先于长度（1.8.11 P1-4）：短问句不是应答。
 * @param {string} text
 * @returns {boolean}
 */
export function isPureAcknowledgement(text) {
  const raw = String(text ?? '');
  const compact = compactText(raw);
  if (compact === '') return true;
  if (hasQuestionSignal(raw)) return false;
  if (Array.from(compact).length > ACK_MAX_CHARS) return false;
  return !hasTaskVerb(raw);
}

/**
 * 这条真实用户消息是否应当触发「强制召回」。
 * 只有真实用户消息才谈得上强制；空消息/纯应答返回 false。
 * @param {string} text
 * @returns {boolean}
 */
export function shouldForceRecallForMessage(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return false;
  return !isPureAcknowledgement(raw);
}

/**
 * 反馈词判定（在线学习用；也放这里，避免 learning 模块自己再定义一套口径）。
 * 只判「上一轮注入之后他这句是在确认还是否认」，不做更多语义推断。
 * 否认优先：一句里同时出现「不是这个…就对了」按否认算（宁可少加权重）。
 * @param {string} text
 * @returns {'confirm'|'deny'|null}
 */
export function classifyLinkFeedback(text) {
  const s = String(text ?? '').trim();
  if (s === '') return null;
  if (/(不对|不是这个|不是它|不是我要|不是那张|错了|搞错|记错|弄错|不准确|没对上|不相关)/u.test(s)) return 'deny';
  if (/(对的|对呀|对。|对，|对$|就是这个|就是它|没错|正是|准确|精准|靠谱|这个对|就是这张|对了)/u.test(s)) return 'confirm';
  return null;
}
