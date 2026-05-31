import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';

import {
  buildApiOutputPath,
  normalizeApiSourcePath,
  loadApiManifest,
  syncApi
} from '../src/api-sync.mjs';

function createApiClientFixture({
  classCatalog,
  sortedCatalogs,
  details,
  failSourcePath
}) {
  return {
    async fetchClassCatalog() {
      return classCatalog;
    },
    async fetchSortedCatalog(family) {
      return sortedCatalogs[family];
    },
    async fetchDetail(_family, sourcePath) {
      if (sourcePath === failSourcePath) {
        throw new Error(`failed detail ${sourcePath}`);
      }

      const detail = details[sourcePath];
      if (!detail) {
        throw new Error(`missing detail fixture: ${sourcePath}`);
      }

      return detail;
    }
  };
}

test('normalizeApiSourcePath converts detail/class paths and preserves existing family detail paths', () => {
  assert.equal(
    normalizeApiSourcePath('class', 'detail/class/和平全局接口/角色系统/UGCPlayerControllerSystem.json'),
    'class/detail/和平全局接口/角色系统/UGCPlayerControllerSystem.json'
  );
  assert.equal(
    normalizeApiSourcePath('cppenum', 'cppenum/detail/AI_Phase.json'),
    'cppenum/detail/AI_Phase.json'
  );
});

test('buildApiOutputPath maps class and sorted families to local markdown paths', () => {
  assert.equal(
    buildApiOutputPath({
      family: 'class',
      sourcePath: 'class/detail/和平全局接口/角色系统/UGCPlayerControllerSystem.json',
      bucketPath: []
    }),
    'docs/api/class/和平全局接口/角色系统/UGCPlayerControllerSystem.md'
  );
  assert.equal(
    buildApiOutputPath({
      family: 'cppenum',
      sourcePath: 'cppenum/detail/AI_Phase.json',
      bucketPath: ['A', 'AI']
    }),
    'docs/api/cppenum/A/AI/AI_Phase.md'
  );
});

