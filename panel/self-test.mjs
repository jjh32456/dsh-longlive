/**
 * dsh-longlive-panel · self-test
 *
 * 不启 HTTP 服务，也不碰真实的 memoryRoot / sessionsRoot：
 * 在 plugin/.fixture/ 下造一份最小记忆库 + 会话目录，直接调 server 的 handler，
 * 逐个断言七个接口的返回结构，外加几个负例（穿越 / 超限 / 未知路由 / 405 / 304）。
 *
 *   node self-test.mjs          跑完删 fixture
 *   node self-test.mjs --keep   保留 fixture 便于肉眼检查
 *
 * 退出码：全 PASS = 0，任何 FAIL = 1。
 */

import { mkdir, writeFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createPanel, MAX_FILE_BYTES, defaultMemoryRoot } from './src/server.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const FIXTURE = join(HERE, '.fixture')
const MEMORY = join(FIXTURE, 'memory')
const SESSIONS = join(FIXTURE, 'sessions')
const KEEP = process.argv.includes('--keep')

let pass = 0
let failed = 0
const failures = []
// 用例串成一条链：保证打印顺序 = 书写顺序，同时能正确 await 每个 async 用例。
let chain = Promise.resolve()

function check(name, fn) {
  chain = chain.then(async () => {
    try {
      const detail = await fn()
      pass += 1
      console.log(`PASS  ${name}${detail ? `  ·  ${detail}` : ''}`)
    } catch (e) {
      failed += 1
      const msg = e && e.message ? e.message : String(e)
      failures.push(`${name}: ${msg}`)
      console.log(`FAIL  ${name}  ·  ${msg}`)
    }
  })
  return chain
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

function has(obj, key, label) {
  assert(obj && Object.prototype.hasOwnProperty.call(obj, key), `${label} 缺字段 ${key}`)
}

/** 临时清空 memoryRoot 相关环境变量，跑完恢复，避免污染后续用例。 */
function withCleanMemoryEnv(fn) {
  const saved = { llm: process.env.DSH_LONGLIVE_MEMORY_ROOT, legacy: process.env.DSH_MEM }
  delete process.env.DSH_LONGLIVE_MEMORY_ROOT
  delete process.env.DSH_MEM
  try {
    return fn()
  } finally {
    if (saved.llm === undefined) delete process.env.DSH_LONGLIVE_MEMORY_ROOT
    else process.env.DSH_LONGLIVE_MEMORY_ROOT = saved.llm
    if (saved.legacy === undefined) delete process.env.DSH_MEM
    else process.env.DSH_MEM = saved.legacy
  }
}

function isIso(v, label) {
  assert(typeof v === 'string' && Number.isFinite(Date.parse(v)), `${label} 不是 ISO 时间：${JSON.stringify(v)}`)
}

const DAY = 86400000
const iso = (offsetDays, offsetMs = 0) => new Date(Date.now() - offsetDays * DAY + offsetMs).toISOString()

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

async function makeFixture() {
  await rm(FIXTURE, { recursive: true, force: true })
  const put = async (rel, content) => {
    const abs = join(FIXTURE, rel)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, content, 'utf8')
  }

  // —— 记忆库 ——
  await put('memory/INDEX.md', [
    '# 引子索引',
    '',
    '<!-- BEGIN GENERATED -->',
    '| 卡 | 文件 |',
    '|---|---|',
    '| Alpha | topics/alpha.md |',
    '| Beta | topics/beta.md |',
    '<!-- END GENERATED -->',
    '',
  ].join('\n'))

  await put('memory/POLICY.md', '# POLICY\n\n只读面板不写库。\n')
  await put('memory/STATE.md', '我在哪：self-test fixture\n')
  await put('memory/tombstones.md', '## 2026-10-01 过期卡\n\n归档理由：被取代。\n')
  await put('memory/status.json', JSON.stringify({ at: iso(0), ok: true }, null, 2))
  await put('memory/flow/current.md', '我正在：跑 self-test。\n')
  await put('memory/flow/archive/2026-11-02-1200.md', '上一段。\n')

  await put('memory/topics/alpha.md', [
    '---',
    'title: Alpha 卡',
    'date: ' + iso(1).slice(0, 10),
    'salience: 5',
    'strength: 4',
    'last_used: ' + iso(1).slice(0, 10),
    'revisions: 2',
    '---',
    '# Alpha 卡',
    '',
    '这是 Alpha 的摘要段，用来验证 excerpt 抽取。',
    '',
    '## 正文',
    '',
    '正文第二段。',
    '',
  ].join('\n'))

  await put('memory/topics/beta.md', [
    '---',
    'title: Beta 卡',
    'date: 2026-01-01',
    'salience: 2',
    'strength: 2',
    'last_used: 2026-01-05',
    'revisions: 0',
    '---',
    '# Beta 卡',
    '',
    '很久没用的卡，应该被打上 stale。',
    '',
  ].join('\n'))

  await put('memory/journal/2026-11.md', '# 2026-11\n\n## 11-03\n\n写了 self-test。\n')
  await put('memory/journal/2026-10.md', '# 2026-10\n\n## 10-30\n\n截断成功。\n')

  // 超过 1 MiB 的卡：用来验证 413
  await put('memory/topics/huge.md', '---\ntitle: Huge\n---\n' + '字'.repeat(Math.ceil((MAX_FILE_BYTES + 1024) / 3)))

  // 永不提供的文件：白名单之外
  await put('memory/.credentials/api.yaml', 'token: SHOULD_NOT_LEAK\n')
  await put('memory/topics/notes.txt', '不是 .md，不该被列进 cards\n')

  await put('memory/.longlive/live/session-aaaaaaaa-1111.json', JSON.stringify({
    schemaVersion: 1,
    sessionId: 'session-aaaaaaaa-1111',
    pid: 4242,
    host: 'fixture-host',
    startedAt: iso(0, -60000),
    updatedAt: iso(0, -2000),
    heartbeatAt: iso(0, -2000),
    ttlMs: 60000,
    state: 'running',
    turn: 7,
    goal: '跑 self-test',
    blocked_on: '',
    queued: ['一条排队'],
    last_action: { at: iso(0, -2000), kind: 'tool', detail: 'tool/read' },
  }, null, 2))

  await put('memory/.longlive/live/session-bbbbbbbb-2222.json', JSON.stringify({
    schemaVersion: 1,
    sessionId: 'session-bbbbbbbb-2222',
    heartbeatAt: iso(3),
    ttlMs: 60000,
    state: 'idle',
    goal: '三天前的心跳',
  }, null, 2))

  // stale 归档行：必须被忽略
  await put('memory/.longlive/live/session-aaaaaaaa-1111.json.stale-20261103-211438', '{"sessionId":"ghost"}')

  await put('memory/.longlive/memory-state.json', JSON.stringify({
    lastConsolidated: null,
    indexBuiltAt: iso(0),
    forgetRuns: [],
    seenProposals: [],
    updatedAt: iso(0),
  }, null, 2))

  await put('memory/.longlive/audit.log', [
    `${iso(2)}\tmemory_index\tINDEX.md\tcards=2 legacy=0 changed=true`,
    `${iso(0)}\tmemory_reinforce\ttopics/alpha.md\tstrength=4 revisions=2`,
    '',
  ].join('\n'))

  // 过滤器决策：两行，其中一行 local_only + 长 utterance（验证打码）
  const filterDir = 'memory/.longlive/filter'
  await put(`${filterDir}/decisions-2026-11-03.jsonl`, [
    JSON.stringify({
      ts: iso(0, -3600000),
      unitId: 'unit-remember-1',
      turn: 88,
      target: 'remember',
      score: 7,
      dims: [{ id: 'R1', score: 2, max: 2, why: '含明确结论句' }, { id: 'R2', score: 1, max: 2, why: '可复用' }],
      hardSignals: ['R4'],
      privacy: { verdict: 'pass', marker: null },
      needsHuman: false,
      human: { verdict: 'pending', note: '' },
      source: { file: 'journal/2026-11.md', lineStart: 10, lineEnd: 20 },
      excerpt: '截断前先备份，备份 sha256 记进 truncate.json。',
      dedup: { nearestUnitId: 'unit-old', delta: 1 },
    }),
    JSON.stringify({
      ts: iso(0, -1800000),
      unitId: 'unit-local-1',
      turn: 91,
      target: 'local_only',
      score: 4,
      dims: [{ id: 'R1', score: 1, max: 2, why: '半结论' }],
      hardSignals: [],
      privacy: { verdict: 'pass', marker: null },
      needsHuman: true,
      human: { verdict: 'pending', note: '' },
      source: { file: 'journal/2026-11.md', lineStart: 30, lineEnd: 40 },
      excerpt: '这条只存在本地：'.concat('很长的一段话'.repeat(40)),
      dedup: null,
    }),
    '',
  ].join('\n'))

  // 召回流水：3 轮（文件里故意乱序）+ 1 行坏 JSON，验证排序、归一化和坏行容错
  await put('memory/.longlive/recall-log.jsonl', [
    JSON.stringify({
      at: iso(0, -3 * 3600000),
      sessionId: 'sess-recall-a',
      turn: 10,
      injected: [
        { id: 'card:rule-context', title: '上下文预算', score: 0.91, reason: '命中词：上下文' },
        { id: 'card:backup', title: '醒来先备份', score: 0.62, reason: '实体：备份' },
      ],
      blocked: [{ id: 'secret:credential', title: '凭据片段', reason: '隐私门：禁止外带' }],
    }),
    JSON.stringify({
      at: iso(0, -2 * 3600000),
      sessionId: 'sess-recall-b',
      turn: 11,
      injected: [{ id: 'card:truncate', title: '截断 runbook', score: 0.55, reason: '命中词：截断' }],
      blocked: [],
    }),
    '{ this is not json',
    JSON.stringify({
      at: iso(0, -1 * 3600000),
      sessionId: 'sess-recall-a',
      turn: 12,
      injected: [{ id: 'card:recall', title: '召回纪律', score: 0.87, reason: '命中词：召回' }],
      blocked: [],
    }),
    '',
  ].join('\n'))

  // 空文件 / 目录都不存在的两种降级态
  await put('memory-empty/.longlive/recall-log.jsonl', '')

  // 影子记录：真实 runtime 的嵌套形状（tool / call.text / decision.* / outcome.*）
  await put('memory/router-runtime.jsonl', [
    JSON.stringify({
      ts: iso(0, -120000),
      mode: 'shadow',
      tool: 'memory_save',
      call: { text: '准备把今天的结论写进 engram', args: { api_key: 'sk-should-never-leak', text: 'x' } },
      decision: {
        matchedRule: 'memory-write-default',
        ruleId: 'memory-write-default',
        action: 'memory.remember',
        level: 'L1',
        target: 'topics',
        tool: 'memory_save',
        needsHuman: false,
        confidence: 0.82,
        failClosed: false,
        errors: [],
      },
      guard: { verdict: 'allow', reason: null },
      risk: { level: 'none', reasons: [] },
      outcome: { status: 'ok', ms: 176.018 },
      input: { utterance: '准备把今天的结论写进 engram', local_only: false },
    }),
    '',
  ].join('\n'))

  // 常驻 Router：status + board + 四个提案（正文里放 sentinel，必须不回传）
  const sidForRouter = 'session-cccccccc-3333'
  const routerDir = 'memory/.longlive/router'
  await put(`${routerDir}/status.json`, JSON.stringify({
    v: 2,
    state: 'degraded',
    reason: 'budget blocked: fixture today tokens exhausted',
    since: iso(0, -3600000),
    runId: 'run-fixture',
    provider: { configured: true, missing: false },
    model: { auto: true },
    autonomy: 'ask',
    agentMode: false,
    lastTickAt: iso(0, -30000),
    nextTickAt: iso(0, -60000),
    heartbeatAt: iso(0, -20000),
    today: { day: '2026-11-04', usedTokens: 120000, reservedTokens: 0, capTokens: 100000 },
    run: { usedTokens: 5000, capTokens: 50000 },
    // v2.1 的 queue 已改名 tickQueue；顶层 queue 是五个计数键（DESIGN §6.5）。
    tickQueue: { pending: 3, invalid: 1, oldestAgeMs: 600000 },
    queue: { pending: 2, queued: 1, applying: 0, blockedOnUser: 1, expired: 3 },
    board: { seq: 17, generatedAt: iso(0, -60000), activeSessions: 2, unknownSessions: 1, focusVisible: 2, stale: true },
    proposals: {
      doneToday: 1,
      conflicts: 1,
      superseded: 0,
      queue: {
        seqCounter: 41,
        depth: 2,
        etaMs: 40000,
        starvation: true,
        writer: { ticket: 'q-0041', proposalId: 'tp-approved', sessionId: sidForRouter, since: iso(0, -900000) },
        blocked: [{ ticket: 'q-0039', reason: 'fixture blocked on user', since: iso(0, -1200000) }],
      },
    },
    lease: { active: true, holder: 'q-0041', since: iso(0, -900000), renewals: 2, expiresAt: iso(0, 60000) },
    wal: { lastSeq: 99, lastAt: iso(0, -60000), bytes: 4096, segments: 2, broken: false },
    wake: { enabled: false, lastAttemptAt: null, todayCount: 0, cooldownRemainingMs: 0, lastError: null },
    shared: { hintTokensLast: 400, injectedTurns: 7, injectedTokensToday: 2100, skipped: 2, readyProposals: 1, lastInjectAt: iso(0, -120000), lastInjectSha256: 'f'.repeat(64), liveRows: 2, unknownSessions: 1 },
    // warnings 是开放枚举：两个已知码 + 一个面板还不认识的码，必须原样保留。
    warnings: ['QUEUE_STARVATION', 'CREDENTIAL_RISK', 'FUTURE_UNKNOWN_CODE'],
    alerts: [
      { code: 'QUEUE_STARVATION', severity: 'warn', message: 'fixture queue starving' },
      { code: 'LIVE_UNREADABLE', severity: 'info', message: 'fixture live row unreadable' },
      { code: 'RESTORE_REQUIRED', severity: 'error', message: 'fixture restore required' },
    ],
    lastError: { code: 'AUDIT_CHAIN_BROKEN', message: 'audit hash mismatch at line 3' },
    lastReport: { at: iso(0, -3600000), summary: 'fixture tick' },
    files: {
      vault: MEMORY,
      board: join(MEMORY, '.longlive/router/board.json'),
      audit: join(MEMORY, '.longlive/router/audit.jsonl'),
    },
  }, null, 2))
  await put(`${routerDir}/board.json`, JSON.stringify({
    v: 1,
    seq: 17,
    generatedAt: iso(0, -60000),
    source: { liveRows: 2, proposals: 4, scanMs: 31 },
    // 旧口径的 kind/state/ageMs/host/declared 故意留在 fixture 里：面板必须丢掉，只出三字段。
    focus: [
      { sessionId: sidForRouter, goal: '跑 self-test', updatedAt: iso(0, -12000), kind: 'main', state: 'running', ageMs: 12000, host: 'fixture', declared: true },
      { sessionId: 'session-dddddddd-4444', goal: '等主人确认一条提案', updatedAt: iso(0, -600000), kind: 'sub', state: 'blocked', ageMs: 600000, host: 'fixture', declared: false },
    ],
    timeline: [
      { at: iso(0, -120000), kind: 'handover', sessionId: sidForRouter, ref: 'card-fixture', summary: '交接：面板只读。' },
    ],
    // pulse 是 v2.3 的名字：旧名 pendingProposals / writerLocked 不采用。
    pulse: { active: 2, running: 1, blocked: 1, unknownSessions: 1, queuedProposals: 2, approvedProposals: 1, blockedOnUser: 1, readyProposals: 1, queueHead: 'q-0042', lease: { active: true, holder: 'q-0041', expiresAt: iso(0, 60000) }, lastApplyAt: iso(0, -300000) },
    warnings: ['BOARD_STALE', 'CREDENTIAL_RISK'],
    hash: 'fixture-hash',
  }, null, 2))
  const proposal = (id, status, createdAt, extra = {}) => put(`${routerDir}/proposals/${id}.json`, JSON.stringify({
    v: 1,
    id,
    ticket: null,
    createdAt,
    updatedAt: createdAt,
    rev: 1,
    origin: { sessionId: sidForRouter, kind: 'main', host: 'fixture', turn: 3 },
    op: 'topic.update',
    target: 'topics/alpha.md',
    title: `fixture ${id}`,
    priority: 2,
    effectivePriority: 2,
    attempts: 0,
    deadlineAt: null,
    content: 'SECRET ROUTER BODY MUST NOT LEAK',
    rationale: 'fixture rationale',
    baseSha: 'fixture-base-sha',
    baseBytes: 10,
    risk: 'medium',
    riskReasons: ['fixture'],
    dedupeKey: `k-${id}`,
    status,
    ...extra,
  }, null, 2))
  await proposal('tp-pending-old', 'pending', iso(0, -600000), { ticket: 'q-0040', priority: 2, deadlineAt: iso(0, 3600000) })
  await proposal('tp-conflict', 'conflict', iso(0, -300000), { conflict: { reason: 'E_BASE_MOVED' }, ticket: 'q-0041', priority: 3, attempts: 3 })
  await proposal('tp-approved', 'approved', iso(0, -200000), { ticket: 'q-0042', priority: 1, attempts: 1, deadlineAt: iso(0, 600000) })
  await proposal('tp-done', 'done', iso(0, -100000), { ticket: 'q-0038' })

  // —— 会话目录 ——
  const sid = sidForRouter
  const ws = '--C-fixture-workspace--'
  await put(`sessions/${ws}/${sid}/truncate.json`, JSON.stringify({
    truncations: [{
      at: iso(2),
      beforeBytes: 10485760,
      afterBytes: 5242880,
      beforeEvents: 20000,
      afterEvents: 12000,
      cutSeq: 0,
      cutTurn: 1,
      backup: `C:\\fixture\\sessions\\${ws}\\${sid}\\session.v4.jsonl.zstd.bak-20261101-2`,
      backupSha256: 'a'.repeat(64),
    }],
  }, null, 2))
  await put(`sessions/${ws}/${sid}/backups.json`, JSON.stringify({
    version: 1,
    backups: [{
      file: `C:\\fixture\\sessions\\${ws}\\${sid}\\session.v4.jsonl.zstd.bak-20261101`,
      sha256: 'b'.repeat(64),
      size: 5242880,
      createdAt: iso(2, -1000),
      deletable: false,
    }],
  }, null, 2))
  await put(`sessions/${ws}/${sid}/session.v4.jsonl.zstd.bak-20261101`, 'BINARYISH')
  await put(`sessions/${ws}/${sid}/session.v4.jsonl.zstd`, 'CURRENTLOG')

  return { sid, ws }
}

