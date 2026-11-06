/**
 * D6 — tool-surface trimming, pure decisions.
 *
 * Everything in this file is deliberately host-free: it takes plain tool
 * schemas and a plain message, and returns plain sets/lists.  The runtime in
 * `runtime.js` owns the Cordis wiring and the per-session freeze; this file owns
 * the policy that the unit tests pin.
 *
 * The one rule that is not policy: the core surface is never trimmed.  A
 * trimmed tool is still reachable through `tool_search`, which lifts its
 * restriction and lets the host append it at the end of the next request.
 */

export const CORE_EXACT = Object.freeze([
  'read',
  'write',
  'edit',
  'pwsh',
  'glob',
  'grep',
  'todo',
  'todo_write',
  'tool_search',
]);

/** Tools the spec names individually, plus every session_* / memory_* tool. */
export function isCoreTool(name) {
  if (typeof name !== 'string' || name === '') return false;
  if (CORE_EXACT.includes(name)) return true;
  return name.startsWith('session_') || name.startsWith('memory_');
}

const CODE_WORDS = [
  '代码', '编程', '实现', '修复', '测试', '重构', '构建', '部署', '脚本', '函数',
  '接口', '仓库', '编译', '调试', '报错', '类型', '单元测试', '命令行', '补丁', '提交',
  'code', 'coding', 'implement', 'fix', 'bug', 'refactor', 'test', 'build', 'deploy',
  'script', 'function', 'api', 'repo', 'compile', 'debug', 'typescript', 'javascript',
  'python', 'rust', 'golang', 'patch', 'commit', 'lint', 'cli',
];

const MEDIA_WORDS = [
  '图片', '图像', '照片', '视频', '音频', '音乐', '歌曲', '语音', '编曲', '混音',
  '作曲', '乐谱', '扒谱', '分轨', '视觉', '海报', '封面', '表情包', '绘画', '渲染',
  '动画', '镜头', '配音', '朗读', '生成图', '生成视频', '设计图',
  'image', 'photo', 'picture', 'video', 'audio', 'music', 'song', 'sound', 'speech',
  'voice', 'render', 'draw', 'paint', 'visual', 'poster', 'cover', 'meme', 'animation',
  'blender', 'libtv', 'seedance', 'ace studio', 'midi', 'score',
];

const MEDIA_TOOL_RE = /(image|video|audio|music|song|sound|speech|voice|media|meme|render|draw|paint|photo|visual|poster|cover|blender|libtv|seedance|ace[-_ ]?studio|midi|图片|图像|视频|音频|音乐|语音|表情|绘|渲染)/i;

const SKIP_DENY = new Set(['run_code', 'tool_search']);

/** Count keyword hits, longest words first so a phrase is not double-counted. */
function scoreWords(haystack, words) {
  const text = haystack.toLowerCase();
  let score = 0;
  for (const word of words) {
    if (!text.includes(word)) continue;
    score += 1;
    if (word.includes(' ')) score += 1;
  }
  return score;
}

