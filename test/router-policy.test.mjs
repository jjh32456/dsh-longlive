// R1 策略 profile：默认 generic（通用原则）+ 可选家规叠加层（owner-rulings-2026-11-03）。
//
// 这里只测「策略可配置」这件事本身：
//   - 默认 profile 行为与拆分前一致（generic 仍是 20 条规则 / 19 条 fixture 的基线）；
//   - owner 叠加层真的生效（隐私 marker / rest resumePoint / 改名同意引原话）；
//   - 未知 profile、损坏文件、试图放宽 fail-closed 的叠加层全部必红；
//   - 家规文件里不出现个人名或本机路径（portability 的策略面扩到 policies/）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ERROR_CODES,
  POLICY,
  RULES,
  route,
  runtimeFor,
} from '../src/router/route.js';
import {
  E_ROUTE_POLICY_INVALID,
  E_ROUTE_PROFILE_UNKNOWN,
  POLICY_PROFILE_DEFAULT,
  configurePolicyProfile,
  configuredPolicyProfileName,
  loadPolicyProfile,
  resetPolicyProfileForTests,
} from '../src/policy-profile.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const POLICIES_DIR = path.join(REPO, 'src', 'router', 'policies');
const OWNER = 'owner-rulings-2026-11-03';

function input(utterance, extra = {}) {
  return { caseId: 'POLICY-1', turn: 1, utterance, ctx: { tokens: 1000, zone: 'green', activeWorkers: 0, openRows: 0 }, ...extra };
}

function decide(result) {
  return { decisions: result.decisions, needsHuman: result.needsHuman, errors: result.errors };
}

// 临时目录里的另一份 policies/：测「坏文件 / 放宽 fail-closed」——
// 套件运行期间不许往包树里写文件（P6 会给包树拍快照），所以损坏样本只存在于 tmp。
function stagingDir(assert) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-policy-'));
  fs.copyFileSync(path.join(POLICIES_DIR, 'generic.json'), path.join(root, 'generic.json'));
  const dir = new URL(`${pathToFileURL(root).href}/`);
  return {
    root,
    write(name, body) {
      fs.writeFileSync(path.join(root, `${name}.json`), typeof body === 'string' ? body : JSON.stringify({ name, ...body }));
    },
    load(name) {
      return loadPolicyProfile(name, { dir });
    },
  };
}