// ---------------------------------------------------------------------------
// mock req/res
// ---------------------------------------------------------------------------

function mockRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    ended: false,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers || {}
      return this
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      this.ended = true
      return this
    },
    destroy() {},
  }
}

async function get(panel, path, init = {}) {
  const res = mockRes()
  await panel.handleHttp({ method: 'GET', url: path, headers: init.headers || {} }, res)
  let json = null
  try {
    json = res.body ? JSON.parse(res.body) : null
  } catch {
    json = null
  }
  return { status: res.statusCode, headers: res.headers, json }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function main() {
  const { sid } = await makeFixture()
  const panel = createPanel({
    memoryRoot: MEMORY,
    sessionsRoot: SESSIONS,
    designDoc: 'C:\\dshops\\longlive-panel\\DESIGN.md',
  })

  console.log(`fixture: ${FIXTURE}`)
  console.log(`panel  : memoryRoot=${MEMORY}`)
  console.log('')

  // 0. memoryRoot 默认值：走标准默认，不认本机私货
  {
    check('memoryRoot · 无配置 → 标准默认（H 盘存在也不采用）', () => withCleanMemoryEnv(() => {
      const std = join(homedir(), '.dsh', 'longlive-memory')
      eq(defaultMemoryRoot(), std, '默认路径')
      const hDrive = 'H:\\dsh-memory'
      return existsSync(hDrive) ? `${std}（${hDrive} 存在，仍未采用）` : std
    }))

    check('memoryRoot · 显式 config 优先于环境变量与默认', () => withCleanMemoryEnv(() => {
      process.env.DSH_LONGLIVE_MEMORY_ROOT = join(FIXTURE, 'env-memory-root')
      const explicit = join(FIXTURE, 'explicit-memory-root')
      const p = createPanel({ memoryRoot: explicit, sessionsRoot: SESSIONS })
      eq(p.config.memoryRoot, explicit, 'config.memoryRoot')
      return explicit
    }))
  }

  // 1. summary
  {
    const r = await panel.handle('summary', {})
    const b = r.body
    check('summary · HTTP 200 + ok', () => {
      eq(r.status, 200, 'status')
      eq(b.ok, true, 'ok')
      eq(b.readOnly, true, 'readOnly')
      return `root=${b.root}`
    })
    check('summary · 六层结构完整', () => {
      assert(Array.isArray(b.layers) && b.layers.length === 6, `layers 应为 6，实际 ${b.layers ? b.layers.length : 'n/a'}`)
      const ids = b.layers.map((l) => l.id).join(',')
      eq(ids, 'working,episodic,semantic,procedural,index,archive', 'layer ids')
      b.layers.forEach((l) => {
        for (const k of ['id', 'index', 'name', 'path', 'count', 'unit', 'health', 'note']) has(l, k, `layer ${l.id}`)
      })
      return ids
    })
    check('summary · totals 与 fixture 对齐', () => {
      eq(b.totals.cards, 2, 'cards')
      eq(b.totals.journalMonths, 2, 'journalMonths')
      eq(b.totals.procedures, 0, 'procedures')
      eq(b.totals.live, 2, 'live（stale 归档行必须被忽略）')
      eq(b.totals.liveRunning, 1, 'liveRunning')
      eq(b.totals.liveDead, 1, 'liveDead')
      eq(b.totals.truncations, 1, 'truncations')
      eq(b.totals.backups, 1, 'backups')
      eq(b.totals.filterDecisions, 2, 'filterDecisions')
      return JSON.stringify(b.totals)
    })
    check('summary · freshness / sources / warnings', () => {
      isIso(b.freshness.indexBuiltAt, 'freshness.indexBuiltAt')
      eq(b.sources.length, 2, 'sources.length')
      eq(b.sources[0].path, resolve(MEMORY), 'memoryRoot.path')
      eq(b.sources[0].readable, true, 'memoryRoot.readable')
      eq(b.sources[1].readable, true, 'sessionsRoot.readable')
      assert(Array.isArray(b.warnings), 'warnings 应为数组')
      assert(b.warnings.some((w) => w.code === 'W_NO_PROCEDURES'), 'procedures 为空应给出 W_NO_PROCEDURES')
      return `warnings=${b.warnings.map((w) => w.code).join('|')}`
    })
    check('summary · live 行字段与状态判定', () => {
      const running = b.live.find((x) => x.sessionId === 'session-aaaaaaaa-1111')
      assert(running, '找不到 running 那一行')
      eq(running.state, 'running', 'running.state')
      eq(running.turn, 7, 'running.turn')
      assert(running.heartbeatAgeMs != null && running.heartbeatAgeMs >= 0, 'heartbeatAgeMs 应为非负数')
      for (const k of ['sessionId', 'shortId', 'host', 'state', 'ttlMs', 'goal', 'blockedOn', 'lastAction']) has(running, k, 'live row')
      const dead = b.live.find((x) => x.sessionId === 'session-bbbbbbbb-2222')
      eq(dead.state, 'dead', '三天前心跳应为 dead')
      return `live=${b.live.map((x) => `${x.shortId}:${x.state}`).join(', ')}`
    })
  }

  // 2. cards
  {
    const r = await panel.handle('cards', { layer: 'semantic', limit: '10' })
    const b = r.body
    check('cards · 结构 + 排序 + 分页', () => {
      eq(r.status, 200, 'status')
      eq(b.ok, true, 'ok')
      eq(b.layer, 'semantic', 'layer')
      eq(b.items.length, 2, 'items.length（huge.md 应被跳过，notes.txt 不算卡）')
      eq(b.page.total, 2, 'page.total')
      eq(b.page.limit, 10, 'page.limit')
      eq(b.page.hasMore, false, 'page.hasMore')
      eq(b.items[0].path, 'topics/alpha.md', 'salience 5 应排第一')
      for (const k of ['id', 'layer', 'title', 'path', 'salience', 'strength', 'bytes', 'mtime', 'excerpt', 'flags']) has(b.items[0], k, 'card item')
      isIso(b.items[0].mtime, 'card.mtime')
      return `items=${b.items.map((x) => x.path).join(', ')}`
    })
    check('cards · flags（high / stale）', () => {
      const alpha = b.items.find((x) => x.path === 'topics/alpha.md')
      const beta = b.items.find((x) => x.path === 'topics/beta.md')
      assert(alpha.flags.includes('high'), 'alpha 应带 high')
      assert(beta.flags.includes('stale'), 'beta 应带 stale')
      return `alpha=${alpha.flags.join('+')} beta=${beta.flags.join('+')}`
    })
    check('cards · limit 夹住并标记 clamped', async () => {
      const over = await panel.handle('cards', { layer: 'semantic', limit: '999' })
      eq(over.body.page.limit, 100, 'limit 上限')
      eq(over.body.page.clamped, true, 'clamped')
      return 'limit=999 → 100, clamped=true'
    })
    check('cards · 未知 layer → 400 E_BAD_QUERY', async () => {
      const bad = await panel.handle('cards', { layer: 'nope' })
      eq(bad.status, 400, 'status')
      eq(bad.body.ok, false, 'ok')
      eq(bad.body.error.code, 'E_BAD_QUERY', 'error.code')
      return bad.body.error.message
    })
    check('cards · q 搜索过滤', async () => {
      const hit = await panel.handle('cards', { layer: 'semantic', q: 'beta' })
      eq(hit.body.page.total, 1, 'q=beta total')
      eq(hit.body.items[0].path, 'topics/beta.md', 'q=beta 命中')
      return 'q=beta → topics/beta.md'
    })
  }

  // 3. card/:id
  {
    const r = await panel.handle('card', 'topics/alpha.md')
    const b = r.body
    check('card/:id · frontmatter + body', () => {
      eq(r.status, 200, 'status')
      eq(b.ok, true, 'ok')
      eq(b.id, 'topics/alpha.md', 'id')
      eq(b.frontmatter.title, 'Alpha 卡', 'frontmatter.title')
      eq(b.frontmatter.salience, 5, 'frontmatter.salience')
      eq(b.frontmatter.revisions, 2, 'frontmatter.revisions')
      assert(b.body.startsWith('# Alpha 卡'), `body 应去掉 frontmatter，实际开头 ${JSON.stringify(b.body.slice(0, 20))}`)
      eq(b.truncated, false, 'truncated')
      eq(b.truncationReason, null, 'truncationReason')
      eq(typeof b.bytes, 'number', 'bytes')
      return `${b.bytes} B, body ${b.body.length} chars`
    })
    check('card/:id · ETag 存在且形如 W/"..."', () => {
      assert(/^W\/"[0-9a-f]{16}"$/.test(r.headers.etag || ''), `etag 格式不对：${r.headers.etag}`)
      return r.headers.etag
    })
    check('card/:id · 白名单外 → 404（不透出存在性）', async () => {
      const r1 = await panel.handle('card', '.credentials/api.yaml')
      eq(r1.status, 404, '.credentials status')
      eq(r1.body.error.code, 'E_NOT_FOUND', '.credentials code')
      const r2 = await panel.handle('card', 'topics/notes.txt')
      eq(r2.status, 404, 'notes.txt status')
      return '两个都 404 E_NOT_FOUND'
    })
    check('card/:id · 路径穿越 → 400 E_BAD_QUERY', async () => {
      for (const evil of ['../../etc/passwd', '..\\..\\windows\\win.ini', 'C:/Windows/win.ini', '/etc/passwd']) {
        const bad = await panel.handle('card', evil)
        assert(bad.status === 400 || bad.status === 404, `${evil} 返回 ${bad.status}，应为 400/404`)
        eq(bad.body.ok, false, `${evil} ok`)
      }
      return '4 种穿越全部拒绝'
    })
    check('card/:id · 超过 1 MiB → 413 E_TOO_LARGE_FILE', async () => {
      const big = await panel.handle('card', 'topics/huge.md')
      eq(big.status, 413, 'status')
      eq(big.body.error.code, 'E_TOO_LARGE_FILE', 'code')
      return big.body.error.message
    })
  }

  // 4. truncations
  {
    const r = await panel.handle('truncations', { limit: '10' })
    const b = r.body
    check('truncations · 结构', () => {
      eq(r.status, 200, 'status')
      eq(b.ok, true, 'ok')
      eq(b.items.length, 1, 'items.length')
      assert(b.sessionsScanned >= 1, 'sessionsScanned 应 >= 1')
      for (const k of ['id', 'sessionId', 'at', 'beforeBytes', 'afterBytes', 'backup', 'backupSha256', 'savedBytes', 'savedRatio']) has(b.items[0], k, 'truncation item')
      isIso(b.items[0].at, 'truncation.at')
      return `session=${b.items[0].sessionId}`
    })
    check('truncations · 省下的字节与比例', () => {
      eq(b.items[0].savedBytes, 10485760 - 5242880, 'savedBytes')
      eq(b.items[0].savedRatio, 0.5, 'savedRatio')
      return `${b.items[0].savedBytes} B / ${b.items[0].savedRatio}`
    })
    check('truncations · backups + exists 探测', () => {
      eq(b.backups.length, 1, 'backups.length')
      eq(b.backups[0].exists, true, 'backups[0].exists（fixture 里那个 .bak 文件存在）')
      eq(b.backups[0].file, 'session.v4.jsonl.zstd.bak-20261101', 'backups[0].file 只留文件名')
      return b.backups[0].file
    })
    check('truncations · ?session= 过滤 + current', async () => {
      const one = await panel.handle('truncations', { session: sid })
      eq(one.body.items.length, 1, 'items.length')
      assert(one.body.current && one.body.current.bytes > 0, 'current 应带上当前日志大小')
      eq(one.body.current.file, 'session.v4.jsonl.zstd', 'current.file')
      const none = await panel.handle('truncations', { session: 'no-such-session' })
      eq(none.body.items.length, 0, '不存在的 session → 0 条')
      eq(none.body.current, null, '不存在的 session → current null')
      return `current=${one.body.current.bytes} B`
    })
  }

  // 5. filter
  {
    const r = await panel.handle('filter', { limit: '10' })
    const b = r.body
    check('filter · implemented + items', () => {
      eq(r.status, 200, 'status')
      eq(b.ok, true, 'ok')
      eq(b.implemented, true, 'implemented')
      eq(b.items.length, 2, 'items.length')
      eq(b.metrics.total, 2, 'metrics.total')
      return `source=${b.sourceFile}`
    })
    check('filter · 指标与队列', () => {
      eq(b.metrics.by.remember, 1, 'by.remember')
      eq(b.metrics.by.local_only, 1, 'by.local_only')
      eq(b.metrics.queue, 1, 'metrics.queue')
      assert(b.queue.length >= 1, 'queue 不应为空')
      has(b.queue[0], 'unitId', 'queue item')
      return `avgScore=${b.metrics.avgScore}`
    })
    check('filter · local_only 的 excerpt 恒为 null（契约 0.7）', () => {
      const local = b.items.find((x) => x.target === 'local_only')
      eq(local.excerpt, null, 'local_only.excerpt')
      assert(local.excerptHash, '仍应保留 excerptHash 供比对')
      const other = b.items.find((x) => x.target === 'remember')
      assert(other.excerpt && other.excerpt.length > 0, '本地可回放的 excerpt 应保留')
      return `local_only hash=${local.excerptHash}`
    })
    check('filter · dims 带契约要求的 name（缺省按 id 兜底）', () => {
      const remember = b.items.find((x) => x.target === 'remember')
      const names = remember.dims.map((d) => d.name)
      assert(names.every(Boolean), `dims[].name 不应为空：${JSON.stringify(names)}`)
      eq(names[0], '断言性', 'R1 name')
      return names.join(' / ')
    })
    check('filter · 目标过滤 ?target=', async () => {
      const only = await panel.handle('filter', { target: 'remember' })
      eq(only.body.items.length, 1, 'target=remember')
      return 'target=remember → 1 条'
    })
  }

  // 6. recall
  {
    const r = await panel.handle('recall', { limit: '10' })
    const b = r.body
    check('recall · 200 + 只读 + implemented', () => {
      eq(r.status, 200, 'status')
      eq(b.ok, true, 'ok')
      eq(b.readOnly, true, 'readOnly')
      eq(b.implemented, true, 'implemented')
      eq(b.present, true, 'present')
      eq(b.readable, true, 'readable')
      return `source=${b.sourceFile}`
    })
    check('recall · 按时间倒序（12/11/10），坏行跳过', () => {
      eq(b.items.map((x) => x.turn).join(','), '12,11,10', 'turn 顺序')
      eq(b.parseErrors, 1, 'parseErrors')
      isIso(b.items[0].at, 'items[0].at')
      return `12→10，bad=${b.parseErrors}`
    })
    check('recall · 注入条目带 id/title/score/reason', () => {
      const first = b.items[0].injected[0]
      eq(first.id, 'card:recall', 'id')
      eq(first.title, '召回纪律', 'title')
      eq(first.score, 0.87, 'score')
      eq(first.reason, '命中词：召回', 'reason')
      return `${first.title} ${first.score}`
    })
    check('recall · 隐私门拦截与注入分开', () => {
      const oldest = b.items[2]
      eq(oldest.blocked.length, 1, 'blocked.length')
      eq(oldest.blocked[0].title, '凭据片段', 'blocked title')
      eq(oldest.blocked[0].reason, '隐私门：禁止外带', 'blocked reason')
      eq(oldest.injected.length, 2, 'injected.length')
      return `turn 10：${oldest.injected.length} 注入 / ${oldest.blocked.length} 拦截`
    })
    check('recall · 指标（轮次/注入/拦截/会话/最近一次）', () => {
      eq(b.metrics.turns, 3, 'turns')
      eq(b.metrics.injected, 4, 'injected')
      eq(b.metrics.blocked, 1, 'blocked')
      eq(b.metrics.sessions, 2, 'sessions')
      eq(b.metrics.parseErrors, 1, 'metrics.parseErrors')
      assert(b.metrics.lastAt && Date.parse(b.metrics.lastAt) > 0, 'lastAt 应为可解析时间')
      return `turns=${b.metrics.turns} injected=${b.metrics.injected} blocked=${b.metrics.blocked}`
    })
    check('recall · limit 分页（2/3，hasMore）', async () => {
      const one = await panel.handle('recall', { limit: '2' })
      eq(one.body.items.length, 2, 'items.length')
      eq(one.body.page.returned, 2, 'page.returned')
      eq(one.body.page.total, 3, 'page.total')
      eq(one.body.page.hasMore, true, 'page.hasMore')
      eq(one.body.items.map((x) => x.turn).join(','), '12,11', '只取最近两轮')
      return '12,11 + hasMore'
    })
    check('recall · limit 上限夹取', async () => {
      const big = await panel.handle('recall', { limit: '999' })
      eq(big.body.page.clamped, true, 'clamped')
      eq(big.body.page.limit, 100, 'limit')
      return 'clamp → 100'
    })
    check('recall · 日志不存在 → 200 空态，不是 404', async () => {
      const other = createPanel({ memoryRoot: join(FIXTURE, 'memory-no-recall'), sessionsRoot: SESSIONS })
      const e = await other.handle('recall', {})
      eq(e.status, 200, 'status')
      eq(e.body.ok, true, 'ok')
      eq(e.body.present, false, 'present')
      eq(e.body.items.length, 0, 'items.length')
      eq(e.body.metrics.turns, 0, 'metrics.turns')
      assert(e.body.note && e.body.note.includes('还没有召回日志'), '应给出「还没有召回日志」的说明')
      return '缺文件 → 200 空态'
    })
    check('recall · 空文件 → 200 present 空态', async () => {
      const other = createPanel({ memoryRoot: join(FIXTURE, 'memory-empty'), sessionsRoot: SESSIONS })
      const e = await other.handle('recall', {})
      eq(e.status, 200, 'status')
      eq(e.body.present, true, 'present')
      eq(e.body.items.length, 0, 'items.length')
      eq(e.body.parseErrors, 0, 'parseErrors')
      assert(e.body.note && e.body.note.includes('还没有任何一轮记录'), '应说明文件为空')
      return '空文件 → 200 空态'
    })
  }

  // 7. shadow
  {
    const r = await panel.handle('shadow', { limit: '10' })
    const b = r.body
    check('shadow · mode + files + items', () => {
      eq(r.status, 200, 'status')
      eq(b.ok, true, 'ok')
      eq(b.mode, 'shadow', 'mode 取自 router-runtime.jsonl 最后一条')
      eq(b.modeSource, 'router-runtime.jsonl', 'modeSource')
      eq(b.files.length, 2, 'files.length（router + decisions）')
      eq(b.items.length, 3, 'items.length（router 1 + decisions 2）')
      for (const k of ['id', 'source', 'ts', 'subject', 'action', 'status']) has(b.items[0], k, 'shadow item')
      return `files=${b.files.map((f) => f.path).join(', ')}`
    })
    check('shadow · call.args 绝不回传，secret 不外泄', () => {
      const text = JSON.stringify(b)
      assert(!text.includes('sk-should-never-leak'), '响应里出现了 secret 值')
      assert(!text.includes('"args"'), '响应里出现了 call.args')
      assert(!text.includes('"api_key"'), '响应里出现了 api_key 键')
      return '没有 args / 没有 secret'
    })
    check('shadow · utterance 打码：默认 80 字 + hash', () => {
      const router = b.items.find((x) => x.source === 'router')
      assert(router.utteranceHash && /^[0-9a-f]{8}$/.test(router.utteranceHash), `utteranceHash 应 8 位 hex，实际 ${router.utteranceHash}`)
      return `${router.callText}… hash=${router.utteranceHash}`
    })
    check('shadow · 真实 runtime 嵌套字段映射', () => {
      const router = b.items.find((x) => x.source === 'router')
      eq(router.subject, 'memory_save', 'subject ← tool')
      eq(router.action, 'allow', 'action ← guard/needsHuman 推导')
      eq(router.level, 'L1', 'level ← decision.level')
      eq(router.matchedRule, 'memory-write-default', 'matchedRule ← decision.matchedRule')
      eq(router.confidence, 0.82, 'confidence ← decision.confidence')
      eq(router.status, 'ok', 'status ← outcome.status')
      eq(router.totalMs, 176.018, 'totalMs ← outcome.ms')
      assert(router.raw && typeof router.raw === 'object', 'raw 应存在（契约 §6）')
      eq(router.raw.decision.matchedRule, 'memory-write-default', 'raw.decision.matchedRule')
      eq(router.raw.outcome.status, 'ok', 'raw.outcome.status')
      return `${router.subject}/${router.action}/${router.level}`
    })
    check('shadow · metrics 聚合', () => {
      eq(b.metrics.router.total, 1, 'router.total')
      eq(b.metrics.router.allow, 1, 'router.allow')
      eq(b.metrics.maf.total, 2, 'maf.total（decisions 两行）')
      eq(b.metrics.maf.byTarget.remember, 1, 'maf.byTarget.remember')
      eq(b.metrics.maf.avgConfidence, 0, 'maf.avgConfidence（决策行没有 confidence）')
      assert(Array.isArray(b.metrics.byRule) && b.metrics.byRule.length >= 1, 'byRule 应非空')
      return `byAction=${b.metrics.byAction.map((x) => `${x.action}:${x.count}`).join(',')}`
    })
    check('shadow · 同时合并顶层与 .longlive 两份 runtime', async () => {
      const source = [
        JSON.stringify({
          ts: iso(0, 60000),
          mode: 'on',
          tool: 'memory_recall',
          call: { text: '第二份 runtime' },
          decision: { matchedRule: 'second-source', ruleId: 'second-source', target: 'topics', level: 'L2', needsHuman: false, confidence: 0.5, errors: [] },
          guard: { verdict: 'allow', reason: null },
          risk: { level: 'none', reasons: [] },
          outcome: { status: 'ok', ms: 1.5 },
        }),
        '',
      ].join('\n')
      await mkdir(join(MEMORY, '.longlive'), { recursive: true })
      await writeFile(join(MEMORY, '.longlive', 'router-runtime.jsonl'), source, 'utf8')
      const r2 = await panel.handle('shadow', { limit: '10' })
      const b2 = r2.body
      eq(b2.files.length, 3, 'files.length（两份 router + decisions）')
      eq(b2.items.filter((x) => x.source === 'router').length, 2, 'router 两份都应并入 items')
      eq(b2.mode, 'on', 'mode 取最新一条')
      eq(b2.modeSource, '.longlive/router-runtime.jsonl', 'modeSource 应指向较新的 .longlive 文件')
      return b2.files.map((f) => f.path).join(', ')
    })
  }

  // 8. 常驻 Router（只读窗口）
  {
    check('router · 缺 status.json → 未启用且不报错', async () => {
      const p = createPanel({ memoryRoot: join(FIXTURE, 'no-router-memory'), sessionsRoot: SESSIONS })
      const r = await p.handle('router', {})
      eq(r.status, 200, 'status')
      const b = r.body
      eq(b.ok, true, 'ok')
      eq(b.readOnly, true, 'readOnly')
      eq(b.enabled, false, 'enabled')
      eq(b.status, null, 'status')
      eq(b.board, null, 'board')
      eq(b.warnings.length, 0, 'warnings')
      assert(b.notes.length >= 1 && /未安装|未启用/.test(b.notes[0]), `notes 应说明未启用：${JSON.stringify(b.notes)}`)
      return b.notes[0].slice(0, 40)
    })

    const r = await panel.handle('router', {})
    const b = r.body
    check('router · status v2 字段（布尔 / provider 两态 / queue 五键）', () => {
      eq(r.status, 200, 'status')
      eq(b.ok, true, 'ok')
      eq(b.readOnly, true, 'readOnly')
      eq(b.enabled, true, 'enabled')
      eq(b.status.state, 'degraded', 'state')
      assert(typeof b.status.lastTickAt === 'string' && /T.*Z$/.test(b.status.lastTickAt) && Number.isFinite(Date.parse(b.status.lastTickAt)), `lastTickAt 应是 ISO 原文：${b.status.lastTickAt}`)
      assert(b.status.nextTickAt != null, 'nextTickAt')
      eq(b.status.model.auto, true, 'model.auto 必须是 boolean')
      eq(b.status.agentMode, false, 'agentMode 必须是 boolean')
      eq(b.status.provider.configured, true, 'provider.configured')
      eq(b.status.provider.missing, false, 'provider.missing')
      eq(Object.keys(b.status.provider).sort().join(','), 'configured,missing', 'provider 只有两个布尔')
      eq(b.status.model.resolved, undefined, 'model 出口不带 resolved')
      eq(b.status.model.resolvedAt, undefined, 'model 出口不带 resolvedAt')
      eq(b.status.askQueue, undefined, '不再有 askQueue')
      eq(JSON.stringify(b.status.tickQueue), JSON.stringify({ pending: 3, invalid: 1, oldestAgeMs: 600000 }), 'tickQueue 是运行队列')
      eq(JSON.stringify(b.status.queue), JSON.stringify({ pending: 2, queued: 1, applying: 0, blockedOnUser: 1, expired: 3 }), 'queue 正好五键')
      eq(Object.keys(b.status.queue).sort().join(','), 'applying,blockedOnUser,expired,pending,queued', 'queue 不多不少五键')
      assert(b.status.lease.heldMs > 0, `lease.heldMs 应由 since 计算：${b.status.lease.heldMs}`)
      eq(b.status.lease.holder, 'q-0041', 'lease.holder')
      eq(b.status.wal.lastSeq, 99, 'wal.lastSeq')
      eq(b.status.shared.liveRows, 2, 'shared.liveRows')
      eq(b.status.shared.unknownSessions, 1, 'shared.unknownSessions')
      return `auto=${b.status.model.auto} queue=${JSON.stringify(b.status.queue)}`
    })

    check('router · board 焦点三字段 + pulse 新名', () => {
      eq(b.board.seq, 17, 'seq')
      eq(b.board.focus.length, 2, 'focus.length')
      eq(Object.keys(b.board.focus[0]).sort().join(','), 'goal,sessionId,updatedAt', 'focus 只出三字段')
      eq(b.board.focus[0].goal, '跑 self-test', 'focus.goal')
      eq(b.board.focus[0].state, undefined, 'focus 不带 state')
      eq(b.board.focus[0].ageMs, undefined, 'focus 不带 ageMs')
      eq(b.board.timeline.length, 1, 'timeline.length')
      eq(b.board.pulse.active, 2, 'pulse.active')
      eq(b.board.pulse.unknownSessions, 1, 'pulse.unknownSessions')
      eq(b.board.pulse.queuedProposals, 2, 'pulse.queuedProposals')
      eq(b.board.pulse.blockedOnUser, 1, 'pulse.blockedOnUser')
      eq(b.board.pulse.readyProposals, 1, 'pulse.readyProposals')
      eq(b.board.pulse.queueHead, 'q-0042', 'pulse.queueHead')
      eq(b.board.pulse.lease.holder, 'q-0041', 'pulse.lease')
      eq(b.board.pulse.pendingProposals, undefined, '旧名 pendingProposals 不再出口')
      eq(b.board.pulse.writerLocked, undefined, '旧名 writerLocked 不再出口')
      eq(b.board.source.proposals, 4, 'source.proposals')
      return `focus=${b.board.focus.length} timeline=${b.board.timeline.length}`
    })

    check('router · 提案 counts/排序/最老等待/安全字段', () => {
      eq(b.proposals.source, 'proposals', 'source')
      eq(b.proposals.counts.total, 4, 'total')
      eq(b.proposals.counts.pending, 1, 'pending')
      eq(b.proposals.counts.approved, 1, 'approved')
      eq(b.proposals.counts.conflict, 1, 'conflict')
      eq(b.proposals.counts.done, 1, 'done')
      eq(b.proposals.items[0].status, 'pending', 'pending 排最前')
      eq(b.proposals.items[0].id, 'tp-pending-old', '最老 pending 的 id')
      assert(b.proposals.oldestAgeMs >= 600000, `oldestAgeMs=${b.proposals.oldestAgeMs}`)
      eq(b.proposals.items[0].ticket, 'q-0040', 'ticket')
      eq(b.proposals.items[0].op, 'topic.update', 'op')
      eq(b.proposals.items[0].priority, 2, 'priority')
      assert(b.proposals.items[0].deadlineAt, 'deadlineAt')
      eq(b.proposals.items.find((x) => x.id === 'tp-conflict').attempts, 3, 'attempts')
      return b.proposals.items.map((x) => `${x.id}:${x.status}`).join(' ')
    })

    check('router · 提案正文/理由/baseSha 不回传', () => {
      const text = JSON.stringify(b)
      for (const sentinel of ['SECRET ROUTER BODY MUST NOT LEAK', 'fixture rationale', 'fixture-base-sha']) {
        assert(!text.includes(sentinel), `响应里出现了 ${sentinel}`)
      }
      for (const key of ['content', 'rationale', 'baseSha', 'evidence', 'resolved', 'candidates']) {
        assert(!text.includes(`"${key}"`), `响应里出现了字段 ${key}`)
      }
      return '正文/理由/baseSha/证据/模型名均未出口'
    })

    check('router · alerts 严重级三值 + warnings 开放枚举', () => {
      eq(b.alerts.length, 3, 'alerts.length')
      eq(b.alerts.map((a) => a.severity).sort().join(','), 'error,info,warn', 'severity 只有 info/warn/error')
      eq(b.alerts[0].code, 'QUEUE_STARVATION', 'alerts[0].code')
      eq(b.alerts[0].message, 'fixture queue starving', 'alerts[0].message')
      eq(b.warnings.length, 3, 'warnings 条数 = Router 给的条数（含未知码）')
      eq(b.warnings.map((w) => w.code).join(','), 'QUEUE_STARVATION,CREDENTIAL_RISK,FUTURE_UNKNOWN_CODE', '顺序原样保留')
      const unknown = b.warnings.find((w) => w.code === 'FUTURE_UNKNOWN_CODE')
      eq(unknown.known, false, '未知码 known=false')
      eq(unknown.label, 'FUTURE_UNKNOWN_CODE', '未知码原样展示')
      const known = b.warnings.find((w) => w.code === 'QUEUE_STARVATION')
      eq(known.known, true, '已知码 known=true')
      assert(known.label && known.label !== 'QUEUE_STARVATION', `已知码应给中文文案：${known.label}`)
      eq(b.boardWarnings.length, 2, 'boardWarnings 单列')
      eq(b.boardWarnings[0].code, 'BOARD_STALE', 'boardWarnings 来自 board.warnings')
      eq(b.boardWarnings[0].source, 'board.warnings', 'boardWarnings 来源标记')
      return b.warnings.map((w) => `${w.code}:${w.known}`).join(',')
    })

    check('router · HTTP GET /router 200 只读', async () => {
      const h = await get(panel, '/api/longlive-panel/router')
      eq(h.status, 200, 'status')
      eq(h.json.ok, true, 'ok')
      eq(h.json.readOnly, true, 'readOnly')
      return '200, readOnly'
    })
  }

  // 9. HTTP 层
  {
    check('http · GET /summary 200 + no-store', async () => {
      const r = await get(panel, '/api/longlive-panel/summary')
      eq(r.status, 200, 'status')
      eq(r.json.ok, true, 'ok')
      eq(r.headers['cache-control'], 'no-store', 'cache-control')
      assert(/application\/json/.test(r.headers['content-type']), 'content-type')
      return '200, no-store'
    })
    check('http · GET /card/topics%2Falpha.md 200', async () => {
      const r = await get(panel, '/api/longlive-panel/card/topics%2Falpha.md')
      eq(r.status, 200, 'status')
      eq(r.json.id, 'topics/alpha.md', 'id')
      return '200'
    })
    check('http · If-None-Match 命中 → 304', async () => {
      const first = await get(panel, '/api/longlive-panel/card/topics%2Falpha.md')
      const second = await get(panel, '/api/longlive-panel/card/topics%2Falpha.md', { headers: { 'if-none-match': first.headers.etag } })
      eq(second.status, 304, 'status')
      eq(second.body === undefined || second.body === '', true, '304 无正文')
      return first.headers.etag
    })
    check('http · GET /recall 200 只读（limit 生效）', async () => {
      const r = await get(panel, '/api/longlive-panel/recall?limit=2')
      eq(r.status, 200, 'status')
      eq(r.json.ok, true, 'ok')
      eq(r.json.readOnly, true, 'readOnly')
      eq(r.json.items.length, 2, 'items.length')
      eq(r.json.page.hasMore, true, 'page.hasMore')
      return '200, readOnly, limit=2'
    })
    check('http · 未知路由 → 404 E_NOT_FOUND', async () => {
      const r = await get(panel, '/api/longlive-panel/nope')
      eq(r.status, 404, 'status')
      eq(r.json.error.code, 'E_NOT_FOUND', 'code')
      const root = await get(panel, '/api/longlive-panel')
      eq(root.status, 404, '裸前缀也 404')
      return '404'
    })
    check('http · 非 GET/HEAD → 405 E_METHOD_NOT_ALLOWED', async () => {
      const res = mockRes()
      await panel.handleHttp({ method: 'POST', url: '/api/longlive-panel/summary', headers: {} }, res)
      eq(res.statusCode, 405, 'status')
      eq(JSON.parse(res.body).error.code, 'E_METHOD_NOT_ALLOWED', 'code')
      eq(res.headers.allow, 'GET, HEAD', 'allow 只声明 GET/HEAD')
      const opt = mockRes()
      await panel.handleHttp({ method: 'OPTIONS', url: '/api/longlive-panel/summary', headers: {} }, opt)
      eq(opt.statusCode, 405, 'OPTIONS 也是 405')
      eq(opt.headers.allow, 'GET, HEAD', 'OPTIONS 只回 Allow')
      eq(opt.headers['content-length'], '0', 'OPTIONS 不回错误体')
      return '405'
    })
    check('http · HEAD 不写正文', async () => {
      const res = mockRes()
      await panel.handleHttp({ method: 'HEAD', url: '/api/longlive-panel/summary', headers: {} }, res)
      eq(res.statusCode, 200, 'status')
      eq(res.body, '', 'HEAD body')
      return `content-length=${res.headers['content-length']}`
    })
  }

  // 10. 纯函数
  {
    const { normalizeRel, parseFrontmatter } = await import('./src/server.js')
    check('normalizeRel · 拒绝一切越界写法', () => {
      const bad = ['../x', 'a/../../b', '/abs', 'C:\\x', '\\\\server\\share', 'a/\0b', '']
      const survived = bad.filter((x) => normalizeRel(x) !== null)
      assert(survived.length === 0, `这些没被拒绝：${JSON.stringify(survived)}`)
      eq(normalizeRel('topics\\a.md'), 'topics/a.md', '反斜杠归一')
      eq(normalizeRel('./topics//a.md'), 'topics/a.md', '多余的 . 与 //')
      return '8 种越界全拒绝'
    })
    check('parseFrontmatter · 数字/布尔/列表/引号', () => {
      const { frontmatter, body } = parseFrontmatter('---\na: 1\nb: true\nc: [x, y]\nd: "q"\n---\n# T\n\nbody\n')
      eq(frontmatter.a, 1, 'a')
      eq(frontmatter.b, true, 'b')
      eq(frontmatter.c.join(','), 'x,y', 'c')
      eq(frontmatter.d, 'q', 'd')
      eq(body, '# T\n\nbody\n', 'body')
      return JSON.stringify(frontmatter)
    })
  }

  // 11. fixture 自检：只有真的文件才算数
  {
    const st = await stat(join(MEMORY, 'topics/alpha.md'))
    check('fixture · 文件确实落在 plugin/.fixture 下', () => eq(st.isFile(), true, 'alpha.md'))
  }

  console.log('')
  await chain
  console.log('')
  console.log(`结果：${pass} PASS · ${failed} FAIL${KEEP ? ' · fixture 已保留' : ''}`)
  if (failed) {
    console.log('失败明细：')
    for (const f of failures) console.log(`  - ${f}`)
  }
  if (!KEEP) await rm(FIXTURE, { recursive: true, force: true })
  process.exitCode = failed ? 1 : 0
}

main().catch(async (e) => {
  console.error('self-test 崩了：', e && e.stack ? e.stack : e)
  if (!KEEP) await rm(FIXTURE, { recursive: true, force: true }).catch(() => {})
  process.exitCode = 1
})
