// src/util/local-day.js — local-day primitives shared outside the router.
//
// `localDayKey` (YYYY-MM-DD) is what quotas roll over on at local midnight.
// It used to live only in src/router/service/paths.mjs, but 1.8.4's proactive
// lifecycle (src/lifecycle/proactive.js) needs the same key and product code
// must not import src/router (R1-ID4: the router is reachable only through the
// explicit seam in src/index.js). It lives here, in a neutral module, and the
// router path helper re-exports it so existing router callers are untouched.
//
// Pure functions, no IO.

/** Coerce Date | epoch ms | parseable string into a Date; fall back to now. */
export function nowDate(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : new Date();
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms);
  }
  return new Date();
}

/** Local-day key (YYYY-MM-DD) — quotas roll over at local midnight. */
export function localDayKey(value) {
  const date = nowDate(value);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
