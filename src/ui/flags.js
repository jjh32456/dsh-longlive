// Pure model for the longlive settings panel: the seven feature switches the
// row's `plugins.row.config` page edits, plus the read-only memory root.
//
// The model has no Host service imports on purpose. The route layer supplies
// readConfig/writeConfig, and the tests can drive the same functions with a
// plain object. Keep every string here in sync with src/config.js ZH copy —
// the client panel receives these labels from the Host so the browser half
// never carries a second copy.

/** Package name the row key is derived from (see `rowConfigKey` in the Host). */
export const FLAGS_PACKAGE = 'dsh-longlive';
/** Row id the shipped cordis.patch.yml declares. */
export const FLAGS_ROW_ID = 'session-longlive';
/** Key for `plugins.row.config`: `<package name>#<row id>`. */
export const FLAGS_SLOT_KEY = `${FLAGS_PACKAGE}#${FLAGS_ROW_ID}`;
/** Panel heading shown above the switches. */
export const FLAGS_TITLE = '久视 · 功能开关';

/**
 * One editable switch. `path` is the config path written through the profile
 * editor; the displayed value falls back to `fallback` when the raw row does
 * not carry the key yet (the schema's own default).
 */
export const FLAGS = Object.freeze([
  Object.freeze({
    key: 'd2.enabled',
    path: Object.freeze(['d2', 'enabled']),
    group: 'tools',
    label: '工具输出裁剪',
    description: '超过上限的工具输出全文归档，只保留头尾内联。',
    fallback: false,
  }),
  Object.freeze({
    key: 'd6.enabled',
    path: Object.freeze(['d6', 'enabled']),
    group: 'tools',
    label: '工具面裁剪',
    description: '第一轮冻结按任务挑选的工具清单，其余工具用 tool_search 申请。',
    fallback: false,
  }),
  Object.freeze({
    key: 'autoRecall.enabled',
    path: Object.freeze(['autoRecall', 'enabled']),
    group: 'memory',
    label: '自动想起',
    description: '按轮次从记忆库召回卡片并注入上下文。',
    fallback: false,
  }),
  Object.freeze({
    key: 'presenceBus.enabled',
    path: Object.freeze(['presenceBus', 'enabled']),
    group: 'memory',
    label: '共享大脑',
    description: '消费其他会话写入总线的消息。',
    fallback: false,
  }),
  Object.freeze({
    key: 'routerFace.enabled',
    path: Object.freeze(['routerFace', 'enabled']),
    group: 'memory',
    label: '后台面',
    description: '定时读取共享记忆，写 journal 与建议 outbox。',
    fallback: false,
  }),
  Object.freeze({
    key: 'autoMaintenance.enabled',
    path: Object.freeze(['autoMaintenance', 'enabled']),
    group: 'memory',
    label: '每日维护',
    description: '本地午夜调度合并报告与遗忘候选清单。',
    fallback: false,
  }),
  Object.freeze({
    key: 'routerEnabled',
    path: Object.freeze(['routerEnabled']),
    group: 'router',
    label: 'Router',
    description: '判定工具调用并按策略记录/拦截。',
    fallback: false,
  }),
]);

/** Display order and headings of the switch groups. */
export const FLAGS_GROUPS = Object.freeze([
  Object.freeze({ id: 'tools', label: '工具与会话' }),
  Object.freeze({ id: 'memory', label: '记忆与后台' }),
  Object.freeze({ id: 'router', label: '路由' }),
]);

/** Error codes the Host route maps to a 4xx and the client shows verbatim. */
export class FlagsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FlagsError';
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read one descriptor's value from a raw config object.
 * @param raw - the row's raw config, possibly missing the key.
 * @param flag - a descriptor from {@link FLAGS}.
 * @returns the boolean effective value (`true` only for literal true).
 */
export function readFlagValue(raw, flag) {
  let current = isRecord(raw) ? raw : {};
  for (const key of flag.path) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) return flag.fallback === true;
    current = current[key];
  }
  return current === true;
}

/**
 * Project every switch value out of a raw config.
 * @param raw - the row's raw config.
 * @returns a `{ [flag.key]: boolean }` object.
 */
export function readFlagValues(raw) {
  const values = {};
  for (const flag of FLAGS) values[flag.key] = readFlagValue(raw, flag);
  return values;
}

/**
 * Find a switch descriptor by its public key.
 * @param key - e.g. `d2.enabled`.
 * @returns the descriptor, or undefined.
 */
export function flagByKey(key) {
  return FLAGS.find((flag) => flag.key === key);
}

