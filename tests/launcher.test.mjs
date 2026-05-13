import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

test('launcher script runs the sync command and points users to the generated docs', async () => {
  const launcherPath = path.resolve('双击运行同步Wiki.cmd');
  const buffer = await readFile(launcherPath);
  const content = buffer.toString('utf8');

  assert.match(content, /node src\\cli\.mjs sync/);
  assert.match(content, /docs\\wiki\\/);
  assert.match(content, /start "" "%~dp0docs\\wiki"/);
  assert.match(content, /--no-pause/);
  assert.ok(content.includes('\r\n'), 'launcher script should use CRLF line endings for cmd.exe');
  assert.ok(!buffer.includes(Buffer.from('\nsetlocal\n')), 'launcher script should not use LF-only line endings');
});
