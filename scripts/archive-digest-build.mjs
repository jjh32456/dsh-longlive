#!/usr/bin/env node
// scripts/archive-digest-build.mjs — M2-A 旧记忆归档摘要构建（archive digest）
//
// 把「热截断」与「可见截断」切掉的旧正文，摘成本地只读索引，供
// `src/recall/archive-search.mjs#searchArchive` 查询。输入只读，输出原子写。
//
//   node scripts/archive-digest-build.mjs \
//     --memory-root <dir> [--sessions-root <dir>] [--out <dir>] \
//     [--incremental] [--dry-run] [--json]
//
//   输入：<memory-root>/.longlive/hot-truncate/*.jsonl
//         <sessions-root>/**/session.v4.jsonl.zstd.archive/*.zstd
//   输出：<out>/{index.jsonl,manifest.json}；--out 默认 = <memory-root>/.longlive/archive-digest
//
// 增量策略（幂等、与全量构建等价）：输入按固定顺序排列；只有「从头开始、路径与
// sha256 都没变」的前缀文件复用上次索引行，遇到第一个变化（改/增/删/重排）后，
// 其后全部重新解析。这样去重结果与全量构建逐字节一致（去重依赖输入顺序）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { splitFrames, decompressFrame } from '../src/codec.js';
import {
  ARCHIVE_DIGEST_SCHEMA,
  ARCHIVE_DIGEST_DIR,
  ARCHIVE_INDEX_FILE,
  ARCHIVE_MANIFEST_FILE,
  foldWhitespace,
  tokenizeQuery,
} from '../src/recall/archive-search.mjs';

const HOT_TRUNCATE_SUBDIR = path.join('.longlive', 'hot-truncate');
const ARCHIVE_DIR_SUFFIX = '.archive';
const ARCHIVE_FILE_SUFFIX = '.zstd';
const MAX_WALK_DEPTH = 8;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function sha256Hex(input) {
  const hash = crypto.createHash('sha256');
  hash.update(typeof input === 'string' ? Buffer.from(input, 'utf8') : input);
  return hash.digest('hex');
}

