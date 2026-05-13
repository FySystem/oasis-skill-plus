const BAR_WIDTH = 20;

export const STAGE_ORDER = ['category', 'articles', 'images', 'finalize'];
export const API_STAGE_ORDER = ['catalogs', 'details', 'finalize'];

export const STAGE_LABELS = {
  category: 'Loading category tree',
  articles: 'Fetching articles',
  images: 'Processing images',
  finalize: 'Writing local files'
};
export const API_STAGE_LABELS = {
  catalogs: 'Loading API catalogs',
  details: 'Fetching API details',
  finalize: 'Writing local files'
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

  return `[${stageIndex}/${stageCount}] ${label} [${bar}] ${current}/${safeTotal} (${percentage}%)`;
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
      const padded = text.padEnd(lastLineLength, ' ');
      stdout.write(`\r${padded}`);
      lastLineLength = padded.length;
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
    done = false
  }) {
    const stageIndex = getStageIndex(phase, stageOrder);
    const stageCount = stageOrder.length;
    const line = formatProgressLine({
      stageIndex,
      stageCount,
      label: label ?? stageLabels[phase] ?? 'Working',
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
