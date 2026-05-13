import test from 'node:test';
import assert from 'node:assert/strict';

import {
  API_STAGE_LABELS,
  createTerminalProgressReporter,
  formatProgressLine,
  STAGE_LABELS
} from '../src/progress.mjs';

test('default stage labels are localized', () => {
  assert.equal(STAGE_LABELS.category, '正在加载分类树');
  assert.equal(STAGE_LABELS.articles, '正在抓取词条');
  assert.equal(STAGE_LABELS.images, '正在处理图片');
  assert.equal(STAGE_LABELS.finalize, '正在写入本地文件');
  assert.equal(API_STAGE_LABELS.catalogs, '正在加载 API 目录');
  assert.equal(API_STAGE_LABELS.details, '正在抓取 API 详情');
  assert.equal(API_STAGE_LABELS.finalize, '正在写入本地文件');
});

test('formatProgressLine renders a stage label and progress bar', () => {
  const line = formatProgressLine({
    stageIndex: 2,
    stageCount: 4,
    label: '正在抓取词条',
    current: 3,
    total: 10
  });

  assert.match(line, /^\[2\/4\] 正在抓取词条 \[[#-]{20}\] 3\/10 \(30%\)$/);
});

test('createTerminalProgressReporter writes carriage-return progress and terminates with newline', () => {
  let output = '';
  const reporter = createTerminalProgressReporter({
    stdout: {
      isTTY: true,
      write(chunk) {
        output += chunk;
      }
    }
  });

  reporter.update({
    phase: 'articles',
    current: 1,
    total: 4
  });
  reporter.update({
    phase: 'articles',
    current: 4,
    total: 4,
    done: true
  });

  assert.match(output, /\r\[2\/4\] 正在抓取词条 \[[#-]{20}\] 1\/4 \(25%\)/);
  assert.match(output, /\r\[2\/4\] 正在抓取词条 \[[#-]{20}\] 4\/4 \(100%\)\n$/);
});