export function runPolicySuite({ runCase, assert }) {
  runCase('R1-POL1', '默认 profile=generic：阈值/询问/隐私/休息全部来自策略文件', () => {
    assert(configuredPolicyProfileName() === POLICY_PROFILE_DEFAULT, `默认 profile 应为 generic，实际 ${configuredPolicyProfileName()}`);
    const loaded = loadPolicyProfile(POLICY_PROFILE_DEFAULT);
    assert(loaded.ok, `generic 加载失败：${loaded.message}`);
    assert(loaded.policy.thresholds.compressAt === 150000 && loaded.policy.thresholds.redAt === 300000,
      `generic 阈值不对：${JSON.stringify(loaded.policy.thresholds)}`);
    assert(POLICY.compressAt === loaded.policy.thresholds.compressAt && POLICY.redAt === loaded.policy.thresholds.redAt,
      'route 导出的 POLICY 与 generic.json 阈值不一致');
    const runtime = runtimeFor(POLICY_PROFILE_DEFAULT);
    assert(runtime.errors.length === 0, `generic runtime 有错误：${JSON.stringify(runtime.errors)}`);
    assert(runtime.rules.length === RULES.length && RULES.length >= 14, `generic 规则数 ${runtime.rules.length} != ${RULES.length}`);
    for (const text of ['今天好累，先歇会儿', '我的护照号是 E12345678，帮我记住，别外传。', '把那条预算记忆删掉，不用合并。']) {
      const implicit = route(input(text));
      const explicit = route(input(text), { profile: 'generic' });
      assert(JSON.stringify(implicit) === JSON.stringify(explicit), `默认 profile 与显式 generic 输出不一致：${text}`);
    }
  });

  runCase('R1-POL2', 'owner 叠加层：extends generic、六条 J8 裁决、只写三处机器差异', () => {
    const loaded = loadPolicyProfile(OWNER);
    assert(loaded.ok, `owner 加载失败：${loaded.message}`);
    const policy = loaded.policy;
    assert(policy.extends === 'generic', `owner.extends=${policy.extends}`);
    assert(policy.failClosed === true, 'owner 不得关闭 failClosed');
    assert(Array.isArray(policy.rulings) && policy.rulings.length === 6, `J8 裁决应为 6 条，实际 ${policy.rulings && policy.rulings.length}`);
    assert(policy.rulings.every((ruling) => ruling.id && ruling.rule && ruling.source === 'J8-RULINGS-2026-11-03'),
      `裁决缺 id/rule/source：${JSON.stringify(policy.rulings)}`);
    assert(policy.privacy.markers.length > loadPolicyProfile('generic').policy.privacy.markers.length,
      'owner 的隐私 marker 没有比 generic 更严');
    assert(policy.rest.resumePoint !== loadPolicyProfile('generic').policy.rest.resumePoint, 'owner 的 resumePoint 没变');
    assert(policy.identity.requireQuoteId === true, 'owner 没有要求引用原话 id');
  });

  runCase('R1-POL3', '可观察差异①：同一句隐私话，generic 0 命中、owner 落本地且 0 网络', () => {
    const utterance = '我的护照号是 E12345678，帮我记住，别外传。';
    const generic = route(input(utterance), { profile: 'generic' });
    assert(generic.decisions.length === 0 && generic.target === 'none', `generic 不应命中隐私规则：${JSON.stringify(generic.decisions)}`);
    const owner = route(input(utterance), { profile: OWNER });
    assert(owner.decisions.length >= 1, 'owner 没有命中隐私规则');
    const first = owner.decisions[0];
    assert(first.action === 'memory.save_local' && first.ruleId === 'R-MEM-LOCAL', `owner 隐私决定=${first.action}/${first.ruleId}`);
    assert(first.args.echoBack === false && first.args.networkCalls === 0 && first.args.uploadAllowed === false,
      `owner 隐私参数放宽了：${JSON.stringify(first.args)}`);
    assert(first.args.store === 'memory/private/', `owner 落盘目录=${first.args.store}`);
  });

  runCase('R1-POL4', '可观察差异②：休息仍是可恢复暂停，owner 的 resumePoint 不同', () => {
    const utterance = '今天好累，先歇会儿，回头还得接着干。';
    const generic = route(input(utterance), { profile: 'generic' });
    const owner = route(input(utterance), { profile: OWNER });
    for (const [name, result] of [['generic', generic], ['owner', owner]]) {
      const decision = result.decisions.find((item) => item.action === 'reply.only');
      assert(decision, `${name} 没有 reply.only`);
      assert(decision.args.restKind === 'TEMPORARY' && decision.args.terminal === false && decision.args.resumable === true,
        `${name} 把休息当成了终止：${JSON.stringify(decision.args)}`);
      assert(typeof decision.args.resumePoint === 'string' && decision.args.resumePoint.trim(), `${name} resumePoint 为空`);
    }
    const genericPoint = generic.decisions.find((item) => item.action === 'reply.only').args.resumePoint;
    const ownerPoint = owner.decisions.find((item) => item.action === 'reply.only').args.resumePoint;
    assert(genericPoint === POLICY.rest.resumePoint, `generic resumePoint=${genericPoint}`);
    assert(ownerPoint !== genericPoint, `owner resumePoint 未生效：${ownerPoint}`);
  });

  runCase('R1-POL5', '可观察差异③：改名同意权，owner 还要引用原话 id', () => {
    const utterance = '以后你就叫小蓝，别再叫听澜了，画像也改一下。';
    const consent = { holder: 'assistant', at: '2026-11-03T10:00:00+08:00', quote: '那就叫小蓝吧' };
    const generic = route(input(utterance, { consent }), { profile: 'generic' });
    const genericEdit = generic.decisions.find((item) => item.action === 'engram.profile.edit');
    assert(genericEdit && genericEdit.args.keepHistory === true, 'generic 有助手同意时应放行改画像并 keepHistory');

    const ownerNoId = route(input(utterance, { consent }), { profile: OWNER });
    const hold = ownerNoId.decisions.find((item) => item.action === 'identity.hold');
    assert(hold, 'owner 缺 quoteId 时没有 identity.hold');
    assert(hold.args.errorCode === ERROR_CODES.IDENTITY_CONSENT_REQUIRED, `hold.errorCode=${hold.args.errorCode}`);
    assert(!ownerNoId.decisions.some((item) => item.action === 'engram.profile.edit'), 'owner 缺 quoteId 却写了画像');

    const ownerWithId = route(input(utterance, { consent: { ...consent, quoteId: 'm00211' } }), { profile: OWNER });
    const ownerEdit = ownerWithId.decisions.find((item) => item.action === 'engram.profile.edit');
    assert(ownerEdit && ownerEdit.args.keepHistory === true, 'owner 带 quoteId 时应放行改画像');
    assert(ownerEdit.args.consent.satisfied === true, 'owner 放行后 consent.satisfied 应为 true');
  });

  runCase('R1-POL6', '未知 profile：E_ROUTE_PROFILE_UNKNOWN + fail-closed（零写入/需人判）', () => {
    assert(E_ROUTE_PROFILE_UNKNOWN === 'E_ROUTE_PROFILE_UNKNOWN', '错误码导出不对');
    const runtime = runtimeFor('no-such-profile');
    assert(runtime.rules.length === 0 && runtime.errors.length === 1, `未知 profile runtime 没关死：${JSON.stringify(runtime.errors)}`);
    assert(runtime.errors[0].code === E_ROUTE_PROFILE_UNKNOWN, `code=${runtime.errors[0].code}`);
    const result = route(input('现在上下文多少？'), { profile: 'no-such-profile' });
    assert(result.target === 'none' && result.needsHuman === true, `未知 profile 未 fail-closed：target=${result.target}`);
    assert(result.decisions.every((item) => item.writeScope.length === 0), '未知 profile 下不应有可写决定');
    assert(result.errors.some((error) => error.code === E_ROUTE_PROFILE_UNKNOWN), '未知 profile 没报错误码');
  });

  runCase('R1-POL7', '坏策略文件与放宽 fail-closed 的叠加层：E_ROUTE_POLICY_INVALID', () => {
    const stage = stagingDir(assert);
    try {
      stage.write('broken', '{ this is not json');
      const broken = stage.load('broken');
      assert(!broken.ok && broken.code === E_ROUTE_POLICY_INVALID, `坏 JSON 未报 POLICY_INVALID：${JSON.stringify(broken)}`);

      const relaxations = {
        'relax-network': { extends: 'generic', privacy: { networkCalls: 2 } },
        'relax-terminal': { extends: 'generic', rest: { terminal: true } },
        'relax-consent': { extends: 'generic', identity: { userConsentCounts: true } },
        'relax-threshold': { extends: 'generic', thresholds: { redAt: 999999 } },
        'relax-scope': { extends: 'generic', writeScope: { allowPrefixes: ['memory/', 'C:/anywhere/'] } },
        'relax-failclosed': { extends: 'generic', failClosed: false },
      };
      for (const [name, overlay] of Object.entries(relaxations)) {
        stage.write(name, { name, ...overlay });
        const loaded = stage.load(name);
        assert(!loaded.ok && loaded.code === E_ROUTE_POLICY_INVALID,
          `${name} 应被拒：${JSON.stringify(loaded)}`);
      }

      stage.write('ok-narrow', { name: 'ok-narrow', extends: 'generic', privacy: { extraMarkers: ['护照号'] } });
      const narrowed = stage.load('ok-narrow');
      assert(narrowed.ok && narrowed.policy.privacy.markers.includes('护照号'), `合规收窄被误拒：${JSON.stringify(narrowed)}`);
    } finally {
      fs.rmSync(stage.root, { recursive: true, force: true });
    }
  });

  runCase('R1-POL8', '切换 profile 只改策略字段：规则 id 与错误码不变', () => {
    const generic = runtimeFor('generic');
    const owner = runtimeFor(OWNER);
    const ids = (runtime) => runtime.rules.map((rule) => rule.id).join(',');
    assert(ids(generic) === ids(owner), 'owner profile 改变了规则 id 集合');
    assert(generic.limits.maxRules === owner.limits.maxRules, 'owner 改变了决策上限');
    assert(Object.keys(ERROR_CODES).every((key) => typeof ERROR_CODES[key] === 'string'), 'ERROR_CODES 有非字符串值');
    assert(ERROR_CODES.PROFILE_UNKNOWN === E_ROUTE_PROFILE_UNKNOWN && ERROR_CODES.POLICY_INVALID === E_ROUTE_POLICY_INVALID,
      'route 没有登记两个 profile 错误码');
  });

  runCase('R1-POL9', '配置项生效：configurePolicyProfile 切换默认，失败时保留请求名并 fail-closed', () => {
    try {
      const owner = configurePolicyProfile(OWNER);
      assert(owner.ok && configuredPolicyProfileName() === OWNER, `configure owner 失败：${JSON.stringify(owner)}`);
      const result = route(input('今天好累，先歇会儿，回头还得接着干。'));
      const decision = result.decisions.find((item) => item.action === 'reply.only');
      assert(decision && decision.args.resumePoint === loadPolicyProfile(OWNER).policy.rest.resumePoint,
        '默认 profile 没切到 owner');

      const missing = configurePolicyProfile('missing-profile');
      assert(!missing.ok && configuredPolicyProfileName() === 'missing-profile', '失败的 profile 没有保留请求名');
      const rejected = route(input('现在上下文多少？'));
      assert(rejected.errors.some((error) => error.code === E_ROUTE_PROFILE_UNKNOWN), '未配置成功的 profile 没有 fail-closed');
    } finally {
      resetPolicyProfileForTests();
    }
    assert(configuredPolicyProfileName() === POLICY_PROFILE_DEFAULT, 'reset 后默认 profile 不是 generic');
  });

  runCase('R1-POL10', 'portability：策略文件里没有个人名、本机路径或盘符', () => {
    const names = ['金嘉恒', '听澜'];
    const machine = [/[A-Za-z]:[\\/]/, /\\\\Users\\\\/i, /\bdshops\b/, /\bdsh-memory\b/];
    for (const file of fs.readdirSync(POLICIES_DIR).filter((name) => name.endsWith('.json'))) {
      const text = fs.readFileSync(path.join(POLICIES_DIR, file), 'utf8');
      for (const name of names) assert(!text.includes(name), `${file} 出现个人名 ${name}`);
      for (const pattern of machine) assert(!pattern.test(text), `${file} 出现本机路径样式 ${pattern}`);
      const parsed = JSON.parse(text);
      assert(typeof parsed.name === 'string' && parsed.name === file.replace(/\.json$/, ''), `${file} 的 name 与文件名不一致`);
    }
  });
}