export function briefError(error) {
  const message = error && typeof error.message === 'string' ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

function dshHome() {
  const raw = process.env.DSH_HOME;
  if (typeof raw === 'string' && raw.trim() !== '') return path.resolve(raw.trim());
  return path.join(os.homedir(), '.dsh');
}

export function defaultMemoryRoot() {
  for (const envName of ['DSH_LONGLIVE_MEMORY_ROOT', 'DSH_MEM']) {
    const value = process.env[envName];
    if (typeof value === 'string' && value.trim() !== '') return path.resolve(value.trim());
  }
  return path.join(dshHome(), 'longlive-memory');
}

export function defaultSessionsRoot() {
  return path.join(dshHome(), 'sessions');
}

// ---------------------------------------------------------------------------
// 输入发现
// ---------------------------------------------------------------------------

/** <memoryRoot>/.longlive/hot-truncate/*.jsonl（按文件名排序，保证构建确定）。 */
export function discoverHotTruncateInputs(memoryRoot) {
  const dir = path.join(path.resolve(memoryRoot), HOT_TRUNCATE_SUBDIR);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

/** <sessionsRoot>/**\\session.v4.jsonl.zstd.archive/*.zstd（只下钻到 .archive 目录，只读）。 */
export function discoverArchiveInputs(sessionsRoot) {
  if (typeof sessionsRoot !== 'string' || sessionsRoot.trim() === '') return [];
  const root = path.resolve(sessionsRoot.trim());
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir, depth) => {
    if (depth > MAX_WALK_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name.endsWith(ARCHIVE_DIR_SUFFIX)) {
        let files;
        try {
          files = fs.readdirSync(full, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const file of files) {
          if (file.isFile() && file.name.endsWith(ARCHIVE_FILE_SUFFIX)) out.push(path.join(full, file.name));
        }
      } else {
        walk(full, depth + 1);
      }
    }
  };
  walk(root, 0);
  return out.sort();
}

/** 归档输入在前、热截断在后；各自按路径排序。去重依赖这个顺序，不要随意改。 */
export function discoverInputs({ memoryRoot, sessionsRoot }) {
  const inputs = [];
  for (const filePath of discoverArchiveInputs(sessionsRoot)) inputs.push({ path: filePath, kind: 'archive' });
  for (const filePath of discoverHotTruncateInputs(memoryRoot)) inputs.push({ path: filePath, kind: 'hot-truncate' });
  return inputs;
}

// ---------------------------------------------------------------------------
// 输入解析
// ---------------------------------------------------------------------------

/**
 * 会话日志归档（多帧 zstd）：frame0 = session header，其后每帧是一批事件。
 * 逐帧解压、逐行 JSON.parse，不把整个快照 join 成一个大字符串（大归档省内存）。
 */
export function parseArchiveBuffer(buffer) {
  const frames = splitFrames(buffer);
  if (frames.length === 0) throw new Error('archive has no zstd frames');
  const headerText = decompressFrame(buffer.subarray(frames[0].start, frames[0].end));
  const headerLines = headerText.split('\n').filter((line) => line.length > 0);
  if (headerLines.length !== 1) throw new Error(`archive header frame must hold exactly 1 line, got ${headerLines.length}`);
  let header;
  try {
    header = JSON.parse(headerLines[0]);
  } catch (error) {
    throw new Error(`archive header is not JSON: ${briefError(error)}`);
  }
  if (!header || header.type !== 'session') throw new Error('archive header is not a session header');
  if (header.version !== 4) throw new Error(`unsupported archive header version ${header.version}`);

  const events = [];
  let expectedSeq = 0;
  for (let frameNo = 1; frameNo < frames.length; frameNo += 1) {
    const frame = frames[frameNo];
    const text = decompressFrame(buffer.subarray(frame.start, frame.end));
    for (const line of text.split('\n')) {
      if (line === '') continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw new Error(`archive frame ${frameNo}: event line is not JSON: ${briefError(error)}`);
      }
      if (!event || typeof event !== 'object') throw new Error(`archive frame ${frameNo}: event is not an object`);
      if (event.seq !== expectedSeq) throw new Error(`archive event seq ${event.seq} at index ${expectedSeq} (not contiguous from 0)`);
      expectedSeq += 1;
      events.push(event);
    }
  }
  return { header, events, frameCount: frames.length };
}

/** 热截断 JSONL：header 行 + 原始事件行 + footer 行。坏行计数但不打断（写入中的文件容忍）。 */
export function parseHotTruncateBuffer(buffer, filePath = '') {
  const lines = String(buffer ?? '').split('\n');
  let header = null;
  let sawFooter = false;
  let parseErrors = 0;
  const events = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      parseErrors += 1;
      continue;
    }
    if (item && item.kind === 'hot-truncate/header') {
      if (header === null) header = item;
      continue;
    }
    if (item && item.kind === 'hot-truncate/footer') {
      sawFooter = true;
      continue;
    }
    if (item && typeof item === 'object' && Number.isInteger(item.seq)) events.push(item);
    else parseErrors += 1;
  }
  if (!header) throw new Error(`hot-truncate file has no header: ${filePath}`);
  if (typeof header.sessionId !== 'string' || header.sessionId === '') {
    throw new Error(`hot-truncate header has no sessionId: ${filePath}`);
  }
  return { header, events, parseErrors, sawFooter };
}

function messageContentBlocks(event) {
  const data = event && typeof event.data === 'object' && event.data !== null ? event.data : null;
  const candidates = [data?.content, data?.message?.content, event?.message?.content];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return null;
}

