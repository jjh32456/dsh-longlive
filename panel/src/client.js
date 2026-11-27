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
 *   - main：整页面板 = 旧 7 页签（六层视图 / 过滤器决策 / 影子记录 / 常驻 Router / 本轮想起 / 截断记录 / 使用说明）
 *     + 1.6.9 三板块（记忆 / 回忆 / 遗忘）
 *     + 1.8.0 全视图（断言-证据 / 冲突 / 审计 / 角色；内嵌 claims+evidence 版本链、信任分/Bank、帧栈）
 *     + 1.8.2 网络 / 蒸馏（longlive 1.8.8 links + 1.8.11 edges/lifecycle/迁移），并在
 *       六层视图/本轮想起/截断记录三页追加 24h 活动窗、强制召回与链路、自动截断口径
 *     （三板块与 1.8.0 视图不拿 SAMPLE 顶班，未接通就显示未实装/空态）
 *
 * 数据：旧页签走 /api/longlive-panel/*（只读）；三板块走 /api/longlive-panel/v2/*。
 * 动作只允许 longlive G7 的 16 个契约动作名，浏览器不持有能力令牌（面板 server 内部通道现签）。
 * 旧页签拿不到数据时退回 SAMPLE 并挂「样例」标；三板块不拿样例冒充真数据。
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
    // v2（1.6.9）三板块：记忆 / 回忆 / 遗忘。与旧 7 页签并列，旧页签结构不变。
    const V2_TABS = [
      { id: 'v2memory', label: '记忆', unit: '' },
      { id: 'v2recall', label: '回忆', unit: '' },
      { id: 'v2forget', label: '遗忘', unit: '' },
      { id: 'v2records', label: '断言-证据', unit: '' },
      { id: 'v2conflicts', label: '冲突', unit: '' },
      { id: 'v2audit', label: '审计', unit: '' },
      { id: 'v2role', label: '角色', unit: '' },
    ]

    const TABS = [
      { id: 'palace', label: '六层视图', unit: '层' },
      { id: 'filter', label: '过滤器决策', unit: '条' },
      { id: 'shadow', label: '影子记录', unit: '条' },
      { id: 'router', label: '常驻 Router', unit: '条' },
      { id: 'recall', label: '本轮想起', unit: '轮' },
      { id: 'network', label: '网络', unit: '边' },
      { id: 'distill', label: '蒸馏', unit: '卡' },
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
        { sessionId: 'session-e219dedfa08a4eed9cd2ef49', shortId: 'e219dedf', state: 'running', turn: 231, heartbeatAgeMs: 12000, ttlMs: 60000, goal: '主会话示例', blockedOn: null, lastAction: { at: '2026-11-03T13:19:52.672Z', kind: 'turn', detail: 'turn/start #231' } },
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
          files: { vault: '<memoryRoot>', board: '<memoryRoot>/.longlive/router/board.json', audit: '<memoryRoot>/.longlive/router/audit.jsonl' },
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
          { code: 'BLOCKED_ON_USER_EXPIRED', severity: 'error', message: '一条提案等待确认超过 24 小时，请主人处理。', at: '2026-11-03T13:20:00.000Z' },
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
    // 查表一律走 hasOwn：state 来自磁盘上的 JSON，脏数据里可能是 constructor/__proto__ 这类原型链键，
    // 直查会把 Object.prototype 上的东西当结果（对象 child / 非法 className / NaN 比较器）。
    const hasOwnKey = (table, key) => Object.prototype.hasOwnProperty.call(table, key)
    function stateLabel(state) {
      if (hasOwnKey(STATE_LABEL, state)) return STATE_LABEL[state]
      return typeof state === 'string' && state ? state.slice(0, 24) : '—'
    }
    function stateTone(state) {
      return hasOwnKey(STATE_TONE, state) ? STATE_TONE[state] : 'mute'
    }

    // 活体行的显示顺序：运行中最上，空闲次之，其它活动态再往后，已归档（dead）永远最后。
    // 旧顺序按心跳从旧到新排，已归档行最长，会把正在跑/空闲的会话挤到表格下面（2026-11-06 用户当场指出）。
    const LIVE_STATE_RANK = { running: 0, idle: 1, blocked: 2, waiting: 3, stale: 4, corrupt: 5 }
    function liveStateRank(state) {
      const rank = hasOwnKey(LIVE_STATE_RANK, state) ? LIVE_STATE_RANK[state] : undefined
      if (rank != null) return rank
      return state === 'dead' ? 9 : 6
    }
    // 心跳未知（null / 读不到）当「最旧」：排在同档最后，不许冒充最新（评审 v1，用例 01）。
    function liveAgeMs(row) {
      const age = row && row.heartbeatAgeMs
      if (age == null) return Number.POSITIVE_INFINITY
      const n = Number(age)
      return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY
    }
    // 先按状态档位，再按心跳（越新越靠前），最后按 sessionId 兜底，保证每次刷新的顺序一致。
    function sortLiveRows(rows) {
      const list = Array.isArray(rows) ? rows.slice() : []
      return list.sort((a, b) => {
        const rank = liveStateRank(a && a.state) - liveStateRank(b && b.state)
        if (rank !== 0) return rank
        const ageA = liveAgeMs(a)
        const ageB = liveAgeMs(b)
        if (ageA !== ageB) {
          if (!Number.isFinite(ageA)) return 1
          if (!Number.isFinite(ageB)) return -1
          return ageA - ageB
        }
        return String((a && a.sessionId) || '').localeCompare(String((b && b.sessionId) || ''))
      })
    }

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
    const ROUTER_QUEUE_LABEL = { pending: '待取号', queued: '已批准待执行', applying: '执行中', blockedOnUser: '等待确认', expired: '已过期' }
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

    // 1.8.2（红队 rt-panel-ui P1/P2 复现修复）：UI 层兜底脱敏与脏数组防护。
    // 数据层（extras/server）已经脱敏；这里再挡一道「换源/字段旁路」——
    // 任何绝对路径（盘符 / UNC / home）都压成 [path]，会话只显示短 id，
    // 数组里混进 null/非对象元素时跳过，不让一个坏行把整页打崩。
    function maskClientPath(value) {
      let s = asText(value)
      if (!s) return '—'
      s = s.replace(/[A-Za-z]:[\\/][^\s"'，。；、）)\]]*/g, '[path]')
      s = s.replace(/\\\\[^\s"'，。；、）)\]]+/g, '[path]')
      s = s.replace(/\/(?:home|Users|root|opt|var|mnt)\/[^\s"'，。；、）)\]]*/g, '[path]')
      // 完整会话 id 也不上屏：session-xxxxxxxx-… 与裸 UUID 都压成短 id。
      s = s.replace(/session-[A-Za-z0-9-]{8,}/g, (m) => {
        const rest = m.slice('session-'.length)
        return rest.length > 12 ? `session-${rest.slice(0, 12)}…` : m
      })
      s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (m) => `${m.slice(0, 8)}…`)
      return s
    }

    // 页头只显示记忆库目录名（如 …/longlive-memory），不显示盘符/用户名绝对路径。
    function maskRootPath(value) {
      const s = asText(value)
      if (!s) return ''
      const m = /[\\/]([^\\/]+)[\\/]?$/.exec(s)
      return m ? `…/${m[1]}` : s
    }

    function objectsOf(value) {
      return Array.isArray(value) ? value.filter((x) => x && typeof x === 'object') : []
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
.llp .fold{border:1px solid var(--llp-border);border-radius:10px;min-width:0}
.llp .fold>summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;cursor:pointer;list-style:none;padding:9px 12px;border-radius:10px;user-select:none}
.llp .fold>summary::-webkit-details-marker{display:none}
.llp .fold>summary::before{content:'▸';color:var(--llp-muted);font-size:11px;line-height:1;flex:none}
.llp .fold[open]>summary::before{content:'▾'}
.llp .fold>summary:hover{background:var(--llp-soft)}
.llp .fold[open]>summary{border-bottom:1px solid var(--llp-border);border-radius:10px 10px 0 0;background:var(--llp-soft)}
.llp .fold>.foldbody{padding:10px 12px 0;overflow-x:auto}
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
.llp nav.v2tabs{display:flex;gap:10px;padding:12px 28px 0;flex:none;flex-wrap:wrap}
.llp nav.v2tabs button{border:1px solid var(--llp-border);border-radius:999px;background:var(--llp-bg);padding:4px 14px;min-height:30px;color:var(--llp-text);font-size:13px}
.llp nav.v2tabs button[aria-selected="true"]{background:color-mix(in srgb,var(--llp-accent) 12%,transparent);border-color:var(--llp-accent);color:var(--llp-accent)}
.llp .v2grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}
.llp .v2field{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--llp-muted)}
.llp .v2field input,.llp .v2field select,.llp .v2field textarea{font:inherit;color:inherit;background:var(--llp-bg);border:1px solid var(--llp-border);border-radius:6px;padding:5px 8px;min-width:0}
.llp .v2field textarea{min-height:56px;resize:vertical}
.llp .v2actions{display:flex;gap:6px;flex-wrap:wrap}
.llp .v2actions button{padding:3px 9px;min-height:26px;font-size:12px}
.llp .banner{border:1px solid var(--llp-border);border-radius:8px;padding:9px 12px;font-size:12.5px}
.llp .banner.bad{border-color:color-mix(in srgb,var(--llp-bad) 45%,var(--llp-border));background:color-mix(in srgb,var(--llp-bad) 7%,transparent);color:var(--llp-bad)}
.llp .banner.warn{border-color:color-mix(in srgb,var(--llp-warn) 40%,var(--llp-border));background:color-mix(in srgb,var(--llp-warn) 7%,transparent);color:var(--llp-warn)}
.llp .preview{border:1px solid var(--llp-border);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;margin-top:8px}
.llp .preview pre{margin:0;font-size:11.5px;overflow:auto;max-height:180px;background:var(--llp-soft);padding:8px;border-radius:6px}
.llp .v2pill{display:inline-flex;gap:4px;align-items:center;border-radius:999px;padding:1px 8px;font-size:11px;background:var(--llp-soft);color:var(--llp-muted)}
.llp .v2pill.ok{color:var(--llp-ok)} .llp .v2pill.warn{color:var(--llp-warn)} .llp .v2pill.bad{color:var(--llp-bad)}
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
      const cards = objectsOf(layers).map((l) => h('div', { className: 'card', key: l.id }, [
        h('div', { className: 'top', key: 'top' }, [
          h('span', { className: 'no', key: 'no' }, `L${l.index}`),
          h(HealthDot, { health: l.health, key: 'dot' }),
        ]),
        h('h3', { key: 'name' }, l.name),
        h('div', { className: 'path', key: 'path' }, maskClientPath(l.path)),
        h('div', { className: 'count', key: 'count' }, [String(l.count ?? 0), h('small', { key: 'u' }, l.unit || '')]),
        h('div', { className: 'note', key: 'note' }, l.note || ''),
      ]))
      return h('div', { className: 'grid' }, cards)
    }

    function LiveTable({ rows, emptyText }) {
      // 脏数据防线：null / 非对象行直接跳过；key 兜底下标，免得重复 sessionId 触发 React key 警告。
      const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : []
      if (!list.length) return h('div', { className: 'empty' }, emptyText || '没有活体心跳行（.longlive/live/*.json 为空）')
      const body = list.map((r, i) => h('tr', { key: r.sessionId == null ? `row-${i}` : String(r.sessionId) }, [
        h('td', { key: 'id' }, [
          h('div', { className: 'mono', key: 'a' }, r.shortId || r.sessionId || `row-${i}`),
          r.workspace ? h('div', { className: 'snippet mono', key: 'b' }, r.workspace) : null,
        ]),
        h('td', { key: 'state' }, h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' } }, [
          h('span', { className: `chip ${stateTone(r.state)}`, key: 's' }, [
            h('span', { className: 'dot', key: 'd' }),
            stateLabel(r.state),
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

    // 已归档折叠：默认收起，**收起时不物化表格**（评审 v1，用例 06：折叠只藏 DOM 等于没减负担），
    // 点开后才挂 LiveTable；<details>/<summary> 保留原生键盘语义与无 JS 时的展开能力。
    // initialOpen 只给回归测试用（假 React 没法点开 summary），宿主不传。
    function ArchivedFold({ rows, initialOpen }) {
      const [open, setOpen] = useState(Boolean(initialOpen))
      const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : []
      const onToggle = (e) => setOpen(Boolean(e && e.currentTarget && e.currentTarget.open))
      return h('details', { className: 'fold', open, onToggle }, [
        h('summary', null, [
          h('span', { className: 'chip', key: 'c' }, `已归档 ${list.length} 行`),
          h('span', { className: 'snippet', key: 'hint' }, '心跳超 4 个心跳周期、读不到，或自报已归档；默认折叠，点开看明细'),
        ]),
        open ? h('div', { className: 'foldbody', key: 'body' }, h(LiveTable, { rows: list })) : null,
      ])
    }

    function PalaceTab({ summary, source, extras }) {
      const badge = h('span', { className: `chip ${source === 'live' ? 'solid' : 'sample'}` }, source === 'live' ? '实时' : '样例')
      const act = extras && extras.present ? extras : null
      const actMetrics = act ? [
        ['近 24h 活动行', act.rows24h],
        ['活跃会话', act.activeSessions24h],
        ['总行数', act.rows],
        ['旧行归档', act.archivedFiles ? act.archivedFiles.length : 0],
        ['归档体积', fmtBytes(act.archivedBytes)],
        ['最早行', fmtTime(act.oldestAt)],
        ['最新行', fmtTime(act.newestAt)],
      ] : []
      const warnings = objectsOf(summary.warnings).map((w) => h('span', { key: w.code, className: 'chip warn' }, maskClientPath(w.code)))
      // 先排好序再分两组：活动行直接展开，已归档行收进折叠，别让历史把当下挤下去。
      const liveRows = sortLiveRows(summary.live)
      const activeRows = liveRows.filter((r) => r && r.state !== 'dead')
      const archivedRows = liveRows.filter((r) => r && r.state === 'dead')
      return h(React.Fragment, null, [
        h('section', { className: 'section', key: 'layers' }, [
          h('h2', null, ['六层', badge]),
          h(LayerGrid, { layers: summary.layers || [] }),
        ]),
        h('section', { className: 'section', key: 'live' }, [
          h('h2', null, ['活体心跳', h('span', { className: 'chip', key: 'c' }, `${activeRows.length} 个活动`)]),
          h(LiveTable, { rows: activeRows, emptyText: '当前没有运行中或空闲的会话' }),
          archivedRows.length
            ? h(ArchivedFold, { rows: archivedRows, key: 'archived' })
            : null,
        ]),
        h('section', { className: 'section', key: 'activity' }, [
          h('h2', null, [
            '活动窗（近 24h）',
            h('span', { className: 'chip', key: 'v' }, '1.8.8'),
            h('span', { className: 'chip mute', key: 'win' }, '时间窗口径：先按 24h 再按行数护栏'),
          ]),
          act
            ? h('div', { key: 'body' }, [
              h('div', { className: 'metrics', key: 'm' }, actMetrics.map(([label, value], i) => h('div', { className: 'metric', key: `m-${i}` }, [
                h('b', { key: 'v' }, asText(value) == null ? '—' : asText(value)),
                h('span', { key: 'l' }, label),
              ]))),
              act.byKind && Object.keys(act.byKind).length
                ? h('div', { className: 'row', key: 'kinds' }, Object.keys(act.byKind).sort().map((k) => h('span', { className: 'chip', key: k }, `${maskClientPath(k)} ${act.byKind[k]}`)))
                : null,
              objectsOf(act.archivedFiles).length
                ? h('div', { className: 'note', key: 'arch' }, objectsOf(act.archivedFiles).map((f) => `${maskClientPath(f.name)}（${fmtBytes(f.sizeBytes)}）`).join(' · '))
                : null,
              act.badLines ? h('div', { className: 'note', key: 'bad' }, `${act.badLines} 行活动记录解析失败，已跳过。`) : null,
            ])
            : h('div', { className: 'empty', key: 'empty' }, '没有读到 .longlive/board/activity.jsonl（活动板未开启或还没有活动）。'),
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

    function TruncTab({ trunc, source, extras }) {
      const items = objectsOf(trunc.items)
      const backups = objectsOf(trunc.backups)
      const badge = h('span', { className: `chip ${source === 'live' ? 'solid' : 'sample'}` }, source === 'live' ? '实时' : '样例')
      const auto = extras && extras.present ? extras : null
      const autoMetrics = auto ? [
        ['模式', auto.mode || '—'],
        ['开关', auto.enabled ? 'enabled' : 'disabled'],
        ['外部日志阈值', auto.thresholds && auto.thresholds.tokensThreshold != null ? `${Number(auto.thresholds.tokensThreshold).toLocaleString('en-US')} tokens` : '—'],
        ['保留轮数 keepTurns', auto.thresholds ? auto.thresholds.keepTurns : '—'],
        ['保留 token keepTokens', auto.thresholds ? Number(auto.thresholds.keepTokens).toLocaleString('en-US') : '—'],
        ['评估次数', auto.counters ? auto.counters.evaluations : '—'],
        ['超阈会话', auto.counters ? auto.counters.over : '—'],
        ['不可切 infeasible', auto.counters ? auto.counters.infeasible : '—'],
      ] : []

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
          h('div', { className: 'mono snippet', key: 'f' }, t.backup ? maskClientPath(String(t.backup).split(/[\\/]/).pop()) : '—'),
          t.backupSha256 ? h('div', { className: 'snippet mono', key: 'h' }, shortSha(t.backupSha256)) : null,
          t.kind === 'visible' && t.archive ? h('div', { className: 'snippet mono', key: 'a' }, `归档 ${maskClientPath(t.archive)}`) : null,
        ]),
      ]))
      const truncTable = items.length
        ? h('table', null, [TH(['时间', '会话', '截断前', '截断后', '省下', '事件 / 消息', '备份']), h('tbody', null, truncRows)])
        : h('div', { className: 'empty' }, '没有截断记录（truncate.json / truncate-visible.json 不存在或为空）')

      const backupRows = backups.map((b) => h('tr', { key: `${b.sessionId}/${b.file}` }, [
        h('td', { className: 'mono', key: 'file' }, maskClientPath(b.file)),
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
        h('section', { className: 'section', key: 'auto' }, [
          h('h2', null, [
            '自动截断口径',
            h('span', { className: 'chip', key: 'v' }, '1.8.10'),
            h('span', { className: 'chip mute', key: 'file' }, '.longlive/auto-truncate-status.json'),
          ]),
          auto
            ? h('div', { key: 'body' }, [
              h('div', { className: 'metrics', key: 'm' }, autoMetrics.map(([label, value], i) => h('div', { className: 'metric', key: `am-${i}` }, [
                h('b', { key: 'v' }, asText(value) == null ? '—' : asText(value)),
                h('span', { key: 'l' }, label),
              ]))),
              h('div', { className: 'note', key: 'why' }, '外部日志阈值与模型上下文线（350k）已解耦：12M tokens ≈ 60MB 会话日志；默认 dryrun 只评估不写请求。'),
              auto.over && objectsOf(auto.over.sessions).length
                ? h('div', { key: 'sessions' }, [
                  h('h3', { key: 't' }, `超阈会话（${auto.over.count ?? objectsOf(auto.over.sessions).length}）`),
                  h('table', { key: 'tbl' }, [
                    TH(['会话', 'tokens', '轮次', '最近评估']),
                    h('tbody', null, objectsOf(auto.over.sessions).map((s, i) => h('tr', { key: `os-${i}` }, [
                      h('td', { className: 'mono', key: 's' }, maskClientPath(s.session)),
                      h('td', { className: 'num', key: 't' }, s.tokens == null ? '—' : Number(s.tokens).toLocaleString('en-US')),
                      h('td', { className: 'num', key: 'n' }, s.turns == null ? '—' : String(s.turns)),
                      h('td', { className: 'num', key: 'a' }, fmtTime(s.at)),
                    ]))),
                  ]),
                ])
                : null,
              auto.lastInfeasible
                ? h('div', { className: 'alert warn', key: 'infeasible' }, [
                  h('div', { className: 't', key: 't' }, '最近一次不可切'),
                  h('div', { className: 'd', key: 'd' }, `${auto.lastInfeasible.code || '—'} · ${auto.lastInfeasible.reason || '没有给原因'}`),
                  h('div', { className: 'snippet mono', key: 'm' }, `${auto.lastInfeasible.session || '—'} · ${fmtTime(auto.lastInfeasible.at)}`),
                ])
                : null,
              auto.lastError
                ? h('div', { className: 'alert bad', key: 'err' }, [
                  h('div', { className: 't', key: 't' }, '最近一次评估错误'),
                  h('div', { className: 'd', key: 'd' }, `${auto.lastError.code || '—'} · ${auto.lastError.message || '—'}`),
                  h('div', { className: 'snippet mono', key: 'm' }, `${auto.lastError.session || '—'} · ${fmtTime(auto.lastError.at)}`),
                ])
                : null,
            ])
            : h('div', { className: 'empty', key: 'empty' }, '没读到自动截断状态（未开启或还没有评估记录）。'),
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
          h('div', { className: 't' }, '有提案等待你确认'),
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
        const code = maskClientPath(asText(w && w.code)) || `W-${i}`
        const known = w && w.known === true
        return h('div', { className: 'row', key: `${srcKey}-${code}-${i}`, title: w && w.detail ? maskClientPath(w.detail) : undefined }, [
          h('span', { className: `chip ${known ? 'warn' : 'mute'}`, key: 'label' }, known ? (maskClientPath(asText(w.label)) || code) : code),
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
        if (pulse.blockedOnUser != null) boardMetrics.push(metric(pulse.blockedOnUser, '等待确认', 'blocked-user'))
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
        // proposals.queue.blocked[]：红色角标 +「请主人确认」（DESIGN §6.5，1211 行）。
        blockedList.length ? h('div', { className: 'alerts', key: 'blocked' }, blockedList.map((b, i) => h('div', { className: 'alert bad', key: asText(b && b.ticket) || `b-${i}` }, [
          h('div', { className: 't' }, [
            h('span', { className: 'chip bad', key: 'tag' }, '请主人确认'),
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

    function RecallTab({ recall, source, error, loading, extras }) {
      const data = recall || {}
      const items = Array.isArray(data.items) ? data.items : []
      const metrics = data.metrics && typeof data.metrics === 'object' ? data.metrics : {}
      const page = data.page && typeof data.page === 'object' ? data.page : {}
      const live = source === 'live'
      const present = live && data.present !== false
      const parseErrors = Number(data.parseErrors) || 0
      const forced = extras && extras.present ? extras : null
      const forcedMetrics = forced ? [
        ['强制召回轮数', forced.counts ? forced.counts.forced : null],
        ['link 命中注入', forced.link ? forced.link.injected : null],
        ['link tokens', forced.link && forced.link.tokens != null ? Number(forced.link.tokens).toLocaleString('en-US') : null],
        ['归档兜底命中', forced.archive ? forced.archive.hits : null],
        ['日志扫了', forced.scanned],
      ] : []

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
        const sid = shortSession(row && row.sessionId)
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
        h('section', { className: 'section', key: 'forced' }, [
          h('h2', null, [
            '强制召回与链路',
            h('span', { className: 'chip', key: 'v' }, '1.8.8'),
            h('span', { className: 'chip mute', key: 'src' }, '.longlive/recall-log.jsonl（尾部）'),
          ]),
          forced
            ? h('div', { key: 'body' }, [
              h('div', { className: 'metrics', key: 'm' }, forcedMetrics.map(([label, value], i) => h('div', { className: 'metric', key: `fm-${i}` }, [
                h('b', { key: 'v' }, asText(value) == null ? '—' : asText(value)),
                h('span', { key: 'l' }, label),
              ]))),
              h('div', { className: 'row', key: 'srcs' }, [
                h('span', { className: 'chip', key: 'lbl' }, '注入来源'),
                h('span', { className: 'chip solid', key: 'link' }, `link ${forced.sources ? forced.sources.link : 0}`),
                h('span', { className: 'chip', key: 'file' }, `file ${forced.sources ? forced.sources.file : 0}`),
                h('span', { className: 'chip', key: 'archive' }, `archive ${forced.sources ? forced.sources.archive : 0}`),
                forced.counts && forced.counts.archiveUnavailable
                  ? h('span', { className: 'chip warn', key: 'unavail' }, `归档不可用 ${forced.counts.archiveUnavailable}`)
                  : null,
              ]),
              objectsOf(forced.recentForced).length
                ? h('div', { key: 'recent' }, [
                  h('h3', { key: 't' }, '最近的强制召回'),
                  h('table', { key: 'tbl' }, [
                    TH(['时间', '会话', '轮', '触发', '结果', '命中', 'link 词', 'token']),
                    h('tbody', null, objectsOf(forced.recentForced).map((r, i) => h('tr', { key: `rf-${i}` }, [
                      h('td', { className: 'num', key: 'a' }, fmtTime(r.at)),
                      h('td', { className: 'mono', key: 's' }, maskClientPath(r.session)),
                      h('td', { className: 'num', key: 'n' }, r.turn == null ? '—' : String(r.turn)),
                      h('td', { key: 'w' }, h('span', { className: 'chip', key: 't' }, r.trigger || '—')),
                      h('td', { key: 'o' }, h('span', { className: `chip ${r.outcome === 'injected' ? 'solid' : (r.error ? 'bad' : 'mute')}`, key: 'x' }, r.outcome || '—')),
                      h('td', { className: 'num', key: 'c' }, r.injectedCount == null ? '—' : String(r.injectedCount)),
                      h('td', { className: 'snippet', key: 'm' }, Array.isArray(r.matchedTerms) && r.matchedTerms.length ? r.matchedTerms.map((t) => maskClientPath(asText(t))).filter(Boolean).join(' / ') || '—' : '—'),
                      h('td', { className: 'num', key: 'k' }, r.estimatedTokens == null ? '—' : Number(r.estimatedTokens).toLocaleString('en-US')),
                    ]))),
                  ]),
                ])
                : h('div', { className: 'empty', key: 'no-forced' }, '日志里还没有 forced 记录（或日志还没写入）。'),
              forced.badLines ? h('div', { className: 'note', key: 'bad' }, `${forced.badLines} 行召回日志解析失败，已跳过。`) : null,
            ])
            : h('div', { className: 'empty', key: 'empty' }, '没读到强制召回统计（.longlive/recall-log.jsonl 不存在或为空）。'),
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
    // 网络（1.8.8 链路 + 1.8.11 edges）与 蒸馏（1.8.11 lifecycle/迁移）
    // 只读：数据来自 /api/longlive-panel/network 与 /distill；
    // 文件缺失只显示空态，不拿样例顶班。
    // ------------------------------------------------------------------

    function NetworkTab({ network, source, error, loading }) {
      const data = network || {}
      const edges = data.edges && typeof data.edges === 'object' ? data.edges : {}
      const links = data.links && typeof data.links === 'object' ? data.links : {}
      const audit = data.audit && typeof data.audit === 'object' ? data.audit : {}
      const live = source === 'live'
      const [typeFilter, setTypeFilter] = useState('')
      const edgeItems = objectsOf(edges.items)
      const shown = typeFilter ? edgeItems.filter((e) => e.type === typeFilter) : edgeItems
      const byType = edges.byType && typeof edges.byType === 'object' ? edges.byType : {}
      const types = Object.keys(byType).sort((a, b) => byType[b] - byType[a] || a.localeCompare(b))
      const metric = (value, label, key) => h('div', { className: 'metric', key }, [
        h('b', { key: 'v' }, asText(value) == null ? '—' : asText(value)),
        h('span', { key: 'l' }, label),
      ])
      const edgeRows = shown.map((e, i) => h('tr', { key: `${asText(e.from)}->${asText(e.to)}:${i}` }, [
        h('td', { key: 'f' }, h('div', { className: 'mono path', key: 'p' }, maskClientPath(e.from))),
        h('td', { key: 't' }, h('div', { className: 'mono path', key: 'p' }, maskClientPath(e.to))),
        h('td', { key: 'ty' }, h('span', { className: 'chip', key: 'c' }, maskClientPath(e.type))),
        h('td', { className: 'num', key: 'cf' }, e.confidence == null ? '—' : String(e.confidence)),
        h('td', { key: 'q' }, h('div', { className: 'snippet', key: 's' }, maskClientPath(e.quote))),
        h('td', { className: 'num', key: 'cr' }, fmtTime(e.createdAt)),
      ]))
      const nodeRows = objectsOf(edges.topNodes).map((n, i) => h('tr', { key: `n-${i}` }, [
        h('td', { key: 'p' }, h('div', { className: 'mono path' }, maskClientPath(n.path))),
        h('td', { className: 'num', key: 'd' }, n.degree == null ? '—' : String(n.degree)),
      ]))
      const termRows = objectsOf(links.topTerms).map((t, i) => h('tr', { key: `t-${i}` }, [
        h('td', { key: 't' }, maskClientPath(t.term)),
        h('td', { className: 'num', key: 'c' }, t.cards == null ? '—' : String(t.cards)),
        h('td', { className: 'num', key: 'w' }, t.weightSum == null ? '—' : String(t.weightSum)),
      ]))
      const learnedRows = objectsOf(links.recentLearned).map((t, i) => h('tr', { key: `l-${i}` }, [
        h('td', { key: 't' }, maskClientPath(t.term)),
        h('td', { key: 'p' }, h('div', { className: 'mono path' }, maskClientPath(t.cardPath))),
        h('td', { className: 'num', key: 'w' }, t.weight == null ? '—' : String(t.weight)),
        h('td', { className: 'num', key: 'u' }, fmtTime(t.updatedAt)),
      ]))
      const auditRows = objectsOf(audit.items).map((a, i) => h('tr', { key: `a-${i}` }, [
        h('td', { className: 'num', key: 'at' }, fmtTime(a.at)),
        h('td', { key: 'ac' }, maskClientPath(a.action)),
        h('td', { key: 'fb' }, maskClientPath(a.feedback)),
        h('td', { className: 'num', key: 'c' }, a.changeCount == null ? '—' : String(a.changeCount)),
        h('td', { key: 'tm' }, Array.isArray(a.terms) ? a.terms.map((t) => asText(t)).filter(Boolean).map((t) => maskClientPath(t)).join(' / ') || '—' : '—'),
      ]))
      return h(React.Fragment, null, [
        !live && !loading ? h('div', { className: 'notice', key: 'notice' }, '网络接口未接通：这一页没有样例数据，不会拿假边冒充记忆网络。') : null,
        h('section', { className: 'section', key: 'head' }, [
          h('h2', null, ['网络（记忆边）', h('span', { className: `chip ${live ? 'solid' : 'sample'}`, key: 'tag' }, live ? '实时' : (loading ? '读取中' : '未接通'))]),
          h('div', { className: 'row', key: 'files' }, [
            h('span', { className: 'chip mono', key: 'e' }, '.longlive/recall/edges.jsonl'),
            h('span', { className: 'chip mono', key: 'l' }, '.longlive/recall/links.jsonl'),
          ]),
          h('div', { className: 'metrics', key: 'm' }, [
            metric(edges.total ?? 0, '边总数', 'edges'),
            metric(edges.nodes ?? 0, '节点', 'nodes'),
            metric(links.total ?? 0, '链路（词→卡）', 'links'),
            metric(links.terms ?? 0, '词', 'terms'),
            metric(links.cards ?? 0, '卡', 'cards'),
            metric(links.learned ?? 0, 'learned 边', 'learned'),
          ]),
          edges.badLines ? h('div', { className: 'note', key: 'bad' }, `${edges.badLines} 行边记录解析失败，已跳过。`) : null,
        ]),
        h('section', { className: 'section', key: 'types' }, [
          h('h2', null, ['边类型分布', h('span', { className: 'chip mute', key: 'n' }, '1.8.11：8 类关系边')]),
          h('div', { className: 'row', key: 'chips' }, [
            h('button', { key: 'all', type: 'button', className: `chip ${typeFilter ? '' : 'solid'}`, onClick: () => setTypeFilter('') }, `全部 ${edges.total ?? 0}`),
            ...types.map((t) => h('button', { key: t, type: 'button', className: `chip ${typeFilter === t ? 'solid' : ''}`, onClick: () => setTypeFilter(typeFilter === t ? '' : t) }, `${t} ${byType[t]}`)),
          ]),
          shown.length
            ? h('table', null, [TH(['从', '到', '类型', '置信度', '证据引文', '建立时间']), h('tbody', null, edgeRows)])
            : h('div', { className: 'empty' }, live ? '没有边记录（.longlive/recall/edges.jsonl 为空或构建脚本还没跑过）。' : '边接口未接通。'),
        ]),
        h('section', { className: 'section', key: 'nodes' }, [
          h('h2', null, ['连接最多的节点', h('span', { className: 'chip', key: 'n' }, `Top ${nodeRows.length}`)]),
          nodeRows.length ? h('table', null, [TH(['卡路径', '度数']), h('tbody', null, nodeRows)]) : h('div', { className: 'empty' }, '没有节点'),
        ]),
        h('section', { className: 'section', key: 'terms' }, [
          h('h2', null, ['学习链路（词 → 卡）', h('span', { className: 'chip mute', key: 'v' }, '1.8.8：seed/learned')]),
          h('div', { className: 'row', key: 'srcs' }, [
            h('span', { className: 'chip', key: 'lbl' }, '来源'),
            h('span', { className: 'chip solid', key: 'seed' }, `seed ${links.bySource ? links.bySource.seed || 0 : 0}`),
            h('span', { className: 'chip', key: 'learned' }, `learned ${links.bySource ? links.bySource.learned || 0 : 0}`),
          ]),
          termRows.length ? h('table', null, [TH(['词', '卡数', '权重和']), h('tbody', null, termRows)]) : h('div', { className: 'empty' }, '没有链路记录'),
          learnedRows.length
            ? h('div', { key: 'learned' }, [
              h('h3', { key: 't' }, '最近学习到的边'),
              h('table', { key: 'tbl' }, [TH(['词', '卡路径', '权重', '更新时间']), h('tbody', null, learnedRows)]),
            ])
            : null,
          auditRows.length
            ? h('div', { key: 'audit' }, [
              h('h3', { key: 't' }, `链路审计（最近 ${auditRows.length} 条）`),
              h('table', { key: 'tbl' }, [TH(['时间', '动作', '反馈', '变更数', '词']), h('tbody', null, auditRows)]),
            ])
            : null,
        ]),
      ])
    }

    function DistillTab({ distill, source, error, loading }) {
      const data = distill || {}
      const cards = data.cards && typeof data.cards === 'object' ? data.cards : {}
      const migrations = data.migrations && typeof data.migrations === 'object' ? data.migrations : {}
      const live = source === 'live'
      const metric = (value, label, key) => h('div', { className: 'metric', key }, [
        h('b', { key: 'v' }, asText(value) == null ? '—' : asText(value)),
        h('span', { key: 'l' }, label),
      ])
      const roomRows = objectsOf(cards.byRoom).map((r, i) => h('tr', { key: `r-${i}` }, [
        h('td', { className: 'mono', key: 'n' }, maskClientPath(r.room)),
        h('td', { className: 'num', key: 't' }, r.total == null ? '—' : String(r.total)),
        h('td', { className: 'num', key: 'c' }, r.canonical == null ? '—' : String(r.canonical)),
        h('td', { className: 'num', key: 'h' }, r.historical == null ? '—' : String(r.historical)),
        h('td', { className: 'num', key: 'm' }, r.none == null ? '—' : String(r.none)),
      ]))
      const histRows = objectsOf(cards.historical).map((c, i) => h('tr', { key: `h-${i}` }, [
        h('td', { key: 'p' }, h('div', { className: 'mono path' }, maskClientPath(c.path))),
        h('td', { key: 't' }, maskClientPath(c.title)),
        h('td', { key: 'l' }, h('span', { className: 'chip mute' }, 'historical')),
        h('td', { key: 's' }, maskClientPath(c.status)),
        h('td', { className: 'mono', key: 'sb' }, maskClientPath(c.supersededBy)),
      ]))
      const migCards = objectsOf(migrations.items).map((m, i) => h('div', { className: 'card', key: `m-${i}` }, [
        h('div', { className: 'top', key: 'top' }, [
          h('span', { className: 'chip solid', key: 'st' }, maskClientPath(m.status) || 'unknown'),
          h('span', { className: 'chip mono', key: 'id' }, maskClientPath(m.migrationId)),
          h('span', { className: 'chip mute', key: 'at' }, fmtTime(m.at)),
        ]),
        h('div', { className: 'row', key: 'counts' }, [
          h('span', { className: 'chip', key: 'c' }, `canonical ${m.cards ? m.cards.canonical || 0 : 0}`),
          h('span', { className: 'chip', key: 'h' }, `historical ${m.cards ? m.cards.historical || 0 : 0}`),
          h('span', { className: 'chip', key: 'x' }, `extracts ${m.extracts == null ? '—' : m.extracts}`),
          h('span', { className: 'chip mute', key: 'b' }, `备份 ${m.backupFiles ?? '—'} 文件 / ${fmtBytes(m.backupBytes)}`),
          m.planSha256 ? h('span', { className: 'chip mono', key: 'sha' }, shortSha(m.planSha256)) : null,
        ]),
        h('div', { className: 'snippet' }, objectsOf(m.reasons).slice(0, 4).map((r) => `${maskClientPath(r.rel)} → ${maskClientPath(r.lifecycle)}：${maskClientPath(r.reason)}`).join('\n').slice(0, 600) || '没有可读的降级理由'),
      ]))
      return h(React.Fragment, null, [
        !live && !loading ? h('div', { className: 'notice', key: 'notice' }, '蒸馏接口未接通：这一页没有样例数据。') : null,
        h('section', { className: 'section', key: 'head' }, [
          h('h2', null, ['蒸馏（卡生命周期）', h('span', { className: `chip ${live ? 'solid' : 'sample'}`, key: 'tag' }, live ? '实时' : (loading ? '读取中' : '未接通'))]),
          h('div', { className: 'row', key: 'files' }, [
            h('span', { className: 'chip mono', key: 'f' }, '卡 frontmatter lifecycle'),
            h('span', { className: 'chip mono', key: 'm' }, '.longlive/lifecycle-migrations/'),
          ]),
          h('div', { className: 'metrics', key: 'm' }, [
            metric(cards.scanned ?? 0, '扫描卡数', 'scanned'),
            metric(cards.canonicalTotal ?? 0, 'canonical（现行）', 'canonical'),
            metric(cards.historicalTotal ?? 0, 'historical（历史）', 'historical'),
            metric(cards.legacyTotal ?? 0, '未标注 lifecycle', 'legacy'),
            metric(migrations.dirs ?? 0, '迁移运行', 'migrations'),
          ]),
          h('div', { className: 'note', key: 'why' }, '1.8.11 口径：historical 默认不进注入，显式历史查询才放行并标「历史口径」；canonical 排序优先。面板只读，不触发蒸馏/迁移。'),
        ]),
        h('section', { className: 'section', key: 'rooms' }, [
          h('h2', null, '按房间分布'),
          roomRows.length ? h('table', null, [TH(['房间', '总数', 'canonical', 'historical', '未标注']), h('tbody', null, roomRows)]) : h('div', { className: 'empty' }, '没有扫到卡'),
        ]),
        h('section', { className: 'section', key: 'historical' }, [
          h('h2', null, ['historical 卡', h('span', { className: 'chip', key: 'n' }, `${cards.historicalTotal ?? 0}`)]),
          histRows.length ? h('table', null, [TH(['卡路径', '标题', 'lifecycle', 'status', 'superseded_by']), h('tbody', null, histRows)]) : h('div', { className: 'empty' }, '没有 historical 卡（迁移还没跑或全部现行）'),
        ]),
        h('section', { className: 'section', key: 'migrations' }, [
          h('h2', null, ['迁移运行记录', h('span', { className: 'chip mute', key: 'n' }, '只读：manifest + 备份统计')]),
          migCards.length ? h('div', { className: 'grid' }, migCards) : h('div', { className: 'empty' }, '没有迁移运行记录（.longlive/lifecycle-migrations/ 为空）'),
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
      return h(React.Fragment, null, [
        h('section', { className: 'section help', key: 'what' }, [
          h('h2', null, '使用说明（潜望镜 · 久视 longlive 面板）'),
          P('p1', '只读优先的记忆治理面板：读 27 条 longlive 只读路由，执行 18 个受控动作（需宿主令牌）。'),
          P('p2', '7 个 v2 页签：记忆 / 回忆 / 遗忘 / 断言-证据 / 冲突 / 审计 / 角色；另有 9 个遗留只读页签（含 1.8.2 新增的「网络」「蒸馏」）。'),
          P('p3', '1.8.2 上屏：记忆网络（edges）、蒸馏（canonical/historical + 迁移记录）、强制召回/链路学习/归档兜底、24h 活动窗、自动截断新阈值口径；并修复 longlive 1.8.12 改名后面板 v2 面脱钩。'),
        ]),
        h('section', { className: 'section help', key: 'perm' }, [
          h('h2', null, '权限与安全边界'),
          h('ul', { key: 'l' }, [
            item('面板不是信任边界', '不直读记忆文件、不落盘凭据；能力令牌只在宿主内存，一次性、TTL ≤60 秒。', 'q1'),
            item('缺失/跨源/CSRF', '缺能力令牌（401 E_NO_CAP）/ 跨源（403 E_ORIGIN）/ CSRF 不符（403 E_CSRF）：动作一律拒绝。', 'q2'),
            item('宿主 secret', '宿主未注入面板 secret：只读/动作 403 E_PANEL_HOST_ONLY（宿主进程外不可自签）。', 'q3'),
            item('actor', '动作身份由宿主令牌绑定（actor=host）；请求体里的 actor 字段不参与鉴权，缺宿主 actor 时 401 E_ACTOR_REQUIRED。', 'q4'),
            item('完整性', '面板完整性校验失败：动作全部禁用，只读展示保留（E_PANEL_INTEGRITY）。', 'q5'),
          ]),
        ]),
        h('section', { className: 'section help', key: 'views' }, [
          h('h2', null, '视图怎么读'),
          h('ul', { key: 'l' }, [
            item('记忆', '六层（工作/情景/语义/程序性/档案/索引）+ 当前帧/帧栈；活体是会话不是记忆；帧 TTL 30 分钟，过期标 stale。', 'v1'),
            item('回忆', '按轮召回条目、候选与 gap；空≠坏。', 'v2'),
            item('遗忘', '归档进 tombstones，不删除；面板只读。', 'v3'),
            item('断言-证据', 'records #17 / claims #18 / evidence 链 #19 / banks #20；trustScore 由宿主计算，面板只显示；低信任 claim 只进候选区、不得作为结论注入。', 'v4'),
            item('冲突', '#21 冲突列表与 conflict.arbitrate（preferA/preferB/both/disputed）。仲裁 ≠ 验证：只记录人工取舍，不证明真假。', 'v5'),
            item('审计', '四指标（错答率/弃答率/覆盖率/幻觉率）只供数；判定归 answer-guard/Gate-3。questionId 缺失显示 unknown；导出在客户端做白名单字段 NDJSON，不做服务端导出。', 'v6'),
            item('角色', '#24 attention / #25 relationships（tier 权重来自响应级 tierWeights + version/CAS）/ #26 personality（retentionBias 对象）/ #27 channels（只读注册，协议 1.8.1+）。', 'v7'),
            item('网络', 'edges（8 类关系边，1.8.11）+ links（词→卡学习链路，1.8.8）+ 链路审计；文件缺失显示空态，不拿样例顶班。', 'v8'),
            item('蒸馏', '卡 lifecycle canonical/historical（1.8.11）+ 迁移运行记录；面板只读，不触发蒸馏/迁移。', 'v9'),
            item('活动窗', '六层视图里的「活动窗（近 24h）」按 1.8.8 时间窗口径统计当前活动板，旧行在 activity-YYYYMM.jsonl。', 'v10'),
          ]),
        ]),
        h('section', { className: 'section help', key: 'degraded' }, [
          h('h2', null, '空态与降级口径'),
          h('ul', { key: 'l' }, [
            item('200 + 空', '没有数据（不是故障）。', 'd1'),
            item('404', '路由未接通/未实装。', 'd2'),
            item('tampered', '宿主写保护侧车（HMAC）校验失败，读侧 fail-safe 不加载正文；不是空数据。', 'd3'),
            item('degraded', '部分行损坏，展示可用部分。', 'd4'),
            item('denied', '仅 #25/#26 在带非 host caller 且 subject 不可读时出现（#24 无 denied 字段）。', 'd5'),
          ]),
        ]),
        h('section', { className: 'section help', key: 'faq' }, [
          h('h2', null, '常见问题'),
          h('ul', { key: 'l' }, [
            item('动作为什么灰了', '缺 version（CAS 源）或完整性校验失败。', 'f1'),
            item('为什么看不到某字段', '该字段无生产者——面板不编造，显示 —/unknown。', 'f2'),
            item('怎么改配置', '宿主 Config / 环境变量（见 INSTALL），面板内无设置页。', 'f3'),
          ]),
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
      const [networkRes, refreshNetwork] = useRemote('/network?limit=30', true)
      const [distillRes, refreshDistill] = useRemote('/distill', true)
      const [systemRes, refreshSystem] = useRemote('/system', true)
      const [v2StateRes, refreshV2State] = useRemote('/v2/state', true)
      const [refreshing, setRefreshing] = useState(false)
      // P1-1：同源页面从 /v2/state 取 per-session CSRF；跨源读不到，POST 缺它必 403。
      useEffect(() => {
        if (v2StateRes.data && asText(v2StateRes.data.csrfToken)) V2_CSRF_TOKEN = String(v2StateRes.data.csrfToken)
      }, [v2StateRes.data])

      const summary = summaryRes.data
      const summaryLive = Boolean(summary)
      const view = useMemo(() => ({
        summary: summary || SAMPLE,
        trunc: truncRes.data || { items: SAMPLE.truncations, backups: SAMPLE.backups, sessionsScanned: null },
        filter: withPreview(filterRes.data, SAMPLE.filter),
        shadow: withPreview(shadowRes.data, SAMPLE.shadow),
        router: routerRes.data || SAMPLE.router,
        recall: recallRes.data || null,
        network: networkRes.data || null,
        distill: distillRes.data || null,
        system: systemRes.data || null,
        v2state: v2StateRes.data || null,
      }), [summary, truncRes.data, filterRes.data, shadowRes.data, routerRes.data, recallRes.data, networkRes.data, distillRes.data, systemRes.data, v2StateRes.data])

      const counts = {
        palace: view.summary.totals ? view.summary.totals.cards : (view.summary.layers || []).length,
        trunc: (view.trunc.items || []).length,
        filter: (view.filter.items || []).length,
        shadow: (view.shadow.items || []).length,
        // 页签角标 = status.queue.pending（协议口径；proposals 文件里的 pending 只是目录扫描结果）。
        router: (((view.router.status || {}).queue || {}).pending) ?? 0,
        recall: (view.recall && view.recall.items ? view.recall.items.length : 0),
        network: (view.network && view.network.edges ? view.network.edges.total || 0 : 0),
        distill: (view.distill && view.distill.cards ? view.distill.cards.historicalTotal || 0 : 0),
        v2memory: null,
        v2recall: null,
        v2forget: null,
        v2records: null,
        v2conflicts: null,
        v2audit: null,
        v2role: null,
        help: null,
      }

      const errors = [summaryRes.error, truncRes.error, filterRes.error, shadowRes.error, routerRes.error, recallRes.error, networkRes.error, distillRes.error, systemRes.error, v2StateRes.error].filter(Boolean)
      const anyLive = summaryLive || Boolean(truncRes.data) || Boolean(filterRes.data) || Boolean(shadowRes.data) || Boolean(routerRes.data) || Boolean(recallRes.data) || Boolean(networkRes.data) || Boolean(distillRes.data) || Boolean(systemRes.data)

      const onRefresh = useCallback(async () => {
        setRefreshing(true)
        refreshSummary()
        refreshTrunc()
        refreshRouter()
        refreshRecall()
        refreshNetwork()
        refreshDistill()
        refreshSystem()
        refreshV2State()
        setRefreshing(false)
      }, [refreshSummary, refreshTrunc, refreshRouter, refreshRecall, refreshNetwork, refreshDistill, refreshSystem, refreshV2State])

      return h('div', { className: 'llp', 'data-main': 'true' },
        h('header', null,
          h('div', null,
            h('h1', null, PANEL_LABEL),
            h('div', { className: 'sub' },
              h('span', null, '只读优先 · 动作走宿主令牌'),
              view.summary.root ? h('span', { className: 'mono' }, maskRootPath(view.summary.root)) : null,
              h('span', { className: `chip ${anyLive ? 'solid' : 'sample'}` }, anyLive ? '接口已接通' : '样例数据'),
              view.v2state && view.v2state.bridge && view.v2state.bridge.available
                ? h('span', { className: 'chip solid' }, 'v2 接口已接通')
                : h('span', { className: 'chip mute' }, 'v2 未接通'),
              h('span', { className: 'chip' }, `v${view.summary.version || PLUGIN_VERSION}`))),
          h('div', { className: 'actions' },
            errors.length ? h('span', { className: 'chip warn', title: errors.join(', ') }, `${errors.length} 个接口失败`) : null,
            h('button', { type: 'button', onClick: onRefresh, disabled: refreshing }, refreshing ? '刷新中…' : '刷新'))),
        h('nav', { className: 'v2tabs', role: 'tablist', 'aria-label': '1.6.9 三板块' },
          V2_TABS.map((t) => h('button', {
            key: t.id,
            type: 'button',
            role: 'tab',
            'aria-selected': tab === t.id ? 'true' : 'false',
            onClick: () => setTab(t.id),
          }, t.label))),
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
            h(V2IntegrityBanner, { v2state: view.v2state, error: v2StateRes.error, loading: v2StateRes.loading }),
            tab === 'v2memory' ? h(MemoryBoardTab, { v2state: view.v2state }) : null,
            tab === 'v2recall' ? h(RecallFlowTab, { v2state: view.v2state }) : null,
            tab === 'v2forget' ? h(ForgetTab, { v2state: view.v2state }) : null,
            tab === 'v2records' ? h(RecordsTab, { v2state: view.v2state }) : null,
            tab === 'v2conflicts' ? h(ConflictTab, { v2state: view.v2state }) : null,
            tab === 'v2audit' ? h(AuditTab, { v2state: view.v2state }) : null,
            tab === 'v2role' ? h(RoleTab, { v2state: view.v2state }) : null,
            tab === 'palace' ? h(PalaceTab, { summary: view.summary, source: summaryLive ? 'live' : 'sample', extras: view.system && view.system.activityWindow }) : null,
            tab === 'trunc' ? h(TruncTab, { trunc: view.trunc, source: truncRes.data ? 'live' : 'sample', extras: view.system && view.system.autoTruncate }) : null,
            tab === 'filter' ? h(FilterTab, { filter: view.filter, source: filterRes.data ? 'live' : 'sample' }) : null,
            tab === 'shadow' ? h(ShadowTab, { shadow: view.shadow, source: shadowRes.data ? 'live' : 'sample' }) : null,
            tab === 'router' ? h(RouterTab, { router: view.router, source: routerRes.data ? 'live' : 'sample' }) : null,
            tab === 'recall' ? h(RecallTab, { recall: view.recall, source: recallRes.data ? 'live' : 'sample', error: recallRes.error, loading: recallRes.loading, extras: view.system && view.system.recallForced }) : null,
            tab === 'network' ? h(NetworkTab, { network: view.network, source: networkRes.data ? 'live' : 'sample', error: networkRes.error, loading: networkRes.loading }) : null,
            tab === 'distill' ? h(DistillTab, { distill: view.distill, source: distillRes.data ? 'live' : 'sample', error: distillRes.error, loading: distillRes.loading }) : null,
            tab === 'help' ? h(HelpTab, null) : null),
          h('div', { className: 'foot' },
            h('span', null, '只读优先 · 18 个受控动作经宿主令牌（27 条只读路由；本页不存 token/凭据）'),
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
    // v2（1.6.9 三板块 + M2-G 动作交互）
    //
    // 只读：/api/longlive-panel/v2/read/<16 路由名>、/v2/state
    // 动作：/api/longlive-panel/v2/actions/{preview|apply|undo}（面板 server 经
    // 宿主内部通道调 longlive M2-G；浏览器永远拿不到能力令牌）。
    // 动作名只允许 16 个契约名；R7 表单在本地先校验，缺参禁用并显示错误码。
    // ------------------------------------------------------------------

    const V2_ACTIONS = [
      'approve', 'reject', 'return', 'promote', 'merge', 'distill', 'archive', 'restore',
      'undo', 'apply', 'annotate', 'dry-run', 'distill.rollback', 'protection.add',
      'protection.remove', 'review.reopen', 'conflict.arbitrate', 'relationship.update',
    ]
    const V2_BUTTON_ACTION = {
      approve: 'approve', reject: 'reject', return: 'return', undo: 'undo', annotate: 'annotate',
      dryRun: 'dry-run', apply: 'apply', promote: 'promote', merge: 'merge', distill: 'distill',
      archive: 'archive', restore: 'restore', distillRollback: 'distill.rollback',
      protectionAdd: 'protection.add', protectionRemove: 'protection.remove',
      reviewReopen: 'review.reopen',
      conflictArbitrate: 'conflict.arbitrate', relationshipUpdate: 'relationship.update',
    }
    const V2_BUTTON_LABEL = {
      approve: '通过', reject: '拒绝', return: '退回', undo: '撤销', annotate: '注释', dryRun: 'dry-run 预览',
      apply: '执行', promote: '提升为卡', merge: '合并', distill: '生成蒸馏', archive: '归档', restore: '恢复归档',
      distillRollback: '回滚蒸馏', protectionAdd: '加入保护', protectionRemove: '移除保护', reviewReopen: '重新打开',
      conflictArbitrate: '仲裁冲突', relationshipUpdate: '更新关系等级',
    }
    // v2.4 §4.4-A 状态→按钮矩阵（与 src/v2-core.js 同源；客户端只认这张表）
    const V2_MATRIX = {
      pending: { approve: true, reject: true, return: true, annotate: true, dryRun: true },
      approved: { annotate: true, dryRun: true },
      rejected: { annotate: true },
      returned: { annotate: true },
      applied: { undo: true, annotate: true },
      failed: { annotate: true, dryRun: true },
      undone: { annotate: true },
      expired: { annotate: true, reviewReopen: true },
    }
    const V2_MIN_REASON = 10

    let V2_CSRF_TOKEN = ''

    async function apiPost(path, body) {
      const res = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-panel-csrf': V2_CSRF_TOKEN },
        body: JSON.stringify(body || {}),
        cache: 'no-store',
        credentials: 'same-origin',
      })
      let json = null
      try { json = await res.json() } catch { json = null }
      if (!res.ok || !json || json.ok === false) {
        const code = json && json.error ? json.error.code : `HTTP_${res.status}`
        const err = new Error(code)
        err.code = code
        err.state = json && json.error ? json.error.state : null
        err.detail = json && json.error ? json.error.message : ''
        throw err
      }
      return json.data || json
    }

    function useV2Read(name, enabled, query) {
      const path = `/v2/read/${name}${query ? `?${query}` : ''}`
      const [res, refresh] = useRemote(path, enabled !== false)
      return {
        loading: res.loading,
        error: res.error,
        routeOk: Boolean(res.data),
        data: res.data && res.data.data ? res.data.data : null,
        v2: res.data || null,
        refresh,
      }
    }

    function v2ButtonsFor(state) {
      return Object.prototype.hasOwnProperty.call(V2_MATRIX, state) ? V2_MATRIX[state] : {}
    }

    /** fail-closed：未接通/完整性未知/锁定 → 所有动作按钮禁用。 */
    function v2LockedOf(v2state) {
      const bridge = v2state && v2state.bridge ? v2state.bridge : null
      const integrity = v2state && v2state.integrity ? v2state.integrity : null
      if (!bridge || !bridge.available) return true
      if (!integrity) return true
      return Boolean(integrity.locked || integrity.status === 'unknown' || integrity.status === 'not-implemented')
    }

    function v2ReviewRow(row) {
      const r = row && typeof row === 'object' ? row : {}
      const target = r.target && typeof r.target === 'object' ? r.target : null
      const state = asText(r.state) || 'unknown'
      const incomplete = !target || !asText(target.kind) || target.version == null
      return {
        raw: r,
        id: asText(r.id),
        kind: asText(r.kind),
        salience: r.salience == null ? null : Number(r.salience),
        state,
        expiry: asText(r.expiry),
        target,
        version: target && target.version != null ? target.version : null,
        decision: r.decision && typeof r.decision === 'object' ? r.decision : null,
        source: asText(r.source),
        incomplete,
        buttons: incomplete ? {} : v2ButtonsFor(state),
      }
    }

    function v2FormatError(e) {
      if (!e) return '未知错误'
      const code = e.code || e.message || 'E_FETCH'
      const state = e.state ? `（${e.state}）` : ''
      const detail = e.detail ? ` ${e.detail}` : ''
      return `${code}${state}${detail}`
    }

    function V2Field({ label, children, key }) {
      return h('label', { className: 'v2field', key }, [h('span', { key: 'l' }, label), children])
    }

    function V2Memo({ label, value, key }) {
      return h('div', { className: 'metric', key }, [h('b', { key: 'v' }, value == null || value === '' ? '—' : String(value)), h('span', { key: 'l' }, label)])
    }

    function V2IntegrityBanner({ v2state, error, loading }) {
      const [probe, setProbe] = useState(null)
      const [probing, setProbing] = useState(false)
      async function runProbe() {
        setProbing(true)
        try {
          const r = await apiGet('/v2/integrity')
          setProbe(r && r.integrity ? r.integrity : (r && r.data && r.data.integrity ? r.data.integrity : null))
        } catch (e) {
          setProbe({ error: v2FormatError(e) })
        } finally {
          setProbing(false)
        }
      }
      if (loading) return h('div', { className: 'banner warn' }, '正在读面板完整性状态…')
      if (error) return h('div', { className: 'banner warn' }, `完整性状态读取失败（${asText(error)}）；动作默认禁用，只读数据仍可看。`)
      const state = v2state || {}
      const bridge = state.bridge || {}
      const integrity = state.integrity || null
      if (!bridge.available) {
        return h('div', { className: 'banner warn' }, 'longlive 1.6.9 面板 API 未接通（memoryV2 未开启 / 未装 1.6.9）。三板块与判定按钮显示「未实装」，只读旧页签不受影响。')
      }
      if (integrity && integrity.locked) {
        const files = (integrity.failedFiles || []).map((f) => f.path).join(', ')
        return h('div', { className: 'banner bad', title: files }, `面板包完整性校验失败（${integrity.lastError || 'E_PANEL_INTEGRITY'}）：动作已全部禁用，只读展示保留。${files ? `失败文件：${files}` : ''}`)
      }
      if (!integrity) {
        const where = state.integrityStatus || 'unknown'
        return h('div', { className: 'banner warn' }, [
          h('div', { key: 't' }, `完整性状态未知（${where}；#16 未实装或读取失败）：动作按钮 fail-closed 禁用，只读数据可看。`),
          h('div', { className: 'row', key: 'r' }, [
            h('button', { key: 'b', type: 'button', disabled: probing, onClick: runProbe }, probing ? '探针检查中…' : '用 dry-run 探针检查'),
            probe ? h('span', { key: 'p', className: 'v2pill' }, probe.error ? `探针失败 ${probe.error}` : `探针：${asText(probe.status) || 'unknown'}（${asText(probe.lastError) || '无错误'}）`) : null,
          ]),
        ])
      }
      if (integrity && integrity.status === 'unknown') {
        return h('div', { className: 'banner warn' }, '完整性状态未知（longlive 返回缺 ok 字段）：动作按钮默认禁用，只读数据可看。')
      }
      const checked = integrity && integrity.checkedAt ? fmtTime(integrity.checkedAt) : '—'
      return h('div', { className: 'row' }, [
        h('span', { className: 'v2pill ok', key: 'ok' }, '面板完整性 OK'),
        h('span', { className: 'v2pill', key: 'mv' }, asText(integrity && integrity.manifestVersion) || 'manifest 未知'),
        h('span', { className: 'v2pill', key: 'at' }, `校验于 ${checked}`),
      ])
    }

    /** 动作执行器：preview →（确认）→ apply；所有动作名来自 V2_ACTIONS。 */
    function V2ActionDialog({ dialog, integrity, onClose, onDone }) {
      const d = dialog || null
      const [values, setValues] = useState({})
      const [busy, setBusy] = useState(false)
      const [preview, setPreview] = useState(null)
      const [result, setResult] = useState(null)
      const [error, setError] = useState(null)
      if (!d) return null
      const button = d.button
      const row = d.row || {}
      const action = V2_BUTTON_ACTION[button]
      const target = row && row.target && typeof row.target === 'object' ? row.target : {}
      const baseTarget = { kind: asText(target.kind) || 'review', id: asText(target.id) || asText(row.id), version: target.version == null ? null : target.version }
      const locked = !integrity || Boolean(integrity.locked || integrity.status === 'unknown' || integrity.status === 'not-implemented')
      const set = (key, value) => setValues((v) => ({ ...v, [key]: value }))
      const isMerge = button === 'merge'
      const isArchive = button === 'archive'
      const isAnnotate = button === 'annotate'
      const isUndo = button === 'undo'
      const isDryRun = button === 'dryRun'
      const isApply = button === 'apply'
      const needsReason = button === 'reject' || button === 'return' || button === 'reviewReopen'
        || button === 'distillRollback' || button === 'protectionAdd' || button === 'protectionRemove'
        || button === 'conflictArbitrate' || button === 'relationshipUpdate'

      function payload() {
        const params = {}
        if (button === 'approve' || button === 'reject' || button === 'return') {
          params.itemId = asText(row.id)
          if (needsReason) params.reason = asText(values.reason)
          if (button === 'return' && asText(values.assignee)) params.assignee = asText(values.assignee)
        } else if (button === 'reviewReopen') {
          params.reviewId = asText(row.id)
          params.reason = asText(values.reason)
        } else if (isUndo) {
          params.actionId = asText(values.actionId)
          params.idempotencyKey = asText(values.idempotencyKey) || `panel-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
        } else if (isAnnotate) {
          params.target = baseTarget
          params.note = asText(values.note)
          params.visibility = values.visibility === 'audit' ? 'audit' : 'panel'
        } else if (isDryRun) {
          params.action = asText(values.action) || 'annotate'
          params.target = baseTarget
          params.params = {}
        } else if (isMerge) {
          const ids = Array.isArray(target.eventIds) ? target.eventIds.map((x) => asText(x)).filter(Boolean) : []
          params.eventIds = Array.isArray(values.eventIds) ? values.eventIds : ids
          params.primaryId = asText(values.primaryId) || ids[0] || ''
        } else if (isArchive) {
          params.recordId = asText(values.recordId) || asText(target.recordId) || asText(target.id)
          params.archiveReport = {
            reason: asText(values.reason), affects: asText(values.affects),
            stillUseful: asText(values.stillUseful), recoverable: values.recoverable === true,
          }
        } else if (button === 'restore') {
          params.archiveId = asText(values.archiveId) || asText(target.id) || asText(target.recordId)
        } else if (button === 'promote') {
          params.distillId = asText(values.distillId) || asText(target.id)
          params.targetKind = asText(values.targetKind) || 'card'
        } else if (button === 'distill') {
          params.sourceIds = Array.isArray(values.sourceIds) ? values.sourceIds : []
          params.mode = 'extractive'
        } else if (button === 'distillRollback') {
          params.distillId = asText(values.distillId) || asText(target.id)
          params.reason = asText(values.reason)
        } else if (button === 'protectionAdd') {
          params.id = asText(values.id) || asText(target.id)
          params.kind = asText(values.kind) || asText(target.kind) || 'memory'
          params.reason = asText(values.reason)
        } else if (button === 'protectionRemove') {
          params.id = asText(values.id) || asText(target.id)
          params.reason = asText(values.reason)
        } else if (button === 'conflictArbitrate') {
          params.conflictId = asText(values.conflictId) || asText(target.id)
          params.resolution = asText(values.resolution) || 'disputed'
          params.reason = asText(values.reason)
          params.expectedVersion = baseTarget.version
        } else if (button === 'relationshipUpdate') {
          params.personId = asText(values.personId) || asText(target.id)
          params.tier = asText(values.tier) || 'familiar'
          params.reason = asText(values.reason)
          params.expectedVersion = baseTarget.version
        } else if (isApply) {
          params.previewId = asText(values.previewId)
          params.idempotencyKey = asText(values.idempotencyKey) || `panel-${Date.now()}`
          params.expectedVersion = values.expectedVersion
        }
        return { action, target: baseTarget, params }
      }

      function localCheck() {
        if (needsReason && asText(values.reason).length < V2_MIN_REASON) return `理由至少 ${V2_MIN_REASON} 字（E_PARAMS）`
        if (isMerge) {
          const ids = Array.isArray(target.eventIds) ? target.eventIds.length : 0
          if (ids < 2 || ids > 10) return 'eventIds 需 2..10 条（E_TARGET_EVENTIDS）'
        }
        if (isArchive) {
          const missing = ['reason', 'affects', 'stillUseful'].filter((k) => !asText(values[k]))
          if (missing.length || typeof values.recoverable !== 'boolean') return `归档三问不完整：${missing.join(',') || 'recoverable'}（E_ARCHIVE_REPORT_INCOMPLETE）`
        }
        if (isAnnotate && asText(values.note).length === 0) return '注释不能为空（E_PARAMS）'
        if (isUndo && !asText(values.actionId)) return '撤销需要 actionId（E_PARAMS）'
        if (isApply && !asText(values.previewId)) return '执行需要 previewId（E_PARAMS）'
        if ((button === 'conflictArbitrate' || button === 'relationshipUpdate') && baseTarget.version == null) return '缺 version 源：CAS 不可用（P0-2，等 #21/#25 schema 补 version）'
        return null
      }

      async function doPreview() {
        const bad = localCheck()
        if (bad) { setError(bad); return }
        setBusy(true); setError(null); setResult(null)
        try {
          setPreview(await apiPost('/v2/actions/preview', payload()))
        } catch (e) {
          setError(v2FormatError(e))
        } finally {
          setBusy(false)
        }
      }

      async function doApply() {
        if (!preview || !preview.previewId) { setError('没有可执行的 previewId'); return }
        if (locked) { setError('完整性锁定：动作已禁用（只读保留）'); return }
        setBusy(true); setError(null)
        try {
          const out = await apiPost('/v2/actions/apply', { previewId: preview.previewId, idempotencyKey: `panel-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, expectedVersion: baseTarget.version })
          setResult(out)
          setPreview(null)
          if (typeof onDone === 'function') onDone(out)
        } catch (e) {
          setError(v2FormatError(e))
        } finally {
          setBusy(false)
        }
      }

      const rows = []
      if (needsReason) rows.push(h(V2Field, { key: 'reason', label: '理由（≥10 字）' }, h('textarea', { value: asText(values.reason), onChange: (e) => set('reason', e.target.value) })))
      if (button === 'return') rows.push(h(V2Field, { key: 'assignee', label: '指派给（可选）' }, h('input', { value: asText(values.assignee), onChange: (e) => set('assignee', e.target.value) })))
      if (isMerge) {
        const ids = Array.isArray(target.eventIds) ? target.eventIds : []
        rows.push(h(V2Field, { key: 'eventIds', label: `eventIds（${ids.length} 条）` }, h('div', null, ids.map((id) => h('label', { key: `e-${id}`, className: 'v2field' }, [h('input', { type: 'checkbox', checked: true, readOnly: true }), ' ', asText(id)])))))
        rows.push(h(V2Field, { key: 'primaryId', label: 'primaryId' }, h('select', { value: asText(values.primaryId) || ids[0] || '', onChange: (e) => set('primaryId', e.target.value) }, ids.map((id) => h('option', { key: id, value: id }, asText(id))))))
      }
      if (isArchive) {
        rows.push(h(V2Field, { key: 'recordId', label: 'recordId（只读）' }, h('input', { value: asText(values.recordId) || asText(target.recordId) || asText(target.id), readOnly: true })))
        rows.push(h(V2Field, { key: 'a-reason', label: '三问 · reason' }, h('input', { value: asText(values.reason), onChange: (e) => set('reason', e.target.value) })))
        rows.push(h(V2Field, { key: 'a-affects', label: '三问 · affects' }, h('input', { value: asText(values.affects), onChange: (e) => set('affects', e.target.value) })))
        rows.push(h(V2Field, { key: 'a-still', label: '三问 · stillUseful' }, h('input', { value: asText(values.stillUseful), onChange: (e) => set('stillUseful', e.target.value) })))
        rows.push(h(V2Field, { key: 'a-recover', label: 'recoverable' }, h('input', { type: 'checkbox', checked: values.recoverable === true, onChange: (e) => set('recoverable', e.target.checked) })))
      }
      if (isAnnotate) {
        rows.push(h(V2Field, { key: 'note', label: '注释（≤500 字）' }, h('textarea', { value: asText(values.note), onChange: (e) => set('note', e.target.value) })))
        rows.push(h(V2Field, { key: 'vis', label: '可见性' }, h('select', { value: asText(values.visibility) || 'panel', onChange: (e) => set('visibility', e.target.value) }, [h('option', { key: 'p', value: 'panel' }, 'panel'), h('option', { key: 'a', value: 'audit' }, 'audit')])))
      }
      if (isUndo) rows.push(h(V2Field, { key: 'aid', label: 'actionId' }, h('input', { value: asText(values.actionId), onChange: (e) => set('actionId', e.target.value) })))
      if (isDryRun) rows.push(h(V2Field, { key: 'da', label: '要预览的动作' }, h('select', { value: asText(values.action) || 'annotate', onChange: (e) => set('action', e.target.value) }, V2_ACTIONS.map((a) => h('option', { key: a, value: a }, a)))))
      if (button === 'distillRollback' || button === 'promote') rows.push(h(V2Field, { key: 'did', label: 'distillId' }, h('input', { value: asText(values.distillId) || asText(target.id), onChange: (e) => set('distillId', e.target.value) })))
      if (button === 'restore') rows.push(h(V2Field, { key: 'arid', label: 'archiveId' }, h('input', { value: asText(values.archiveId) || asText(target.id), onChange: (e) => set('archiveId', e.target.value) })))
      if (button === 'protectionAdd' || button === 'protectionRemove') rows.push(h(V2Field, { key: 'pid', label: '保护条目 id' }, h('input', { value: asText(values.id) || asText(target.id), onChange: (e) => set('id', e.target.value) })))
      if (button === 'protectionAdd') rows.push(h(V2Field, { key: 'pkind', label: 'kind' }, h('input', { value: asText(values.kind) || 'memory', onChange: (e) => set('kind', e.target.value) })))
      if (button === 'conflictArbitrate') rows.push(h(V2Field, { key: 'res', label: '仲裁结果（resolution）' }, h('select', { value: asText(values.resolution) || 'disputed', onChange: (e) => set('resolution', e.target.value) }, ['preferA', 'preferB', 'both', 'disputed'].map((r) => h('option', { key: r, value: r }, r)))))
      if (button === 'relationshipUpdate') rows.push(h(V2Field, { key: 'tier', label: '关系等级（tier）' }, h('select', { value: asText(values.tier) || 'familiar', onChange: (e) => set('tier', e.target.value) }, ['stranger', 'familiar', 'trusted', 'intimate'].map((r) => h('option', { key: r, value: r }, r)))))
      if (isApply) rows.push(h(V2Field, { key: 'pv', label: 'previewId' }, h('input', { value: asText(values.previewId), onChange: (e) => set('previewId', e.target.value) })))

      const previewNode = preview ? h('div', { className: 'preview', key: 'pv' }, [
        h('div', { className: 'row', key: 'h' }, [
          h('b', { key: 'b' }, `预览：${action}`),
          h('span', { className: 'v2pill', key: 'exp' }, `过期 ${fmtTime(preview.expiresAt)}`),
          h('span', { className: 'v2pill', key: 'id' }, asText(preview.previewId)),
        ]),
        h('pre', { key: 'diff' }, JSON.stringify({ diff: preview.diff, risks: preview.risks }, null, 2)),
        h('div', { className: 'v2actions', key: 'a' }, [
          h('button', { key: 'ok', type: 'button', disabled: busy || locked, onClick: doApply }, busy ? '执行中…' : '确认执行'),
          h('button', { key: 'no', type: 'button', onClick: () => setPreview(null) }, '取消预览'),
        ]),
      ]) : null

      return h('section', { className: 'section' }, [
        h('h2', null, [`动作：${V2_BUTTON_LABEL[button] || button}（${action}）`,
          h('span', { className: 'v2pill' }, `target=${baseTarget.kind}:${baseTarget.id}@${baseTarget.version}`)]),
        locked ? h('div', { className: 'banner bad' }, '完整性锁定：动作已全部禁用（只读展示保留）。') : null,
        h('div', { className: 'v2grid' }, rows),
        h('div', { className: 'v2actions', key: 'go' }, [
          h('button', { key: 'pv', type: 'button', disabled: busy || locked, onClick: doPreview }, busy ? '预览中…' : '预览（dry-run 同源）'),
          h('button', { key: 'c', type: 'button', onClick: () => { if (typeof onClose === 'function') onClose() } }, '关闭'),
        ]),
        error ? h('div', { className: 'banner bad', key: 'err' }, error) : null,
        result ? h('div', { className: 'banner', key: 'res' }, `已提交：actionId=${asText(result.actionId)} auditSeq=${asText(result.auditSeq)} status=${asText(result.status)}${result.replayed ? '（重放）' : ''}`) : null,
        previewNode,
      ])
    }

    function V2ReviewTable({ rows, onAction, integrity, emptyNote, locked: lockedProp }) {
      const list = Array.isArray(rows) ? rows : []
      const locked = lockedProp === undefined
        ? (!integrity || Boolean(integrity.locked || integrity.status === 'unknown' || integrity.status === 'not-implemented'))
        : Boolean(lockedProp)
      if (!list.length) return h('div', { className: 'empty' }, [h('div', null, '待判队列为空'), h('div', { className: 'note' }, emptyNote || 'longlive review 队列里没有条目（等 M2-D 产出）。')])
      return h('table', null, [
        TH(['id', 'kind', 'salience', 'state', 'expiry', 'target', 'decision', '动作']),
        h('tbody', null, list.map((row, i) => {
          const keys = Object.keys(row.buttons || {})
          return h('tr', { key: row.id || `row-${i}` }, [
            h('td', { className: 'mono', key: 'id' }, row.id || '—'),
            h('td', { key: 'kind' }, asText(row.kind) || '—'),
            h('td', { className: 'num', key: 'sal' }, row.salience == null ? '—' : String(row.salience)),
            h('td', { key: 'state' }, h('span', { className: `v2pill ${row.state === 'expired' ? 'warn' : row.state === 'applied' ? 'ok' : ''}` }, row.incomplete ? '数据不完整' : row.state)),
            h('td', { className: 'num', key: 'exp' }, asText(row.expiry) ? fmtTime(row.expiry) : '—'),
            h('td', { className: 'mono', key: 'target' }, row.target ? `${asText(row.target.kind)}:${asText(row.target.id)}@${row.version}` : '—'),
            h('td', { key: 'dec' }, row.decision ? `${asText(row.decision.by) || '—'} / ${asText(row.decision.reason) || '—'}` : '—'),
            h('td', { key: 'act' }, h('div', { className: 'v2actions' }, keys.map((b) => h('button', {
              key: b,
              type: 'button',
              disabled: locked || row.incomplete,
              title: locked ? '完整性锁定/未接通：动作禁用' : (row.incomplete ? '数据不完整：缺 target/version/state' : ''),
              onClick: () => { if (typeof onAction === 'function') onAction(b, row) },
            }, V2_BUTTON_LABEL[b] || b)))),
          ])
        })),
      ])
    }

    function MemoryBoardTab({ v2state }) {
      const board = useV2Read('board', true, 'limit=50')
      const status = useV2Read('status', true)
      const live = useV2Read('live', true)
      const activity = useV2Read('activity', true)
      const gap = useV2Read('gap', true)
      const writeHealth = useV2Read('write-health', true)
      const events = useV2Read('events', true, 'limit=50')
      const [anchorDetail, setAnchorDetail] = useState(null)
      const [anchorError, setAnchorError] = useState(null)
      const bridge = v2state && v2state.bridge ? v2state.bridge : null
      const available = Boolean(bridge && bridge.available)

      async function readAnchor(anchorId) {
        setAnchorError(null)
        try {
          const data = await apiGet(`/v2/read/anchor/${encodeURIComponent(anchorId)}`)
          setAnchorDetail({ anchorId, data: data && data.data ? data.data : data })
        } catch (e) {
          setAnchorDetail(null)
          setAnchorError(v2FormatError(e))
        }
      }

      const liveRows = (live.data && (Array.isArray(live.data.rows) ? live.data.rows : Array.isArray(live.data.live) ? live.data.live : [])) || []
      const eventRows = (events.data && (Array.isArray(events.data.items) ? events.data.items : Array.isArray(events.data.rows) ? events.data.rows : [])) || []
      const gapData = gap.data || {}
      const whData = writeHealth.data || {}

      return h(React.Fragment, null, [
        !available ? h('div', { className: 'banner warn', key: 'na' }, '面板 API 未接通：本页以空态/降级展示，只读展示保留。') : null,
        h('div', { className: 'note', key: 'intro' }, '记忆分六层：工作、情景、语义、程序性、档案、索引。活体是会话，不是记忆；历史层数据不全时如实标缺省，不补样例。所有内容只读，改动走受控动作。'),
        h(WorkingFrameCard, { key: 'wf', v2state }),
        h(FramesCard, { key: 'frames', v2state }),
        h('section', { className: 'section', key: 'live' }, [
          h('h2', null, ['实时共享（#3 status / #4 live / #5 activity）', h('span', { className: 'v2pill' }, available ? '接口已接通' : '未实装')]),
          liveRows.length
            ? h('table', null, [TH(['会话', '状态', 'turn', '目标 / 最近动作']), h('tbody', null, liveRows.map((row, i) => {
              const r = row && typeof row === 'object' ? row : {}
              return h('tr', { key: asText(r.sessionId) || `l${i}` }, [
                h('td', { className: 'mono', key: 's' }, asText(r.sessionId) || '—'),
                h('td', { key: 'st' }, asText(r.state) || '—'),
                h('td', { className: 'num', key: 't' }, r.turn == null ? '—' : String(r.turn)),
                h('td', { key: 'g' }, asText(r.goal) || (r.lastAction && asText(r.lastAction.detail)) || '—'),
              ])
            }))])
            : h('div', { className: 'empty' }, [h('div', null, live.loading ? '正在读实时状态' : '没有活体行'), h('div', { className: 'note' }, asText(live.error) || 'longlive live/status 无数据。')]),
          h('div', { className: 'row' }, [
            h('span', { className: 'v2pill', key: 'b' }, `board ${board.data && (Array.isArray(board.data.rows) ? board.data.rows.length : Array.isArray(board.data.items) ? board.data.items.length : '—')}`),
            h('span', { className: 'v2pill', key: 'a' }, activity.routeOk ? 'activity 已接通' : `activity ${asText(activity.error) || '未实装'}`),
            h('span', { className: 'v2pill', key: 's' }, status.routeOk ? 'status 已接通' : `status ${asText(status.error) || '未实装'}`),
          ]),
        ]),
        h('section', { className: 'section', key: 'health' }, [
          h('h2', null, '写入健康（#9 write-health/v1）与双时钟（#7 gap/v1）'),
          h('div', { className: 'metrics' }, [
            h(V2Memo, { key: 'wf', label: 'writesFailed', value: whData.writesFailed }),
            h(V2Memo, { key: 'lo', label: 'lastOkAt', value: whData.lastOkAt ? fmtTime(whData.lastOkAt) : '—' }),
            h(V2Memo, { key: 'qd', label: 'queueDepth', value: whData.queueDepth }),
            h(V2Memo, { key: 'hg', label: 'host-gap（hostGapSec）', value: gapData.hostGapSec }),
            h(V2Memo, { key: 'mg', label: 'memory-gap（gapSec）', value: gapData.gapSec }),
            h(V2Memo, { key: 'src', label: '最近内容来源', value: gapData.sourceFile || '—' }),
          ]),
          Array.isArray(gapData.excluded) && gapData.excluded.length
            ? h('div', { className: 'note' }, `排除项：${gapData.excluded.map((x) => asText(x)).join(', ')}`)
            : null,
        ]),
        h('section', { className: 'section', key: 'events' }, [
          h('h2', null, '事件流（#11 events/v1）与 R1 锚点回读（#15 anchor/:anchorId）'),
          eventRows.length
            ? h('table', null, [TH(['at', 'session', 'turn', 'kind', 'anchorId', '回读']), h('tbody', null, eventRows.slice(0, 50).map((row, i) => {
              const r = row && typeof row === 'object' ? row : {}
              const anchorId = asText(r.anchorId)
              return h('tr', { key: asText(r.id) || `e${i}` }, [
                h('td', { className: 'num', key: 'at' }, r.at ? fmtTime(r.at) : '—'),
                h('td', { className: 'mono', key: 's' }, asText(r.sessionId) || '—'),
                h('td', { className: 'num', key: 't' }, r.turn == null ? '—' : String(r.turn)),
                h('td', { key: 'k' }, asText(r.kind) || '—'),
                h('td', { className: 'mono', key: 'a' }, anchorId || '旧证据（无 anchorId）'),
                h('td', { key: 'btn' }, h('button', { type: 'button', disabled: !anchorId || !available, onClick: () => readAnchor(anchorId) }, '回读原文')),
              ])
            }))])
            : h('div', { className: 'empty' }, [h('div', null, '没有事件行'), h('div', { className: 'note' }, asText(events.error) || 'events/v1 无数据（等 M2-A 索引）。')]),
          anchorDetail ? h('div', { className: 'detail', key: 'detail' }, [
            h('div', { className: 'row' }, [h('b', null, 'anchor/v1'), h('span', { className: 'mono' }, asText(anchorDetail.anchorId))]),
            h('pre', null, JSON.stringify(anchorDetail.data && anchorDetail.data.anchor ? anchorDetail.data.anchor : anchorDetail.data, null, 2)),
          ]) : null,
          anchorError ? h('div', { className: 'banner bad' }, `回读失败：${anchorError}`) : null,
        ]),
      ])
    }

    function RecallFlowTab({ v2state }) {
      const evidence = useV2Read('evidence', true)
      const recallLog = useV2Read('recall-log', true, 'limit=20')
      const [anchorDetail, setAnchorDetail] = useState(null)
      const [anchorError, setAnchorError] = useState(null)
      const [note, setNote] = useState({ note: '', visibility: 'panel' })
      const [feedbackResult, setFeedbackResult] = useState(null)
      const [busy, setBusy] = useState(false)
      const bridge = v2state && v2state.bridge ? v2state.bridge : null
      const integrity = v2state && v2state.integrity ? v2state.integrity : null
      const available = Boolean(bridge && bridge.available)
      const locked = v2LockedOf(v2state)
      const bundle = evidence.data || {}
      const anchors = Array.isArray(bundle.anchors) ? bundle.anchors : []
      const oldEvidence = anchors.length > 0 && anchors.every((a) => !asText(a && a.anchorId))
      const timings = bundle.timings && typeof bundle.timings === 'object' ? bundle.timings : {}

      async function readAnchor(anchorId) {
        setAnchorError(null)
        try {
          const data = await apiGet(`/v2/read/anchor/${encodeURIComponent(anchorId)}`)
          setAnchorDetail({ anchorId, data: data && data.data ? data.data : data })
        } catch (e) {
          setAnchorError(v2FormatError(e))
        }
      }
      async function submitFeedback() {
        setBusy(true); setFeedbackResult(null)
        try {
          const target = { kind: 'evidence', id: asText(bundle.queryId), version: 1 }
          const out = await apiPost('/v2/actions/preview', { action: 'annotate', target, params: { target, note: note.note, visibility: note.visibility } })
          setFeedbackResult({ stage: 'preview', out })
        } catch (e) {
          setFeedbackResult({ stage: 'error', message: v2FormatError(e) })
        } finally {
          setBusy(false)
        }
      }

      return h(React.Fragment, null, [
        h('div', { className: 'note', key: 'intro' }, '本轮想起了什么：按轮展示召回条目、候选与 gap。只读；不显示无生产者字段，缺省显示 —。'),
        h('section', { className: 'section', key: 'ev' }, [
          h('h2', null, ['本轮证据（#6 evidence-package/v1）', h('span', { className: 'v2pill' }, available ? '接口已接通' : '未接通')]),
          !evidence.routeOk && !evidence.loading
            ? h('div', { className: 'empty' }, [h('div', null, '这一轮没有召回记录（可能未启用或本轮无召回），不是故障'), h('div', { className: 'note' }, asText(evidence.error) || 'evidence/latest 无数据。')])
            : h(React.Fragment, null, [
              h('div', { className: 'row' }, [
                h('span', { className: 'v2pill', key: 'q' }, `queryId ${asText(bundle.queryId) || '—'}`),
                h('span', { className: 'v2pill', key: 'st' }, `status ${asText(bundle.status) || 'unknown'}`),
                h('span', { className: 'v2pill', key: 'fa' }, `fastAnswer ${bundle.fastAnswer == null ? '—' : asText(bundle.fastAnswer)}`),
                h('span', { className: 'v2pill', key: 'fb' }, `fallback ${bundle.fallback == null ? '—' : asText(bundle.fallback)}`),
                h('span', { className: 'v2pill', key: 'sha' }, `sha ${(asText(bundle.packageSha256) || '').slice(0, 12) || '—'}`),
              ]),
              h('div', { className: 'metrics', key: 't' }, ['questionAt', 'queueMs', 'prefetchAt', 'retrievedAt', 'evidenceReadyAt'].map((k) => h(V2Memo, { key: k, label: k, value: timings[k] == null ? (k === 'queueMs' ? 'null' : '—') : asText(timings[k]) }))),
              oldEvidence ? h('div', { className: 'banner warn' }, '旧证据包（v2.6 前生成，anchors 无 anchorId）：回读不可用，只显示摘录；这不是错误。') : null,
              anchors.length
                ? h('table', null, [TH(['anchorId', 'l0Status', '摘录', '回读']), h('tbody', null, anchors.map((a, i) => {
                  const x = a && typeof a === 'object' ? a : {}
                  const anchorId = asText(x.anchorId)
                  return h('tr', { key: anchorId || `a${i}` }, [
                    h('td', { className: 'mono', key: 'id' }, anchorId || '旧证据（无 anchorId）'),
                    h('td', { key: 'l0' }, asText(x.l0Status) || '—'),
                    h('td', { key: 'ex' }, asText(x.excerpt) || '—'),
                    h('td', { key: 'btn' }, h('button', { type: 'button', disabled: !anchorId || locked, onClick: () => readAnchor(anchorId) }, anchorId ? '回读原文' : '不可回读')),
                  ])
                }))])
                : h('div', { className: 'empty' }, [h('div', null, '没有锚点'), h('div', { className: 'note' }, '证据包里 anchors 为空；有锚点时每项都带 anchorId，可经 /api/longlive/anchor/:anchorId 回读原文。')]),
              anchorDetail ? h('div', { className: 'detail', key: 'ad' }, [
                h('div', { className: 'row' }, [h('b', null, 'anchor/v1'), h('span', { className: 'mono' }, asText(anchorDetail.anchorId))]),
                h('pre', null, JSON.stringify(anchorDetail.data && anchorDetail.data.anchor ? anchorDetail.data.anchor : anchorDetail.data, null, 2)),
              ]) : null,
              anchorError ? h('div', { className: 'banner bad', key: 'ae' }, `回读失败：${anchorError}`) : null,
              h('div', { className: 'detail', key: 'fb' }, [
                h('b', null, '这条对 / 不对（注释到面板或审计；动作名 annotate）'),
                h('div', { className: 'v2grid' }, [
                  h(V2Field, { key: 'n', label: '注释（≤500 字）' }, h('textarea', { value: note.note, onChange: (e) => setNote({ ...note, note: e.target.value }) })),
                  h(V2Field, { key: 'v', label: '可见性' }, h('select', { value: note.visibility, onChange: (e) => setNote({ ...note, visibility: e.target.value }) }, [h('option', { key: 'p', value: 'panel' }, 'panel'), h('option', { key: 'a', value: 'audit' }, 'audit')])),
                ]),
                h('div', { className: 'v2actions' }, h('button', { type: 'button', disabled: busy || locked || note.note.trim() === '', onClick: submitFeedback }, busy ? '提交中…' : '提交注释预览')),
                feedbackResult && feedbackResult.stage === 'preview' ? h('pre', { key: 'pr' }, JSON.stringify(feedbackResult.out, null, 2)) : null,
                feedbackResult && feedbackResult.stage === 'error' ? h('div', { className: 'banner bad', key: 'er' }, feedbackResult.message) : null,
              ]),
            ]),
        ]),
        h('section', { className: 'section', key: 'hist' }, [
          h('h2', null, '历史召回（#8 recall-log/v1，只读）：按轮列出召回条目与候选；空 ≠ 坏。'),
          recallLog.data && (Array.isArray(recallLog.data.items) ? recallLog.data.items.length : Array.isArray(recallLog.data.rows) ? recallLog.data.rows.length : 0)
            ? h('table', null, [TH(['at', 'sessionId', 'turn', '原样字段']), h('tbody', null, (recallLog.data.items || recallLog.data.rows || []).slice(0, 20).map((row, i) => h('tr', { key: `h${i}` }, [
              h('td', { className: 'num', key: 'at' }, asText(row && row.at) ? fmtTime(row.at) : '—'),
              h('td', { className: 'mono', key: 's' }, asText(row && row.sessionId) || '—'),
              h('td', { className: 'num', key: 't' }, row && row.turn != null ? String(row.turn) : '—'),
              h('td', { className: 'mono', key: 'j' }, JSON.stringify(row).slice(0, 160)),
            ])))])
            : h('div', { className: 'empty' }, [h('div', null, '没有历史召回行'), h('div', { className: 'note' }, asText(recallLog.error) || 'recall-log/v1 无数据（旧 injected/blocked 结构不展示）。')]),
        ]),
      ])
    }

    function ForgetTab({ v2state }) {
      const review = useV2Read('review', true, 'limit=100')
      const distill = useV2Read('distill', true, 'limit=100')
      const archive = useV2Read('archive', true, 'limit=100')
      const protection = useV2Read('protection', true)
      const [dialog, setDialog] = useState(null)
      const [lastResult, setLastResult] = useState(null)
      const [refreshTick, setRefreshTick] = useState(0)
      const integrity = v2state && v2state.integrity ? v2state.integrity : null
      const bridge = v2state && v2state.bridge ? v2state.bridge : null
      const locked = v2LockedOf(v2state)
      const available = Boolean(bridge && bridge.available)
      const rows = ((review.data && (review.data.items || review.data.rows)) || []).map(v2ReviewRow)
      const distillRows = (distill.data && (distill.data.items || distill.data.rows)) || []
      const archiveRows = (archive.data && (archive.data.items || archive.data.rows)) || []
      const protectionData = protection.data || {}

      function onAction(button, row) {
        if (locked || !available) return
        setDialog({ button, row })
      }
      function onDone(result) {
        setLastResult(result)
        setRefreshTick((n) => n + 1)
      }

      return h(React.Fragment, null, [
        h('div', { className: 'note', key: 'intro' }, '遗忘 = 归档，不是删除：条目进 tombstones，仍可审计、可回看。面板只读展示归档与墓碑，不做删除。'),
        h('section', { className: 'section', key: 'queue' }, [
          h('h2', null, ['待判队列（#10 review/v1，G1 字段）', h('span', { className: 'v2pill' }, `${rows.length} 条`)]),
          !available ? h('div', { className: 'banner warn' }, '面板 API 未接通：待判队列显示未实装。') : null,
          h(V2ReviewTable, { rows, onAction, integrity, locked, emptyNote: 'longlive review/v1 无条目（等 M2-D 产出）。' }),
        ]),
        dialog ? h(V2ActionDialog, {
          key: `${dialog.button}-${dialog.row && dialog.row.id}-${refreshTick}`,
          dialog,
          integrity,
          onClose: () => setDialog(null),
          onDone: (out) => { setDialog(null); onDone(out) },
        }) : null,
        lastResult ? h('div', { className: 'banner' }, `动作已提交：actionId=${asText(lastResult.actionId)} auditSeq=${asText(lastResult.auditSeq)} status=${asText(lastResult.status)}`) : null,
        h('section', { className: 'section', key: 'distill' }, [
          h('h2', null, '蒸馏（#12 distill/v1）与回滚（distill.rollback）'),
          distillRows.length
            ? h('table', null, [TH(['id', 'version', 'derivedFrom', 'gist', '动作']), h('tbody', null, distillRows.map((d, i) => h('tr', { key: asText(d && d.id) || `d${i}` }, [
              h('td', { className: 'mono', key: 'id' }, asText(d && d.id) || '—'),
              h('td', { className: 'num', key: 'v' }, d && d.version != null ? String(d.version) : '—'),
              h('td', { className: 'mono', key: 'df' }, asText(d && d.derivedFrom) || '—'),
              h('td', { key: 'g' }, asText(d && d.gist) || '—'),
              h('td', { key: 'a' }, h('div', { className: 'v2actions' }, [
                h('button', { key: 'promote', type: 'button', disabled: locked, onClick: () => setDialog({ button: 'promote', row: { target: { kind: 'distill', id: asText(d && d.id), version: d && d.version } } }) }, '提升为卡'),
                h('button', { key: 'rollback', type: 'button', disabled: locked, onClick: () => setDialog({ button: 'distillRollback', row: { target: { kind: 'distill', id: asText(d && d.id), version: d && d.version } } }) }, '回滚蒸馏'),
              ])),
            ])))])
            : h('div', { className: 'empty' }, '没有蒸馏记录（有记录时可 提升为卡 promote / 回滚蒸馏 distill.rollback）'),
        ]),
        h('section', { className: 'section', key: 'archive' }, [
          h('h2', null, '归档（#13 archive/v1，数据文件 <memoryRoot>/tombstones.md + <memoryRoot>/archive/tombstones/）与恢复（restore）'),
          archiveRows.length
            ? h('table', null, [TH(['id', 'reason', 'affects', 'stillUseful', 'recoverable', 'restored', '动作']), h('tbody', null, archiveRows.map((a, i) => h('tr', { key: asText(a && a.id) || `a${i}` }, [
              h('td', { className: 'mono', key: 'id' }, asText(a && a.id) || '—'),
              h('td', { key: 'r' }, asText(a && a.reason) || '—'),
              h('td', { key: 'af' }, asText(a && a.affects) || '—'),
              h('td', { key: 'su' }, asText(a && a.stillUseful) || '—'),
              h('td', { key: 'rc' }, a && a.recoverable === false ? '否' : '是'),
              h('td', { key: 'rs' }, a && a.restored === true ? '已恢复' : '未恢复'),
              h('td', { key: 'btn' }, h('button', { type: 'button', disabled: locked || (a && a.restored === true), onClick: () => setDialog({ button: 'restore', row: { target: { kind: 'archive', id: asText(a && a.id), version: a && a.version } } }) }, '恢复归档')),
            ])))])
            : h('div', { className: 'empty' }, '没有归档记录'),
        ]),
        h('section', { className: 'section', key: 'protection' }, [
          h('h2', null, ['保护名单（#14 protection/v1；写操作 protection.add / protection.remove）', h('span', { className: 'v2pill' }, `default=${asText(protectionData.default) || '—'}`)]),
          Array.isArray(protectionData.entries) && protectionData.entries.length
            ? h('table', null, [TH(['id', 'kind', 'reason', 'by', 'at', '动作']), h('tbody', null, protectionData.entries.map((p, i) => {
              const row = p && typeof p === 'object' ? p : {}
              const salience = Number(row.salience)
              const removeBlocked = (Number.isFinite(salience) && salience >= 5) || row.locked === true || row.important === true
              return h('tr', { key: asText(row.id) || `p${i}` }, [
                h('td', { className: 'mono', key: 'id' }, asText(row.id) || '—'),
                h('td', { key: 'k' }, asText(row.kind) || '—'),
                h('td', { key: 'r' }, asText(row.reason) || '—'),
                h('td', { key: 'b' }, asText(row.by) || '—'),
                h('td', { className: 'num', key: 'at' }, asText(row.at) ? fmtTime(row.at) : '—'),
                h('td', { key: 'a' }, h('div', { className: 'v2actions' }, [
                  h('button', { key: 'add', type: 'button', disabled: locked, onClick: () => setDialog({ button: 'protectionAdd', row: { target: { kind: 'protection', id: asText(row.id), version: protectionData.version } } }) }, '加入保护'),
                  h('button', { key: 'rm', type: 'button', disabled: locked || removeBlocked, title: removeBlocked ? '重要事件永禁移除（salience==5/locked/重要事件）' : '', onClick: () => setDialog({ button: 'protectionRemove', row: { target: { kind: 'protection', id: asText(row.id), version: protectionData.version } } }) }, '移除保护'),
                ])),
              ])
            }))])
            : h('div', { className: 'empty' }, '保护名单为空'),
        ]),
      ])
    }


    // ------------------------------------------------------------------
    // v2.6.4 / 1.8.0：断言-证据只读页（#17 records）与 working-frame 当前帧
    //
    // 只读：records 来自 longlive #17 只读路由（records/v1）；证据锚点经
    // /v2/read/anchor/<anchorId> 校活；conflict/conflict_with 只展示不裁定。
    // 本页没有任何写操作，也不新增动作名（仲裁仍走 18 动作里的既有动作）。
    // working-frame 为可选路由：longlive 未提供时显示「未实装」，不崩。
    // ------------------------------------------------------------------

    const RECORD_TIER_TONE = { user: 'ok', host: 'solid', agent: 'mute', plugin: 'warn' }

    function RecordsTab({ v2state, recordsOverride }) {
      const liveRecords = useV2Read('records', true, 'limit=200')
      const records = recordsOverride || liveRecords
      const [expanded, setExpanded] = useState(null)
      const [anchorDetail, setAnchorDetail] = useState(null)
      const [anchorError, setAnchorError] = useState(null)
      const bridge = v2state && v2state.bridge ? v2state.bridge : null
      const available = Boolean(bridge && bridge.available)
      const model = records.v2 && records.v2.records ? records.v2.records : null
      const items = model && Array.isArray(model.items) ? model.items : []
      const conflicts = model && Array.isArray(model.conflicts) ? model.conflicts : []
      const byId = {}
      for (const item of items) byId[item.id] = item

      async function readAnchor(anchorId) {
        setAnchorError(null)
        try {
          const data = await apiGet(`/v2/read/anchor/${encodeURIComponent(anchorId)}`)
          setAnchorDetail({ anchorId, data: data && data.data ? data.data : data })
        } catch (e) {
          setAnchorDetail(null)
          setAnchorError(v2FormatError(e))
        }
      }

      const notice = !available
        ? h('div', { className: 'banner warn', key: 'na' }, '面板 API 未接通：断言-证据页以空态/降级展示，只读旧页签不受影响。')
        : null
      const empty = !records.loading && !records.routeOk
        ? h('div', { className: 'empty', key: 'empty' }, [
          h('div', null, '读不到断言记录（records/v1）'),
          h('div', { className: 'note' }, asText(records.error) || 'longlive 未提供 #17 records 路由，或 records.jsonl 还不存在；本页不拿样例行顶班。'),
        ])
        : null

      const summary = model
        ? h('div', { className: 'metrics', key: 'metrics' }, [
          h(V2Memo, { key: 't', label: '断言总数', value: model.total }),
          h(V2Memo, { key: 'c', label: '冲突组', value: model.conflictsCount }),
          h(V2Memo, { key: 'u', label: 'unverified（无证据）', value: model.unverified }),
          h(V2Memo, { key: 'b', label: '坏行', value: model.badLines }),
          h(V2Memo, { key: 's', label: 'schema', value: model.schema }),
        ])
        : null

      const conflictSection = conflicts.length
        ? h('section', { className: 'section', key: 'conflicts' }, [
          h('h2', null, ['冲突（只标注，不自动裁定；双方并排）', h('span', { className: 'v2pill warn' }, `${conflicts.length} 组`)]),
          h('table', null, [
            TH(['subject', 'why', '断言 A', '断言 B']),
            h('tbody', null, conflicts.map((c, i) => {
              const a = byId[c.idA] || null
              const b = byId[c.idB] || null
              return h('tr', { key: `${c.idA}-${c.idB}-${i}` }, [
                h('td', { key: 's' }, asText(c.subject) || '—'),
                h('td', { key: 'w' }, asText(c.why) || '—'),
                h('td', { key: 'a' }, a ? [h('div', { className: 'mono', key: 'id' }, a.id), h('div', { key: 'c' }, a.content || '—')] : asText(c.idA)),
                h('td', { key: 'b' }, b ? [h('div', { className: 'mono', key: 'id' }, b.id), h('div', { key: 'c' }, b.content || '—')] : asText(c.idB)),
              ])
            })),
          ]),
        ])
        : null

      const rows = []
      for (const item of items) {
        const open = expanded === item.id
        rows.push(h('tr', { key: item.id || `r${rows.length}` }, [
          h('td', { key: 'id' }, h('div', { className: 'mono' }, item.id || '—'), h('div', { className: `v2pill ${RECORD_TIER_TONE[item.sourceTier] || 'mute'}` }, `sourceTier=${item.sourceTier}${item.tierDefaulted ? '（默认降级）' : ''}`)),
          h('td', { key: 'kind' }, [h('div', { key: 'k' }, item.kind || '—'), item.subject || item.attribute ? h('div', { className: 'mono', key: 's' }, `${item.subject || ''}${item.attribute ? ` · ${item.attribute}` : ''}`) : null]),
          h('td', { key: 'content' }, asText(item.content) || '—'),
          h('td', { className: 'num', key: 'sal' }, item.salience == null ? '—' : String(item.salience)),
          h('td', { key: 'state' }, h('span', { className: 'v2pill' }, item.state || '—')),
          h('td', { key: 'ev' }, [
            h('div', { key: 'n' }, `${item.evidenceCount} 条证据`),
            item.unverified ? h('span', { className: 'v2pill warn', key: 'u' }, 'unverified') : h('span', { className: 'v2pill ok', key: 'v' }, '有证据'),
          ]),
          h('td', { key: 'conf' }, item.conflict ? h('div', { key: 'c' }, [h('span', { className: 'v2pill bad', key: 'b' }, 'conflict'), ...(item.conflictWith || []).map((id) => h('span', { className: 'v2pill', key: `w-${id}` }, `↔ ${id}`))]) : '—'),
          h('td', { key: 'act' }, h('button', { type: 'button', onClick: () => setExpanded(open ? null : item.id) }, open ? '收起证据' : '展开证据')),
        ]))
        if (open) {
          rows.push(h('tr', { key: `${item.id}-ev` }, [
            h('td', { colSpan: 8, key: 'ev' }, h('div', { className: 'detail' }, [
              h('div', { className: 'row' }, [h('b', { key: 't' }, 'evidence[]（锚点 → 校活）'), h('span', { className: 'v2pill', key: 'n' }, `${item.evidenceCount} 条`)]),
              item.evidence.length
                ? h('table', { key: 'tbl' }, [
                  TH(['anchorId', 'sha256', 'verifiedAt', '回读']),
                  h('tbody', null, item.evidence.map((ev) => h('tr', { key: ev.anchorId }, [
                    h('td', { className: 'mono', key: 'id' }, ev.anchorId),
                    h('td', { className: 'mono', key: 'sha' }, (ev.sha256 || '').slice(0, 16) || '—'),
                    h('td', { className: 'num', key: 'at' }, ev.verifiedAt ? fmtTime(ev.verifiedAt) : '—'),
                    h('td', { key: 'btn' }, h('button', { type: 'button', onClick: () => readAnchor(ev.anchorId) }, '回读原文')),
                  ]))),
                ])
                : h('div', { className: 'empty', key: 'none' }, [h('div', null, '这条断言没有挂证据（unverified）'), h('div', { className: 'note' }, '面板只显示，不替它补证据；需要证据由 longlive 写入侧补。')]),
            ])),
          ]))
        }
      }

      const table = items.length
        ? h('table', null, [
          TH(['id / sourceTier', 'kind / subject', 'content', 'salience', 'state', '证据', 'conflict', '证据详情']),
          h('tbody', null, rows),
        ])
        : empty

      return h(React.Fragment, null, [
        notice,
        h(ClaimsChainCard, { key: 'claims-card', v2state }),
        h(BankTrustCard, { key: 'bank-card', v2state }),
        h('section', { className: 'section', key: 'head' }, [
          h('h2', null, ['断言-证据（#17 records + #18 claims + #19 evidence 链，只读）', h('span', { className: 'v2pill' }, available ? '接口已接通' : '未接通')]),
          summary,
          h('div', { className: 'note' }, '只读：看一条断言从提出、校活到证据链的全程；仲裁 ≠ 验证（只记录取舍，不证明真假）；本页没有写操作。'),
        ]),
        conflictSection,
        h('section', { className: 'section', key: 'list' }, [
          h('h2', null, ['断言列表', h('span', { className: 'v2pill' }, `${items.length} 条`) ]),
          table,
          anchorDetail ? h('div', { className: 'detail', key: 'ad' }, [
            h('div', { className: 'row' }, [h('b', null, 'anchor/v1'), h('span', { className: 'mono' }, asText(anchorDetail.anchorId))]),
            h('pre', null, JSON.stringify(anchorDetail.data && anchorDetail.data.anchor ? anchorDetail.data.anchor : anchorDetail.data, null, 2)),
          ]) : null,
          anchorError ? h('div', { className: 'banner bad', key: 'ae' }, `回读失败：${anchorError}`) : null,
        ]),
      ])
    }

    function WorkingFrameCard({ v2state, frameOverride }) {
      const liveFrame = useV2Read('working-frame', true)
      const frameRes = frameOverride || liveFrame
      const bridge = v2state && v2state.bridge ? v2state.bridge : null
      const available = Boolean(bridge && bridge.available)
      const payload = frameRes.v2 && frameRes.v2.frame ? frameRes.v2.frame : null
      const present = Boolean(payload && payload.present && payload.frame)
      const f = present ? payload.frame : null
      const missing = !frameRes.loading && !frameRes.routeOk
      const chips = f
        ? [
          h('span', { className: 'v2pill', key: 'id' }, `frameId ${asText(f.frameId) || '—'}`),
          h('span', { className: 'v2pill', key: 'no' }, `#${f.frameNo == null ? '—' : f.frameNo}`),
          h('span', { className: 'v2pill', key: 'turn' }, `turnRange ${Array.isArray(f.turnRange) && f.turnRange.length === 2 ? `${f.turnRange[0]}–${f.turnRange[1]}` : '—'}`),
          h('span', { className: 'v2pill', key: 'ttl' }, `ttl ${f.ttlMs == null ? '—' : `${Math.round(f.ttlMs / 60000)}min`}`),
          h('span', { className: `v2pill ${f.state === 'archived' ? 'warn' : f.stale ? 'warn' : 'ok'}`, key: 'state' }, `state ${asText(f.state) || '—'}${f.stale || f.state === 'stale' ? '（过期）' : ''}`),
          h('span', { className: 'v2pill', key: 'at' }, `lastUsedAt ${f.lastUsedAt ? fmtTime(f.lastUsedAt) : '—'}`),
        ]
        : null
      return h('section', { className: 'section', key: 'working-frame' }, [
        h('h2', null, ['当前工作帧（可选只读）：接上本轮的会话帧；TTL 30 分钟（单调时钟），过期即不注入并标 stale；帧不是记忆，不参与召回，只做续接。', h('span', { className: 'v2pill' }, missing ? '未接通' : present ? '当前帧' : '无帧')]),
        !available
          ? h('div', { className: 'banner warn' }, '面板 API 未接通：工作帧显示未实装。')
          : missing
            ? h('div', { className: 'empty' }, [h('div', null, 'working-frame 路由未实装'), h('div', { className: 'note' }, 'longlive 未提供 /api/longlive/working-frame；当前帧只在 pre-step 内部注入，面板不直读文件。')])
            : present
              ? h(React.Fragment, null, [
                h('div', { className: 'row' }, chips),
                h('div', { className: 'kv' }, [
                  h('dt', { key: 'e' }, 'focus.entities'),
                  h('dd', { key: 'ev' }, f.entities && f.entities.length ? f.entities.join(', ') : '—'),
                  h('dt', { key: 'a' }, 'focus.anchors'),
                  h('dd', { key: 'av' }, f.anchors && f.anchors.length ? f.anchors.map((a) => `${a.anchorId}${a.oneLine ? `（${a.oneLine}）` : ''}`).join('；') : '—'),
                ]),
              ])
              : h('div', { className: 'empty' }, [h('div', null, '没有当前工作帧'), h('div', { className: 'note' }, '过期帧会保留并标 stale（不是无帧）；不拿样例顶班。')]),
        frameRes.error ? h('div', { className: 'banner warn' }, `工作帧读取：${asText(frameRes.error)}（按未实装处理）`) : null,
      ])
    }


    // ------------------------------------------------------------------
    // 1.8.0 / v2.8：治理、连续性、角色内核只读视图
    //   #18 claims / #19 evidence 版本链 / #20 banks / #21 conflicts / #22 audit
    //   #23 frames / #24 attention / #25 relationships / #26 personality / #27 channels
    // 只读；动作只走 18 个契约名（conflict.arbitrate / relationship.update）。
    // ------------------------------------------------------------------

    const V2_TIER_NAMES = ['stranger', 'familiar', 'trusted', 'intimate']
    const V2_REL_WEIGHT = { stranger: 1.0, familiar: 1.05, trusted: 1.1, intimate: 1.15 }
    const V2_AG_METRICS = [
      { id: 'wrong', label: '错答率', target: '0' },
      { id: 'refused', label: '弃答率', target: '≤10%' },
      { id: 'coverage', label: '覆盖率', target: '≥90%' },
      { id: 'hallucination', label: '幻觉率', target: '0' },
    ]

    function ClaimsChainCard({ v2state, claimsOverride }) {
      const liveClaims = useV2Read('claims', true, 'limit=200')
      const claims = claimsOverride || liveClaims
      const [chain, setChain] = useState(null)
      const [chainError, setChainError] = useState(null)
      const bridge = v2state && v2state.bridge ? v2state.bridge : null
      const available = Boolean(bridge && bridge.available)
      const model = claims.v2 && claims.v2.model ? claims.v2.model : null
      const items = model && Array.isArray(model.items) ? model.items : []

      async function loadChain(claimId) {
        setChainError(null)
        try {
          const data = await apiGet(`/v2/read/evidence-chain/${encodeURIComponent(claimId)}`)
          setChain({ claimId, model: data && data.model ? data.model : null, data })
        } catch (e) {
          setChain(null)
          setChainError(v2FormatError(e))
        }
      }

      return h('section', { className: 'section', key: 'claims' }, [
        h('h2', null, ['Claim 与证据版本链（#18/#19，只读）：supersedes 指旧版本被新版本取代，链上两版都留。', h('span', { className: 'v2pill' }, available ? '接口已接通' : '未接通')]),
        !available ? h('div', { className: 'banner warn' }, '面板 API 未接通：claims/evidence 显示未实装。') : null,
        items.length
          ? h('table', null, [
            TH(['claimId', 'bankId', 'subject', 'content', '证据数', 'state', 'trustScore', '证据链']),
            h('tbody', null, items.map((c) => h('tr', { key: c.id || c.content }, [
              h('td', { className: 'mono', key: 'id' }, c.id || '—'),
              h('td', { className: 'mono', key: 'bank' }, c.bankId || '—'),
              h('td', { key: 'subject' }, typeof c.subject === 'string' ? c.subject : (c.subject && c.subject.entity ? `${c.subject.entity}${c.subject.attribute ? '.' + c.subject.attribute : ''}` : '—')),
              h('td', { key: 'content' }, c.content || '—'),
              h('td', { className: 'num', key: 'n' }, String(c.evidenceCount)),
              h('td', { key: 'st' }, h('span', { className: `v2pill ${c.conflict ? 'bad' : ''}` }, c.state || '—')),
              h('td', { className: 'num', key: 'trust' }, c.trustScore == null ? '—' : String(c.trustScore)),
              h('td', { key: 'btn' }, h('button', { type: 'button', onClick: () => loadChain(c.id) }, '展开证据链')),
            ]))),
          ])
          : h('div', { className: 'empty' }, [h('div', null, claims.loading ? '正在读 Claim' : '还没有 Claim 数据'), h('div', { className: 'note' }, asText(claims.error) || 'claims.jsonl 为空或尚未写入；不拿样例顶班。')]),
        chain && chain.model
          ? h('div', { className: 'detail', key: 'chain' }, [
            h('div', { className: 'row' }, [
              h('b', { key: 't' }, `证据版本链 · ${chain.claimId}`),
              h('span', { className: 'v2pill', key: 'v' }, `version=${chain.model.version}`),
            ]),
            chain.model.entries.length
              ? h('table', { key: 'tbl' }, [
                TH(['anchorId', 'sha256', 'verifier', 'verifiedAt', 'supersedes']),
                h('tbody', null, chain.model.entries.map((ev, i) => h('tr', { key: ev.anchorId || `e${i}` }, [
                  h('td', { className: 'mono', key: 'id' }, ev.anchorId || '—'),
                  h('td', { className: 'mono', key: 'sha' }, (ev.sha256 || '').slice(0, 16) || '—'),
                  h('td', { key: 'ver' }, ev.verifier || '—'),
                  h('td', { className: 'num', key: 'at' }, ev.verifiedAt ? fmtTime(ev.verifiedAt) : '—'),
                  h('td', { className: 'mono', key: 'sup' }, ev.supersedes || '—'),
                ]))),
              ])
              : h('div', { className: 'empty', key: 'none' }, '这条 Claim 还没有证据版本'),
          ])
          : null,
        chainError ? h('div', { className: 'banner bad', key: 'ce' }, `证据链读取失败：${chainError}`) : null,
      ])
    }

    function BankTrustCard({ v2state, banksOverride, claimsOverride }) {
      const liveBanks = useV2Read('banks', true)
      const liveClaims = useV2Read('claims', true, 'limit=200')
      const banks = banksOverride || liveBanks
      const claims = claimsOverride || liveClaims
      const bridge = v2state && v2state.bridge ? v2state.bridge : null
      const available = Boolean(bridge && bridge.available)
      const bankModel = banks.v2 && banks.v2.model ? banks.v2.model : null
      const claimModel = claims.v2 && claims.v2.model ? claims.v2.model : null
      const bankList = bankModel && Array.isArray(bankModel.banks) ? bankModel.banks : []
      const claimList = claimModel && Array.isArray(claimModel.items) ? claimModel.items : []
      // P1-8：trustScore 由宿主计算；面板只显示 #18 字段，不前端派生公式。
      const lowTrust = claimList.filter((c) => c.trustScore != null && Number(c.trustScore) < 0.35 && c.state !== 'verified')
      return h('section', { className: 'section', key: 'banks' }, [
        h('h2', null, ['信任分 / Bank（#20 banks + #18 claims.trustScore，只读）：信任分由宿主按规则计算，面板只显示，不在前端派生。', h('span', { className: 'v2pill' }, available ? '接口已接通' : '未接通')]),
        !available ? h('div', { className: 'banner warn' }, '面板 API 未接通：Bank/信任分显示未实装。') : null,
        h('div', { className: 'metrics' }, [
          h(V2Memo, { key: 'b', label: 'Bank 数', value: bankList.length }),
          h(V2Memo, { key: 'c', label: 'Claim 数', value: claimList.length }),
          h(V2Memo, { key: 'l', label: '低信任 Claim（<0.35）', value: lowTrust.length }),
        ]),
        bankList.length
          ? h('table', null, [
            TH(['bankId', 'scope', 'owner', 'readers', 'writers', 'auditors']),
            h('tbody', null, bankList.map((b) => h('tr', { key: b.bankId }, [
              h('td', { className: 'mono', key: 'id' }, b.bankId || '—'),
              h('td', { key: 'scope' }, h('span', { className: 'v2pill' }, b.scope)),
              h('td', { key: 'owner' }, b.owner || '—'),
              h('td', { key: 'r' }, b.readers.join(', ') || '—'),
              h('td', { key: 'w' }, b.writers.join(', ') || '—'),
              h('td', { key: 'a' }, b.auditors.join(', ') || '—'),
            ]))),
          ])
          : h('div', { className: 'empty' }, [h('div', null, banks.loading ? '正在读 Bank' : '没有 Bank 数据'), h('div', { className: 'note' }, asText(banks.error) || 'longlive #20 banks 路由未实装或 banks.json 为空。')]),
        h('div', { className: 'note', key: 'ts' }, 'trustScore 来源：宿主按 sourceTier / verifyCount / 时间衰减计算；缺失显示 —，不猜。低于 0.35 视为低信任：面板只显示提示、不阻断任何面板操作；系统侧低信任 claim 只进候选区、不得作为结论注入。'),
        lowTrust.length
          ? h('div', { className: 'note', key: 'lt' }, `低信任候选（不冒泡为结论）：${lowTrust.map((c) => c.id).join(', ')}`)
          : null,
      ])
    }

    function FramesCard({ v2state, framesOverride }) {
      const liveFrames = useV2Read('frames', true)
      const frames = framesOverride || liveFrames
      const bridge = v2state && v2state.bridge ? v2state.bridge : null
      const available = Boolean(bridge && bridge.available)
      const model = frames.v2 && frames.v2.model ? frames.v2.model : null
      const stack = model && Array.isArray(model.stack) ? model.stack : []
      return h('section', { className: 'section', key: 'frames' }, [
        h('h2', null, ['帧栈（#23 frames/v1，只读）：当前 memoryRoot 下各会话的最近帧（跨会话，每行带 sessionId，按 lastUsedAt 倒序，默认 limit 50）；TTL 30 分钟，过期帧保留并标 stale。帧不是记忆，不参与召回。', h('span', { className: 'v2pill' }, available ? '接口已接通' : '未接通')]),
        !available ? h('div', { className: 'banner warn' }, '面板 API 未接通：帧栈显示未实装。') : null,
        stack.length
          ? h('table', null, [
            TH(['sessionId', 'frameId', 'turnRange', 'focus.entities', 'focus.anchors', 'ttl', 'state', 'lastUsedAt']),
            h('tbody', null, stack.map((f) => h('tr', { key: `${f.sessionId || ''}-${f.frameId || ''}` }, [
              h('td', { className: 'mono', key: 'sess' }, f.sessionId || '—'),
              h('td', { className: 'mono', key: 'id' }, f.frameId || '—'),
              h('td', { className: 'num', key: 'turn' }, Array.isArray(f.turnRange) && f.turnRange.length === 2 ? `${f.turnRange[0]}–${f.turnRange[1]}` : '—'),
              h('td', { key: 'ent' }, f.entities.join(', ') || '—'),
              h('td', { className: 'mono', key: 'anc' }, f.anchors.map((a) => a.anchorId).join(', ') || '—'),
              h('td', { className: 'num', key: 'ttl' }, f.ttlMs == null ? '—' : `${Math.round(f.ttlMs / 60000)}min`),
              h('td', { key: 'state' }, h('span', { className: `v2pill ${f.state === 'stale' ? 'warn' : 'ok'}` }, f.state || '—')),
              h('td', { className: 'num', key: 'at' }, f.lastUsedAt ? fmtTime(f.lastUsedAt) : '—'),
            ]))),
          ])
          : h('div', { className: 'empty' }, [h('div', null, frames.loading ? '正在读帧栈' : '没有帧'), h('div', { className: 'note' }, asText(frames.error) || '帧栈为空 = 200 + code:E_FRAMES_EMPTY；仅 404 才显示「未接通」。')]),
      ])
    }

    function ConflictTab({ v2state, conflictsOverride, claimsOverride }) {
      const liveConflicts = useV2Read('conflicts', true)
      const liveClaims = useV2Read('claims', true, 'limit=200')
      const conflicts = conflictsOverride || liveConflicts
      const claims = claimsOverride || liveClaims
      const [dialog, setDialog] = useState(null)
      const [lastResult, setLastResult] = useState(null)
      const bridge = v2state && v2state.bridge ? v2state.bridge : null
      const available = Boolean(bridge && bridge.available)
      const model = conflicts.v2 && conflicts.v2.model ? conflicts.v2.model : null
      const items = model && Array.isArray(model.items) ? model.items : []
      const claimModel = claims.v2 && claims.v2.model ? claims.v2.model : null
      const claimById = {}
      for (const c of (claimModel && claimModel.items) || []) claimById[c.id] = c
      // P0-2：CAS 需要 version 源；无 version 时仲裁禁用（等 #21 schema 补 version）。
      const conflictMatrix = (state, version) => ({ arbitrate: (state === 'open' || state === 'disputed') && version != null })

      return h(React.Fragment, null, [
        h('section', { className: 'section', key: 'list' }, [
          h('h2', null, ['冲突仲裁（#21 conflicts/v1）：列出两条互斥断言及稳定 conflictId，记录人工取舍。注意：仲裁 ≠ 验证——它只记录选择，不证明任一方为真。', h('span', { className: 'v2pill' }, `${items.length} 条`)]),
          !available ? h('div', { className: 'banner warn' }, '面板 API 未接通：冲突以空态/降级展示。') : null,
          items.length
            ? h('table', null, [
              TH(['conflictId', 'subject', 'why', 'claimA', 'claimB', 'state', 'resolution', '动作']),
              h('tbody', null, items.map((c) => {
                const a = claimById[c.claimA] || null
                const b = claimById[c.claimB] || null
                const can = conflictMatrix(c.state, c.version)
                return h('tr', { key: c.conflictId }, [
                  h('td', { className: 'mono', key: 'id' }, c.conflictId || '—'),
                  h('td', { key: 'ver' }, c.version == null ? 'version 缺（CAS 不可用）' : `v${c.version}`),
                  h('td', { key: 'sub' }, c.subject || '—'),
                  h('td', { key: 'why' }, c.why || '—'),
                  h('td', { key: 'a' }, a ? [h('div', { className: 'mono', key: 'id' }, a.id), h('div', { key: 'c' }, a.content)] : (c.claimA || '—')),
                  h('td', { key: 'b' }, b ? [h('div', { className: 'mono', key: 'id' }, b.id), h('div', { key: 'c' }, b.content)] : (c.claimB || '—')),
                  h('td', { key: 'st' }, h('span', { className: `v2pill ${c.state === 'open' ? 'warn' : c.state === 'disputed' ? 'bad' : 'ok'}` }, c.state)),
                  h('td', { key: 'res' }, c.resolution || '—'),
                  h('td', { key: 'act' }, h('button', { type: 'button', disabled: !can.arbitrate, title: can.arbitrate ? '' : '缺 version 源：CAS 不可用（P0-2）', onClick: () => setDialog({ button: 'conflictArbitrate', row: { target: { kind: 'conflict', id: c.conflictId, version: c.version } } }) }, '仲裁')),
                ])
              })),
            ])
            : h('div', { className: 'empty' }, [h('div', null, conflicts.loading ? '正在读冲突' : '没有冲突记录'), h('div', { className: 'note' }, asText(conflicts.error) || '冲突列表为空（200 空）；仅 404 才显示「未接通」。')]),
        ]),
        dialog ? h(V2ActionDialog, {
          key: `cf-${dialog.row && dialog.row.target && dialog.row.target.id}`,
          dialog,
          integrity: v2state && v2state.integrity,
          onClose: () => setDialog(null),
          onDone: (out) => { setDialog(null); setLastResult(out) },
        }) : null,
        lastResult ? h('div', { className: 'banner' }, `仲裁已提交：actionId=${asText(lastResult.actionId)} auditSeq=${asText(lastResult.auditSeq)} status=${asText(lastResult.status)}`) : null,
      ])
    }

    function AuditTab({ v2state, auditOverride }) {
      const liveAudit = useV2Read('audit-records', true)
      const audit = auditOverride || liveAudit
      const [filter, setFilter] = useState({ questionId: '', hit: '', failureReason: '' })
      const [exported, setExported] = useState(null)
      const bridge = v2state && v2state.bridge ? v2state.bridge : null
      const available = Boolean(bridge && bridge.available)
      const model = audit.v2 && audit.v2.model ? audit.v2.model : null
      const items = model && Array.isArray(model.items) ? model.items : []

      function rowsForExport() {
        return items.filter((row) => {
          if (filter.questionId && row.questionKey !== filter.questionId) return false
          if (filter.hit === 'hit' && row.hit !== true) return false
          if (filter.hit === 'miss' && row.hit !== false) return false
          if (filter.failureReason && row.failureReason !== filter.failureReason) return false
          return true
        }).map((row) => ({ at: row.at, recordId: row.recordId, readerTier: row.readerTier, action: row.action, hit: row.hit, failureReason: row.failureReason, questionId: row.questionKey, expectedTurns: row.expectedTurns, answerText: row.answerText, exportable: row.exportable }))
      }

      function exportNdjson() {
        const rows = rowsForExport()
        const text = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')
        setExported({ count: rows.length, bytes: text.length })
        try {
          if (typeof document !== 'undefined' && typeof Blob === 'function' && document.createElement) {
            const blob = new Blob([text], { type: 'application/x-ndjson;charset=utf-8' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `longlive-audit-${Date.now()}.ndjson`
            a.click()
            setTimeout(() => URL.revokeObjectURL(url), 1000)
          }
        } catch {
          /* 非浏览器环境（测试）只返回统计 */
        }
      }

      return h(React.Fragment, null, [
        h('section', { className: 'section', key: 'four' }, [
          h('h2', null, ['审计导出（#22 audit-records）：四指标只做供数与复盘，判定归 answer-guard / Gate-3；面板不冒充评分。', h('span', { className: 'v2pill' }, available ? '接口已接通' : '未接通')]),
          !available ? h('div', { className: 'banner warn' }, '面板 API 未接通：审计导出以空态/降级展示。') : null,
          h('div', { className: 'metrics' }, [
            h(V2Memo, { key: 'all', label: '审计行（#22 供数）', value: items.length }),
            h(V2Memo, { key: 'hit', label: '命中行', value: items.filter((r) => r.hit === true).length }),
            h(V2Memo, { key: 'miss', label: '未命中行', value: items.filter((r) => r.hit === false).length }),
            h(V2Memo, { key: 'unk', label: '题号缺失（unknown）', value: items.filter((r) => !r.questionId).length }),
          ]),
          h('div', { className: 'note' }, '四指标（错答率/弃答率/覆盖率/幻觉率）只供数；questionId 缺省显示 unknown（不臆造）；expectedTurns 兼容整数/数组（整数归一到 [n]）；answerText 截断脱敏；导出在客户端做白名单字段 NDJSON，不做服务端导出。'),
          h('div', { className: 'row' }, V2_AG_METRICS.map((m) => h('span', { className: 'v2pill', key: `t-${m.id}` }, `${m.label}（目标 ${m.target}，Gate-3 判定）`))),
          h('div', { className: 'row' }, [
            h(V2Field, { key: 'q', label: '题号（questionId）' }, h('input', { value: filter.questionId, onChange: (e) => setFilter({ ...filter, questionId: e.target.value }) })),
            h(V2Field, { key: 'h', label: '命中' }, h('select', { value: filter.hit, onChange: (e) => setFilter({ ...filter, hit: e.target.value }) }, [h('option', { key: 'a', value: '' }, '全部'), h('option', { key: 'y', value: 'hit' }, '命中'), h('option', { key: 'n', value: 'miss' }, '未命中')])),
            h(V2Field, { key: 'f', label: '失败原因' }, h('select', { value: filter.failureReason, onChange: (e) => setFilter({ ...filter, failureReason: e.target.value }) }, [h('option', { key: 'a', value: '' }, '全部'), ...['no_hit', 'low_trust', 'privacy_blocked', 'audit_missing', 'unknown'].map((r) => h('option', { key: r, value: r }, r))])),
            h('button', { key: 'exp', type: 'button', onClick: exportNdjson }, '导出 NDJSON（白名单字段，客户端序列化）'),
          ]),
          exported ? h('div', { className: 'note', key: 'ex' }, `已生成 ${exported.count} 行 / ${exported.bytes} 字节 NDJSON（questionId 缺失标 unknown，不臆造）。`) : null,
        ]),
        h('section', { className: 'section', key: 'rows' }, [
          h('h2', null, ['审计行（#22）', h('span', { className: 'v2pill' }, `${items.length} 行`) ]),
          items.length
            ? h('table', null, [
              TH(['at', 'recordId', 'readerTier', 'action', '命中', '失败原因', 'questionId', 'expectedTurns', 'answerText（截断）']),
              h('tbody', null, items.slice(0, 200).map((row, i) => h('tr', { key: `${row.recordId || 'row'}-${i}` }, [
                h('td', { className: 'num', key: 'at' }, row.at ? fmtTime(row.at) : '—'),
                h('td', { className: 'mono', key: 'rid' }, row.recordId || '—'),
                h('td', { key: 'tier' }, row.readerTier || '—'),
                h('td', { key: 'act' }, row.action || '—'),
                h('td', { key: 'hit' }, row.hit === true ? '命中' : row.hit === false ? '未命中' : '—'),
                h('td', { key: 'fr' }, row.failureReason || '—'),
                h('td', { className: 'mono', key: 'q' }, row.questionKey || 'unknown'),
                h('td', { className: 'mono', key: 'et' }, Array.isArray(row.expectedTurns) && row.expectedTurns.length ? row.expectedTurns.join(',') : '—'),
                h('td', { key: 'atx' }, row.answerText ? row.answerText.slice(0, 60) : '—'),
              ]))),
            ])
            : h('div', { className: 'empty' }, [h('div', null, audit.loading ? '正在读审计' : '还没有审计记录'), h('div', { className: 'note' }, asText(audit.error) || '审计列表为空（200 空）；仅 404 才显示「未接通」。')]),
        ]),
      ])
    }

    function RoleTab({ v2state, attentionOverride, relationshipsOverride, personalityOverride, channelsOverride }) {
      const liveAttention = useV2Read('attention', true)
      const liveRelationships = useV2Read('relationships', true)
      const livePersonality = useV2Read('personality', true)
      const liveChannels = useV2Read('channels', true)
      const attention = attentionOverride || liveAttention
      const relationships = relationshipsOverride || liveRelationships
      const personality = personalityOverride || livePersonality
      const channels = channelsOverride || liveChannels
      const [dialog, setDialog] = useState(null)
      const [lastResult, setLastResult] = useState(null)
      const bridge = v2state && v2state.bridge ? v2state.bridge : null
      const available = Boolean(bridge && bridge.available)
      const attentionModel = attention.v2 && attention.v2.model ? attention.v2.model : null
      const relModel = relationships.v2 && relationships.v2.model ? relationships.v2.model : null
      const persModel = personality.v2 && personality.v2.model ? personality.v2.model : null
      const chanModel = channels.v2 && channels.v2.model ? channels.v2.model : null
      const attItems = attentionModel && Array.isArray(attentionModel.items) ? attentionModel.items : []
      const nodes = relModel && Array.isArray(relModel.nodes) ? relModel.nodes : []
      const chanList = chanModel && Array.isArray(chanModel.channels) ? chanModel.channels : []
      const missing = (res) => !res.loading && !res.routeOk

      return h(React.Fragment, null, [
        h('section', { className: 'section', key: 'attention' }, [
          h('h2', null, ['attention 队列（#24 attention/v1，只读）：P0→P1→P2，按优先级与老化排序。空队列≠未实装。', h('span', { className: 'v2pill' }, available ? '接口已接通' : '未接通'), attentionModel && attentionModel.version != null ? h('span', { className: 'v2pill', key: 'v' }, `v${attentionModel.version}`) : null]),
          !available ? h('div', { className: 'banner warn' }, '面板 API 未接通：角色内核显示未实装。') : null,
          attentionModel && attentionModel.tampered ? h('div', { className: 'banner bad', key: 'att-t' }, '完整性校验失败（tampered）：宿主写保护侧车（HMAC）校验失败——侧车缺失/被篡改，或取不到匹配的宿主 auditKey 与 .hostkey；读侧 fail-safe 不加载正文（present:false / tampered:true / code:E_INTEGRITY_TAMPER），只保留状态提示。不是数据为空。') : null,
          attentionModel && attentionModel.degraded && !attentionModel.tampered ? h('div', { className: 'banner warn', key: 'att-d' }, 'attention 部分行损坏/降级（degraded；不崩，展示可用行）') : null,
          attItems.length
            ? h('table', null, [TH(['priority', 'kind', 'subject', 'at', 'source']), h('tbody', null, attItems.map((a) => h('tr', { key: a.id || `${a.at}-${a.subject}` }, [
              h('td', { key: 'p' }, h('span', { className: `v2pill ${a.priority === 'P0' ? 'bad' : a.priority === 'P1' ? 'warn' : ''}` }, a.priority)),
              h('td', { key: 'k' }, a.kind),
              h('td', { key: 's' }, a.subject || '—'),
              h('td', { className: 'num', key: 'at' }, a.at ? fmtTime(a.at) : '—'),
              h('td', { key: 'src' }, a.source || '—'),
            ])))])
            : missing(attention) ? h('div', { className: 'empty' }, [h('div', null, 'attention 读取失败（路由未接通/404）'), h('div', { className: 'note' }, '字段按 v2.8 §16.3；不拿样例顶班。')]) : h('div', { className: 'empty' }, '暂无 attention 行'),
        ]),
        h('section', { className: 'section', key: 'relationships' }, [
          h('h2', null, ['关系等级（#25 relationships/v1）：tier 只影响召回排序权重（stranger 1.0 / familiar 1.05 / trusted 1.1 / intimate 1.15，来自响应级 tierWeights，不是每行字段），不改事实。字段：personId / tier / confidence / updatedAt / version（供 CAS 更新）/ appellations。', h('span', { className: 'v2pill' }, available ? '接口已接通' : '未接通'), relModel && relModel.version != null ? h('span', { className: 'v2pill', key: 'v' }, `v${relModel.version}`) : null]),
          relModel && relModel.tampered ? h('div', { className: 'banner bad', key: 'rel-t' }, '完整性校验失败（tampered）：宿主写保护侧车（HMAC）校验失败，读侧 fail-safe 不加载正文；不是数据为空。') : null,
          relModel && relModel.denied ? h('div', { className: 'banner warn', key: 'rel-dn' }, '读取被 subject/readers 边界拒绝（denied）：仅带非 host caller 且 subject 不可读时出现。') : null,
          relModel && relModel.degraded && !relModel.tampered ? h('div', { className: 'banner warn', key: 'rel-d' }, '关系图部分节点/边损坏（degraded；展示可用部分）') : null,
          nodes.length
            ? h('table', null, [TH(['personId', 'tier', 'confidence', 'updatedAt', 'appellations', 'recall ×（tierWeights）', '动作']), h('tbody', null, nodes.map((n) => h('tr', { key: n.personId }, [
              h('td', { className: 'mono', key: 'id' }, n.personId || '—'),
              h('td', { key: 'tier' }, [h('span', { className: 'v2pill', key: 't' }, n.tier), h('span', { className: 'v2pill', key: 'v' }, n.version == null ? 'version 缺' : `v${n.version}`)]),
              h('td', { className: 'num', key: 'conf' }, n.confidence == null ? '—' : String(n.confidence)),
              h('td', { className: 'num', key: 'at' }, n.updatedAt ? fmtTime(n.updatedAt) : '—'),
              h('td', { key: 'app' }, Array.isArray(n.appellations) && n.appellations.length ? n.appellations.join(', ') : '—'),
              h('td', { className: 'num', key: 'w' }, String((relModel && relModel.tierWeights ? relModel.tierWeights : V2_REL_WEIGHT)[n.tier] || '—')),
              h('td', { key: 'act' }, h('button', { type: 'button', disabled: n.version == null, title: n.version == null ? '缺 version 源：CAS 不可用（P0-2）' : '', onClick: () => setDialog({ button: 'relationshipUpdate', row: { target: { kind: 'relationship', id: n.personId, version: n.version } } }) }, '更新关系等级')),
            ])))])
            : missing(relationships) ? h('div', { className: 'empty' }, [h('div', null, '关系图读取失败（路由未接通/404）'), h('div', { className: 'note' }, '字段按 v2.8 §16.3；不拿样例顶班。')]) : h('div', { className: 'empty' }, '没有关系记录'),
        ]),
        h('section', { className: 'section', key: 'personality' }, [
          h('h2', null, ['人格快照（#26 personality/v1）：retentionBias 是对象（kind→权重），只调遗忘/保留阈值，不改变已存事实；快照只读。', h('span', { className: 'v2pill' }, available ? '接口已接通' : '未接通')]),
          persModel && persModel.tampered ? h('div', { className: 'banner bad', key: 'per-t' }, '完整性校验失败（tampered）：宿主写保护侧车（HMAC）校验失败——侧车缺失/被篡改，或取不到匹配的宿主 auditKey 与 .hostkey；读侧 fail-safe 不加载正文（present:false / tampered:true / code:E_INTEGRITY_TAMPER），只保留状态提示。不是数据为空。') : null,
          persModel && persModel.denied ? h('div', { className: 'banner warn', key: 'per-dn' }, '人格快照读取被边界拒绝（denied）') : null,
          persModel && persModel.degraded && !persModel.tampered ? h('div', { className: 'banner warn', key: 'per-d' }, '人格快照损坏/降级（degraded；显示默认值，不崩）') : null,
          persModel && persModel.present
            ? h('div', { className: 'detail' }, [
              h('div', { className: 'row' }, [
                h('span', { className: 'v2pill', key: 'id' }, `snapshot ${persModel.snapshotId || '—'}`),
                h('span', { className: 'v2pill', key: 'v' }, `version ${persModel.version == null ? '—' : persModel.version}`),
                h('span', { className: 'v2pill', key: 'tone' }, `tone ${persModel.tone || '—'}`),
                h('span', { className: 'v2pill', key: 'created' }, `createdAt ${persModel.createdAt ? fmtTime(persModel.createdAt) : '—'}`),
              ]),
              h('div', { className: 'kv' }, Object.entries(persModel.retentionBias || {}).length
                ? Object.entries(persModel.retentionBias).map(([k, v]) => [h('dt', { key: `k-${k}` }, k), h('dd', { key: `v-${k}` }, String(v))])
                : [h('dt', { key: 'none' }, 'retentionBias'), h('dd', { key: 'none-v' }, '—')]),
            ])
            : missing(personality) ? h('div', { className: 'empty' }, [h('div', null, '人格快照读取失败（路由未接通/404）'), h('div', { className: 'note' }, '不拿样例顶班。')]) : h('div', { className: 'empty' }, '没有人格快照'),
        ]),
        h('section', { className: 'section', key: 'channels' }, [
          h('h2', null, ['渠道只读（#27 channels/v1）：1.8.0 只注册只读渠道状态，不接真实 QQ/Web 协议（计划 1.8.1+）。', h('span', { className: 'v2pill' }, available ? '接口已接通' : '未接通')]),
          chanList.length
            ? h('table', null, [TH(['id', 'type', 'enabled', 'lastSeenAt']), h('tbody', null, chanList.map((c) => h('tr', { key: c.id }, [
              h('td', { className: 'mono', key: 'id' }, c.id || '—'),
              h('td', { key: 't' }, c.type),
              h('td', { key: 'en' }, h('span', { className: `v2pill ${c.enabled ? 'ok' : 'mute'}` }, c.enabled ? 'enabled' : 'disabled')),
              h('td', { className: 'num', key: 'at' }, c.lastSeenAt ? fmtTime(c.lastSeenAt) : '—'),
            ])))])
            : missing(channels) ? h('div', { className: 'empty' }, [h('div', null, '渠道读取失败（路由未接通/404）'), h('div', { className: 'note' }, '不接真实 QQ 协议（1.8.1+，§16.7）。')]) : h('div', { className: 'empty' }, '没有注册渠道'),
        ]),
        dialog ? h(V2ActionDialog, {
          key: `rel-${dialog.row && dialog.row.target && dialog.row.target.id}`,
          dialog,
          integrity: v2state && v2state.integrity,
          onClose: () => setDialog(null),
          onDone: (out) => { setDialog(null); setLastResult(out) },
        }) : null,
        lastResult ? h('div', { className: 'banner' }, `关系更新已提交：actionId=${asText(lastResult.actionId)} auditSeq=${asText(lastResult.auditSeq)} status=${asText(lastResult.status)}`) : null,
      ])
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
    exports.__test = {
      fmtBytes, fmtAge, fmtTime, shortSha, sortLiveRows, liveStateRank, liveAgeMs, stateLabel, stateTone, TABS, SAMPLE,
      V2_TABS, V2_ACTIONS, V2_MATRIX, V2_BUTTON_ACTION, V2_BUTTON_LABEL, V2_REL_WEIGHT, v2ButtonsFor, v2ReviewRow, v2FormatError, v2LockedOf,
      components: {
        Panel, PalaceTab, ArchivedFold, TruncTab, FilterTab, ShadowTab, RouterTab, RecallTab, NetworkTab, DistillTab, HelpTab,
        V2IntegrityBanner, V2ActionDialog, V2ReviewTable, MemoryBoardTab, RecallFlowTab, ForgetTab, RecordsTab, WorkingFrameCard,
        ClaimsChainCard, BankTrustCard, FramesCard, ConflictTab, AuditTab, RoleTab, V2Field, V2Memo,
      },
    }

    return module.exports
  },
})
