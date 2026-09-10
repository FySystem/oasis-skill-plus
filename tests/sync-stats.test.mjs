import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { syncApi } from '../src/api-sync.mjs';
import { syncWiki } from '../src/sync.mjs';
import { hasNativeFiles } from '../src/native-files.mjs';

// 保留 manifest，删除真实生成目录，覆盖用户复现以及 JS/Go 两种写入路径。
for (const nativeFiles of [false, true]) {
  test(`API 删除 class 或整个目录后统计补回数量（nativeFiles=${nativeFiles}）`,
    { skip: nativeFiles && !hasNativeFiles() }, async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-api-stats-'));
      let description = '原内容';
      const client = {
        async fetchClassCatalog() { return [{ Type: 'class', Name: 'Actor', Path: 'class/detail/Actor.json' }]; },
        async fetchSortedCatalog(family) { return family === 'cppenum' ? { State: 'cppenum/detail/State.json' } : {}; },
        async fetchDetail() { return { Name: '示例', Description: description, Variables: [] }; }
      };
      const sync = () => syncApi({ rootDir, client, nativeFiles });
      try {
        assert.equal((await sync()).createdCount, 2);
        await rm(path.join(rootDir, 'docs/api/class'), { recursive: true });
        const partial = await sync();
        assert.equal(partial.createdCount, 1);
        assert.equal(partial.updatedCount, 0);
        assert.ok(await readFile(path.join(rootDir, 'docs/api/class/Actor.md'), 'utf8'));
        await rm(path.join(rootDir, 'docs/api'), { recursive: true });
        assert.equal((await sync()).createdCount, 2);
        assert.equal((await sync()).createdCount, 0);
        // 同时发生远端变化与本地缺失时，每个实体只统计一次。
        await rm(path.join(rootDir, 'docs/api/class'), { recursive: true });
        description = '远端新内容';
        const changed = await sync();
        assert.equal(changed.createdCount, 0);
        assert.equal(changed.updatedCount, 2);
      } finally {
        await rm(rootDir, { recursive: true, force: true });
      }
    });
}

test('Wiki 删除整目录后补回词条计入新增，图片独立统计，再次同步归零', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-wiki-stats-'));
  const client = {
    async fetchCategoryTree() { return { tree: [{ id: 1, type: 1, label: '示例' }] }; },
    async fetchArticle() { return { id: '1', title: '示例', body: '![图](https://example.com/a.png)' }; },
    async downloadImage() { return { buffer: Buffer.from('图片') }; }
  };
  try {
    await syncWiki({ rootDir, client });
    await rm(path.join(rootDir, 'docs/wiki'), { recursive: true });
    const restored = await syncWiki({ rootDir, client });
    assert.equal(restored.createdCount, 1);
    assert.equal(restored.updatedCount, 0);
    assert.equal(restored.imagesDownloaded, 1);
    assert.ok(await readFile(path.join(rootDir, 'docs/wiki/1_示例.md'), 'utf8'));
    const unchanged = await syncWiki({ rootDir, client });
    assert.equal(unchanged.createdCount, 0);
    assert.equal(unchanged.updatedCount, 0);
    assert.equal(unchanged.imagesDownloaded, 0);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