/** 从事件流里抽 user/assistant 的正文文本（只要 content[].type==='text'，跳过 reasoning/tool-call）。 */
export function extractEntries({ events, sessionId, sourceSha, sourcePath }) {
  const entries = [];
  let turn = null;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'turn/start') {
      const value = event.data?.turn ?? event.turn;
      if (Number.isInteger(value)) turn = value;
      continue;
    }
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue;
    const blocks = messageContentBlocks(event);
    if (!blocks) continue;
    const textParts = [];
    for (const block of blocks) {
      if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') textParts.push(block.text);
    }
    if (textParts.length === 0) continue;
    const folded = foldWhitespace(textParts.join('\n'));
    if (folded === '') continue;
    const eventTurn = Number.isInteger(event.turn)
      ? event.turn
      : Number.isInteger(event.data?.turn)
        ? event.data.turn
        : turn;
    entries.push({
      p: sourcePath,
      s: sessionId,
      seq: Number.isInteger(event.seq) ? event.seq : null,
      turn: Number.isInteger(eventTurn) ? eventTurn : null,
      ts: Number.isFinite(event.time) ? event.time : null,
      t: folded,
      h: sourceSha,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 输出写入（tmp → rename，重复构建幂等）
// ---------------------------------------------------------------------------

function writeIndexLines({ lines, indexPath, dryRun }) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  if (dryRun) {
    for (const line of lines) {
      const buf = Buffer.from(`${line}\n`, 'utf8');
      hash.update(buf);
      bytes += buf.length;
    }
    return { bytes, sha256: hash.digest('hex'), written: false };
  }
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  const tmp = `${indexPath}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    for (const line of lines) {
      const buf = Buffer.from(`${line}\n`, 'utf8');
      fs.writeSync(fd, buf);
      hash.update(buf);
      bytes += buf.length;
    }
    fs.fsyncSync(fd);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw error;
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, indexPath);
  return { bytes, sha256: hash.digest('hex'), written: true };
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 构建
// ---------------------------------------------------------------------------

/**
 * 扫描输入、摘要、写索引。任何输入文件失败只记入 manifest（error 字段），不中断整体。
 * @returns {Promise<object>} receipt
 */
export async function buildArchiveDigest(options = {}) {
  const started = Date.now();
  if (typeof options.memoryRoot !== 'string' || options.memoryRoot.trim() === '') {
    throw new Error('buildArchiveDigest: memoryRoot is required');
  }
  const memoryRoot = path.resolve(options.memoryRoot.trim());
  const sessionsRoot = typeof options.sessionsRoot === 'string' && options.sessionsRoot.trim() !== ''
    ? path.resolve(options.sessionsRoot.trim())
    : defaultSessionsRoot();
  const outDir = typeof options.outDir === 'string' && options.outDir.trim() !== ''
    ? path.resolve(options.outDir.trim())
    : path.join(memoryRoot, '.longlive', ARCHIVE_DIGEST_DIR);
  const incremental = options.incremental === true;
  const dryRun = options.dryRun === true;
  const indexPath = path.join(outDir, ARCHIVE_INDEX_FILE);
  const manifestPath = path.join(outDir, ARCHIVE_MANIFEST_FILE);

  const inputs = discoverInputs({ memoryRoot, sessionsRoot });
  const stats = {
    inputs: inputs.length,
    archives: inputs.filter((input) => input.kind === 'archive').length,
    hotTruncate: inputs.filter((input) => input.kind === 'hot-truncate').length,
    inputsParsed: 0,
    inputsReused: 0,
    inputsFailed: 0,
    eventsScanned: 0,
    textEvents: 0,
    duplicatesDropped: 0,
    entryCount: 0,
  };

  // ---- 上次索引（增量） -----------------------------------------------------
  let prev = null;
  let prevUsable = false;
  if (incremental) {
    try {
      prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      prev = null;
    }
    if (prev && prev.schema === ARCHIVE_DIGEST_SCHEMA && typeof prev.indexSha256 === 'string' && fs.existsSync(indexPath)) {
      try {
        prevUsable = sha256Hex(fs.readFileSync(indexPath)) === prev.indexSha256;
      } catch {
        prevUsable = false;
      }
    }
  }
  const prevInputsList = prevUsable && Array.isArray(prev.inputs) ? prev.inputs : [];

  let oldGroups = null;
  let oldGroupsLoaded = false;
  const loadOldGroups = () => {
    if (oldGroupsLoaded) return oldGroups;
    oldGroupsLoaded = true;
    const groups = new Map();
    let text;
    try {
      text = fs.readFileSync(indexPath, 'utf8');
    } catch {
      oldGroups = null;
      return oldGroups;
    }
    for (const line of text.split('\n')) {
      if (line === '') continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        oldGroups = null;
        return oldGroups;
      }
      if (!entry || typeof entry.p !== 'string' || typeof entry.s !== 'string' || typeof entry.t !== 'string') {
        oldGroups = null;
        return oldGroups;
      }
      const list = groups.get(entry.p);
      if (list) list.push(line);
      else groups.set(entry.p, [line]);
    }
    oldGroups = groups;
    return oldGroups;
  };

  // ---- 主扫描 / 合并 -------------------------------------------------------
  const lines = [];
  const seen = new Set();
  const writtenByPath = new Map();
  const inputRecords = [];
  let reuseMode = incremental && prevUsable;

  const addEntryLine = (line, entry) => {
    const key = `${entry.s}\u0000${sha256Hex(entry.t)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    lines.push(line);
    writtenByPath.set(entry.p, (writtenByPath.get(entry.p) || 0) + 1);
    return true;
  };

  let inputIndex = 0;
  for (const input of inputs) {
    // 复用以「位置」为准，不按路径查：上一个清单里第 i 个输入必须还是同一个文件，
    // 否则（前面增/删/改/重排）前缀链已断，不能复用。
    const prevInput = prevUsable ? prevInputsList[inputIndex] : null;
    inputIndex += 1;
    let buffer;
    let sha256;
    let bytes;
    let mtimeMs;
    try {
      const stat = fs.statSync(input.path);
      buffer = fs.readFileSync(input.path);
      sha256 = sha256Hex(buffer);
      bytes = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch (error) {
      stats.inputsFailed += 1;
      inputRecords.push({ path: input.path, kind: input.kind, error: briefError(error) });
      reuseMode = false; // 读不到 = 前缀链断开
      continue;
    }

    if (reuseMode && prevInput && prevInput.path === input.path && prevInput.sha256 === sha256 && Number.isInteger(prevInput.entries)) {
      const groups = loadOldGroups();
      const reusedLines = groups ? groups.get(input.path) || [] : null;
      if (reusedLines && reusedLines.length === prevInput.entries) {
        let added = 0;
        for (const line of reusedLines) {
          let entry;
          try {
            entry = JSON.parse(line);
          } catch {
            entry = null;
          }
          if (!entry) {
            added = -1;
            break;
          }
          if (addEntryLine(line, entry)) added += 1;
        }
        if (added >= 0) {
          stats.inputsReused += 1;
          stats.eventsScanned += Number.isInteger(prevInput.events) ? prevInput.events : 0;
          stats.textEvents += Number.isInteger(prevInput.textEvents) ? prevInput.textEvents : 0;
          inputRecords.push({
            path: input.path,
            kind: input.kind,
            sha256,
            bytes,
            mtimeMs,
            events: Number.isInteger(prevInput.events) ? prevInput.events : 0,
            textEvents: Number.isInteger(prevInput.textEvents) ? prevInput.textEvents : 0,
            entries: added,
            reused: true,
          });
          continue;
        }
      }
    }
    // 有输入需要重解析（改/增/删/重排）→ 前缀链断开，其后一律重解析；
    // 否则「前面新增一个文件、后面同名旧文件被复用」会漏掉新去重关系。
    reuseMode = false;

    let parsed;
    try {
      if (input.kind === 'archive') {
        const archive = parseArchiveBuffer(buffer);
        if (typeof archive.header.id !== 'string' || archive.header.id === '') throw new Error('archive header has no session id');
        parsed = { sessionId: archive.header.id, events: archive.events, extra: { frameCount: archive.frameCount } };
      } else {
        const hot = parseHotTruncateBuffer(buffer, input.path);
        parsed = { sessionId: hot.header.sessionId, events: hot.events, extra: { parseErrors: hot.parseErrors, sawFooter: hot.sawFooter } };
      }
    } catch (error) {
      stats.inputsFailed += 1;
      inputRecords.push({ path: input.path, kind: input.kind, sha256, bytes, mtimeMs, error: briefError(error) });
      continue;
    }

    const entries = extractEntries({
      events: parsed.events,
      sessionId: parsed.sessionId,
      sourceSha: sha256,
      sourcePath: input.path,
    });
    let added = 0;
    for (const entry of entries) {
      if (addEntryLine(JSON.stringify(entry), entry)) added += 1;
    }
    stats.inputsParsed += 1;
    stats.eventsScanned += parsed.events.length;
    stats.textEvents += entries.length;
    inputRecords.push({
      path: input.path,
      kind: input.kind,
      sha256,
      bytes,
      mtimeMs,
      sessionId: parsed.sessionId,
      events: parsed.events.length,
      textEvents: entries.length,
      entries: added,
      reused: false,
      ...parsed.extra,
    });
  }

  stats.entryCount = lines.length;
  stats.duplicatesDropped = Math.max(0, stats.textEvents - stats.entryCount);

  const indexResult = writeIndexLines({ lines, indexPath, dryRun });
  const manifest = {
    schema: ARCHIVE_DIGEST_SCHEMA,
    builtAt: new Date().toISOString(),
    memoryRoot,
    sessionsRoot,
    outDir,
    incremental,
    indexSha256: indexResult.sha256,
    indexBytes: indexResult.bytes,
    entryCount: stats.entryCount,
    inputs: inputRecords,
    stats: { ...stats, elapsedMs: Date.now() - started },
  };
  if (!dryRun) writeJsonAtomic(manifestPath, manifest);

  return {
    schema: ARCHIVE_DIGEST_SCHEMA,
    memoryRoot,
    sessionsRoot,
    outDir,
    dryRun,
    incremental,
    index: {
      path: indexPath,
      bytes: indexResult.bytes,
      sha256: indexResult.sha256,
      entryCount: stats.entryCount,
      written: indexResult.written,
    },
    manifest: { path: manifestPath, written: !dryRun },
    inputs: inputRecords,
    stats: { ...stats, elapsedMs: Date.now() - started },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `用法: node scripts/archive-digest-build.mjs [选项]
  --memory-root <dir>    长活记忆根（读 .longlive/hot-truncate/*.jsonl）
  --sessions-root <dir>  会话日志根（默认 <DSH_HOME>/sessions）
  --out <dir>            输出目录（默认 <memory-root>/.longlive/archive-digest）
  --incremental          复用 sha256 未变的前缀输入（与全量构建等价）
  --dry-run              只扫描统计，不写任何文件
  --json                 以 JSON 打印 receipt
  --help                 显示本帮助`;

function parseCliArgs(argv) {
  const args = {
    memoryRoot: '',
    sessionsRoot: '',
    outDir: '',
    incremental: false,
    dryRun: false,
    json: false,
    help: false,
  };
  const valueFlags = new Map([
    ['--memory-root', 'memoryRoot'],
    ['--sessions-root', 'sessionsRoot'],
    ['--out', 'outDir'],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (valueFlags.has(arg)) {
      const value = argv[i + 1];
      if (typeof value !== 'string' || value === '') throw new Error(`${arg} needs a value`);
      args[valueFlags.get(arg)] = value;
      i += 1;
      continue;
    }
    if (arg === '--incremental') args.incremental = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function printHuman(receipt) {
  const { stats } = receipt;
  console.log(`[archive-digest-build] out=${receipt.outDir}`);
  console.log(`[archive-digest-build] inputs=${stats.inputs} (archive=${stats.archives} hot-truncate=${stats.hotTruncate}) ` +
    `parsed=${stats.inputsParsed} reused=${stats.inputsReused} failed=${stats.inputsFailed}`);
  console.log(`[archive-digest-build] events=${stats.eventsScanned} textEvents=${stats.textEvents} ` +
    `entries=${stats.entryCount} duplicatesDropped=${stats.duplicatesDropped}`);
  console.log(`[archive-digest-build] index bytes=${receipt.index.bytes} sha256=${receipt.index.sha256} ` +
    `written=${receipt.index.written} elapsed=${stats.elapsedMs}ms`);
  if (receipt.dryRun) console.log('[archive-digest-build] dry-run: nothing written');
}

async function main(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const memoryRoot = path.resolve(args.memoryRoot !== '' ? args.memoryRoot : defaultMemoryRoot());
  const sessionsRoot = path.resolve(args.sessionsRoot !== '' ? args.sessionsRoot : defaultSessionsRoot());
  const receipt = await buildArchiveDigest({
    memoryRoot,
    sessionsRoot,
    outDir: args.outDir,
    incremental: args.incremental,
    dryRun: args.dryRun,
  });
  if (args.json) console.log(JSON.stringify(receipt, null, 2));
  else printHuman(receipt);
  return 0;
}

const isMain = typeof process.argv[1] === 'string' && process.argv[1] !== ''
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`[archive-digest-build] FAILED: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
