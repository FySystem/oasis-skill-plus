import path from 'node:path';
import process from 'node:process';
import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { formatTextResult, runDocsQuery } from '../../../src/docs-search.mjs';

const VALUE_OPTIONS = new Set([
  '--project-root',
  '--scope',
  '--mode',
  '--query',
  '--limit',
  '--format',
  '--family'
]);

function createCliError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function writeJson(payload, stream = process.stdout) {
  stream.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function writeText(payload, stream = process.stdout) {
  stream.write(`${payload}\n`);
}

function isDirectory(targetPath) {
  try {
    return statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function parseLimit(value) {
  if (!/^[1-9]\d*$/.test(String(value))) {
    throw createCliError('INVALID_ARGUMENTS', `Invalid --limit value "${value}". Expected a positive integer.`);
  }

  return Number(value);
}

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    projectRoot: process.cwd(),
    scope: 'all',
    format: 'json',
    limit: 20,
    exact: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === '--help') {
      options.help = true;
      continue;
    }

    if (current === '--exact') {
      options.exact = true;
      continue;
    }

    if (!current.startsWith('--')) {
      throw createCliError('INVALID_ARGUMENTS', `Unexpected positional argument: ${current}`);
    }

    if (!VALUE_OPTIONS.has(current)) {
      throw createCliError('INVALID_ARGUMENTS', `Unknown argument: ${current}`);
    }

    const next = argv[index + 1];
    if (next == null) {
      throw createCliError('INVALID_ARGUMENTS', `Missing value for ${current}`);
    }

    switch (current) {
      case '--project-root':
        options.projectRoot = next;
        break;
      case '--scope':
        options.scope = next;
        break;
      case '--mode':
        options.mode = next;
        break;
      case '--query':
        options.query = next;
        break;
      case '--limit':
        options.limit = parseLimit(next);
        break;
      case '--format':
        options.format = next;
        break;
      case '--family':
        options.family = next;
        break;
    }

    index += 1;
  }

  return options;
}

function createUsagePayload() {
  return {
    ok: true,
    usage:
      'node query-oasis-docs.mjs --project-root <path> --scope api|wiki|all --mode verify-api|search --query <text> [--format json|text] [--limit <n>] [--family class|cppenum|cppstruct|globalfunc] [--exact]',
    options: [
      '--project-root <path>',
      '--scope api|wiki|all',
      '--mode verify-api|search',
      '--query <text>',
      '--limit <n>',
      '--format json|text',
      '--family class|cppenum|cppstruct|globalfunc',
      '--exact',
      '--help'
    ]
  };
}

function createErrorPayload(error) {
  if (error.code) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {})
      }
    };
  }

  return {
    ok: false,
    error: {
      code: 'UNEXPECTED_ERROR',
      message: error.message
    }
  };
}

function getRequiredScopes(options) {
  if (options.mode === 'verify-api') {
    return ['api'];
  }

  if (options.scope === 'all') {
    return ['api', 'wiki'];
  }

  return [options.scope];
}

function validateScopeDirectories(payload, options) {
  for (const scope of getRequiredScopes(options)) {
    const expectedPath = path.join(payload.oasisRepoRoot, 'docs', scope);
    if (!isDirectory(expectedPath)) {
      throw createCliError(
        'DOCS_SCOPE_MISSING',
        `Expected docs/${scope} to exist under ${payload.oasisRepoRoot}.`,
        {
          scope,
          expectedPath
        }
      );
    }
  }
}

export async function runCli(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);

    if (options.help) {
      writeJson(createUsagePayload());
      return 0;
    }

    const payload = await runDocsQuery(options);
    validateScopeDirectories(payload, options);
    if (options.format === 'text') {
      writeText(formatTextResult(payload));
    } else {
      writeJson(payload);
    }

    return 0;
  } catch (error) {
    writeJson(createErrorPayload(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const exitCode = await runCli();
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}
