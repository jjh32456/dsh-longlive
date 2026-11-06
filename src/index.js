// @local/dsh-longlive — plugin entry
//
// Session longevity for DeepSeek Harness. Registers twenty-two tools:
//   session_health / session_backup / session_truncate / session_truncate_visible /
//     session_compact — dry-run by default, write nothing until asked with a confirm word;
//   session_wake / lease_acquire / lease_release —
//     the wake-up kit over the memory store (same resolver as memory_* below:
//     memoryRoot / memRoot → $DSH_LONGLIVE_MEMORY_ROOT → legacy $DSH_MEM →
//     <DSH home>/longlive-memory);
//   memory_index / memory_consolidate / memory_reinforce / memory_forget /
//     memory_procedure / memory_recall —
//     the v0.4 memory layer, which only touches the configured memory root
//     (since 0.7.3 an unset root derives to <DSH home>/longlive-memory;
//     `strictMemoryRoot: true` restores the old "unset root is an error" mode);
//     memory_recall (0.8.0) is read-only hybrid search over topics/ and journal/,
//     and locked cards are immune to forget moves and consolidate merges;
//   session_live_update / session_live_list / session_live_get /
//     session_live_prune — the v0.5 "正在" live session registry under
//     <memoryRoot>/.longlive/live, one atomic JSON row per session.
//
// 0.7.3 makes the package portable: no drive-letter default, one memory-root
// resolver for both families, a runtime engines.dsh check that warns and
// degrades instead of crashing, and platform notes in the docs.
//
// 0.7.1 fixes who counts as the user: carryFirstUserMessage and the archive
// card only accept a host-confirmed user-authored message (`source.kind` is
// "user" AND the client stamped `clientTimeZone`), never the surgical
// checkpoint or a runtime-context/skill-catalog block. It also adds automatic
// visible truncation at `turn/end` (`autoTruncate`: log / dryrun / request,
// default log, 300k tokens, 12 turns, 60-minute per-session cooldown). Request
// mode only writes `auto-truncate.request.json`; the session log is cut outside
// the app, after it exits (0.7.0's in-app apply corrupted a running session).
//
// 0.6.0 adds whole-turn visible truncation. On startup it also finishes or
// rolls back any `.truncate-visible-inflight.json` left by a crash.
//
// 0.5.1 adds auto-binding and auto-heartbeat:
//   - identity comes from the tool execution's explicit `exec.agent` (route 1
//     in identity.js), so `session_live_update` needs no sessionId argument;
//   - a bound row is refreshed on `session/event` turn boundaries and by an
//     unref'd `heartbeatMs` timer (default 15 s; 0 disables automatic writes).
// Startup writes no session log and no live row. It may create the derived
// default memory directory (<DSH home>/longlive-memory) so the memory tools
// work out of the box; an explicitly configured root is never created here.

import fs from 'node:fs';
import path from 'node:path';
import { registerTools, dshHome, TOOLS } from './tools.js';
import { resolveCurrentSessionId } from './identity.js';
import { createAutoHeartbeat, DEFAULT_HEARTBEAT_MS } from './heartbeat.js';
import { sweepInflight } from './truncate-visible.js';
import { checkSurgeryOnStart, receiptText } from './surgery-recovery.js';
import { createAutoTruncator } from './auto-truncate.js';
import { VERSION } from './version.js';
import { memoryRootSetting, defaultMemoryRoot } from './memory/paths.js';
import { checkHostCompatibility, declaredHostRange, detectHostVersion, warnOnce } from './host-version.js';
import { recordEngineStatus } from './engine-status.js';
import { configurePolicyProfile } from './policy-profile.js';
import { createRouterRuntime, createRouterService, createRouterTools, normalizeRouterConfig } from './router/runtime.js';
import { createRouterFace, normalizeFaceConfig } from './router/face/index.mjs';
import { registerFeatures } from './features.js';
import { createConclusionBridge } from './conclusion.js';
import { checkOptionalDeps, formatMissingDepsWarning } from './deps.js';
import { scheduleFilterRun } from './memory/filter-runner.js';
import { registerMetrics } from './metrics/index.mjs';
import { registerToolOutputTrim } from './tool-output.js';
import { registerD6 } from './d6/runtime.js';
import { registerUiRoutes } from './ui/routes.js';

