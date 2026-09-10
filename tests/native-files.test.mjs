import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hasNativeFiles, writeNativeFiles } from '../src/native-files.mjs';
import { syncApi } from '../src/api-sync.mjs';

test('Go 与 JS API 同步输出一致，缓存时间保持不变', { skip: !hasNativeFiles() }, async () => {
  // 同一份目录和详情分别走两种实现，比较全部产物而不只检查退出码。
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oasis-native-api-'));
  const client = {
    async fetchClassCatalog() { return []; },
    async fetchSortedCatalog(family) { return family === 'cppenum' ? { 示例: 'cppenum/detail/example.json' } : {}; },
    async fetchDetail() { return { Name: '示例', Description: 'Unicode 内容', Variables: [] }; }
  };
  async function contents(root, relative = '') {
    const files = {};
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) Object.assign(files, await contents(root, file));
      else files[file] = await readFile(path.join(root, file), 'utf8');
    }
    return files;
  }
  try {
    for (const nativeFiles of [false, true]) {
      const rootDir = path.join(directory, String(nativeFiles));
      await syncApi({ rootDir, client, nativeFiles, clock: () => '固定时间' });
      const doc = path.join(rootDir, 'docs/api/cppenum/example.md');
      const before = await stat(doc);
      await syncApi({ rootDir, client, nativeFiles, clock: () => '固定时间' });
      assert.equal((await stat(doc)).mtimeMs, before.mtimeMs);
    }
    assert.deepEqual(await contents(path.join(directory, 'true')), await contents(path.join(directory, 'false')));
    // 制造目录被普通文件占用的写入错误，确认 API manifest 不会提前提交。
    const rootDir = path.join(directory, 'true');
    const manifestPath = path.join(rootDir, '.oasis-sync/api-manifest.json');
    const manifestBefore = await readFile(manifestPath, 'utf8');
    await writeFile(path.join(rootDir, 'docs/api/cppenum/B'), '阻止创建目录');
    client.fetchSortedCatalog = async (family) => family === 'cppenum'
      ? { 示例: 'cppenum/detail/example.json', B: { 新增: 'cppenum/detail/new.json' } } : {};
    await assert.rejects(syncApi({ rootDir, client, nativeFiles: true }));
    assert.equal(await readFile(manifestPath, 'utf8'), manifestBefore);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('原生写入保留缓存内容、修复缺失文件，并拒绝路径穿越', { skip: !hasNativeFiles() }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oasis-native-files-'));
  try {
    const items = [{ filename: 'existing.md', content: '远端内容', checkOnly: true }, { filename: 'missing.md', content: '缺失修复', checkOnly: true }];
    await writeFile(path.join(directory, 'existing.md'), '现有内容');
    const completed = [];
    await writeNativeFiles({ directory, items, onWritten: (index) => completed.push(index) });
    assert.deepEqual(completed.sort(), [0, 1]);
    assert.equal(await readFile(path.join(directory, 'existing.md'), 'utf8'), '现有内容');
    assert.equal(await readFile(path.join(directory, 'missing.md'), 'utf8'), '缺失修复');
    await assert.rejects(writeNativeFiles({ directory, items: [{ filename: '../escape', content: '越界' }], onWritten() {} }), /文件名/);
    await assert.rejects(writeNativeFiles({ directory, items, onWritten() { throw new Error('进度失败'); } }), /进度失败/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
