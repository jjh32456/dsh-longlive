// queue.mjs — 任务队列（JSONL）
//
// 写路径与读路径分离：
//   - read()/pending() 给 Router 的 tick 用，永远只读；
//   - append 只通过队列自己签发的 writer capability 暴露，插件把 writer 交给
//     「可信生产者」（用户输入 / 宿主调度器），后台 agent 拿不到。
//     capability 是逻辑隔离，不是 OS 权限隔离；真正的隔离靠后台 agent 的工具面
//     没有 fs 写工具（见 tool-policy.mjs）。
//
// 去重规则：id 第一次出现者胜；后出现的重复 id 被忽略，并在 read().duplicates
// 里留下证据。append 遇到已存在 id 返回 {ok:false, code:'E_DUPLICATE'}，不写盘。
//
// 容量上限（复核 P29）：800 条任务曾被无条件收下。现在 append 前同时检查
// maxTasks / maxBytes，超了返回 E_QUEUE_FULL 且不写盘。id 缓存带文件签名
// （size+mtime），别的实例追加后本实例会重扫，避免拿过期缓存写出重复 id（P28）。

import fs from 'node:fs';
import path from 'node:path';

/** 任务最小形状：{ id: string, type: string, payload?: object, origin?: string, depth?: number } */
export function validateTask(raw, index = 0) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: `line ${index}: not an object` };
  if (typeof raw.id !== 'string' || raw.id.length === 0) return { ok: false, reason: `line ${index}: missing id` };
  if (typeof raw.type !== 'string' || raw.type.length === 0) return { ok: false, reason: `line ${index}: missing type` };
  if (raw.payload !== undefined && (raw.payload === null || typeof raw.payload !== 'object')) {
    return { ok: false, reason: `line ${index}: payload must be an object` };
  }
  if (raw.depth !== undefined && (!Number.isInteger(raw.depth) || raw.depth < 0)) {
    return { ok: false, reason: `line ${index}: depth must be a non-negative integer` };
  }
  return { ok: true, task: raw };
}

export const DEFAULT_MAX_TASKS = 500;
export const DEFAULT_MAX_BYTES = 1024 * 1024;

export class TaskQueue {
  constructor({
    file,
    maxTasks = DEFAULT_MAX_TASKS,
    maxBytes = DEFAULT_MAX_BYTES,
  } = {}) {
    if (!file) throw new Error('TaskQueue: file is required');
    this.file = file;
    this.maxTasks = maxTasks;
    this.maxBytes = maxBytes;
    this.ids = null;
    this.loadedSignature = null;
    this.count = 0;
    this.bytes = 0;
    const writer = Object.freeze({ append: (task) => this.#append(task) });
    this.writer = writer;
  }

  /** 裸 append 一律拒绝：写队列是可信生产者的能力，不是普通调用。 */
  append() {
    const error = new Error('TaskQueue: append() is reserved for the trusted producer; use queue.writer.append(task)');
    error.code = 'E_UNTRUSTED_PRODUCER';
    throw error;
  }

  #signature() {
    try {
      const stat = fs.statSync(this.file);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return 'missing';
    }
  }

  #loadIds() {
    const signature = this.#signature();
    if (this.ids !== null && this.loadedSignature === signature) return this.ids;
    const ids = new Set();
    let count = 0;
    if (fs.existsSync(this.file)) {
      const text = fs.readFileSync(this.file, 'utf8');
      this.bytes = Buffer.byteLength(text);
      let line = 0;
      for (const rawLine of text.split('\n')) {
        line += 1;
        if (rawLine.trim() === '') continue;
        count += 1;
        try {
          const rec = JSON.parse(rawLine);
          const verdict = validateTask(rec, line);
          if (verdict.ok) ids.add(verdict.task.id);
        } catch { /* 坏行不参与 id 集合 */ }
      }
    } else {
      this.bytes = 0;
    }
    this.ids = ids;
    this.count = count;
    this.loadedSignature = signature;
    return ids;
  }

