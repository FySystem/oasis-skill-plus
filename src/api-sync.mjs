import path from 'node:path';
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises';

import { hashContent, SCHEMA_VERSION } from './manifest.mjs';
import {
  normalizeMarkdown,
  relativeMarkdownPath,
  sanitizePathSegment
} from './markdown.mjs';
import {
  API_STAGE_LABELS
} from './progress.mjs';
import { createApiClient } from './api-client.mjs';
import { renderApiMarkdown } from './api-markdown.mjs';
import {
  buildApiSymbolIndexRows,
  renderTsv
} from './tsv-index.mjs';

const API_OUTPUT_ROOT = 'docs/api';
const API_MANIFEST_PATH = '.oasis-sync/api-manifest.json';
const API_FAMILIES = ['class', 'cppenum', 'cppstruct', 'globalfunc'];
const API_SYMBOL_INDEX_PATH = 'docs/api/symbol-index.tsv';
const API_SYMBOL_INDEX_HEADERS = [
  'kind',
  'name',
  'symbol_path',
  'source_json_path',
  'source_json_url',
  'markdown_file',
  'description'
];

function toPosixPath(...segments) {
  return path.posix.join(...segments);
}

function toAbsolutePath(rootDir, relativePath) {
  return path.resolve(rootDir, ...relativePath.split('/'));
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function emitProgress(onProgress, event) {
  if (typeof onProgress === 'function') {
    onProgress(event);
  }
}

export function createEmptyApiManifest() {
  return {
    schemaVersion: SCHEMA_VERSION,
    lastSyncedAt: null,
    families: {},
    entities: []
  };
}

export async function loadApiManifest(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...createEmptyApiManifest(),
      ...parsed,
      families: parsed.families ?? {},
      entities: parsed.entities ?? []
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return createEmptyApiManifest();
    }

    throw error;
  }
}

async function saveApiManifest(filePath, manifest) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function apiRecordsEquivalent(previousRecord, nextRecord) {
  return (
    previousRecord.family === nextRecord.family &&
    previousRecord.name === nextRecord.name &&
    previousRecord.outputPath === nextRecord.outputPath &&
    previousRecord.contentHash === nextRecord.contentHash
  );
}

export function diffApiManifest(previousManifest, nextManifest) {
  const previousRecords = new Map(
    (previousManifest.entities ?? []).map((entity) => [String(entity.sourcePath), entity])
  );
  const nextRecords = new Map(
    (nextManifest.entities ?? []).map((entity) => [String(entity.sourcePath), entity])
  );

  const created = [];
  const updated = [];
  const deleted = [];

  for (const [sourcePath, nextRecord] of nextRecords.entries()) {
    const previousRecord = previousRecords.get(sourcePath);
    if (!previousRecord) {
      created.push(nextRecord);
      continue;
    }

    if (!apiRecordsEquivalent(previousRecord, nextRecord)) {
      updated.push(nextRecord);
    }
  }

  for (const [sourcePath, previousRecord] of previousRecords.entries()) {
    if (!nextRecords.has(sourcePath)) {
      deleted.push(previousRecord);
    }
  }

  return { created, updated, deleted };
}

