// 客户端回归测试：用假 React + 假 ModuleLoader 加载 client.js，再用真实 server 数据把七个页签渲染一遍。
// 验证：bundle id、inject、两个 slot 的注册参数、七个页签在「真实数据 / 空数据」下都不抛异常、侧栏图标是 svg。
import { readFileSync } from 'node:fs'
import { createPanel } from './src/server.js'

const PKG = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

const results = []
const ok = (name, cond, extra) => {
  results.push({ name, pass: Boolean(cond), extra })
}
const fail = (name, err) => {
  results.push({ name, pass: false, extra: err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err) })
}

// ---- 假 React ----
let hookQueue = []
const Fragment = Symbol('Fragment')
const React = {
  Fragment,
  createElement(type, props, ...children) {
    const kids = children.length <= 1 ? children[0] : children
    return { type, props: props || {}, children: kids }
  },
  useState(initial) {
    if (hookQueue.length) return [hookQueue.shift(), () => {}]
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useMemo(fn) { return fn() },
  useCallback(fn) { return fn },
  useRef(v) { return { current: v } },
}

// ---- 假 ModuleLoader ----
let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(def) { captured = def },
  },
}

const file = new URL('./src/client.js', import.meta.url)
// 构建会把 __DSH_PLUGIN_VERSION__ 替换成 package.json 的版本；smoke 加载源码时
// 同样做一次注入，否则版本断言测的是「未注入的中间产物」，不是宿主真正拿到的东西。
const sourceText = readFileSync(file, 'utf8').replaceAll('__DSH_PLUGIN_VERSION__', PKG.version)
await import(`data:text/javascript;base64,${Buffer.from(sourceText, 'utf8').toString('base64')}`)

ok('client: 调用了 __ModuleLoader__.load', Boolean(captured))
ok('client: bundle id 是包名', captured && captured.id === '@jjh32456/dsh-longlive-panel', captured && captured.id)

