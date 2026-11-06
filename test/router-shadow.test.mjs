#!/usr/bin/env node
/**
 * 影子模式单测：证明 shadow.mjs「只记录、不执行、不越界写」。
 *
 * 既可以被 test/run.mjs 当作套件调用（runShadowSuite），也可以单独跑：
 *   node test/router-shadow.test.mjs
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { RULES, route } from '../src/router/route.js';
import { loadFixtures, fixtureInput, validateWriteScope } from '../src/router/judge.mjs';
import {
  SHADOW_CODES, SHADOW_MODE, MAX_DECISIONS,
  analyze, appendRecords, checkTable, computeMetrics, guard, pickReviewSample,
  sampleHit, scoreReview, validWriteScope,
} from '../src/router/shadow.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SHADOW = path.join(REPO, 'src', 'router', 'shadow.mjs');

const { fixtures } = loadFixtures(path.join(REPO, 'src', 'router', 'fixtures'));

function fakeRule(over = {}) {
  return {
    id: over.id || 'R-TEST',
    priority: over.priority ?? 10,
    kind: over.kind || '*',
    keywordKeys: over.keywordKeys || ['测试'],
    matchToolKey: null,
    matchCtx: over.matchCtx || null,
    ctxOnly: false,
    decision: {
      kind: over.decisionKind || 'memory',
      action: over.action || 'engram.save',
      target: 'engram',
      writeScope: over.writeScope || ['memory/journal/'],
      needsHuman: false,
    },
    reason: '单测规则',
  };
}

function fakeResult(over = {}) {
  return {
    decisions: over.decisions || [],
    needsHuman: over.needsHuman ?? false,
    errors: over.errors || [],
    overrides: over.overrides || [],
    overrideAudit: over.overrideAudit || { applied: (over.overrides || []).length, rejected: 0, records: over.overrides || [] },
  };
}

export function runShadowSuite({ runCase, assert }) {
  runCase('R1-SH1', '影子模式只有 dry 一种模式，且没有执行分支（--execute 必须被拒）', () => {
    assert(SHADOW_MODE === 'dry', `SHADOW_MODE=${SHADOW_MODE}`);
    const tmp = mkdtempSync(path.join(tmpdir(), 'r1-shadow-arg-'));
    const run = spawnSync(process.execPath, [SHADOW, '--from-fixtures', '--out', tmp, '--execute'], { encoding: 'utf8' });
    rmSync(tmp, { recursive: true, force: true });
    assert(run.status === 1, `--execute 应被拒，实际 exit=${run.status}`);
    assert(/未知参数/.test(run.stderr), `stderr 未说明拒绝原因：${run.stderr}`);
  });

  runCase('R1-SH2', '19 条 fixtures：影子判定与 route() 一致，且全部标记为 record-only/refuse（不会执行）', () => {
    for (const fixture of fixtures) {
      const input = fixtureInput(fixture);
      const analysis = analyze(input);
      const base = route(input);
      assert(analysis.decision.matchedRule === base.matchedRule, `${fixture.id} 规则不一致`);
      assert(
        JSON.stringify(analysis.decision.decisions.map((d) => `${d.kind}:${d.action}@${d.ruleId}`))
        === JSON.stringify(base.decisions.map((d) => `${d.kind}:${d.action}@${d.ruleId}`)),
        `${fixture.id} 决策不一致`,
      );
      assert(['record-only', 'refuse'].includes(analysis.guard.action), `${fixture.id} guard.action=${analysis.guard.action}`);
    }
  });

  runCase('R1-SH3', '采样：同 seed 稳定复现，rate 0/1 与边界正确', () => {
    const key = 'T1:1:abc';
    const a = Array.from({ length: 200 }, (_, i) => sampleHit(`${key}:${i}`, { rate: 0.3, seed: 's1' }));
    const b = Array.from({ length: 200 }, (_, i) => sampleHit(`${key}:${i}`, { rate: 0.3, seed: 's1' }));
    assert(JSON.stringify(a) === JSON.stringify(b), '同 seed 采样不稳定');
    const hits = a.filter(Boolean).length;
    assert(hits > 20 && hits < 120, `0.3 采样命中 ${hits}/200 明显偏离`);
    assert(sampleHit(key, { rate: 0 }) === false, 'rate 0 应为 false');
    assert(sampleHit(key, { rate: 1 }) === true, 'rate 1 应为 true');
  });

  runCase('R1-SH4', '规则表体检：空表/缺 id/priority 倒序 → E_SHADOW_TABLE', () => {
    assert(checkTable(RULES).ok === true, `真实规则表未通过体检：${JSON.stringify(checkTable(RULES).errors)}`);
    const empty = checkTable([]);
    assert(empty.ok === false && empty.errors.some((e) => e.code === SHADOW_CODES.TABLE), '空表未被拦');
    const broken = checkTable([
      { ...fakeRule(), id: '' },
      { ...fakeRule({ id: 'R-A' }), priority: 5 },
      { ...fakeRule({ id: 'R-B' }), priority: 9 },
    ]);
    assert(broken.ok === false, '坏表未被拦');
    assert(broken.errors.some((e) => e.message.includes('优先级')), '未报优先级倒序');
    assert(broken.errors.some((e) => e.message.includes('无 id')), '缺 id 的规则未报');
  });

  runCase('R1-SH5', '空判定 → E_SHADOW_UNMATCHED + needsHuman + refuse', () => {
    const analysis = analyze({ caseId: 'X', turn: 1, utterance: '完全无法归类的一句话 zzz', ctx: {} });
    assert(analysis.decision.matchedRule === null, '不该有规则命中');
    assert(analysis.guard.ok === false, '空判定必须被拦');
    assert(analysis.guard.errors.some((e) => e.code === SHADOW_CODES.UNMATCHED), '缺 UNMATCHED');
    assert(analysis.guard.needsHuman === true, 'needsHuman 应为 true');
    assert(analysis.guard.action === 'refuse', 'action 应为 refuse');
  });

  runCase('R1-SH6', 'writeScope 越界 → E_SHADOW_SCOPE（盘符/穿越/绝对路径/未知前缀）', () => {
    const bad = ['Z:\\dsh-memory\\x', '../../etc/passwd', '/etc/passwd', '~/x', 'unknown/dir', 'C:/x'];
    for (const scope of bad) {
      const rules = [fakeRule({ writeScope: [scope] })];
      const result = fakeResult({
        decisions: [{ kind: 'memory', action: 'engram.save', ruleId: 'R-TEST', writeScope: [scope] }],
      });
      const verdict = guard({ utterance: '测试' }, result, { rules });
      assert(verdict.ok === false, `scope=${scope} 未被拦`);
      assert(verdict.errors.some((e) => e.code === SHADOW_CODES.SCOPE), `scope=${scope} 缺 SCOPE`);
    }
    for (const scope of ['memory/journal/2026-11.md', 'taskboard:R1', 'sandbox:r1', 'evidence:x.jsonl', '']) {
      assert(validWriteScope(scope) === true, `合法 scope 被误判：${scope}`);
    }
  });

  runCase('R1-SH7', '决策数爆炸 → E_SHADOW_EXPLOSION', () => {
    const rules = [fakeRule()];
    const decisions = Array.from({ length: MAX_DECISIONS + 1 }, () => ({ kind: 'memory', action: 'engram.save', ruleId: 'R-TEST', writeScope: ['memory/journal/'] }));
    const verdict = guard({ utterance: '测试' }, fakeResult({ decisions }), { rules });
    assert(verdict.ok === false, '爆炸未被拦');
    assert(verdict.errors.some((e) => e.code === SHADOW_CODES.EXPLOSION), '缺 EXPLOSION');
  });

  runCase('R1-SH8', '同优先级双命中 → E_SHADOW_AMBIGUOUS', () => {
    const rules = [fakeRule({ id: 'R-A', priority: 50 }), fakeRule({ id: 'R-B', priority: 50, action: 'journal.append', writeScope: ['memory/journal/'] })];
    const verdict = guard(
      { utterance: '测试' },
      fakeResult({ decisions: [{ kind: 'memory', action: 'engram.save', ruleId: 'R-A', writeScope: ['memory/journal/'] }] }),
      { rules },
    );
    assert(verdict.ok === false, '歧义未被拦');
    assert(verdict.errors.some((e) => e.code === SHADOW_CODES.AMBIGUOUS), '缺 AMBIGUOUS');
  });

  runCase('R1-SH9', 'override 指向不存在的规则 → E_SHADOW_OVERRIDE；route 自身报错 → 升级为拒绝', () => {
    const rules = [fakeRule()];
    const verdict = guard(
      { utterance: '测试' },
      fakeResult({
        decisions: [{ kind: 'memory', action: 'engram.save', ruleId: 'R-TEST', writeScope: ['memory/journal/'], overridden: { ruleId: 'R-NOPE' } }],
        overrides: [{ ruleId: 'R-NOPE', reason: 'x' }],
      }),
      { rules },
    );
    assert(verdict.ok === false && verdict.errors.some((e) => e.code === SHADOW_CODES.OVERRIDE), '错 ruleId override 未被拦');

    const withRouteError = guard(
      { utterance: '测试' },
      fakeResult({
        decisions: [{ kind: 'reply', action: 'guard.refuse', ruleId: 'R-TEST', writeScope: [] }],
        errors: [{ code: 'E_ROUTE_OVERRIDE_UNJUSTIFIED', message: 'x' }],
        needsHuman: true,
      }),
      { rules },
    );
    assert(withRouteError.ok === false, 'route 的错必须升级为拒绝');
    assert(withRouteError.errors.some((e) => e.code === 'E_ROUTE_OVERRIDE_UNJUSTIFIED'), '未透传 route 错误码');
  });

  runCase('R1-SH10', 'writeScope 口径与 judge.validateWriteScope 一致（空串除外）；字符串入参不被放行', () => {
    const scopes = ['memory/journal/a.md', 'memory/', 'taskboard:R1', 'sandbox:x', 'Z:\\dsh-memory', 'C:/tmp', '../../x', '/etc/passwd', '~/x', 'unknown/', 'evidence:r1.jsonl'];
    for (const scope of scopes) {
      const mine = validWriteScope(scope);
      // judge 的 validateWriteScope 契约为「数组入参」（内部 asArray 只认数组）。
      const theirs = validateWriteScope([scope]).length === 0;
      assert(mine === theirs, `scope=${JSON.stringify(scope)} shadow=${mine} judge=${theirs}`);
    }
    // 空串：judge 视为「空条目」报错，影子视为「不声明写入」。两者都不会把空串当合法落点，
    // 这里把差异显式钉住，防止哪天被误读成「两边都放行」。
    assert(validWriteScope('') === true && validateWriteScope(['']).length === 1, '空串语义与预期不符');
    assert(validateWriteScope([]).length === 0, '空数组应合法（不写）');
    // 影子层对「裸字符串」也严格判：避免把 string 误当数组而静默放行（judge 的 asArray 有此类型脆弱点）。
    assert(validWriteScope('Z:\\dsh-memory') === false, 'shadow 对裸字符串放行了越界 scope');
  });

  runCase('R1-SH11', 'CLI 只写 outDir：fixtures 全跑 + 抽 5 条人工判读，产物只有两个 jsonl', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'r1-shadow-out-'));
    const run = spawnSync(process.execPath, [SHADOW, '--from-fixtures', '--out', out, '--date', '2026-11-03', '--review-sample', '5', '--json'], { encoding: 'utf8' });
    assert(run.status === 0, `shadow CLI 失败：${run.stderr}`);
    const files = readdirSync(out).sort();
    assert(JSON.stringify(files) === JSON.stringify(['decisions-2026-11-03.jsonl', 'review-2026-11-03.jsonl']), `产物不符：${files}`);
    const lines = readFileSync(path.join(out, 'decisions-2026-11-03.jsonl'), 'utf8').split('\n').filter(Boolean);
    assert(lines.length === 19, `应有 19 条记录，实际 ${lines.length}`);
    for (const line of lines) {
      const record = JSON.parse(line);
      assert(record.mode === 'dry', '记录 mode 必须是 dry');
      assert(record.human && record.human.verdict === null, 'human.verdict 应为 null');
      assert(!('toolResult' in record) && !('executed' in record), '记录里不该有执行结果');
      assert(['record-only', 'refuse'].includes(record.guard.action), `guard.action=${record.guard.action}`);
    }
    const review = readFileSync(path.join(out, 'review-2026-11-03.jsonl'), 'utf8').split('\n').filter(Boolean);
    assert(review.length === 5, `人工判读抽样应为 5，实际 ${review.length}`);
    rmSync(out, { recursive: true, force: true });
  });

  runCase('R1-SH12', 'appendRecords 只写 outDir 内的 decisions-<date>.jsonl（含 .. 的 outDir 先归一化）', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'r1-shadow-guard-'));
    let threw = '';
    try {
      appendRecords([{ a: 1 }], { outDir: out, date: '2026-11-03' });
    } catch (error) {
      threw = error.message;
    }
    assert(threw === '', `正常写入不该抛错：${threw}`);
    const file = path.join(out, 'decisions-2026-11-03.jsonl');
    assert(readFileSync(file, 'utf8').trim() === JSON.stringify({ a: 1 }), '写入内容不符');

    // outDir 里带 `..` 时必须先归一化：落点只能是归一化目录，不能出现「夹带穿越段」的第三处路径。
    const nested = path.join(out, 'sub', '..', 'escape');
    const written = appendRecords([{ b: 2 }], { outDir: nested, date: '2026-11-03' });
    assert(path.dirname(written.file) === path.resolve(nested), `落点未归一化：${written.file}`);
    assert(readdirSync(path.resolve(nested)).join(',') === 'decisions-2026-11-03.jsonl', '归一化目录里出现了额外文件');
    rmSync(out, { recursive: true, force: true });
  });

  runCase('R1-SH13', '指标：needsHuman/歧义/ctx/不一致率计算正确', () => {
    const records = [
      { guard: { needsHuman: true, action: 'refuse', errors: [{ code: SHADOW_CODES.AMBIGUOUS }] }, decision: { matchedRule: 'R-A', decisions: [{ kind: 'memory', action: 'engram.save' }], confidence: 0.9 } },
      { guard: { needsHuman: false, action: 'record-only', errors: [] }, decision: { matchedRule: 'R-A', decisions: [{ kind: 'reply', action: 'reply.only' }], confidence: 0.75 } },
      { guard: { needsHuman: false, action: 'record-only', errors: [] }, decision: { matchedRule: 'R-B', decisions: [], confidence: 0.5 } },
      { guard: { needsHuman: true, action: 'refuse', errors: [{ code: SHADOW_CODES.CTX }] }, decision: { matchedRule: null, decisions: [{ kind: 'tool', action: 'read' }], confidence: 0 } },
    ];
    const metrics = computeMetrics(records);
    assert(metrics.total === 4, 'total');
    assert(metrics.rates.needsHuman === 50, `needsHuman=${metrics.rates.needsHuman}`);
    assert(metrics.rates.guardReject === 50, `guardReject=${metrics.rates.guardReject}`);
    assert(metrics.rates.ambiguous === 25, `ambiguous=${metrics.rates.ambiguous}`);
    assert(metrics.rates.ctxMissing === 25, `ctx=${metrics.rates.ctxMissing}`);
    assert(metrics.byRule['R-A'] === 2 && metrics.byRule['(none)'] === 1, `byRule=${JSON.stringify(metrics.byRule)}`);
    assert(metrics.decisionsPerTurn.max === 1, 'max decisions');

    const sample = pickReviewSample(records.map((record, index) => ({ ...record, caseId: `c${index}`, turn: 1, input: { utterance: 'x' } })), 2);
    assert(sample.length === 2 && sample[0].caseId === 'c0', '高风险优先排序不对');

    const score = scoreReview([
      { caseId: 'a', human: { verdict: 'agree', note: '' } },
      { caseId: 'b', human: { verdict: 'disagree', note: '应派活' } },
      { caseId: 'c', human: { verdict: null, note: '' } },
    ]);
    assert(score.reviewed === 2 && score.disagree === 1 && score.disagreeRate === 50, `score=${JSON.stringify(score)}`);
  });
}

// ---------------------------------------------------------------------------
// 单独运行时的极简 runner
// ---------------------------------------------------------------------------

const isDirect = Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirect) {
  let pass = 0;
  let fail = 0;
  const assert = (cond, message) => {
    if (!cond) throw new Error(message || 'assert failed');
  };
  const runCase = (id, name, fn) => {
    try {
      fn();
      pass += 1;
      process.stdout.write(`PASS  ${id}  ${name}\n`);
    } catch (error) {
      fail += 1;
      process.stdout.write(`FAIL  ${id}  ${name}\n      ${error.message}\n`);
    }
  };
  runShadowSuite({ runCase, assert });
  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}
