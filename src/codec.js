// @local/dsh-longlive — codec
//
// DSH session logs are multi-frame zstd streams (`session.v4.jsonl.zstd`):
//   frame 1 : exactly one JSON line  -> the session header
//   frame n : a chunk of JSON lines  -> events
// Every event carries a monotonically increasing `seq` starting at 0.
//
// Nothing here reads message content beyond the fields needed to fold the
// Surface and hash the visible messages. No network, no third-party deps.

import zlib from 'node:zlib';
import crypto from 'node:crypto';

export const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
export const HEADER_VERSION = 4;

const ZSTD_CHECKSUM_FLAG = zlib.constants.ZSTD_c_checksumFlag ?? 1;

/** Compress one chunk with the same settings the host uses (checksum on). */
export function compressFrame(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'), {
    params: { [ZSTD_CHECKSUM_FLAG]: 1 },
  });
}

/** Decompress one frame. Throws when the bytes are not one valid zstd frame. */
export function decompressFrame(frame) {
  return zlib.zstdDecompressSync(frame).toString('utf8');
}

const ZSTD_MAGIC_LE = 0xfd2fb528; // bytes 28 B5 2F FD, read little-endian
const SKIPPABLE_MAGIC_MIN = 0x184d2a50;
const SKIPPABLE_MAGIC_MAX = 0x184d2a5f;
const DICTIONARY_ID_BYTES = [0, 1, 2, 4];
const CONTENT_SIZE_BYTES = [0, 2, 4, 8];

/**
 * Length in bytes of exactly one zstd frame starting at `start`, read from the
 * frame structure itself (RFC 8878 §3.1): frame header, then block headers
 * until the last block, then the optional content checksum.
 *
 * Nothing here searches for the next magic: a magic byte pair inside compressed
 * payload is invisible to this walk, which is the whole point (see splitFrames).
 */
export function zstdFrameLength(buf, start = 0) {
  const bad = (what, at) => new Error(`corrupt session log: ${what} at byte ${at}`);
  let p = start;
  if (p + 4 > buf.length) throw bad('truncated zstd frame magic', p);
  const magic = buf.readUInt32LE(p);
  if (magic >= SKIPPABLE_MAGIC_MIN && magic <= SKIPPABLE_MAGIC_MAX) {
    if (p + 8 > buf.length) throw bad('truncated skippable zstd frame header', p);
    const size = buf.readUInt32LE(p + 4);
    if (p + 8 + size > buf.length) throw bad(`truncated skippable zstd frame (${size} payload bytes)`, p);
    return p + 8 + size;
  }
  if (magic !== ZSTD_MAGIC_LE) throw bad('no zstd frame magic', p);
  p += 4;

  if (p + 1 > buf.length) throw bad('truncated zstd frame header', p);
  const descriptor = buf[p];
  p += 1;
  const contentSizeFlag = descriptor >>> 6;
  const singleSegment = (descriptor >>> 5) & 1;
  const checksumFlag = (descriptor >>> 2) & 1;
  const dictionaryFlag = descriptor & 3;
  if ((descriptor >>> 3) & 1) throw bad('reserved bit set in the zstd frame header', start);

  if (!singleSegment) {
    if (p + 1 > buf.length) throw bad('truncated zstd window descriptor', p);
    p += 1;
  }
  p += DICTIONARY_ID_BYTES[dictionaryFlag];
  p += contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : CONTENT_SIZE_BYTES[contentSizeFlag];
  if (p > buf.length) throw bad('truncated zstd frame header fields', start);

  for (;;) {
    if (p + 3 > buf.length) throw bad('truncated zstd block header', p);
    const header = buf.readUIntLE(p, 3);
    p += 3;
    const lastBlock = header & 1;
    const blockType = (header >>> 1) & 3;
    const blockSize = header >>> 3;
    if (blockType === 3) throw bad('reserved zstd block type', p - 3);
    // An RLE block stores one byte whatever its decompressed size claims.
    p += blockType === 1 ? 1 : blockSize;
    if (p > buf.length) throw bad('truncated zstd block payload', p);
    if (lastBlock) break;
  }
  if (checksumFlag) p += 4;
  if (p > buf.length) throw bad('truncated zstd content checksum', p);
  return p;
}

/**
 * Split a log buffer into its physical zstd frames.
 *
 * Boundaries come from the frame structure (zstdFrameLength), not from scanning
 * for the magic: a compressed payload that happens to contain 28 B5 2F FD used
 * to be read as a frame boundary, which cut one frame into two and left the log
 * unparseable. Each computed slice is then decompressed as a proof, so a corrupt
 * log still fails loudly instead of yielding frames nobody can read.
 */
export function splitFrames(buf) {
  const firstMagic = buf.indexOf(MAGIC, 0);
  if (firstMagic < 0) throw new Error('not a zstd session log: frame magic 28 B5 2F FD not found');
  if (firstMagic !== 0) throw new Error(`corrupt session log: ${firstMagic} stray bytes before the first frame`);

  const frames = [];
  let cursor = 0;
  while (cursor < buf.length) {
    const end = zstdFrameLength(buf, cursor);
    try {
      decompressFrame(buf.subarray(cursor, end));
    } catch (error) {
      throw new Error(`corrupt session log: zstd frame ${frames.length} at byte ${cursor} ` +
        `(${end - cursor} bytes) does not decompress: ${error.message}`);
    }
    frames.push({ start: cursor, end, bytes: end - cursor });
    cursor = end;
  }
  return frames;
}

