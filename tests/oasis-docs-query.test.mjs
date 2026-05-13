import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

const scriptPath = path.resolve('skills', 'oasis-official-docs', 'scripts', 'query-oasis-docs.mjs');

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
    assert.equal(payload.matches[0].matchType, 'exact-title');
    assert.equal(payload.matches[0].title, 'AActor');
    assert.equal(payload.matches[0].relativePath, 'docs/api/class/Others/AActor.md');
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
      'BeginPlay'
    ]);

    assert.equal(result.exitCode, 0);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.matches.length, 1);
    assert.equal(payload.matches[0].type, 'wiki');
    assert.equal(payload.matches[0].matchType, 'content');
    assert.equal(payload.matches[0].title, 'Actor 生命周期');
    assert.equal(payload.matches[0].relativePath, 'docs/wiki/Gameplay/101_Actor生命周期.md');
    assert.match(payload.matches[0].excerpt, /BeginPlay/);
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
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