/** User-visible text from a host message, a plain string, or a goal object. */
export function messageText(message) {
  if (typeof message === 'string') return message;
  if (message === null || typeof message !== 'object') return '';
  if (typeof message.text === 'string') return message.text;
  if (typeof message.objective === 'string') return message.objective;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') parts.push(block);
    else if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * Pick the task family for the first turn.  A tie goes to "code" because the
 * code surface is the smaller one and tool_search can recover a media tool.
 */
export function classifyTask(goal, message) {
  const text = `${messageText(goal)}\n${messageText(message)}`;
  const media = scoreWords(text, MEDIA_WORDS);
  const code = scoreWords(text, CODE_WORDS);
  if (media > code && media > 0) return 'media';
  if (code > 0) return 'code';
  if (media > 0) return 'media';
  return 'general';
}

/** Tools that are obviously useful for a media task even without a matching name. */
const MEDIA_EXTRA = new Set(['present', 'load_workspace_dependencies']);

function isMediaTool(tool, name) {
  if (MEDIA_EXTRA.has(name)) return true;
  // Match the NAME, not the description: a generic tool's description often
  // mentions images/media in passing (decompress, subagent research, ...) and
  // would drag unrelated tools into the media surface.
  return MEDIA_TOOL_RE.test(name);
}

/**
 * Compute the frozen allowlist.
 *
 * @param {{goal?: unknown, message?: unknown, tools?: object[], config?: object}} input
 * @returns {{task: string, allow: string[], trimmed: string[], toolNames: string[],
 *            keepCount: number, trimmedCount: number, fallback: boolean, reason: string}}
 */
export function selectAllowlist({ goal = '', message = '', tools = [], config = {} } = {}) {
  const task = classifyTask(goal, message);
  const list = Array.isArray(tools) ? tools.filter((tool) => typeof tool?.name === 'string' && tool.name !== '') : [];
  const allow = [];
  const trimmed = [];
  const names = [];
  for (const tool of list) {
    const name = tool.name;
    names.push(name);
    let keep = isCoreTool(name);
    if (!keep && task === 'media' && isMediaTool(tool, name)) keep = true;
    // A few profiles want an explicit extra set (tests and future configs).
    if (!keep && Array.isArray(config.keepTools) && config.keepTools.includes(name)) keep = true;
    if (keep) allow.push(name);
    else if (!SKIP_DENY.has(name)) trimmed.push(name);
  }
  // tool_search is core even when a fake context did not include it.
  if (!allow.includes('tool_search')) allow.unshift('tool_search');
  const keepCount = allow.filter((name) => names.includes(name)).length;
  const fallback = keepCount === 0;
  const reason = fallback
    ? 'no visible tool survived the core filter'
    : `task=${task}; keep=${keepCount}; trim=${trimmed.length}`;
  return { task, allow, trimmed, toolNames: names, keepCount, trimmedCount: trimmed.length, fallback, reason };
}

/** Detect which host shape an assemble waterfall value has. */
export function assembleShape(assembly) {
  if (Array.isArray(assembly?.tools)) return '0.2.1';
  return '0.2.2';
}

/**
 * 0.2.1 compatibility: the host returns `assembly.tools` and trusts the
 * waterfall's value.  Keep only the frozen surface, then append tools the model
 * requested through tool_search at the END so the cached prefix is untouched.
 * 0.2.2 returns `assembly.tools === undefined`; there is nothing to filter here
 * because the earlier `tools.restrict()` already filtered the provider.
 */
export function filterAssembly(assembly, { allow, requested = [], fullTools = [] } = {}) {
  const shape = assembleShape(assembly);
  if (shape === '0.2.2') return { assembly, shape, changed: false, appended: [] };
  if (!(allow instanceof Set) || allow.size === 0) return { assembly, shape, changed: false, appended: [] };
  const tools = assembly.tools;
  const requestedSet = new Set(requested.filter((name) => !isCoreTool(name)));
  const kept = [];
  for (const tool of tools) {
    if (typeof tool?.name !== 'string') continue;
    if (requestedSet.has(tool.name)) continue;
    if (isCoreTool(tool.name) || allow.has(tool.name)) kept.push(tool);
  }
  if (kept.length === 0) return { assembly, shape, changed: false, appended: [], fallback: true };
  const seen = new Set(kept.map((tool) => tool.name));
  const byName = new Map((Array.isArray(fullTools) ? fullTools : []).map((tool) => [tool.name, tool]));
  const append = [];
  for (const name of requested) {
    if (seen.has(name) || isCoreTool(name)) continue;
    const tool = byName.get(name);
    if (tool === undefined) continue;
    kept.push(tool);
    append.push(name);
    seen.add(name);
  }
  const changed = kept.length !== tools.length || append.length > 0;
  const result = changed ? { ...assembly, tools: kept } : assembly;
  return { assembly: result, shape, changed, appended: append };
}
