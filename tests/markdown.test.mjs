import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildArticleFileName,
  buildImageFileName,
  rewriteMarkdownContent,
  sanitizePathSegment
} from '../src/markdown.mjs';

test('sanitizePathSegment keeps readable text and replaces Windows-invalid characters', () => {
  assert.equal(sanitizePathSegment('  技能:Task?查询*手册.  '), '技能_Task_查询_手册');
  assert.equal(sanitizePathSegment('...'), '未命名');
});

test('buildArticleFileName prefixes article id', () => {
  assert.equal(buildArticleFileName('20094', '商业化系统'), '20094_商业化系统.md');
});

test('rewriteMarkdownContent converts official wiki links to relative local links', () => {
  const body = [
    '查看 [属性绑定](https://developer.gp.qq.com/wikieditor/?timeStamp=1725589224096#/catalog/20108)',
    '以及 [技能Task](https://developer.gp.qq.com/wikieditor/#/catalog/20186?autoJump=%E6%8A%80%E8%83%BDTask-%E9%80%89%E6%8B%A9%E7%9B%AE%E6%A0%87)'
  ].join('\n');

  const rewritten = rewriteMarkdownContent({
    body,
    outputPath: 'docs/wiki/进阶内容/20094_商业化系统.md',
    articlePathById: new Map([
      ['20108', 'docs/wiki/进阶内容/20108_属性绑定.md'],
      ['20186', 'docs/wiki/技能系统/20186_技能Task查询手册.md']
    ]),
    imagePathByUrl: new Map()
  });

  assert.match(rewritten.body, /\[属性绑定\]\(\.\/20108_属性绑定\.md\)/);
  assert.match(
    rewritten.body,
    /\[技能Task\]\(\.\.\/技能系统\/20186_技能Task查询手册\.md#技能Task-选择目标\)/
  );
});

test('rewriteMarkdownContent localizes markdown and html images while preserving discovered urls', () => {
  const body = [
    '![截图](https://example.com/assets/%E6%B5%8B%E8%AF%95.png)',
    '<img src="https://example.com/assets/demo.gif" alt="demo">'
  ].join('\n');

  const imagePathByUrl = new Map([
    ['https://example.com/assets/%E6%B5%8B%E8%AF%95.png', 'docs/wiki/_assets/images/abc12345_测试.png'],
    ['https://example.com/assets/demo.gif', 'docs/wiki/_assets/images/def67890_demo.gif']
  ]);

  const rewritten = rewriteMarkdownContent({
    body,
    outputPath: 'docs/wiki/新手入门/299_编辑器资源库.md',
    articlePathById: new Map(),
    imagePathByUrl
  });

  assert.deepEqual(rewritten.imageUrls, [
    'https://example.com/assets/%E6%B5%8B%E8%AF%95.png',
    'https://example.com/assets/demo.gif'
  ]);
  assert.match(rewritten.body, /!\[截图\]\(\.\.\/_assets\/images\/abc12345_测试\.png\)/);
  assert.match(rewritten.body, /<img src="\.\.\/_assets\/images\/def67890_demo\.gif" alt="demo">/);
});

test('rewriteMarkdownContent handles markdown image urls with spaces and parentheses', () => {
  const imageUrl = 'https://example.com/wiki/%E7%94%9F%E6%88%90%E9%81%93%E8%B7%AF%20(2).png';
  const imagePathByUrl = new Map([[imageUrl, 'docs/wiki/_assets/images/a1b2c3d4_生成道路 (2).png']]);

  const rewritten = rewriteMarkdownContent({
    body: `![道路](${imageUrl})`,
    outputPath: 'docs/wiki/分类/100_文章.md',
    articlePathById: new Map(),
    imagePathByUrl
  });

  assert.deepEqual(rewritten.imageUrls, [imageUrl]);
  assert.match(rewritten.body, /!\[道路\]\(\.\.\/_assets\/images\/a1b2c3d4_生成道路 \(2\)\.png\)/);
});

test('buildImageFileName keeps original extension and adds a stable hash prefix', () => {
  const fileName = buildImageFileName('https://example.com/path/%E4%BC%81%E4%B8%9A%E5%BE%AE%E4%BF%A1.png');
  assert.match(fileName, /^[a-f0-9]{8}_企业微信\.png$/);
});
