// Router 1.1.0 WP5 — provider/model resolution and host failure mapping.
//
// Binding inputs (2026-11-05), repo root of the router-1100 workspace:
//   DECISIONS-WP5.md D-WP5-1..6
//   MODEL-PROVIDER-CONTRACT.md (host DSH 0.2.1-rc.5)
//
// Resolution order is fixed by D-WP5-1:
//   1) explicit routerModel (anything but "auto")
//   2) ctx.get('agentDefaultModel').currentSelection() when the provider matches
//   3) llm.listModels(provider), first non-preview id (MODEL_AUTO_PICKED_LIST_ORDER)
//   4) blocked E_NO_PROVIDER with candidates
// There is deliberately no version ranking, no guessing, and no hardcoded model id.

export const DEFAULT_PROVIDER = 'deepseek-official';
export const AUTO_MODEL = 'auto';

export const MODEL_AUTO_PICKED_LIST_ORDER = 'MODEL_AUTO_PICKED_LIST_ORDER';
export const MODEL_UNLISTED = 'MODEL_UNLISTED';
export const REASONING_EFFORT_UNSUPPORTED = 'REASONING_EFFORT_UNSUPPORTED';
export const PROVIDER_FALLBACK = 'PROVIDER_FALLBACK';
export const MODEL_AUTO_UNRESOLVED = 'MODEL_AUTO_UNRESOLVED';

const PREVIEW_RE = /(?:^|[-_.])(preview|experimental|beta|alpha|rc\d*)(?:$|[-_.])/i;

export function isPreviewModelId(id) {
  return PREVIEW_RE.test(String(id ?? ''));
}

export function readService(ctx, name) {
  try {
    if (!ctx || typeof ctx.get !== 'function') return null;
    return ctx.get(name) ?? null;
  } catch {
    return null;
  }
}

function nonemptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

// Detached copy: callers must never hold the host's selection object.
export function readCurrentSelection(ctx) {
  const service = readService(ctx, 'agentDefaultModel');
  if (!service || typeof service.currentSelection !== 'function') return null;
  try {
    const selection = service.currentSelection();
    if (!selection || typeof selection !== 'object') return null;
    const provider = nonemptyString(selection.provider);
    const model = nonemptyString(selection.model);
    if (!provider || !model || model === AUTO_MODEL) return null;
    const out = { provider, model };
    const effort = nonemptyString(selection.reasoningEffort);
    if (effort) out.reasoningEffort = effort;
    return out;
  } catch {
    return null;
  }
}

function providerIdsOf(raw) {
  const ids = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const id = typeof item === 'string' ? item : item?.id;
      if (nonemptyString(id)) ids.push(id.trim());
    }
  } else if (raw && typeof raw === 'object') {
    for (const id of Object.keys(raw)) {
      if (nonemptyString(id)) ids.push(id.trim());
    }
  }
  return [...new Set(ids)];
}

// Advisory only. A missing listProviders() means "cannot verify", not "no provider".
export async function listProviderIds(llm) {
  if (!llm || typeof llm.listProviders !== 'function') return { ok: false, ids: null };
  try {
    return { ok: true, ids: providerIdsOf(await llm.listProviders()) };
  } catch {
    return { ok: false, ids: null };
  }
}

export function modelIdsOf(raw) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === 'object') {
    list = Array.isArray(raw.models) ? raw.models : Array.isArray(raw.data) ? raw.data : [];
  }
  const ids = [];
  for (const item of list) {
    const id = typeof item === 'string' ? item : item?.id ?? item?.model ?? item?.name;
    if (nonemptyString(id) && id.trim() !== AUTO_MODEL) ids.push(id.trim());
  }
  return [...new Set(ids)];
}

// Host contract calls listModels(provider); older WP3 mocks accepted {provider}.
export async function listModelIds(llm, provider) {
  if (!llm || typeof llm.listModels !== 'function') return { ok: false, ids: [] };
  let raw;
  try {
    raw = await llm.listModels(provider);
  } catch {
    try {
      raw = await llm.listModels({ provider });
    } catch {
      return { ok: false, ids: [] };
    }
  }
  return { ok: true, ids: modelIdsOf(raw) };
}

