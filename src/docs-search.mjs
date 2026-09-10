import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';

const SUPPORTED_MODES = new Set(['verify-api', 'search']);
const SUPPORTED_SCOPES = new Set(['api', 'wiki', 'all']);
const SUPPORTED_FORMATS = new Set(['json', 'text']);
const SUPPORTED_FAMILIES = new Set(['class', 'cppenum', 'cppstruct', 'globalfunc']);

const API_INDEX_PATH = 'docs/api/symbol-index.tsv';
const WIKI_INDEX_PATH = 'docs/wiki/article-index.tsv';

export function createSearchError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

export function resolveOasisRepoRoot(projectRoot) {
  const root = path.resolve(projectRoot ?? process.cwd());
  const nested = path.join(root, 'oasis-skill-plus');
  const directRoot = path.basename(root) === 'oasis-skill-plus' ? root : null;

  if (isDirectory(path.join(nested, 'docs'))) {
    return nested;
  }

  if (directRoot && isDirectory(path.join(directRoot, 'docs'))) {
    return directRoot;
  }

  throw createSearchError(
    'OASIS_REPO_NOT_FOUND',
    `未找到 oasis-skill-plus 文档目录：已检查 ${path.join(root, 'oasis-skill-plus', 'docs')}`,
    { projectRoot: root, expectedPath: nested }
  );
}

export function createRgJsonRunner({ spawnImpl = spawn, rgPath = 'rg' } = {}) {
  return function runRgJson({ cwd, args = [] } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnImpl(rgPath, ['--json', ...args], {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        reject(mapSpawnError(error, rgPath));
        return;
      }

      const matches = [];
      let stdoutBuffer = '';
      let stderr = '';
      let settled = false;

      child.stdout?.setEncoding?.('utf8');
      child.stderr?.setEncoding?.('utf8');

      child.stdout?.on('data', (chunk) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.trim() === '') {
            continue;
          }
          try {
            const event = JSON.parse(line);
            if (event.type === 'match') {
              matches.push(event);
            }
          } catch (error) {
            settled = true;
            reject(createSearchError('RG_FAILED', '解析 rg JSON 输出失败。', { cause: error.message, line }));
          }
        }
      });

      child.stderr?.on('data', (chunk) => {
        stderr += chunk;
      });

      child.on('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(mapSpawnError(error, rgPath));
      });

      child.on('close', (exitCode) => {
        if (settled) {
          return;
        }
        settled = true;

        if (stdoutBuffer.trim() !== '') {
          try {
            const event = JSON.parse(stdoutBuffer);
            if (event.type === 'match') {
              matches.push(event);
            }
          } catch (error) {
            reject(createSearchError('RG_FAILED', '解析 rg JSON 输出失败。', { cause: error.message, line: stdoutBuffer }));
            return;
          }
        }

        if (exitCode === 0 || exitCode === 1) {
          resolve(exitCode === 1 ? [] : matches);
          return;
        }

        reject(createSearchError('RG_FAILED', `rg 执行失败，退出码 ${exitCode}。`, { exitCode, stderr }));
      });
    });
  };
}

export async function runDocsQuery(options = {}) {
  const normalized = normalizeOptions(options);
  const oasisRepoRoot = resolveOasisRepoRoot(normalized.projectRoot);
  const runRgJson = normalized.runRgJson ?? createRgJsonRunner();
  const warnings = [];
  const matches = [];

  const tasks = buildSearchTasks(oasisRepoRoot, normalized, warnings);
  // 最多四项独立检索并发执行；等待全部结束，再按原任务顺序合并，避免完成顺序改变结果优先级。
  const results = await Promise.allSettled(tasks.map(async (task) => runRgJson({
    cwd: oasisRepoRoot,
    args: task.args
  })));

  for (const [index, task] of tasks.entries()) {
    const result = results[index];
    if (result.status === 'rejected') {
      throw result.reason;
    }
    const events = result.value;

    for (const event of events) {
      const match = task.mapper(event, oasisRepoRoot, normalized);
      if (match) {
        matches.push(match);
      }
    }
  }

  return {
    ok: true,
    mode: normalized.mode,
    scope: normalized.scope,
    format: normalized.format,
    query: normalized.query,
    oasisRepoRoot,
    warnings,
    matches: dedupeMatches(matches).slice(0, normalized.limit)
  };
}

export function formatTextResult(payload) {
  const lines = [
    `ok: ${payload.ok}`,
    `scope: ${payload.scope}`,
    `mode: ${payload.mode}`,
    `query: ${payload.query}`
  ];

  if (payload.warnings?.length > 0) {
    lines.push('warnings:');
    for (const warning of payload.warnings) {
      lines.push(`- ${warning.code}: ${warning.message}`);
    }
  }

  if (!payload.matches || payload.matches.length === 0) {
    lines.push('No matches.');
    return lines.join('\n');
  }

  lines.push('matches:');
  payload.matches.forEach((match, index) => {
    lines.push(`${index + 1}. [${match.type}] ${match.title}`);
    lines.push(`   file: ${match.relativePath}`);
    lines.push(`   line: ${match.lineNumber}`);
    lines.push(`   excerpt: ${match.excerpt}`);
  });

  return lines.join('\n');
}

