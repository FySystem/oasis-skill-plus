import test from 'node:test';
import assert from 'node:assert/strict';

import { diffManifest, hashContent } from '../src/manifest.mjs';

test('hashContent is stable for identical content', () => {
  assert.equal(hashContent('hello'), hashContent('hello'));
  assert.notEqual(hashContent('hello'), hashContent('world'));
});

test('diffManifest detects created, updated, and deleted articles', () => {
  const previous = {
    articles: [
      {
        id: '1',
        title: '旧文章',
        treePath: ['分类A'],
        outputPath: 'docs/wiki/分类A/1_旧文章.md',
        updateTime: 1,
        contentHash: 'hash-old',
        imageUrls: []
      },
      {
        id: '2',
        title: '会被删除',
        treePath: ['分类B'],
        outputPath: 'docs/wiki/分类B/2_会被删除.md',
        updateTime: 1,
        contentHash: 'hash-delete',
        imageUrls: []
      }
    ]
  };

  const next = {
    articles: [
      {
        id: '1',
        title: '旧文章',
        treePath: ['分类A'],
        outputPath: 'docs/wiki/分类A/1_旧文章.md',
        updateTime: 2,
        contentHash: 'hash-new',
        imageUrls: []
      },
      {
        id: '3',
        title: '新文章',
        treePath: ['分类C'],
        outputPath: 'docs/wiki/分类C/3_新文章.md',
        updateTime: 1,
        contentHash: 'hash-create',
        imageUrls: []
      }
    ]
  };

  const diff = diffManifest(previous, next);

  assert.deepEqual(diff.created.map((item) => item.id), ['3']);
  assert.deepEqual(diff.updated.map((item) => item.id), ['1']);
  assert.deepEqual(diff.deleted.map((item) => item.id), ['2']);
});