export function normalizeApiSourcePath(family, sourcePath) {
  const normalized = String(sourcePath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');

  if (normalized.startsWith(`${family}/detail/`)) {
    return normalized;
  }

  if (family === 'class' && normalized.startsWith('detail/class/')) {
    return `class/detail/${normalized.slice('detail/class/'.length)}`;
  }

  return normalized;
}

export function buildApiOutputPath({ family, sourcePath, bucketPath }) {
  if (family === 'class') {
    const relativeSource = normalizeApiSourcePath(family, sourcePath).slice('class/detail/'.length);
    const pathWithoutExtension = relativeSource.replace(/\.json$/i, '');
    const segments = pathWithoutExtension.split('/').map((segment) => sanitizePathSegment(segment));
    return toPosixPath(API_OUTPUT_ROOT, family, ...segments.slice(0, -1), `${segments.at(-1)}.md`);
  }

  const fileName = sanitizePathSegment(path.posix.basename(sourcePath, '.json'));
  return toPosixPath(
    API_OUTPUT_ROOT,
    family,
    ...bucketPath.map((segment) => sanitizePathSegment(segment)),
    `${fileName}.md`
  );
}

function flattenClassCatalog(nodes, ancestry = []) {
  const records = [];
  const indexNodes = [];

  for (const node of nodes ?? []) {
    if (node.Type === 'class') {
      const sourcePath = normalizeApiSourcePath('class', node.Path);
      const record = {
        family: 'class',
        name: node.Name,
        sourcePath,
        outputPath: buildApiOutputPath({
          family: 'class',
          sourcePath,
          bucketPath: []
        }),
        bucketPath: ancestry
      };
      records.push(record);
      indexNodes.push({
        kind: 'entity',
        label: node.Label ?? node.Name,
        outputPath: record.outputPath
      });
      continue;
    }

    const nextAncestry = [...ancestry, node.Label ?? node.Name];
    const flattened = flattenClassCatalog(node.Children ?? [], nextAncestry);
    records.push(...flattened.records);
    indexNodes.push({
      kind: 'directory',
      label: node.Label ?? node.Name,
      children: flattened.indexNodes
    });
  }

  return { records, indexNodes };
}

function flattenSortedCatalog(family, tree, bucketPath = []) {
  const records = [];
  const indexNodes = [];

  for (const [key, value] of Object.entries(tree ?? {})) {
    if (typeof value === 'string') {
      const sourcePath = normalizeApiSourcePath(family, value);
      const record = {
        family,
        name: key,
        sourcePath,
        outputPath: buildApiOutputPath({
          family,
          sourcePath,
          bucketPath
        }),
        bucketPath
      };
      records.push(record);
      indexNodes.push({
        kind: 'entity',
        label: key,
        outputPath: record.outputPath
      });
      continue;
    }

    const flattened = flattenSortedCatalog(family, value, [...bucketPath, key]);
    records.push(...flattened.records);
    indexNodes.push({
      kind: 'directory',
      label: key,
      children: flattened.indexNodes
    });
  }

  return { records, indexNodes };
}

function buildTreeIndexMarkdown({ title, indexPath, nodes }) {
  const lines = [`# ${title}`, ''];

  function visit(currentNodes, depth) {
    for (const node of currentNodes) {
      if (node.kind === 'entity') {
        lines.push(`- [${node.label}](${relativeMarkdownPath(indexPath, node.outputPath)})`);
        continue;
      }

      lines.push(`${'#'.repeat(Math.min(depth, 6))} ${node.label}`);
      lines.push('');
      visit(node.children ?? [], depth + 1);
    }
  }

  visit(nodes, 2);
  lines.push('');
  return lines.join('\n');
}

function buildRootApiIndexMarkdown(familySummaries) {
  const lines = ['# 绿洲开发者 API 索引', ''];
  for (const family of API_FAMILIES) {
    const summary = familySummaries[family] ?? { count: 0 };
    lines.push(`## ${family}`);
    lines.push('');
    lines.push(`- [${family} 索引](./${family}/000_索引.md)`);
    lines.push(`- Entities: ${summary.count}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function writeTextFileIfChanged(filePath, content) {
  if (await fileExists(filePath)) {
    const current = await readFile(filePath, 'utf8');
    if (current === content) {
      return false;
    }
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return true;
}

async function safeRemove(rootDir, relativePath) {
  const absoluteRoot = path.resolve(rootDir);
  const absoluteTarget = toAbsolutePath(rootDir, relativePath);
  const safeRootPrefix = `${absoluteRoot}${path.sep}`;

  if (absoluteTarget !== absoluteRoot && !absoluteTarget.startsWith(safeRootPrefix)) {
    throw new Error(`Refusing to remove path outside the workspace: ${absoluteTarget}`);
  }

  await rm(absoluteTarget, { recursive: true, force: true });
}

async function pruneEmptyDirectories(directoryPath, stopAt) {
  const resolvedDirectory = path.resolve(directoryPath);
  const resolvedStopAt = path.resolve(stopAt);

  if (resolvedDirectory === resolvedStopAt) {
    return;
  }

  const entries = await readdir(resolvedDirectory, { withFileTypes: true });
  if (entries.length > 0) {
    return;
  }

  await rm(resolvedDirectory, { recursive: true, force: true });
  await pruneEmptyDirectories(path.dirname(resolvedDirectory), resolvedStopAt);
}

export async function syncApi({
  rootDir = process.cwd(),
  client = createApiClient(),
  detailConcurrency = 12,
  clock = () => new Date().toISOString(),
  onProgress
} = {}) {
  const startedAt = Date.now();
  const manifestPath = toAbsolutePath(rootDir, API_MANIFEST_PATH);
  const previousManifest = await loadApiManifest(manifestPath);

  const familySummaries = {};
  const familyIndexNodes = {};
  const catalogTotal = API_FAMILIES.length;
  let catalogProgress = 0;

  emitProgress(onProgress, {
    phase: 'catalogs',
    label: API_STAGE_LABELS.catalogs,
    current: 0,
    total: catalogTotal
  });

  const classCatalog = await client.fetchClassCatalog();
  const flattenedClass = flattenClassCatalog(classCatalog);
  familyIndexNodes.class = flattenedClass.indexNodes;
  familySummaries.class = { count: flattenedClass.records.length };
  catalogProgress += 1;
  emitProgress(onProgress, {
    phase: 'catalogs',
    label: API_STAGE_LABELS.catalogs,
    current: catalogProgress,
    total: catalogTotal
  });

  const flattenedFamilies = { class: flattenedClass };
  for (const family of API_FAMILIES.filter((item) => item !== 'class')) {
    const sortedCatalog = await client.fetchSortedCatalog(family);
    const flattened = flattenSortedCatalog(family, sortedCatalog);
    flattenedFamilies[family] = flattened;
    familyIndexNodes[family] = flattened.indexNodes;
    familySummaries[family] = { count: flattened.records.length };
    catalogProgress += 1;
    emitProgress(onProgress, {
      phase: 'catalogs',
      label: API_STAGE_LABELS.catalogs,
      current: catalogProgress,
      total: catalogTotal,
      done: catalogProgress === catalogTotal
    });
  }

  const allRecords = API_FAMILIES.flatMap((family) => flattenedFamilies[family].records);
  const outputPathBySourcePath = new Map(allRecords.map((record) => [record.sourcePath, record.outputPath]));
  const nameCounts = new Map();
  for (const record of allRecords) {
    nameCounts.set(record.name, (nameCounts.get(record.name) ?? 0) + 1);
  }
  const uniqueOutputPathByName = new Map(
    allRecords
      .filter((record) => nameCounts.get(record.name) === 1)
      .map((record) => [record.name, record.outputPath])
  );

  let detailProgress = 0;
  emitProgress(onProgress, {
    phase: 'details',
    label: API_STAGE_LABELS.details,
    current: 0,
    total: allRecords.length
  });
  if (allRecords.length === 0) {
    emitProgress(onProgress, {
      phase: 'details',
      label: API_STAGE_LABELS.details,
      current: 0,
      total: 0,
      done: true
    });
  }

  const renderedEntities = await mapLimit(allRecords, detailConcurrency, async (record) => {
    const detail = await client.fetchDetail(record.family, record.sourcePath);
    const body = renderApiMarkdown({
      family: record.family,
      detail,
      outputPath: record.outputPath,
      outputPathBySourcePath,
      uniqueOutputPathByName
    });

    detailProgress += 1;
    emitProgress(onProgress, {
      phase: 'details',
      label: API_STAGE_LABELS.details,
      current: detailProgress,
      total: allRecords.length,
      done: detailProgress === allRecords.length
    });

    return {
      ...record,
      description: detail?.Description ?? '',
      body,
      contentHash: hashContent(body)
    };
  });

  const nextManifest = {
    schemaVersion: SCHEMA_VERSION,
    lastSyncedAt: clock(),
    families: Object.fromEntries(
      API_FAMILIES.map((family) => [family, familySummaries[family] ?? { count: 0 }])
    ),
    entities: renderedEntities
      .map(({ body, description, ...entity }) => entity)
      .sort((left, right) => left.outputPath.localeCompare(right.outputPath, 'en'))
  };

  const diff = diffApiManifest(previousManifest, nextManifest);
  const previousEntitiesBySourcePath = new Map(
    (previousManifest.entities ?? []).map((entity) => [entity.sourcePath, entity])
  );
  const nextOutputPaths = new Set(nextManifest.entities.map((entity) => entity.outputPath));
  const staleOutputPaths = (previousManifest.entities ?? [])
    .map((entity) => entity.outputPath)
    .filter((outputPath) => !nextOutputPaths.has(outputPath));
  const familyIndexFiles = API_FAMILIES.map((family) => toPosixPath(API_OUTPUT_ROOT, family, '000_索引.md'));
  const finalizeTotal = renderedEntities.length + familyIndexFiles.length + staleOutputPaths.length + 3;
  let finalizeProgress = 0;

  emitProgress(onProgress, {
    phase: 'finalize',
    label: API_STAGE_LABELS.finalize,
    current: 0,
    total: finalizeTotal
  });

  function tickFinalize() {
    finalizeProgress += 1;
    emitProgress(onProgress, {
      phase: 'finalize',
      label: API_STAGE_LABELS.finalize,
      current: finalizeProgress,
      total: finalizeTotal,
      done: finalizeProgress === finalizeTotal
    });
  }

  for (const entity of renderedEntities) {
    const previousEntity = previousEntitiesBySourcePath.get(entity.sourcePath);
    const shouldWrite =
      !previousEntity ||
      diff.updated.some((record) => record.sourcePath === entity.sourcePath) ||
      !(await fileExists(toAbsolutePath(rootDir, entity.outputPath)));

    if (shouldWrite) {
      await writeTextFileIfChanged(toAbsolutePath(rootDir, entity.outputPath), entity.body);
    }
    tickFinalize();
  }

  for (const family of API_FAMILIES) {
    const familyIndexPath = toPosixPath(API_OUTPUT_ROOT, family, '000_索引.md');
    const familyIndexContent = `${buildTreeIndexMarkdown({
      title: `${family} API 索引`,
      indexPath: familyIndexPath,
      nodes: familyIndexNodes[family] ?? []
    }).trimEnd()}\n`;
    await writeTextFileIfChanged(toAbsolutePath(rootDir, familyIndexPath), familyIndexContent);
    tickFinalize();
  }

  const rootIndexContent = `${buildRootApiIndexMarkdown(familySummaries).trimEnd()}\n`;
  await writeTextFileIfChanged(
    toAbsolutePath(rootDir, toPosixPath(API_OUTPUT_ROOT, '000_索引.md')),
    rootIndexContent
  );
  tickFinalize();

  const symbolIndexContent = renderTsv(API_SYMBOL_INDEX_HEADERS, buildApiSymbolIndexRows(renderedEntities));
  await writeTextFileIfChanged(toAbsolutePath(rootDir, API_SYMBOL_INDEX_PATH), symbolIndexContent);
  tickFinalize();

  for (const stalePath of staleOutputPaths) {
    await safeRemove(rootDir, stalePath);
    await pruneEmptyDirectories(path.dirname(toAbsolutePath(rootDir, stalePath)), toAbsolutePath(rootDir, API_OUTPUT_ROOT));
    tickFinalize();
  }

  await saveApiManifest(manifestPath, nextManifest);
  tickFinalize();

  return {
    totalEntities: renderedEntities.length,
    createdCount: diff.created.length,
    updatedCount: diff.updated.length,
    deletedCount: diff.deleted.length,
    durationMs: Date.now() - startedAt
  };
}
