// D2 — trim oversized tool results before they reach the context.
//
// Seam: the host's `tools/post-execute` waterfall (Cordis). The host runs it
// after a tool has produced its content and before that content is appended to
// the session log (`@deepseek-ai/dsh-tools` lib/pipeline.js `postExecute` →
// `commit` → `session.append('tool/result', …)`), so a replacement returned
// here is exactly what the model sees and what the log keeps. No history
// rewriting, no second pass over the context.
//
// Contract with D3: the archive lands at the D3 convention
//   `<memoryRoot>/.longlive/tool-output/<turn>/<id>.txt`
// with `<id>` = `archiveFileName({kind:'tool', toolCallId})`, i.e. the same
// toolCallId that `session_original` uses to plan a path. D3 never writes it;
// D2 does, and both agree on the name.
//
// Safety envelope:
//   - off by default: `d2.enabled !== true` registers no listener at all;
//   - fail-open: every failure keeps the untouched decision and never throws
//     out of the hook (a broken trim must not break a turn);
//   - the privacy gate (`privacyScan`) scans the FULL text before anything is
//     written; a hit writes nothing and leaves a placeholder;
//   - write-before-replace: the archive is renamed into place before the
//     content is swapped, so a path printed in the context always resolves.
//
// Ordering note: this listener does NOT use `{prepend:true}`. It runs after
// other post-execute policies (notably `@deepseek-ai/dsh-spill-policy`) and its
// decision is the final one, while `result.content` — read before `next()`
// resolves — is still the untrimmed tool output.

import fs from 'node:fs';
import path from 'node:path';

import { archiveFileName, textOfParts } from './original.js';
import { privacyScan } from './recall/privacy.mjs';

export const D2_DEFAULTS = Object.freeze({
  enabled: true,
  maxInlineChars: 4096,
  headRatio: 0.6,
  skipTools: Object.freeze(['read']),
  trimErrors: false,
});
export const D2_MIN_MAX_INLINE_CHARS = 64;
export const D2_MAX_MAX_INLINE_CHARS = 1_000_000;

/** Where D2 keeps tool output for a memory root (D3's convention). */
export function toolOutputRoot(memoryRoot) {
  return path.join(String(memoryRoot ?? ''), '.longlive', 'tool-output');
}

