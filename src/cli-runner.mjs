import {
  API_STAGE_LABELS,
  API_STAGE_ORDER,
  createTerminalProgressReporter,
  STAGE_LABELS,
  STAGE_ORDER
} from './progress.mjs';
import { syncApi } from './api-sync.mjs';
import { syncWiki } from './sync.mjs';

function writeLine(stream, line) {
  stream.write(`${line}\n`);
}

function formatSecondsTenths(tenths) {
  if (tenths % 10 === 0) {
    return String(tenths / 10);
  }

  return (tenths / 10).toFixed(1);
}

function formatDuration(durationMs) {
  const totalTenths = Math.max(0, Math.round(durationMs / 100));

  if (totalTenths < 600) {
    return `${formatSecondsTenths(totalTenths)}秒`;
  }

  const hours = Math.floor(totalTenths / 36000);
  const remainingTenths = totalTenths % 36000;
  const minutes = Math.floor(remainingTenths / 600);
  const secondsTenths = remainingTenths % 600;
  const parts = [];

  if (hours > 0) {
    parts.push(`${hours}小时`);
  }

  if (minutes > 0) {
    parts.push(`${minutes}分`);
  }

  if (secondsTenths > 0 || parts.length === 0) {
    parts.push(`${formatSecondsTenths(secondsTenths)}秒`);
  }

  return parts.join(' ');
}

function printUsage(stderr) {
  writeLine(stderr, '用法：node src/cli.mjs sync|sync-api|sync-all');
}

function printWikiSummary(stdout, result, heading = 'Wiki 同步完成。') {
  writeLine(
    stdout,
    [
      heading,
      `词条数：${result.totalArticles}`,
      `新增：${result.createdCount}`,
      `更新：${result.updatedCount}`,
      `删除：${result.deletedCount}`,
      `下载图片：${result.imagesDownloaded}`,
      `耗时：${formatDuration(result.durationMs)}`
    ].join(' ')
  );
}

function printApiSummary(stdout, result, heading = 'API 同步完成。') {
  writeLine(
    stdout,
    [
      heading,
      `实体数：${result.totalEntities}`,
      `新增：${result.createdCount}`,
      `更新：${result.updatedCount}`,
      `删除：${result.deletedCount}`,
      `耗时：${formatDuration(result.durationMs)}`
    ].join(' ')
  );
}

export async function runCli({
  argv = process.argv,
  stdout = process.stdout,
  stderr = process.stderr,
  syncWikiImpl = syncWiki,
  syncApiImpl = syncApi,
  createProgressReporterImpl = createTerminalProgressReporter
} = {}) {
  const command = argv[2];

  if (!['sync', 'sync-api', 'sync-all'].includes(command)) {
    printUsage(stderr);
    return 1;
  }

  try {
    if (command === 'sync') {
      const reporter = createProgressReporterImpl({
        stdout,
        stageOrder: STAGE_ORDER,
        stageLabels: STAGE_LABELS
      });
      const result = await syncWikiImpl({
        onProgress: reporter.update
      });
      reporter.end();
      printWikiSummary(stdout, result);
      return 0;
    }

    if (command === 'sync-api') {
      const reporter = createProgressReporterImpl({
        stdout,
        stageOrder: API_STAGE_ORDER,
        stageLabels: API_STAGE_LABELS
      });
      const result = await syncApiImpl({
        onProgress: reporter.update
      });
      reporter.end();
      printApiSummary(stdout, result);
      return 0;
    }

    const startedAt = Date.now();
    const wikiReporter = createProgressReporterImpl({
      stdout,
      stageOrder: STAGE_ORDER,
      stageLabels: STAGE_LABELS
    });
    const wikiResult = await syncWikiImpl({
      onProgress: wikiReporter.update
    });
    wikiReporter.end();
    printWikiSummary(stdout, wikiResult, 'Wiki 同步完成。');

    const apiReporter = createProgressReporterImpl({
      stdout,
      stageOrder: API_STAGE_ORDER,
      stageLabels: API_STAGE_LABELS
    });
    const apiResult = await syncApiImpl({
      onProgress: apiReporter.update
    });
    apiReporter.end();
    printApiSummary(stdout, apiResult);
    writeLine(stdout, `全部同步完成。 总耗时：${formatDuration(Date.now() - startedAt)}`);
    return 0;
  } catch (error) {
    writeLine(stderr, `同步失败：${error.message}`);
    return 1;
  }
}
