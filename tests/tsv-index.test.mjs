import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildApiSymbolIndexRows,
  buildWikiArticleIndexRows,
  parseTsv,
  renderTsv
} from '../src/tsv-index.mjs';

test('renderTsv escapes tabs and newlines without losing readable text', () => {
  const text = renderTsv(
    ['kind', 'name', 'description'],
    [
      {
        kind: 'class',
        name: 'AActor',
        description: 'line one\nline two\twith tab'
      }
    ]
  );

  assert.equal(
    text,
    'kind\tname\tdescription\nclass\tAActor\tline one line two with tab\n'
  );
});

test('parseTsv returns row objects keyed by header names', () => {
  const rows = parseTsv('kind\tname\tfile\n\nclass\tAActor\tdocs/api/class/Others/AActor.md\n\n');

  assert.deepEqual(rows, [
    {
      kind: 'class',
      name: 'AActor',
      file: 'docs/api/class/Others/AActor.md'
    }
  ]);
});

test('buildWikiArticleIndexRows records article metadata and source URL', () => {
  const rows = buildWikiArticleIndexRows([
    {
      id: '203',
      title: '网络同步系统介绍',
      treePath: ['进阶内容', '脚本逻辑'],
      outputPath: 'docs/wiki/进阶内容/脚本逻辑/203_网络同步系统介绍.md'
    }
  ]);

  assert.deepEqual(rows, [
    {
      id: '203',
      title: '网络同步系统介绍',
      wiki_path: '进阶内容 / 脚本逻辑',
      url: 'https://developer.gp.qq.com/wikieditor/#/catalog/203',
      file: 'docs/wiki/进阶内容/脚本逻辑/203_网络同步系统介绍.md'
    }
  ]);
});

test('buildApiSymbolIndexRows records symbol metadata and source URL', () => {
  const rows = buildApiSymbolIndexRows([
    {
      family: 'class',
      name: 'AActor',
      sourcePath: 'class/detail/Others/AActor.json',
      outputPath: 'docs/api/class/Others/AActor.md',
      bucketPath: ['Others'],
      description: 'Actor base class'
    }
  ]);

  assert.deepEqual(rows, [
    {
      kind: 'class',
      name: 'AActor',
      symbol_path: 'Others / AActor',
      source_json_path: 'class/detail/Others/AActor.json',
      source_json_url: 'https://developer.gp.qq.com/api/class/detail/Others/AActor.json',
      markdown_file: 'docs/api/class/Others/AActor.md',
      description: 'Actor base class'
    }
  ]);
});
