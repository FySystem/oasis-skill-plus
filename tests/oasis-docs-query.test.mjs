import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../skills/oasis-official-docs/scripts/query-oasis-docs.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(testDir, '..', 'skills', 'oasis-official-docs', 'scripts', 'query-oasis-docs.mjs');

function runQueryScript(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({
        exitCode,
        stdout,
        stderr
      });
    });
  });
}

async function writeText(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

async function createFixtureProject() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'oasis-docs-skill-'));
  const oasisRepoRoot = path.join(projectRoot, 'oasis-skill-plus');

  await writeText(
    path.join(oasisRepoRoot, 'docs', 'api', 'symbol-index.tsv'),
    [
      'kind\tname\tsymbol_path\tsource_json_path\tsource_json_url\tmarkdown_file\tdescription',
      'class\tAActor\tUObject.AActor\tdocs/api-json/class/AActor.json\thttps://example.invalid/api/AActor.json\tdocs/api/class/Others/AActor.md\tActor base class used for spawned level objects.',
      'class\tAPawn\tUObject.APawn\tdocs/api-json/class/APawn.json\thttps://example.invalid/api/APawn.json\tdocs/api/class/Others/APawn.md\tPawn class controlled by players or AI.'
    ].join('\n')
  );

  await writeText(
    path.join(oasisRepoRoot, 'docs', 'api', 'class', 'Others', 'AActor.md'),
    [
      '# AActor',
      '',
      'Actor is the base class for an Object that can be placed or spawned in a level.',
      '',
      '## Functions',
      '',
      '### SetOwner',
      '',
      'Set the owner of this Actor, used primarily for network replication.',
      ''
    ].join('\n')
  );

  await writeText(
    path.join(oasisRepoRoot, 'docs', 'api', 'class', 'Others', 'APawn.md'),
    [
      '# APawn',
      '',
      'Pawn can be possessed by a controller.',
      ''
    ].join('\n')
  );

  await writeText(
    path.join(oasisRepoRoot, 'docs', 'wiki', 'article-index.tsv'),
    [
      'id\ttitle\twiki_path\turl\tfile',
      '101\tActor 生命周期\tGameplay/BeginPlay 生命周期\thttps://example.invalid/wiki/actor-lifecycle\tdocs/wiki/Gameplay/101_Actor生命周期.md'
    ].join('\n')
  );

  await writeText(
    path.join(oasisRepoRoot, 'docs', 'wiki', 'Gameplay', '101_Actor生命周期.md'),
    [
      '# Actor 生命周期',
      '',
      '当对象需要管理出生和销毁时，可以先检查 AActor 的生命周期函数和相关 Wiki 说明。',
      '',
      '常见排查点包括 BeginPlay、EndPlay 和销毁时机。',
      ''
    ].join('\n')
  );

  return {
    projectRoot,
    oasisRepoRoot
  };
}

