import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

test('Wiki+API launcher uses sync-all and CRLF line endings', async () => {
  const launcherPath = path.resolve('双击运行同步Wiki+API.cmd');
  const buffer = await readFile(launcherPath);
  const content = buffer.toString('utf8');

  assert.match(content, /node src\\cli\.mjs sync-all/);
  assert.match(content, /start "" "%~dp0docs"/);
  assert.ok(content.includes('\r\n'));
  assert.ok(!buffer.includes(Buffer.from('\nsetlocal\n')));
});

test('API-only launcher uses sync-api and CRLF line endings', async () => {
  const launcherPath = path.resolve('双击运行同步API.cmd');
  const buffer = await readFile(launcherPath);
  const content = buffer.toString('utf8');

  assert.match(content, /node src\\cli\.mjs sync-api/);
  assert.match(content, /start "" "%~dp0docs\\api"/);
  assert.ok(content.includes('\r\n'));
  assert.ok(!buffer.includes(Buffer.from('\nsetlocal\n')));
});
