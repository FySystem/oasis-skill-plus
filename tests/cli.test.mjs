import test from 'node:test';
import assert from 'node:assert/strict';

import { runCli } from '../src/cli-runner.mjs';

function createWritableCapture(isTTY = false) {
  let output = '';
  return {
    stream: {
      isTTY,
      write(chunk) {
        output += chunk;
      }
    },
    read() {
      return output;
    }
  };
}

test('runCli routes sync-api to the API synchronizer', async () => {
  const stdout = createWritableCapture();
  const stderr = createWritableCapture();
  const calls = [];

  const exitCode = await runCli({
    argv: ['node', 'cli', 'sync-api'],
    stdout: stdout.stream,
    stderr: stderr.stream,
    syncWikiImpl: async () => {
      calls.push('wiki');
      return {};
    },
    syncApiImpl: async () => {
      calls.push('api');
      return {
        totalEntities: 4,
        createdCount: 4,
        updatedCount: 0,
        deletedCount: 0,
        durationMs: 20
      };
    }
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, ['api']);
  assert.match(stdout.read(), /API 同步完成。/);
  assert.match(stdout.read(), /实体数：4/);
  assert.match(stdout.read(), /新增：4/);
  assert.equal(stderr.read(), '');
});

test('runCli routes sync-all to both synchronizers', async () => {
  const stdout = createWritableCapture();
  const calls = [];

  const exitCode = await runCli({
    argv: ['node', 'cli', 'sync-all'],
    stdout: stdout.stream,
    stderr: createWritableCapture().stream,
    syncWikiImpl: async () => {
      calls.push('wiki');
      return {
        totalArticles: 2,
        createdCount: 1,
        updatedCount: 0,
        deletedCount: 0,
        imagesDownloaded: 0,
        durationMs: 10
      };
    },
    syncApiImpl: async () => {
      calls.push('api');
      return {
        totalEntities: 4,
        createdCount: 4,
        updatedCount: 0,
        deletedCount: 0,
        durationMs: 20
      };
    }
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, ['wiki', 'api']);
  assert.match(stdout.read(), /Wiki 同步完成。/);
  assert.match(stdout.read(), /API 同步完成。/);
  assert.match(stdout.read(), /全部同步完成。/);
  assert.match(stdout.read(), /总耗时：/);
});

test('联合同步并发启动，失败时等待另一任务并结束固定进度区域', async () => {
  // 使用显式屏障验证并发，不依赖机器速度或计时阈值。
  const stdout = createWritableCapture(true);
  const stderr = createWritableCapture();
  let releaseApi;
  const apiGate = new Promise((resolve) => { releaseApi = resolve; });
  let apiStarted;
  const started = new Promise((resolve) => { apiStarted = resolve; });
  let returned = false;
  const running = runCli({
    argv: ['node', 'cli', 'sync-all'], stdout: stdout.stream, stderr: stderr.stream,
    syncWikiImpl: async ({ onProgress }) => {
      onProgress({ phase: 'articles', current: 1, total: 2 });
      await started;
      throw new Error('Wiki 失败');
    },
    syncApiImpl: async ({ onProgress }) => {
      apiStarted();
      onProgress({ phase: 'details', current: 1, total: 2 });
      await apiGate;
      return { totalEntities: 2, durationMs: 1 };
    }
  }).then((code) => { returned = true; return code; });
  await started;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(returned, false);
  releaseApi();
  assert.equal(await running, 1);
  assert.match(stdout.read(), /Wiki +\| API/);
  assert.match(stdout.read(), /\[2\/4\].*\| \[2\/3\]/);
  assert.match(stdout.read(), /API 同步完成/);
  assert.doesNotMatch(stdout.read(), /全部同步完成/);
  assert.match(stderr.read(), /Wiki 失败/);
});

test('联合同步捕获两个同步抛出的错误', async () => {
  // 注入实现同步抛错时，另一任务也必须得到执行。
  const stderr = createWritableCapture();
  const code = await runCli({
    argv: ['node', 'cli', 'sync-all'], stdout: createWritableCapture().stream, stderr: stderr.stream,
    syncWikiImpl() { throw new Error('Wiki 错误'); },
    syncApiImpl() { throw new Error('API 错误'); }
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /Wiki 错误；API 错误/);
});

test('runCli prints usage for an unsupported command', async () => {
  const stderr = createWritableCapture();

  const exitCode = await runCli({
    argv: ['node', 'cli', 'unknown'],
    stdout: createWritableCapture().stream,
    stderr: stderr.stream,
    syncWikiImpl: async () => ({}),
    syncApiImpl: async () => ({})
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.read(), /用法：node src\/cli\.mjs sync\|sync-api\|sync-all/);
});

test('runCli prints a localized error when syncing fails', async () => {
  const stdout = createWritableCapture();
  const stderr = createWritableCapture();

  const exitCode = await runCli({
    argv: ['node', 'cli', 'sync-api'],
    stdout: stdout.stream,
    stderr: stderr.stream,
    syncWikiImpl: async () => ({}),
    syncApiImpl: async () => {
      throw new Error('请求失败，状态码 500：https://example.com/api');
    }
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.read(), '');
  assert.match(stderr.read(), /同步失败：请求失败，状态码 500：https:\/\/example\.com\/api/);
});