  /** 当前容量快照（给 read()/审计用）。 */
  capacity() {
    this.#loadIds();
    return {
      maxTasks: this.maxTasks,
      maxBytes: this.maxBytes,
      count: this.count,
      bytes: this.bytes,
      full: this.count >= this.maxTasks || this.bytes >= this.maxBytes,
    };
  }

  #append(task) {
    const verdict = validateTask(task);
    if (!verdict.ok) return { ok: false, code: 'E_INVALID_TASK', reason: verdict.reason };
    const ids = this.#loadIds();
    if (ids.has(verdict.task.id)) return { ok: false, code: 'E_DUPLICATE', id: verdict.task.id };

    const line = JSON.stringify(verdict.task) + '\n';
    const lineBytes = Buffer.byteLength(line);
    if (this.count + 1 > this.maxTasks) {
      return {
        ok: false,
        code: 'E_QUEUE_FULL',
        reason: `queue already has ${this.count} task(s); maxTasks is ${this.maxTasks}`,
        maxTasks: this.maxTasks,
        count: this.count,
      };
    }
    if (this.bytes + lineBytes > this.maxBytes) {
      return {
        ok: false,
        code: 'E_QUEUE_FULL',
        reason: `queue is ${this.bytes} byte(s); adding ${lineBytes} would exceed maxBytes ${this.maxBytes}`,
        maxBytes: this.maxBytes,
        bytes: this.bytes,
      };
    }

    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const fd = fs.openSync(this.file, 'a');
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    ids.add(verdict.task.id);
    this.count += 1;
    this.bytes += lineBytes;
    this.loadedSignature = this.#signature();
    return { ok: true, task: verdict.task };
  }

  /**
   * 读全部合法任务；坏行/坏任务进 invalid，重复 id 只保留第一条。
   * 不抛异常（除文件系统本身不可读）。
   */
  read() {
    if (!fs.existsSync(this.file)) {
      return {
        tasks: [],
        invalid: [],
        duplicates: [],
        missing: true,
        total: 0,
        capacity: { maxTasks: this.maxTasks, maxBytes: this.maxBytes, count: 0, bytes: 0, full: false },
      };
    }
    const text = fs.readFileSync(this.file, 'utf8');
    const tasks = [];
    const invalid = [];
    const duplicates = [];
    const seen = new Set();
    text.split('\n').forEach((line, i) => {
      if (line.trim() === '') return;
      let raw;
      try {
        raw = JSON.parse(line);
      } catch (error) {
        invalid.push({ line: i + 1, reason: `json: ${error.message}` });
        return;
      }
      const verdict = validateTask(raw, i + 1);
      if (!verdict.ok) {
        invalid.push({ line: i + 1, reason: verdict.reason });
        return;
      }
      if (seen.has(verdict.task.id)) {
        duplicates.push({ line: i + 1, id: verdict.task.id });
        return;
      }
      seen.add(verdict.task.id);
      tasks.push(verdict.task);
    });
    const bytes = Buffer.byteLength(text);
    const lines = text.split('\n').filter((line) => line.trim() !== '').length;
    return {
      tasks,
      invalid,
      duplicates,
      missing: false,
      total: tasks.length,
      capacity: {
        maxTasks: this.maxTasks,
        maxBytes: this.maxBytes,
        count: lines,
        bytes,
        full: lines >= this.maxTasks || bytes >= this.maxBytes,
      },
    };
  }

  /** 过滤掉已处理过的任务（seen 来自审计回放）。去重后的第一条先参与处理。 */
  pending(seen = new Set()) {
    const { tasks, invalid, duplicates, missing, total, capacity } = this.read();
    return {
      tasks: tasks.filter((task) => !seen.has(task.id)),
      invalid,
      duplicates,
      missing,
      total,
      capacity,
    };
  }
}
