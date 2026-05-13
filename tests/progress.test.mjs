import test from 'node:test';
import assert from 'node:assert/strict';

import { createTerminalProgressReporter, formatProgressLine } from '../src/progress.mjs';

test('formatProgressLine renders a stage label and progress bar', () => {
  const line = formatProgressLine({
    stageIndex: 2,
    stageCount: 4,
    label: 'Fetching articles',
    current: 3,
    total: 10
  });

  assert.match(line, /^\[2\/4\] Fetching articles \[[#-]{20}\] 3\/10 \(30%\)$/);
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
    label: 'Fetching articles',
    current: 1,
    total: 4
  });
  reporter.update({
    phase: 'articles',
    label: 'Fetching articles',
    current: 4,
    total: 4,
    done: true
  });

  assert.match(output, /\r\[2\/4\] Fetching articles \[[#-]{20}\] 1\/4 \(25%\)/);
  assert.match(output, /\r\[2\/4\] Fetching articles \[[#-]{20}\] 4\/4 \(100%\)\n$/);
});
