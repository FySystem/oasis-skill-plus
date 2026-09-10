import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';

import {
  API_STAGE_LABELS,
  createCombinedProgressReporter,
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

  assert.match(line, /^\[2\/4\] 正在抓取词条 +\[[#-]{20}\] +3\/ +10 \( 30%\)$/);
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

  assert.match(output, /\r\[2\/4\] 正在抓取词条 +\[[#-]{20}\] +1\/ +4 \( 25%\)/);
  assert.match(output, /\r\[2\/4\] 正在抓取词条 +\[[#-]{20}\] +4\/ +4 \(100%\)\n$/);
});

test('联合进度左右分栏，切换阶段后仍保留已完成记录', () => {
  // 完成事件触发刷新，只显示收到事件的阶段，并保留已完成计数。
  let output = '';
  const reporter = createCombinedProgressReporter({ stdout: {
    isTTY: true, columns: 80, write(chunk) { output += chunk; }
  } });
  reporter.update('wiki', { phase: 'articles', current: 321, total: 321, done: true });
  reporter.update('api', { phase: 'details', current: 10, total: 6196, done: true });
  reporter.update('wiki', { phase: 'images', current: 1, total: 3428, done: true });
  reporter.update('api', { phase: 'details', current: 20, total: 6196 });
  reporter.end();
  const frames = output.split(/\x1b\[\d+A/).map((frame) => stripVTControlCharacters(frame).trimEnd().split('\n'));
  assert.ok(frames.length >= 4);
  for (const frame of frames) {
    assert.ok([4, 6].includes(frame.length));
    assert.match(frame[0], /^Wiki +\| API/);
    assert.doesNotMatch(frame.join('\n'), /等待开始|正在加载|正在写入/);
  }
  const last = frames.at(-1);
  assert.equal(frames[0].length, 4);
  assert.equal(last.length, 6);
  assert.match(last[2], /^\[2\/4\].*\| \[2\/3\]/);
  assert.match(last[3], /321\/321 \(100%\).*\| .*20\/6196/);
  assert.match(last[4], /正在处理图片/);
  assert.match(last[5], /1\/3428/);
});

test('联合进度在窄窗口不折行，重定向按任务分组且无控制字符', () => {
  // 窄窗口每行留出最后一列，防止终端自动换行。
  let output = '';
  const reporter = createCombinedProgressReporter({ stdout: {
    isTTY: true, columns: 24, write(chunk) { output += chunk; }
  } });
  reporter.update('wiki', { phase: 'finalize', current: 324, total: 324 });
  for (const line of stripVTControlCharacters(output).trim().split('\n')) {
    assert.ok([...line].reduce((width, character) => width + (character.charCodeAt(0) > 255 ? 2 : 1), 0) < 24);
  }
  output = '';
  const redirected = createCombinedProgressReporter({ stdout: { write(chunk) { output += chunk; } } });
  redirected.update('api', { phase: 'details', current: 1, total: 2 });
  redirected.update('wiki', { phase: 'articles', current: 2, total: 2 });
  assert.equal(output, '');
  redirected.end();
  assert.equal(output, stripVTControlCharacters(output));
  assert.match(output.split('\n')[0], /^Wiki +\| API/);
  assert.match(output.split('\n')[3], /2\/2.*\| .*1\/2/);
});

test('中英文阶段的进度条与数字列按终端显示宽度对齐', () => {
  // 覆盖任务名前缀和最长阶段文案，避免仅检查字符串长度漏掉中文宽度。
  const lines = ['Wiki：正在加载分类树', 'API ：正在加载 API 目录', 'Wiki：正在写入本地文件'].map((label, index) =>
    formatProgressLine({ stageIndex: 1, stageCount: 4, label, current: index ? 6196 : 1, total: index ? 6196 : 1 }));
  for (const line of lines) {
    const prefix = line.slice(0, line.indexOf('[#'));
    assert.equal([...prefix].reduce((width, character) => width + (character.charCodeAt(0) > 255 ? 2 : 1), 0), 33);
    assert.match(line, /\] .{4}\/.{4} \(100%\)$/);
  }
});
