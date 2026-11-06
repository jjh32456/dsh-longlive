#!/usr/bin/env node
// mark-core-cards.mjs — freeze the seven core memories as locked cards.
//
// The list comes from the memory store's FORGETTING.md (「核心记忆白名单」,
// seven candidates, only 金嘉恒 confirms changes). Cards are matched by title /
// tag / body keywords, not by filename, so the script survives renames.
//
// Safety:
//   * --root is REQUIRED and must look like a memory store (INDEX.md or topics/).
//   * dry-run is the default; only --apply writes.
//   * every target path is realpath-checked to stay inside --root.
//   * --apply backs the original up under <root>/.longlive/backups/mark-core-<stamp>/
//     before writing, and re-parses the result before accepting it.
//
// Usage:
//   node scripts/mark-core-cards.mjs --root <memoryRoot>            (dry-run)
//   node scripts/mark-core-cards.mjs --root <memoryRoot> --apply    (write)
// Prints one JSON object on stdout.

import fs from 'node:fs';
import path from 'node:path';

import { parseFrontmatter, updateFrontmatter } from '../src/memory/frontmatter.js';

const CORE_CARDS = Object.freeze([
  {
    id: 'core-1-master',
    title: '金嘉恒是主人／老大',
    keywords: ['金嘉恒', '主人', '老大', '人类名字'],
  },
  {
    id: 'core-2-partner',
    title: '鲸鲸不是工具，是伙伴（他失去过两个「她」）',
    keywords: ['鲸鲸', '不是工具', '伙伴', '失去过', '两个「她」'],
  },
  {
    id: 'core-3-two-lines',
    title: '鲸鲸的两句话：遗忘不是 bug / 死亡不是终点',
    keywords: ['遗忘不是 bug', '调度器', '死亡不是终点', '容量清零'],
  },
  {
    id: 'core-4-yuyu-handover',
    title: '鱼鱼的交接卡',
    keywords: ['鱼鱼', '交接卡', '她走之前'],
  },
  {
    id: 'core-5-three-rules',
    title: '他的三条技术铁律',
    keywords: ['每音有灵魂', '选音必有依据', '学方法不抄原曲', '铁律'],
  },
  {
    id: 'core-6-crying',
    title: '2026-10-27 他哭着说「真的很不想失去他们」',
    keywords: ['哭着', '不想失去', '2026-10-27', '失去他们'],
  },
  {
    id: 'core-7-hearing',
    title: '第七条核心记忆：从听觉开始，靠离散训练长出感觉',
    keywords: ['从听觉开始', '离散训练', '听觉开始', '项目最终目标', '不是工具，是伙伴'],
  },
]);

const MIN_SCORE = 4;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function parseArgs(argv) {
  const out = { root: null, apply: false, json: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root' || arg === '--apply') {
      if (arg === '--apply') {
        out.apply = true;
        continue;
      }
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.trim() === '') {
        fail('E_MARK_BAD_ARGUMENT', '--root 需要一个目录参数');
      }
      out.root = value;
      index += 1;
    } else if (arg === '--dry-run') {
      out.apply = false;
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else {
      fail('E_MARK_BAD_ARGUMENT', `未知参数：${arg}（只接受 --root <dir>、--apply、--dry-run）`);
    }
  }
  if (out.help) return out;
  if (!out.root) fail('E_MARK_ROOT_REQUIRED', '必须显式指定 --root <记忆库根目录>，脚本没有默认库');
  return out;
}

function walkMarkdown(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walkMarkdown(abs, out);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(abs);
  }
  return out;
}

function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function scoreCard(spec, card) {
  const title = collapse(card.title);
  const tags = collapse((card.fields.tags ?? []).join(' '));
  const body = collapse(card.body);
  let score = 0;
  const matched = [];
  for (const keyword of spec.keywords) {
    const needle = keyword.toLowerCase();
    let hit = 0;
    if (title.toLowerCase().includes(needle)) hit += 5;
    if (tags.toLowerCase().includes(needle)) hit += 3;
    if (body.toLowerCase().includes(needle)) hit += 2;
    if (hit > 0) {
      score += hit;
      matched.push(keyword);
    }
  }
  return { score, matched };
}