async function supportedReasoningEffort(llm, provider, model, effort, warnings) {
  const wanted = nonemptyString(effort);
  if (!wanted) return null;
  if (!llm || typeof llm.resolveModelInfo !== 'function') return wanted;
  let info;
  try {
    info = await llm.resolveModelInfo(provider, model);
  } catch {
    // Metadata is advisory; a probe failure must not drop a requested effort.
    return wanted;
  }
  const declared = info?.reasoning?.efforts;
  if (Array.isArray(declared) && declared.length > 0) {
    const ids = declared
      .map((entry) => (typeof entry === 'string' ? entry : entry?.id))
      .filter((entry) => nonemptyString(entry));
    if (ids.length > 0 && !ids.includes(wanted)) {
      if (!warnings.includes(REASONING_EFFORT_UNSUPPORTED)) warnings.push(REASONING_EFFORT_UNSUPPORTED);
      return null;
    }
  }
  return wanted;
}

function blocked(reason, message, extra = {}) {
  return {
    ok: false,
    code: 'E_NO_PROVIDER',
    reason,
    message,
    candidates: Array.isArray(extra.candidates) ? extra.candidates : [],
    ...extra,
  };
}

function candidatesText(candidates) {
  return candidates.length > 0 ? candidates.join(', ') : 'none';
}

/**
 * Resolve the effective provider/model pair for one start (and for auto re-resolve).
 *
 * @param {object} input
 * @param {object} input.config   normalized Router config (provider, model, providerExplicit)
 * @param {object} input.ctx      plugin context (ctx.get only; ctx.llm is forbidden)
 * @param {object|null} input.llm llm service or null
 * @param {string|null} [input.explicitReasoningEffort] future/lead-provided effort override
 * @returns {Promise<object>} {ok:true, provider, providerSource, providerExplicit,
 *   providerCandidates, auto, model, modelSource, reasoningEffort, warnings, candidates}
 *   or {ok:false, code:'E_NO_PROVIDER', reason, message, candidates}
 */
export async function resolveModelTarget({ config, ctx, llm, explicitReasoningEffort = null } = {}) {
  const cfg = config && typeof config === 'object' ? config : {};
  const warnings = [];
  const configuredProvider = nonemptyString(cfg.provider);
  const configuredModel = nonemptyString(cfg.model);
  const providerExplicit = cfg.providerExplicit === true;
  const selection = readCurrentSelection(ctx);

  // ---- provider (D-WP5-6) -------------------------------------------------
  let provider;
  let providerSource;
  if (providerExplicit && configuredProvider) {
    provider = configuredProvider;
    providerSource = 'explicit';
  } else if (selection) {
    provider = selection.provider;
    providerSource = 'host-default';
  } else if (configuredProvider && configuredProvider !== DEFAULT_PROVIDER) {
    provider = configuredProvider;
    providerSource = 'configured';
  } else {
    provider = DEFAULT_PROVIDER;
    providerSource = 'default';
  }

  const providerList = await listProviderIds(llm);
  let providerCandidates = providerList.ids;
  if (Array.isArray(providerCandidates) && providerCandidates.length === 0) {
    return blocked('no_providers', 'llm.listProviders() returned no providers', {
      candidates: [],
      providerExplicit,
      providerSource,
    });
  }
  if (Array.isArray(providerCandidates) && !providerCandidates.includes(provider)) {
    if (providerSource === 'explicit') {
      return blocked(
        'provider_not_registered',
        `provider "${provider}" is not registered (candidates: ${candidatesText(providerCandidates)})`,
        { candidates: providerCandidates, providerExplicit, providerSource },
      );
    }
    if (providerCandidates.includes(DEFAULT_PROVIDER)) {
      provider = DEFAULT_PROVIDER;
      providerSource = 'default';
    } else {
      provider = providerCandidates[0];
      providerSource = 'fallback';
      warnings.push(PROVIDER_FALLBACK);
    }
  }

  // ---- model (D-WP5-1/2/3) ------------------------------------------------
  const explicitModel = configuredModel && configuredModel !== AUTO_MODEL ? configuredModel : '';

  if (explicitModel) {
    const listed = await listModelIds(llm, provider);
    let unlisted = false;
    if (listed.ok && listed.ids.length > 0 && !listed.ids.includes(explicitModel)) {
      unlisted = true;
      warnings.push(MODEL_UNLISTED);
    }
    const inherited = nonemptyString(explicitReasoningEffort);
    const reasoningEffort = inherited
      ? await supportedReasoningEffort(llm, provider, explicitModel, inherited, warnings)
      : null;
    return {
      ok: true,
      provider,
      providerSource,
      providerExplicit,
      providerCandidates,
      auto: false,
      model: explicitModel,
      modelSource: 'explicit',
      reasoningEffort,
      warnings,
      unlisted,
      candidates: listed.ids,
    };
  }

  if (!configuredModel) {
    return blocked('empty_model', 'routerProvider/routerModel is empty', {
      candidates: providerCandidates ?? [],
      providerExplicit,
      providerSource,
    });
  }

  // configuredModel === 'auto'
  const hostMatch = selection && selection.provider === provider ? selection.model : '';
  let model = '';
  let modelSource = '';
  let reasoningEffort = null;

  if (hostMatch) {
    model = hostMatch;
    modelSource = 'host-default';
    const wanted = nonemptyString(explicitReasoningEffort) || nonemptyString(selection.reasoningEffort);
    reasoningEffort = await supportedReasoningEffort(llm, provider, model, wanted, warnings);
  } else {
    const listed = await listModelIds(llm, provider);
    if (!listed.ok || listed.ids.length === 0) {
      return blocked(
        'no_model_candidates',
        `routerModel=auto could not be resolved: llm.listModels("${provider}") returned no models`,
        { candidates: [], providerExplicit, providerSource },
      );
    }
    const stable = listed.ids.filter((id) => !isPreviewModelId(id));
    if (stable.length === 0) {
      return blocked(
        'no_stable_model_candidate',
        `routerModel=auto could not be resolved: all candidates are preview/experimental (candidates: ${candidatesText(listed.ids)})`,
        { candidates: listed.ids, providerExplicit, providerSource },
      );
    }
    model = stable[0];
    modelSource = 'list-order';
    warnings.push(MODEL_AUTO_PICKED_LIST_ORDER);
    const wanted = nonemptyString(explicitReasoningEffort) || nonemptyString(selection?.reasoningEffort);
    reasoningEffort = await supportedReasoningEffort(llm, provider, model, wanted, warnings);
  }

  return {
    ok: true,
    provider,
    providerSource,
    providerExplicit,
    providerCandidates,
    auto: true,
    model,
    modelSource,
    reasoningEffort,
    warnings,
    unlisted: false,
    candidates: [],
  };
}