export const name = 'dsh-longlive';
export const inject = ['tools'];
/** The engines.dsh range this build was tested against (also in package.json). */
export const HOST_RANGE = declaredHostRange();
// Host-visible schema (optional: undefined when the schemastery peer is absent).
// Declaring it lets the Cordis loader validate a row's config at activation;
// see src/config.js for why the advanced router keys stay passthrough.
export { Config } from './config.js';

/**
 * Resolve the memory root once, at load time, for the pieces that need it
 * (heartbeat, auto-truncation, the live registry). Never throws: a bad or
 * missing explicitly configured root is a warning here and a coded error from
 * the tool that actually needs it — loading the plugin must not crash.
 */
function startupMemoryRoot(ctx, config, env = process.env) {
  const setting = memoryRootSetting(config, env);
  if (!setting.explicit) {
    if (setting.strict) {
      warnOnce(ctx, 'memoryRoot 未配置且 strictMemoryRoot 已开启 — memory_* 工具会返回 ' +
        'E_MEMORY_ROOT_UNSET；设置 memoryRoot 或 DSH_LONGLIVE_MEMORY_ROOT 后重启宿主。');
      return null;
    }
    const derived = defaultMemoryRoot(config, env);
    try {
      fs.mkdirSync(derived, { recursive: true });
      return derived;
    } catch (error) {
      warnOnce(ctx, `无法创建默认记忆根目录 ${derived}（${error?.code ?? error?.message}）— ` +
        'memory_* / live_* / autoTruncate 会降级；请检查写权限或显式设置 memoryRoot。');
      return null;
    }
  }
  const root = path.resolve(setting.explicit);
  let ok = false;
  try {
    ok = fs.statSync(root).isDirectory();
  } catch {
    ok = false;
  }
  if (!ok) {
    warnOnce(ctx, `记忆根目录 ${root}（来源 ${setting.source}）不存在或不是目录 — ` +
      '需要它的工具会返回 E_MEMORY_ROOT_MISSING；先创建该目录，或修正 memoryRoot。');
  }
  return root;
}

