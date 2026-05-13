import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

test('Wiki+API launcher uses sync-all and CRLF line endings', async () => {
  const launcherPath = path.resolve('双击运行同步Wiki+API.cmd');
  const buffer = await readFile(launcherPath);
  const content = buffer.toString('utf8');

  assert.match(content, /chcp 65001 >nul/);
  assert.match(content, /node src\\cli\.mjs sync-all/);
  assert.match(content, /\[信息\] 开始同步 Oasis Wiki 和 API\.\.\./u);
  assert.match(content, /\[完成\] 同步已完成。/u);
  assert.doesNotMatch(content, /已自动打开输出目录/u);
  assert.match(content, /echo 请按任意键继续\.\.\./u);
  assert.match(content, /pause >nul/);
  assert.doesNotMatch(content, /explorer\.exe/u);
  assert.ok(content.includes('\r\n'));
  assert.doesNotMatch(content, /(?<!\r)\n/);
  assert.ok(!buffer.includes(Buffer.from('\nsetlocal\n')));
});

test('API-only launcher uses sync-api and CRLF line endings', async () => {
  const launcherPath = path.resolve('双击运行同步API.cmd');
  const buffer = await readFile(launcherPath);
  const content = buffer.toString('utf8');

  assert.match(content, /chcp 65001 >nul/);
  assert.match(content, /node src\\cli\.mjs sync-api/);
  assert.match(content, /\[信息\] 开始同步 Oasis API\.\.\./u);
  assert.match(content, /\[完成\] 同步已完成。/u);
  assert.doesNotMatch(content, /已自动打开输出目录/u);
  assert.match(content, /echo 请按任意键继续\.\.\./u);
  assert.match(content, /pause >nul/);
  assert.doesNotMatch(content, /explorer\.exe/u);
  assert.ok(content.includes('\r\n'));
  assert.doesNotMatch(content, /(?<!\r)\n/);
  assert.ok(!buffer.includes(Buffer.from('\nsetlocal\n')));
});