// Re-resolve path used by the `llm/adapters-updated` listener. Never throws.
export async function resolveAutoModelOnly({ config, ctx, llm } = {}) {
  try {
    return await resolveModelTarget({ config, ctx, llm, explicitReasoningEffort: null });
  } catch (error) {
    return blocked('resolver_error', `model resolver failed: ${error?.message ?? 'unknown error'}`, { candidates: [] });
  }
}

/**
 * D-WP5-5 host failure mapping.
 * terminal=true means Router blocks with routerCode. retryable=true keeps the
 * existing backoff path and never turns a transient provider hiccup into a
 * permanent block.
 */
export function mapProviderFailure(code, options = {}) {
  const hostCode = nonemptyString(code) || 'UNKNOWN';
  const upper = hostCode.toUpperCase();
  const rawRetry = Number(options.retryAfterMs);
  const retryAfterMs = Number.isFinite(rawRetry) && rawRetry >= 0 ? Math.min(rawRetry, 300000) : null;

  if (upper === 'ABORTED') {
    return { routerCode: 'E_ABORTED', hostCode, terminal: false, aborted: true, retryable: false, retryAfterMs: null };
  }
  if (['NO_ADAPTER', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'AUTH'].includes(upper)) {
    return { routerCode: 'E_NO_PROVIDER', hostCode, terminal: true, reason: 'provider_auth', retryAfterMs: null };
  }
  if (upper === 'RATE_LIMIT' || upper === 'ACCOUNT_QUOTA' || upper === 'HTTP_429') {
    return { routerCode: 'E_RATE_LIMITED', hostCode, terminal: false, rateLimited: true, retryable: true, retryAfterMs };
  }
  if (upper === 'QUOTA') {
    return { routerCode: 'E_QUOTA', hostCode, terminal: true, retryAfterMs: null };
  }
  if (upper === 'CONTEXT_WINDOW_EXCEEDED') {
    return { routerCode: 'E_CONTEXT_WINDOW', hostCode, terminal: true, retryAfterMs: null };
  }
  if (['TIMEOUT', 'TRANSPORT', 'SERVER', 'EMPTY_RESPONSE'].includes(upper) || /^HTTP_5\d\d$/.test(upper)) {
    return { routerCode: 'E_PROVIDER_FAILED', hostCode, terminal: false, retryable: true, retryAfterMs };
  }
  return { routerCode: 'E_PROVIDER_FAILED', hostCode, terminal: true, retryAfterMs: null };
}

export const HOST_AUTH_CODES = Object.freeze(['NO_ADAPTER', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'AUTH']);
