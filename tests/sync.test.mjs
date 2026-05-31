import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';

import { loadManifest } from '../src/manifest.mjs';
import { syncWiki } from '../src/sync.mjs';

function createClientFixture({ tree, articles, images, failImageUrl }) {
  return {
    async fetchCategoryTree() {
      return {
        tree,
        version: 33,
        updateTime: 1778655807
      };
    },
    async fetchArticle(id) {
      const article = articles[id];
      if (!article) {
        throw new Error(`missing article fixture: ${id}`);
      }

      return {
        id,
        title: article.title,
        body: article.body,
        updateTime: article.updateTime
      };
    },
    async downloadImage(url) {
      if (url === failImageUrl) {
        throw new Error(`failed to download ${url}`);
      }

      const body = images[url];
      if (!body) {
        throw new Error(`missing image fixture: ${url}`);
      }

      return {
        buffer: Buffer.from(body, 'utf8'),
        contentType: 'image/png'
      };
    }
  };
}

test('syncWiki writes docs, index, images, and manifest from fixtures', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-sync-'));

  const tree = [
    {
      label: '新手入门',
      type: 0,
      id: 10,
      children: [
        { id: 299, label: '编辑器资源库', type: 1 }
      ]
    },
    {
      label: '进阶内容',
      type: 0,
      id: 20,
      children: [
        { id: 20108, label: '属性绑定', type: 1 }
      ]
    }
  ];

  const client = createClientFixture({
    tree,
    articles: {
      '299': {
        title: '编辑器资源库',
        updateTime: 100,
        body: [
          '# 编辑器资源库',
          '',
          '见 [属性绑定](https://developer.gp.qq.com/wikieditor/#/catalog/20108)',
          '',
          '![图片](https://example.com/assets/resource.png)'
        ].join('\n')
      },
      '20108': {
        title: '属性绑定',
        updateTime: 200,
        body: '# 属性绑定'
      }
    },
    images: {
      'https://example.com/assets/resource.png': 'png-binary'
    }
  });

  try {
    const result = await syncWiki({ rootDir, client });
    const docFile = path.join(rootDir, 'docs', 'wiki', '新手入门', '299_编辑器资源库.md');
    const indexFile = path.join(rootDir, 'docs', 'wiki', '000_索引.md');
    const articleIndexFile = path.join(rootDir, 'docs', 'wiki', 'article-index.tsv');
    const manifestFile = path.join(rootDir, '.oasis-sync', 'manifest.json');

    assert.equal(result.totalArticles, 2);
    assert.equal(result.createdCount, 2);
    assert.equal(result.updatedCount, 0);
    assert.equal(result.deletedCount, 0);
    assert.equal(result.imagesDownloaded, 1);

    const docText = await readFile(docFile, 'utf8');
    const indexText = await readFile(indexFile, 'utf8');
    const articleIndexText = await readFile(articleIndexFile, 'utf8');
    const manifest = await loadManifest(manifestFile);

    assert.match(docText, /\[属性绑定\]\(\.\.\/进阶内容\/20108_属性绑定\.md\)/);
    assert.match(docText, /!\[图片\]\(\.\.\/_assets\/images\/[a-f0-9]{8}_resource\.png\)/);
    assert.match(indexText, /\[编辑器资源库\]\(\.\/新手入门\/299_编辑器资源库\.md\)/);
    assert.equal(articleIndexText.split('\n')[0], 'id\ttitle\twiki_path\turl\tfile');
    assert.match(
      articleIndexText,
      /299\t编辑器资源库\t新手入门\thttps:\/\/developer\.gp\.qq\.com\/wikieditor\/#\/catalog\/299\tdocs\/wiki\/新手入门\/299_编辑器资源库\.md/
    );
    assert.match(
      articleIndexText,
      /20108\t属性绑定\t进阶内容\thttps:\/\/developer\.gp\.qq\.com\/wikieditor\/#\/catalog\/20108\tdocs\/wiki\/进阶内容\/20108_属性绑定\.md/
    );
    assert.equal(manifest.articles.length, 2);
    assert.equal(Object.keys(manifest.images).length, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('syncWiki is stable on a second run with identical fixtures', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-sync-repeat-'));
  const tree = [
    {
      label: '分类',
      type: 0,
      id: 1,
      children: [{ id: 100, label: '文章A', type: 1 }]
    }
  ];

  const client = createClientFixture({
    tree,
    articles: {
      '100': {
        title: '文章A',
        updateTime: 1,
        body: '# 文章A'
      }
    },
    images: {}
  });

  try {
    await syncWiki({ rootDir, client });
    const firstPath = path.join(rootDir, 'docs', 'wiki', '分类', '100_文章A.md');
    const firstStat = await stat(firstPath);

    const result = await syncWiki({ rootDir, client });
    const secondStat = await stat(firstPath);

    assert.equal(result.createdCount, 0);
    assert.equal(result.updatedCount, 0);
    assert.equal(result.deletedCount, 0);
    assert.equal(result.imagesDownloaded, 0);
    assert.equal(secondStat.mtimeMs, firstStat.mtimeMs);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('syncWiki handles rename, move, and delete on later syncs', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-sync-move-'));
  const firstClient = createClientFixture({
    tree: [
      {
        label: '分类A',
        type: 0,
        id: 1,
        children: [
          { id: 100, label: '旧文章', type: 1 },
          { id: 200, label: '会被删除', type: 1 }
        ]
      }
    ],
    articles: {
      '100': { title: '旧文章', updateTime: 1, body: '# 旧文章' },
      '200': { title: '会被删除', updateTime: 1, body: '# 会被删除' }
    },
    images: {}
  });

  const secondClient = createClientFixture({
    tree: [
      {
        label: '分类B',
        type: 0,
        id: 2,
        children: [{ id: 100, label: '新文章', type: 1 }]
      }
    ],
    articles: {
      '100': { title: '新文章', updateTime: 2, body: '# 新文章' }
    },
    images: {}
  });

  try {
    await syncWiki({ rootDir, client: firstClient });
    const oldFile = path.join(rootDir, 'docs', 'wiki', '分类A', '100_旧文章.md');
    const deletedFile = path.join(rootDir, 'docs', 'wiki', '分类A', '200_会被删除.md');
    const newFile = path.join(rootDir, 'docs', 'wiki', '分类B', '100_新文章.md');

    const result = await syncWiki({ rootDir, client: secondClient });

    await assert.rejects(() => stat(oldFile));
    await assert.rejects(() => stat(deletedFile));
    await stat(newFile);
    assert.equal(result.updatedCount, 1);
    assert.equal(result.deletedCount, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('syncWiki does not delete existing docs when a new image download fails', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-sync-fail-'));
  const firstClient = createClientFixture({
    tree: [
      {
        label: '分类',
        type: 0,
        id: 1,
        children: [{ id: 100, label: '文章', type: 1 }]
      }
    ],
    articles: {
      '100': {
        title: '文章',
        updateTime: 1,
        body: '# 文章'
      }
    },
    images: {}
  });

  const failingClient = createClientFixture({
    tree: [
      {
        label: '分类',
        type: 0,
        id: 1,
        children: [{ id: 100, label: '文章', type: 1 }]
      }
    ],
    articles: {
      '100': {
        title: '文章',
        updateTime: 2,
        body: '![图片](https://example.com/fail.png)'
      }
    },
    images: {},
    failImageUrl: 'https://example.com/fail.png'
  });

  try {
    await syncWiki({ rootDir, client: firstClient });
    const stableFile = path.join(rootDir, 'docs', 'wiki', '分类', '100_文章.md');

    await assert.rejects(() => syncWiki({ rootDir, client: failingClient }), /failed to download/);
    const fileText = await readFile(stableFile, 'utf8');

    assert.match(fileText, /# 文章/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('syncWiki emits progress updates for category, articles, images, and finalize stages', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-sync-progress-'));
  const progressEvents = [];
  const client = createClientFixture({
    tree: [
      {
        label: 'Category',
        type: 0,
        id: 1,
        children: [
          { id: 100, label: 'Article A', type: 1 },
          { id: 200, label: 'Article B', type: 1 }
        ]
      }
    ],
    articles: {
      '100': {
        title: 'Article A',
        updateTime: 1,
        body: '![Image](https://example.com/assets/a.png)'
      },
      '200': {
        title: 'Article B',
        updateTime: 1,
        body: '# Article B'
      }
    },
    images: {
      'https://example.com/assets/a.png': 'binary-a'
    }
  });

  try {
    await syncWiki({
      rootDir,
      client,
      onProgress(event) {
        progressEvents.push(event);
      }
    });

    const categoryEvents = progressEvents.filter((event) => event.phase === 'category');
    const articleEvents = progressEvents.filter((event) => event.phase === 'articles');
    const imageEvents = progressEvents.filter((event) => event.phase === 'images');
    const finalizeEvents = progressEvents.filter((event) => event.phase === 'finalize');

    assert.ok(categoryEvents.length > 0);
    assert.ok(articleEvents.length > 0);
    assert.ok(imageEvents.length > 0);
    assert.ok(finalizeEvents.length > 0);
    assert.equal(articleEvents.at(-1).current, 2);
    assert.equal(articleEvents.at(-1).total, 2);
    assert.equal(imageEvents.at(-1).current, 1);
    assert.equal(imageEvents.at(-1).total, 1);
    assert.equal(finalizeEvents.at(-1).done, true);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
