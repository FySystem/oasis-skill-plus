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
  assert.match(stdout.read(), /API sync completed\./);
  assert.equal(stderr.read(), '');
});

test('runCli routes sync-all to both synchronizers in order', async () => {
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
  assert.match(stdout.read(), /Wiki sync completed\./);
  assert.match(stdout.read(), /API sync completed\./);
  assert.match(stdout.read(), /Sync-all completed\./);
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
  assert.match(stderr.read(), /Usage: node src\/cli\.mjs sync\|sync-api\|sync-all/);
});