/** Read + decompress + parse a session log buffer. */
export function parseSession(buf) {
  const frames = splitFrames(buf);
  const texts = frames.map((f) => decompressFrame(buf.subarray(f.start, f.end)));
  const text = texts.join('');
  const lines = text.split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error('corrupt session log: empty');
  let header;
  let events;
  try {
    header = JSON.parse(lines[0]);
  } catch (error) {
    throw new Error(`corrupt session log: first frame is not a JSON header (${error.message})`);
  }
  if (header.type !== 'session') throw new Error('corrupt session log: the first line is not a session header');
  if (header.version !== HEADER_VERSION) {
    throw new Error(`unsupported session format: header version ${header.version}, this plugin supports v${HEADER_VERSION}`);
  }
  events = lines.slice(1).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`corrupt session log: event line ${index + 2} is not JSON (${error.message})`);
    }
  });
  assertContiguous(events);
  return { frames, texts, header, events, bytes: buf.length };
}

/** Every event must satisfy `seq === array index`. */
export function assertContiguous(events) {
  for (let i = 0; i < events.length; i += 1) {
    if (events[i].seq !== i) {
      throw new Error(`corrupt session log: event at index ${i} has seq ${events[i].seq} (expected ${i}); seq must be contiguous from 0`);
    }
  }
}

/**
 * Serialize a session the way the host does: one header frame, then chunks.
 * `eventsPerFrame` only affects size/IO, never semantics.
 */
export function encodeSession(header, events, { eventsPerFrame = 2000 } = {}) {
  assertContiguous(events);
  const out = [];
  out.push(compressFrame(JSON.stringify(header) + '\n'));
  for (let i = 0; i < events.length; i += eventsPerFrame) {
    const chunk = events.slice(i, i + eventsPerFrame).map((e) => JSON.stringify(e) + '\n').join('');
    out.push(compressFrame(chunk));
  }
  return Buffer.concat(out);
}

/** Deterministic JSON: sorted keys, so hashes do not depend on key order. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** sha256 of a buffer, hex. */
export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const VOLATILE_KEYS = new Set([
  'seq', 'turn', 'step', 'time', 'surfaceOp',
  'startSeq', 'endSeq', 'start', 'end',
  'sourceEventSeqs', 'shadowedSeqs', 'shadowedRange', 'shadowedTokenCount',
  'messageSeqs', 'headerSeq', 'sourceEventSeq', 'throughSeq', 'compactionId',
]);

/** Strip coordinates that legitimately change when seqs/turns are renumbered. */
function projectValue(value) {
  if (Array.isArray(value)) return value.map(projectValue);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value)) {
    if (VOLATILE_KEYS.has(key)) continue;
    out[key] = projectValue(value[key]);
  }
  return out;
}

/** Types that can appear in the model-visible message list. */
export const MESSAGE_TYPES = new Set([
  'system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result',
]);

function rangeOf(surfaceOp) {
  if (!surfaceOp || typeof surfaceOp !== 'object') return null;
  const start = surfaceOp.startSeq ?? surfaceOp.start;
  const end = surfaceOp.endSeq ?? surfaceOp.end;
  if (typeof start !== 'number' || typeof end !== 'number') return null;
  return { start, end };
}

/**
 * Fold the event log into the Surface (append / replace), mirroring the
 * host's `foldSurface`.
 *
 * A replace names its span by SURFACE POSITION, not by numeric seq order: the
 * replacement node takes the first node's position, so after an earlier
 * replacement the declared `start` seq can be greater than `end`
 * (`CompactionResult.shadowedRange` documents exactly that). Resolving both
 * edges positionally — instead of testing `start <= seq <= end` — is what keeps
 * a second cut from leaving the previous pointer visible.
 *
 * Returns nodes in surface order: [{ seq, type, event }].
 */
export function foldSurface(events) {
  const nodes = [];
  for (const event of events) {
    const op = event.surfaceOp;
    if (op === 'append') {
      nodes.push({ seq: event.seq, type: event.type, event });
      continue;
    }
    const range = rangeOf(op);
    if (!range) continue; // log-only events (no surfaceOp) never enter the Surface
    const startIndex = nodes.findIndex((node) => node.seq === range.start);
    const endIndex = nodes.findIndex((node) => node.seq === range.end);
    if (startIndex < 0 || endIndex < startIndex) continue;
    nodes.splice(startIndex, endIndex - startIndex + 1, { seq: event.seq, type: event.type, event });
  }
  return nodes;
}

/**
 * Digest of the model-visible messages implied by this log.
 *
 * This is the plugin's deterministic stand-in for the host's deriveMessages:
 * fold the Surface, keep message-like nodes, project out coordinates that are
 * allowed to change on truncation (seq / turn / step / references), and hash
 * the rest. Two logs with the same visible conversation hash the same.
 */
export function deriveMessagesDigest(header, events) {
  const nodes = foldSurface(events).filter((node) => MESSAGE_TYPES.has(node.type));
  const projected = nodes.map((node) => ({
    type: node.type,
    data: projectValue(node.event.data ?? {}),
  }));
  const text = stableStringify(projected);
  return { count: projected.length, chars: text.length, sha256: sha256(Buffer.from(text, 'utf8')) };
}
