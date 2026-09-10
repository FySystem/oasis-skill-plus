import path from 'node:path';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
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
import {
  buildWikiArticleIndexRows,
  renderTsv
} from './tsv-index.mjs';
import { createWikiClient } from './wiki-client.mjs';
import { countRestoredDocuments } from './sync-stats.mjs';

const OUTPUT_ROOT = 'docs/wiki';
const IMAGES_ROOT = 'docs/wiki/_assets/images';
const INDEX_PATH = 'docs/wiki/000_索引.md';
const ARTICLE_INDEX_PATH = 'docs/wiki/article-index.tsv';
const MANIFEST_PATH = '.oasis-sync/manifest.json';
const ARTICLE_INDEX_HEADERS = ['id', 'title', 'wiki_path', 'url', 'file'];

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
  // 并发必须为正整数，失败后停止领新任务并等待在途任务收尾。
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('并发数必须为正整数');
  const results = new Array(items.length);
  let nextIndex = 0;
  let failed = false;

  async function worker() {
    while (!failed && nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      try {
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }

  const workerCount = Math.min(limit, items.length);
  const workers = await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
  const rejected = workers.find((result) => result.status === 'rejected');
  if (rejected) throw rejected.reason;
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
  // 文章和图片分别限流，图片并发下载与暂存，不再积攒全部图片缓冲区。
  articleConcurrency = 16,
  imageConcurrency = 24,
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

  // 临时图片与正式目录位于同一工作区，下载全部成功后可直接重命名落盘。
  await mkdir(path.dirname(manifestFile), { recursive: true });
  const stagingDirectory = await mkdtemp(path.join(path.dirname(manifestFile), 'images-'));
  try {
    await mapLimit(imageUrls, imageConcurrency, async (url) => {
      const imageOutputPath = imagePathByUrl.get(url);
      const previousOutputPath = previousImages[url];
      const imageExistsLocally =
        previousOutputPath === imageOutputPath &&
        (await fileExists(toAbsolutePath(rootDir, imageOutputPath)));

      if (!imageExistsLocally) {
        const download = await client.downloadImage(url);
        const stagedPath = path.join(stagingDirectory, path.basename(imageOutputPath));
        await writeFile(stagedPath, download.buffer);
        imageDownloads.set(url, stagedPath);
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
      nextArticles.length + imageDownloads.size + staleArticlePaths.length + uniqueStaleImagePaths.length + 3;
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

    // 补回本地缺失文档计入新增，远端已变化的文档仍按原差异分类，避免重复计数。
    const changedPaths = new Set([...diff.created, ...diff.updated].map((article) => article.outputPath));
    const restoredCount = await countRestoredDocuments(rootDir,
      nextArticles.filter((article) => !changedPaths.has(article.outputPath)));
    // 更新标识只建立一次，避免批量更新时反复扫描整个差异列表。
    const updatedArticleIds = new Set(diff.updated.map((article) => article.id));
    for (const article of nextArticles) {
      const previousRecord = previousArticlesById.get(article.id);
      const shouldWrite =
        !previousRecord ||
        updatedArticleIds.has(article.id) ||
        !(await fileExists(toAbsolutePath(rootDir, article.outputPath)));

      if (!shouldWrite) {
        tickFinalize();
        continue;
      }

      await writeTextFileIfChanged(toAbsolutePath(rootDir, article.outputPath), article.body);
      tickFinalize();
    }

    // 图片内容已经在下载阶段写入磁盘，此处只移动文件，不再重复写入数 GB 数据。
    if (imageDownloads.size > 0) await mkdir(toAbsolutePath(rootDir, IMAGES_ROOT), { recursive: true });
    for (const [url, stagedPath] of imageDownloads.entries()) {
      await rename(stagedPath, toAbsolutePath(rootDir, imagePathByUrl.get(url)));
      tickFinalize();
    }

    const indexContent = buildIndexMarkdown(tree, titleById, articlePathById);
    await writeTextFileIfChanged(toAbsolutePath(rootDir, INDEX_PATH), `${indexContent.trimEnd()}\n`);
    tickFinalize();

    const articleIndexContent = renderTsv(ARTICLE_INDEX_HEADERS, buildWikiArticleIndexRows(nextArticles));
    await writeTextFileIfChanged(toAbsolutePath(rootDir, ARTICLE_INDEX_PATH), articleIndexContent);
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
      createdCount: diff.created.length + restoredCount,
      updatedCount: diff.updated.length,
      deletedCount: diff.deleted.length,
      imagesDownloaded: imageDownloads.size,
      durationMs: Date.now() - startedAt
    };
  } finally {
    // 只清理本次 mkdtemp 创建的目录；mapLimit 已确保没有在途写入。
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}