/**
 * Validate a write and return the next raw config. Only whitelisted switch
 * paths are touched; unknown top-level keys and sibling fields are preserved
 * byte-for-byte at the value level.
 * @param raw - the current raw config.
 * @param key - the switch key.
 * @param value - the next boolean.
 * @returns a new raw config object; the input is never mutated.
 * @throws {FlagsError} for an unknown key, a read-only field, or a non-boolean.
 */
export function setFlagInConfig(raw, key, value) {
  const flag = flagByKey(key);
  if (flag === undefined) {
    if (key === 'memoryRoot' || key === 'memRoot') {
      throw new FlagsError('E_FLAG_READONLY', 'memoryRoot 是只读展示字段，不能在面板里修改。');
    }
    throw new FlagsError('E_FLAG_UNKNOWN', `未知的功能开关：${String(key)}`);
  }
  if (typeof value !== 'boolean') {
    throw new FlagsError('E_FLAG_TYPE', `开关 ${key} 只接受布尔值（收到 ${typeof value}）。`);
  }
  const before = isRecord(raw) ? raw : {};
  const next = { ...before };
  if (flag.path.length === 1) {
    next[flag.path[0]] = value;
    return next;
  }
  const [block, field] = flag.path;
  const existing = isRecord(before[block]) ? before[block] : {};
  next[block] = { ...existing, [field]: value };
  return next;
}

/**
 * Build the payload the browser panel renders: groups in display order, each
 * switch carrying its current value, and the read-only memory root.
 * @param raw - the row's raw config.
 * @param options - `{ memoryRoot, writable }`.
 * @returns a JSON-safe snapshot.
 */
export function describeFlags(raw, options = {}) {
  const values = readFlagValues(raw);
  const writable = options.writable === true;
  return {
    ok: true,
    title: FLAGS_TITLE,
    packageName: FLAGS_PACKAGE,
    rowId: FLAGS_ROW_ID,
    slotKey: FLAGS_SLOT_KEY,
    writable,
    memoryRoot: typeof options.memoryRoot === 'string' && options.memoryRoot !== '' ? options.memoryRoot : null,
    groups: FLAGS_GROUPS.map((group) => ({
      id: group.id,
      label: group.label,
      switches: FLAGS.filter((flag) => flag.group === group.id).map((flag) => ({
        key: flag.key,
        label: flag.label,
        description: flag.description,
        value: values[flag.key],
        readOnly: false,
        writable,
      })),
    })),
  };
}

/**
 * Host-side service the route calls. The write path is injected so tests can
 * model the profile editor without a Host.
 * @param options - `{ readConfig, writeConfig, memoryRoot, canWrite }`.
 * @returns `{ snapshot, setFlag }`.
 */
export function createFlagsService(options) {
  const readConfig = typeof options?.readConfig === 'function' ? options.readConfig : () => ({});
  const writeConfig = typeof options?.writeConfig === 'function' ? options.writeConfig : undefined;
  const canWrite = typeof options?.canWrite === 'function' ? options.canWrite : () => writeConfig !== undefined;

  function readRaw() {
    try {
      const raw = readConfig();
      return isRecord(raw) ? raw : {};
    } catch {
      return {};
    }
  }

  return {
    /** Current panel state, never throws. */
    snapshot() {
      let writable = false;
      try {
        writable = canWrite() === true && writeConfig !== undefined;
      } catch {
        writable = false;
      }
      return describeFlags(readRaw(), { memoryRoot: options?.memoryRoot, writable });
    },

    /**
     * Persist one whitelisted switch.
     * @param key - the switch key.
     * @param value - the next boolean.
     * @returns the new snapshot, read after the write settles.
     * @throws {FlagsError} when the write cannot be performed or the editor rejects it.
     */
    async setFlag(key, value) {
      // Validate before touching the editor so a bad key never learns whether
      // the profile is writable.
      setFlagInConfig({}, key, value);
      if (writeConfig === undefined || canWrite() !== true) {
        throw new FlagsError('E_FLAG_WRITE', '当前宿主不允许写入插件配置（configEditor 或配置行不可用）。');
      }
      try {
        await writeConfig(key, value);
      } catch (error) {
        if (error instanceof FlagsError) throw error;
        throw new FlagsError('E_FLAG_WRITE', `保存 ${key} 失败：${error?.message ?? String(error)}`);
      }
      return describeFlags(readRaw(), { memoryRoot: options?.memoryRoot, writable: true });
    },
  };
}
