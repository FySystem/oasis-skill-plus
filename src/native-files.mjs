import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const nativeFileBinary = fileURLToPath(new URL(
  `../bin/oasis-file-writer${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url
));

export function hasNativeFiles() {
  return existsSync(nativeFileBinary);
}

export function writeNativeFiles({ items, directory, concurrency = 8, onWritten }) {
  if (items.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    // 单次批量传入已渲染的文本；Go 只负责磁盘 I/O，不重复实现 Markdown 规则。
    const child = spawn(nativeFileBinary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const completed = new Set();
    let failure;
    let stderr = '';
    const lines = createInterface({ input: child.stdout });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192); });
    child.on('error', (error) => { failure = error; });
    child.stdin.on('error', (error) => { failure ??= error; });
    lines.on('line', (line) => {
      try {
        const { index } = JSON.parse(line);
        if (!Number.isInteger(index) || index < 0 || index >= items.length || completed.has(index)) {
          throw new Error('Go 文件写入器返回了无效的完成编号');
        }
        completed.add(index);
        onWritten(index);
      } catch (error) {
        failure = error;
        child.kill();
      }
    });
    // 进程关闭后才能更新 manifest 或返回错误，避免后台仍在写入文档。
    child.on('close', (code) => {
      lines.close();
      if (failure || code !== 0 || completed.size !== items.length) {
        reject(failure ?? new Error(stderr.trim() || `Go 文件写入失败，退出码：${code}`));
      } else resolve();
    });
    child.stdin.end(JSON.stringify({ items, directory, concurrency }));
  });
}
