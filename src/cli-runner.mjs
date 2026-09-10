import {
  API_STAGE_LABELS,
  API_STAGE_ORDER,
  createCombinedProgressReporter,
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
  // 标题与统计分行，图片统计单列，避免联合结果成为两条超长行。
  writeLine(stdout, heading);
  writeLine(
    stdout,
    [
      `  词条数：${String(result.totalArticles).padEnd(4)}`,
      `新增：${result.createdCount}`,
      `更新：${result.updatedCount}`,
      `删除：${result.deletedCount}`,
      `耗时：${formatDuration(result.durationMs)}`
    ].join('  ')
  );
  writeLine(stdout, `  下载图片：${result.imagesDownloaded}`);
}

function printApiSummary(stdout, result, heading = 'API 同步完成。') {
  // 与 Wiki 使用相同统计列，便于纵向对照。
  writeLine(stdout, heading);
  writeLine(
    stdout,
    [
      `  实体数：${String(result.totalEntities).padEnd(4)}`,
      `新增：${result.createdCount}`,
      `更新：${result.updatedCount}`,
      `删除：${result.deletedCount}`,
      `耗时：${formatDuration(result.durationMs)}`
    ].join('  ')
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
    // Wiki 与 API 左右分栏，分别保留各阶段进度。
    const reporter = createCombinedProgressReporter({ stdout });
    // 输出目录与 manifest 独立；失败时也等待另一任务结束，再返回退出码。
    const results = await Promise.allSettled([
      Promise.resolve().then(() => syncWikiImpl({
        onProgress: (event) => reporter.update('wiki', event)
      })),
      Promise.resolve().then(() => syncApiImpl({
        onProgress: (event) => reporter.update('api', event)
      }))
    ]);
    reporter.end();
    writeLine(stdout, '');
    if (results[0].status === 'fulfilled') printWikiSummary(stdout, results[0].value);
    if (results[1].status === 'fulfilled') printApiSummary(stdout, results[1].value);
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) {
      throw new Error(failures.map((result) => result.reason?.message ?? String(result.reason)).join('；'));
    }
    writeLine(stdout, `全部同步完成。 总耗时：${formatDuration(Date.now() - startedAt)}`);
    return 0;
  } catch (error) {
    writeLine(stderr, `同步失败：${error.message}`);
    return 1;
  }
}