/** `<memoryRoot>/.longlive/tool-output/<turn>` — the directory D3 plans too. */
export function toolOutputDir(memoryRoot, turn) {
  return path.join(toolOutputRoot(memoryRoot), String(turn));
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Normalise `config.d2`. Unknown/invalid values fall back to the defaults
 * instead of failing activation: a typo must not disable a working feature or,
 * worse, make it trim at a nonsense size.
 */
export function normalizeD2Config(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const skipTools = Array.isArray(source.skipTools)
    ? source.skipTools.filter((name) => typeof name === 'string' && name !== '')
    : [...D2_DEFAULTS.skipTools];
  return {
    enabled: source.enabled !== false,
    maxInlineChars: Math.round(clampNumber(
      source.maxInlineChars,
      D2_DEFAULTS.maxInlineChars,
      D2_MIN_MAX_INLINE_CHARS,
      D2_MAX_MAX_INLINE_CHARS,
    )),
    headRatio: clampNumber(source.headRatio, D2_DEFAULTS.headRatio, 0.2, 0.8),
    skipTools,
    trimErrors: source.trimErrors === true,
  };
}

/**
 * Split `text` into an inline head and tail of at most `maxInlineChars`
 * characters (head ≈ `headRatio`). Never splits a surrogate pair, so an emoji
 * on the boundary cannot become a lone half. Returns `trimmed:false` when the
 * text already fits.
 */
export function splitHeadTail(text, maxInlineChars, headRatio = D2_DEFAULTS.headRatio) {
  const source = String(text ?? '');
  const budget = Math.max(1, Math.round(Number(maxInlineChars) || D2_DEFAULTS.maxInlineChars));
  if (source.length <= budget) {
    return { head: source, tail: '', headChars: source.length, tailChars: 0, omittedChars: 0, trimmed: false };
  }
  const headBudget = Math.max(1, Math.min(budget - 1, Math.round(budget * clampNumber(headRatio, 0.6, 0.2, 0.8))));
  const tailBudget = Math.max(0, budget - headBudget);

  let head = source.slice(0, headBudget);
  if (head.length > 0 && /[\uD800-\uDBFF]/.test(head[head.length - 1])) head = head.slice(0, -1);
  let tail = tailBudget > 0 ? source.slice(source.length - tailBudget) : '';
  if (tail.length > 0 && /[\uDC00-\uDFFF]/.test(tail[0])) tail = tail.slice(1);

  return {
    head,
    tail,
    headChars: head.length,
    tailChars: tail.length,
    omittedChars: source.length - head.length - tail.length,
    trimmed: true,
  };
}

/** The single context line that replaces an archived tool output. */
export function formatD2Notice({
  chars,
  inlineChars,
  bytes,
  file,
  turn,
  callId,
  toolName,
}) {
  const name = toolName ? ` (${toolName})` : '';
  const turnHint = Number.isInteger(turn)
    ? ` or session_original(turn=${turn}, toolCallId=${JSON.stringify(callId)})`
    : '';
  return `[D2] tool output${name} trimmed: ${chars} chars → ${inlineChars} inline. ` +
    `Full output (${bytes} bytes) saved at ${file} — read it back with read(path)${turnHint}.`;
}

/** The placeholder left when the privacy gate refuses to archive. */
export function formatD2PrivacyNotice({ chars, toolName, reasons }) {
  const name = toolName ? ` from ${toolName}` : '';
  const why = Array.isArray(reasons) && reasons.length > 0 ? ` (${reasons.join(', ')})` : '';
  return `[D2] tool output${name} withheld: ${chars} chars matched the privacy gate${why}. ` +
    'Nothing was written to disk and the text is not shown here.';
}

function warn(logger, message, error) {
  try {
    if (typeof logger?.warn === 'function') logger.warn(`${message}: ${error?.message ?? error}`);
    else if (typeof logger === 'function') logger(`${message}: ${error?.message ?? error}`);
  } catch {
    /* logging a failure must not create one */
  }
}

/**
 * The turn a tool call belongs to.
 *
 * `exec` carries no turn (0.2.2 `createExecution`), so ask the `agents`
 * service's turnBoundary projection (O(1)); if that service or its projection
 * is unavailable, scan the session log backwards for the latest `turn/start`.
 * Returning null is safe: the caller keeps the original content.
 */
export function currentTurnOf(ctx, exec) {
  const session = exec?.agent?.session;
  if (!session) return null;
  try {
    const agents = typeof ctx?.get === 'function' ? ctx.get('agents') : null;
    const boundary = agents?.turnBoundaryOf?.(session);
    if (Number.isInteger(boundary?.lastTurn) && boundary.lastTurn >= 1) return boundary.lastTurn;
  } catch {
    /* projection unavailable — fall through to the log scan */
  }
  try {
    const length = Number(session.seq);
    for (let seq = (Number.isInteger(length) ? length : 0) - 1; seq >= 0; seq -= 1) {
      const event = session.eventAt(seq);
      if (event?.type === 'turn/start' && Number.isInteger(event?.data?.turn)) return event.data.turn;
    }
  } catch {
    /* unreadable log — no turn */
  }
  return null;
}

/** Merge every text part into one string and replace them with `text`. */
export function replaceTextParts(content, text) {
  const parts = Array.isArray(content) ? content : [];
  const out = [];
  let placed = false;
  for (const part of parts) {
    if (part && part.type === 'text' && typeof part.text === 'string') {
      if (!placed) {
        out.push({ ...part, text });
        placed = true;
      }
      continue;
    }
    if (part) out.push(part);
  }
  if (!placed) out.unshift({ type: 'text', text });
  return out;
}

/** Atomic archive write: tmp file next to the target, then rename. */
function writeArchiveAtomic(dir, file, text) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the tmp file may not exist yet */
    }
    throw error;
  }
}

/**
 * The whole decision, one call. Pure over its inputs except the injected
 * `scan` / `writeArchive` / `now`, which is what makes the five acceptance
 * cases testable with a fake host.
 *
 * Returns `{action, decision}` where `decision` is always a valid
 * `tools/post-execute` accept decision. `action` is one of
 * `off | keep | small | trimmed | privacy | error`.
 */
