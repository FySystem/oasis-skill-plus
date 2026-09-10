import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 每个样本启动新 Node 进程，计入技能脚本日常调用时的启动成本。
if (process.argv[2] === '--sample') {
  const { runDocsQuery } = await import(pathToFileURL(path.resolve(process.argv[3])).href);
  const result = await runDocsQuery(JSON.parse(process.argv[4]));
  process.stdout.write(JSON.stringify(result));
} else {
  const baseline = process.argv[2];
  if (!baseline) throw new Error('用法：node scripts/benchmark-query.mjs <优化前 docs-search.mjs> [limit=1000000]');
  const limit = Number(process.argv[3] ?? 1000000);
  assert.ok(Number.isSafeInteger(limit) && limit > 0, 'limit 必须是正整数');
  const cases = [
    { mode: 'verify-api', scope: 'api', query: 'AActor' },
    { mode: 'search', scope: 'api', query: 'Actor' },
    { mode: 'search', scope: 'wiki', query: '生命周期' },
    { mode: 'search', scope: 'all', query: 'Actor' },
    { mode: 'search', scope: 'all', query: '不存在的查询词_987654321' },
    { mode: 'search', scope: 'all', query: 'AActor', exact: true },
    { mode: 'search', scope: 'api', query: 'Player', family: 'class' }
  ];
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  for (const options of cases) {
    const times = [[], []];
    let fullMatches;
    for (let round = -1; round < 7; round += 1) {
      const outputs = [];
      // 交替先后顺序，减小操作系统文件缓存对一侧的偏向。
      for (const side of round % 2 ? [1, 0] : [0, 1]) {
        const start = performance.now();
        const result = spawnSync(process.execPath, [process.argv[1], '--sample',
          side ? 'src/docs-search.mjs' : baseline,
          JSON.stringify({ ...options, projectRoot: process.cwd(), limit: round < 0 ? 1000000 : limit })
        ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
        if (round >= 0) times[side].push(performance.now() - start);
        assert.equal(result.status, 0, result.stderr);
        outputs[side] = JSON.parse(result.stdout);
      }
      // rg 遍历文件的顺序本来就不固定；比较命中集合，默认大 limit 用于检查完整结果。
      for (const output of outputs) output.matches.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      if (round < 0 || limit === 1000000) {
        assert.deepEqual(outputs[1], outputs[0]);
        fullMatches = new Set(outputs[0].matches.map((match) => JSON.stringify(match)));
      } else {
        // 截断前的正文顺序不稳定，因此检查条数及每条是否属于已核对的完整集合。
        for (const output of outputs) {
          assert.equal(output.matches.length, Math.min(limit, fullMatches.size));
          assert.ok(output.matches.every((match) => fullMatches.has(JSON.stringify(match))));
        }
        assert.deepEqual({ ...outputs[1], matches: [] }, { ...outputs[0], matches: [] });
      }
    }
    const before = median(times[0]);
    const after = median(times[1]);
    console.log(JSON.stringify({ ...options, limit, beforeMs: before, afterMs: after,
      reductionPercent: (1 - after / before) * 100, times, equivalent: true }));
  }
}