function normalizeOptions(options) {
  const mode = options.mode;
  const scope = options.scope;
  const format = options.format ?? 'json';
  const query = String(options.query ?? '').trim();
  const family = options.family;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 20;

  if (!SUPPORTED_MODES.has(mode)) {
    throw createSearchError('INVALID_ARGUMENTS', 'mode 只支持 verify-api / search。', { mode });
  }
  if (!SUPPORTED_SCOPES.has(scope)) {
    throw createSearchError('INVALID_ARGUMENTS', 'scope 只支持 api / wiki / all。', { scope });
  }
  if (!SUPPORTED_FORMATS.has(format)) {
    throw createSearchError('INVALID_ARGUMENTS', 'format 只支持 json / text。', { format });
  }
  if (query === '') {
    throw createSearchError('INVALID_ARGUMENTS', 'query 必填且不能为空。');
  }
  if (mode === 'verify-api' && scope === 'wiki') {
    throw createSearchError('INVALID_ARGUMENTS', 'verify-api 不允许 scope=wiki。', { mode, scope });
  }
  if (family !== undefined && !SUPPORTED_FAMILIES.has(family)) {
    throw createSearchError('INVALID_ARGUMENTS', 'family 只支持 class / cppenum / cppstruct / globalfunc。', { family });
  }

  return {
    ...options,
    mode,
    scope,
    format,
    query,
    family,
    limit
  };
}

function buildSearchTasks(oasisRepoRoot, options, warnings) {
  const tasks = [];
  const includeApi = options.mode === 'verify-api' || options.scope === 'api' || options.scope === 'all';
  const includeWiki = options.mode !== 'verify-api' && (options.scope === 'wiki' || options.scope === 'all');

  if (includeApi) {
    const hasApiIndex = existsSync(path.join(oasisRepoRoot, API_INDEX_PATH));
    if (hasApiIndex) {
      tasks.push({
        args: buildTsvArgs(API_INDEX_PATH, options, 'api'),
        mapper: mapApiIndexMatch
      });
    } else {
      warnings.push({
        code: 'INDEX_MISSING',
        message: buildIndexMissingMessage(API_INDEX_PATH, options)
      });
    }

    const shouldSearchApiMarkdown = !options.exact && !(options.mode === 'verify-api' && hasApiIndex);
    const apiMarkdownTarget = options.family ? `docs/api/${options.family}` : 'docs/api';
    if (shouldSearchApiMarkdown && isDirectory(path.join(oasisRepoRoot, apiMarkdownTarget))) {
      tasks.push({
        args: buildMarkdownArgs(options.query, apiMarkdownTarget),
        mapper: mapMarkdownMatch
      });
    }
  }

  if (includeWiki) {
    const hasWikiIndex = existsSync(path.join(oasisRepoRoot, WIKI_INDEX_PATH));
    if (hasWikiIndex) {
      tasks.push({
        args: buildTsvArgs(WIKI_INDEX_PATH, options, 'wiki'),
        mapper: mapWikiIndexMatch
      });
    } else {
      warnings.push({
        code: 'INDEX_MISSING',
        message: buildIndexMissingMessage(WIKI_INDEX_PATH, options)
      });
    }

    if (!options.exact && isDirectory(path.join(oasisRepoRoot, 'docs/wiki'))) {
      tasks.push({
        args: buildMarkdownArgs(options.query, 'docs/wiki'),
        mapper: mapMarkdownMatch
      });
    }
  }

  return tasks;
}

function buildTsvArgs(indexPath, options, indexType) {
  if (options.mode === 'verify-api' && indexType === 'api') {
    const pattern = options.family
      ? `^${escapeRegex(options.family)}\\t${escapeRegex(options.query)}\\t`
      : `^[^\\t]+\\t${escapeRegex(options.query)}\\t`;
    return ['--ignore-case', pattern, indexPath];
  }

  if (options.exact) {
    return ['--ignore-case', `\\t${escapeRegex(options.query)}\\t`, indexPath];
  }

  return ['--fixed-strings', '--ignore-case', '--regexp', options.query, indexPath];
}

function buildMarkdownArgs(query, targetPath) {
  return ['--fixed-strings', '--ignore-case', '--glob', '*.md', '--glob', '!**/000_*.md', '--regexp', query, targetPath];
}

function buildIndexMissingMessage(indexPath, options) {
  if (options.exact) {
    return `${indexPath} is missing; exact search requires the index, so Markdown fallback was skipped.`;
  }

  return `${indexPath} is missing; searched Markdown files directly.`;
}