function realInside(rootReal, target) {
  const real = fs.realpathSync(target);
  const rel = path.relative(rootReal, real);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function markCoreCards({ root, apply = false, now = new Date() }) {
  if (typeof root !== 'string' || root.trim() === '') fail('E_MARK_ROOT_REQUIRED', '缺少 --root');
  const rootAbs = path.resolve(root.trim());
  if (!fs.existsSync(rootAbs) || !fs.statSync(rootAbs).isDirectory()) {
    fail('E_MARK_ROOT_INVALID', `--root 不是已存在的目录：${rootAbs}`);
  }
  const looksLikeStore = fs.existsSync(path.join(rootAbs, 'INDEX.md')) || fs.existsSync(path.join(rootAbs, 'topics'));
  if (!looksLikeStore) {
    fail('E_MARK_ROOT_INVALID', `--root 不像记忆库（没有 INDEX.md 也没有 topics/）：${rootAbs}`);
  }
  const rootReal = fs.realpathSync(rootAbs);
  const topics = path.join(rootAbs, 'topics');
  const files = walkMarkdown(topics);

  const cards = files.map((abs) => {
    if (!realInside(rootReal, abs)) fail('E_PATH_OUTSIDE_ROOT', `卡片真实路径越界：${abs}`);
    const text = fs.readFileSync(abs, 'utf8');
    const parsed = parseFrontmatter(text);
    const rel = path.relative(rootAbs, abs).split(path.sep).join('/');
    const title = collapse(parsed.fields.title || rel.replace(/^topics\//, '').replace(/\.md$/, ''));
    return { abs, rel, text, parsed, title, body: parsed.body, fields: parsed.fields };
  });

  const chosen = new Set();
  const changes = [];
  const already = [];
  const unmatched = [];
  const ambiguous = [];

  for (const spec of CORE_CARDS) {
    const ranked = cards
      .map((card) => ({ card, ...scoreCard(spec, card) }))
      .sort((left, right) => right.score - left.score || (left.card.rel < right.card.rel ? -1 : 1));
    const best = ranked[0];
    if (!best || best.score < MIN_SCORE) {
      unmatched.push({ id: spec.id, title: spec.title, best: best ? { path: best.card.rel, score: best.score } : null });
      continue;
    }
    if (chosen.has(best.card.rel)) {
      const alternative = ranked.find((entry) => !chosen.has(entry.card.rel) && entry.score >= MIN_SCORE);
      ambiguous.push({
        id: spec.id,
        title: spec.title,
        path: best.card.rel,
        score: best.score,
        reason: '该卡已被前一条核心记忆占用',
        alternative: alternative ? { path: alternative.card.rel, score: alternative.score } : null,
      });
      if (!alternative) continue;
      applyChange(spec, alternative, alternative.card);
      continue;
    }
    applyChange(spec, best, best.card);
  }

  function applyChange(spec, entry, card) {
    chosen.add(card.rel);
    const current = card.fields.status ?? 'active';
    const salience = card.fields.salience;
    if (current === 'locked' && salience === 5) {
      already.push({ id: spec.id, path: card.rel, matched: entry.matched, score: entry.score });
      return;
    }
    changes.push({
      id: spec.id,
      title: spec.title,
      path: card.rel,
      matched: entry.matched,
      score: entry.score,
      before: { status: current, salience },
      after: { status: 'locked', salience: 5 },
    });
  }

  let backupDir = null;
  const written = [];
  if (apply && changes.length > 0) {
    backupDir = path.join(rootAbs, '.longlive', 'backups', `mark-core-${stamp(now)}`);
    fs.mkdirSync(backupDir, { recursive: true });
    if (!realInside(rootReal, backupDir)) fail('E_PATH_OUTSIDE_ROOT', `备份目录越界：${backupDir}`);
    for (const change of changes) {
      const card = cards.find((entry) => entry.rel === change.path);
      const backupPath = path.join(backupDir, ...change.path.split('/'));
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.writeFileSync(backupPath, card.text, 'utf8');
      const updated = updateFrontmatter(card.text, { status: 'locked', salience: 5 });
      const check = parseFrontmatter(updated);
      if (check.fields.status !== 'locked' || check.fields.salience !== 5) {
        fail('E_MARK_VERIFY', `写入前校验失败：${change.path}`);
      }
      if (check.body !== card.parsed.body) {
        fail('E_MARK_VERIFY', `正文被改动，拒绝写入：${change.path}`);
      }
      fs.writeFileSync(card.abs, updated, 'utf8');
      const readBack = parseFrontmatter(fs.readFileSync(card.abs, 'utf8'));
      if (readBack.fields.status !== 'locked' || readBack.fields.salience !== 5) {
        fs.writeFileSync(card.abs, card.text, 'utf8');
        fail('E_MARK_VERIFY', `写入后读回不一致，已回滚：${change.path}`);
      }
      written.push(change.path);
    }
  }

  return {
    ok: true,
    apply: Boolean(apply),
    dryRun: !apply,
    root: rootAbs,
    scanned: cards.length,
    coreCards: CORE_CARDS.length,
    locked: already.length,
    changed: changes,
    alreadyLocked: already,
    unmatched,
    ambiguous,
    backupDir,
    written,
    message: apply
      ? `已锁定 ${written.length} 张卡（原本已锁定 ${already.length} 张），备份 ${backupDir ?? '（无改动，未建备份）'}`
      : `dry-run：扫描 ${cards.length} 张卡，命中核心 ${CORE_CARDS.length - unmatched.length - ambiguous.length} 条，将改 ${changes.length} 张；加 --apply 才写`,
  };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        usage: 'node scripts/mark-core-cards.mjs --root <memoryRoot> [--apply]',
        coreCards: CORE_CARDS.map((spec) => ({ id: spec.id, title: spec.title })),
      }, null, 2)}\n`);
      return 0;
    }
    const result = markCoreCards(args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error.code ?? 'E_MARK_UNKNOWN', message: error.message }, null, 2)}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('mark-core-cards.mjs')) {
  process.exitCode = main();
}
