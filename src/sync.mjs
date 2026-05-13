import path from 'node:path';
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';

import {
  buildArticleFileName,
  buildImageFileName,
  collectImageUrls,
  normalizeMarkdown,
  rewriteImageLinks,
  rewriteOfficialWikiLinks
} from './markdown.mjs';
import {
  createEmptyManifest,
  diffManifest,
  hashContent,
  loadManifest,
  saveManifest
} from './manifest.mjs';
import { STAGE_LABELS } from './progress.mjs';
import { createWikiClient } from './wiki-client.mjs';

const OUTPUT_ROOT = 'docs/wiki';
const IMAGES_ROOT = 'docs/wiki/_assets/images';
const INDEX_PATH = 'docs/wiki/000_索引.md';
const MANIFEST_PATH = '.oasis-sync/manifest.json';

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

export function flattenWikiTree(nodes, categoryPath = []) {
  const articles = [];

  for (const node of nodes) {
    if (node.type === 1) {
      articles.push({
        id: String(node.id),
        label: String(node.label ?? ''),
        treePath: [...categoryPath]
      });
      continue;
    }

    const nextPath = [...categoryPath, String(node.label ?? '未命名')];
    articles.push(...flattenWikiTree(node.children ?? [], nextPath));
  }

  return articles;
}

function buildOutputPath(article) {
  const directories = article.treePath.map((segment) => segment.trim()).filter(Boolean);
  return toPosixPath(OUTPUT_ROOT, ...directories, buildArticleFileName(article.id, article.title));
}

