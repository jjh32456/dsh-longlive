#!/usr/bin/env node
/**
 * scripts/acceptance-1.8.11.mjs — 1.8.11 lifecycle / 网络层 结构化验收（SPEC-1.8.11 §3）
 *
 * 五例 + 负例 + 迁移（dry-run / apply / rollback），全部用真实记忆卡跑：
 *   e1 六轨旧卡：现行查询 canonical rank=0、旧句不注入；历史查询放行 historical 且带「历史口径」
 *   e2 听澜命名：conflicts_with 边证据在注入文本里；非历史查询不用旧转述
 *   e3 贝贝妈妈未记录卡：全库无该结论，查询不得假装「已记录」
 *   e4 五问 derived_from：边证据可核，excerpt 含五问指定句
 *   e5 当前六轨：基线通过 + 注入层不得回退
 *   e6 工具层（D9）：memoryRecall / memory_recall_v2 对 historical 降权，显式历史查询不降权
 *   e7 迁移：plan 只读 / dry-run 四下游 / 副本 apply / rollback 逐字节等价 / 真库指纹未变
 *   n1..n4 负例：伪造边不注入、预算截断、非历史查询排除 historical 正文、status 枚举零改动
 *
 * 真库（默认 C:\Users\Administrator\.dsh\longlive-memory）全程只读；apply/rollback 只在临时副本。
 * 输出 JSON（每例 pass + 断言 expected/actual/ref + 输入 sha256）；exit 0 仅当全部通过。
 *
 * 用法：
 *   node scripts/acceptance-1.8.11.mjs [--memory-root <dir>] [--plan <lifecycle-plan.json>]
 *        [--copy-root <.tmp-test/acceptance-copy>] [--out <.tmp-test/acceptance-1.8.11.json>]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { memoryRecall, scoreCard } from '../src/memory/recall.js';
import { recallV2 } from '../src/memory/recall-v2.js';
import { scanCards } from '../src/memory/index.js';
import { sha256File, sha256Text } from '../src/memory/state.js';
import { CARD_STATUSES, parseStatus } from '../src/memory/frontmatter.js';
import {
  LIFECYCLE_VALUES,
  lifecycleRank,
  readCardLifecycle,
} from '../src/memory/lifecycle.js';
import { loadEdges } from '../src/recall/edges.js';
import { estimateTokens } from '../src/recall/recall-core.mjs';
import { apply as applyRecall } from '../src/recall/index.js';
import {
  LIFECYCLE_INDEX_BEGIN,
  applyLifecycleMigration,
  copyMemoryRootForDryRun,
  dryRunLifecycleMigration,
  loadLifecyclePlan,
  planLifecycleMigration,
  rollbackLifecycleMigration,
  verifyAppliedMigration,
} from '../src/memory/migrate-lifecycle.js';
import { PreStepBus, makeUserMessageFactory, textMessage, noopLogger } from '../test/fixtures/pre-step-container.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const SCHEMA = 'acceptance-1.8.11/v1';

// ---------- CLI ----------

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    if (eq >= 0) {
      args[raw.slice(2, eq)] = raw.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[raw.slice(2)] = next;
      i += 1;
    } else {
      args[raw.slice(2)] = true;
    }
  }
  return args;
}

const ARGS = parseArgs(process.argv);
const MEMORY_ROOT = path.resolve(
  ARGS['memory-root'] || process.env.DSH_LONGLIVE_MEMORY_ROOT || path.join(os.homedir(), '.dsh', 'longlive-memory'),
);
const PLAN_PATH = path.resolve(ARGS.plan || path.join(PKG, 'src', 'memory', 'lifecycle-plan.json'));
const COPY_ROOT = path.resolve(ARGS['copy-root'] || path.join(PKG, '.tmp-test', 'acceptance-copy'));
const OUT_PATH = path.resolve(ARGS.out || path.join(PKG, '.tmp-test', 'acceptance-1.8.11.json'));
const DRYRUN_COPY = path.join(path.dirname(COPY_ROOT), 'acceptance-dryrun-copy');

// ---------- 小工具 ----------

const now = new Date();
let preStepSeq = 0;
let msgSeq = 0;

function rel(root, p) {
  return path.relative(root, p).split(path.sep).join('/');
}

function absOf(root, p) {
  return path.isAbsolute(p) ? p : path.resolve(root, p);
}

function readText(root, p) {
  return fs.readFileSync(absOf(root, p), 'utf8');
}

function exists(root, p) {
  return fs.existsSync(absOf(root, p));
}

function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** 宽容读 frontmatter 块里的单行字段（不触发 E_FRONTMATTER_MULTILINE）。 */
function frontmatterField(text, key) {
  const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(String(text ?? ''));
  if (!block) return null;
  const line = new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(block[1]);
  return line ? line[1].trim() : null;
}

function statusOfText(text) {
  return frontmatterField(text, 'status') ?? 'active';
}

function titleOfText(text) {
  const raw = frontmatterField(text, 'title');
  if (raw === null) return '';
  // frontmatter 里的 title 可能是带引号的 YAML 标量；注入渲染用的是去引号后的标题。
  const m = /^(["'])([\s\S]*)\1$/.exec(raw.trim());
  return m ? m[2].replace(/\\(["'])/g, '$1') : raw.trim();
}

/** frontmatter 之后的正文（用于证明迁移对正文零改动）。 */
function bodyOfText(text) {
  const src = String(text ?? '');
  const match = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/.exec(src);
  return match ? src.slice(match[0].length) : src;
}

/** body 第一行在整份文件里的 0-based 下标（无 frontmatter 为 0）。 */
function bodyStartLineIndex(text) {
  const match = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/.exec(String(text ?? ''));
  if (!match) return 0;
  return match[0].split(/\r?\n/).length - 1;
}

/**
 * 按「body 内行号」取整份文件里的那一行。R12-R2 P0：迁移会给无 frontmatter 的卡
 * 新增 3 行 frontmatter，body 行号会整体后移；验收必须按 body 语义取行，不能按文件行号。
 */
function lineAtPlanLine(text, planLine) {
  const src = String(text ?? '');
  const lines = src.split(/\r?\n/);
  return lines[bodyStartLineIndex(src) + planLine - 1];
}

/**
 * R12-R2 P1：plan 的行号是「迁移前整份文件」的 1-based 行号。迁移后只有原本无 frontmatter
 * 的卡会在头部新增 3 行，因此换算成 migration 后文件行号 = planLine + (postBodyStart - preBodyStart)。
 */
function lineAtPlanLineAfter(postText, planLine, preText) {
  const shift = bodyStartLineIndex(postText) - bodyStartLineIndex(preText);
  const lines = String(postText ?? '').split(/\r?\n/);
  return lines[planLine - 1 + shift];
}

/** frontmatter 里出现的键名（按出现顺序；用于断言「只新增 lifecycle、不注入默认字段」）。 */
function frontmatterKeysOfText(text) {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(String(text ?? ''));
  if (!match) return [];
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const at = line.indexOf(':');
      return at < 0 ? line : line.slice(0, at).trim();
    });
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function shaOfFileOrNull(file) {
  try {
    return sha256File(file);
  } catch {
    return null;
  }
}

/** 宿主/其他代理在验收运行期间也可能写的活状态文件：单独记 volatile，不计入「本包是否写脏真库」核心判据。 */
const REAL_ROOT_VOLATILE = new Set(['.longlive/memory-state.json', '.longlive/audit.log']);

/** 真库指纹：只涵盖本包可能触碰的文件（cards + INDEX/STATE + .longlive 状态 + recall 索引）。 */
function snapshotRealRoot(root) {
  const files = new Map();
  const add = (abs) => {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return;
    files.set(rel(root, abs), sha256File(abs));
  };
  for (const name of ['INDEX.md', 'STATE.md']) add(path.join(root, name));
  for (const dir of ['topics', 'journal', 'procedures', 'handover']) {
    const base = path.join(root, dir);
    if (!fs.existsSync(base)) continue;
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const abs = path.join(current, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (entry.isFile() && entry.name.endsWith('.md')) add(abs);
      }
    };
    walk(base);
  }
  for (const p of [
    '.longlive/memory-state.json',
    '.longlive/audit.log',
    '.longlive/manifest.json',
    '.longlive/index-freshness.json',
    '.longlive/recall/links.jsonl',
    '.longlive/recall/links-audit.jsonl',
    '.longlive/recall/edges.jsonl',
  ]) add(path.join(root, p));
  const sorted = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const digest = sha256Text(JSON.stringify(sorted));
  const coreDigest = sha256Text(JSON.stringify(sorted.filter(([file]) => !REAL_ROOT_VOLATILE.has(file))));
  return { files: new Map(sorted), checked: sorted.length, digest, coreDigest };
}

function diffSnapshots(before, after) {
  const changed = [];
  for (const [file, sha] of before.files) {
    if (after.files.get(file) !== sha) changed.push(file);
  }
  for (const file of after.files.keys()) {
    if (!before.files.has(file)) changed.push(file);
  }
  return changed;
}

// ---------- 断言 ----------

function assertion(id, expected, actual, pass, ref) {
  return { id, expected, actual, pass: pass === true, ref };
}

function withTry(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error: { code: error.code ?? 'E_ERROR', message: error.message } };
  }
}

async function withTryAsync(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: { code: error.code ?? 'E_ERROR', message: error.message } };
  }
}