const requireStub = (id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require: ${id}`)
}

let client = null
try {
  client = captured.factory(requireStub)
  ok('client: factory 返回 exports', Boolean(client) && typeof client.apply === 'function', typeof client?.apply)
  ok('client: inject 含 slots', Array.isArray(client.inject) && client.inject.includes('slots'), JSON.stringify(client.inject))
} catch (e) {
  fail('client: factory 执行', e)
}

// ---- 注册 ----
const registered = []
const slots = {
  inject(name, fn) { fn() },
  register(spec, component) {
    registered.push({ spec, component })
    return { dispose() {} }
  },
  get(name) { return null },
}
try {
  client.apply({ slots })
  ok('client: 注册 2 个 slot', registered.length === 2, registered.map((r) => r.spec.name).join(','))
  ok('client: 注册了 main', registered.some((r) => r.spec.name === 'main' && r.spec.key === '@jjh32456/dsh-longlive-panel'))
  ok('client: 注册了 sidebar.panellist', registered.some((r) => r.spec.name === 'sidebar.panellist' && r.spec.order === 42 && r.spec.label === '潜望镜'))
} catch (e) {
  fail('client: apply 注册', e)
}

// ---- 渲染工具 ----
function serialize(node, depth = 0) {
  if (node == null || typeof node !== 'object') return String(node ?? '')
  if (depth > 40) return '…'
  const t = typeof node.type === 'function' ? node.type.name || 'fn' : node.type === Fragment ? 'Fragment' : String(node.type)
  const kids = Array.isArray(node.children) ? node.children : [node.children]
  return `${t}(${kids.map((k) => serialize(k, depth + 1)).filter(Boolean).join(',')})`
}

function render(name, component, props) {
  try {
    const tree = component(props)
    const text = serialize(tree)
    ok(name, text.length > 20 && !text.includes('undefined('), text.slice(0, 120))
    return text
  } catch (e) {
    fail(name, e)
    return ''
  }
}

const C = client.__test.components

// ---- 真实数据 ----
const panel = createPanel({})
const real = {}
try {
  real.summary = await panel.handle('summary', {})
  real.truncations = await panel.handle('truncations', { limit: '5' })
  real.filter = await panel.handle('filter', { limit: '5' })
  real.shadow = await panel.handle('shadow', { limit: '5' })
  real.router = await panel.handle('router', {})
  real.recall = await panel.handle('recall', { limit: '5' })
  ok('server: summary 200', real.summary.status === 200)
  ok('server: router 200', real.router.status === 200 && real.router.body.readOnly === true)
  ok('server: recall 200 且只读', real.recall.status === 200 && real.recall.body.readOnly === true)
} catch (e) {
  fail('server: 取真实数据', e)
}

render('render: PalaceTab(真实 summary)', C.PalaceTab, { summary: real.summary.body, source: 'live' })
render('render: TruncTab(真实 truncations)', C.TruncTab, { trunc: real.truncations.body, source: 'live' })
render('render: FilterTab(真实 filter)', C.FilterTab, { filter: real.filter.body, source: 'live' })
render('render: ShadowTab(真实 shadow)', C.ShadowTab, { shadow: real.shadow.body, source: 'live' })
render('render: RouterTab(真实 router)', C.RouterTab, { router: real.router.body, source: 'live' })
render('render: RecallTab(真实 recall)', C.RecallTab, { recall: real.recall.body, source: 'live', error: null, loading: false })

// 空数据 / 样例也跑一遍
const empty = { layers: [], live: [], items: [], backups: [], metrics: {}, files: [], sessionsScanned: 0 }
render('render: PalaceTab(空)', C.PalaceTab, { summary: empty, source: 'sample' })
render('render: TruncTab(空)', C.TruncTab, { trunc: empty, source: 'sample' })
render('render: FilterTab(空)', C.FilterTab, { filter: { ...empty, metrics: {} }, source: 'sample' })
render('render: ShadowTab(空)', C.ShadowTab, { shadow: { ...empty, mode: 'off' }, source: 'sample' })
render('render: RouterTab(空/未启用)', C.RouterTab, { router: { enabled: false, present: {}, proposals: { items: [], counts: {} }, warnings: [], notes: ['没有 status.json'] }, source: 'live' })
render('render: RouterTab(样例)', C.RouterTab, { router: client.__test.SAMPLE.router, source: 'sample' })
render('render: RecallTab(实时空态)', C.RecallTab, { recall: { present: false, items: [], metrics: {}, page: {} }, source: 'live', error: null, loading: false })
render('render: RecallTab(接口未接通)', C.RecallTab, { recall: null, source: 'sample', error: 'E_FETCH', loading: false })

// 侧栏图标
const iconComp = registered.find((r) => r.spec.name === 'sidebar.panellist')
try {
  const iconEl = iconComp.component({ size: 20 })
  const svg = typeof iconEl.type === 'function' ? iconEl.type(iconEl.props) : iconEl
  ok('render: 侧栏图标', svg && svg.type === 'svg' && svg.props.width === 20, svg && svg.type)
} catch (e) {
  fail('render: 侧栏图标', e)
}

// ---------------------------------------------------------------------------
// 第七页签「使用说明」与页签顺序的新增断言
// 单列一组、单独计数：上面 25 条是基线，这里只加不减；任一条失败照样退出码非 0。
// ---------------------------------------------------------------------------

const helpResults = []
const hok = (name, cond, extra) => helpResults.push({ name, pass: Boolean(cond), extra })
const hfail = (name, err) => helpResults.push({ name, pass: false, extra: String(err) })

function collectText(node, out) {
  if (node == null || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const n of node) collectText(n, out)
    return out
  }
  if (typeof node === 'object') collectText(node.children, out)
  return out
}

function findByClass(node, cls) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findByClass(n, cls)
      if (hit) return hit
    }
    return null
  }
  const cn = node.props && node.props.className
  if (typeof cn === 'string' && cn.split(/\s+/).includes(cls)) return node
  return findByClass(node.children, cls)
}

const TABS = client.__test.TABS
const C2 = client.__test.components

let nav = null
let panelText = ''
try {
  const panelTree = C2.Panel({})
  nav = findByClass(panelTree, 'tabs')
  panelText = collectText(panelTree, []).join('\n')
} catch (e) {
  hfail('panel: 渲染第五页签所在的导航', e)
}

// 0) 版本 smoke：页头版本必须等于 package.json 的 version（0.1.3 事故的回归断言）
{
  const summaryVersion = real.summary && real.summary.body && real.summary.body.version
  hok('version: summary.version == package.json', summaryVersion === PKG.version, `summary=${summaryVersion} pkg=${PKG.version}`)
  hok(`version: 页头显示 v${PKG.version}`, panelText.includes(`v${PKG.version}`), panelText.split('\n').filter((l) => /^v\d/.test(l)).join(' | ') || '页头没有版本号')
  hok('version: 客户端无未注入占位符', !panelText.includes('__DSH_PLUGIN_VERSION__'), 'placeholder 仍未替换')
}

// 1) 页签数 = 7（数据源 TABS 与真实渲染出来的 tab 按钮都要是 7 个）
{
  const buttons = nav && Array.isArray(nav.children) ? nav.children.filter((n) => n && n.props && n.props.role === 'tab') : []
  hok('tabs: 页签数 = 7', TABS.length === 7 && buttons.length === 7, `TABS=${TABS.length} 渲染=${buttons.length}`)
}

// 2) 第七页签标题含「使用说明」，且排在最后
{
  const seventh = TABS[6]
  const label = seventh && seventh.label
  hok('tabs: 第七页签标题含「使用说明」', Boolean(label) && label.includes('使用说明') && panelText.includes('使用说明'), label)
  hok('tabs: 第四页签是常驻 Router', TABS[3] && TABS[3].id === 'router' && TABS[3].label.includes('Router'), TABS[3] && TABS[3].label)
  hok('tabs: 第五页签是「本轮想起」', TABS[4] && TABS[4].id === 'recall' && TABS[4].label.includes('本轮想起'), TABS[4] && TABS[4].label)
  hok('tabs: 第六页签是维护页「截断记录」', TABS[5] && TABS[5].id === 'trunc' && TABS[5].label.includes('截断记录'), TABS[5] && TABS[5].label)
  hok('tabs: 顺序为 六层视图→过滤器→影子→Router→想起→截断→说明', TABS.map((t) => t.id).join(',') === 'palace,filter,shadow,router,recall,trunc,help', TABS.map((t) => t.id).join(','))
}

// 3) 页面含 dryrun / request / on 三个开关字样
{
  let text = ''
  try {
    text = collectText(C2.HelpTab({}), []).join('\n')
  } catch (e) {
    hfail('render: HelpTab', e)
  }
  const missing = ['dryrun', 'request', 'on'].filter((w) => !text.includes(w))
  hok('help: 含 dryrun / request / on 三个开关', missing.length === 0, missing.length ? `缺 ${missing.join(',')}` : '三个都在')
}

// 4) 页面含「绝不」（它绝不会做什么）
{
  let text = ''
  try {
    text = collectText(C2.HelpTab({}), []).join('\n')
  } catch (e) {
    hfail('render: HelpTab 绝不段', e)
  }
  hok('help: 含「绝不」', text.includes('绝不'), text.includes('绝不') ? '在' : '缺')
}

// 5) 文案禁用词扫描：已死 / 墓碑 / 墓志铭 / 记忆宫殿
{
  let text = ''
  try {
    text = collectText(C2.HelpTab({}), []).join('\n')
  } catch (e) {
    hfail('render: HelpTab 禁用词', e)
  }
  const banned = ['已死', '墓碑', '墓志铭', '记忆宫殿'].filter((w) => text.includes(w))
  hok('help: 不含禁用词（已死/墓碑/墓志铭/记忆宫殿）', banned.length === 0, banned.length ? `出现 ${banned.join(',')}` : '干净')
}

// 6) 帮助页补了「共享大脑 v1 在看什么」，四个词都用人话解释
{
  let text = ''
  try {
    text = collectText(C2.HelpTab({}), []).join('\n')
  } catch (e) {
    hfail('render: HelpTab 共享大脑段', e)
  }
  const need = ['共享大脑 v1 在看什么', '租约', 'CAS', '冲突', '不批准提案']
  const missing = need.filter((w) => !text.includes(w))
  hok('help: 共享大脑段解释队列/租约/CAS/冲突', missing.length === 0, missing.length ? `缺 ${missing.join(',')}` : '四样都在')
  hok('help: 明确面板不批准提案', text.includes('不批准提案') && text.includes('不执行提案'), text.includes('不批准提案') ? '在' : '缺')
}

// 6b) 0.2.5 文案定位：共享大脑为主，截断退到维护位
{
  let text = ''
  try {
    text = collectText(C2.HelpTab({}), []).join('\n')
  } catch (e) {
    hfail('render: HelpTab 共享大脑优先', e)
  }
  hok('help: 开头是「哪个会话都是同一个人」', text.includes('哪个会话都是同一个人') && text.includes('不是陌生人'), text.slice(0, 60))
  hok('help: 截断是打扫不是身份', text.includes('那是打扫，不是身份'), text.includes('那是打扫，不是身份') ? '在' : '缺')
  hok('help: 维护：截断的三个开关 + 共享大脑平时用不到这些', text.includes('维护：截断的三个开关') && text.includes('共享大脑平时用不到这些'), '标题与开头句')
  hok('help: 四步从六层视图开场、截断收尾', text.includes('① 看「六层视图」') && text.includes('④ 最后才动截断开关'), '共享大脑优先')
  hok('help: 页签列表含维护位说明', text.includes('先看这里，确认自己接上了') && text.includes('维护页：会话日志被剪短的账'), '维护位标注')
}

// 7) RouterTab 缺 status.json 时降级「未启用」，不抛异常
{
  let text = ''
  try {
    text = collectText(C2.RouterTab({ router: { enabled: false, present: {}, notes: [], proposals: { items: [], counts: {} }, warnings: [] }, source: 'live' }), []).join('\n')
  } catch (e) {
    hfail('render: RouterTab(未启用)', e)
  }
  hok('router: 缺 status.json 显示「未启用」', text.includes('未启用') && text.includes('不报错'), text.slice(0, 80))
}

// 8) RouterTab 样例四块都在：状态 / 告警 / 共享板 / 队列
{
  let text = ''
  try {
    text = collectText(C2.RouterTab({ router: client.__test.SAMPLE.router, source: 'sample' }), []).join('\n')
  } catch (e) {
    hfail('render: RouterTab(样例)', e)
  }
  const need = ['Router 状态', '风险告警', '共享大脑', '提案队列', '待主人确认']
  const missing = need.filter((w) => !text.includes(w))
  hok('router: 样例含状态/告警/共享板/队列', missing.length === 0, missing.length ? `缺 ${missing.join(',')}` : '四块都在')
}

// 9) Router 契约 v2.3-rev2：五键 queue / tickQueue / provider 两态 / warnings 开放枚举
{
  let text = ''
  try {
    text = collectText(C2.RouterTab({ router: client.__test.SAMPLE.router, source: 'sample' }), []).join('\n')
  } catch (e) {
    hfail('render: RouterTab(样例 v2.3)', e)
  }
  const queueNeed = ['待取号 1', '已批准待执行 1', '执行中 0', '等人裁决 1', '已过期 0']
  const queueMissing = queueNeed.filter((w) => !text.includes(w))
  hok('router: queue 五键分开显示', queueMissing.length === 0, queueMissing.length ? `缺 ${queueMissing.join(',')}` : '五键都在')
  hok('router: tickQueue 单列，不和 status.queue 混用', text.includes('tick 任务队列') && text.includes('等待 2'), 'tickQueue 行')
  hok('router: provider 只显示两态', text.includes('已配置') && !text.includes('deepseek') && !text.includes('candidates'), '已配置 / 无模型名')
  hok('router: model.auto / agentMode 以中文展示布尔', text.includes('自动选择') && text.includes('非 agent 模式'), '布尔映射')
  hok('router: focus 只有三列（会话/当前任务/更新时间）', text.includes('当前任务') && text.includes('更新时间') && !text.includes('焦点来源'), '三列')
  hok('router: warnings 未知码原样显示 + 未收录 + 条数', text.includes('PANEL_SAMPLE_UNKNOWN') && text.includes('未收录') && text.includes('告警 2 条'), '开放枚举')
  hok('router: alerts severity 映射为中文（警告/错误）', text.includes('警告') && text.includes('错误'), '三色映射')
  hok('router: 写者条 / 下一张票 / 饿死条', text.includes('正在写') && text.includes('q-0043') && text.includes('请主人裁决'), 'writer / ticket / blocked')
}


// 10) 本轮想起（A5）：有数据 / 空文件 / 接口未接通三种态都渲染，且文案分得开
{
  const recallFixture = {
    ok: true,
    present: true,
    sourceFile: '.longlive/recall-log.jsonl',
    size: 420,
    mtimeMs: Date.parse('2026-11-05T12:03:00+08:00'),
    truncated: false,
    parseErrors: 0,
    items: [{
      at: '2026-11-05T12:02:00+08:00',
      sessionId: 'session-a',
      turn: 12,
      injected: [{ id: 'card:abc123', title: '召回纪律', score: 0.87, reason: '命中词：召回' }],
      blocked: [{ id: 'secret:9', title: '密钥片段', reason: '隐私门：凭据' }],
    }],
    metrics: { turns: 1, injected: 1, blocked: 1, sessions: 1, lastAt: '2026-11-05T12:02:00+08:00', parseErrors: 0 },
    page: { limit: 20, clamped: false, returned: 1, total: 1, hasMore: false },
  }
  let recallText = ''
  try {
    recallText = collectText(C2.RecallTab({ recall: recallFixture, source: 'live', error: null, loading: false }), []).join('\n')
  } catch (e) {
    hfail('render: RecallTab(有数据)', e)
  }
  const need = ['第 12 轮', '召回纪律', 'card:abc123', '0.87', '命中词：召回', '隐私门拦下', '隐私门：凭据', 'session-a', '.longlive/recall-log.jsonl']
  const missing = need.filter((w) => !recallText.includes(w))
  hok('recall: 有数据态显示轮次/条目/分数/命中词/拦截原因', missing.length === 0, missing.length ? `缺 ${missing.join(',')}` : '字段都在')
  hok('recall: 注入与隐私门用不同状态标出', recallText.includes('注入') && recallText.includes('隐私门拦下'), '两态')

  let emptyText = ''
  try {
    emptyText = collectText(C2.RecallTab({ recall: { present: false, items: [], metrics: {}, page: {} }, source: 'live', error: null, loading: false }), []).join('\n')
  } catch (e) {
    hfail('render: RecallTab(空态)', e)
  }
  hok('recall: 缺文件/空文件显示「本轮没有触发召回」', emptyText.includes('本轮没有触发召回'), emptyText.slice(0, 80))
  hok('recall: 空态不抛异常且不显示假条目', emptyText.includes('还没有 .longlive/recall-log.jsonl') && !emptyText.includes('0.87'), emptyText.indexOf('还没有') >= 0 ? '空态说明在' : '缺说明')

  let unavailableText = ''
  try {
    unavailableText = collectText(C2.RecallTab({ recall: null, source: 'sample', error: 'E_FETCH', loading: false }), []).join('\n')
  } catch (e) {
    hfail('render: RecallTab(接口未接通)', e)
  }
  hok('recall: 接口未接通显示「读不到召回日志」且不拿样例顶班', unavailableText.includes('读不到召回日志') && unavailableText.includes('不会拿假记录冒充召回'), unavailableText.slice(0, 100))
}


// ---------------------------------------------------------------------------
// 滚动断言：面板占满插槽时，main 必须自己滚动，
// 而不是被宿主固定高度的插槽直接裁掉。断言直接读源码里的 CSS 规则，
// 不依赖宿主真实渲染（smoke 里没有 DOM）。
// ---------------------------------------------------------------------------

const scrollResults = []
const sok = (name, cond, extra) => scrollResults.push({ name, pass: Boolean(cond), extra })

{
  const src = readFileSync(new URL('./src/client.js', import.meta.url), 'utf8')
  const rule = (selector) => {
    const at = src.indexOf(selector + '{')
    if (at < 0) return ''
    const end = src.indexOf('}', at)
    return end < 0 ? '' : src.slice(at + selector.length + 1, end)
  }
  const rootRule = rule('.llp')
  const mainRule = rule('.llp main')
  const compact = (r) => (r ? r.replace(/\s+/g, ' ').slice(0, 140) : '规则不存在')

  sok('.llp 占满插槽并裁切（height:100% + overflow:hidden）',
    rootRule.includes('height:100%') && rootRule.includes('overflow:hidden'),
    `height:100%=${rootRule.includes('height:100%')} overflow:hidden=${rootRule.includes('overflow:hidden')}｜${compact(rootRule)}`)
  sok('main 自己纵向滚动（overflow-y:auto + min-height:0）',
    mainRule.includes('overflow-y:auto') && mainRule.includes('min-height:0'),
    `overflow-y:auto=${mainRule.includes('overflow-y:auto')} min-height:0=${mainRule.includes('min-height:0')}｜${compact(mainRule)}`)
}

// ---------------------------------------------------------------------------
// 活体行排序 + 已归档折叠：运行中 → 空闲 → 已归档；已归档默认折叠、点开才占版面。
// 用户 2026-11-06 反馈：已归档行太长，运行中/空闲反被挤到下面。
// ---------------------------------------------------------------------------

const orderResults = []
const ook = (name, cond, extra) => orderResults.push({ name, pass: Boolean(cond), extra })

// 组件树的文字要穿过函数组件（LiveTable 是 PalaceTab 里的子组件，collectText 只走
// host 元素的 children，会漏掉它），所以这里按 React 的物化顺序把函数组件也调一遍。
function deepText(node, out = []) {
  if (node == null || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const n of node) deepText(n, out)
    return out
  }
  if (typeof node === 'object') {
    if (typeof node.type === 'function') return deepText(node.type(node.props || {}), out)
    deepText(node.children, out)
  }
  return out
}

// find 也要穿透函数组件（ArchivedFold 也是函数组件），否则找不到 details.fold。
function findByClassDeep(node, cls) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findByClassDeep(n, cls)
      if (hit) return hit
    }
    return null
  }
  if (typeof node.type === 'function') return findByClassDeep(node.type(node.props || {}), cls)
  const cn = node.props && node.props.className
  if (typeof cn === 'string' && cn.split(/\s+/).includes(cls)) return node
  return findByClassDeep(node.children, cls)
}

{
  const liveFixture = [
    { sessionId: 'session-ddead-0002', shortId: 'ddead', state: 'dead', heartbeatAgeMs: 90000000, ttlMs: 60000, turn: 3, goal: '旧会话一', lastAction: null },
    { sessionId: 'session-idle1-0003', shortId: 'idle1', state: 'idle', heartbeatAgeMs: 12000, ttlMs: 60000, turn: 9, goal: '空闲会话', lastAction: null },
    { sessionId: 'session-run11-0001', shortId: 'run11', state: 'running', heartbeatAgeMs: 4000, ttlMs: 60000, turn: 12, goal: '在跑的会话', lastAction: null },
    { sessionId: 'session-dead2-0002', shortId: 'dead2', state: 'dead', heartbeatAgeMs: 80000000, ttlMs: 60000, turn: 1, goal: '旧会话二', lastAction: null },
  ]

  // 1) 纯函数：状态档位 + 排序 + 红队 v1 修过的三个边界
  const ranked = client.__test.sortLiveRows(liveFixture).map((r) => r.shortId).join(',')
  ook('live: sortLiveRows = 运行中 → 空闲 → 已归档（已归档内按心跳新→旧）', ranked === 'run11,idle1,dead2,ddead', ranked)
  ook('live: liveStateRank(running=0) 且 dead 排最后（9）', client.__test.liveStateRank('running') === 0 && client.__test.liveStateRank('dead') === 9 && client.__test.liveStateRank('idle') === 1, `running=${client.__test.liveStateRank('running')} idle=${client.__test.liveStateRank('idle')} dead=${client.__test.liveStateRank('dead')}`)
  ook('live: 原型链键 state 落兜底 rank 6（不命中 Object.prototype）', client.__test.liveStateRank('constructor') === 6 && client.__test.liveStateRank('__proto__') === 6 && client.__test.liveStateRank('toString') === 6, `constructor=${client.__test.liveStateRank('constructor')} __proto__=${client.__test.liveStateRank('__proto__')}`)
  ook('live: 心跳未知（null/NaN）排同档最后，不冒充最新', client.__test.sortLiveRows([
    { sessionId: 'a-null', state: 'dead', heartbeatAgeMs: null },
    { sessionId: 'b-500s', state: 'dead', heartbeatAgeMs: 500000 },
    { sessionId: 'c-900s', state: 'dead', heartbeatAgeMs: 900000 },
  ]).map((r) => r.sessionId).join(',') === 'b-500s,c-900s,a-null', 'null 心跳应最后')
  ook('live: sortLiveRows 不改原数组', liveFixture.map((r) => r.shortId).join(',') === 'ddead,idle1,run11,dead2', liveFixture.map((r) => r.shortId).join(','))
  ook('live: stateLabel/stateTone 对原型链键与对象值安全（不出对象 child / 函数 className）', (() => {
    const bad = ['__proto__', 'constructor', {}, null]
    return bad.every((s) => typeof client.__test.stateLabel(s) === 'string' && typeof client.__test.stateTone(s) === 'string')
  })(), `labels=${['__proto__', 'constructor', {}, null].map((s) => JSON.stringify(client.__test.stateLabel(s))).join(',')}`)

  // 2) 渲染（收起态）：活动行在上、已归档折进 <details>，**收起时表格不物化**
  const liveSummary = { generatedAt: new Date().toISOString(), layers: [], live: liveFixture, warnings: [] }
  let tree = null
  let text = ''
  try {
    tree = C2.PalaceTab({ summary: liveSummary, source: 'live' })
    text = deepText(tree).join('\n')
  } catch (e) {
    hfail('render: PalaceTab(活体排序 fixture)', e)
  }
  const posRun = text.indexOf('run11')
  const posIdle = text.indexOf('idle1')
  ook('live: 活动区顺序 运行中 在 空闲 之前', posRun >= 0 && posIdle > posRun, `run11=${posRun} idle1=${posIdle}`)

  const fold = findByClassDeep(tree, 'fold')
  ook('live: 已归档有折叠容器（details.fold）', Boolean(fold) && fold.type === 'details', fold && String(fold.type))
  ook('live: 已归档默认折叠（open=false）', Boolean(fold) && !fold.props.open, fold ? JSON.stringify(fold.props) : '无折叠节点')
  ook('live: 收起时不物化归档表格（dead 行不在树里）', text.indexOf('dead2') < 0 && text.indexOf('ddead') < 0, `dead2=${text.indexOf('dead2')} ddead=${text.indexOf('ddead')}`)
  ook('live: 页头显示活动行数（2 个活动）', text.includes('2 个活动'), text.split('\n').filter((l) => l.includes('活动')).join(' | '))
  ook('live: 折叠标题写明条数与原因（不含未解释的 TTL 缩写）', text.includes('已归档 2 行') && text.includes('心跳超 4 个心跳周期') && !text.includes('TTL'), text.split('\n').filter((l) => /已归档|心跳/.test(l)).join(' | '))

  // 3) 展开态：ArchivedFold(initialOpen=true) 才挂出归档表格（含两条）
  let foldOpenText = ''
  try {
    foldOpenText = deepText(C2.ArchivedFold({ rows: [liveFixture[0], liveFixture[3]], initialOpen: true })).join('\n')
  } catch (e) {
    hfail('render: ArchivedFold(展开)', e)
  }
  ook('live: 展开后归档表格才出现（dead2/ddead 各一次）', foldOpenText.includes('dead2') && foldOpenText.includes('ddead'), foldOpenText.slice(0, 80))

  // 4) 脏数据防线：null 行不炸整页（红队 v1 RED-04）
  let nullOk = false
  let nullErr = ''
  try {
    deepText(C2.PalaceTab({ summary: { ...liveSummary, live: [null, liveFixture[2]] }, source: 'live' }))
    nullOk = true
  } catch (e) {
    nullErr = `${e.constructor.name}: ${e.message}`
  }
  ook('live: summary.live 含 null 行时不抛（坏一行不毁整页）', nullOk, nullErr || '不抛')
}

// ---- 输出 ----
const pass = results.filter((r) => r.pass).length
const failed = results.filter((r) => !r.pass)
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `  <- ${r.extra}`}`)
}
for (const r of helpResults) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `  <- ${r.extra}`}`)
}
for (const r of scrollResults) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `  <- ${r.extra}`}`)
}
const helpPass = helpResults.filter((r) => r.pass).length
const helpFailed = helpResults.length - helpPass
const scrollPass = scrollResults.filter((r) => r.pass).length
const scrollFailed = scrollResults.length - scrollPass
for (const r of orderResults) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `  <- ${r.extra}`}`)
}
const orderPass = orderResults.filter((r) => r.pass).length
const orderFailed = orderResults.length - orderPass
console.log(`\n${pass} PASS · ${failed.length} FAIL`)
console.log(`新增页签断言：${helpPass} PASS · ${helpFailed} FAIL`)
console.log(`新增滚动断言：${scrollPass} PASS · ${scrollFailed} FAIL`)
console.log(`新增活体排序/折叠断言：${orderPass} PASS · ${orderFailed} FAIL`)
process.exit(failed.length || helpFailed || scrollFailed || orderFailed ? 1 : 0)

