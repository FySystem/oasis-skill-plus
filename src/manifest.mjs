import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export const SCHEMA_VERSION = 1;

export function createEmptyManifest() {
  return {
    schemaVersion: SCHEMA_VERSION,
    lastSyncedAt: null,
    remoteTree: {
      version: null,
      updateTime: null
    },
    articles: [],
    images: {}
  };
}

export async function loadManifest(filePath) {
  try {
    const rawContent = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(rawContent);

    return {
      ...createEmptyManifest(),
      ...parsed,
      remoteTree: {
        ...createEmptyManifest().remoteTree,
        ...(parsed.remoteTree ?? {})
      },
      articles: parsed.articles ?? [],
      images: parsed.images ?? {}
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return createEmptyManifest();
    }

    throw error;
  }
}

export async function saveManifest(filePath, manifest) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export function hashContent(content) {
  return crypto.createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex').slice(0, 16);
}

function arraysEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function recordsEquivalent(previousRecord, nextRecord) {
  return (
    previousRecord.title === nextRecord.title &&
    previousRecord.outputPath === nextRecord.outputPath &&
    previousRecord.contentHash === nextRecord.contentHash &&
    arraysEqual(previousRecord.treePath ?? [], nextRecord.treePath ?? []) &&
    arraysEqual(previousRecord.imageUrls ?? [], nextRecord.imageUrls ?? [])
  );
}

export function diffManifest(previousManifest, nextManifest) {
  const previousArticles = new Map((previousManifest?.articles ?? []).map((article) => [String(article.id), article]));
  const nextArticles = new Map((nextManifest?.articles ?? []).map((article) => [String(article.id), article]));

  const created = [];
  const updated = [];
  const deleted = [];

  for (const [id, nextRecord] of nextArticles.entries()) {
    const previousRecord = previousArticles.get(id);
    if (!previousRecord) {
      created.push(nextRecord);
      continue;
    }

    if (!recordsEquivalent(previousRecord, nextRecord)) {
      updated.push(nextRecord);
    }
  }

  for (const [id, previousRecord] of previousArticles.entries()) {
    if (!nextArticles.has(id)) {
      deleted.push(previousRecord);
    }
  }

  return { created, updated, deleted };
}
