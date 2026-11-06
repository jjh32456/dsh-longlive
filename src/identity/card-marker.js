// identityCard 的跨进程「已注入」标记。
//
// 背景：registerIdentityCard() 原先只在进程内 Map 里记 state.opened。用
// `--session-id` 续跑同一会话时是**新进程**，Map 从空开始，step 1 又注入一次，
// 同一会话于是出现两张开机卡（VM-EXTRA-3）。判定必须落到磁盘上：
//
//   <memoryRoot>/.longlive/identity-card/<safeSessionId>.json
//   { "v": 1, "sessionId": "...", "openedAt": "ISO", "at": "ISO" }
//
// 语义是 fail-closed：任何读不了 / 解析不了 / 写不了的情况都当作「可能已经开过」
// 处理，宁可不注入，也不重复注入。文件本身用 O_EXCL 创建：两个进程同时到 step 1
// 时只有抢到文件的那个注入，输家直接跳过。
//
// 只读文件系统同样跳过：写入不了 marker 就无法保证下一次不重复，于是这一次也不注。
//
// 本模块不做日志：调用方决定 warn 的时机（每个会话最多一次）。

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/** 标记格式版本；字段变化时旧 marker 会被当成损坏并 fail-closed。 */
export const MARKER_VERSION = 1;

/** 标记目录（相对 memoryRoot）。 */
export const MARKER_DIRNAME = path.join('.longlive', 'identity-card');

/** 超过 30 天的 marker 可以在启动时清掉。 */
export const MARKER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** 一次启动最多清 128 个，避免在巨大目录上卡住。 */
export const MARKER_PRUNE_LIMIT = 128;

/** 文件名里允许的字符；其余字符转 '_'。 */
const SAFE_NAME = /[^A-Za-z0-9._-]/g;

/**
 * sessionId -> 可用作文件名的片段。
 *
 * 常见 id（`session-<uuid>`）原样保留，方便人工排查；含路径分隔符、空格、中文
 * 等字符时替换为 '_' 并追加原始 id 的短哈希，避免不同 id 规范化后撞到同一个文件。
 * 大小写在 Windows 上仍可能撞车：读取时会核对文件内的 sessionId，对不上按损坏
 * 处理（跳过注入），不会误判成「已开过」而写坏别人的标记。
 *
 * @param {unknown} sessionId
 * @returns {string}
 */
export function safeSessionId(sessionId) {
  const raw = typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId : 'unknown';
  const cleaned = raw.replace(SAFE_NAME, '_').replace(/^\.+/, '_');
  if (cleaned === raw && cleaned.length <= 120) return cleaned;
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 8);
  return `${cleaned.slice(0, 100) || 'session'}-${digest}`;
}

/** `<memoryRoot>/.longlive/identity-card`。 */
export function markerDirFor(memoryRoot) {
  const root = path.resolve(String(memoryRoot));
  return path.join(root, MARKER_DIRNAME);
}

/** 某个会话的 marker 路径。 */
export function markerPathFor(memoryRoot, sessionId) {
  return path.join(markerDirFor(memoryRoot), `${safeSessionId(sessionId)}.json`);
}

/**
 * 读取 marker。
 *
 * 返回值：
 *   {ok:true, exists:false}                  没有 marker，可以尝试注入
 *   {ok:true, exists:true, marker}           已开过，跳过
 *   {ok:false, exists:boolean, code}         读/解析/身份不符 -> 调用方跳过并 warn 一次
 *
 * @param {{memoryRoot?: string, sessionId?: unknown}} [input]
 * @returns {{ok:boolean, exists:boolean, path?:string, marker?:object, code?:string}}
 */
export function readCardMarker(input = {}) {
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId : String(input.sessionId ?? '');
  let file;
  try {
    file = markerPathFor(input.memoryRoot, sessionId);
  } catch (error) {
    return { ok: false, exists: false, code: error?.code ?? 'E_MARKER_PATH' };
  }

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { ok: true, exists: false, path: file };
    }
    return { ok: false, exists: false, path: file, code: error?.code ?? 'E_MARKER_READ' };
  }

  let marker;
  try {
    marker = JSON.parse(raw);
  } catch {
    return { ok: false, exists: true, path: file, code: 'E_MARKER_CORRUPT' };
  }
  if (!marker || typeof marker !== 'object' || marker.v !== MARKER_VERSION) {
    return { ok: false, exists: true, path: file, code: 'E_MARKER_CORRUPT' };
  }
  // 用 O_EXCL 抢到的进程先写一个 openedAt:null 的临时体；它同样算「已开过」，
  // 这样崩溃在注入途中也不会让下一个进程重复注入。
  if (marker.sessionId !== sessionId) {
    return { ok: false, exists: true, path: file, code: 'E_MARKER_SESSION_MISMATCH' };
  }
  return { ok: true, exists: true, path: file, marker };
}

