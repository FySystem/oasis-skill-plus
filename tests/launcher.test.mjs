import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

test('launcher script runs the sync command and points users to the generated docs', async () => {
  const launcherPath = path.resolve('双击运行同步Wiki.cmd');
  const buffer = await readFile(launcherPath);
  const content = buffer.toString('utf8');

  assert.match(content, /chcp 65001 >nul/);
  assert.match(content, /node src\\cli\.mjs sync/);
  assert.match(content, /\[信息\] 开始同步 Oasis Wiki\.\.\./u);
  assert.match(content, /\[完成\] 同步已完成。/u);
  assert.doesNotMatch(content, /已自动打开输出目录/u);
  assert.match(content, /echo 请按任意键继续\.\.\./u);
  assert.match(content, /pause >nul/);
  assert.doesNotMatch(content, /explorer\.exe/u);
  assert.match(content, /--no-pause/);
  assert.ok(content.includes('\r\n'), 'launcher script should use CRLF line endings for cmd.exe');
  assert.doesNotMatch(content, /(?<!\r)\n/);
  assert.ok(!buffer.includes(Buffer.from('\nsetlocal\n')), 'launcher script should not use LF-only line endings');
});