export function decideToolOutputTrim({
  exec,
  result,
  decision,
  settings,
  memoryRoot,
  turn,
  scan = privacyScan,
  writeArchive = writeArchiveAtomic,
  nextIndex = () => 0,
}) {
  if (!settings?.enabled) return { action: 'off', decision };
  if (!decision || decision.kind !== 'accept') return { action: 'keep', decision };
  // Another policy already replaced the value (e.g. a structured tool result):
  // D2 only ever rewrites text content.
  if (Object.hasOwn(decision, 'value')) return { action: 'keep', decision };
  if (exec?.parent) return { action: 'keep', decision };
  const toolName = typeof exec?.name === 'string' ? exec.name : '';
  if (settings.skipTools.includes(toolName)) return { action: 'keep', decision };
  if (settings.trimErrors !== true && result?.isError === true) return { action: 'keep', decision };

  const content = result?.content;
  if (!Array.isArray(content)) return { action: 'keep', decision };
  const { text } = textOfParts(content);
  if (text === '') return { action: 'keep', decision };
  if (text.length <= settings.maxInlineChars) return { action: 'small', decision };

  const callId = typeof exec?.callId === 'string' && exec.callId !== ''
    ? exec.callId
    : (typeof exec?.rootCallId === 'string' ? exec.rootCallId : '');
  const chars = text.length;
  const bytes = Buffer.byteLength(text, 'utf8');

  // Privacy gate first: a match must not write anything, not even a tmp file.
  const verdict = scan(text);
  if (verdict && verdict.verdict !== 'none') {
    const placeholder = formatD2PrivacyNotice({ chars, toolName, reasons: verdict.reasons });
    return {
      action: 'privacy',
      decision: { ...decision, content: replaceTextParts(content, placeholder) },
    };
  }

  if (!Number.isInteger(turn) || turn < 1 || !memoryRoot) return { action: 'keep', decision };

  const seq = nextIndex();
  const dir = toolOutputDir(memoryRoot, turn);
  const file = path.join(dir, archiveFileName({ kind: 'tool', toolCallId: callId || null, seq }));
  writeArchive(dir, file, text);

  const { head, tail, headChars, tailChars, omittedChars } = splitHeadTail(
    text,
    settings.maxInlineChars,
    settings.headRatio,
  );
  const notice = formatD2Notice({
    chars,
    inlineChars: headChars + tailChars,
    bytes,
    file,
    turn,
    callId,
    toolName,
  });
  const inline = [head, notice, tail].filter((part) => part !== '').join('\n\n');
  return {
    action: 'trimmed',
    info: { chars, bytes, file, turn, headChars, tailChars, omittedChars, inlineChars: inline.length },
    decision: { ...decision, content: replaceTextParts(content, inline) },
  };
}

/**
 * Build the `tools/post-execute` listener. The listener is fail-open by
 * construction: `next()` is always honoured, and every internal failure
 * returns whatever the next policy decided.
 */
export function createTrimHandler({
  settings,
  memoryRoot,
  logger = null,
  currentTurn = (exec) => currentTurnOf(null, exec),
  nextIndex = () => 0,
  scan = privacyScan,
  writeArchive = writeArchiveAtomic,
  onTrimmed = null,
} = {}) {
  return async function trimToolResult(exec, result, next) {
    let decision;
    try {
      decision = await next();
    } catch (error) {
      warn(logger, 'tool-output trim: next() failed', error);
      throw error;
    }
    try {
      const outcome = decideToolOutputTrim({
        exec,
        result,
        decision,
        settings,
        memoryRoot,
        turn: currentTurn(exec),
        scan,
        writeArchive,
        nextIndex,
      });
      if (outcome.action === 'trimmed' && typeof onTrimmed === 'function') {
        try {
          onTrimmed(outcome.info);
        } catch {
          /* an observer must not break the hook */
        }
      }
      return outcome.decision;
    } catch (error) {
      warn(logger, 'tool-output trim failed; keeping the inline output', error);
      return decision;
    }
  };
}

/**
 * Mount D2 on a Cordis-like context. Returns a small status object; the
 * listener is disposed with the plugin scope when the context supports
 * `ctx.effect`.
 */
export function registerToolOutputTrim(ctx, config, { memoryRoot = null, logger = null } = {}) {
  const settings = normalizeD2Config(config?.d2);
  if (!settings.enabled) return { enabled: false, registered: false, settings };
  if (!memoryRoot) {
    warn(logger ?? ctx?.logger, 'tool-output trim enabled but memoryRoot is unset — not registered');
    return { enabled: true, registered: false, settings, reason: 'E_MEMORY_ROOT_UNSET' };
  }
  if (typeof ctx?.on !== 'function') {
    return { enabled: true, registered: false, settings, reason: 'E_NO_HOOK_SEAM' };
  }

  let counter = 0;
  const handler = createTrimHandler({
    settings,
    memoryRoot,
    logger: logger ?? ctx?.logger,
    currentTurn: (exec) => currentTurnOf(ctx, exec),
    nextIndex: () => (counter += 1),
  });

  let dispose = null;
  try {
    dispose = ctx.on('tools/post-execute', handler);
  } catch (error) {
    warn(logger ?? ctx?.logger, 'tool-output trim could not listen on tools/post-execute', error);
    return { enabled: true, registered: false, settings, reason: 'E_HOOK_FAILED' };
  }
  if (typeof dispose === 'function' && typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => () => dispose(), 'longlive.tool-output');
    } catch {
      /* fake context without an effect scope: listener lives with the plugin */
    }
  }
  try {
    ctx?.logger?.info?.(
      `longlive D2: tool output trim on — >${settings.maxInlineChars} chars archived to ` +
        `${toolOutputRoot(memoryRoot)} (head ${Math.round(settings.headRatio * 100)}%)`,
    );
  } catch {
    /* logging must not fail activation */
  }
  return { enabled: true, registered: true, settings, dispose, archiveRoot: toolOutputRoot(memoryRoot) };
}