/**
 * 用 O_EXCL 抢占本会话的注入权，并写入占位 marker。
 *
 * 抢占成功返回 `{ok:true, path, sessionId, claimedAt}`；`E_ALREADY_CLAIMED`
 * 表示另一个进程已经抢到（或本会话早就开过），调用方直接跳过即可。
 *
 * @param {{memoryRoot?: string, sessionId?: unknown, now?: number}} [input]
 * @returns {{ok:boolean, path?:string, code?:string, sessionId?:string, claimedAt?:number}}
 */
export function claimCardMarker(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId : String(input.sessionId ?? '');
  let file;
  try {
    file = markerPathFor(input.memoryRoot, sessionId);
  } catch (error) {
    return { ok: false, code: error?.code ?? 'E_MARKER_PATH' };
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (error) {
    return { ok: false, code: error?.code ?? 'E_MARKER_MKDIR' };
  }

  let fd;
  try {
    // 'wx' = O_CREAT | O_EXCL | O_WRONLY：两个进程只有一个能创建成功。
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') return { ok: false, code: 'E_ALREADY_CLAIMED' };
    return { ok: false, code: error?.code ?? 'E_MARKER_CLAIM' };
  }

  const provisional = {
    v: MARKER_VERSION,
    sessionId,
    openedAt: null,
    at: new Date(now).toISOString(),
    claimed: true,
  };
  try {
    fs.writeFileSync(fd, `${JSON.stringify(provisional)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } catch (error) {
    try { fs.unlinkSync(file); } catch { /* 没写成就没有占位 */ }
    return { ok: false, code: error?.code ?? 'E_MARKER_CLAIM_WRITE' };
  } finally {
    try { fs.closeSync(fd); } catch { /* 已关闭 */ }
  }

  return { ok: true, path: file, sessionId, claimedAt: now };
}

/** 原子写：同目录 tmp + fsync + rename；失败返回 code，不抛。 */
function writeAtomic(file, text) {
  const tmp = path.join(
    path.dirname(file),
    `${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`,
  );
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
    return { ok: true, path: file };
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* 已关闭 */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* 没写成就没有 tmp */ }
    return { ok: false, code: error?.code ?? 'E_MARKER_WRITE' };
  }
}

/**
 * 注入被接受后重写 marker，落最终内容。
 *
 * 写失败不抛：本进程的 state.opened 仍然为真（本次只注入一次），磁盘上留着
 * 抢占时写入的占位 marker，后续进程照样会跳过（fail-closed）。
 *
 * @param {{ok?:boolean, path?:string, sessionId?:string}|null} claim
 * @param {{sessionId?:string, now?:number}} [options]
 * @returns {{ok:boolean, path?:string, code?:string, marker?:object}}
 */
export function finalizeCardMarker(claim, options = {}) {
  if (!claim?.ok || typeof claim.path !== 'string') {
    return { ok: false, code: 'E_MARKER_NO_CLAIM' };
  }
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const sessionId = typeof options.sessionId === 'string'
    ? options.sessionId
    : (claim.sessionId ?? '');
  const marker = {
    v: MARKER_VERSION,
    sessionId,
    openedAt: new Date(now).toISOString(),
    at: new Date(now).toISOString(),
  };
  const written = writeAtomic(claim.path, `${JSON.stringify(marker)}\n`);
  return written.ok ? { ok: true, path: written.path, marker } : { ok: false, code: written.code };
}

/**
 * 注入没有被接受（next() 抛错或 reject）时释放占位 marker。
 * 此时并没有任何消息落进会话，释放不会造成重复注入。
 *
 * @param {{ok?:boolean, path?:string}|null} claim
 * @returns {{ok:boolean, code?:string}}
 */
export function releaseCardMarker(claim) {
  if (!claim?.ok || typeof claim.path !== 'string') return { ok: false, code: 'E_MARKER_NO_CLAIM' };
  try {
    fs.unlinkSync(claim.path);
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error?.code ?? 'E_MARKER_RELEASE' };
  }
}

/**
 * 启动时清理过期 marker（mtime > 30 天），最多 128 个。
 *
 * 只删除 `.json` 文件；正在写入的 `.tmp-*` 不碰。目录不存在、只读、单个文件
 * 删不掉都只是少清一个，不影响启动，也不抛。
 *
 * @param {string} memoryRoot
 * @param {{now?:number, maxAgeMs?:number, limit?:number}} [options]
 * @returns {{ok:boolean, scanned:number, deleted:number, errors:number}}
 */
export function pruneCardMarkers(memoryRoot, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : MARKER_MAX_AGE_MS;
  const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : MARKER_PRUNE_LIMIT;
  let dir;
  try {
    dir = markerDirFor(memoryRoot);
  } catch {
    return { ok: false, scanned: 0, deleted: 0, errors: 0 };
  }

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { ok: true, scanned: 0, deleted: 0, errors: 0 };
  }

  let deleted = 0;
  let errors = 0;
  for (const entry of entries) {
    if (deleted >= limit) break;
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(dir, entry.name);
    try {
      const stat = fs.statSync(file);
      if (now - stat.mtimeMs <= maxAgeMs) continue;
      fs.unlinkSync(file);
      deleted += 1;
    } catch {
      errors += 1;
    }
  }
  return { ok: true, scanned: entries.length, deleted, errors };
}
