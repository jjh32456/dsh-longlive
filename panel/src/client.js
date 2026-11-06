/**
 * dsh-longlive-panel · 客户端（Client 半边）
 *
 * 以 dsh.client bundle 格式加载（与 dsh-meme / dsh-dream 同款）：
 *   window.__ModuleLoader__.load({ id, factory })
 * 注册 id 必须等于包名 dsh-longlive-panel，否则 ModuleLoader 报
 * "loaded without registering dsh-longlive-panel"。
 *
 * 挂两处：
 *   - sidebar.panellist：侧栏入口（图标 + label）
 *   - main：整页面板，七个页签（六层视图 / 过滤器决策 / 影子记录 / 常驻 Router / 本轮想起 / 截断记录 / 使用说明；截断记录是维护页）
 *
 * 数据一律走宿主侧只读路由 /api/longlive-panel/*。
 * 拿不到时退回本文件里的 SAMPLE，并在页头挂「样例」标——不许把样例当真数据展示。
 */

window.__ModuleLoader__.load({
  id: '@jjh32456/dsh-longlive-panel',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useCallback, useRef } = React

    const API = '/api/longlive-panel'
    const PANEL_ID = '@jjh32456/dsh-longlive-panel'
    const PANEL_LABEL = '潜望镜'
    const PANEL_ORDER = 42
    // 版本号不手写：构建脚本打包时会把版本占位符替换成 package.json 的 version。
    // 页头优先用服务端 summary.version（它来自同一个 package.json），这里只是接口未回来时的兜底。
    const PLUGIN_VERSION = '__DSH_PLUGIN_VERSION__'

    // 第七页签「使用说明」放最后：只给人看，不取接口、不带计数。
    // 截断记录是维护页，放在数据页末尾、使用说明之前；id 不变，只调显示顺序。
    const TABS = [
      { id: 'palace', label: '六层视图', unit: '层' },
      { id: 'filter', label: '过滤器决策', unit: '条' },
      { id: 'shadow', label: '影子记录', unit: '条' },
      { id: 'router', label: '常驻 Router', unit: '条' },
      { id: 'recall', label: '本轮想起', unit: '轮' },
      { id: 'trunc', label: '截断记录', unit: '次' },
      { id: 'help', label: '使用说明', unit: '' },
    ]

    // ------------------------------------------------------------------
    // 样例（只在接口不可用 / 尚未实装时展示，页头会挂「样例」标）
    // ------------------------------------------------------------------

    const SAMPLE = {
      generatedAt: '2026-11-03T13:20:04.221Z',
      freshness: { indexBuiltAt: '2026-11-03T05:38:44.963Z', lastConsolidated: null, auditLastAt: '2026-11-03T05:38:44.963Z' },
      totals: { cards: 13, journalMonths: 2, procedures: 0, live: 10, liveRunning: 2, liveStale: 1, liveDead: 0, backups: 3, truncations: 1, filterDecisions: 0, shadowRecords: 6 },
      layers: [
        { id: 'working', index: 1, name: '工作记忆', path: '.longlive/live/ + sessions/**', count: 10, unit: '活体', health: 'warn', note: '活体心跳不是记忆；已归档行不当记忆读' },
        { id: 'episodic', index: 2, name: '情景记忆', path: 'journal/YYYY-MM.md', count: 2, unit: '月', health: 'ok', note: '主脑手写，按月份归档' },
        { id: 'semantic', index: 3, name: '语义记忆', path: 'topics/*.md + engram 一句', count: 13, unit: '卡', health: 'ok', note: 'salience 唯一权威在卡 frontmatter' },
        { id: 'procedural', index: 4, name: '程序性记忆', path: 'procedures/*.md', count: 0, unit: '卡', health: 'empty', note: '目录不存在；engram kind=skill 只放指针' },
        { id: 'index', index: 5, name: '索引与召回', path: 'INDEX.md 生成段 + bin/recall.mjs', count: 13, unit: '卡已索引', health: 'ok', note: '最近一次 memory_index：cards=15 legacy=0' },
        { id: 'archive', index: 6, name: '归档与封存', path: 'epochs/ · archive/ · tombstones.md', count: 0, unit: '封存卡', health: 'empty', note: '还没有被归档的条目；归档理由记在 tombstones.md' },
      ],
      live: [
        { sessionId: 'session-9f3c1a2b4d5e6f708192', shortId: '9f3c1a2b', state: 'running', turn: 12, heartbeatAgeMs: 4200, ttlMs: 60000, goal: '做潜望镜面板原型', blockedOn: null, lastAction: { at: '2026-11-03T13:19:58.100Z', kind: 'tool', detail: 'tool/write DESIGN.md' } },
        { sessionId: 'session-e219dedfa08a4eed9cd2ef49', shortId: 'e219dedf', state: 'running', turn: 231, heartbeatAgeMs: 12000, ttlMs: 60000, goal: '听澜主会话', blockedOn: null, lastAction: { at: '2026-11-03T13:19:52.672Z', kind: 'turn', detail: 'turn/start #231' } },
      ],
      truncations: [
        { id: 'session-e219dedf@2026-11-01T14:28:06.280Z', sessionId: 'session-e219dedf-a08a-4eed-9cd2-ef49cec29258', at: '2026-11-01T14:28:06.280Z', beforeBytes: 5030747, afterBytes: 3192946, beforeEvents: 12053, afterEvents: 11490, cutSeq: 0, cutTurn: 1, backup: 'session.v4.jsonl.zstd.bak-20261101-2', backupSha256: '8d9c2ed7372dfee235a9ef9d48ddb34cddffce6881e53e1cd9c488ce92ae2ebf', savedBytes: 1837801, savedRatio: 0.365 },
      ],
      backups: [
        { sessionId: 'session-e219dedf-a08a-4eed-9cd2-ef49cec29258', file: 'session.v4.jsonl.zstd.bak-20261101-2', size: 5030747, createdAt: '2026-11-01T14:28:05.455Z', exists: true, deletable: false },
      ],
      filter: {
        implemented: false,
        preview: true,
        items: [
          { ts: '2026-11-02T09:12:31.004Z', unitId: 'a3f19c2d8e4b7061', turn: 88, target: 'remember', score: 7, needsHuman: false, privacy: { verdict: 'pass' }, excerpt: '截断前先备份，备份 sha256 记进 truncate.json，回滚时按 sha 校验……', dims: [{ id: 'R1', score: 2, max: 2, why: '含明确结论句' }, { id: 'R2', score: 1, max: 2, why: '跨 3 个项目可复用' }] },
          { ts: '2026-11-02T10:03:44.120Z', unitId: 'c81d4e2a67b0f395', turn: 104, target: 'human', score: 4, needsHuman: true, privacy: { verdict: 'pass' }, excerpt: '侧栏要显示……', dims: [{ id: 'R1', score: 1, max: 2, why: '半结论' }] },
        ],
        metrics: { total: 2, by: { remember: 1, archive_only: 0, human: 1, local_only: 0 }, queue: 1, privacyBlocked: 0, avgScore: 5.5 },
        queue: [{ unitId: 'c81d4e2a67b0f395', ts: '2026-11-02T10:03:44.120Z', score: 4, target: 'human', reason: '3–5 分区间' }],
      },
      shadow: {
        mode: 'shadow',
        modeSource: 'router-runtime.jsonl',
        files: [{ path: 'router-runtime.jsonl', lines: 4 }, { path: 'decisions-2026-11-03.jsonl', lines: 2 }],
        items: [
          { id: 'router:3', source: 'router', ts: '2026-11-03T12:58:01.120Z', subject: 'memory_save', action: 'allow', level: 'L1', matchedRule: 'memory-write-default', confidence: 0.82, needsHuman: false, guard: { verdict: 'allow', reason: null }, risk: { level: 'none', reasons: [] }, status: 'ok', totalMs: 176.018, errors: [], callText: '准备把今天的结论写进 engram' },
          { id: 'router:2', source: 'router', ts: '2026-11-03T12:57:40.006Z', subject: 'session_truncate', action: 'ask', level: 'L2', matchedRule: 'destructive-file-op', confidence: 0.91, needsHuman: true, guard: { verdict: 'ask', reason: '确认词缺失：需要显式 TRUNCATE' }, risk: { level: 'medium', reasons: ['writes session log', 'rewrites seq'] }, status: 'ok', totalMs: 42.118, errors: [], callText: '截断这个会话的日志到 2 万事件以内' },
        ],
        metrics: { router: { total: 2, allow: 1, deny: 0, ask: 1, needsHuman: 1, guardReject: 0, avgTotalMs: 109.1 }, maf: { total: 2, byAction: { allow: 1, ask: 1 }, byRule: { 'L2-decision': 1, ambiguous: 1 }, needsHuman: 2 }, byRule: [{ rule: 'memory-write-default', count: 1 }, { rule: 'destructive-file-op', count: 1 }], byAction: [{ action: 'allow', count: 1 }, { action: 'ask', count: 1 }] },
      },
      router: {
        ok: true,
        readOnly: true,
        enabled: true,
        present: { status: true, board: true, proposals: true },
        paths: { status: '/.longlive/router/status.json', board: '/.longlive/router/board.json', proposals: '/.longlive/router/proposals/' },
        status: {
          state: 'running',
          reason: null,
          since: '2026-11-03T09:00:00.000Z',
          runId: 'run-2026-11-03-a',
          provider: { configured: true, missing: false },
          model: { auto: true },
          autonomy: 'ask',
          agentMode: false,
          lastTickAt: '2026-11-03T13:20:00.000Z',
          nextTickAt: '2026-11-03T13:25:00.000Z',
          heartbeatAt: '2026-11-03T13:20:02.000Z',
          today: { day: '2026-11-03', usedTokens: 182400, reservedTokens: 0, capTokens: 400000, ratio: 0.456 },
          run: { usedTokens: 31200, capTokens: 120000, ratio: 0.26 },
          tickQueue: { pending: 2, invalid: 0, oldestAgeMs: 420000 },
          queue: { pending: 1, queued: 1, applying: 0, blockedOnUser: 1, expired: 0 },
          board: { seq: 42, generatedAt: '2026-11-03T13:19:58.000Z', activeSessions: 2, unknownSessions: 1, focusVisible: 2, stale: false },
          proposals: {
            doneToday: 3,
            conflicts: 1,
            superseded: 0,
            queue: {
              seqCounter: 42,
              depth: 3,
              etaMs: 36000,
              starvation: false,
              writer: { ticket: 'q-0042', proposalId: 'tp-20261103-a2', sessionId: 'session-9f3c1a2b4d5e6f708192', since: '2026-11-03T13:19:20.000Z' },
              blocked: [{ ticket: 'q-0039', reason: '目标文件被另一个会话改过，等待重排', since: '2026-11-03T13:10:00.000Z' }],
            },
          },
          lease: { active: true, holder: 'q-0042', since: '2026-11-03T13:19:20.000Z', heldMs: 42000, renewals: 1, expiresAt: '2026-11-03T13:21:20.000Z' },
          wal: { lastSeq: 812, lastAt: '2026-11-03T13:19:58.000Z', bytes: 145233, segments: 1, broken: false },
          wake: { enabled: false, lastAttemptAt: null, todayCount: 0, cooldownRemainingMs: 0, lastError: null },
          shared: { hintTokensLast: 380, injectedTurns: 12, injectedTokensToday: 4200, skipped: 1, readyProposals: 1, lastInjectAt: '2026-11-03T13:18:00.000Z', lastInjectSha256: 'ab12cd34ef56ab78', liveRows: 2, unknownSessions: 1 },
          lastError: null,
          lastReport: { at: '2026-11-03T13:20:00.000Z', summary: '本轮 tick 完成：重建共享板，读取 2 个提案。' },
          files: { vault: 'H:/dsh-memory', board: 'H:/dsh-memory/.longlive/router/board.json', audit: 'H:/dsh-memory/.longlive/router/audit.jsonl' },
        },
        board: {
          seq: 42,
          generatedAt: '2026-11-03T13:19:58.000Z',
          source: { liveRows: 2, proposals: 2, scanMs: 37 },
          focus: [
            { sessionId: 'session-e219dedfa08a4eed9cd2ef49', goal: '把只读窗口接到 v2.3 契约上', updatedAt: '2026-11-03T13:19:10.000Z' },
            { sessionId: 'session-9f3c1a2b4d5e6f708192', goal: '等主人确认一条提案', updatedAt: '2026-11-03T13:12:00.000Z' },
          ],
          timeline: [
            { at: '2026-11-03T13:12:00.000Z', kind: 'handover', sessionId: 'session-e219dedfa08a4eed9cd2ef49', ref: 'card-20261103-a', summary: '交接：面板只读窗口先接 status/board，提案不显示正文。' },
          ],
          pulse: { active: 2, running: 1, blocked: 1, unknownSessions: 1, queuedProposals: 1, approvedProposals: 1, blockedOnUser: 1, readyProposals: 1, queueHead: 'q-0042', lease: { active: true, holder: 'q-0042', expiresAt: '2026-11-03T13:21:20.000Z' }, lastApplyAt: '2026-11-03T12:58:00.000Z' },
          warnings: ['BOARD_STALE'],
          hash: '9ce1…41af',
        },
        proposals: {
          source: 'proposals',
          countsFrom: 'proposals',
          counts: { pending: 1, approved: 1, applying: 0, done: 1, conflict: 1, rejected: 0, rolled_back: 0, superseded: 0, other: 0, total: 4 },
          oldestAgeMs: 420000,
          items: [
            { id: 'tp-20261103-a1', ticket: 'q-0040', op: 'append', status: 'pending', statusLabel: '待主人确认', tone: 'warn', priority: 2, effectivePriority: 2, attempts: 0, deadlineAt: '2026-11-03T14:00:00.000Z', originSessionId: 'session-e219dedfa08a4eed9cd2ef49', target: 'topics/panel.md', title: '补一条面板只读边界', risk: 'low', ageMs: 420000, createdAt: '2026-11-03T13:13:00.000Z', updatedAt: '2026-11-03T13:13:00.000Z' },
            { id: 'tp-20261103-a2', ticket: 'q-0042', op: 'replace', status: 'approved', statusLabel: '已批准，等执行', tone: 'solid', priority: 1, effectivePriority: 1, attempts: 1, deadlineAt: '2026-11-03T13:40:00.000Z', originSessionId: 'session-9f3c1a2b4d5e6f708192', target: 'journal/2026-11.md', title: '记录一次共享板重建', risk: 'medium', ageMs: 90000, createdAt: '2026-11-03T13:18:30.000Z', updatedAt: '2026-11-03T13:19:00.000Z' },
            { id: 'tp-20261103-a3', ticket: 'q-0041', op: 'append', status: 'conflict', statusLabel: '冲突', tone: 'bad', priority: 3, effectivePriority: 3, attempts: 3, deadlineAt: null, originSessionId: 'session-9f3c1a2b4d5e6f708192', target: 'topics/panel.md', title: '同一段被另一个会话改过', risk: 'medium', ageMs: 180000, createdAt: '2026-11-03T13:16:00.000Z', updatedAt: '2026-11-03T13:17:00.000Z' },
            { id: 'tp-20261103-a4', ticket: 'q-0038', op: 'append', status: 'done', statusLabel: '已完成', tone: 'ok', priority: 2, effectivePriority: 2, attempts: 1, deadlineAt: null, originSessionId: 'session-e219dedfa08a4eed9cd2ef49', target: 'STATE.md', title: '更新状态卡', risk: 'low', ageMs: 1800000, createdAt: '2026-11-03T12:50:00.000Z', updatedAt: '2026-11-03T12:52:00.000Z' },
          ],
          limit: 50,
          total: 4,
          truncated: false,
          unreadable: 0,
        },
        alerts: [
          { code: 'QUEUE_STARVATION', severity: 'warn', message: '提案队列最老一条已等 7 分钟，可能没有写者在推进。', at: '2026-11-03T13:20:00.000Z' },
          { code: 'BLOCKED_ON_USER_EXPIRED', severity: 'error', message: '一条提案在「等人裁决」停留超过 24 小时，请主人处理。', at: '2026-11-03T13:20:00.000Z' },
        ],
        warnings: [
          { code: 'QUEUE_STARVATION', known: true, label: '队列可能饿死', detail: '面板只展示 Router 给的码与条数，不用自己的阈值判断。', source: 'status.warnings' },
          { code: 'PANEL_SAMPLE_UNKNOWN', known: false, label: 'PANEL_SAMPLE_UNKNOWN', detail: '样例里的未知码：原样显示并计入条数，不白名单过滤、不丢弃。', source: 'status.warnings' },
        ],
        boardWarnings: [
          { code: 'BOARD_STALE', known: true, label: '共享板过期', detail: 'board.json 没有按时重建，焦点可能不是最新的（样例）。', source: 'board.warnings' },
        ],
        notes: [],
      },
    }

    // ------------------------------------------------------------------
    // fetch
    // ------------------------------------------------------------------

    async function apiGet(path, signal) {
      const res = await fetch(`${API}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal,
        cache: 'no-store',
        credentials: 'same-origin',
      })
      let json = null
      try {
        json = await res.json()
      } catch {
        json = null
      }
      if (!res.ok || !json || json.ok === false) {
        const code = json && json.error ? json.error.code : `HTTP_${res.status}`
        const err = new Error(code)
        err.code = code
        throw err
      }
      return json
    }

    function useRemote(path, enabled) {
      const [state, setState] = useState({ data: null, error: null, loading: true })
      const [nonce, setNonce] = useState(0)
      useEffect(() => {
        if (!enabled) {
          setState({ data: null, error: null, loading: false })
          return undefined
        }
        const ctrl = typeof AbortController === 'function' ? new AbortController() : null
        let alive = true
        setState((s) => ({ data: s.data, error: null, loading: true }))
        apiGet(path, ctrl ? ctrl.signal : undefined)
          .then((data) => {
            if (alive) setState({ data, error: null, loading: false })
          })
          .catch((e) => {
            if (alive && e.name !== 'AbortError') setState({ data: null, error: e.code || e.message || 'E_FETCH', loading: false })
          })
        return () => {
          alive = false
          if (ctrl) ctrl.abort()
        }
      }, [path, enabled, nonce])
      return [state, useCallback(() => setNonce((n) => n + 1), [])]
    }

    // ------------------------------------------------------------------
    // 小工具
    // ------------------------------------------------------------------

    function fmtBytes(n) {
      if (n == null || !Number.isFinite(Number(n))) return '—'
      const v = Number(n)
      if (v < 1024) return `${v} B`
      if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
      if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`
      return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`
    }

    function fmtAge(ms) {
      if (ms == null || !Number.isFinite(Number(ms))) return '—'
      const s = Math.round(Number(ms) / 1000)
      if (s < 60) return `${s}s`
      if (s < 3600) return `${Math.round(s / 60)}m`
      if (s < 86400) return `${Math.round(s / 3600)}h`
      return `${Math.round(s / 86400)}d`
    }

    function fmtTime(iso) {
      if (!iso) return '—'
      const t = Date.parse(iso)
      if (!Number.isFinite(t)) return String(iso)
      const d = new Date(t)
      const p = (x) => String(x).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }

    function shortSha(v) {
      const s = String(v || '')
      return s.length > 12 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s || '—'
    }

    // 渲染前最后一道类型闸：对象/数组一律不交给 React 做 child。
    function asText(value) {
      if (value === null || value === undefined) return null
      if (typeof value === 'string') return value
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      return null
    }

    // 页签级错误边界：只挂当前页签，页头、页签栏和其它页签不动。
    const ComponentBase = React.Component || class {
      constructor(props) { this.props = props; this.state = {} }
      setState(next) {
        const patch = typeof next === 'function' ? next(this.state) : next
        this.state = { ...this.state, ...(patch || {}) }
      }
    }

    class TabErrorBoundary extends ComponentBase {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        try {
          console.error('[dsh-longlive-panel] tab crashed', this.props.tabId, error, info && info.componentStack)
        } catch {}
      }

      render() {
        if (this.state.error) {
          const summary = asText(this.state.error && (this.state.error.message || this.state.error)) || '未知错误'
          return h('section', { className: 'section tabfail', role: 'alert' }, [
            h('h2', { key: 'title' }, '这一页加载失败'),
            h('div', { className: 'notice', key: 'summary' }, `错误摘要：${summary.slice(0, 300)}`),
            h('div', { className: 'snippet', key: 'hint' }, '只有这个页签挂了，页头、页签栏和其它页签仍可用。'),
            h('button', { key: 'retry', type: 'button', onClick: () => this.setState({ error: null }) }, '重试这一页'),
          ])
        }
        return this.props.children
      }
    }

    // 状态词只有这一份显示映射：字段名仍是 running/stale/dead/corrupt，界面上不出现「死」。
    const STATE_LABEL = { running: '运行中', idle: '空闲', stale: '休眠', dead: '已归档', corrupt: '损坏', blocked: '阻塞', waiting: '等待' }
    const STATE_TONE = { running: 'ok', idle: 'mute', stale: 'warn', dead: 'mute', corrupt: 'bad', blocked: 'warn', waiting: 'mute' }
    const ACTION_TONE = { allow: 'ok', ask: 'warn', deny: 'bad' }
    const TARGET_LABEL = { remember: '记住', archive_only: '只归档', human: '等人判', local_only: '只留本地' }

    // 常驻 Router 的显示映射。服务端已经给过 statusLabel/tone 的优先用服务端的；
    // 这里只是样例与老数据的兜底，未知状态原样显示，不猜。
    const ROUTER_STATE_LABEL = { running: '运行中', active: '运行中', idle: '空闲', sleeping: '休眠', paused: '暂停', blocked: '阻塞', degraded: '降级', stopped: '已停止', off: '未启用', error: '异常' }
    const ROUTER_STATE_TONE = { running: 'ok', active: 'ok', idle: 'mute', sleeping: 'mute', paused: 'warn', blocked: 'warn', degraded: 'warn', stopped: 'mute', off: 'mute', error: 'bad' }
    const PROPOSAL_LABEL = { pending: '待主人确认', approved: '已批准，等执行', applying: '执行中（持有租约）', done: '已完成', conflict: '冲突', rejected: '已拒绝', rolled_back: '已回滚', superseded: '已被取代' }
    const PROPOSAL_TONE = { pending: 'warn', approved: 'solid', applying: 'solid', done: 'ok', conflict: 'bad', rejected: 'mute', rolled_back: 'warn', superseded: 'mute' }
    // severity 是 Router 给的协议值（info / warn / error，DESIGN §6.5）。
    // 下面只是 UI 映射：文字 + 配色，不改协议、不猜未知值。
    const SEVERITY_LABEL = { info: '信息', warn: '警告', error: '错误' }
    const SEVERITY_TONE = { info: 'mute', warn: 'warn', error: 'bad' }
    // 顶层 queue 的五个计数键（DESIGN §6.5）：不是运行队列，运行队列叫 tickQueue。
    const ROUTER_QUEUE_KEYS = ['pending', 'queued', 'applying', 'blockedOnUser', 'expired']
    const ROUTER_QUEUE_LABEL = { pending: '待取号', queued: '已批准待执行', applying: '执行中', blockedOnUser: '等人裁决', expired: '已过期' }
    const ROUTER_QUEUE_TONE = { pending: 'warn', queued: 'solid', applying: 'solid', blockedOnUser: 'bad', expired: 'mute' }

    function fmtTokens(n) {
      if (n == null || !Number.isFinite(Number(n))) return '—'
      const v = Number(n)
      if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`
      if (v >= 1000) return `${(v / 1000).toFixed(1)}K`
      return String(Math.round(v))
    }

    function fmtPct(ratio) {
      if (ratio == null || !Number.isFinite(Number(ratio))) return null
      return `${(Number(ratio) * 100).toFixed(0)}%`
    }

    function ageSince(iso) {
      if (!iso) return null
      const t = Date.parse(iso)
      if (!Number.isFinite(t)) return null
      return Math.max(0, Date.now() - t)
    }

    function shortSession(id) {
      const s = asText(id)
      if (!s) return '—'
      return s.replace(/^session-/, '').slice(0, 12)
    }

    // ------------------------------------------------------------------
    // 样式（只用宿主 token）
    //
    // 滚动布局：宿主插槽给的是固定高度，内容超出会被直接裁掉，所以
    //   .llp     占满插槽高度并裁切（height:100% + overflow:hidden）；
    //   header / nav.tabs  flex:none，固定不滚；
    //   main      flex:1 + min-height:0，自己纵向滚（overflow-y:auto）。
    // 只改布局，不动任何数据逻辑与页签结构。
    // ------------------------------------------------------------------

    const CSS = `
.llp{--llp-bg:var(--dsw-alias-bg-layer-1,#fff);--llp-soft:var(--dsw-alias-bg-layer-2,#f6f7fa);--llp-text:var(--dsw-alias-label-primary,#18202c);--llp-muted:var(--dsw-alias-label-secondary,#667085);--llp-border:var(--dsw-alias-border-l1,#e6e8ef);--llp-accent:var(--dsh-plugin-workbench-accent,#4f6bdb);--llp-ok:var(--dsw-alias-state-success-primary,#24794a);--llp-warn:var(--dsw-alias-state-warning-primary,#b27b16);--llp-bad:var(--dsw-alias-state-error-primary,#b43c3c);
  display:flex;flex-direction:column;gap:0;height:100%;min-height:0;min-width:0;overflow:hidden;color:var(--llp-text);background:var(--llp-bg);font:14px/1.6 var(--dsh-font-family-content,system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif)}
.llp *,.llp *::before,.llp *::after{box-sizing:border-box}
.llp>header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;flex:none;padding:calc(22px + var(--dsh-frame-top-clearance,0px)) 28px 14px max(28px,var(--dsh-frame-leading-clearance,0px))}
.llp h1{font-size:22px;line-height:1.3;font-weight:650;margin:0;letter-spacing:-.01em}
.llp .sub{color:var(--llp-muted);font-size:12.5px;margin-top:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.llp .mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px}
.llp .actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.llp button{font:inherit;color:inherit;background:var(--llp-bg);border:1px solid var(--llp-border);border-radius:8px;padding:6px 12px;cursor:pointer;min-height:32px}
.llp button:not(:disabled):hover{border-color:var(--llp-accent)}
.llp button:disabled{opacity:.5;cursor:default}
.llp .chip{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:1px 8px;font-size:11.5px;line-height:1.7;background:var(--llp-soft);color:var(--llp-muted);border:1px solid transparent;white-space:nowrap}
.llp .chip.ok{color:var(--llp-ok)}.llp .chip.warn{color:var(--llp-warn)}.llp .chip.bad{color:var(--llp-bad)}.llp .chip.mute{color:var(--llp-muted)}
.llp .chip.solid{background:color-mix(in srgb,var(--llp-accent) 12%,transparent);color:var(--llp-accent)}
.llp .chip.sample{background:color-mix(in srgb,var(--llp-warn) 14%,transparent);color:var(--llp-warn);border-color:color-mix(in srgb,var(--llp-warn) 30%,transparent)}
.llp .dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.llp nav.tabs{display:flex;gap:20px;padding:0 28px;border-bottom:1px solid var(--llp-border);overflow-x:auto;flex:none}
.llp nav.tabs button{border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;padding:10px 2px 12px;min-height:0;color:var(--llp-muted);font-weight:550;display:inline-flex;align-items:center;gap:7px;white-space:nowrap}
.llp nav.tabs button[aria-selected="true"]{color:var(--llp-accent);border-bottom-color:var(--llp-accent)}
.llp nav.tabs .n{font-size:11.5px;background:var(--llp-soft);border-radius:5px;padding:0 6px;color:var(--llp-muted)}
.llp nav.tabs button[aria-selected="true"] .n{background:color-mix(in srgb,var(--llp-accent) 14%,transparent);color:var(--llp-accent)}
.llp main{flex:1;min-height:0;min-width:0;overflow-y:auto;padding:20px 28px 40px;display:flex;flex-direction:column;gap:18px}
.llp .notice{border:1px solid color-mix(in srgb,var(--llp-warn) 35%,var(--llp-border));background:color-mix(in srgb,var(--llp-warn) 8%,transparent);border-radius:8px;padding:9px 12px;font-size:12.5px;color:var(--llp-warn)}
.llp .tabfail{border:1px solid color-mix(in srgb,var(--llp-bad) 38%,var(--llp-border));background:color-mix(in srgb,var(--llp-bad) 6%,transparent);border-radius:10px;padding:18px 20px}
.llp .tabfail>h2{color:var(--llp-bad);font-size:15px}
.llp .tabfail .notice{color:var(--llp-bad);border-color:color-mix(in srgb,var(--llp-bad) 30%,var(--llp-border));background:color-mix(in srgb,var(--llp-bad) 5%,transparent)}
.llp .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(268px,1fr));gap:12px}
.llp .card{border:1px solid var(--llp-border);border-radius:10px;padding:13px 14px;background:var(--llp-bg);display:flex;flex-direction:column;gap:8px;min-width:0}
.llp .card .top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.llp .card .no{font-size:11px;color:var(--llp-muted);font-variant-numeric:tabular-nums}
.llp .card h3{margin:0;font-size:14px;font-weight:600;overflow-wrap:anywhere}
.llp .card .path{font-size:11px;color:var(--llp-muted);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
.llp .card .count{font-size:22px;font-weight:650;line-height:1.1;font-variant-numeric:tabular-nums}
.llp .card .count small{font-size:11px;font-weight:400;color:var(--llp-muted);margin-left:4px}
.llp .card .note{font-size:11.5px;color:var(--llp-muted);overflow-wrap:anywhere}
.llp table{width:100%;border-collapse:collapse;font-size:12.5px}
.llp table th{text-align:left;font-weight:550;color:var(--llp-muted);font-size:11.5px;padding:0 10px 7px 0;white-space:nowrap;border-bottom:1px solid var(--llp-border)}
.llp table td{padding:8px 10px 8px 0;border-bottom:1px solid var(--llp-border);vertical-align:top;overflow-wrap:anywhere}
.llp table tr:last-child td{border-bottom:0}
.llp .num{font-variant-numeric:tabular-nums;white-space:nowrap}
.llp .section{display:flex;flex-direction:column;gap:10px;min-width:0}
.llp .section>h2{margin:0;font-size:13px;font-weight:600;color:var(--llp-muted);letter-spacing:.02em;display:flex;align-items:center;gap:8px}
.llp .empty{border:1px dashed var(--llp-border);border-radius:10px;padding:26px 18px;text-align:center;color:var(--llp-muted);font-size:12.5px}
.llp .metrics{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:10px}
.llp .metric{border:1px solid var(--llp-border);border-radius:9px;padding:10px 12px}
.llp .metric b{display:block;font-size:19px;font-weight:650;line-height:1.2;font-variant-numeric:tabular-nums}
.llp .metric span{font-size:11.5px;color:var(--llp-muted)}
.llp .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}
.llp .snippet{font-size:12px;color:var(--llp-muted);max-width:62ch}
.llp .bar{display:flex;gap:3px;align-items:center;flex-wrap:wrap}
.llp .bar i{display:block;height:6px;border-radius:3px;background:var(--llp-border);width:16px}
.llp .bar i.on{background:var(--llp-accent)}
.llp .detail{border:1px solid var(--llp-border);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.llp .kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 14px;font-size:12.5px}
.llp .kv dt{color:var(--llp-muted)}
.llp .kv dd{margin:0;overflow-wrap:anywhere}
.llp .foot{color:var(--llp-muted);font-size:11.5px;display:flex;gap:14px;flex-wrap:wrap;padding-top:4px}
.llp .help{max-width:84ch;gap:12px}
.llp .help p{margin:0;font-size:13px;overflow-wrap:anywhere}
.llp .help ul,.llp .help ol{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:8px;font-size:13px}
.llp .help li{overflow-wrap:anywhere}
.llp .help li b{font-weight:600}
.llp .help code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;background:var(--llp-soft);border:1px solid var(--llp-border);border-radius:4px;padding:0 4px}
.llp .help .you{color:var(--llp-accent);font-size:12.5px;margin-top:2px}
.llp .help .switches{display:flex;flex-direction:column;gap:8px}
.llp .help .switch{border:1px solid var(--llp-border);border-radius:9px;padding:9px 12px;display:flex;gap:14px;align-items:baseline;flex-wrap:wrap}
.llp .help .switch .name{flex:none;min-width:150px;display:flex;align-items:baseline;gap:8px}
.llp .help .switch .alias{font-size:11.5px;color:var(--llp-muted)}
.llp .help .switch .what{flex:1;min-width:220px;font-size:12.5px;color:var(--llp-muted)}
.llp .help .warnbox{border-left:3px solid var(--llp-warn);background:color-mix(in srgb,var(--llp-warn) 7%,transparent);border-radius:6px;padding:8px 12px;font-size:12.5px}
.llp .alerts{display:flex;flex-direction:column;gap:8px}
.llp .alert{border:1px solid var(--llp-border);border-left-width:3px;border-radius:8px;padding:9px 12px;display:flex;flex-direction:column;gap:3px}
.llp .alert.bad{border-left-color:var(--llp-bad);background:color-mix(in srgb,var(--llp-bad) 6%,transparent)}
.llp .alert.warn{border-left-color:var(--llp-warn);background:color-mix(in srgb,var(--llp-warn) 6%,transparent)}
.llp .alert .t{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-weight:600;font-size:13px}
.llp .alert .d{font-size:12.5px;color:var(--llp-muted);overflow-wrap:anywhere}
.llp .alert .s{font-size:11px;color:var(--llp-muted);font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.llp .budget{height:6px;border-radius:3px;background:var(--llp-border);overflow:hidden}
.llp .budget i{display:block;height:100%;background:var(--llp-ok)}
.llp .budget i.warn{background:var(--llp-warn)}
.llp .budget i.bad{background:var(--llp-bad)}
@media (max-width:760px){.llp>header{padding:calc(14px + var(--dsh-frame-top-clearance,0px)) 16px 12px max(16px,var(--dsh-frame-leading-clearance,0px))}.llp nav.tabs{padding:0 16px;gap:14px}.llp main{padding:16px 16px 32px}.llp table{font-size:12px}}
@media (prefers-reduced-motion:reduce){.llp *{transition:none!important;animation:none!important}}
`

    /**
     * 服务端明确返回 implemented:false 时，live 视图保持空数据并显示「未启用」，
     * 不再塞样例——source==='live' 的页签不允许出现样例内容或样例标。
     * 只有请求本身失败（source==='sample'）才用 SAMPLE 撑版面。
     */
    function withPreview(live, sample) {
      if (!live) return sample
      if (live.implemented === false) {
        return { ...live, items: [], metrics: live.metrics || {}, queue: [] }
      }
      return live
    }

    function useStyles(id) {
      useEffect(() => {
        const elId = `llp-style-${id}`
        let el = document.getElementById(elId)
        if (!el) {
          el = document.createElement('style')
          el.id = elId
          el.textContent = CSS
          document.head.appendChild(el)
        }
        return () => {
          // 面板可能被反复挂载/卸载，样式留着不摘，避免闪烁
        }
      }, [id])
    }

    // ------------------------------------------------------------------
    // 组件
    // ------------------------------------------------------------------

    const TH = (labels) => h('thead', null, h('tr', null, labels.map((t, i) => h('th', { key: i }, t))))

    function HealthDot({ health }) {
      const tone = health === 'ok' ? 'ok' : health === 'warn' ? 'warn' : 'mute'
      const label = health === 'empty' ? '空' : health === 'warn' ? '注意' : '正常'
      return h('span', { className: `chip ${tone}` }, [h('span', { className: 'dot', key: 'd' }), label])
    }

    function LayerGrid({ layers }) {
      const cards = (layers || []).map((l) => h('div', { className: 'card', key: l.id }, [
        h('div', { className: 'top', key: 'top' }, [
          h('span', { className: 'no', key: 'no' }, `L${l.index}`),
          h(HealthDot, { health: l.health, key: 'dot' }),
        ]),
        h('h3', { key: 'name' }, l.name),
        h('div', { className: 'path', key: 'path' }, l.path),
        h('div', { className: 'count', key: 'count' }, [String(l.count ?? 0), h('small', { key: 'u' }, l.unit || '')]),
        h('div', { className: 'note', key: 'note' }, l.note || ''),
      ]))
      return h('div', { className: 'grid' }, cards)
    }

    function LiveTable({ rows }) {
      if (!rows || !rows.length) return h('div', { className: 'empty' }, '没有活体心跳行（.longlive/live/*.json 为空）')
      const body = rows.map((r) => h('tr', { key: r.sessionId }, [
        h('td', { key: 'id' }, [
          h('div', { className: 'mono', key: 'a' }, r.shortId || r.sessionId),
          r.workspace ? h('div', { className: 'snippet mono', key: 'b' }, r.workspace) : null,
        ]),
        h('td', { key: 'state' }, h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' } }, [
          h('span', { className: `chip ${STATE_TONE[r.state] || 'mute'}`, key: 's' }, [
            h('span', { className: 'dot', key: 'd' }),
            STATE_LABEL[r.state] || r.state,
          ]),
          r.sessionFile === false ? h('span', { className: 'chip warn', key: 'orphan', title: '活体登记指向的会话目录里没有 session.v4.jsonl.zstd' }, '无会话文件') : null,
        ])),
        h('td', { className: 'num', key: 'turn' }, r.turn == null ? '—' : String(r.turn)),
        h('td', { className: 'num', key: 'hb' }, fmtAge(r.heartbeatAgeMs)),
        h('td', { key: 'what' }, [
          h('div', { className: 'snippet', key: 'g' }, r.goal || '（没有写目标）'),
          r.blockedOn ? h('div', { className: 'snippet', key: 'b' }, `等：${r.blockedOn}`) : null,
          r.lastAction && r.lastAction.detail ? h('div', { className: 'snippet mono', key: 'l' }, r.lastAction.detail) : null,
        ]),
      ]))
      return h('table', null, [TH(['会话', '状态', '回合', '心跳', '在做什么']), h('tbody', null, body)])
    }

    function PalaceTab({ summary, source }) {
      const badge = h('span', { className: `chip ${source === 'live' ? 'solid' : 'sample'}` }, source === 'live' ? '实时' : '样例')
      const warnings = (summary.warnings || []).map((w) => h('span', { key: w.code, className: 'chip warn' }, w.code))
      return h(React.Fragment, null, [
        h('section', { className: 'section', key: 'layers' }, [
          h('h2', null, ['六层', badge]),
          h(LayerGrid, { layers: summary.layers || [] }),
        ]),
        h('section', { className: 'section', key: 'live' }, [
          h('h2', null, ['活体心跳', h('span', { className: 'chip', key: 'c' }, `${(summary.live || []).length} 行`)]),
          h(LiveTable, { rows: summary.live || [] }),
        ]),
        h('div', { className: 'foot', key: 'foot' }, [
          h('span', { key: 'g' }, `刷新于 ${fmtTime(summary.generatedAt)}`),
          summary.freshness && summary.freshness.indexBuiltAt
            ? h('span', { key: 'i' }, `INDEX 建于 ${fmtTime(summary.freshness.indexBuiltAt)}`)
            : null,
          ...warnings,
        ]),
      ])
    }

    function TruncTab({ trunc, source }) {
      const items = trunc.items || []
      const backups = trunc.backups || []
      const badge = h('span', { className: `chip ${source === 'live' ? 'solid' : 'sample'}` }, source === 'live' ? '实时' : '样例')

      const truncRows = items.map((t) => h('tr', { key: t.id }, [
        h('td', { className: 'num', key: 'at' }, [
          fmtTime(t.at),
          t.kind === 'visible'
            ? h('div', { className: 'snippet', key: 'kind' }, `可见截断${t.tool ? ` · ${t.tool}` : ''}`)
            : null,
        ]),
        h('td', { key: 'sid' }, h('div', { className: 'mono' }, String(t.sessionId || '').replace(/^session-/, '').slice(0, 12))),
        h('td', { className: 'num', key: 'before' }, fmtBytes(t.beforeBytes)),
        h('td', { className: 'num', key: 'after' }, fmtBytes(t.afterBytes)),
        h('td', { className: 'num', key: 'saved' }, `${fmtBytes(t.savedBytes)}${t.savedRatio != null ? ` · ${(t.savedRatio * 100).toFixed(1)}%` : ''}`),
        h('td', { className: 'num', key: 'events' }, t.kind === 'visible'
          ? `${t.beforeMessages ?? '—'} → ${t.afterMessages ?? '—'} 条消息`
          : `${t.beforeEvents ?? '—'} → ${t.afterEvents ?? '—'}`),
        h('td', { key: 'backup' }, [
          h('div', { className: 'mono snippet', key: 'f' }, t.backup || '—'),
          t.backupSha256 ? h('div', { className: 'snippet mono', key: 'h' }, shortSha(t.backupSha256)) : null,
          t.kind === 'visible' && t.archive ? h('div', { className: 'snippet mono', key: 'a' }, `归档 ${t.archive}`) : null,
        ]),
      ]))
      const truncTable = items.length
        ? h('table', null, [TH(['时间', '会话', '截断前', '截断后', '省下', '事件 / 消息', '备份']), h('tbody', null, truncRows)])
        : h('div', { className: 'empty' }, '没有截断记录（truncate.json / truncate-visible.json 不存在或为空）')

      const backupRows = backups.map((b) => h('tr', { key: `${b.sessionId}/${b.file}` }, [
        h('td', { className: 'mono', key: 'file' }, b.file || '—'),
        h('td', { className: 'num', key: 'size' }, fmtBytes(b.size)),
        h('td', { className: 'num', key: 'at' }, fmtTime(b.createdAt)),
        h('td', { key: 'exists' }, h('span', { className: `chip ${b.exists === false ? 'warn' : 'ok'}` }, b.exists === false ? '缺失' : '存在')),
        h('td', { className: 'mono', key: 'sha' }, shortSha(b.sha256)),
      ]))
      const backupTable = backups.length
        ? h('table', null, [TH(['文件', '大小', '生成时间', '在盘上', 'SHA256']), h('tbody', null, backupRows)])
        : h('div', { className: 'empty' }, '没有 backups.json 记录')

      return h(React.Fragment, null, [
        h('section', { className: 'section', key: 'trunc' }, [
          h('h2', null, ['截断记录', badge, h('span', { className: 'chip', key: 'c' }, `扫了 ${trunc.sessionsScanned ?? '—'} 个会话目录`)]),
          truncTable,
        ]),
        h('section', { className: 'section', key: 'backups' }, [
          h('h2', null, ['备份', h('span', { className: 'chip', key: 'c' }, `${backups.length} 个`)]),
          backupTable,
        ]),
      ])
    }

    function FilterTab({ filter, source }) {
      const metrics = filter.metrics || {}
      const by = metrics.by || {}
      const items = filter.items || []
      const sample = source !== 'live'
      const unavailable = source === 'live' && filter.implemented === false

      const metric = (value, label, key) => h('div', { className: 'metric', key }, [
        h('b', null, String(value)),
        h('span', null, label),
      ])

      const cards = items.map((it, index) => {
        const dims = Array.isArray(it.dims) ? it.dims : []
        const unitId = asText(it.unitId)
        const target = asText(it.target)
        const privacyVerdict = it.privacy && asText(it.privacy.verdict)
        const bars = dims.map((d, di) => {
          const id = asText(d && d.id) || `d${di + 1}`
          return h('i', {
            key: id,
            className: d.score >= d.max && d.max > 0 ? 'on' : '',
            title: `${id} ${d.score}/${d.max}${asText(d.why) ? ` · ${asText(d.why)}` : ''}`,
          })
        })
        const why = dims.filter((d) => d.max > 0 && d.score === d.max).map((d) => asText(d.why)).filter(Boolean).join('；')
        return h('div', { className: 'card', key: unitId || asText(it.ts) || `row-${index}` }, [
          h('div', { className: 'top', key: 'top' }, [
            h('span', { className: 'chip solid', key: 'target' }, TARGET_LABEL[target] || target || '—'),
            h('span', { className: 'no num', key: 'score' }, `分 ${it.score ?? '—'}`),
          ]),
          h('div', { className: 'mono path', key: 'id' }, unitId || ''),
          h('div', { className: 'bar', key: 'bar' }, bars),
          h('div', { className: 'note', key: 'why' }, why || '没有满分子项'),
          h('div', { className: 'snippet', key: 'excerpt' }, asText(it.excerpt) || '（不展示正文：local_only）'),
          h('div', { className: 'row', key: 'row' }, [
            it.needsHuman ? h('span', { className: 'chip warn', key: 'human' }, '待人工') : null,
            privacyVerdict && privacyVerdict !== 'pass'
              ? h('span', { className: 'chip bad', key: 'privacy' }, `隐私 ${privacyVerdict}`)
              : null,
            h('span', { className: 'chip', key: 'ts' }, fmtTime(it.ts)),
          ]),
        ])
      })

      return h(React.Fragment, null, [
        sample ? h('div', { className: 'notice', key: 'notice' }, '过滤器数据源未连接，下面展示的是样例，用来看实装后长什么样。') : null,
        unavailable ? h('div', { className: 'notice', key: 'off' }, '过滤器未启用或还没有决策文件（.longlive/filter/decisions-*.jsonl）。开启 filterEnabled 后重启 DSH 即可看到真数据。') : null,
        h('section', { className: 'section', key: 'metrics' }, h('div', { className: 'metrics' }, [
          metric(metrics.total ?? 0, '决策总数', 'total'),
          metric(metrics.queue ?? 0, '待人工', 'queue'),
          metric(metrics.privacyBlocked ?? 0, '隐私拦截', 'privacy'),
          metric(metrics.avgScore == null ? '—' : metrics.avgScore, '平均分', 'avg'),
          metric(by.remember ?? 0, '记住', 'remember'),
          metric(by.archive_only ?? 0, '只归档', 'archive'),
        ])),
        h('section', { className: 'section', key: 'items' }, [
          h('h2', null, '决策流水'),
          items.length
            ? h('div', { className: 'grid' }, cards)
            : h('div', { className: 'empty' }, '还没有决策记录'),
        ]),
      ])
    }

    function ShadowTab({ shadow, source }) {
      const items = shadow.items || []
      const metrics = shadow.metrics || {}
      const router = metrics.router || {}
      const sample = source !== 'live'
      const unavailable = source === 'live' && shadow.implemented === false

      const metric = (value, label, key) => h('div', { className: 'metric', key }, [
        h('b', null, String(value)),
        h('span', null, label),
      ])

      const rows = items.map((it, index) => {
        const action = asText(it.action)
        const guardReason = it.guard && asText(it.guard.reason)
        const errors = Array.isArray(it.errors) ? it.errors.map(asText).filter(Boolean) : []
        const confidence = typeof it.confidence === 'number' ? it.confidence.toFixed(2) : '—'
        const totalMs = typeof it.totalMs === 'number' ? `${it.totalMs.toFixed(0)}ms` : '—'
        const decisionSummary = asText(it.decisionSummary)
        return h('tr', { key: asText(it.id) || `${asText(it.source) || 'row'}:${index}` }, [
          h('td', { className: 'num', key: 'ts' }, fmtTime(it.ts)),
          h('td', { key: 'source' }, h('span', { className: 'chip' }, asText(it.source) || '—')),
          h('td', { className: 'mono', key: 'subject' }, asText(it.subject) || '—'),
          h('td', { key: 'action' }, h('span', { className: `chip ${ACTION_TONE[action] || 'mute'}` }, action || '—')),
          h('td', { className: 'mono', key: 'rule' }, asText(it.matchedRule) || '—'),
          h('td', { className: 'num', key: 'conf' }, confidence),
          h('td', { className: 'num', key: 'ms' }, totalMs),
          h('td', { key: 'what' }, [
            h('div', { className: 'snippet', key: 'call' }, asText(it.callText) || '—'),
            decisionSummary ? h('div', { className: 'snippet mono', key: 'decision' }, `decision：${decisionSummary}`) : null,
            guardReason ? h('div', { className: 'snippet', key: 'guard' }, `guard：${guardReason}`) : null,
            errors.length ? h('div', { className: 'snippet mono', key: 'err' }, errors.join(', ')) : null,
          ]),
        ])
      })

      const mode = asText(shadow.mode) || 'off'
      const modeChip = h('span', { className: `chip ${mode === 'off' ? 'mute' : 'solid'}` }, `模式 ${mode}`)
      const fileChips = (shadow.files || []).map((f, index) => {
        const path = asText(f && f.path) || `file-${index + 1}`
        return h('span', { key: path, className: 'chip mono' }, `${path} · ${f && f.lines != null ? f.lines : 0} 行`)
      })

      return h(React.Fragment, null, [
        sample ? h('div', { className: 'notice', key: 'notice' }, '影子数据源未连接，下面展示的是样例。') : null,
        unavailable ? h('div', { className: 'notice', key: 'off' }, `影子记录未启用或还没有记录（router-runtime.jsonl）。当前模式 ${asText(shadow.mode) || 'off'}；开启 shadowEnabled 后重启 DSH 即可看到真数据。`) : null,
        h('section', { className: 'section', key: 'head' }, [
          h('div', { className: 'row' }, [
            modeChip,
            asText(shadow.modeSource) ? h('span', { className: 'chip mono', key: 'src' }, asText(shadow.modeSource)) : null,
            ...fileChips,
          ]),
          h('div', { className: 'metrics' }, [
            metric(router.total ?? 0, '路由判定', 'total'),
            metric(router.allow ?? 0, 'allow', 'allow'),
            metric(router.ask ?? 0, 'ask', 'ask'),
            metric(router.deny ?? 0, 'deny', 'deny'),
          ]),
        ]),
        h('section', { className: 'section', key: 'items' }, [
          h('h2', null, '影子流水'),
          items.length
            ? h('table', null, [TH(['时间', '来源', '对象', '动作', '规则', '置信', '耗时', '说的是什么']), h('tbody', null, rows)])
            : h('div', { className: 'empty' }, '没有影子记录'),
        ]),
      ])
    }

    // ------------------------------------------------------------------
    // 常驻 Router（第五页签，只读窗口）
    // 只显示 status.json / board.json / proposals/*.json 里已有的字段：
    // 缺文件显示「未启用」，缺字段就隐藏，不猜、不推断、不写回。
    // ------------------------------------------------------------------

    function RouterTab({ router, source }) {
      const data = router || {}
      const st = data.status || null
      const board = data.board || null
      const prop = data.proposals || {}
      const counts = prop.counts || {}
      const items = Array.isArray(prop.items) ? prop.items : []
      // alerts 是 Router 给的严重级告警（info/warn/error）；warnings 是开放枚举的码，
      // boardWarnings 是共享板文件自己的诊断码，三者分开显示、不混计数（DESIGN §6.5）。
      const alerts = Array.isArray(data.alerts) ? data.alerts : []
      const warnings = Array.isArray(data.warnings) ? data.warnings : []
      const boardWarnings = Array.isArray(data.boardWarnings) ? data.boardWarnings : []
      const notes = Array.isArray(data.notes) ? data.notes : []
      // 顶层 queue 是五个计数（pending/queued/applying/blockedOnUser/expired），
      // 运行队列在 tickQueue 里；两者不混用。
      const q = st && st.queue && typeof st.queue === 'object' ? st.queue : null
      const qTotal = q ? ROUTER_QUEUE_KEYS.reduce((n, k) => n + (Number(q[k]) || 0), 0) : null
      const propQ = st && st.proposals && st.proposals.queue ? st.proposals.queue : null
      const queueLabel = (k) => ROUTER_QUEUE_LABEL[k] || k
      const queueChips = q ? ROUTER_QUEUE_KEYS.map((k) => (
        h('span', { className: `chip ${ROUTER_QUEUE_TONE[k] || 'mute'}`, key: k }, `${queueLabel(k)} ${q[k] ?? 0}`)
      )) : []
      const disabled = data.enabled === false || !st
      const badge = h('span', { className: `chip ${source === 'live' ? 'solid' : 'sample'}` }, source === 'live' ? '实时' : '样例')
      const metric = (value, label, key) => h('div', { className: 'metric', key }, [
        h('b', null, String(value)),
        h('span', null, label),
      ])
      const kvRow = (label, value, key) => (value == null || value === '' ? null : [
        h('dt', { key: `${key}-t` }, label),
        h('dd', { key: `${key}-d` }, value),
      ])

      const statusMetrics = []
      if (st) {
        const hbAge = ageSince(st.heartbeatAt)
        if (hbAge != null) statusMetrics.push(metric(fmtAge(hbAge), '距上次心跳', 'hb'))
        // 时间字段是 ISO 或 null；null 表示「未运行」，不是缺数据（DESIGN §6.5：null 显示「未运行」）。
        const lastAge = ageSince(st.lastTickAt)
        statusMetrics.push(metric(lastAge == null ? '未运行' : `${fmtAge(lastAge)}前`, '上次 tick', 'tick'))
        if (st.nextTickAt) {
          const due = Date.parse(st.nextTickAt) - Date.now()
          statusMetrics.push(metric(Number.isFinite(due) ? `${fmtAge(Math.abs(due))}${due >= 0 ? '后' : '前'}` : '未运行', '下次唤醒', 'wake'))
        } else {
          statusMetrics.push(metric('未运行', '下次唤醒', 'wake'))
        }
        // 顶层 queue 五键 → 顶部五个数字（DESIGN §6.5）；不是 tickQueue。
        if (q) {
          for (const k of ROUTER_QUEUE_KEYS) statusMetrics.push(metric(q[k] ?? 0, queueLabel(k), `q-${k}`))
        }
        if (st.today && st.today.capTokens != null) {
          const t = st.today
          statusMetrics.push(metric(`${fmtTokens(t.usedTokens)} / ${fmtTokens(t.capTokens)}`, `今日 token${fmtPct(t.ratio) ? ` · ${fmtPct(t.ratio)}` : ''}`, 'today'))
        }
        if (st.run && st.run.capTokens != null) {
          statusMetrics.push(metric(`${fmtTokens(st.run.usedTokens)} / ${fmtTokens(st.run.capTokens)}`, '本轮 token', 'run'))
        }
      }

      const todayRatio = st && st.today && Number.isFinite(Number(st.today.ratio))
        ? Number(st.today.ratio)
        : (st && st.today && st.today.capTokens > 0 ? Number(st.today.usedTokens || 0) / Number(st.today.capTokens) : null)
      const budgetTone = todayRatio == null ? null : todayRatio >= 1 ? 'bad' : todayRatio >= 0.9 ? 'warn' : 'ok'

      // provider 只有两态：configured / missing；不显示 id、模型名、端点、凭据（DESIGN §6.5）。
      const providerText = st && st.provider ? (st.provider.configured === true ? '已配置' : '缺失') : null
      const modelText = st && st.model
        ? (st.model.auto === true ? '自动选择' : st.model.auto === false ? '按配置固定' : null)
        : null
      const agentText = st ? (st.agentMode === true ? 'agent 模式' : st.agentMode === false ? '非 agent 模式' : null) : null
      const leaseText = st && st.lease
        ? (st.lease.active
          ? `持有者 ${st.lease.holder || '—'} · 已持有 ${st.lease.heldMs != null ? fmtAge(st.lease.heldMs) : '—'} · 续约 ${st.lease.renewals ?? '—'} 次 · 到期 ${fmtTime(st.lease.expiresAt)}`
          : `空闲${st.lease.holder ? `（上次持有者 ${st.lease.holder}）` : ''}`)
        : null
      const tickQueueText = st && st.tickQueue
        ? `等待 ${st.tickQueue.pending ?? '—'} · 无效 ${st.tickQueue.invalid ?? '—'} · 最老 ${fmtAge(st.tickQueue.oldestAgeMs)}`
        : null
      const walText = st && st.wal
        ? `末序号 ${st.wal.lastSeq ?? '—'} · ${st.wal.segments ?? '—'} 段 · ${fmtBytes(st.wal.bytes)}${st.wal.broken ? ' · 链断裂' : ''}`
        : null

      const statusDetail = st ? [
        kvRow('状态', `${ROUTER_STATE_LABEL[st.state] || st.state || '—'}${st.since ? `（自 ${fmtTime(st.since)}）` : ''}`, 'state'),
        kvRow('运行号', st.runId, 'run'),
        kvRow('provider', providerText, 'provider'),
        kvRow('模型选择', modelText, 'model'),
        kvRow('自主度 / 模式', [st.autonomy, agentText].filter(Boolean).join(' / ') || null, 'mode'),
        kvRow('tick 任务队列', tickQueueText, 'tickq'),
        kvRow('提案计数（五键）', q ? ROUTER_QUEUE_KEYS.map((k) => `${queueLabel(k)} ${q[k] ?? 0}`).join(' · ') : null, 'q'),
        kvRow('写者租约', leaseText, 'lease'),
        kvRow('WAL', walText, 'wal'),
        kvRow('共享提示', st.shared
          ? `注入 ${st.shared.injectedTurns ?? '—'} 轮 · 今日 ${fmtTokens(st.shared.injectedTokensToday)} token · 最近 hint ${fmtTokens(st.shared.hintTokensLast)} token · 跳过 ${st.shared.skipped ?? '—'} 次 · 活体 ${st.shared.liveRows ?? '—'} 行 · 未知 ${st.shared.unknownSessions ?? '—'}`
          : null, 'shared'),
        kvRow('上次报告', st.lastReport && st.lastReport.summary
          ? `${fmtTime(st.lastReport.at)} · ${st.lastReport.summary}`
          : null, 'report'),
        kvRow('状态文件', st.files && st.files.board, 'files-board'),
      ].flat().filter(Boolean) : []

      const statusSection = h('section', { className: 'section', key: 'router-status' }, [
        h('h2', null, [
          'Router 状态',
          badge,
          disabled ? h('span', { className: 'chip bad', key: 'off' }, '未启用') : h('span', { className: 'chip ok', key: 'on' }, '在跑'),
          st && st.state ? h('span', { className: `chip ${ROUTER_STATE_TONE[st.state] || 'mute'}`, key: 'state' }, ROUTER_STATE_LABEL[st.state] || st.state) : null,
        ]),
        disabled && notes.length ? h('div', { className: 'notice', key: 'notes' }, notes.join(' ')) : null,
        disabled && !notes.length ? h('div', { className: 'empty', key: 'empty' }, '没有 .longlive/router/status.json：常驻 Router 未安装或未启用，这一页不报错。') : null,
        st && st.reason ? h('div', { className: 'notice', key: 'reason' }, `Router 说的原因：${st.reason}`) : null,
        // blockedOnUser > 0 → 黄条（DESIGN §6.5，1202 行）。
        q && q.blockedOnUser > 0 ? h('div', { className: 'alert warn', key: 'blocked-on-user' }, [
          h('div', { className: 't' }, '有提案在等你裁决'),
          h('div', { className: 'd' }, `queue.blockedOnUser = ${q.blockedOnUser}：这些条目卡在需要主人决定的一步。`),
        ]) : null,
        // starvation 是 Router 给的布尔（DESIGN §6.5，1214 行）；面板只展示，不自己判阈值。
        propQ && propQ.starvation === true ? h('div', { className: 'alert bad', key: 'starve' }, [
          h('div', { className: 't' }, '队列可能有饿死'),
          h('div', { className: 'd' }, 'Router 标记 proposals.queue.starvation = true，排在前面的条目可能长时间拿不到执行机会。'),
        ]) : null,
        // WAL 只在 broken = true 时报警（DESIGN §6.5，1213 行）；平时只是诊断字段。
        st && st.wal && st.wal.broken === true ? h('div', { className: 'alert bad', key: 'wal-broken' }, [
          h('div', { className: 't' }, 'WAL 链断裂'),
          h('div', { className: 'd' }, `末序号 ${st.wal.lastSeq ?? '—'} · ${st.wal.segments ?? '—'} 段 · ${fmtBytes(st.wal.bytes)}；需要 Router 侧修复，面板只读不修。`),
        ]) : null,
        statusMetrics.length ? h('div', { className: 'metrics', key: 'metrics' }, statusMetrics) : null,
        todayRatio != null ? h('div', { className: 'budget', key: 'budget', title: `今日预算已用 ${fmtPct(todayRatio)}` }, [
          h('i', { className: budgetTone, style: { width: `${Math.min(100, Math.max(0, todayRatio * 100))}%` } }),
        ]) : null,
        statusDetail.length ? h('div', { className: 'detail', key: 'detail' }, h('dl', { className: 'kv' }, statusDetail)) : null,
        st && st.lastError ? h('div', { className: 'alert bad', key: 'lastError' }, [
          h('div', { className: 't' }, '最后一条错误'),
          h('div', { className: 'd' }, st.lastError),
        ]) : null,
      ])

      // alerts：Router 给的严重级（info / warn / error），原样透传，界面只做配色（UI 映射，不改协议）。
      const alertList = alerts.map((a, i) => {
        const sev = asText(a && a.severity) || 'info'
        const tone = SEVERITY_TONE[sev] === 'bad' ? 'bad' : SEVERITY_TONE[sev] === 'warn' ? 'warn' : 'info'
        const code = asText(a && a.code)
        return h('div', { className: `alert ${tone}`, key: code || `a-${i}` }, [
          h('div', { className: 't' }, [
            h('span', { className: `chip ${SEVERITY_TONE[sev] || 'mute'}`, key: 'sev' }, SEVERITY_LABEL[sev] || sev),
            asText(a && a.message) || code || '未命名告警',
            code ? h('span', { className: 's', key: 'code' }, code) : null,
          ]),
          asText(a && a.at) ? h('div', { className: 's', key: 'at' }, fmtTime(a.at)) : null,
        ])
      })

      // warnings：开放枚举的码。已知码给中文文案，未知码原样显示并标「未收录」；
      // 条数就是 warnings.length（DESIGN §6.5），不白名单过滤、不丢弃。
      const warningRow = (w, i, srcKey) => {
        const code = asText(w && w.code) || `W-${i}`
        const known = w && w.known === true
        return h('div', { className: 'row', key: `${srcKey}-${code}-${i}`, title: asText(w && w.detail) || undefined }, [
          h('span', { className: `chip ${known ? 'warn' : 'mute'}`, key: 'label' }, known ? (asText(w.label) || code) : code),
          known ? h('span', { className: 's mono', key: 'code' }, code) : h('span', { className: 'chip bad', key: 'unknown' }, '未收录'),
        ])
      }
      const warningList = warnings.map((w, i) => warningRow(w, i, 'status'))
      const boardWarningList = boardWarnings.map((w, i) => warningRow(w, i, 'board'))
      const alertSection = h('section', { className: 'section', key: 'router-alerts' }, [
        h('h2', null, [
          '风险告警',
          h('span', { className: 'chip', key: 'c' }, `告警 ${warnings.length} 条`),
          alerts.length ? h('span', { className: 'chip', key: 'ac' }, `严重级 ${alerts.length} 条`) : null,
        ]),
        alerts.length ? h('div', { className: 'alerts', key: 'alerts' }, alertList) : null,
        warnings.length ? h('div', { className: 'row', key: 'warnings' }, warningList) : null,
        boardWarnings.length ? h('div', { className: 'row', key: 'board-warnings' }, [
          h('span', { className: 's', key: 'lbl' }, '共享板诊断'),
          ...boardWarningList,
        ]) : null,
        (!alerts.length && !warnings.length && !boardWarnings.length)
          ? h('div', { className: 'empty', key: 'empty' }, '没有告警（warnings 为空数组；status.json 不存在时面板也不会因此报错）')
          : null,
      ])

      const pulse = (board && board.pulse) || null
      const boardMetrics = []
      if (pulse) {
        if (pulse.active != null) boardMetrics.push(metric(pulse.active, '活跃会话', 'active'))
        if (pulse.running != null) boardMetrics.push(metric(pulse.running, '运行中', 'running'))
        if (pulse.blocked != null) boardMetrics.push(metric(pulse.blocked, '阻塞', 'blocked'))
        // unknownSessions：活体摘要里有几行读不出来 / 对不上（DESIGN §6.5）。
        if (pulse.unknownSessions != null) boardMetrics.push(metric(pulse.unknownSessions, '未知会话', 'unknown'))
        if (pulse.queuedProposals != null) boardMetrics.push(metric(pulse.queuedProposals, '提案待执行', 'queued'))
        if (pulse.approvedProposals != null) boardMetrics.push(metric(pulse.approvedProposals, '已批准提案', 'approved'))
        if (pulse.blockedOnUser != null) boardMetrics.push(metric(pulse.blockedOnUser, '等人裁决', 'blocked-user'))
        if (pulse.readyProposals != null) boardMetrics.push(metric(pulse.readyProposals, '可执行提案', 'ready'))
      }
      const focusRows = ((board && board.focus) || []).map((f, i) => h('tr', { key: asText(f.sessionId) || `f-${i}` }, [
        h('td', { className: 'mono', key: 'sid' }, shortSession(f.sessionId)),
        h('td', { key: 'goal' }, asText(f.goal) || '（没有写目标）'),
        h('td', { className: 'num', key: 'updated' }, fmtTime(f.updatedAt)),
      ]))
      const timelineRows = ((board && board.timeline) || []).map((t, i) => h('tr', { key: `${asText(t.at) || 't'}-${i}` }, [
        h('td', { className: 'num', key: 'at' }, fmtTime(t.at)),
        h('td', { key: 'kind' }, h('span', { className: 'chip' }, asText(t.kind) || '—')),
        h('td', { className: 'mono', key: 'sid' }, shortSession(t.sessionId)),
        h('td', { key: 'summary' }, asText(t.summary) || '—'),
      ]))
      const boardSection = h('section', { className: 'section', key: 'router-board' }, [
        h('h2', null, [
          '共享大脑',
          board && board.seq != null ? h('span', { className: 'chip', key: 'seq' }, `seq ${board.seq}`) : null,
          board && board.generatedAt ? h('span', { className: 'chip', key: 'at' }, `建于 ${fmtTime(board.generatedAt)}`) : null,
        ]),
        board
          ? h(React.Fragment, null, [
            boardMetrics.length ? h('div', { className: 'metrics', key: 'pulse' }, boardMetrics) : null,
            (pulse && (pulse.queueHead || pulse.lease || pulse.lastApplyAt))
              ? h('div', { className: 'row', key: 'pulse-extra' }, [
                pulse.queueHead ? h('span', { className: 'chip solid', key: 'head' }, `队头 ${pulse.queueHead}`) : null,
                pulse.lease && pulse.lease.active
                  ? h('span', { className: 'chip warn', key: 'lease' }, `租约 ${pulse.lease.holder || '—'}${pulse.lease.expiresAt ? ` · 到期 ${fmtTime(pulse.lease.expiresAt)}` : ''}`)
                  : null,
                pulse.lastApplyAt ? h('span', { className: 'chip mute', key: 'apply' }, `上次执行 ${fmtTime(pulse.lastApplyAt)}`) : null,
              ])
              : null,
            ((board.focus || []).length
              // focus 只给 sessionId / goal / updatedAt 三字段，状态不在这里推断（DESIGN §6.5）。
              ? h('table', { key: 'focus' }, [TH(['会话', '当前任务', '更新时间']), h('tbody', null, focusRows)])
              : h('div', { className: 'empty', key: 'focus-empty' }, '共享板上还没有活跃会话')),
            ((board.timeline || []).length
              ? h('table', { key: 'timeline' }, [TH(['时间', '类型', '会话', '交接内容']), h('tbody', null, timelineRows)])
              : h('div', { className: 'empty', key: 'timeline-empty' }, '还没有最近的交接记录')),
            h('div', { className: 'foot', key: 'src' }, board.source
              ? `扫描 ${board.source.liveRows ?? '—'} 行活体 · ${board.source.unknownSessions ?? board.unknownSessions ?? '—'} 行未知 · ${board.source.proposals ?? '—'} 个提案 · ${board.source.scanMs ?? '—'}ms`
              : null),
          ])
          : h('div', { className: 'empty', key: 'empty' }, '共享板还没生成（board.json 不存在）；Router 未启用时这是正常的。'),
      ])

      // 文件扫描计数（最多 50 条）与顶层 queue 的五键不是一回事，分开标注。
      const fileChips = ['pending', 'approved', 'applying', 'conflict'].map((k) => (
        counts[k] == null ? null : h('span', { className: `chip ${PROPOSAL_TONE[k] || 'mute'}`, key: k }, `${PROPOSAL_LABEL[k]} ${counts[k]}`)
      )).filter(Boolean)
      const writer = propQ && propQ.writer ? propQ.writer : null
      const nextTicket = propQ && Number.isFinite(Number(propQ.seqCounter))
        ? `q-${String(Number(propQ.seqCounter) + 1).padStart(4, '0')}`
        : null
      const blockedList = propQ && Array.isArray(propQ.blocked) ? propQ.blocked : []
      const queueRows = items.map((it, i) => {
        const status = asText(it.status) || 'other'
        const deadline = asText(it.deadlineAt)
        const overdue = deadline && Number.isFinite(Date.parse(deadline)) && Date.parse(deadline) < Date.now()
        const prio = it.priority == null ? null : (it.effectivePriority != null && String(it.effectivePriority) !== String(it.priority)
          ? `${it.priority} → ${it.effectivePriority}`
          : String(it.priority))
        return h('tr', { key: asText(it.ticket) || asText(it.id) || `p-${i}` }, [
          h('td', { className: 'mono', key: 'ticket' }, [
            h('div', { key: 't' }, asText(it.ticket) || '—'),
            asText(it.id) ? h('div', { className: 'snippet', key: 'id' }, asText(it.id)) : null,
          ]),
          h('td', { className: 'mono', key: 'sid' }, shortSession(it.originSessionId || it.sessionId)),
          h('td', { key: 'target' }, [
            h('div', { className: 'mono', key: 't' }, asText(it.target) || '—'),
            asText(it.title) ? h('div', { className: 'snippet', key: 'title' }, asText(it.title)) : null,
          ]),
          h('td', { className: 'mono', key: 'op' }, asText(it.op) || '—'),
          h('td', { className: 'num', key: 'prio' }, prio || '—'),
          h('td', { className: 'num', key: 'deadline' }, deadline ? (overdue ? h('span', { className: 'chip bad' }, '已过期') : fmtTime(deadline)) : '—'),
          h('td', { key: 'status' }, h('span', { className: `chip ${asText(it.tone) || PROPOSAL_TONE[status] || 'mute'}` }, asText(it.statusLabel) || PROPOSAL_LABEL[status] || status)),
        ])
      })
      const queueSection = h('section', { className: 'section', key: 'router-queue' }, [
        h('h2', null, [
          '提案队列',
          h('span', { className: 'chip', key: 'c' }, `${counts.total != null ? counts.total : items.length} 条`),
          prop.oldestAgeMs != null ? h('span', { className: 'chip', key: 'old' }, `最老 ${fmtAge(prop.oldestAgeMs)}`) : null,
          nextTicket ? h('span', { className: 'chip', key: 'next' }, `下一张票 ${nextTicket}`) : null,
          propQ && propQ.etaMs != null ? h('span', { className: 'chip', key: 'eta' }, `预计约 ${fmtAge(propQ.etaMs)}`) : null,
        ]),
        // 五键来自 status.queue（计数对象），不是运行队列。
        q ? h('div', { className: 'row', key: 'queue5' }, [
          h('span', { className: 'chip', key: 'lbl' }, `status.queue 合计 ${qTotal}`),
          ...queueChips,
        ]) : null,
        // proposals.queue.writer：顶部「正在写」条（DESIGN §6.5，1209 行）。
        h('div', { className: 'row', key: 'writer' }, [
          h('span', { className: 'chip solid', key: 'lbl' }, '正在写'),
          writer
            ? h(React.Fragment, null, [
              h('span', { className: 'chip warn', key: 'ticket' }, asText(writer.ticket) || '—'),
              h('span', { className: 'chip mute', key: 'prop' }, asText(writer.proposalId) || '—'),
              h('span', { className: 'chip mute', key: 'sid' }, shortSession(writer.sessionId)),
              h('span', { className: 'chip mute', key: 'since' }, `自 ${fmtTime(writer.since)}`),
            ])
            : h('span', { className: 'chip mute', key: 'idle' }, '当前没有写者'),
        ]),
        // proposals.queue.blocked[]：红色角标 +「请主人裁决」（DESIGN §6.5，1211 行）。
        blockedList.length ? h('div', { className: 'alerts', key: 'blocked' }, blockedList.map((b, i) => h('div', { className: 'alert bad', key: asText(b && b.ticket) || `b-${i}` }, [
          h('div', { className: 't' }, [
            h('span', { className: 'chip bad', key: 'tag' }, '请主人裁决'),
            asText(b && b.ticket) || `#${i + 1}`,
          ]),
          h('div', { className: 'd', key: 'reason' }, `${asText(b && b.reason) || '没有给原因'}${b && b.since ? `（自 ${fmtTime(b.since)}）` : ''}`),
        ]))) : null,
        fileChips.length ? h('div', { className: 'row', key: 'counts' }, [
          h('span', { className: 'chip', key: 'lbl' }, '文件扫描'),
          ...fileChips,
        ]) : null,
        prop.truncated ? h('div', { className: 'notice', key: 'trunc' }, `提案目录超过 ${prop.limit} 条，这里只显示前 ${prop.limit} 条。`) : null,
        prop.unreadable ? h('div', { className: 'notice', key: 'bad' }, `${prop.unreadable} 个提案文件读不出来（JSON 坏了或没有权限），已跳过。`) : null,
        prop.source === 'none' && qTotal > 0
          ? h('div', { className: 'notice', key: 'src' }, '提案目录还没有可读文件；上面五键来自 status.json 的 queue，与列表不是同一来源。')
          : null,
        items.length
          ? h('table', { key: 'table' }, [TH(['票据', '会话', '目标文件', '操作', '优先级', '截止', '状态']), h('tbody', null, queueRows)])
          : h('div', { className: 'empty', key: 'empty' }, '没有可读的提案（proposals/ 为空）。'),
      ])

      return h(React.Fragment, null, [
        statusSection,
        alertSection,
        boardSection,
        queueSection,
        h('div', { className: 'foot', key: 'foot' }, [
          h('span', { key: 'a' }, '只读窗口：只显示 status / board / proposals 里的字段，不写记忆、不批准提案、不执行写入。'),
          data.generatedAt ? h('span', { key: 'b' }, `数据时间 ${fmtTime(data.generatedAt)}`) : null,
        ]),
      ])
    }

    // ------------------------------------------------------------------
    // 本轮想起（第六页签，A5）
    // 只读 <memoryRoot>/.longlive/recall-log.jsonl：最近几轮召回了哪些条目、
    // 命中词与分数、哪些被隐私门拦下。文件不存在 / 空文件 / 接口没接通都只显示
    // 空态，不崩；这一页不用 SAMPLE 顶班——召回记录的真假不能拿样例冒充。
    // ------------------------------------------------------------------

    function RecallTab({ recall, source, error, loading }) {
      const data = recall || {}
      const items = Array.isArray(data.items) ? data.items : []
      const metrics = data.metrics && typeof data.metrics === 'object' ? data.metrics : {}
      const page = data.page && typeof data.page === 'object' ? data.page : {}
      const live = source === 'live'
      const present = live && data.present !== false
      const parseErrors = Number(data.parseErrors) || 0

      const metric = (value, label, key) => h('div', { className: 'metric', key }, [
        h('b', { key: 'v' }, asText(value) == null ? '—' : asText(value)),
        h('span', { key: 'l' }, label),
      ])

      const fmtScore = (value) => {
        if (value === null || value === undefined || value === '') return '—'
        const n = Number(value)
        return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : '—'
      }

      const entryRow = (entry, kind, key, ctx) => {
        const id = asText(entry && entry.id)
        const title = asText(entry && entry.title)
        const reason = asText(entry && entry.reason)
        return h('tr', { key }, [
          h('td', { className: 'num', key: 'turn' }, ctx.turnLabel),
          h('td', { className: 'num', key: 'at' }, ctx.when),
          h('td', { className: 'mono', key: 'sid' }, ctx.sid),
          h('td', { key: 'state' }, kind === 'blocked'
            ? h('span', { className: 'chip bad' }, '隐私门拦下')
            : h('span', { className: 'chip solid' }, '注入')),
          h('td', { key: 'item' }, [
            h('div', { key: 'title' }, title || '（没有标题）'),
            id ? h('div', { className: 'mono path', key: 'id' }, id) : null,
          ]),
          h('td', { className: 'num', key: 'score' }, kind === 'injected' ? fmtScore(entry && entry.score) : '—'),
          h('td', { key: 'reason' }, reason || '—'),
        ])
      }

      const rows = []
      items.forEach((row, i) => {
        const base = asText(row && row.at) || `row-${i}`
        const turnLabel = row && row.turn != null ? `第 ${asText(row.turn)} 轮` : '轮次未记'
        const when = fmtTime(row && row.at)
        const sid = asText(row && row.sessionId) || '—'
        const injected = row && Array.isArray(row.injected) ? row.injected : []
        const blocked = row && Array.isArray(row.blocked) ? row.blocked : []
        const ctx = { turnLabel, when, sid }
        if (!injected.length && !blocked.length) {
          rows.push(h('tr', { key: `${base}:empty` }, [
            h('td', { className: 'num', key: 'turn' }, turnLabel),
            h('td', { className: 'num', key: 'at' }, when),
            h('td', { className: 'mono', key: 'sid' }, sid),
            h('td', { key: 'state' }, h('span', { className: 'chip mute' }, '无条目')),
            h('td', { key: 'item' }, '这一轮没有注入，也没有被拦下的条目'),
            h('td', { className: 'num', key: 'score' }, '—'),
            h('td', { key: 'reason' }, '—'),
          ]))
          return
        }
        injected.forEach((entry, j) => {
          rows.push(entryRow(entry, 'injected', `${base}:in:${asText(entry && entry.id) || j}`, ctx))
        })
        blocked.forEach((entry, j) => {
          rows.push(entryRow(entry, 'blocked', `${base}:bl:${asText(entry && entry.id) || j}`, ctx))
        })
      })

      const emptyTitle = !live
        ? (loading ? '正在读召回日志' : '读不到召回日志')
        : '本轮没有触发召回'
      const emptyNote = !live
        ? (loading
          ? '等接口回话；读不到也不会拿样例记录顶班。'
          : `召回日志接口没有接通（${asText(error) || 'E_FETCH'}）。这一页不会用样例冒充召回，接口恢复后点「刷新」重试。`)
        : (asText(data.note) || (present
          ? '日志存在，但还没有任何一轮记录（文件为空或全是坏行）。'
          : '还没有 .longlive/recall-log.jsonl；召回钩子写入后，这一页会自动出现记录。'))

      const fileChips = [
        h('span', { className: 'chip mono', key: 'file' }, asText(data.sourceFile) || '.longlive/recall-log.jsonl'),
        live
          ? h('span', { className: `chip ${present ? 'ok' : 'warn'}`, key: 'present' }, present ? '日志已找到' : '日志还不存在')
          : h('span', { className: 'chip warn', key: 'present' }, loading ? '正在读' : '接口未接通'),
        live && parseErrors ? h('span', { className: 'chip bad', key: 'bad' }, `${parseErrors} 行解析失败`) : null,
        live && data.truncated ? h('span', { className: 'chip warn', key: 'trunc' }, '只读了日志尾部') : null,
        live && Number.isFinite(Number(data.size)) && Number(data.size) > 0
          ? h('span', { className: 'chip mute', key: 'size' }, fmtBytes(data.size))
          : null,
        live && Number.isFinite(Number(data.mtimeMs)) && Number(data.mtimeMs) > 0
          ? h('span', { className: 'chip mute', key: 'mtime' }, `写于 ${fmtTime(new Date(Number(data.mtimeMs)).toISOString())}`)
          : null,
      ].filter(Boolean)

      return h(React.Fragment, null, [
        !live && !loading ? h('div', { className: 'notice', key: 'notice' }, '召回日志接口未接通：这一页没有样例数据，不会拿假记录冒充召回。') : null,
        h('section', { className: 'section', key: 'head' }, [
          h('h2', null, [
            '本轮想起',
            h('span', { className: `chip ${live ? 'solid' : 'sample'}`, key: 'tag' }, live ? '实时' : (loading ? '读取中' : '未接通')),
          ]),
          h('div', { className: 'row', key: 'file' }, fileChips),
          items.length
            ? h('div', { className: 'metrics', key: 'metrics' }, [
              metric(metrics.turns != null ? metrics.turns : items.length, '轮次', 'turns'),
              metric(metrics.injected != null ? metrics.injected : 0, '注入条目', 'injected'),
              metric(metrics.blocked != null ? metrics.blocked : 0, '隐私拦截', 'blocked'),
              metric(metrics.sessions != null ? metrics.sessions : 0, '涉及会话', 'sessions'),
              metric(metrics.lastAt ? fmtTime(metrics.lastAt) : '—', '最近一次', 'last'),
            ])
            : null,
        ]),
        h('section', { className: 'section', key: 'items' }, [
          h('h2', null, [
            '召回流水',
            h('span', { className: 'chip', key: 'n' }, `${items.length} 轮`),
            h('span', { className: 'chip mute', key: 'why' }, '命中词 / 分数 / 隐私门'),
          ]),
          items.length
            ? h('table', null, [
              TH(['轮次', '时间', '会话', '状态', '命中的条目', '分数', '命中词 / 为什么被拦']),
              h('tbody', null, rows),
            ])
            : h('div', { className: 'empty', key: 'empty' }, [
              h('div', { key: 't' }, emptyTitle),
              h('div', { className: 'note', key: 'n' }, emptyNote),
            ]),
          page.hasMore
            ? h('div', { className: 'note', key: 'more' }, `日志里还有更早的 ${Math.max(0, (Number(page.total) || 0) - (Number(page.returned) || items.length))} 轮，这里只显示最近 ${Number(page.limit) || items.length} 轮。`)
            : null,
        ]),
      ])
    }

    // ------------------------------------------------------------------
    // 使用说明（第七页签）
    // 纯静态文案：不取接口、不写文件、不发请求；术语第一次出现给一句人话解释，
    // 让第一次用插件的人能照着做完，不必先读源码。
    // ------------------------------------------------------------------

    function HelpTab() {
      const P = (key, text) => h('p', { key }, text)
      const item = (name, text, key) => h('li', { key }, [h('b', null, name), '：', text])
      const step = (title, what, see, key) => h('li', { key }, [
        h('b', null, title),
        h('div', null, what),
        h('div', { className: 'you' }, `你该看到什么：${see}`),
      ])
      const sw = (name, alias, what, key) => h('div', { className: 'switch', key }, [
        h('div', { className: 'name' }, [h('code', null, name), h('span', { className: 'alias' }, alias)]),
        h('div', { className: 'what' }, what),
      ])

      return h(React.Fragment, null, [
        h('section', { className: 'section help', key: 'what' }, [
          h('h2', null, '它是什么'),
          P('p1', 'longlive（久视）做的第一件事，是让哪个会话都是同一个人：记忆卡、状态卡和开机卡放在磁盘上，新会话一开始就把我是谁、刚才在做什么、还有哪几件没做完接上——换会话、多开窗口、断线重连，接上的都是同一段关系和同一套习惯，不是陌生人。'),
          P('p2', '分层，是把最近发生的、长期的结论、做事的步骤分开放在不同文件里；不同会话读的是同一份，所以谁都接得上。'),
          P('p3', '会话本身还是会越聊越长、越卡，所以它顺手带一套卫生工具（截断记录、过滤器、影子记录）——那是打扫，不是身份。它只把整理好的结果摆给你看：不改记忆正文、不联网，也不替你决定该记什么。'),
        ]),
        h('section', { className: 'section help', key: 'see' }, [
          h('h2', null, '装好你会看到什么'),
          P('p1', '侧栏会多一个「潜望镜」。点开是七个页签，从左到右：'),
          h('ul', { key: 'tabs' }, [
            item('六层视图', '先看这里，确认自己接上了：记忆库分了几层、每层多少条，以及现在有哪些会话在跑。', 't1'),
            item('过滤器决策', '一条内容该不该进记忆，打分和理由。', 't2'),
            item('影子记录', '路由对每个动作的放行 / 询问 / 拒绝（影子＝只记录、不真拦；路由＝决定一个动作能不能做的检查）。', 't3'),
            item('常驻 Router', 'Router 的心跳、共享大脑、提案队列和风险告警；没装时显示「未启用」，不报错。', 't4'),
            item('本轮想起', '最近几轮实际注入过哪些记忆、命中词和分数，以及哪些被隐私门拦下；没有召回时显示「本轮没有触发召回」。', 't5'),
            item('截断记录', '维护页：会话日志被剪短的账。两份账都列——事件截断（truncate.json）与可见对话截断（truncate-visible.json），剪前多大、剪后多大、备份/归档在哪。', 't6'),
            item('使用说明', '就是这一页。', 't7'),
          ]),
          P('p2', '第一次装好，先去「六层视图」看活体行，确认自己接上了；「截断记录」是维护页，等会话太长要减负时再看。'),
        ]),
        h('section', { className: 'section help', key: 'identity' }, [
          h('h2', null, '身份上移：让新会话接上'),
          P('p1', '一个 agent 默认把身份绑在当前会话上；会话一换，它就像失忆。身份上移就是把「我是谁、停在哪、在等什么」从会话里拿出来，放进磁盘上的文件，让下一个会话一开机就接上。'),
          P('p2', '现在能做的是「开机卡」：打开后，每个新会话的第一条真人消息之后会插入一段隐藏上下文（不是聊天气泡），内容来自 STATE.md 的三节——我在哪、在等什么、最近三件。它只注入、不写回，也不改你的记忆正文。'),
          h('ol', { key: 'steps' }, [
            step('① 写 STATE.md', '在记忆根目录建 STATE.md，用三个二级标题「我在哪」「在等什么」「最近三件」，每节只写结论和坐标，不写过程。', '文件存在，三个标题逐字一致；缺哪节，开机卡就少哪节。', 'i1'),
            step('② 打开 identityCard', '配置里写 identityCard.enabled: true，path 默认 <memoryRoot>/STATE.md，maxChars 默认 800。', '重启后页头「接口已接通」；没打开时新会话里不会有开机卡。', 'i2'),
            step('③ 重启宿主', '配置和客户端插件都在启动时加载，改完要重启一次。', '宿主重新起来，工具和面板都在。', 'i3'),
            step('④ 开新会话验证', '新开一个会话，随便说一句话，看它是不是知道上次停在哪。', '它接着上次的线说话；不知道，就先回去核对 STATE.md 的标题和内容。', 'i4'),
            step('⑤ 每段结束更新 STATE.md', 'v0 不会自动写回；不更新，下次开机卡就是旧的。', '新会话里的开机卡跟着你的更新变。', 'i5'),
          ]),
          P('p3', '边界：仓库里有把交接草稿写进 outbox 的写入器（identity-router v0），但还没接进默认安装；常驻 Router 本身已实现并能在面板里只读查看（没开启时显示「未启用」）。'),
        ]),
        h('section', { className: 'section help', key: 'brain' }, [
          h('h2', null, '共享大脑 v1 在看什么'),
          P('p1', 'Router 不只自己跑，还会把「谁在跑、在做什么、最近交接了什么」写到一张共享板上（board.json）。这样多个会话不用互相读聊天记录，也能知道彼此在干嘛。面板的「常驻 Router」页就是把这张板、Router 的心跳和待办摆出来给你看。'),
          P('p2', '你会在那一页看到四样东西：'),
          h('ul', { key: 'list' }, [
            item('心跳', 'Router 每隔一会儿报一次「我还活着、上次干活是什么时候、下次什么时候醒」。停了或卡住，状态会变，风险栏会提醒。', 'b1'),
            item('共享板', '当前活跃的会话、各自的任务、共享焦点和最近交接。只显示板上已有的字段，面板不替它推断。', 'b2'),
            item('提案队列', '想改记忆的会话先交一张「提案」排队，不会直接动手。票据号、谁提的、改哪个文件、操作、优先级和截止时间，都在这张表里；正文和证据不出口。', 'b3'),
            item('风险告警', 'Router 每一轮给的告警（info / warn / error 三档，面板只翻成灰 / 黄 / 红），加上一组开放枚举的诊断码：认识的给中文，不认识的把码原样摆出来，不丢也不猜。', 'b4'),
          ]),
          P('p3', '几个词说人话：'),
          h('ul', { key: 'terms' }, [
            item('租约', '同一时间只许一个会话写，免得两个人同时改同一个文件。拿到租约＝正在写；租约超时只是提醒，面板不会去抢锁。', 'c1'),
            item('CAS', '提案里带着「改之前那份文件的指纹」。真执行前再对一次指纹，对不上就说明别人先改了，不能硬盖。', 'c2'),
            item('冲突', '指纹对不上，或者两条提案改同一段，提案就被标成冲突，等人来看。面板只显示冲突，不解冲突。', 'c3'),
            item('待主人确认', '所有提案都要你点头才会往下走；面板不是批准入口，连提案正文都不展示。', 'c4'),
          ]),
          P('p4', '边界：这一页只是窗口。它不写记忆、不批准提案、不执行提案、不抢租约，也不改 Router 的任何状态；它只读 status.json、board.json 和 proposals/ 里的字段，读不到就显示「未启用」或占位。'),
        ]),
        h('section', { className: 'section help', key: 'router' }, [
          h('h2', null, '路由器：动作先过一道判定'),
          P('p1', 'R1 路由替你把每个动作分三档：allow（放行）、ask（要你确认）、deny（拒绝）。它只管判定，不替代宿主的权限系统。'),
          h('ul', { key: 'modes' }, [
            item('off', '不判定、不记录，行为与旧版一致。默认就是它。', 'r1'),
            item('shadow', '只判定 + 记录到 <memoryRoot>/router-runtime.jsonl，不拦任何调用；「影子记录」页看的就是它。', 'r2'),
            item('on', '高风险写会被拒，只读调用永不拒；on 还没在真机验收，先别开。', 'r3'),
          ]),
          P('p2', '判定依据是 routerPolicyProfile：默认 generic（通用原则，不带任何人的家规）；可以加一份只写差异的家规叠加层。策略读不到、文件坏了，一律 fail-closed（拒绝），不会静默放行。'),
          P('p3', '从 shadow 起步：配置 routerRuntime: shadow，重启，正常干活，去「影子记录」看判定和理由；确认没有误拒，再考虑 on。'),
        ]),
        h('section', { className: 'section help', key: 'switch' }, [
          h('h2', null, '维护：截断的三个开关'),
          P('p0', '共享大脑平时用不到这些；只有会话太长、想让它自动减负时才动。'),
          h('div', { className: 'switches', key: 'list' }, [
            sw('dryrun', '试运行', '只看不剪。它会算出「如果剪能省多少」，但一个字节都不动。新手先停在这里。', 's1'),
            sw('request', '先问', '它把剪短的请求发出来，等人确认后才真的剪。', 's2'),
            sw('on', '自动', '满足条件就自动拦下来剪；碰到危险操作仍然会停下来要你确认。', 's3'),
          ]),
          P('p1', '从 dryrun 起步，看明白了再往右挪一格。'),
          P('p2', '这三个是截断的开关，别和上面路由器的 on 混了；开关不在这一页上——这一页只能看、不能改，它由 longlive 本体读取，要改就去改那边的配置。'),
        ]),
        h('section', { className: 'section help', key: 'first' }, [
          h('h2', null, '第一次用，四步'),
          h('ol', { key: 'steps' }, [
            step('① 看「六层视图」活体行', '先确认自己接上了：六层视图会把当前在跑的会话、它正在做什么、心跳时间，以及六层各有多少条摆在最上面。', '活体行里有你正在用的会话，目标、最近动作和心跳时间都在；六层卡片各自有条数。', 'st1'),
            step('② 开一个新会话验证开机卡', '新开一个会话，随便说一句话，看它是不是知道上次停在哪——开机卡（identityCard）会把「同一个你」接回来，而不是从零开始。', '新会话接着上次的线说话；不知道，就先回去核对 STATE.md 的三个标题与内容。', 'st2'),
            step('③ 看「本轮想起」和「影子记录」', '看大脑怎么想起（最近几轮注入了哪些记忆、命中词和分数），以及它怎么拦动作（每个动作的放行 / 询问 / 拒绝判定）。', '「本轮想起」有轮次、条目、命中词和分数；「影子记录」有动作与判定理由；没有记录时是空态，不拿样例顶班。', 'st3'),
            step('④ 最后才动截断开关', '共享大脑平时用不到这些；只有会话太长、想让它自动减负时才动，先停在 dryrun 观察，别急着切自动。', 'dryrun 下「截断记录」能看到打算剪的条目，但会话日志大小没变。', 'st4'),
          ]),
        ]),
        h('section', { className: 'section help', key: 'trouble' }, [
          h('h2', null, '出问题先看这里'),
          h('div', { className: 'warnbox', key: 'w' }, '下面三条覆盖了最常见的情况；照着看一眼，多半就能自己弄好。'),
          h('ul', { key: 'list' }, [
            h('li', { key: 'b1' }, [
              h('b', null, '侧栏没有「潜望镜」'),
              h('div', null, '查 bundles 清单（宿主记录「装了哪些插件」的那份列表）里有没有 dsh-longlive-panel 这个包名；装完要重启宿主（关掉再打开），界面才会重新加载插件。'),
            ]),
            h('li', { key: 'b2' }, [
              h('b', null, '截断一直没发生'),
              h('div', null, '先看「六层视图」里的活体心跳行（活体＝正在跑的会话），确认它写明了目标、最近动作和时间；再看日志里有没有报错。会话没到阈值（到多长才动手的那条线）本来就不会剪，这是正常的。'),
            ]),
            h('li', { key: 'b3' }, [
              h('b', null, '剪完心里没底'),
              h('div', null, '每次剪之前都会先备份。备份就放在该会话的目录里，文件名形如 session.v4.jsonl.zstd.bak-20261101；「截断记录」页的备份表能看它还在不在盘上。要回滚，先退出宿主，再把备份复制回原名 session.v4.jsonl.zstd 覆盖当前日志。'),
            ]),
          ]),
        ]),
        h('section', { className: 'section help', key: 'never' }, [
          h('h2', null, '它绝不会做什么'),
          h('ul', { key: 'list' }, [
            h('li', { key: 'n1' }, '不删你的记忆正文，也不改任何一张卡的内容。'),
            h('li', { key: 'n2' }, '不在后台联网，不上传任何东西。'),
            h('li', { key: 'n3' }, '没经过你同意就剪会话：dryrun 只看，request 要你点头，on 也只对满足条件的会话动手。'),
            h('li', { key: 'n4' }, '不把隐私内容写进日志：长句会被截断，只留一段摘要和校验用的 hash（一串指纹，用来核对内容没被改过）。'),
            h('li', { key: 'n5' }, '不把开机卡伪装成你说的话：它是一段不可见上下文，不会变成聊天气泡，也不会替你发言。'),
            h('li', { key: 'n6' }, '不批准、不执行提案，也不改 Router 的共享板：那一页只读字段，提案正文和证据都不显示。'),
            h('li', { key: 'n7' }, '不触发召回、不改召回结果：那一页只读 .longlive/recall-log.jsonl，日志不存在或为空时显示空态，不拿样例顶班。'),
          ]),
        ]),
        h('div', { className: 'foot', key: 'foot' }, [
          h('span', { key: 'a' }, '更完整的使用文档见包内 README.md / QUICKSTART.md'),
          h('span', { key: 'b' }, '安装与卸载步骤见 INSTALL.md'),
          h('span', { key: 'c' }, '本页只读：不取接口、不写文件、不发起网络请求'),
        ]),
      ])
    }

    function Panel() {
      useStyles('panel')
      const [tab, setTab] = useState('palace')
      const [summaryRes, refreshSummary] = useRemote('/summary', true)
      const [truncRes, refreshTrunc] = useRemote('/truncations?limit=20', true)
      const [filterRes] = useRemote('/filter?limit=20', true)
      const [shadowRes] = useRemote('/shadow?limit=20', true)
      const [routerRes, refreshRouter] = useRemote('/router', true)
      const [recallRes, refreshRecall] = useRemote('/recall?limit=20', true)
      const [refreshing, setRefreshing] = useState(false)

      const summary = summaryRes.data
      const summaryLive = Boolean(summary)
      const view = useMemo(() => ({
        summary: summary || SAMPLE,
        trunc: truncRes.data || { items: SAMPLE.truncations, backups: SAMPLE.backups, sessionsScanned: null },
        filter: withPreview(filterRes.data, SAMPLE.filter),
        shadow: withPreview(shadowRes.data, SAMPLE.shadow),
        router: routerRes.data || SAMPLE.router,
        recall: recallRes.data || null,
      }), [summary, truncRes.data, filterRes.data, shadowRes.data, routerRes.data, recallRes.data])

      const counts = {
        palace: view.summary.totals ? view.summary.totals.cards : (view.summary.layers || []).length,
        trunc: (view.trunc.items || []).length,
        filter: (view.filter.items || []).length,
        shadow: (view.shadow.items || []).length,
        // 页签角标 = status.queue.pending（协议口径；proposals 文件里的 pending 只是目录扫描结果）。
        router: (((view.router.status || {}).queue || {}).pending) ?? 0,
        recall: (view.recall && view.recall.items ? view.recall.items.length : 0),
        help: null,
      }

      const errors = [summaryRes.error, truncRes.error, filterRes.error, shadowRes.error, routerRes.error, recallRes.error].filter(Boolean)
      const anyLive = summaryLive || Boolean(truncRes.data) || Boolean(filterRes.data) || Boolean(shadowRes.data) || Boolean(routerRes.data) || Boolean(recallRes.data)

      const onRefresh = useCallback(async () => {
        setRefreshing(true)
        refreshSummary()
        refreshTrunc()
        refreshRouter()
        refreshRecall()
        setRefreshing(false)
      }, [refreshSummary, refreshTrunc, refreshRouter, refreshRecall])

      return h('div', { className: 'llp', 'data-main': 'true' },
        h('header', null,
          h('div', null,
            h('h1', null, PANEL_LABEL),
            h('div', { className: 'sub' },
              h('span', null, '只读'),
              view.summary.root ? h('span', { className: 'mono' }, view.summary.root) : null,
              h('span', { className: `chip ${anyLive ? 'solid' : 'sample'}` }, anyLive ? '接口已接通' : '样例数据'),
              h('span', { className: 'chip' }, `v${view.summary.version || PLUGIN_VERSION}`))),
          h('div', { className: 'actions' },
            errors.length ? h('span', { className: 'chip warn', title: errors.join(', ') }, `${errors.length} 个接口失败`) : null,
            h('button', { type: 'button', onClick: onRefresh, disabled: refreshing }, refreshing ? '刷新中…' : '刷新'))),
        h('nav', { className: 'tabs', role: 'tablist' },
          TABS.map((t) => h('button', {
            key: t.id,
            type: 'button',
            role: 'tab',
            'aria-selected': tab === t.id ? 'true' : 'false',
            onClick: () => setTab(t.id),
          }, t.label, counts[t.id] == null ? null : h('span', { className: 'n' }, String(counts[t.id]))))),
        h('main', null,
          errors.length && !anyLive ? h('div', { className: 'notice' }, `接口不可用（${errors.join(', ')}），下面是样例数据。按「刷新」重试。`) : null,
          h(TabErrorBoundary, { key: tab, tabId: tab },
            tab === 'palace' ? h(PalaceTab, { summary: view.summary, source: summaryLive ? 'live' : 'sample' }) : null,
            tab === 'trunc' ? h(TruncTab, { trunc: view.trunc, source: truncRes.data ? 'live' : 'sample' }) : null,
            tab === 'filter' ? h(FilterTab, { filter: view.filter, source: filterRes.data ? 'live' : 'sample' }) : null,
            tab === 'shadow' ? h(ShadowTab, { shadow: view.shadow, source: shadowRes.data ? 'live' : 'sample' }) : null,
            tab === 'router' ? h(RouterTab, { router: view.router, source: routerRes.data ? 'live' : 'sample' }) : null,
            tab === 'recall' ? h(RecallTab, { recall: view.recall, source: recallRes.data ? 'live' : 'sample', error: recallRes.error, loading: recallRes.loading }) : null,
            tab === 'help' ? h(HelpTab, null) : null),
          h('div', { className: 'foot' },
            h('span', null, '本面板不提供任何写操作；所有数据来自 /api/longlive-panel/*'),
            h('span', null, `数据时间 ${fmtTime(view.summary.generatedAt)}`))))
    }

    function PanelIcon({ size }) {
      const s = Number(size) || 20
      return h('svg', {
        width: s,
        height: s,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M3 9.5 12 4l9 5.5' }),
        h('path', { d: 'M5 11v7.5h14V11' }),
        h('path', { d: 'M9.5 18.5v-5h5v5' }))
    }

    // ------------------------------------------------------------------
    // 注册
    // ------------------------------------------------------------------

    const inject = ['slots']

    function apply(ctx) {
      const slots = ctx.slots || (typeof ctx.get === 'function' ? ctx.get('slots') : null)
      if (!slots) return

      slots.inject('main', () => slots.register(
        { name: 'main', key: PANEL_ID, inject: () => ({ workbench: true }) },
        () => h(Panel),
      ))

      slots.inject('sidebar.panellist', () => slots.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: PANEL_LABEL },
        (props) => h(PanelIcon, { size: props && props.size }),
      ))
    }

    exports.apply = apply
    exports.inject = inject
    // 辅助入口只给回归测试用，宿主不消费
    exports.__test = { fmtBytes, fmtAge, fmtTime, shortSha, TABS, SAMPLE, components: { Panel, PalaceTab, TruncTab, FilterTab, ShadowTab, RouterTab, RecallTab, HelpTab } }

    return module.exports
  },
})
