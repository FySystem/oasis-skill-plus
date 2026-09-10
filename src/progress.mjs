import { clearLine, cursorTo, moveCursor } from 'node:readline';

const BAR_WIDTH = 20;

// 当前进度文案只含中英文和全角标点，中文按终端的两列宽度计算。
function displayWidth(text) {
  return [...text].reduce((width, character) => width + (/[^\u0000-\u00ff]/u.test(character) ? 2 : 1), 0);
}

export const STAGE_ORDER = ['category', 'articles', 'images', 'finalize'];
export const API_STAGE_ORDER = ['catalogs', 'details', 'finalize'];

export const STAGE_LABELS = {
  category: '正在加载分类树',
  articles: '正在抓取词条',
  images: '正在处理图片',
  finalize: '正在写入本地文件'
};
export const API_STAGE_LABELS = {
  catalogs: '正在加载 API 目录',
  details: '正在抓取 API 详情',
  finalize: '正在写入本地文件'
};

export function getStageIndex(phase, stageOrder = STAGE_ORDER) {
  const index = stageOrder.indexOf(phase);
  return index === -1 ? 1 : index + 1;
}

export function formatProgressLine({
  stageIndex,
  stageCount,
  label,
  current,
  total
}) {
  const safeTotal = total <= 0 ? 0 : total;
  const ratio = safeTotal === 0 ? 1 : Math.min(1, Math.max(0, current / safeTotal));
  const percentage = Math.round(ratio * 100);
  const filledWidth = Math.round(ratio * BAR_WIDTH);
  const bar = `${'#'.repeat(filledWidth)}${'-'.repeat(BAR_WIDTH - filledWidth)}`;

  // 固定文案、计数和百分比列宽，避免阶段切换时进度条左右跳动。
  const paddedLabel = label + ' '.repeat(Math.max(0, 26 - displayWidth(label)));
  return `[${stageIndex}/${stageCount}] ${paddedLabel} [${bar}] ${String(current).padStart(4)}/${String(safeTotal).padStart(4)} (${String(percentage).padStart(3)}%)`;
}

export function createTerminalProgressReporter({
  stdout = process.stdout,
  stageOrder = STAGE_ORDER,
  stageLabels = STAGE_LABELS
} = {}) {
  let lastLineLength = 0;
  let hasActiveLine = false;

  function writeLine(text) {
    if (stdout.isTTY) {
      // 按显示列清除上一行；字符串长度无法正确覆盖中英文混排行。
      const padded = text + ' '.repeat(Math.max(0, lastLineLength - displayWidth(text)));
      stdout.write(`\r${padded}`);
      lastLineLength = displayWidth(padded);
      hasActiveLine = true;
      return;
    }

    stdout.write(`${text}\n`);
  }

  function update({
    phase,
    label,
    current = 0,
    total = 0,
    done = false,
    // 联合同步共享显示状态，但各任务仍使用自己的阶段数量。
    stageOrder: eventStageOrder = stageOrder
  }) {
    const stageIndex = getStageIndex(phase, eventStageOrder);
    const stageCount = eventStageOrder.length;
    const line = formatProgressLine({
      stageIndex,
      stageCount,
      label: label ?? stageLabels[phase] ?? '处理中',
      current,
      total
    });

    writeLine(line);

    if (done && stdout.isTTY) {
      stdout.write('\n');
      hasActiveLine = false;
      lastLineLength = 0;
    }
  }

  function end() {
    if (stdout.isTTY && hasActiveLine) {
      stdout.write('\n');
      hasActiveLine = false;
      lastLineLength = 0;
    }
  }

  return {
    update,
    end
  };
}

export function createCombinedProgressReporter({ stdout = process.stdout } = {}) {
  // 左侧 Wiki、右侧 API，各阶段独立保留，后续阶段不会覆盖已完成记录。
  const events = { wiki: new Map(), api: new Map() };
  let drawnRows = 0;
  let lastRenderAt = 0;

  function render() {
    const cellWidth = Math.max(1, Math.floor(((stdout.columns ?? 80) - 4) / 2));
    // 每格按中文显示宽度裁切、补齐，给分隔符和终端最后一列留出空间。
    function cell(text) {
      let visible = '';
      let width = 0;
      for (const character of text) {
        if (width + displayWidth(character) > cellWidth) break;
        width += displayWidth(character);
        visible += character;
      }
      return visible + ' '.repeat(cellWidth - width);
    }
    const columns = ['wiki', 'api'].map((task) => {
      const stageOrder = task === 'wiki' ? STAGE_ORDER : API_STAGE_ORDER;
      const labels = task === 'wiki' ? STAGE_LABELS : API_STAGE_LABELS;
      const rows = [task === 'wiki' ? 'Wiki' : 'API', '-'.repeat(cellWidth)];
      for (const [index, phase] of stageOrder.entries()) {
        const event = events[task].get(phase);
        // 仅显示已经开始的阶段，完成后收到下一阶段事件才扩展该列。
        if (!event) continue;
        rows.push(`[${index + 1}/${stageOrder.length}] ${event.label ?? labels[phase]}`);
        const current = event.current ?? 0;
        const total = Math.max(0, event.total ?? 0);
        const ratio = total === 0 ? 1 : Math.min(1, Math.max(0, current / total));
        const filled = Math.round(ratio * 10);
        const bar = cellWidth >= 32 ? `[${'#'.repeat(filled)}${'-'.repeat(10 - filled)}] ` : '';
        rows.push(`${bar}${current}/${total} (${Math.round(ratio * 100)}%)`);
      }
      return rows;
    });
    const rowCount = Math.max(columns[0].length, columns[1].length);
    if (stdout.isTTY && drawnRows) moveCursor(stdout, 0, -drawnRows);
    for (let index = 0; index < rowCount; index += 1) {
      if (stdout.isTTY) {
        cursorTo(stdout, 0);
        clearLine(stdout, 0);
      }
      stdout.write(`${cell(columns[0][index] ?? '')} | ${cell(columns[1][index] ?? '')}\n`);
    }
    drawnRows = rowCount;
    lastRenderAt = Date.now();
  }

  function update(task, event) {
    const newStage = !events[task].has(event.phase);
    events[task].set(event.phase, event);
    // 限制刷新频率，避免数千条下载事件反复重绘整张表影响同步速度。
    if (stdout.isTTY && (!drawnRows || newStage || event.done || Date.now() - lastRenderAt >= 50)) render();
  }

  function end() {
    // 最后刷新未显示的计数；重定向文件也保留完整左右分栏且不带控制字符。
    render();
  }

  return { update, end };
}
