import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// 使用相同缓存副本或空目录请求真实远端，交替运行顺序，避免污染仓库文档。
const baselineSource = path.resolve(process.argv[2]);
const rounds = Number(process.argv[3] ?? 3);
// cold 模式从空目录开始，真实下载所有图片，不复制已有缓存。
const mode = process.argv[4] ?? 'warm';
const command = process.argv[5] ?? 'sync-all';
assert.ok(['sync-all', 'sync-api', 'sync'].includes(command), '无效的同步命令');
assert.ok(['cold', 'warm'].includes(mode), '模式必须为 cold 或 warm');
assert.ok(Number.isInteger(rounds) && rounds > 0);
const workspace = process.cwd();
const temp = await mkdtemp(path.join(tmpdir(), 'oasis-sync-benchmark-'));
console.log(JSON.stringify({ temp, baselineSource, rounds, mode, command, node: process.version }));
const versions = {};
for (const [name, source] of [['before', baselineSource], ['after', path.join(workspace, 'src')]]) {
  versions[name] = {
    cli: await import(pathToFileURL(path.join(source, 'cli-runner.mjs'))),
    wiki: await import(pathToFileURL(path.join(source, 'sync.mjs'))),
    api: await import(pathToFileURL(path.join(source, 'api-sync.mjs')))
  };
}

// 比较所有文档与 manifest，排除同步时间字段；任何内容差异都要明确报出。
async function fingerprints(root, relative = '') {
  const result = {};
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const file = path.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(result, await fingerprints(root, file));
    else {
      let bytes = await readFile(path.join(root, file));
      if (file.endsWith('manifest.json')) {
        const manifest = JSON.parse(bytes);
        delete manifest.lastSyncedAt;
        bytes = JSON.stringify(manifest);
      }
      result[file] = createHash('sha256').update(bytes).digest('hex');
    }
  }
  return result;
}

const measurements = [];
for (let round = 0; round < rounds; round += 1) {
  const outputs = {};
  for (const name of round % 2 ? ['after', 'before'] : ['before', 'after']) {
    const rootDir = path.join(temp, `${round}-${name}`);
    await mkdir(rootDir);
    if (mode === 'warm') {
      // 单独测 API 时不复制无关的数 GB Wiki 图片缓存。
      const cachePaths = command === 'sync-api' ? ['docs/api', '.oasis-sync/api-manifest.json']
        : command === 'sync' ? ['docs/wiki', '.oasis-sync/manifest.json'] : ['docs', '.oasis-sync'];
      for (const directory of cachePaths) {
        await mkdir(path.dirname(path.join(rootDir, directory)), { recursive: true });
        await cp(path.join(workspace, directory), path.join(rootDir, directory), { recursive: true });
      }
    }
    const version = versions[name];
    const timings = {};
    const phaseStart = {};
    const phaseMs = {};
    // 分阶段记录真实耗时，用于区分网络下载与最终文件写入的瓶颈。
    function progress(task, event) {
      const key = `${task}.${event.phase}`;
      if (!(key in phaseStart)) phaseStart[key] = performance.now();
      if (event.done) {
        phaseMs[key] = performance.now() - phaseStart[key];
        console.log(JSON.stringify({ round: round + 1, name, phase: key, durationMs: phaseMs[key] }));
      }
    }
    const start = performance.now();
    const code = await version.cli.runCli({
      argv: ['node', 'cli', command],
      stdout: { write() {} },
      stderr: { write(text) { console.error(text.trim()); } },
      syncWikiImpl: async (options) => {
        const result = await version.wiki.syncWiki({ ...options, rootDir, onProgress: (event) => {
          options.onProgress(event);
          progress('wiki', event);
        } });
        timings.wiki = result;
        return result;
      },
      syncApiImpl: async (options) => {
        const result = await version.api.syncApi({ ...options, rootDir, onProgress: (event) => {
          options.onProgress(event);
          progress('api', event);
        } });
        timings.api = result;
        return result;
      }
    });
    assert.equal(code, 0, `${name} 同步失败，不能计为有效性能样本`);
    const measurement = { round: round + 1, name, totalMs: performance.now() - start, phaseMs, ...timings };
    measurements.push(measurement);
    console.log(JSON.stringify(measurement));
    outputs[name] = await fingerprints(rootDir);
    // 指纹已留在内存，每次只保留一个缓存副本，避免多轮测试耗尽磁盘。
    assert.equal(path.dirname(rootDir), temp);
    await rm(rootDir, { recursive: true, force: true });
  }
  assert.deepEqual(outputs.after, outputs.before, '优化前后输出不一致');
  console.log(JSON.stringify({ round: round + 1, identicalFiles: Object.keys(outputs.after).length }));
}
const median = (values) => {
  // 偶数轮数取中间两项均值，奇数轮数取中间项。
  values.sort((a, b) => a - b);
  return (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2;
};
const beforeMs = median(measurements.filter((item) => item.name === 'before').map((item) => item.totalMs));
const afterMs = median(measurements.filter((item) => item.name === 'after').map((item) => item.totalMs));
console.log(JSON.stringify({ beforeMs, afterMs, reductionPercent: (1 - afterMs / beforeMs) * 100, speedup: beforeMs / afterMs }));
