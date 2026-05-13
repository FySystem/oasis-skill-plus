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

function printUsage(stderr) {
  writeLine(stderr, 'Usage: node src/cli.mjs sync|sync-api|sync-all');
}

function printWikiSummary(stdout, result, heading = 'Sync completed.') {
  writeLine(
    stdout,
    [
      heading,
      `Articles: ${result.totalArticles}`,
      `Created: ${result.createdCount}`,
      `Updated: ${result.updatedCount}`,
      `Deleted: ${result.deletedCount}`,
      `Images downloaded: ${result.imagesDownloaded}`,
      `Duration: ${result.durationMs}ms`
    ].join(' ')
  );
}

function printApiSummary(stdout, result, heading = 'API sync completed.') {
  writeLine(
    stdout,
    [
      heading,
      `Entities: ${result.totalEntities}`,
      `Created: ${result.createdCount}`,
      `Updated: ${result.updatedCount}`,
      `Deleted: ${result.deletedCount}`,
      `Duration: ${result.durationMs}ms`
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
    printWikiSummary(stdout, wikiResult, 'Wiki sync completed.');

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
    writeLine(stdout, `Sync-all completed. Total duration: ${Date.now() - startedAt}ms`);
    return 0;
  } catch (error) {
    writeLine(stderr, `Sync failed: ${error.message}`);
    return 1;
  }
}
