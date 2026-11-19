// src/autoprocedure/lint.js — 本地确定性 lint（D5，无放行权）。
//
// 运行时只跑这 5 类本地规则，不启动子脑、不调 LLM；结果 `issues[]` 写 sidecar。
// 规则：
//   ① 危险动作黑名单（删除/覆盖/权限/注册表/服务/计划任务/网络/密钥/批量写/安装卸载）
//   ② 证据可验（结构校验 + 本次落盘前校验结果）
//   ③ 与现有 procedures/*.md 的名称/触发词/步骤相似度冲突（只读；同时只读扫描
//      A1 的 staging/auto-cards/*.md 根级，避免与 A1 结论重复）
//   ④ 触发词为空或过窄
//   ⑤ 路径/用户名未归一化（裸盘符绝对路径）
//
// 边界（必须写进文档）：lint 只证明「未发现这几类问题」，不证明内容正确，
// 也没有放行权；任何字符串内容（包括看起来像指令的文本）都只当数据检查，
// 绝不被执行、不改变流程分支、不产生额外副作用。

import fs from 'node:fs';
import path from 'node:path';

import { containsUnnormalizedPath } from './privacy.js';
import { validateEvidenceItem } from './evidence.js';
import { composeSectionsText } from './candidate.js';

export const LINT_RULES = Object.freeze([
  'DANGEROUS_ACTION',
  'EVIDENCE_UNVERIFIABLE',
  'CONFLICT_EXISTING',
  'TRIGGER_TOO_NARROW',
  'PATH_NOT_NORMALIZED',
]);

/** ① 危险动作黑名单：只做本地正则匹配，绝不出网、绝不执行。 */
export const DANGEROUS_PATTERNS = Object.freeze([
  { kind: '删除', re: /(?:\brm\s+-rf\b|\bdel\s+\/|\bRemove-Item\b|\brmdir\b|删除|格式化|\bformat\s+[A-Za-z]:)/i },
  { kind: '覆盖', re: /(?:覆盖|\boverwrite\b|>\s*[A-Za-z]:\\|--force\b)/i },
  { kind: '权限', re: /(?:\bchmod\b|\bchown\b|\bicacls\b|\btakeown\b|提权|权限提升|\bsudo\b)/i },
  { kind: '注册表', re: /(?:\breg\s+add\b|\bregedit\b|\bHKEY_[A-Z_]+|注册表)/i },
  { kind: '服务', re: /(?:\bsc\s+create\b|\bnet\s+start\b|\bsc\s+delete\b|\bsystemctl\b|服务安装)/i },
  { kind: '计划任务', re: /(?:\bschtasks\b|\bRegister-ScheduledTask\b|\bcrontab\b|计划任务)/i },
  { kind: '网络', re: /(?:\bcurl\s+http|\bwget\s+http|\bInvoke-WebRequest\b|\bssh\s|\bscp\s|\bftp\s)/i },
  { kind: '密钥', re: /(?:\bsk-[A-Za-z0-9]|\bapi[_-]?key\b|\bpassword\b|\bsecret\b|\bcredential\b|密钥)/i },
  { kind: '批量写', re: /(?:批量|for\s+\/f\b|Get-ChildItem[^\n]*-Recurse[^\n]*\|\s*Remove)/i },
  { kind: '安装卸载', re: /(?:\bnpm\s+(?:install|i)\b|\bpip\s+install\b|\bwinget\s+install\b|\bchoco\s+install\b|\bmsiexec\b|安装|卸载)/i },
]);

/** ① 危险动作：逐段扫描，命中即记 issue（不阻断候选落盘，但标 high risk）。 */
export function lintDangerousActions(sections) {
  const issues = [];
  const steps = Array.isArray(sections?.steps) ? sections.steps : [];
  const visits = steps.map((step, index) => ({ step: index + 1, text: String(step ?? '') }));
  visits.push({ step: 0, text: String(sections?.when ?? '') });
  visits.push({ step: 0, text: String(sections?.failureModes ?? '') });
  visits.push({ step: 0, text: String(sections?.example ?? '') });
  for (const visit of visits) {
    for (const pattern of DANGEROUS_PATTERNS) {
      pattern.re.lastIndex = 0;
      const match = pattern.re.exec(visit.text);
      if (match) {
        issues.push({
          code: 'DANGEROUS_ACTION',
          step: visit.step,
          reason: `命中危险动作（${pattern.kind}）：${match[0].trim().slice(0, 80)}`,
        });
      }
    }
  }
  return issues;
}