async function writeTextFileIfChanged(filePath, content) {
  if (await fileExists(filePath)) {
    const currentContent = await readFile(filePath, 'utf8');
    if (currentContent === content) {
      return false;
    }
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return true;
}

async function writeBinaryFileIfChanged(filePath, buffer) {
  if (await fileExists(filePath)) {
    const currentBuffer = await readFile(filePath);
    if (currentBuffer.equals(buffer)) {
      return false;
    }
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, buffer);
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

function buildIndexMarkdown(tree, titleById, articlePathById) {
  const lines = ['# 绿洲启元 Wiki 索引', ''];

  function visit(nodes, depth) {
    for (const node of nodes) {
      if (node.type === 1) {
        const articlePath = articlePathById.get(String(node.id));
        if (!articlePath) {
          continue;
        }

        const relativePath = path
          .relative(path.dirname(INDEX_PATH), articlePath)
          .replace(/\\/g, '/')
          .replace(/^(?!\.)/, './');
        const title = titleById.get(String(node.id)) ?? node.label;
        lines.push(`- [${title}](${relativePath})`);
        continue;
      }

      lines.push(`${'#'.repeat(Math.min(depth, 6))} ${node.label}`);
      lines.push('');
      visit(node.children ?? [], depth + 1);
    }
  }

  visit(tree, 2);
  lines.push('');
  return lines.join('\n');
}

export async function syncWiki({
  rootDir = process.cwd(),
  client = createWikiClient(),
  articleConcurrency = 8,
  imageConcurrency = 6,
  clock = () => new Date().toISOString(),
  onProgress
} = {}) {
  const startedAt = Date.now();
  const manifestFile = toAbsolutePath(rootDir, MANIFEST_PATH);
  const previousManifest = await loadManifest(manifestFile);

  emitProgress(onProgress, {
    phase: 'category',
    label: STAGE_LABELS.category,
    current: 0,
    total: 1
  });
  const { tree, version, updateTime } = await client.fetchCategoryTree();
  emitProgress(onProgress, {
    phase: 'category',
    label: STAGE_LABELS.category,
    current: 1,
    total: 1,
    done: true
  });

  const articleNodes = flattenWikiTree(tree);
  let articleProgress = 0;
  emitProgress(onProgress, {
    phase: 'articles',
    label: STAGE_LABELS.articles,
    current: 0,
    total: articleNodes.length
  });
  if (articleNodes.length === 0) {
    emitProgress(onProgress, {
      phase: 'articles',
      label: STAGE_LABELS.articles,
      current: 0,
      total: 0,
      done: true
    });
  }
  const remoteArticles = await mapLimit(articleNodes, articleConcurrency, async (node) => {
    const article = await client.fetchArticle(node.id);
    articleProgress += 1;
    emitProgress(onProgress, {
      phase: 'articles',
      label: STAGE_LABELS.articles,
      current: articleProgress,
      total: articleNodes.length,
      done: articleProgress === articleNodes.length
    });
    return {
      ...article,
      treePath: node.treePath
    };
  });

  const articlePathById = new Map(
    remoteArticles.map((article) => [String(article.id), buildOutputPath(article)])
  );
  const titleById = new Map(remoteArticles.map((article) => [String(article.id), article.title]));

  const preparedArticles = [];
  const uniqueImageUrls = new Set();

  for (const article of remoteArticles) {
    const outputPath = articlePathById.get(String(article.id));
    const normalized = normalizeMarkdown(article.body);
    const linkedBody = rewriteOfficialWikiLinks(normalized, outputPath, articlePathById);
    const imageUrls = collectImageUrls(linkedBody);

    imageUrls.forEach((url) => uniqueImageUrls.add(url));

    preparedArticles.push({
      ...article,
      outputPath,
      linkedBody,
      imageUrls
    });
  }

  const imagePathByUrl = new Map(
    Array.from(uniqueImageUrls, (url) => [url, toPosixPath(IMAGES_ROOT, buildImageFileName(url))])
  );

  const imageDownloads = new Map();
  const previousImages = previousManifest.images ?? {};
  const imageUrls = Array.from(uniqueImageUrls);
  let imageProgress = 0;

  emitProgress(onProgress, {
    phase: 'images',
    label: STAGE_LABELS.images,
    current: 0,
    total: imageUrls.length
  });
  if (imageUrls.length === 0) {
    emitProgress(onProgress, {
      phase: 'images',
      label: STAGE_LABELS.images,
      current: 0,
      total: 0,
      done: true
    });
  }

  await mapLimit(imageUrls, imageConcurrency, async (url) => {
    const imageOutputPath = imagePathByUrl.get(url);
    const previousOutputPath = previousImages[url];
    const imageExistsLocally =
      previousOutputPath === imageOutputPath &&
      (await fileExists(toAbsolutePath(rootDir, imageOutputPath)));

    if (!imageExistsLocally) {
      const download = await client.downloadImage(url);
      imageDownloads.set(url, download.buffer);
    }

    imageProgress += 1;
    emitProgress(onProgress, {
      phase: 'images',
      label: STAGE_LABELS.images,
      current: imageProgress,
      total: imageUrls.length,
      done: imageProgress === imageUrls.length
    });
  });

  const nextArticles = preparedArticles.map((article) => {
    const localizedBody = rewriteImageLinks(article.linkedBody, article.outputPath, imagePathByUrl);
    const finalBody = localizedBody.endsWith('\n') ? localizedBody : `${localizedBody}\n`;

    return {
      id: String(article.id),
      title: article.title,
      treePath: article.treePath,
      outputPath: article.outputPath,
      updateTime: article.updateTime,
      contentHash: hashContent(finalBody),
      imageUrls: article.imageUrls,
      body: finalBody
    };
  });

  const nextManifest = {
    schemaVersion: createEmptyManifest().schemaVersion,
    lastSyncedAt: clock(),
    remoteTree: {
      version,
      updateTime
    },
    articles: nextArticles
      .map(({ body, ...articleRecord }) => articleRecord)
      .sort((left, right) => left.outputPath.localeCompare(right.outputPath, 'zh-CN')),
    images: Object.fromEntries(
      Array.from(imagePathByUrl.entries()).sort((left, right) => left[0].localeCompare(right[0], 'en'))
    )
  };

  const diff = diffManifest(previousManifest, nextManifest);
  const previousArticlesById = new Map(
    (previousManifest.articles ?? []).map((article) => [String(article.id), article])
  );
  const nextOutputPaths = new Set(nextManifest.articles.map((article) => article.outputPath));
  const nextImagePaths = new Set(Object.values(nextManifest.images));
  const staleArticlePaths = (previousManifest.articles ?? [])
    .map((article) => article.outputPath)
    .filter((outputPath) => !nextOutputPaths.has(outputPath));
  const staleImagePaths = Object.values(previousManifest.images ?? {}).filter(
    (imagePath) => !nextImagePaths.has(imagePath)
  );
  const uniqueStaleImagePaths = Array.from(new Set(staleImagePaths));
  const finalizeTotal =
    nextArticles.length + imageDownloads.size + staleArticlePaths.length + uniqueStaleImagePaths.length + 2;
  let finalizeProgress = 0;

  emitProgress(onProgress, {
    phase: 'finalize',
    label: STAGE_LABELS.finalize,
    current: 0,
    total: finalizeTotal
  });

  function tickFinalize() {
    finalizeProgress += 1;
    emitProgress(onProgress, {
      phase: 'finalize',
      label: STAGE_LABELS.finalize,
      current: finalizeProgress,
      total: finalizeTotal,
      done: finalizeProgress === finalizeTotal
    });
  }

  for (const article of nextArticles) {
    const previousRecord = previousArticlesById.get(article.id);
    const shouldWrite =
      !previousRecord ||
      diff.updated.some((changedArticle) => changedArticle.id === article.id) ||
      !(await fileExists(toAbsolutePath(rootDir, article.outputPath)));

    if (!shouldWrite) {
      tickFinalize();
      continue;
    }

    await writeTextFileIfChanged(toAbsolutePath(rootDir, article.outputPath), article.body);
    tickFinalize();
  }

  for (const [url, buffer] of imageDownloads.entries()) {
    await writeBinaryFileIfChanged(toAbsolutePath(rootDir, imagePathByUrl.get(url)), buffer);
    tickFinalize();
  }

  const indexContent = buildIndexMarkdown(tree, titleById, articlePathById);
  await writeTextFileIfChanged(toAbsolutePath(rootDir, INDEX_PATH), `${indexContent.trimEnd()}\n`);
  tickFinalize();

  for (const stalePath of staleArticlePaths) {
    await safeRemove(rootDir, stalePath);
    await pruneEmptyDirectories(path.dirname(toAbsolutePath(rootDir, stalePath)), toAbsolutePath(rootDir, OUTPUT_ROOT));
    tickFinalize();
  }

  for (const stalePath of uniqueStaleImagePaths) {
    await safeRemove(rootDir, stalePath);
    await pruneEmptyDirectories(path.dirname(toAbsolutePath(rootDir, stalePath)), toAbsolutePath(rootDir, OUTPUT_ROOT));
    tickFinalize();
  }

  await saveManifest(manifestFile, nextManifest);
  tickFinalize();

  return {
    totalArticles: nextArticles.length,
    createdCount: diff.created.length,
    updatedCount: diff.updated.length,
    deletedCount: diff.deleted.length,
    imagesDownloaded: imageDownloads.size,
    durationMs: Date.now() - startedAt
  };
}
