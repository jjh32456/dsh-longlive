// A1 legacy migration: move 1.8.0 direct conclusion cards and rc.1-rc.3
// topics/auto cards into the .longlive staging area. Content is never deleted.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const day = (d) => d.toISOString().slice(0, 10);

function listAutoFiles(root) {
  const dir = path.join(root, 'topics', 'auto');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => ({ abs: path.join(dir, name), name, source: 'topics/auto' }));
}

function listOldDirect(root) {
  // Deliberately filesystem-only: scanCards() may write card-audit.jsonl for
  // invalid/sidecar cards, so dry-run must not use it.
  const dir = path.join(root, 'topics');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.startsWith('conclusion-t') || !name.endsWith('.md')) continue;
    const abs = path.join(dir, name);
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const frontmatter = (text.match(/^---\s*\n([\s\S]*?)\n---/) ?? [])[1] ?? '';
    const tags = (frontmatter.match(/^tags:\s*\[([^\]]*)\]/m) ?? [])[1] ?? '';
    if (!tags.split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).includes('auto-conclusion')) continue;
    out.push({ abs, name, source: 'topics/conclusion-*', rel: path.join('topics', name).split(path.sep).join('/') });
  }
  return out;
}

function countRecovered(root) {
  const d = path.join(root, '.longlive', 'staging', 'auto-cards', 'legacy-1.8.0');
  return fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.endsWith('.md')).length : 0;
}

/** Read-only preflight for downgrade safety. */
export function preflightA1Legacy(memoryRoot) {  const root = String(memoryRoot ?? '');
  if (root === '') return { ok: false, code: 'E_MEMORY_ROOT', blocking: false, legacyCount: 0, autoCount: 0 };
  const legacy = listOldDirect(root).length;
  const auto = listAutoFiles(root).length;
  return {
    ok: true, memoryRoot: root, legacyCount: legacy, autoCount: auto,
    blocking: legacy > 0 || auto > 0,
    code: legacy > 0 || auto > 0 ? 'E_A1_LEGACY_NOT_MIGRATED' : null,
    message: legacy > 0 || auto > 0
      ? `检测到 ${legacy} 张 1.8.0 直写卡、${auto} 张 topics/auto 卡尚未迁移；先运行 scripts/migrate-a1-legacy.mjs --apply 再降级`
      : 'A1 legacy 已迁移，降级安全',
  };
}

function uniqueDest(dir, name) {
  let candidate = path.join(dir, name);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(name);
  const stem = name.slice(0, -ext.length);
  candidate = path.join(dir, `${stem}.duplicate-${Date.now()}${ext}`);
  return candidate;
}

/**
 * @param {{memoryRoot:string, dryRun?:boolean, now?:Date, rebuildIndex?:boolean}} opts
 */
export function migrateLegacyA1({ memoryRoot, dryRun = true, now = new Date(), rebuildIndex = false } = {}) {
  const root = String(memoryRoot ?? '');
  if (root === '') return { ok: false, code: 'E_MEMORY_ROOT', dryRun, moved: 0, items: [] };
  const plan = [];
  const autoFiles = listAutoFiles(root);
  for (const file of autoFiles) {
    const destDir = path.join(root, '.longlive', 'staging', 'auto-cards');
    plan.push({ kind: 'topics/auto', source: file.abs, sourceRel: path.join('topics', 'auto', file.name).split(path.sep).join('/'), dest: uniqueDest(destDir, file.name) });
  }
  for (const card of listOldDirect(root)) {
    const destDir = path.join(root, '.longlive', 'staging', 'auto-cards', 'legacy-1.8.0');
    plan.push({ kind: 'topics/conclusion-*', source: card.abs, sourceRel: card.rel, dest: uniqueDest(destDir, card.name) });
  }
  const receipt = {
    schema: 'a1-legacy-migration/v1', generatedAt: now.toISOString(), memoryRoot: root,
    dryRun, moved: 0, recovered: 0, skipped: 0, items: [], log: path.join(root, '.longlive', 'logs', 'a1-migration.jsonl'),
    receiptPath: null, indexRebuilt: false, totalLegacy: 0,
  };
  receipt.recovered = countRecovered(root);
  if (plan.length === 0 && receipt.recovered === 0) return { ok: true, ...receipt };
  if (!dryRun) fs.mkdirSync(path.dirname(receipt.log), { recursive: true });
  for (const item of plan) {
    if (!fs.existsSync(item.source)) { receipt.skipped += 1; continue; }
    const before = fs.readFileSync(item.source);
    const detail = { ...item, sourceSha256: sha(before), bytes: before.length, action: dryRun ? 'dry-run' : 'move' };
    if (!dryRun) {
      fs.mkdirSync(path.dirname(item.dest), { recursive: true });
      // Journal the plan BEFORE the rename: a kill between begin/done is
      // recoverable by the next run (source/destination reconciliation).
      fs.appendFileSync(receipt.log, `${JSON.stringify({ at: now.toISOString(), event: 'begin', ...detail })}\n`, 'utf8');
      fs.renameSync(item.source, item.dest);
      fs.appendFileSync(receipt.log, `${JSON.stringify({ at: now.toISOString(), event: 'done', ...detail })}\n`, 'utf8');
    }
    receipt.items.push(detail);
    receipt.moved += 1;
  }
  receipt.totalLegacy = receipt.moved + receipt.recovered;
  if (!dryRun) {
    // Remove only now-empty legacy dirs; cards themselves were moved, not deleted.
    for (const rel of ['topics/auto']) {
      const dir = path.join(root, rel);
      try { if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* leave */ }
    }
    const receiptsDir = path.join(root, '.longlive', 'migrations');
    fs.mkdirSync(receiptsDir, { recursive: true });
    receipt.receiptPath = path.join(receiptsDir, `a1-legacy-${now.toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(receipt.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    if (receipt.log && fs.existsSync(receipt.log)) {
      fs.appendFileSync(receipt.log, `${JSON.stringify({ at: now.toISOString(), event: 'receipt', path: receipt.receiptPath, moved: receipt.moved, recovered: receipt.recovered, totalLegacy: receipt.totalLegacy })}\n`, 'utf8');
    }
  }
  return { ok: true, ...receipt };
}

export const __test = { sha, day };
