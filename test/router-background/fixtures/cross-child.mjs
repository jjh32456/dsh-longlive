// test/fixtures/cross-child.mjs — 跨进程测试子进程（被 cross-process.test.mjs spawn）
//
// 协议：
//   启动后打印 `ready` 并等 stdin 的 `go`；
//   race 模式：收到 go 后跑一次 tick，打印 `tick <json>`，然后 stop/退出；
//   crash 模式：tick 进入 llm.stream 后打印 `in-call` 并永久挂起，等父进程 SIGKILL。

import { Router } from '../../../src/router/background/router.mjs';
import { MockLlm } from '../../../src/router/background/mock-llm.mjs';

const cfg = JSON.parse(process.argv[2]);

function line(value) {
  process.stdout.write(`${value}\n`);
}

function finish(code) {
  process.exit(code);
}

process.on('uncaughtException', (error) => {
  process.stderr.write(`uncaught: ${error?.stack ?? error}\n`);
  finish(1);
});

if (cfg.mode === 'crash') {
  const llm = {
    provider: 'mock',
    model: 'mock-1',
    async *stream() {
      line('in-call');
      // 永不 resolve：父进程会在看到 in-call 之后 SIGKILL。
      await new Promise(() => {});
    },
  };
  const router = new Router({
    queuePath: cfg.queuePath,
    auditPath: cfg.auditPath,
    memoryPath: cfg.memoryPath,
    ledgerPath: cfg.ledgerPath,
    llm,
    maxTokens: cfg.maxTokens,
    callMaxTokens: cfg.callMaxTokens,
    retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 2 },
  });
  const started = router.start();
  if (!started.ok) {
    line(`start-failed ${JSON.stringify(started)}`);
    finish(2);
  }
  line('ready');
  const res = await router.tick();
  // 正常情况下走不到这里（stream 挂起）；如果超时被 abort，也要让父进程看见。
  line(`tick ${JSON.stringify(res)}`);
  finish(0);
} else {
  const llm = new MockLlm({ usage: { inputTokens: cfg.usage, outputTokens: 0 } });
  const router = new Router({
    queuePath: cfg.queuePath,
    auditPath: cfg.auditPath,
    memoryPath: cfg.memoryPath,
    ledgerPath: cfg.ledgerPath,
    llm,
    maxTokens: cfg.maxTokens,
    callMaxTokens: cfg.callMaxTokens,
    maxTasksPerTick: 1,
    retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 2 },
  });
  const started = router.start();
  if (!started.ok) {
    line(`start-failed ${JSON.stringify(started)}`);
    finish(2);
  }
  line('ready');

  await new Promise((resolve) => {
    if (process.stdin.readableEnded) resolve();
    else process.stdin.once('data', resolve);
  });

  const res = await router.tick();
  line(`tick ${JSON.stringify({ ...res, tokensUsed: router.tokensUsed, remaining: router.budget.remaining })}`);
  await router.stop('done');
  finish(0);
}
