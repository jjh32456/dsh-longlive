/**
 * D1 — classify one model-visible message into a working-set layer.
 *
 * Layers:
 *   fixed       system prompt + tool schemas + host-injected context
 *               (agent instructions, runtime context, skill catalog, engram
 *               memory, time context, developer/tool-registry messages)
 *   recent      real conversation inside the keepTurns window
 *   recall      auto-recall injection (`【自动想起】`)
 *   conclusion  boot card (`【开机卡】`) or a future board lastConclusion
 *
 * Everything that is real conversation but older than the window is
 * `carried` — it stays in the request today because D2/D3 trimming is not
 * implemented, and the ledger must show that honestly.
 */

export const RECALL_HEADER = '【自动想起】';
export const CONCLUSION_HEADER = '【开机卡】';

/**
 * Host-injected user messages that are prompt scaffolding, not conversation.
 * Keep this list explicit: an unknown `source.kind` is treated as fixed only
 * when it is clearly host-owned, so a new host notification cannot silently
 * inflate the fixed layer.
 */
export const FIXED_SOURCE_KINDS = new Set([
  'agent-instructions',
  'runtime-context',
  'skill-catalog',
  'plugin:dsh-engram',
  'time-context',
]);

/** Host/user messages that belong to the conversation stream. */
export const CONVERSATION_SOURCE_KINDS = new Set([
  'user',
  'archive-card',
  'agent-message',
  'subagent-settled',
  'user-approval',
]);

/** Return the message carried by a session event. */
export function messageOfEvent(event) {
  const data = event === null || typeof event !== 'object' ? null : event.data;
  if (data === null || typeof data !== 'object') return null;
  if (data.message !== null && typeof data.message === 'object') return data.message;
  // `user/message` stores the message itself as the event data (no wrapper).
  if (typeof data.role === 'string') return data;
  return null;
}

export function sourceKindOf(message) {
  const source = message === null || typeof message !== 'object' ? null : message.source;
  return source !== null && typeof source === 'object' && typeof source.kind === 'string'
    ? source.kind
    : '';
}

/** First non-empty line, trimmed; '' for non-strings. */
export function firstLine(text) {
  if (typeof text !== 'string' || text === '') return '';
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return '';
}

/**
 * The injection source shape is shared by the boot card and auto-recall
 * (`session-reference` / `recall`), so the first line is the discriminator.
 */
export function isRecallText(text) {
  return firstLine(text).startsWith(RECALL_HEADER);
}

export function isConclusionText(text) {
  return firstLine(text).startsWith(CONCLUSION_HEADER);
}

/**
 * Classify one message.
 * @returns {'fixed'|'recall'|'conclusion'|'conversation'|'unknown'}
 *   Callers use `conversation` plus the message turn to decide recent/carried.
 */
export function classifyMessage(message) {
  if (message === null || typeof message !== 'object') return 'unknown';
  const role = typeof message.role === 'string' ? message.role : '';
  if (role === 'system' || role === 'developer') return 'fixed';
  if (role === 'assistant' || role === 'tool') return 'conversation';
  if (role !== 'user') return 'unknown';

  const kind = sourceKindOf(message);
  const text = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      : '';

  if (kind === 'plugin:dsh-auto-recall' || isRecallText(text)) return 'recall';
  if (kind === 'plugin:dsh-identity-router' || isConclusionText(text)) return 'conclusion';
  if (FIXED_SOURCE_KINDS.has(kind)) return 'fixed';
  if (CONVERSATION_SOURCE_KINDS.has(kind)) return 'conversation';
  // An unknown host-owned source (has a kind but is not the real user) is
  // prompt scaffolding rather than conversation.  This keeps total honest
  // when the harness adds a new injection type.
  if (kind !== '') return 'fixed';
  const source = message.source;
  if (source !== null && typeof source === 'object'
    && (source.sections !== undefined || typeof source.form === 'string')) {
    return 'fixed';
  }
  return 'conversation';
}

/**
 * Parse recall card ids from the rendered injection body.
 *
 * Rendered form (one per line):
 *   - 《Card title》（topics/card.md · 相关度 1.72）
 *
 * References are empty in the live payload, so text parsing is the reliable
 * path; `message.source.references` is used first when present.
 */
export function recallIdsFromText(text) {
  if (typeof text !== 'string' || text === '') return [];
  const out = [];
  const re = /^[-*]\s*《([^》\n]{1,200})》\s*[（(]([^）)\n]{1,500})[）)]/gm;
  let match = re.exec(text);
  while (match !== null) {
    const title = match[1].trim();
    const rawPath = match[2].trim();
    const cardPath = rawPath.split(/\s*[·|]\s*/)[0].replace(/`/g, '').trim();
    if (cardPath !== '' || title !== '') out.push({ title, path: cardPath });
    match = re.exec(text);
  }
  return dedupeIds(out);
}

/** Card ids carried by one message: source.references first, text second. */
export function recallIdsFromMessage(message) {
  if (message === null || typeof message !== 'object') return [];
  const source = message.source;
  const refs = source !== null && typeof source === 'object' ? source.references : null;
  if (Array.isArray(refs) && refs.length > 0) {
    const ids = [];
    for (const ref of refs) {
      if (typeof ref === 'string' && ref.trim() !== '') ids.push({ title: '', path: ref.trim() });
      else if (ref !== null && typeof ref === 'object') {
        const cardPath = typeof ref.path === 'string' ? ref.path.trim() : '';
        const title = typeof ref.title === 'string' ? ref.title.trim() : '';
        if (cardPath !== '' || title !== '') ids.push({ title, path: cardPath });
      }
    }
    const deduped = dedupeIds(ids);
    if (deduped.length > 0) return deduped;
  }
  const text = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      : '';
  return recallIdsFromText(text);
}

/** Stable dedupe: path when present, otherwise title. */
export function dedupeIds(ids) {
  const seen = new Set();
  const out = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (id === null || typeof id !== 'object') continue;
    const title = typeof id.title === 'string' ? id.title : '';
    const cardPath = typeof id.path === 'string' ? id.path : '';
    const key = cardPath !== '' ? `p:${cardPath}` : `t:${title}`;
    if (key === 'p:' || key === 't:' || seen.has(key)) continue;
    seen.add(key);
    out.push({ title, path: cardPath });
  }
  return out;
}