export function apply(ctx, config = {}) {
  const home = config.home ?? dshHome();

  // 0.8.0-rc.10: optional peers are advisory. A profile without engram loses
  // only engram_* / memory_save; the twenty-two longlive tools and truncation
  // must keep working. This check is read-only, never throws, and never blocks
  // activation. The one line points at the --setup wizard and says it asks
  // first; startup itself never installs anything.
  try {
    const optional = checkOptionalDeps({
      home,
      env: config.env ?? process.env,
      profile: config.profile,
    });
    const warning = formatMissingDepsWarning(optional.missing);
    if (warning) warnOnce(ctx, warning);
  } catch (error) {
    // An optional-dependency check must never be the reason a plugin fails to load.
    warnOnce(ctx, `可选依赖自检失败（${error?.message ?? error}）— 跳过自检，插件继续加载。`);
  }

  // engines.dsh is a declaration, not an enforcement: check it here, warn once,
  // keep loading. An undetectable host version is not a mismatch. Detection is
  // advisory, so even an unexpected proxy error must not fail activation: a
  // host that does not expose a version is a normal embedding, not a broken
  // installation (0.7.3 lost all 19 tools to one unguarded ctx.version read).
  let detection = { version: null, source: null };
  try {
    detection = detectHostVersion(ctx, config, config?.env ?? process.env);
  } catch (error) {
    warnOnce(ctx, `宿主版本探测失败（${error?.message ?? error}）— 跳过兼容性检查，插件继续加载。`);
  }
  const compat = checkHostCompatibility({
    version: detection.version,
    range: HOST_RANGE,
    pluginVersion: VERSION,
  });
  const detectionOrigin = detection.path
    ? `${detection.source ?? 'unknown'} (${detection.path})`
    : (detection.source ?? 'unknown');
  if (compat.warning) warnOnce(ctx, `${compat.warning}（检测来源：${detectionOrigin}）`);

  const memoryRoot = startupMemoryRoot(ctx, { ...config, home });

  // C1 (1.4.0): persist the verdict for the panel. Data only — the panel may
  // render a red dot from `engineMismatch` and does not need host logs. A
  // matching host clears a stale record. A missing/read-only memoryRoot, a
  // corrupt status file or a race is not a load failure: recordEngineStatus
  // never throws, and this extra guard keeps even an unforeseen bug advisory.
  try {
    recordEngineStatus(memoryRoot, { compat, detection, now: config.now });
  } catch (error) {
    warnOnce(ctx, `engines.dsh 自检状态写入失败（${error?.message ?? error}）— 不影响加载。`);
  }

  // R1 路由策略：默认 generic（通用原则）；宿主可配 routerPolicyProfile 指向
  // src/router/policies/<name>.json 叠加家规（只许收窄，不许放宽 fail-closed）。
  // 未知/损坏 profile 不抛：这里只警告，route() 自己会 fail-closed。
  const policyProfile = configurePolicyProfile(config.routerPolicyProfile);
  if (!policyProfile.ok) {
    warnOnce(ctx, `routerPolicyProfile=${config.routerPolicyProfile} 不可用（${policyProfile.code}）：` +
      `${policyProfile.message} — 路由将 fail-closed。`);
  }

  // 0.7.1: automatic visible truncation. The truncator owns no listener; it is
  // invoked by the heartbeat's `session/event` feed at `turn/end` (one
  // evaluation per session per cooldown).
  const autoTruncator = createAutoTruncator({
    memoryRoot,
    home,
    autoTruncate: config.autoTruncate,
    now: config.now,
  });

  // R1 运行时适配器：1.6.0 安全默认改为 off（abuse assessment §4.1 / §4.5）。
  // 旧版默认 shadow 会把每次工具调用的参数摘要写进
  // <memoryRoot>/.longlive/router-runtime.jsonl；现在只有显式
  // routerRuntime='shadow'|'on' 才启用，shadowEnabled 仅作为旧配置的兼容位。
  // shadow 只判定+记录；on 仅对高风险写操作拒绝，只读调用永不拒绝（DESIGN.md §5）。
  // 构造失败不阻断插件加载：没有适配器就等于 off。
  const runtimeMode = config.routerRuntime ?? 'off';
  let routerRuntime = null;
  try {
    routerRuntime = createRouterRuntime({
      mode: runtimeMode,
      statePath: config.routerRuntimeStatePath,
      memoryRoot,
      maxRecords: config.routerRuntimeMaxRecords,
      // 1.2.0 影子页签要看全部工具调用，而不只是 memory_* 四个。
      recordAllTools: true,
      // Guard only takes the names this plugin does not register (memory_save).
      ownTools: TOOLS.map((tool) => tool.name),
      onError: () => warnOnce(ctx, `R1 记录写入失败（${config.routerRuntimeStatePath ?? '.longlive/router-runtime.jsonl'}）— ` +
        '判定照常，工具行为不受影响。'),
    });
    if (routerRuntime.modeInvalid) {
      warnOnce(ctx, `routerRuntime=${JSON.stringify(config.routerRuntime)} 不是 off/shadow/on — 已按 off 处理。`);
    }
    if (routerRuntime.enabled && !routerRuntime.statePath) {
      warnOnce(ctx, `routerRuntime=${routerRuntime.mode} 但没有可写的记忆根目录 — 判定会跑，记录会被丢弃。`);
    }
  } catch (error) {
    warnOnce(ctx, `R1 运行时适配器创建失败（${error?.message ?? error}）— 影子模式不可用，插件继续加载。`);
  }

  const heartbeat = createAutoHeartbeat({
    ctx,
    memoryRoot,
    // undefined -> 15 s; 0 (or invalid) -> no automatic writes at all.
    heartbeatMs: config.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    now: config.now,
    touch: config.touchLiveSession,
    onTurnEnd: autoTruncator.onTurnEnd,
  });

  // 1.1.0 RouterService（DESIGN §2.1）。默认关闭：routerEnabled=false 时既没有
  // service 对象，也没有定时器/监听器/目录/日志，注册表保持 22 个工具。
  // 构造只保存配置；start() 才碰文件系统。启动失败不阻断插件加载。
  let routerService = null;
  let routerTools = [];
  const routerConfig = normalizeRouterConfig({ ...config, memoryRoot });
  for (const warning of routerConfig.warnings) {
    warnOnce(ctx, `router 配置无效（${warning}）— 已回退默认值。`);
  }
  // Test hooks are a build seam, not a configuration switch. A production
  // build refuses them outright so they can never be enabled from config.
  if (config?.routerTestHooks !== undefined && process.env.LONGLIVE_ROUTER_TEST !== '1') {
    throw new Error('longlive router: routerTestHooks 只在测试构建可用（LONGLIVE_ROUTER_TEST=1）');
  }
  const testHooks = process.env.LONGLIVE_ROUTER_TEST === '1' ? config?.routerTestHooks : undefined;
  if (routerConfig.enabled) {
    try {
      routerService = createRouterService(ctx, routerConfig,
        testHooks ? { memoryRoot, testHooks } : { memoryRoot });
      routerTools = createRouterTools(routerService);
      if (typeof ctx?.effect === 'function') {
        try {
          ctx.effect(() => () => routerService.dispose(), 'longlive.router');
        } catch {
          /* no effect scope in a fake context */
        }
      }
      Promise.resolve(routerService.start()).catch((error) => {
        Promise.resolve(routerService.block(error?.code ?? 'E_START_FAILED', error)).catch(() => {});
      });
    } catch (error) {
      routerService = null;
      warnOnce(ctx, `router 启动失败（${error?.message ?? error}）— 已按关闭处理，插件继续加载。`);
    }
  }

  // 1.3.1+ routerFace（v1 后台面）。默认关闭；关闭时零定时器、零目录、零 IO。
  // 开启后它只读共享记忆、只写 journal 与 bridge outbox，不注册 turn 监听、
  // 不执行任何工具；任何失败只落 status，绝不影响前台 turn。
  let routerFace = null;
  const faceConfig = normalizeFaceConfig(config.routerFace, { memoryRoot });
  for (const warning of faceConfig.warnings) {
    warnOnce(ctx, `routerFace 配置无效（${warning}）— 已回退默认值。`);
  }
  if (faceConfig.enabled && memoryRoot) {
    try {
      routerFace = createRouterFace({ ctx, memoryRoot, config: faceConfig });
      if (typeof ctx?.effect === 'function') {
        try {
          ctx.effect(() => () => routerFace.dispose(), 'longlive.routerFace');
        } catch {
          /* no effect scope in a fake context */
        }
      }
      Promise.resolve(routerFace.start()).catch((error) => {
        warnOnce(ctx, `routerFace 启动失败（${error?.message ?? error}）— 已跳过，插件继续加载。`);
      });
    } catch (error) {
      routerFace = null;
      warnOnce(ctx, `routerFace 初始化失败（${error?.message ?? error}）— 已跳过，插件继续加载。`);
    }
  } else if (faceConfig.enabled && !memoryRoot) {
    warnOnce(ctx, 'routerFace 已启用但没有 memoryRoot — 已跳过。');
  }

  // D6 (opt-in, default off): trim the model-facing tool surface on the first
  // claimed user message, before preStep calls tools.resolve. Registering this
  // before registerTools matters: tool_search must be part of the registry the
  // host sees on that very first resolve, and must not be added later.
  let d6 = { enabled: false, tools: [] };
  if (config?.d6?.enabled === true) {
    try {
      d6 = registerD6(ctx, config);
    } catch (error) {
      warnOnce(ctx, `D6 注册失败（${error?.message ?? error}）— 已跳过，工具面保持全量。`);
    }
  }

  const registered = registerTools(ctx, {
    keepEvents: config.keepEvents ?? 20000,
    recentWriteWindowMs: config.recentWriteWindowMs ?? 60000,
    // Optional overrides (tests pass them explicitly; the host normally omits them).
    home,
    // Test seam: a suite can supply a fake defineTool and drive the real
    // registration path without the @deepseek-ai/dsh-tools peer installed.
    defineTool: config.defineTool,
    // One memory-store root for both families. `memRoot` remains an accepted
    // alias so an existing configuration keeps pointing at the same store.
    memRoot: memoryRoot,
    memoryRoot,
    // Resolve "this session" from the explicit caller Agent the host puts on
    // every tool execution (`exec.agent`), falling back to the agents service
    // and finally to legacy ctx guesses / DSH_SESSION_ID. `null` keeps the
    // existing explicit errors (`无法确定当前会话 id ...` / SESSION_NOT_FOUND).
    currentSessionId: (exec) => resolveCurrentSessionId({ ctx, exec }).id,
    // Every resolver path that had to fall back to "current" binds the id, so
    // turn events and the fallback timer can refresh exactly that row and no
    // other. Best effort by contract (see resolveSessionId in live.js).
    onAutoSessionId: (id) => heartbeat.bind(id),
    // Consumed by the tool wrapper: refresh on every longlive tool call.
    autoHeartbeat: heartbeat,
    // Consumed by the tool wrapper (intercept) and, when the host exposes
    // tools.guard, by the pre-execute hook for tools registered elsewhere.
    routerRuntime,
    // Only present when routerEnabled=true; registerTools appends the four
    // router_* tools from it and otherwise registers exactly the 0.9.0 set.
    routerTools,
    // Only present when config.d6.enabled=true; appended after the normal set
    // so the frozen allowlist can name it without changing the baseline order.
    d6Tools: d6.tools,
    // 1.6.0 safety default: worker_spawn/worker_status/worker_kill are visible
    // in the baseline tool table but return "unavailable" until this is true.
    workers: config.workers,
  });

  heartbeat.start();

  // 1.2.0 记忆准入过滤器：启动后异步跑一次（unref 定时器，不阻塞加载），
  // 只读 journal/*.md 与卡片目录，只写 <memoryRoot>/.longlive/filter/。
  // 任何异常都只是 warning；filterEnabled=false 时连定时器都不创建。
  if (config.filterEnabled !== false && memoryRoot) {
    try {
      scheduleFilterRun(memoryRoot, {
        logger: (message) => warnOnce(ctx, message),
        now: config.now,
      });
    } catch (error) {
      warnOnce(ctx, `memory filter 启动失败（${error?.message ?? error}）— 已跳过，不影响工具。`);
    }
  }

  // A crash between tmp-write and rename leaves a record. Startup is the one
  // moment nothing is writing, so finish or roll it back before any tool runs.
  if (config.recoverOnStart !== false) {
    try {
      sweepInflight(home);
    } catch {
      /* recovery is best effort; the tool still reports any record it finds */
    }
  }

  // 0.9.0-rc.2: unattended-surgery post-mortem. When no stage file exists this
  // is one `existsSync` and nothing else — no read, no log, no hook. A finished
  // (`phase: "done"`) receipt is skipped too. The check itself is read-only for
  // the session; at most it writes one report plus one audit line. `config.
  // surgeryRecovery: false` turns it off for a frozen deployment.
  //
  // When the launcher could not write its visible receipt (failed or crashed
  // run, or an older state file), carry the same text into the first turn so
  // the operator still sees the verdict in the conversation body.
  let surgeryReceipt = null;
  if (config.surgeryRecovery !== false && memoryRoot) {
    try {
      const surgery = checkSurgeryOnStart({
        memoryRoot,
        loadedVersion: VERSION,
        loadedHostVersion: detection.version,
      });
      if (surgery.checked && surgery.report) {
        const written = surgery.report.checks?.receiptWritten === true;
        if (!written) {
          surgeryReceipt = receiptText(surgery.report, { appendingReceipt: false });
        }
        if (surgery.report.classification === 'needs-attention') {
          warnOnce(ctx, `上次无人值守手术需要人工核对（${surgery.report.reasonCode}）：` +
            `${surgery.report.recommendation}`);
        }
      }
    } catch (error) {
      // A post-mortem is evidence, never a reason the plugin fails to load.
      warnOnce(ctx, `手术恢复自检失败（${error?.message ?? error}）— 已跳过，不影响插件加载。`);
    }
  }
  if (typeof ctx?.effect === 'function') {
    try {
      // Plugin lifetime owns the timer and the session/event listener; Cordis
      // runs this disposer when the plugin is unloaded.
      ctx.effect(() => () => heartbeat.stop(), 'longlive.auto-heartbeat');
    } catch {
      /* no effect scope in a test/fake context: process lifetime is fine */
    }
  }
  // A1 (opt-in, default off): conclusion write-back. At every turn/end with
  // reason=completed the bridge checks the turn's last real user message plus
  // the assistant's final text blocks with local trigger rules only — no model
  // call — and writes one card under topics/ plus a session marker under
  // .longlive/bridge/ (also the source A2's board reads). Failures are silent
  // by construction and never block the turn.
  const conclusionBridge = createConclusionBridge({
    enabled: config.autoConclusion === true,
    memoryRoot,
    now: config.now,
  });
  if (conclusionBridge.enabled) {
    let disposeConclusion = null;
    try {
      disposeConclusion = ctx.on('session/event', (session, event) => {
        conclusionBridge.onSessionEvent(session, event);
      });
    } catch (error) {
      warnOnce(ctx, `结论回流监听注册失败（${error?.message ?? error}）— 已跳过。`);
    }
    if (typeof disposeConclusion === 'function' && typeof ctx?.effect === 'function') {
      try {
        ctx.effect(() => () => disposeConclusion(), 'longlive.conclusion');
      } catch {
        /* fake context without an effect scope */
      }
    }
  }
  // 0.9.0-rc.1 opt-in features. Every switch defaults to off, in which case
  // this call registers nothing, reads nothing and logs nothing.
  registerFeatures(ctx, config, { memoryRoot, surgeryReceipt });

  // D1/D4: measure-only working-set ledger.  Never trims, never throws; a
  // missing memoryRoot simply disables the recorder.
  registerMetrics(ctx, config, { memoryRoot });

  // D2 (opt-in, default off): trim oversized tool results at the host's
  // `tools/post-execute` waterfall and archive the full text under
  // `<memoryRoot>/.longlive/tool-output/<turn>/<id>.txt` — the same path D3's
  // session_original plans. Registration failure or a missing root is a
  // warning, never a load failure; an enabled-but-broken trim stays fail-open
  // inside the listener.
  try {
    registerToolOutputTrim(ctx, config, { memoryRoot });
  } catch (error) {
    warnOnce(ctx, `工具输出裁剪注册失败（${error?.message ?? error}）— 已跳过，工具结果保持原文。`);
  }

  // Settings panel: the browser companion registers `plugins.row.config` and
  // calls this same-origin route. The route writes through the Host's
  // `configEditor`, so a switch lands in the profile patch and the ordinary
  // Loader reconciliation reloads this entry with the new value. Profiles
  // without a Web server simply get no route; activation never depends on it.
  try {
    registerUiRoutes(ctx, { config, memoryRoot, rowId: 'session-longlive' });
  } catch (error) {
    warnOnce(ctx, `设置面板接口注册失败（${error?.message ?? error}）— 面板将显示不可用，插件继续加载。`);
  }

  return registered;
}
