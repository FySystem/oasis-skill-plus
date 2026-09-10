import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { nativeFileBinary } from '../src/native-files.mjs';

// 标准库 Go 程序一次编译即可运行，无需在每次同步时编译或安装第三方包。
await mkdir(path.dirname(nativeFileBinary), { recursive: true });
const result = spawnSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', nativeFileBinary, '.'], {
  cwd: fileURLToPath(new URL('../native/file-writer/', import.meta.url)),
  stdio: 'inherit', windowsHide: true
});
if (result.error) console.error(`构建失败，请安装 Go 1.22+：${result.error.message}`);
process.exitCode = result.error ? 1 : result.status ?? 1;
if (process.exitCode === 0) console.log(`Go 文件写入器已构建：${nativeFileBinary}`);
