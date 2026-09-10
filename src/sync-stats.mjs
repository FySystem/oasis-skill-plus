import path from 'node:path';
import { readdir } from 'node:fs/promises';

// 只统计清单未变化但本地缺失的文档；按父目录读取一次，避免原生写入前逐文件 stat。
export async function countRestoredDocuments(rootDir, records) {
  const directories = new Map();
  let restored = 0;
  for (const record of records) {
    const target = path.resolve(rootDir, record.outputPath);
    const directory = path.dirname(target);
    if (!directories.has(directory)) {
      try {
        directories.set(directory, new Set(await readdir(directory)));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        directories.set(directory, new Set());
      }
    }
    if (!directories.get(directory).has(path.basename(target))) restored += 1;
  }
  return restored;
}
