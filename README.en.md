# @jjh32456/dsh-longlive (Longlive)

A DeepSeek Harness plugin that keeps a long session healthy: **inspect it, back it up, and shrink it safely** before the context window fills up. No standalone UI; no network requests or telemetry in the default configuration (Router / RouterFace / embedding call the provider you configure, only after you enable them).
## What you get

- **22 tools** for session health/backup/compaction/truncation, on-demand original-text fetch, memory cards, workers (fan-out is on by default since 1.8.0; set `workers.enabled: false` to disable), and the live-session registry.
- A memory store at `<DSH home>/longlive-memory` (on Windows: `%USERPROFILE%\.dsh\longlive-memory`), created on first start.
- Optional: the separate read-only panel `@jjh32456/dsh-longlive-panel@1.8.0` adds a sidebar named **潜望镜 (Periscope)**. The plugin itself ships no UI.
- **On by default since 1.8.0** (write side + real-time injection; added in 1.6.8): `sharedBrain.activity` writes activity rows from events (throttled to one row per key per 10 s, plus a conclusion row per turn/end) to `.longlive/board/activity.jsonl` and injects only unseen rows from other sessions (max 5 rows / 300 chars, zero tokens when nothing is new). It is independent of `presenceBus`; opt out with `sharedBrain.activity.enabled: false` and restart. All data stays in the local memoryRoot and is never uploaded.
- **On by default since 1.8.0** (set `false` to disable): `d2.enabled` trims oversized tool output (the full text is archived), `d6.enabled` freezes a per-task tool allowlist and registers `tool_search`. See [docs/FEATURES.md](docs/FEATURES.md) and [docs/CONFIG.md](docs/CONFIG.md) for enabling, budget and rollback.

## Install (3 commands)

```powershell
$DSH  = '<DSH install>\resources\runtime\cli\bin\dsh.cmd'
$NODE = '<DSH install>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
& $DSH plugin --profile desktop add "file:<path>/jjh32456-dsh-longlive-1.8.3.tgz"
& $DSH plugin --profile desktop list --depth 0
& $NODE "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@jjh32456\dsh-longlive\scripts\longlive-doctor.mjs" --profile desktop
```

The commands above call `& $DSH` directly (the `dsh.cmd` path set above); if `dsh` is already on PATH you can drop the `& $DSH` prefix.

Fully quit and restart the host afterwards. Install from the local tgz with `plugin add`; do not use `npm install`.

## First run

1. Watch it: `autoTruncate` is on by default since 1.8.0; set `mode: "log"` and watch `<memoryRoot>/.longlive/logs/auto-truncate.log`; entries appear only after the threshold (default 300000) is exceeded.
2. Switch to `mode: "dryrun"` with `tokensThreshold: 5000`, `minTurns: 2`, and watch one planned cut (`"action":"dryrun-planned"`).
3. Switch to `mode: "request"`, wait for `auto-truncate.request.json`, then run `scripts/auto-truncate-run.ps1` **only when you are not using the app** (it closes and reopens the host).
4. Restore production values: `tokensThreshold: 300000`, `minTurns: 12`, `cooldownMinutes: 60`, `keepTurns: 12`, `keepTokens: 80000`.

## Read next

- [QUICKSTART.md](docs/QUICKSTART.md) — install to first truncation, with rollback.
- [CONCEPTS.md](docs/CONCEPTS.md) — tokens, compaction, two kinds of truncation, L1–L6, `on` mode.
- [FAQ.md](docs/FAQ.md) — 401/404, power loss, uninstall, moving machines.
- [README.md](README.md) — full Chinese introduction.

## Privacy & identity (1.8.0)

- Built-in identity is **neutral by default** in 1.8.0: no personal names or roles ship in the release. Define your own identity in `<memoryRoot>/IDENTITY.md`; when absent, a neutral default is used. Distillation's `who` defaults to empty and is injected only from your configuration.
- Shared-brain activity is **on by default since 1.8.0**: it writes and injects only inside your local memoryRoot and uploads nothing; opt out with `sharedBrain.activity.enabled: false` and restart.
- Shared-brain thinking is **on by default since 1.8.0, summary-level**: it injects summaries from other sessions only (no raw text, no logs), and reuses the privacy gate (`local_only` content is never written or injected); set `sharedBrain.thinkingInjection.enabled: false` to disable.
- The release package carries no memory store, session logs or machine paths; packaging runs an absolute-path/privacy scan and **0 blockers is a release gate**.
- Details: [docs/PRIVACY.md](docs/PRIVACY.md).

## Boundaries

- It never rewrites memory prose or deletes sessions/cards. `memory_reinforce` updates frontmatter counters and appends a use note; prose is byte-verified unchanged. `memory_forget` archives by default.
- Backup, both truncations, and forget default to `dryRun` and need their confirm word; `session_compact` is controlled by `dryRun` only. Auto-truncation, router features and other plugin features default to on in 1.8.0 (explicit `false` disables); the confidence gate (`answerGuard.gate`) and a few safety/gray switches default to off.
- `request` mode (close/cut/verify/restart) is Windows-only; on Linux/macOS use `log` or `dryrun`.
- **Portability**: node is resolved through `process.execPath`, no absolute machine paths are baked in, and a clean `DSH_HOME` can install and run the package (Gate-4).
- **Quality gate**: Gate-3 uses the human-mechanism-calibrated criteria `GATE3-CRITERIA-V2` (v2.1, sha256 `40A2C62D2CD07DA1D36C6B9211427A9496A0BD525F4E0862ED21AE94BA318D6D`, (criteria file archived with release evidence, not shipped)); the old criteria remain as a dual-caliber comparison.
