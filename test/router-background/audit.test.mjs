// test/audit.test.mjs — 审计轮转与跨文件续号（mustFix 9/10）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLog, readAudit, rotatedPaths } from '../../src/router/background/audit.mjs';

test('审计轮转：超过 maxBytes 生成 .1/.2，readAudit 按旧→新读回且 seq 连续', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-audit-'));
  const file = path.join(dir, 'audit.jsonl');
  try {
    const log = new AuditLog({
      file,
      runId: 'run-rotation',
      maxBytes: 500,
      maxRotations: 10,
    });
    log.open();
    for (let i = 0; i < 10; i += 1) {
      log.append('tick.start', { tick: i, padding: 'x'.repeat(120) });
    }
    log.close();

    assert.ok(fs.existsSync(file), 'base 文件必须存在');
    assert.ok(rotatedPaths(file, 10).length >= 2, '至少应产生两个轮转文件');

    const { records, badLines, files } = readAudit(file, { maxRotations: 10 });
    assert.equal(badLines, 0);
    assert.equal(records.length, 10);
    assert.deepEqual(records.map((rec) => rec.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.ok(files.length >= 3, 'files 应包含轮转文件 + base');
    assert.equal(records[0].run_id, 'run-rotation');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