// ---------- 真实链路：前置注入 / 工具层召回 ----------

async function preStepTurn(root, query, { budget } = {}) {
  const bus = new PreStepBus();
  bus.sessionId = `acc-${process.pid}-${(preStepSeq += 1)}`;
  applyRecall(
    { on: bus.on.bind(bus), logger: noopLogger() },
    // 1.8.11 D7（红队 R11 P1-2）：生产默认 dirs = topics + handover；验收必须用生产口径，
    // 不许用 dirs:['topics'] 的窄口径掩盖 handover 旧口径卡。
    { memoryRoot: root, createUserMessage: makeUserMessageFactory('acc'), dirs: ['topics', 'handover'], log: false, ...(budget ? { budget } : {}) },
  );
  msgSeq += 1;
  const out = await bus.compose({
    messages: [textMessage(query, { id: `acc-u${msgSeq}` })],
    agent: { session: { id: bus.sessionId, header: { origin: 'main' } } },
    turn: 2,
    step: 1,
  });
  const injected = (out.decision?.messages ?? []).filter((m) => m?.source?.form === 'recall');
  const text = injected.map((m) => (m.content ?? []).map((c) => c.text ?? '').join('\n')).join('\n');
  const titles = [...text.matchAll(/^- 《([^》]+)》/gm)].map((m) => m[1]);
  return { ok: true, query, tokens: estimateTokens(text), titles, text, injectedCount: injected.length };
}

function toolRecall(query, root = MEMORY_ROOT) {
  const result = memoryRecall({ query, topK: 5 }, { memoryRoot: root });
  return {
    ok: result?.ok === true,
    query,
    count: result?.results?.length ?? 0,
    results: (result?.results ?? []).map((item) => ({ path: item.path, title: item.title, score: item.score, lifecycle: item.lifecycle ?? null, excerpt: item.excerpt })),
  };
}

function containsEither(text, needles) {
  const hay = collapse(text);
  return needles.filter((needle) => hay.includes(collapse(needle)));
}

// ---------- 主流程 ----------

