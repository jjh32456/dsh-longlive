# @jjh32456/dsh-longlive (Longlive)

A DeepSeek Harness plugin that keeps a long session healthy: **inspect it, back it up, and shrink it safely** before the context window fills up. No standalone panel; no network requests or telemetry in the default configuration (Router / RouterFace / embedding call the provider you configure, only after you enable them).
## What you get

- **22 tools** for session health/backup/compaction/truncation, on-demand original-text fetch, memory cards, workers (fan-out is unavailable until `workers.enabled: true`), and the live-session registry.
- A built-in settings-page companion: `plugins.row.config` under `@jjh32456/dsh-longlive#session-longlive` with seven feature switches (D2/D6/auto-recall/presence bus/background face/daily maintenance/Router). Profiles without a Web server simply get no route.
- A memory store at `<DSH home>/longlive-memory` (on Windows: `%USERPROFILE%\.dsh\longlive-memory`), created on first start.
- Optional: the separate read-only panel `@jjh32456/dsh-longlive-panel@0.2.5` adds a sidebar named **潜望镜 (Periscope)**. The plugin itself ships no UI.
- Optional and **off by default**: `d2.enabled` trims oversized tool output (the full text is archived), `d6.enabled` freezes a per-task tool allowlist and registers `tool_search`. See [FEATURES.md](FEATURES.md) and [CONFIG.md](CONFIG.md) for enabling, budget and rollback.

## Install (3 commands)

```powershell
$DSH  = '<DSH install>\resources\runtime\cli\bin\dsh.cmd'
$NODE = '<DSH install>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
& $DSH plugin --profile desktop add "file:C:/path/jjh32456-dsh-longlive-1.6.7.tgz"
& $DSH plugin --profile desktop list --depth 0
& $NODE "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@jjh32456\dsh-longlive\scripts\longlive-doctor.mjs" --profile desktop
```

The commands above call `& $DSH` directly (the `dsh.cmd` path set above); if `dsh` is already on PATH you can drop the `& $DSH` prefix.

Fully quit and restart the host afterwards. Install from the local tgz with `plugin add`; do not use `npm install`.

## First run

1. Opt into observation: `autoTruncate` is off by default in 1.6.0, so set `enabled: true` and `mode: "log"`, then watch `<memoryRoot>/.longlive/logs/auto-truncate.log`; entries appear only after the threshold (default 300000) is exceeded.
2. Switch to `mode: "dryrun"` with `tokensThreshold: 5000`, `minTurns: 2`, and watch one planned cut (`"action":"dryrun-planned"`).
3. Switch to `mode: "request"`, wait for `auto-truncate.request.json`, then run `scripts/auto-truncate-run.ps1` **only when you are not using the app** (it closes and reopens the host).
4. Restore production values: `tokensThreshold: 300000`, `minTurns: 12`, `cooldownMinutes: 60`, `keepTurns: 12`, `keepTokens: 80000`.

## Read next

- [QUICKSTART.md](QUICKSTART.md) — install to first truncation, with rollback.
- [CONCEPTS.md](CONCEPTS.md) — tokens, compaction, two kinds of truncation, L1–L6, `on` mode.
- [FAQ.md](FAQ.md) — 401/404, power loss, uninstall, moving machines.
- [README.md](../README.md) — full Chinese introduction.

## Boundaries

- It never rewrites memory prose or deletes sessions/cards. `memory_reinforce` updates frontmatter counters and appends a use note; prose is byte-verified unchanged. `memory_forget` archives by default.
- Backup, both truncations, and forget default to `dryRun` and need their confirm word; `session_compact` is controlled by `dryRun` only. Auto-truncation defaults to `log`; the router guard defaults to `off`.
- `request` mode (close/cut/verify/restart) is Windows-only; on Linux/macOS use `log` or `dryrun`.