test('verify-api finds an existing API document under the oasis-skill-plus submodule', async () => {
  const fixture = await createFixtureProject();

  try {
    const result = await runQueryScript([
      '--project-root',
      fixture.projectRoot,
      '--scope',
      'api',
      '--mode',
      'verify-api',
      '--query',
      'AActor'
    ]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.mode, 'verify-api');
    assert.equal(payload.scope, 'api');
    assert.equal(payload.query, 'AActor');
    assert.equal(payload.oasisRepoRoot, fixture.oasisRepoRoot);
    assert.equal(payload.matches.length, 1);
    assert.equal(payload.matches[0].type, 'api');
    assert.equal(payload.matches[0].matchType, 'symbol-index');
    assert.equal(payload.matches[0].title, 'AActor');
    assert.equal(payload.matches[0].relativePath, 'docs/api/class/Others/AActor.md');
    assert.equal(payload.matches[0].family, 'class');
    assert.equal(
      payload.matches[0].absolutePath,
      path.join(fixture.oasisRepoRoot, 'docs', 'api', 'class', 'Others', 'AActor.md')
    );
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test('verify-api returns an empty result when the requested API does not exist', async () => {
  const fixture = await createFixtureProject();

  try {
    const result = await runQueryScript([
      '--project-root',
      fixture.projectRoot,
      '--scope',
      'api',
      '--mode',
      'verify-api',
      '--query',
      'MissingApi'
    ]);

    assert.equal(result.exitCode, 0);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.matches.length, 0);
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test('search returns wiki matches with excerpts and relative paths', async () => {
  const fixture = await createFixtureProject();

  try {
    const result = await runQueryScript([
      '--project-root',
      fixture.projectRoot,
      '--scope',
      'wiki',
      '--mode',
      'search',
      '--query',
      'Gameplay/BeginPlay'
    ]);

    assert.equal(result.exitCode, 0);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.matches.length, 1);
    assert.equal(payload.matches[0].type, 'wiki');
    assert.equal(payload.matches[0].matchType, 'article-index');
    assert.equal(payload.matches[0].title, 'Actor 生命周期');
    assert.equal(payload.matches[0].relativePath, 'docs/wiki/Gameplay/101_Actor生命周期.md');
    assert.match(payload.matches[0].excerpt, /BeginPlay/);
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test('script prints human-readable text and respects --limit', async () => {
  const fixture = await createFixtureProject();

  try {
    const result = await runQueryScript([
      '--project-root',
      fixture.projectRoot,
      '--scope',
      'api',
      '--mode',
      'search',
      '--query',
      'class',
      '--format',
      'text',
      '--limit',
      '1'
    ]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /ok: true/);
    assert.match(result.stdout, /matches:/);
    assert.match(result.stdout, /1\. \[api\]/);
    assert.doesNotMatch(result.stdout, /2\. \[api\]/);
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test('script rejects an unsupported --family value as INVALID_ARGUMENTS', async () => {
  const fixture = await createFixtureProject();

  try {
    const result = await runQueryScript([
      '--project-root',
      fixture.projectRoot,
      '--scope',
      'api',
      '--mode',
      'verify-api',
      '--query',
      'AActor',
      '--family',
      'bad-family'
    ]);

    assert.equal(result.exitCode, 1);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'INVALID_ARGUMENTS');
    assert.match(payload.error.message, /family/i);
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test('parseArgs treats --exact as a boolean flag without consuming the next option', () => {
  const parsed = parseArgs([
    '--project-root',
    'C:/project',
    '--scope',
    'api',
    '--mode',
    'verify-api',
    '--query',
    'AActor',
    '--exact',
    '--format',
    'text'
  ]);

  assert.equal(parsed.projectRoot, 'C:/project');
  assert.equal(parsed.scope, 'api');
  assert.equal(parsed.mode, 'verify-api');
  assert.equal(parsed.query, 'AActor');
  assert.equal(parsed.exact, true);
  assert.equal(parsed.format, 'text');
});

test('parseArgs allows known value options to receive values that start with --', () => {
  const parsed = parseArgs(['--mode', 'search', '--query', '--foo']);

  assert.equal(parsed.mode, 'search');
  assert.equal(parsed.query, '--foo');
});

test('parseArgs rejects unknown option names as INVALID_ARGUMENTS', () => {
  assert.throws(
    () => parseArgs(['--bad']),
    (error) => {
      assert.equal(error.code, 'INVALID_ARGUMENTS');
      assert.match(error.message, /unknown/i);
      return true;
    }
  );
});

test('script returns a structured error when the oasis-skill-plus submodule is missing', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'oasis-docs-missing-repo-'));

  try {
    const result = await runQueryScript([
      '--project-root',
      projectRoot,
      '--scope',
      'api',
      '--mode',
      'verify-api',
      '--query',
      'AActor'
    ]);

    assert.equal(result.exitCode, 1);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'OASIS_REPO_NOT_FOUND');
    assert.match(payload.error.message, /oasis-skill-plus/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('script returns a structured error when the requested docs scope is missing', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'oasis-docs-missing-scope-'));
  const oasisRepoRoot = path.join(projectRoot, 'oasis-skill-plus');
  await mkdir(path.join(oasisRepoRoot, 'docs', 'wiki'), { recursive: true });

  try {
    const result = await runQueryScript([
      '--project-root',
      projectRoot,
      '--scope',
      'api',
      '--mode',
      'verify-api',
      '--query',
      'AActor'
    ]);

    assert.equal(result.exitCode, 1);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'DOCS_SCOPE_MISSING');
    assert.match(payload.error.message, /docs\/api/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('script validates required arguments before running the query', async () => {
  const fixture = await createFixtureProject();

  try {
    const result = await runQueryScript([
      '--project-root',
      fixture.projectRoot,
      '--scope',
      'api',
      '--mode',
      'verify-api'
    ]);

    assert.equal(result.exitCode, 1);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'INVALID_ARGUMENTS');
    assert.match(payload.error.message, /query/i);
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test('script returns INVALID_ARGUMENTS for unknown arguments', async () => {
  const result = await runQueryScript(['--unknown']);

  assert.equal(result.exitCode, 1);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'INVALID_ARGUMENTS');
  assert.match(payload.error.message, /unknown/i);
});

test('script returns INVALID_ARGUMENTS when an option is missing its value', async () => {
  const result = await runQueryScript([
    '--project-root',
    'C:/project',
    '--scope',
    'api',
    '--mode',
    'verify-api',
    '--query'
  ]);

  assert.equal(result.exitCode, 1);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'INVALID_ARGUMENTS');
  assert.match(payload.error.message, /missing value/i);
});