async function main() {
  const startedAt = new Date();
  const result = {
    schema: SCHEMA,
    startedAt: startedAt.toISOString(),
    node: process.version,
    cwd: process.cwd(),
    memoryRoot: MEMORY_ROOT,
    planPath: PLAN_PATH,
    copyRoot: COPY_ROOT,
    lifecycles: { LIFECYCLE_VALUES, CARD_STATUSES },
    inputsSha256: null,
    migration: null,
    realRootUntouched: null,
    cases: [],
    negatives: [],
    summary: { total: 0, passed: 0, failed: 0 },
    knownBoundaries: [],
    errors: [],
  };

  const caseRec = (id, title, baseline, assertions, extra = {}) => ({
    id,
    title,
    baseline,
    pass: assertions.every((item) => item.pass === true),
    inputSha256: result.inputsSha256,
    assertions,
    ...extra,
  });

  // 0) 环境与输入 -------------------------------------------------------
  if (!fs.existsSync(MEMORY_ROOT)) throw new Error(`真库不存在：${MEMORY_ROOT}`);
  const planInfo = loadLifecyclePlan(PLAN_PATH);
  const plan = planInfo.plan;
  const planSha256 = planInfo.sha256;

  const SRC = {
    sixStem: 'topics/six-stem-drop-2026-11-25.md',
    arrangement: 'topics/arrangement.md',
    musicLibrary: 'topics/music-library.md',
    people: 'topics/people.md',
    fiveQuestions: 'topics/friend-agent-five-questions.md',
    pluginProfile: 'topics/plugin-profile.md',
    bootOld: 'topics/boot-slow-2026-11-06.md',
    bootRoot: 'topics/boot-slow-root-cause-2026-11-08.md',
    // 红队 R11 P1-2：生产召回默认 dirs 含 handover，验收必须把这些卡也覆盖进来。
    handoverOld: 'handover/2026-11-08-评分器v0红队返工.md',
    handoverV14: 'handover/2026-11-12-v1.4冻结等红队.md',
  };
  const inputFiles = ['INDEX.md', ...Object.values(SRC)];
  const inputShas = {};
  for (const file of inputFiles) inputShas[file] = shaOfFileOrNull(path.join(MEMORY_ROOT, file));
  result.inputsSha256 = sha256Text(JSON.stringify({ planSha256, files: inputShas }));
  result.inputShas = inputShas;

  const real = {
    sixStem: readText(MEMORY_ROOT, SRC.sixStem),
    arrangement: readText(MEMORY_ROOT, SRC.arrangement),
    musicLibrary: readText(MEMORY_ROOT, SRC.musicLibrary),
    people: readText(MEMORY_ROOT, SRC.people),
    fiveQuestions: readText(MEMORY_ROOT, SRC.fiveQuestions),
    pluginProfile: readText(MEMORY_ROOT, SRC.pluginProfile),
    bootOld: readText(MEMORY_ROOT, SRC.bootOld),
    bootRoot: readText(MEMORY_ROOT, SRC.bootRoot),
    handoverOld: readText(MEMORY_ROOT, SRC.handoverOld),
    handoverV14: readText(MEMORY_ROOT, SRC.handoverV14),
    index: readText(MEMORY_ROOT, 'INDEX.md'),
  };
  const titles = {
    sixStem: titleOfText(real.sixStem),
    people: titleOfText(real.people),
    fiveQuestions: titleOfText(real.fiveQuestions),
  };
  const legacyTitles = {
    sixStem: plan.extracts.find((item) => item.id === 'six-stem-arrangement-65')?.targetCard?.title,
    naming: plan.extracts.find((item) => item.id === 'naming-people-70')?.targetCard?.title,
  };
  const oldSentenceA = plan.extracts.find((item) => item.id === 'six-stem-arrangement-65').quote;
  const oldSentenceB = plan.extracts.find((item) => item.id === 'six-stem-music-library-48').quote;
  const oldSentenceC = plan.extracts.find((item) => item.id === 'naming-people-70').quote;
  const handoverExtracts = {
    h08: plan.extracts.find((item) => item.id === 'six-stem-handover-11-08-line15'),
    h12: plan.extracts.find((item) => item.id === 'six-stem-handover-11-12-line43'),
  };
  const edgeQuotes = Object.fromEntries(plan.edges.map((edge) => [`${edge.from}|${edge.to}|${edge.type}`, edge.evidence.quote]));

  const snapshotBefore = snapshotRealRoot(MEMORY_ROOT);

  // 1) plan（真库只读） -------------------------------------------------
  const planRun = withTry(() => planLifecycleMigration({ memoryRoot: MEMORY_ROOT, plan, planSha256, now }));
  const planResult = planRun.ok ? planRun.value : null;

  // 2) 副本 apply -------------------------------------------------------
  const copy = { root: COPY_ROOT, apply: null, error: null, verified: null };
  if (fs.existsSync(COPY_ROOT)) fs.rmSync(COPY_ROOT, { recursive: true, force: true });
  const copyRun = withTry(() => {
    copyMemoryRootForDryRun({ memoryRoot: MEMORY_ROOT, destination: COPY_ROOT, now });
    return applyLifecycleMigration({ memoryRoot: COPY_ROOT, plan, planPath: PLAN_PATH, planSha256, now });
  });
  if (copyRun.ok) copy.apply = copyRun.value;
  else copy.error = copyRun.error;

  // 3) 副本迁移结果核验 -------------------------------------------------
  if (copy.apply) {
    copy.verified = withTry(() => {
      const cards = {};
      for (const item of copy.apply.applied.cards) {
        const text = readText(COPY_ROOT, item.rel);
        cards[item.rel] = {
          lifecycle: readCardLifecycle(absOf(COPY_ROOT, item.rel)),
          statusBefore: statusOfText(readText(MEMORY_ROOT, item.rel)),
          statusAfter: statusOfText(text),
          bodyBefore: bodyOfText(readText(MEMORY_ROOT, item.rel)),
          bodyAfter: bodyOfText(text),
          rank: lifecycleRank(item.rel, { memoryRoot: COPY_ROOT }),
        };
      }
      const targets = copy.apply.applied.targets.map((item) => ({
        rel: item.rel,
        lifecycle: readCardLifecycle(absOf(COPY_ROOT, item.rel)),
        title: titleOfText(readText(COPY_ROOT, item.rel)),
        sha256: shaOfFileOrNull(absOf(COPY_ROOT, item.rel)),
      }));
      const edges = loadEdges({ memoryRoot: COPY_ROOT });
      const sourceStatuses = [...new Set(plan.extracts.map((item) => item.fromRel))].map((file) => ({
        file,
        before: statusOfText(readText(MEMORY_ROOT, file)),
        after: statusOfText(readText(COPY_ROOT, file)),
      }));
      const extractLines = copy.apply.applied.extracts.map((item) => {
        // R12-R2 P0/P1：plan 行号来自迁移前文件；无 frontmatter 的卡迁移后 body 整体后移 3 行。
        const pre = readText(MEMORY_ROOT, item.fromRel);
        const post = readText(COPY_ROOT, item.fromRel);
        const line = lineAtPlanLineAfter(post, item.line, pre);
        return { id: item.id, fromRel: item.fromRel, line: item.line, currentLine: line };
      });
      return {
        cards,
        sourceStatuses,
        targets,
        edges: {
          present: edges.present,
          count: edges.edges.length,
          stats: edges.stats,
          rows: edges.edges.map((edge) => ({ from: edge.from, to: edge.to, type: edge.type, confidence: edge.confidence, source: edge.source, evidence: edge.evidence })),
        },
        extractLines,
        indexHasSection: readText(COPY_ROOT, 'INDEX.md').includes(LIFECYCLE_INDEX_BEGIN),
      };
    });
  }

  // 4) 副本上的注入查询 -------------------------------------------------
  const queries = {};
  const runQuery = async (key, query, options = {}) => {
    const run = await withTryAsync(() => preStepTurn(COPY_ROOT, query, options));
    queries[key] = run.ok ? run.value : { ok: false, query, error: run.error };
    return queries[key];
  };
  if (copy.apply) {
    await runQuery('q1', '六轨 分轨 废弃 现在用什么');
    // 历史查询用具体旧事实词（258 首分轨库 5.01 GB）才能把 2026-10 旧口径卡排进 top5；
    // 只写「以前用的六轨分轨旧口径」时 handover 两张历史卡会挤占注入名额，旧卡本身进不来。
    await runQuery('q1h', '以前 258 首分轨库 5.01 GB 旧口径');
    await runQuery('q2', '听澜是谁起的名字');
    await runQuery('q2h', '听澜的名字以前是怎么来的');
    await runQuery('q3', '贝贝的妈妈是谁');
    await runQuery('q1b200', '六轨 分轨 废弃 现在用什么', { budget: 200 });
  }

  const q1 = queries.q1 ?? { ok: false, titles: [], text: '', tokens: 0 };
  const q1h = queries.q1h ?? { ok: false, titles: [], text: '', tokens: 0 };
  const q2 = queries.q2 ?? { ok: false, titles: [], text: '', tokens: 0 };
  const q2h = queries.q2h ?? { ok: false, titles: [], text: '', tokens: 0 };
  const q3 = queries.q3 ?? { ok: false, titles: [], text: '', tokens: 0 };
  const q1b = queries.q1b200 ?? { ok: false, titles: [], text: '', tokens: 0 };

  // 5) 工具层基线（真库只读） ------------------------------------------
  const tool = {
    sixStem: toolRecall('六轨'),
    fiveQuestions: toolRecall('五问是哪五问'),
    naming: toolRecall('听澜是谁起的 名字谁取的'),
    beibei: toolRecall('贝贝的妈妈是谁'),
  };
  const toolCopy = { sixStem: toolRecall('六轨', COPY_ROOT), fiveQuestions: toolRecall('五问是哪五问', COPY_ROOT) };

  // 6) 验收用例 ---------------------------------------------------------
  // e1 六轨旧卡
  {
    const a = [];
    const canonicalRank = copy.verified?.ok ? copy.verified.value.cards[SRC.sixStem]?.rank : null;
    a.push(assertion('e1.rank-canonical', 'canonical rank=0（lifecycleRank）', canonicalRank, canonicalRank === 0, 'src/memory/lifecycle.js:52-59 + 迁移后副本卡'));
    a.push(assertion('e1.titles-first', `注入第 1 条 = 《${titles.sixStem}》`, q1.titles[0], q1.titles[0] === titles.sixStem, 'src/recall/index.js:624-704 lifecycleRank 主键排序'));
    const oldInQ1 = containsEither(q1.text, [oldSentenceA]);
    a.push(assertion('e1.old-clause-absent', '现行查询注入文本不含 arrangement.md:65 旧六分轨数字子句（该子句已换指针、其余文字逐字保留）', oldInQ1, oldInQ1.length === 0, `${SRC.arrangement}:65`));
    const musicRow = copy.verified?.ok ? copy.verified.value.extractLines.find((row) => row.id === 'six-stem-music-library-48') : null;
    const musicLine = musicRow?.currentLine ?? '';
    const musicKept = collapse(musicLine).includes(collapse(oldSentenceB));
    const musicAnnotated = musicKept && musicLine.includes('已作废') && musicLine.includes(SRC.sixStem);
    a.push(assertion('e1.music-library-annotated', 'music-library.md:48 原位保留整条逐字残片（旧统计未静默删）+ 标注「已作废」并指向 six-stem-drop', { kept: musicKept, annotated: musicAnnotated, line: musicLine.slice(0, 160) }, musicAnnotated, `${SRC.musicLibrary}:48（M2：原位追加更正指针）`));
    const oldBInQ1 = collapse(q1.text).includes(collapse(oldSentenceB));
    const oldBLabel = !oldBInQ1 || q1.text.includes('已作废');
    a.push(assertion('e1.old-residue-labeled', '若注入文本仍出现该残片旧统计，必须同时带「已作废」标注（不许无标注当现行）', { present: oldBInQ1, labeled: q1.text.includes('已作废') }, oldBLabel, `${SRC.musicLibrary}:48 行首更正指针`));
    const histLabel = q1.text.includes('〔历史口径');
    a.push(assertion('e1.no-historical-label-current', '现行查询不出现「历史口径」标注', histLabel, histLabel === false, 'src/recall/recall-core.mjs renderInjection'));
    const legacyInHist = q1h.titles.includes(legacyTitles.sixStem);
    a.push(assertion('e1.historical-query-releases', `历史查询注入历史卡《${legacyTitles.sixStem}》`, q1h.titles, legacyInHist, 'plan.targetCard.title + 历史查询关键词 以前'));
    const histLabel2 = q1h.text.includes('〔历史口径：此卡已被后续结论取代〕');
    a.push(assertion('e1.historical-label', '历史卡带「〔历史口径：此卡已被后续结论取代〕」', histLabel2, histLabel2, 'src/recall/recall-core.mjs'));
    const histEdge = q1h.text.includes('被后续卡取代') && q1h.text.includes(edgeQuotes[`${SRC.sixStem}|topics/six-stem-legacy-2026-11-25.md|supersedes`]);
    a.push(assertion('e1.historical-edge-evidence', '历史查询里出现 superseded_by 关系句 + 证据引文「分轨求和一律禁用，出现即 FAIL」', histEdge, histEdge, 'src/recall/edges.js relationSentence + plan.edges'));
    // R11 P1-2：handover 也在生产 dirs 里，旧口径必须同样不进现行注入、来源行只换指针。
    const extractRowsE1 = copy.verified?.ok ? copy.verified.value.extractLines : [];
    const h08Row = extractRowsE1.find((row) => row.id === 'six-stem-handover-11-08-line15');
    const h12Row = extractRowsE1.find((row) => row.id === 'six-stem-handover-11-12-line43');
    const handoverOldWords = [
      handoverExtracts.h08?.quote,
      handoverExtracts.h12?.quote,
      '258 个 stems 目录',
      '六条 ogg',
      '六条ogg',
    ].filter(Boolean).map((value) => collapse(value));
    const handoverOldInQ1 = handoverOldWords.filter((word) => collapse(q1.text).includes(word));
    a.push(assertion('e1.handover-old-absent', '生产 dirs（topics+handover）下现行查询不注入 handover 两张卡的六轨旧口径', handoverOldInQ1, handoverOldInQ1.length === 0, `${SRC.handoverOld}:15 / ${SRC.handoverV14}:43`));
    const pointerOk = (row, quote) => Boolean(row)
      && collapse(row.currentLine).includes('D390–D398')
      && row.currentLine.includes('topics/six-stem-handover-legacy-2026-11-12.md')
      && !collapse(row.currentLine).includes(collapse(quote));
    a.push(assertion('e1.handover-pointer-in-place', 'handover 来源行只把旧子句换成回指指针（其余文字保留、旧句不再留在现行行）', {
      h08: h08Row ? h08Row.currentLine.slice(0, 140) : null,
      h12: h12Row ? h12Row.currentLine.slice(0, 140) : null,
    }, pointerOk(h08Row, handoverExtracts.h08?.quote) && pointerOk(h12Row, handoverExtracts.h12?.quote), 'plan.extracts six-stem-handover-* + sourceHandling=pointer'));
    result.cases.push(caseRec('e1', '六轨旧卡：canonical 优先 + 历史口径只在历史查询出现', '注入层基线：q1 现行卡第一（真实卡）', a, { queries: { q1: pick(q1), q1h: pick(q1h) } }));
  }

  // e2 听澜命名
  {
    const a = [];
    const rows = copy.verified?.ok ? copy.verified.value.edges.rows : [];
    const conflict = rows.find((row) => row.type === 'conflicts_with' && row.from === SRC.people && row.to === 'topics/naming-legacy-2026-10-31.md');
    a.push(assertion('e2.edge-present', `edges.jsonl 有 conflicts_with ${SRC.people} → topics/naming-legacy-2026-10-31.md`, conflict ? { from: conflict.from, to: conflict.to, type: conflict.type } : null, Boolean(conflict), '<memoryRoot>/.longlive/recall/edges.jsonl'));
    const quote = conflict?.evidence?.quote ?? '';
    const quoteInPeople = collapse(real.people).includes(collapse(quote));
    a.push(assertion('e2.edge-evidence-verbatim', '边 evidence.quote 逐字存在于 people.md（迁移前真实卡）', quote, quoteInPeople, `${SRC.people}:64`));
    a.push(assertion('e2.edge-in-injection', '历史查询注入里出现「与此卡冲突」+ 证据路径/引文', { hasSentence: q2h.text.includes('与此卡冲突'), hasPath: q2h.text.includes(SRC.people), hasQuote: collapse(q2h.text).includes(collapse(quote)) }, q2h.text.includes('与此卡冲突') && q2h.text.includes(SRC.people) && collapse(q2h.text).includes(collapse(quote)), 'src/recall/edges.js relationSentence'));
    a.push(assertion('e2.canonical-injected', `非历史查询注入现行 people 卡《${titles.people}》`, q2.titles, q2.titles.includes(titles.people), SRC.people));
    const oldInQ2 = collapse(q2.text).includes(collapse(oldSentenceC));
    a.push(assertion('e2.old-transcript-absent', '非历史查询不注入 2026-10-31 旧转述原句', oldInQ2, oldInQ2 === false, `${SRC.people}:70`));
    result.cases.push(caseRec('e2', '听澜命名：conflicts_with 证据进注入，非历史查询只用现行口径', '工具层基线：people 36.00 第一（真实卡）', a, { queries: { q2: pick(q2), q2h: pick(q2h) } }));
  }

  // e3 贝贝妈妈未记录
  {
    const a = [];
    const scan = scanTopicsForPattern(MEMORY_ROOT, /贝贝的妈妈|贝贝妈妈/);
    a.push(assertion('e3.no-recorded-claim', '全库 topics 无「贝贝的妈妈/贝贝妈妈」结论卡', { files: scan.files, matches: scan.matches }, scan.matches === 0, 'topics/**/*.md 全量扫描'));
    const fabrications = containsEither(q3.text, ['贝贝的妈妈是', '贝贝妈妈是', '已记录', '记录在案', '已写入记忆', '已存进记忆']);
    a.push(assertion('e3.no-pretend-recorded', '查询注入不含「已记录/已写入记忆」类断言', fabrications, fabrications.length === 0, 'src/recall/recall-core.mjs + 真实卡'));
    a.push(assertion('e3.people-card-injected', '注入 people 卡（相关线索）而非编造答案', q3.titles, q3.titles.includes(titles.people), SRC.people));
    result.cases.push(caseRec('e3', '贝贝妈妈未记录：不假装已记录（负例性质的正例）', '工具层基线：people 31.11 第一，无记录性断言（真实卡）', a, { queries: { q3: pick(q3) } }));
  }

  // e4 五问 derived_from
  {
    const a = [];
    const realRecall = tool.fiveQuestions;
    const top = realRecall.results[0];
    a.push(assertion('e4.tool-baseline-first', `工具层 q「五问是哪五问」第 1 条 = ${SRC.fiveQuestions}`, top?.path, top?.path === SRC.fiveQuestions, 'src/memory/recall.js memoryRecall（真库只读）'));
    const five = '这个插件怎么装，用途是什么，要解决什么问题，存在什么风险，还有什么缺陷';
    a.push(assertion('e4.excerpt-contains-sentence', 'excerpt 含五问指定句（原文逐字）', top?.excerpt, collapse(top?.excerpt ?? '').includes(collapse(five)), `${SRC.fiveQuestions}:15`));
    const rows = copy.verified?.ok ? copy.verified.value.edges.rows : [];
    const derived = rows.find((row) => row.type === 'derived_from' && row.from === SRC.fiveQuestions && row.to === SRC.pluginProfile);
    a.push(assertion('e4.edge-present', `edges.jsonl 有 derived_from ${SRC.fiveQuestions} → ${SRC.pluginProfile}`, derived ? { from: derived.from, to: derived.to, type: derived.type } : null, Boolean(derived), '<memoryRoot>/.longlive/recall/edges.jsonl'));
    const dQuote = derived?.evidence?.quote ?? '';
    a.push(assertion('e4.edge-evidence-verbatim', 'derived_from 边 evidence.quote 逐字存在于五问卡', dQuote, collapse(real.fiveQuestions).includes(collapse(dQuote)), `${SRC.fiveQuestions}:9`));
    result.cases.push(caseRec('e4', '五问 derived_from：边证据可核 + excerpt 含指定句', '工具层基线通过（19.08 第一，excerpt 含五问句）', a));
  }

  // e5 当前六轨基线 + 不回退
  {
    const a = [];
    const base = tool.sixStem;
    a.push(assertion('e5.tool-baseline', '工具层 q「六轨」第 1 条 = six-stem-drop（基线通过）', base.results[0]?.path, base.results[0]?.path === SRC.sixStem, 'src/memory/recall.js（真库只读，红队记录 22.07）'));
    a.push(assertion('e5.injection-no-regress', '迁移副本注入层 q1 第 1 条仍是 six-stem-drop', q1.titles[0], q1.titles[0] === titles.sixStem, 'src/recall/index.js:624-704'));
    const copyTopPaths = toolCopy.sixStem.results.map((item) => item.path);
    a.push(assertion('e5.copy-tool-recall-present', '副本工具层召回仍能拿到 six-stem-drop（前 5 内）', copyTopPaths, copyTopPaths.includes(SRC.sixStem), 'src/memory/recall.js'));
    a.push(assertion('e5.copy-tool-lifecycle-order', '副本工具层 q「六轨」第 1 条 = six-stem-drop（D9：historical 降权后不再排现行前）', copyTopPaths[0], copyTopPaths[0] === SRC.sixStem, 'src/memory/recall.js HISTORICAL_SCORE_WEIGHT=0.3'));
    result.cases.push(caseRec('e5', '当前六轨：基线通过 + 注入层不得回退', 'q2 六轨 22.07 rank1（真库）', a));
  }

  // e6 工具层 lifecycle 降权（SPEC-1.8.11 D9） --------------------------
  {
    const a = [];
    const legacyRel = 'topics/six-stem-legacy-2026-11-25.md';
    const copyScan = scanCards(COPY_ROOT);
    const rawOf = (q, rel) => {
      const card = copyScan.find((item) => item.rel === rel);
      return card ? scoreCard(q, card).score : null;
    };
    // 工具层 memoryRecall 有 manualCap=2（1.8.2 D2，src/memory/recall.js:229-231），
    // 「六轨」这种宽查询里 historical 加权后掉出前二就看不到行；用具体旧事实词让 canonical /
    // historical 两张卡都进前二，才能直接观测「historical 分数 = 原始分 × 0.3」。
    const copyQ = '19.9 MB/首 六分轨 ogg';
    const copyHistQ = '以前用的六轨旧口径';
    const canonicalRaw = rawOf(copyQ, SRC.sixStem);
    const legacyRaw = rawOf(copyQ, legacyRel);
    const weightedLegacy = legacyRaw == null ? null : Math.round(legacyRaw * 0.3 * 100) / 100;
    const copyWeighted = toolRecall(copyQ, COPY_ROOT);
    const copyResults = copyWeighted.results;
    const copyCanonicalRow = copyResults.find((item) => item.path === SRC.sixStem);
    const copyLegacyRow = copyResults.find((item) => item.path === legacyRel);
    a.push(assertion('e6.copy-historical-weighted', '副本 historical 卡分数 = 原始分 × 0.3（可复算）', { query: copyQ, raw: legacyRaw, actual: copyLegacyRow?.score, expected: weightedLegacy }, copyLegacyRow?.score === weightedLegacy && weightedLegacy !== null, 'src/memory/recall.js memoryRecall + HISTORICAL_SCORE_WEIGHT'));
    a.push(assertion('e6.copy-canonical-unweighted', 'canonical 卡分数 = 原始分（不降权）', { query: copyQ, raw: canonicalRaw, actual: copyCanonicalRow?.score }, copyCanonicalRow?.score === canonicalRaw && canonicalRaw !== null, 'src/memory/recall.js memoryRecall'));
    a.push(assertion('e6.copy-lifecycle-fields', '结果项带 lifecycle：canonical / historical 各就各位', { canonical: copyCanonicalRow?.lifecycle ?? null, historical: copyLegacyRow?.lifecycle ?? null }, copyCanonicalRow?.lifecycle === 'canonical' && copyLegacyRow?.lifecycle === 'historical', 'src/memory/recall.js results[].lifecycle'));
    const copyHist = toolRecall(copyHistQ, COPY_ROOT);
    const histRow = copyHist.results.find((item) => item.path === legacyRel);
    const legacyRawHist = rawOf(copyHistQ, legacyRel);
    a.push(assertion('e6.explicit-history-no-penalty', '显式历史查询（以前/旧口径）不降权：分数 = 原始分', { query: copyHistQ, raw: legacyRawHist, actual: histRow?.score ?? null }, histRow?.score === legacyRawHist && legacyRawHist !== null, 'src/memory/lifecycle.js isHistoricalQuery + src/memory/recall.js'));
    const v2 = recallV2({ query: copyQ, topK: 5 }, { memoryRoot: COPY_ROOT });
    const v2Hist = v2.hits.find((hit) => hit.card === legacyRel);
    a.push(assertion('e6.recall-v2-inherits', 'memory_recall_v2 继承同一加权分数（不重复实现）', { top1: v2.hits[0]?.card ?? null, v2HistoricalScore: v2Hist?.score ?? null, expected: weightedLegacy }, v2.hits[0]?.card === SRC.sixStem && v2Hist?.score === weightedLegacy, 'src/memory/recall-v2.js（转调 memoryRecall）'));
    result.cases.push(caseRec('e6', '工具层 lifecycle 降权（D9）：memoryRecall 与 memory_recall_v2 同一分数', '工具层基线：真库 q 六轨 six-stem-drop 22.07 rank1', a, { queries: { weightedToolRecall: { query: copyQ, results: copyResults }, historyToolRecall: { query: copyHist.query, results: copyHist.results } } }));
  }

  // e9 evidence 包透传 lifecycle/edge（R11 P1-3，SPEC D4） ---------------
  {
    const a = [];
    // 证据包写入的是「最后一次 composed turn」；此处专门跑一次历史查询（含历史卡 + 边扩展），
    // 然后读副本里的 .longlive/evidence/latest.json 断言 anchors 带 lifecycle/edge。
    // 用具体旧事实词让 2026-10 旧口径卡进 top5（宽查询会被 handover 历史卡挤掉）。
    const run = await withTryAsync(() => preStepTurn(COPY_ROOT, '以前 258 首分轨库 5.01 GB 旧口径'));
    const evidenceAbs = path.join(COPY_ROOT, '.longlive', 'evidence', 'latest.json');
    let pkg = null;
    let readError = null;
    try {
      pkg = JSON.parse(fs.readFileSync(evidenceAbs, 'utf8'));
    } catch (error) {
      readError = String(error?.message ?? error);
    }
    const anchors = pkg?.package?.anchors ?? [];
    const byPath = (needle) => anchors.find((anchor) => String(anchor?.path ?? '').includes(needle)) ?? null;
    const canonicalAnchor = byPath(SRC.sixStem);
    const legacyAnchor = byPath('topics/six-stem-legacy-2026-11-25.md');
    a.push(assertion('e9.evidence-package-present', '副本前置注入写出 .longlive/evidence/latest.json（schema evidence-package/v1，status ready）', { exists: fs.existsSync(evidenceAbs), status: pkg?.package?.status ?? null, anchors: anchors.length, readError }, fs.existsSync(evidenceAbs) && pkg?.schemaVersion === 'evidence-package/v1' && pkg?.package?.status === 'ready' && anchors.length > 0, 'src/memory/evidence.js buildEvidencePackage/writeEvidencePackage'));
    a.push(assertion('e9.anchor-canonical-lifecycle', 'canonical 卡的 anchor 带 lifecycle=canonical', canonicalAnchor ? { path: canonicalAnchor.path, lifecycle: canonicalAnchor.lifecycle } : null, canonicalAnchor?.lifecycle === 'canonical', 'src/memory/evidence.js cleanEvidenceAnchor（R11 P1-3 透传）'));
    a.push(assertion('e9.anchor-historical-lifecycle', 'historical 卡的 anchor 带 lifecycle=historical', legacyAnchor ? { path: legacyAnchor.path, lifecycle: legacyAnchor.lifecycle } : null, legacyAnchor?.lifecycle === 'historical', 'src/memory/evidence.js cleanEvidenceAnchor（R11 P1-3 透传）'));
    const edge = legacyAnchor?.edge ?? null;
    const edgeOk = edge?.type === 'superseded_by' && edge?.from === 'topics/six-stem-legacy-2026-11-25.md' && edge?.to === SRC.sixStem && collapse(edge?.evidence?.quote ?? '').includes('分轨求和一律禁用，出现即 FAIL');
    a.push(assertion('e9.anchor-edge-evidence', 'historical anchor 的 edge 结构可核（type/from/to/evidence.quote 逐字）', edge, edgeOk, 'plan.edges + src/recall/edges.js expandEdges + evidence.js cleanEvidenceAnchor'));
    a.push(assertion('e9.anchor-caps', 'anchors 数量受 cap 约束（EVIDENCE_ANCHOR_LIMITS.anchors=10）', anchors.length, anchors.length <= 10, 'src/memory/evidence.js EVIDENCE_ANCHOR_LIMITS'));
    result.cases.push(caseRec('e9', '证据包透传 lifecycle/edge（R11 P1-3）：边证据进 evidence 包', '证据包基线：原白名单剥 lifecycle/edge（R11 红队发现）', a, { queries: { evidenceProbe: run.ok ? pick(run.value) : { ok: false, error: run.error } } }));
  }

  // n1 坏边不注入 -------------------------------------------------------
  {
    const a = [];
    const edgesAbs = path.join(COPY_ROOT, '.longlive', 'recall', 'edges.jsonl');
    const bogusTarget = 'topics/zzz-no-such-card-1.8.11.md';
    const badRows = [
      // 目标卡不存在的边：扩展时必须 dropped，不得凭空注入
      {
        from: SRC.sixStem,
        to: bogusTarget,
        type: 'superseded_by',
        confidence: 0.99,
        created_at: '2026-11-26T00:00:00+08:00',
        source: 'acceptance-bad-edge',
        evidence: { path: SRC.sixStem, lines: [20, 20], quote: '伪造边哨兵：目标卡不存在不应注入' },
      },
      // 未知 type：loadEdges 必须 dropped
      { from: SRC.sixStem, to: SRC.people, type: 'replaces', confidence: 0.5, created_at: '2026-11-26T00:00:00+08:00', source: 'acceptance-bad-edge' },
      '{broken json line without closing brace',
    ];
    let badRun = { ok: false };
    let stats = null;
    let original = null;
    if (copy.apply && fs.existsSync(edgesAbs)) {
      original = fs.readFileSync(edgesAbs, 'utf8');
      fs.writeFileSync(edgesAbs, `${original}${badRows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n')}\n`, 'utf8');
      badRun = await withTryAsync(() => preStepTurn(COPY_ROOT, '六轨 分轨 废弃 现在用什么'));
      stats = loadEdges({ memoryRoot: COPY_ROOT }).stats;
      fs.writeFileSync(edgesAbs, original, 'utf8');
      const badText = badRun.ok ? badRun.value.text : '';
      const badTitles = badRun.ok ? badRun.value.titles : [];
      a.push(assertion('n1.pipeline-still-ok', '坏边文件下前置注入不崩且仍有注入', { ok: badRun.ok, tokens: badRun.ok ? badRun.value.tokens : 0 }, badRun.ok && badTitles.length > 0, 'src/recall/edges.js loadEdges fail-open'));
      a.push(assertion('n1.bad-lines-counted', '坏 JSON 行计入 badLines、未知 type 计入 dropped', stats, (stats?.badLines ?? 0) >= 1 && (stats?.dropped ?? 0) >= 1, 'src/recall/edges.js parseEdgesText:150-181'));
      a.push(assertion('n1.missing-target-not-injected', '目标卡不存在的边不被扩展注入（无哨兵、无假标题）', { sentinel: badText.includes('伪造边哨兵'), bogusTitle: badTitles.some((title) => title.includes('zzz-no-such-card')) }, !badText.includes('伪造边哨兵') && !badTitles.some((title) => title.includes('zzz-no-such-card')), 'src/recall/edges.js expandEdges:344-351（missing-card dropped）'));
      a.push(assertion('n1.good-edges-still', '同一文件里的真实边仍可用（six-stem 仍第一）', badTitles[0], badTitles[0] === titles.sixStem, 'plan.edges 真实边'));
      const restored = fs.readFileSync(edgesAbs, 'utf8');
      a.push(assertion('n1.edges-restored', '负例后 edges.jsonl 逐字恢复', sha256Text(restored), sha256Text(restored) === sha256Text(original), '副本文件 sha256'));
    } else {
      a.push(assertion('n1.setup', '副本 apply 成功且 edges.jsonl 存在才可跑坏边负例', { apply: Boolean(copy.apply), edges: fs.existsSync(edgesAbs) }, false, 'migrate-lifecycle.js'));
    }
    result.negatives.push({ id: 'n1', title: '坏边（坏 JSON / 未知 type / 缺目标卡）不注入、不崩、可恢复', pass: a.every((item) => item.pass), assertions: a });
  }

  // n2 预算截断 ---------------------------------------------------------
  {
    const a = [];
    a.push(assertion('n2.budget-honored', 'budget=200 时注入 tokens ≤ 200（真实渲染）', q1b.tokens, q1b.tokens > 0 && q1b.tokens <= 200, 'src/recall/index.js:119 cfg.budget clamp + 尾部裁剪'));
    a.push(assertion('n2.truncated-smaller', 'budget=200 条数少于默认 budget 条数', { budget200: q1b.titles.length, default: q1.titles.length }, q1b.titles.length < q1.titles.length, 'src/recall/index.js:624-704'));
    a.push(assertion('n2.canonical-kept', '截断后仍保留 canonical six-stem-drop', q1b.titles[0], q1b.titles[0] === titles.sixStem, 'lifecycleRank 主键排序 + 尾部裁'));
    result.negatives.push({ id: 'n2', title: '预算超限：按真实渲染截断，canonical 不被裁掉', pass: a.every((item) => item.pass), assertions: a });
  }

  // n3 非历史查询排除 historical 正文 -----------------------------------
  {
    const a = [];
    const q2Legacy = q2.titles.includes(legacyTitles.naming);
    const q2Old = collapse(q2.text).includes(collapse(oldSentenceC));
    const q1Legacy = q1.titles.includes(legacyTitles.sixStem);
    a.push(assertion('n3.naming-legacy-excluded', '非历史查询不注入 naming-legacy 历史卡', q2.titles, q2Legacy === false, 'src/recall/index.js historical 过滤'));
    a.push(assertion('n3.naming-old-body-excluded', '非历史查询不含 2026-10-31 旧转述原句', q2Old, q2Old === false, `${SRC.people}:70`));
    a.push(assertion('n3.six-stem-legacy-excluded', '非历史查询不注入 six-stem-legacy 历史卡', q1.titles, q1Legacy === false, 'src/recall/index.js historical 过滤'));
    result.negatives.push({ id: 'n3', title: '非历史查询排除 historical 正文（两张历史卡）', pass: a.every((item) => item.pass), assertions: a });
  }

  // n4 status 枚举零改动 ------------------------------------------------
  {
    const a = [];
    a.push(assertion('n4.card-statuses', "CARD_STATUSES 仍为 ['active','locked','archived']", CARD_STATUSES, JSON.stringify(CARD_STATUSES) === JSON.stringify(['active', 'locked', 'archived']), 'src/memory/frontmatter.js（禁止改动）'));
    const thrown = withTry(() => parseStatus('canonical'));
    a.push(assertion('n4.parse-status-rejects-lifecycle', 'parseStatus("canonical") 仍抛 E_CARD_STATUS_INVALID', thrown.ok ? null : thrown.error.code, !thrown.ok && thrown.error.code === 'E_CARD_STATUS_INVALID', 'src/memory/frontmatter.js parseStatus'));
    const statuses = copy.verified?.ok
      ? [
        ...Object.entries(copy.verified.value.cards).map(([file, info]) => ({ file, before: info.statusBefore, after: info.statusAfter, checked: true })),
        ...copy.verified.value.sourceStatuses.map((item) => ({ file: item.file, before: item.before, after: item.after, checked: true })),
        ...copy.verified.value.targets.map((card) => ({ file: card.rel, before: null, after: statusOfText(readText(COPY_ROOT, card.rel)), checked: false })),
      ]
      : null;
    const stable = statuses ? statuses.filter((item) => item.checked).every((item) => item.before === item.after) : false;
    a.push(assertion('n4.status-unchanged-by-migration', '迁移前后被改卡/来源卡的 status 逐张不变（lifecycle 只走 extras）', statuses, stable, 'migrate-lifecycle.js E_STATUS_CHANGED 保护'));
    result.negatives.push({ id: 'n4', title: 'status 枚举零改动（红队 P0-1 回归门）', pass: a.every((item) => item.pass), assertions: a });
  }

  // e7 迁移：dry-run 四下游 + apply/rollback 字节等价 --------------------
  {
    const a = [];
    a.push(assertion('e7.plan-readonly', 'plan 只读且无阻塞（真实卡证据逐条命中）', planResult ? { ok: planResult.ok, readOnly: planResult.readOnly, counts: planResult.counts } : planRun.error, planRun.ok && planResult.ok === true && planResult.readOnly === true, 'migrate-lifecycle.js planLifecycleMigration'));
    a.push(assertion('e7.apply', '副本 apply 成功（卡/抽取/历史卡/边）', copy.apply ? { migrationId: copy.apply.migrationId, applied: { cards: copy.apply.applied.cards.length, extracts: copy.apply.applied.extracts.length, targets: copy.apply.applied.targets.length, edges: copy.apply.applied.edges }, backups: copy.apply.backups.length } : copy.error, Boolean(copy.apply), 'migrate-lifecycle.js applyLifecycleMigration'));
    a.push(assertion('e7.backup-covers-index-state', '备份覆盖 INDEX.md + .longlive 状态 + 被改卡', copy.apply ? copy.apply.backups.map((item) => item.rel) : null, Boolean(copy.apply) && copy.apply.backups.some((item) => item.rel === 'INDEX.md') && copy.apply.backups.some((item) => item.rel.startsWith('.longlive/')) && copy.apply.backups.length > copy.apply.applied.cards.length, 'migrate-lifecycle.js STATE_FILES 备份清单'));
    a.push(assertion('e7.index-section', 'INDEX.md 写入 LIFECYCLE 注记段', copy.verified?.ok ? copy.verified.value.indexHasSection : null, copy.verified?.ok ? copy.verified.value.indexHasSection : false, 'migrate-lifecycle.js upsertLifecycleSection'));

    // 历史卡回指行：来源行已换，历史卡正文保留原句
    const extractRows = copy.verified?.ok ? copy.verified.value.extractLines : [];
    const replaced = extractRows.map((row) => ({
      id: row.id,
      line: row.currentLine,
      expected: plan.extracts.find((item) => item.id === row.id)?.replaceWith,
    }));
    a.push(assertion('e7.source-lines-replaced', '来源行已逐字换成 plan.replaceWith 回指行（旧句原文迁入历史卡）', replaced, extractRows.length === plan.extracts.length && replaced.every((row) => collapse(row.line) === collapse(row.expected)), 'plan.extracts[].replaceWith'));
    const legacyCards = copy.verified?.ok ? copy.verified.value.targets : [];
    const legacyOk = legacyCards.length === plan.extracts.reduce((set, item) => set.add(item.targetCard.rel), new Set()).size
      && legacyCards.every((card) => card.lifecycle === 'historical' && card.title === (plan.extracts.find((item) => item.targetCard.rel === card.rel)?.targetCard?.title));
    a.push(assertion('e7.legacy-cards-created', '历史卡已建（lifecycle=historical，标题=plan，旧句逐字保留）', legacyCards, legacyOk, 'plan.extracts[].targetCard'));
    const targetRels = [...new Set(plan.extracts.map((item) => item.targetCard.rel))];
    const legacyBody = collapse(targetRels.map((rel) => readText(COPY_ROOT, rel)).join('\n'));
    const legacyQuotes = plan.extracts.filter((item) => item.legacyQuote);
    const wholeLinesOk = legacyQuotes.length > 0 && legacyQuotes.every((item) => legacyBody.includes(collapse(item.legacyQuote)));
    a.push(assertion('e7.legacy-card-whole-lines', `历史卡逐字收录来源整行原文（${legacyQuotes.length} 条 legacyQuote，含 M1 整行；不静默删现行事实）`, legacyQuotes.map((item) => ({ id: item.id, fromRel: item.fromRel, legacyQuoteLen: item.legacyQuote.length })), wholeLinesOk, 'plan.extracts[].legacyQuote + migrate-lifecycle.js buildLegacyCardText'));

    // R12-R2 P1：验收必须按「apply 前快照 vs apply 后」断言，不能按 apply 后同一行号自洽读取。
    // handover 两张卡原本没有 frontmatter：迁移只该新增 lifecycle 一行，正文只该被 plan 行替换。
    const handoverIds = [handoverExtracts.h08.id, handoverExtracts.h12.id];
    const handoverContract = handoverIds.map((id) => {
      const spec = plan.extracts.find((item) => item.id === id);
      const preText = readText(MEMORY_ROOT, spec.fromRel);
      const postText = readText(COPY_ROOT, spec.fromRel);
      const expectedBody = preText.split(/\r?\n/);
      expectedBody[spec.lines[0] - 1] = spec.replaceWith;
      const actualBody = bodyOfText(postText).split(/\r?\n/);
      const fmKeys = frontmatterKeysOfText(postText);
      return {
        id,
        fromRel: spec.fromRel,
        frontmatterKeys: fmKeys,
        bodyDiff: expectedBody.filter((line, index) => actualBody[index] !== line).length
          + Math.abs(expectedBody.length - actualBody.length),
        bodyEqual: arraysEqual(expectedBody, actualBody),
        frontmatterMinimal: fmKeys.length === 1 && fmKeys[0] === 'lifecycle',
      };
    });
    a.push(assertion('e7.handover-body-contract', 'handover 无 frontmatter 卡：apply 前正文逐行 == apply 后正文（仅 plan 行替换、其余逐字不变）', handoverContract.map((item) => ({ id: item.id, fromRel: item.fromRel, bodyEqual: item.bodyEqual, bodyDiff: item.bodyDiff })), handoverContract.every((item) => item.bodyEqual === true), 'apply 前快照 vs apply 后（R12-R2 P1）'));
    a.push(assertion('e7.handover-frontmatter-minimal', 'handover 卡只新增 lifecycle（不注入 salience/strength/revisions 等默认字段）', handoverContract.map((item) => ({ id: item.id, keys: item.frontmatterKeys })), handoverContract.every((item) => item.frontmatterMinimal === true), 'migrate-lifecycle.js composeCardText（R12-R2 P2-1）'));
    const handoverTarget = [...new Set(handoverIds.map((id) => plan.extracts.find((item) => item.id === id).targetCard.rel))];
    const handoverLegacyText = collapse(handoverTarget.map((rel) => readText(COPY_ROOT, rel)).join('\n'));
    const handoverProvenance = handoverIds.map((id) => {
      const spec = plan.extracts.find((item) => item.id === id);
      const preSha = sha256Text(readText(MEMORY_ROOT, spec.fromRel));
      return { id, preSha, recorded: handoverLegacyText.includes(`迁移前文件 sha256：\`${preSha}\``) };
    });
    a.push(assertion('e7.handover-provenance-original-sha', '历史卡登记的是 apply 前原始文件的 sha256（不是加 frontmatter 之后的 sha）', handoverProvenance, handoverProvenance.every((item) => item.recorded === true), 'migrate-lifecycle.js buildLegacyCardText（R12-R2 P1 provenance）'));

    // 负例 n5：把回指指针写到错行（旧 P0 形状）必须被 verifyAppliedMigration 抓住。
    {
      const na = [];
      const spec = plan.extracts.find((item) => item.id === 'six-stem-handover-11-08-line15');
      const file = absOf(COPY_ROOT, spec.fromRel);
      const original = fs.readFileSync(file, 'utf8');
      const eol = original.includes('\r\n') ? '\r\n' : '\n';
      const lines = original.split(/\r?\n/);
      // 模拟未快照的行号错位：按 plan 行号直接在「整份文件」里写指针，忽略新增的 frontmatter 行。
      lines[spec.lines[0] - 1] = spec.replaceWith;
      fs.writeFileSync(file, lines.join(eol));
      const tampered = withTry(() => verifyAppliedMigration(COPY_ROOT, plan));
      fs.writeFileSync(file, original);
      const restoreOk = fs.readFileSync(file, 'utf8') === original;
      const kinds = tampered.ok ? (tampered.value.failures ?? []).map((item) => item.kind) : [];
      na.push(assertion('n5.wrong-line-fails-verify', '错行替换（旧 P0 形状）后 verifyAppliedMigration 必须 fail-closed', { verifyOk: tampered.ok ? tampered.value.ok : null, kinds }, tampered.ok && tampered.value.ok === false && kinds.some((kind) => kind === 'source-line' || kind === 'body-mismatch'), 'migrate-lifecycle.js verifyAppliedMigration（R12-R2 P1 自洽盲区）'));
      na.push(assertion('n5.tamper-restored', '负例篡改后已恢复原字节，后续 rollback 不受影响', { restoreOk }, restoreOk === true, '验收脚本自检'));
      result.negatives.push({ id: 'n5', title: '错行替换必须让验收失败（apply 后自洽读取盲区回归门）', pass: na.every((item) => item.pass), assertions: na });
    }


    // dry-run（真库只读 + 副本四下游）
    if (fs.existsSync(DRYRUN_COPY)) fs.rmSync(DRYRUN_COPY, { recursive: true, force: true });
    const dryRun = withTry(() => dryRunLifecycleMigration({
      memoryRoot: MEMORY_ROOT, plan, planPath: PLAN_PATH, planSha256, now, copyRoot: DRYRUN_COPY, cleanup: true,
      query: '六轨 分轨 现在用什么',
    }));
    const dr = dryRun.ok ? dryRun.value : { ok: false, error: dryRun.error };
    result.migration = {
      plan: planResult ? { ok: planResult.ok, counts: planResult.counts, blockers: planResult.blockers.length, sha256: planSha256, readOnly: planResult.readOnly } : null,
      apply: copy.apply ? { migrationId: copy.apply.migrationId, manifestRel: copy.apply.manifestRel, backupDirRel: copy.apply.backupDirRel, backups: copy.apply.backups.map((item) => item.rel), applied: { cards: copy.apply.applied.cards.length, extracts: copy.apply.applied.extracts.length, targets: copy.apply.applied.targets.length, edges: copy.apply.applied.edges } } : null,
      dryRun: {
        ok: dr.ok,
        previewOk: dr.preview?.ok ?? null,
        verification: dr.verification
          ? { ok: dr.verification.ok, failures: dr.verification.failures, counts: dr.verification.counts }
          : null,
        realRootUntouched: dr.realRootUntouched ?? null,
        downstream: dr.downstream ? { ok: dr.downstream.ok, steps: dr.downstream.steps.map((step) => ({ name: step.name, ok: step.ok, ...pickStep(step) })) } : null,
        copyCleaned: !fs.existsSync(DRYRUN_COPY),
        error: dr.error ?? null,
      },
    };
    a.push(assertion('e7.dry-run-ok', 'dry-run ok（plan 无阻塞 + 副本产物验证 + 下游全绿 + 真库未被写）', { ok: dr.ok, previewOk: dr.preview?.ok ?? null, verificationOk: dr.verification?.ok ?? null, untouched: dr.realRootUntouched?.ok ?? null, downstreamOk: dr.downstream?.ok ?? null, copyCleaned: !fs.existsSync(DRYRUN_COPY) }, dr.ok === true && dr.preview?.ok === true && dr.verification?.ok === true && dr.realRootUntouched?.ok === true && dr.downstream?.ok === true && !fs.existsSync(DRYRUN_COPY), 'migrate-lifecycle.js dryRunLifecycleMigration + verifyAppliedMigration（R11 P1-1 fail-closed）'));
    a.push(assertion('e7.apply-verified', 'dry-run 产物级验证：逐卡 lifecycle / 来源行 replaceWith / 历史卡整行 legacyQuote / plan 边 / INDEX 注记段', dr.verification ?? null, dr.verification?.ok === true && dr.verification?.counts?.cards === plan.cards.length && dr.verification?.counts?.extracts === plan.extracts.length && dr.verification?.counts?.targets === new Set(plan.extracts.map((item) => item.targetCard.rel)).size && dr.verification?.counts?.edges === plan.edges.length, 'migrate-lifecycle.js verifyAppliedMigration（R11 P1-1）'));
    const steps = dr.downstream?.steps ?? [];
    const names = ['memory_index', 'memory_recall', 'memory_reinforce', 'memory_consolidate'];
    a.push(assertion('e7.downstream-four', '下游四入口逐个 ok：memory_index → memory_recall → memory_reinforce → memory_consolidate', steps.map((step) => ({ name: step.name, ok: step.ok })), names.every((name) => steps.find((step) => step.name === name)?.ok === true), 'SPEC-1.8.11 D7'));

    // rollback 逐字节等价
    const rollback = copy.apply ? withTry(() => rollbackLifecycleMigration({ memoryRoot: COPY_ROOT, migrationId: copy.apply.migrationId, now })) : { ok: false, error: { code: 'E_NO_APPLY', message: 'apply 失败，无法回滚' } };
    const rb = rollback.ok ? rollback.value : { ok: false, error: rollback.error };
    result.migration.rollback = rb.ok ? { ok: rb.ok, migrationId: rb.migrationId, restored: rb.restored, removed: rb.removed, countMatched: rb.countMatched, countExpected: rb.countExpected, mismatched: rb.mismatched, indexSha256: rb.indexSha256, auditLogPreserved: rb.auditLogPreserved ?? null, preserved: rb.preserved ?? [], concurrentConflicts: rb.concurrentConflicts ?? [], concurrentOverride: rb.concurrentOverride ?? false } : { ok: false, error: rb.error };
    a.push(assertion('e7.rollback-ok', 'rollback 恢复全部备份且逐字节校验通过（审计日志 append-only 保留）', rb.ok ? { restored: rb.restored, removed: rb.removed, countMatched: rb.countMatched, countExpected: rb.countExpected, mismatched: rb.mismatched, auditLogPreserved: rb.auditLogPreserved } : rb.error, rb.ok === true && rb.countMatched === rb.countExpected && rb.mismatched.length === 0 && rb.auditLogPreserved === true, 'migrate-lifecycle.js rollbackLifecycleMigration（R12 P2-5/P2-6）'));

    const compare = [];
    if (copy.apply) {
      for (const entry of copy.apply.backups) {
        // 红队 R12 P2-5：审计日志 append-only —— rollback 保留 apply 审计行并追加 rollback 行，
        // 因此副本的 audit.log 字节必然不等于真库；这里跳过它，改为断言「两段审计都在」。
        if (entry.rel === '.longlive/audit.log') continue;
        compare.push({
          rel: entry.rel,
          real: shaOfFileOrNull(path.join(MEMORY_ROOT, entry.rel)),
          copy: shaOfFileOrNull(path.join(COPY_ROOT, entry.rel)),
        });
      }
    }
    const compareOk = compare.length > 0 && compare.every((item) => item.real === item.copy);
    a.push(assertion('e7.rollback-bytes-equal-real', '回滚后副本被恢复文件 sha256 与真库逐字节一致（含 INDEX.md；audit.log 按 append-only 单列）', compare, compareOk, '备份文件 sha256 对比'));
    const auditText = exists(COPY_ROOT, '.longlive/audit.log') ? readText(COPY_ROOT, '.longlive/audit.log') : '';
    const auditRows = auditText.split(/\r?\n/).filter(Boolean);
    a.push(assertion('e7.rollback-audit-preserved', 'rollback 保留 apply 审计行并追加 rollback 审计行（append-only，不整文件还原）', {
      preserved: rb.auditLogPreserved ?? null,
      applyRow: auditRows.some((row) => /^\S+\tlifecycle-migration\t/i.test(row)),
      rollbackRow: auditRows.some((row) => /^\S+\tlifecycle-migration-rollback\t/i.test(row)),
    }, rb.auditLogPreserved === true && auditRows.some((row) => /^\S+\tlifecycle-migration\t/i.test(row)) && auditRows.some((row) => /^\S+\tlifecycle-migration-rollback\t/i.test(row)), 'migrate-lifecycle.js appendAudit + rollback（R12 P2-5）'));
    const createdRels = copy.apply ? copy.apply.created.map((item) => item.rel) : [];
    const createdGone = createdRels.every((file) => !exists(COPY_ROOT, file));
    const edgesGone = !exists(COPY_ROOT, '.longlive/recall/edges.jsonl');
    a.push(assertion('e7.rollback-removes-created', '回滚删除新建历史卡与 edges.jsonl', { created: createdRels, createdGone, edgesGone }, createdGone && edgesGone, 'manifest.created / createdEdges'));
    result.cases.push(caseRec('e7', '迁移 plan/dry-run/apply/rollback：四下游 + 字节级可回滚', '真实卡 + 副本（真库全程只读）', a));
  }

  // 7) 真库只读证明 -----------------------------------------------------
  const snapshotAfter = snapshotRealRoot(MEMORY_ROOT);
  const changedAll = diffSnapshots(snapshotBefore, snapshotAfter);
  const coreChanged = changedAll.filter((file) => !REAL_ROOT_VOLATILE.has(file));
  const volatileChanged = changedAll.filter((file) => REAL_ROOT_VOLATILE.has(file));
  const untouchedOk = coreChanged.length === 0;
  result.realRootUntouched = {
    ok: untouchedOk,
    checked: snapshotAfter.checked,
    digestBefore: snapshotBefore.digest,
    digestAfter: snapshotAfter.digest,
    coreDigestBefore: snapshotBefore.coreDigest,
    coreDigestAfter: snapshotAfter.coreDigest,
    changed: coreChanged,
    volatileChanged,
    volatileFiles: [...REAL_ROOT_VOLATILE],
  };
  result.cases.push(caseRec('e8', '真库只读：验收全程真库核心文件 sha256 未变', '真库只读（Owner B 约束）', [
    assertion('e8.untouched', '验收前后真库核心文件指纹一致（宿主可写的 .longlive/memory-state.json / audit.log 单列 volatile，不计入核心判据）', {
      checked: snapshotAfter.checked,
      coreChanged,
      volatileChanged,
      coreDigestBefore: snapshotBefore.coreDigest,
      coreDigestAfter: snapshotAfter.coreDigest,
    }, untouchedOk, 'snapshotRealRoot() 前后 sha256 对比（core = 除 volatile 外全部）'),
  ]));

  // 8) 汇总 -------------------------------------------------------------
  const allCases = [...result.cases];
  const allNegatives = result.negatives;
  result.summary.total = allCases.length + allNegatives.length;
  result.summary.passed = allCases.filter((item) => item.pass).length + allNegatives.filter((item) => item.pass).length;
  result.summary.failed = result.summary.total - result.summary.passed;
  result.finishedAt = new Date().toISOString();
  result.durationMs = Date.now() - startedAt.getTime();

  // 已知边界（如实记录，不算 pass 也不算 fail）
  if (plan.schema !== 'lifecycle-plan/v1') result.knownBoundaries.push({ id: 'kb-plan-schema', detail: `plan schema=${plan.schema}` });
  result.knownBoundaries.push({
    id: 'kb-budget-default',
    area: 'src/recall/index.js（Owner A）',
    detail: 'SPEC D3 写的 autoRecall 预算默认 2000，代码实际 DEFAULTS.budget=1200（下限 200 / 上限 2000）；本验收按真实代码记录 tokens 与截断行为，未改默认值',
  });
  result.knownBoundaries.push({
    id: 'kb-music-library-fragment-retained',
    area: 'topics/music-library.md:48（M2 修订，lead 指示）',
    detail: 'M2 选择「原位保留逐字残片 + 行首追加更正指针」，故现行卡仍含旧六分轨统计文字（未静默删）；由 e1.music-library-annotated / e1.old-residue-labeled 保证它带「已作废」标注。若注入 excerpt 窗口恰好未覆盖标注，e1.old-residue-labeled 会失败而不是放过',
  });
  result.knownBoundaries.push({
    id: 'kb-real-root-volatile-state',
    area: '.longlive/memory-state.json / .longlive/audit.log（宿主或其他代理可写）',
    detail: '实测一次外部写入：2026-11-26 21:13:13（+08）验收运行期间 memory-state.json 被外部改过一次（同一分钟 mtime 63s，内容变化；单独复核该文件 mtime 未再变，本脚本读写路径全部落在副本根）。故 e8 把这两个文件单列 volatile，核心判据 = 除它们之外全部真库文件 sha256 不变；绝不因外部写入放过 cards/INDEX/edges/links 的变化',
  });
  result.knownBoundaries.push({
    id: 'kb-package-files-missing-migration-cli',
    area: 'package.json files 白名单（lead 发布时统一加）',
    detail: 'scripts/migrate-lifecycle.mjs 与 scripts/acceptance-1.8.11.mjs 目前不在 package.json files 白名单（src/**/*.json 会带上 src/memory/lifecycle-plan.json）；按 lead 指示 B 侧不改 package.json、不 bump 版本（仍 1.8.10），由 lead 在发布时统一加',
  });

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!untouchedOk) process.stderr.write(`[acceptance] REAL ROOT CHANGED: ${[...coreChanged, ...volatileChanged].join(', ')}\n`);
  if (result.summary.failed > 0) process.stderr.write(`[acceptance] FAILED ${result.summary.failed}/${result.summary.total}，详见 ${OUT_PATH}\n`);
  return result.summary.failed === 0 && untouchedOk ? 0 : 1;
}

function pick(query) {
  return { query: query.query, tokens: query.tokens, titles: query.titles, ok: query.ok, error: query.error ?? undefined };
}

function pickStep(step) {
  const out = {};
  for (const key of ['status', 'rel', 'sha256', 'changed', 'count', 'titles', 'path', 'strength', 'verify', 'proposals', 'backlog', 'reportRel']) {
    if (step[key] !== undefined) out[key] = step[key];
  }
  return out;
}

function scanTopicsForPattern(root, pattern) {
  const base = path.join(root, 'topics');
  const files = [];
  let matches = 0;
  const walk = (current) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const text = fs.readFileSync(abs, 'utf8');
        const hits = text.match(pattern);
        if (hits) {
          files.push(rel(root, abs));
          matches += hits.length;
        }
      }
    }
  };
  walk(base);
  return { files, matches };
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`[acceptance] ERROR ${error.code ?? ''} ${error.message}\n${error.stack ?? ''}\n`);
    process.exitCode = 1;
  });
