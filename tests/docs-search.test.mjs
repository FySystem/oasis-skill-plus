import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import {
  createRgJsonRunner,
  createSearchError,
  formatTextResult,
  runDocsQuery
} from '../src/docs-search.mjs';

async function writeText(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

async function createFixtureRepo(files) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'oasis-docs-search-'));
  const oasisRepoRoot = path.join(projectRoot, 'oasis-skill-plus');

  for (const [relativePath, content] of Object.entries(files)) {
    await writeText(path.join(oasisRepoRoot, relativePath), content);
  }

  return { projectRoot, oasisRepoRoot };
}

function rgMatch(relativePath, lineNumber, text) {
  return {
    type: 'match',
    data: {
      path: { text: relativePath },
      line_number: lineNumber,
      lines: { text }
    }
  };
}

test('verify-api 使用 symbol-index.tsv 返回结构化 API match', async () => {
  const fixture = await createFixtureRepo({
    'docs/api/symbol-index.tsv': 'kind\tname\tsymbol_path\tsource_json_path\tsource_json_url\tmarkdown_file\tdescription\n',
    'docs/api/class/Others/AActor.md': '# AActor\n'
  });

  const calls = [];
  const runRgJson = async (request) => {
    calls.push(request);
    if (request.args.includes('docs/api/symbol-index.tsv')) {
      return [
        rgMatch(
          'docs/api/symbol-index.tsv',
          2,
          'class\tAActor\tOthers / AActor\tclass/detail/Others/AActor.json\thttps://developer.gp.qq.com/api/class/detail/Others/AActor.json\tdocs/api/class/Others/AActor.md\tActor base class\n'
        )
      ];
    }
    return [];
  };

  try {
    const payload = await runDocsQuery({
      projectRoot: fixture.projectRoot,
      mode: 'verify-api',
      scope: 'api',
      query: 'AActor',
      runRgJson
    });

    assert.equal(calls[0].cwd, fixture.oasisRepoRoot);
    assert.ok(calls[0].args.includes('^[^\\t]+\\tAActor\\t'));
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes('docs/api/symbol-index.tsv'));
    assert.ok(!calls[0].args.includes('docs/api'));
    assert.equal(payload.ok, true);
    assert.equal(payload.matches.length, 1);
    assert.deepEqual(payload.matches[0], {
      type: 'api',
      matchType: 'symbol-index',
      title: 'AActor',
      relativePath: 'docs/api/class/Others/AActor.md',
      absolutePath: path.join(fixture.oasisRepoRoot, 'docs/api/class/Others/AActor.md'),
      excerpt: 'Actor base class',
      lineNumber: 2,
      family: 'class',
      sourceJsonUrl: 'https://developer.gp.qq.com/api/class/detail/Others/AActor.json'
    });
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test('verify-api 在 symbol-index.tsv 存在时不继续搜索 API Markdown', async () => {
  const fixture = await createFixtureRepo({
    'docs/api/symbol-index.tsv': 'kind\tname\tsymbol_path\tsource_json_path\tsource_json_url\tmarkdown_file\tdescription\n',
    'docs/api/class/Others/AActor.md': '正文里也可能出现 AActor。\n'
  });

  const calls = [];
  const runRgJson = async (request) => {
    calls.push(request);
    return [];
  };

  try {
    await runDocsQuery({
      projectRoot: fixture.projectRoot,
      mode: 'verify-api',
      scope: 'api',
      query: 'AActor',
      runRgJson
    });

    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes('docs/api/symbol-index.tsv'));
    assert.ok(!calls[0].args.includes('docs/api'));
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test('search wiki 在 article-index.tsv 缺失时给 warning 并返回 Markdown match', async () => {
  const fixture = await createFixtureRepo({
    'docs/wiki/Gameplay/101_Actor生命周期.md': '# Actor 生命周期\nBeginPlay 在出生后调用。\n'
  });

  const calls = [];
  const runRgJson = async (request) => {
    calls.push(request);
    assert.ok(!request.args.includes('docs/wiki/article-index.tsv'));
    return [
      rgMatch('docs/wiki/Gameplay/101_Actor生命周期.md', 2, 'BeginPlay 在出生后调用。\n')
    ];
  };

  try {
    const payload = await runDocsQuery({
      projectRoot: fixture.projectRoot,
      mode: 'search',
      scope: 'wiki',
      query: 'BeginPlay',
      runRgJson
    });

    assert.deepEqual(payload.warnings, [
      {
        code: 'INDEX_MISSING',
        message: 'docs/wiki/article-index.tsv is missing; searched Markdown files directly.'
      }
    ]);
    assert.equal(payload.matches.length, 1);
    assert.equal(payload.matches[0].type, 'wiki');
    assert.equal(payload.matches[0].matchType, 'content');
    assert.equal(payload.matches[0].relativePath, 'docs/wiki/Gameplay/101_Actor生命周期.md');
    assert.equal(payload.matches[0].lineNumber, 2);
    assert.equal(payload.matches[0].excerpt, 'BeginPlay 在出生后调用。');
    assert.ok(calls[0].args.includes('--glob'));
    assert.ok(calls[0].args.includes('!**/000_*.md'));
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test('projectRoot 只有 docs 目录时不会被误判为 oasis-skill-plus 根目录', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'oasis-docs-search-'));
  await writeText(
    path.join(projectRoot, 'docs/api/symbol-index.tsv'),
    'kind\tname\tsymbol_path\tsource_json_path\tsource_json_url\tmarkdown_file\tdescription\n'
  );

  try {
    await assert.rejects(
      runDocsQuery({
        projectRoot,
        mode: 'search',
        scope: 'api',
        query: 'AActor',
        runRgJson: async () => []
      }),
      (error) => {
        assert.equal(error.code, 'OASIS_REPO_NOT_FOUND');
        return true;
      }
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('以短横线开头的查询词通过 --regexp 安全传给 rg', async () => {
  const fixture = await createFixtureRepo({
    'docs/api/symbol-index.tsv': 'kind\tname\tsymbol_path\tsource_json_path\tsource_json_url\tmarkdown_file\tdescription\n'
  });

  const calls = [];
  const runRgJson = async (request) => {
    calls.push(request);
    return [];
  };

  try {
    await runDocsQuery({
      projectRoot: fixture.projectRoot,
      mode: 'search',
      scope: 'api',
      query: '-foo',
      runRgJson
    });

    assert.ok(calls.length > 0);
    const args = calls[0].args;
    assert.ok(args.includes('--regexp'));
    assert.ok(args.includes('-foo'));
    assert.ok(args.indexOf('--regexp') < args.indexOf('-foo'));
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test('TSV 中逃出 oasisRepoRoot 的 markdown_file 会被丢弃', async () => {
  const fixture = await createFixtureRepo({
    'docs/api/symbol-index.tsv': 'kind\tname\tsymbol_path\tsource_json_path\tsource_json_url\tmarkdown_file\tdescription\n'
  });

  const runRgJson = async () => [
    rgMatch(
      'docs/api/symbol-index.tsv',
      2,
      'class\tAActor\tOthers / AActor\tclass/detail/Others/AActor.json\thttps://developer.gp.qq.com/api/class/detail/Others/AActor.json\t../outside.md\tActor base class\n'
    )
  ];

  try {
    const payload = await runDocsQuery({
      projectRoot: fixture.projectRoot,
      mode: 'verify-api',
      scope: 'api',
      query: 'AActor',
      runRgJson
    });

    assert.deepEqual(payload.matches, []);
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test('exact=true 在索引缺失时不回退搜索 Markdown 正文', async () => {
  const fixture = await createFixtureRepo({
    'docs/api/class/Others/AActor.md': 'Actor appears in markdown body.\n'
  });

  const calls = [];
  const runRgJson = async (request) => {
    calls.push(request);
    return [
      rgMatch('docs/api/class/Others/AActor.md', 1, 'Actor appears in markdown body.\n')
    ];
  };

  try {
    const payload = await runDocsQuery({
      projectRoot: fixture.projectRoot,
      mode: 'search',
      scope: 'api',
      query: 'Actor',
      exact: true,
      runRgJson
    });

    assert.equal(calls.length, 0);
    assert.equal(payload.warnings.length, 1);
    assert.equal(payload.warnings[0].code, 'INDEX_MISSING');
    assert.doesNotMatch(payload.warnings[0].message, /searched Markdown files directly/);
    assert.match(payload.warnings[0].message, /fallback was skipped/);
    assert.deepEqual(payload.matches, []);
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test('family=class 时 API search 的 rg 参数包含 docs/api/class', async () => {
  const fixture = await createFixtureRepo({
    'docs/api/symbol-index.tsv': 'kind\tname\tsymbol_path\tsource_json_path\tsource_json_url\tmarkdown_file\tdescription\n',
    'docs/api/class/Others/AActor.md': '# AActor\n'
  });

  const calls = [];
  const runRgJson = async (request) => {
    calls.push(request);
    return [];
  };

  try {
    await runDocsQuery({
      projectRoot: fixture.projectRoot,
      mode: 'search',
      scope: 'api',
      query: 'Actor',
      family: 'class',
      runRgJson
    });

    assert.ok(calls.some((call) => call.args.includes('docs/api/class')));
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test('family=class 时 API search 会过滤 symbol-index.tsv 中其他 family 的行', async () => {
  const fixture = await createFixtureRepo({
    'docs/api/symbol-index.tsv': 'kind\tname\tsymbol_path\tsource_json_path\tsource_json_url\tmarkdown_file\tdescription\n'
  });

  const runRgJson = async (request) => {
    if (!request.args.includes('docs/api/symbol-index.tsv')) {
      return [];
    }
    return [
      rgMatch(
        'docs/api/symbol-index.tsv',
        2,
        'cppenum\tPhaseState\tEnums / PhaseState\tcppenum/detail/PhaseState.json\thttps://developer.gp.qq.com/api/cppenum/detail/PhaseState.json\tdocs/api/cppenum/PhaseState.md\tPhase enum\n'
      )
    ];
  };

  try {
    const payload = await runDocsQuery({
      projectRoot: fixture.projectRoot,
      mode: 'search',
      scope: 'api',
      family: 'class',
      query: 'Phase',
      runRgJson
    });

    assert.deepEqual(payload.matches, []);
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test('symbol-index.tsv 的 header 行不会被当作 match 返回', async () => {
  const fixture = await createFixtureRepo({
    'docs/api/symbol-index.tsv': 'kind\tname\tsymbol_path\tsource_json_path\tsource_json_url\tmarkdown_file\tdescription\n'
  });

  const runRgJson = async (request) => {
    if (!request.args.includes('docs/api/symbol-index.tsv')) {
      return [];
    }
    return [
      rgMatch(
        'docs/api/symbol-index.tsv',
        1,
        'kind\tname\tsymbol_path\tsource_json_path\tsource_json_url\tmarkdown_file\tdescription\n'
      )
    ];
  };

  try {
    const payload = await runDocsQuery({
      projectRoot: fixture.projectRoot,
      mode: 'search',
      scope: 'api',
      query: 'name',
      runRgJson
    });

    assert.deepEqual(payload.matches, []);
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test('createSearchError 保留 code/message', () => {
  const error = createSearchError('RG_NOT_FOUND', '找不到 rg');

  assert.equal(error.code, 'RG_NOT_FOUND');
  assert.equal(error.message, '找不到 rg');
});

test('createRgJsonRunner 将 spawn ENOENT 映射为 RG_NOT_FOUND', async () => {
  const spawnCalls = [];
  const encodingCalls = [];
  const spawnImpl = (...args) => {
    spawnCalls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = (encoding) => {
      encodingCalls.push(['stdout', encoding]);
    };
    child.stderr.setEncoding = (encoding) => {
      encodingCalls.push(['stderr', encoding]);
    };

    process.nextTick(() => {
      child.emit('error', Object.assign(new Error('spawn missing-rg ENOENT'), { code: 'ENOENT' }));
    });

    return child;
  };

  await assert.rejects(
    createRgJsonRunner({ spawnImpl, rgPath: 'missing-rg' })({
      cwd: process.cwd(),
      args: ['needle']
    }),
    (error) => {
      assert.equal(error.code, 'RG_NOT_FOUND');
      assert.match(error.message, /rg/);
      return true;
    }
  );
  assert.equal(spawnCalls[0][0], 'missing-rg');
  assert.deepEqual(spawnCalls[0][1], ['--json', 'needle']);
  assert.equal(spawnCalls[0][2].cwd, process.cwd());
  assert.deepEqual(encodingCalls, [
    ['stdout', 'utf8'],
    ['stderr', 'utf8']
  ]);
});

test('检索并发启动，逆序完成仍保持优先级、去重和 limit，失败等待其他检索结束', async () => {
  const fixture = await createFixtureRepo({
    'docs/api/symbol-index.tsv': 'header\n',
    'docs/wiki/article-index.tsv': 'header\n'
  });
  try {
    const pending = [];
    const options = { projectRoot: fixture.projectRoot, mode: 'search', scope: 'all', query: 'Actor', limit: 2,
      runRgJson: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) };
    const query = runDocsQuery(options);
    // 未释放任何任务就必须已启动四项，避免用不稳定的毫秒阈值测试并发。
    assert.equal(pending.length, 4);
    pending[3].resolve([rgMatch('docs/wiki/Actor.md', 1, 'wiki')]);
    pending[2].resolve([]);
    const content = rgMatch('docs/api/Actor.md', 1, 'api');
    pending[1].resolve([content, content]);
    pending[0].resolve([rgMatch('docs/api/symbol-index.tsv', 2, 'class\tActor\tActor\tx\turl\tdocs/api/Actor.md\tindex')]);
    assert.deepEqual((await query).matches.map((match) => match.excerpt), ['index', 'api']);

    pending.length = 0;
    let finished = false;
    const failure = new Error('检索失败');
    const failedQuery = runDocsQuery(options).finally(() => { finished = true; });
    const rejection = assert.rejects(failedQuery, (error) => error === failure);
    pending[0].reject(failure);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    for (const task of pending.slice(1)) task.resolve([]);
    await rejection;
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test('formatTextResult 输出包含 file 和 excerpt', () => {
  const text = formatTextResult({
    ok: true,
    mode: 'search',
    scope: 'wiki',
    query: 'BeginPlay',
    warnings: [],
    matches: [
      {
        type: 'wiki',
        title: 'Actor 生命周期',
        relativePath: 'docs/wiki/Gameplay/101_Actor生命周期.md',
        lineNumber: 2,
        excerpt: 'BeginPlay 在出生后调用。'
      }
    ]
  });

  assert.match(text, /file: docs\/wiki\/Gameplay\/101_Actor生命周期\.md/);
  assert.match(text, /excerpt: BeginPlay 在出生后调用。/);
});