function mapApiIndexMatch(event, oasisRepoRoot, options = {}) {
  if (getEventLineNumber(event) === 1) {
    return null;
  }

  const row = parseApiIndexLine(getEventLine(event));
  if (!row) {
    return null;
  }

  if (options.family && row.kind !== options.family) {
    return null;
  }

  const pathInfo = resolveSafeRelativePath(row.markdown_file, oasisRepoRoot);
  if (!pathInfo) {
    return null;
  }

  return {
    type: 'api',
    matchType: 'symbol-index',
    title: row.name,
    relativePath: pathInfo.relativePath,
    absolutePath: pathInfo.absolutePath,
    excerpt: row.description || row.symbol_path,
    lineNumber: getEventLineNumber(event),
    family: row.kind,
    sourceJsonUrl: row.source_json_url
  };
}

function mapWikiIndexMatch(event, oasisRepoRoot) {
  if (getEventLineNumber(event) === 1) {
    return null;
  }

  const row = parseWikiIndexLine(getEventLine(event));
  if (!row) {
    return null;
  }

  const pathInfo = resolveSafeRelativePath(row.file, oasisRepoRoot);
  if (!pathInfo) {
    return null;
  }

  return {
    type: 'wiki',
    matchType: 'article-index',
    title: row.title,
    relativePath: pathInfo.relativePath,
    absolutePath: pathInfo.absolutePath,
    excerpt: row.wiki_path || row.title,
    lineNumber: getEventLineNumber(event),
    sourceUrl: row.url
  };
}

function mapMarkdownMatch(event, oasisRepoRoot) {
  const pathInfo = resolveSafeRelativePath(getEventPath(event), oasisRepoRoot);
  if (!pathInfo) {
    return null;
  }

  const baseName = path.basename(pathInfo.relativePath, '.md').replace(/^\d+_+/, '');

  return {
    type: pathInfo.relativePath.startsWith('docs/api/') ? 'api' : 'wiki',
    matchType: 'content',
    title: baseName,
    relativePath: pathInfo.relativePath,
    absolutePath: pathInfo.absolutePath,
    excerpt: getEventLine(event).trimEnd(),
    lineNumber: getEventLineNumber(event)
  };
}

function parseApiIndexLine(line) {
  const cells = stripLineEnd(line).split('\t');
  if (cells.length < 7) {
    return null;
  }

  return {
    kind: cells[0],
    name: cells[1],
    symbol_path: cells[2],
    source_json_path: cells[3],
    source_json_url: cells[4],
    markdown_file: cells[5],
    description: cells.slice(6).join('\t')
  };
}

function parseWikiIndexLine(line) {
  const cells = stripLineEnd(line).split('\t');
  if (cells.length < 5) {
    return null;
  }

  return {
    id: cells[0],
    title: cells[1],
    wiki_path: cells[2],
    url: cells[3],
    file: cells[4]
  };
}

function dedupeMatches(matches) {
  const seen = new Set();
  const result = [];

  for (const match of matches) {
    const key = `${match.relativePath}:${match.lineNumber}:${match.excerpt}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(match);
  }

  return result;
}

function getEventLine(event) {
  return event?.data?.lines?.text ?? '';
}

function getEventPath(event) {
  return event?.data?.path?.text ?? event?.data?.path?.path ?? '';
}

function getEventLineNumber(event) {
  return event?.data?.line_number ?? event?.data?.lineNumber ?? 0;
}

function resolveSafeRelativePath(inputPath, oasisRepoRoot) {
  const rawPath = String(inputPath ?? '');
  if (rawPath.trim() === '') {
    return null;
  }

  const normalizedInput = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (path.isAbsolute(rawPath) || path.posix.isAbsolute(normalizedInput)) {
    return null;
  }

  const absolutePath = path.resolve(oasisRepoRoot, ...normalizedInput.split('/'));
  const resolvedRoot = path.resolve(oasisRepoRoot);

  if (absolutePath !== resolvedRoot && !absolutePath.startsWith(`${resolvedRoot}${path.sep}`)) {
    return null;
  }

  return {
    relativePath: path.relative(resolvedRoot, absolutePath).replace(/\\/g, '/'),
    absolutePath
  };
}

function isDirectory(targetPath) {
  try {
    return statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function stripLineEnd(line) {
  return String(line ?? '').replace(/\r?\n$/, '');
}

function escapeRegex(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function mapSpawnError(error, rgPath) {
  if (error?.code === 'ENOENT') {
    return createSearchError('RG_NOT_FOUND', `找不到 rg 可执行文件：${rgPath}`, { rgPath });
  }

  return createSearchError('RG_FAILED', '启动 rg 失败。', { cause: error?.message, rgPath });
}