test('syncApi writes API docs, indexes, and manifest from fixtures', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-api-sync-'));
  const client = createApiClientFixture({
    classCatalog: [
      {
        Name: '和平全局接口',
        Label: '和平全局接口',
        Type: 'directory',
        Path: '',
        Children: [
          {
            Name: '角色系统',
            Label: '角色系统',
            Type: 'directory',
            Path: '',
            Children: [
              {
                Name: 'UGCPlayerControllerSystem',
                Label: 'UGCPlayerControllerSystem',
                Type: 'class',
                Path: 'detail/class/和平全局接口/角色系统/UGCPlayerControllerSystem.json',
                Children: null
              }
            ]
          }
        ]
      }
    ],
    sortedCatalogs: {
      cppenum: { A: { AI: { AI_Phase: 'cppenum/detail/AI_Phase.json' } } },
      cppstruct: { F: { FV: { FVector: 'cppstruct/detail/FVector.json' } } },
      globalfunc: { T: { TA: { TagLogRawPrint: 'globalfunc/detail/TagLogRawPrint.json' } } }
    },
    details: {
      'class/detail/和平全局接口/角色系统/UGCPlayerControllerSystem.json': {
        Name: 'UGCPlayerControllerSystem',
        Description: '玩家控制器系统',
        Variables: [
          {
            Name: 'SpawnLocation',
            Type: 'FVector',
            Description: '出生位置',
            Redirect: 'cppstruct/detail/FVector.json'
          }
        ],
        Functions: [
          {
            Name: 'GetCurrentPhase',
            Description: '获取当前阶段',
            Params: [
              {
                Name: 'Phase',
                Type: 'AI_Phase',
                Description: '阶段输出',
                Redirect: 'cppenum/detail/AI_Phase.json'
              }
            ],
            Return: {
              Type: 'bool',
              Description: '是否成功'
            }
          }
        ],
        Parents: ['UBlueprintFunctionLibrary'],
        Event: null,
        Delegate: null,
        Language: 'Lua'
      },
      'cppenum/detail/AI_Phase.json': {
        Name: 'AI_Phase',
        Description: '阶段枚举',
        Variables: [{ Name: 'Born', Value: '0', Description: '出生' }]
      },
      'cppstruct/detail/FVector.json': {
        Name: 'FVector',
        Description: '三维向量',
        Variables: [{ Name: 'X', Type: 'float', Description: 'X 分量', Redirect: '' }]
      },
      'globalfunc/detail/TagLogRawPrint.json': {
        Name: 'TagLogRawPrint',
        Description: '输出原始日志',
        Params: [{ Name: 'LogContent', Type: 'string', Description: '日志内容', Redirect: '' }],
        Return: { Type: 'bool', Description: '是否成功' }
      }
    }
  });

  try {
    const result = await syncApi({ rootDir, client });
    const classDoc = path.join(
      rootDir,
      'docs',
      'api',
      'class',
      '和平全局接口',
      '角色系统',
      'UGCPlayerControllerSystem.md'
    );
    const familyIndex = path.join(rootDir, 'docs', 'api', 'cppenum', '000_索引.md');
    const rootIndex = path.join(rootDir, 'docs', 'api', '000_索引.md');
    const symbolIndex = path.join(rootDir, 'docs', 'api', 'symbol-index.tsv');
    const manifestPath = path.join(rootDir, '.oasis-sync', 'api-manifest.json');

    assert.equal(result.totalEntities, 4);
    assert.equal(result.createdCount, 4);
    assert.equal(result.updatedCount, 0);
    assert.equal(result.deletedCount, 0);

    const classDocText = await readFile(classDoc, 'utf8');
    const familyIndexText = await readFile(familyIndex, 'utf8');
    const rootIndexText = await readFile(rootIndex, 'utf8');
    const symbolIndexText = await readFile(symbolIndex, 'utf8');
    const manifest = await loadApiManifest(manifestPath);

    assert.match(classDocText, /\[FVector\]\(\.\.\/\.\.\/\.\.\/cppstruct\/F\/FV\/FVector\.md\)/);
    assert.match(classDocText, /\[AI_Phase\]\(\.\.\/\.\.\/\.\.\/cppenum\/A\/AI\/AI_Phase\.md\)/);
    assert.match(familyIndexText, /\[AI_Phase\]\(\.\/A\/AI\/AI_Phase\.md\)/);
    assert.match(rootIndexText, /\[class 索引\]\(\.\/class\/000_索引\.md\)/);
    assert.equal(
      symbolIndexText.split('\n')[0],
      'kind\tname\tsymbol_path\tsource_json_path\tsource_json_url\tmarkdown_file\tdescription'
    );
    assert.match(
      symbolIndexText,
      /class\tUGCPlayerControllerSystem\t和平全局接口 \/ 角色系统 \/ UGCPlayerControllerSystem\tclass\/detail\/和平全局接口\/角色系统\/UGCPlayerControllerSystem\.json\thttps:\/\/developer\.gp\.qq\.com\/api\/class\/detail\/和平全局接口\/角色系统\/UGCPlayerControllerSystem\.json\tdocs\/api\/class\/和平全局接口\/角色系统\/UGCPlayerControllerSystem\.md\t玩家控制器系统/
    );
    assert.match(
      symbolIndexText,
      /cppenum\tAI_Phase\tA \/ AI \/ AI_Phase\tcppenum\/detail\/AI_Phase\.json\thttps:\/\/developer\.gp\.qq\.com\/api\/cppenum\/detail\/AI_Phase\.json\tdocs\/api\/cppenum\/A\/AI\/AI_Phase\.md\t阶段枚举/
    );
    assert.equal(manifest.entities.length, 4);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('syncApi is stable on a second run with identical fixtures', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-api-repeat-'));
  const client = createApiClientFixture({
    classCatalog: [],
    sortedCatalogs: {
      cppenum: { A: { AI: { AI_Phase: 'cppenum/detail/AI_Phase.json' } } },
      cppstruct: {},
      globalfunc: {}
    },
    details: {
      'cppenum/detail/AI_Phase.json': {
        Name: 'AI_Phase',
        Description: '阶段枚举',
        Variables: [{ Name: 'Born', Value: '0', Description: '出生' }]
      }
    }
  });

  try {
    await syncApi({ rootDir, client });
    const filePath = path.join(rootDir, 'docs', 'api', 'cppenum', 'A', 'AI', 'AI_Phase.md');
    const firstStat = await stat(filePath);

    const result = await syncApi({ rootDir, client });
    const secondStat = await stat(filePath);

    assert.equal(result.createdCount, 0);
    assert.equal(result.updatedCount, 0);
    assert.equal(result.deletedCount, 0);
    assert.equal(secondStat.mtimeMs, firstStat.mtimeMs);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('syncApi does not delete existing docs when a later detail fetch fails', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-api-fail-'));
  const stableClient = createApiClientFixture({
    classCatalog: [],
    sortedCatalogs: {
      cppenum: { A: { AI: { AI_Phase: 'cppenum/detail/AI_Phase.json' } } },
      cppstruct: {},
      globalfunc: {}
    },
    details: {
      'cppenum/detail/AI_Phase.json': {
        Name: 'AI_Phase',
        Description: '阶段枚举',
        Variables: [{ Name: 'Born', Value: '0', Description: '出生' }]
      }
    }
  });

  const failingClient = createApiClientFixture({
    classCatalog: [],
    sortedCatalogs: {
      cppenum: { A: { AI: { AI_Phase: 'cppenum/detail/AI_Phase.json' } } },
      cppstruct: {},
      globalfunc: {}
    },
    details: {
      'cppenum/detail/AI_Phase.json': {
        Name: 'AI_Phase',
        Description: '阶段枚举',
        Variables: [{ Name: 'Born', Value: '0', Description: '出生' }]
      }
    },
    failSourcePath: 'cppenum/detail/AI_Phase.json'
  });

  try {
    await syncApi({ rootDir, client: stableClient });
    const stableFile = path.join(rootDir, 'docs', 'api', 'cppenum', 'A', 'AI', 'AI_Phase.md');

    await assert.rejects(() => syncApi({ rootDir, client: failingClient }), /failed detail/);
    const text = await readFile(stableFile, 'utf8');
    assert.match(text, /# AI_Phase/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