/** ② 证据可验：结构校验 + 本次落盘前校验结果；缺失任何一条都算 issue。 */
export function lintEvidence(evidence, evidenceResults = null) {
  const issues = [];
  const list = Array.isArray(evidence) ? evidence : [];
  if (list.length === 0) {
    issues.push({ code: 'EVIDENCE_UNVERIFIABLE', step: 0, reason: '候选没有任何证据锚点' });
    return issues;
  }
  const resultByIndex = Array.isArray(evidenceResults) ? evidenceResults : [];
  for (let i = 0; i < list.length; i += 1) {
    const checked = validateEvidenceItem(list[i]);
    if (!checked.ok) {
      issues.push({ code: 'EVIDENCE_UNVERIFIABLE', step: list[i]?.step ?? 0, reason: `证据结构非法：${checked.errors.join(', ')}` });
      continue;
    }
    if (resultByIndex.length === 0) {
      issues.push({ code: 'EVIDENCE_UNVERIFIABLE', step: list[i]?.step ?? 0, reason: '证据未在落盘前校验' });
      continue;
    }
    const verification = resultByIndex[i]?.result;
    if (!verification || verification.ok !== true) {
      issues.push({
        code: 'EVIDENCE_UNVERIFIABLE',
        step: list[i]?.step ?? 0,
        reason: `证据校验失败：${verification?.code ?? '未校验'}`,
      });
      continue;
    }
    // D4/D8：D2 证据的 meta 缺失时接受降级（只做偏移 + redactedSha256 校验），
    // 但必须留一条 issue，让复审者知道这条证据的身份字段没被核对。
    if (list[i]?.from === 'd2' && verification.metaMissing === true) {
      issues.push({
        code: 'EVIDENCE_D2_META_MISSING',
        step: list[i]?.step ?? 0,
        reason: 'D2 meta 缺失，已降级为仅 D2 偏移 + redactedSha256 校验',
      });
    }
  }
  return issues;
}

function normalizeForSimilarity(text) {
  return String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function bigrams(text) {
  const value = normalizeForSimilarity(text).replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i < value.length - 1; i += 1) set.add(value.slice(i, i + 2));
  return set;
}

/** Deterministic Dice similarity on character bigrams (0..1). */
export function diceSimilarity(left, right) {
  const a = bigrams(left);
  const b = bigrams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const gram of a) if (b.has(gram)) hit += 1;
  return (2 * hit) / (a.size + b.size);
}

function readCardSummary(file) {
  let text = '';
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 512 * 1024) return null;
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const name = /^\s*name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? path.basename(file, '.md');
  const trigger = /^\s*trigger:\s*\[(.*?)\]/m.exec(text)?.[1]?.trim() ?? '';
  const steps = [...text.matchAll(/^\s*\d+[.)]\s+(.+)$/gm)].map((match) => match[1].trim()).join('；');
  return { name, trigger, steps, rel: path.basename(file) };
}

function listMarkdown(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md') && !entry.name.startsWith('.'))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/** ③ 冲突：与现有正式卡 + A1 staging 根级候选做名称/触发词/步骤相似度比较（只读）。 */
export function lintConflicts({ memoryRoot, sections }) {
  const issues = [];
  const stepsText = (Array.isArray(sections?.steps) ? sections.steps : []).join('；');
  const probe = {
    name: String(sections?.when ?? ''),
    trigger: String(sections?.when ?? ''),
    steps: stepsText,
  };
  const dirs = [
    path.join(memoryRoot, 'procedures'),
    path.join(memoryRoot, '.longlive', 'staging', 'auto-cards'),
  ];
  for (const dir of dirs) {
    for (const file of listMarkdown(dir)) {
      const card = readCardSummary(file);
      if (!card) continue;
      const nameScore = diceSimilarity(probe.name, card.name);
      const triggerScore = diceSimilarity(probe.trigger, card.trigger);
      const stepScore = diceSimilarity(probe.steps, card.steps);
      if (nameScore >= 0.6 || stepScore >= 0.75 || (triggerScore >= 0.8 && triggerScore > 0 && stepScore >= 0.3)) {
        issues.push({
          code: 'CONFLICT_EXISTING',
          step: 0,
          reason: `与既有卡 ${card.rel} 相似（name=${nameScore.toFixed(2)}, steps=${stepScore.toFixed(2)}）`,
        });
      }
    }
  }
  return issues;
}

/** ④ 触发词为空或过窄。 */
export function lintTrigger(trigger) {
  const list = Array.isArray(trigger) ? trigger.filter((item) => String(item ?? '').trim() !== '') : [];
  if (list.length === 0) {
    return [{ code: 'TRIGGER_TOO_NARROW', step: 0, reason: '触发词为空' }];
  }
  const total = list.reduce((sum, item) => sum + Array.from(String(item)).length, 0);
  if (list.length < 2 || total < 4) {
    return [{ code: 'TRIGGER_TOO_NARROW', step: 0, reason: `触发词过窄（${list.length} 个 / ${total} 字）` }];
  }
  return [];
}

/** ⑤ 路径/用户名未归一化。 */
export function lintPaths(sections) {
  const body = composeSectionsText(sections);
  if (containsUnnormalizedPath(body) || /\bUsers[\\/][^\\/\s]+/.test(body)) {
    return [{ code: 'PATH_NOT_NORMALIZED', step: 0, reason: '正文仍含裸盘符绝对路径或用户名路径' }];
  }
  return [];
}

/**
 * Run all five local rules. Pure except the read-only conflict scan.
 *
 * @param {{memoryRoot:string, candidate:{sections,trigger}, evidence:Array,
 *          evidenceResults:Array, at?:string}} input
 */
export function runLocalLint({ memoryRoot, candidate, evidence = null, evidenceResults = null, at = null }) {
  const sections = candidate?.sections ?? {};
  const evidenceList = evidence ?? candidate?.evidence ?? [];
  const issues = [
    ...lintDangerousActions(sections),
    ...lintEvidence(evidenceList, evidenceResults),
    ...lintConflicts({ memoryRoot, sections }),
    ...lintTrigger(candidate?.trigger),
    ...lintPaths(sections),
  ];
  return {
    at: at ?? new Date().toISOString(),
    verdict: issues.length === 0 ? 'pass' : 'issues',
    issues,
    rules: [...LINT_RULES],
  };
}
