import test from 'node:test';
import assert from 'node:assert/strict';

import { renderApiMarkdown } from '../src/api-markdown.mjs';

test('renderApiMarkdown renders class details with linked sections', () => {
  const markdown = renderApiMarkdown({
    family: 'class',
    detail: {
      Name: 'UGCPlayerControllerSystem',
      Description: '玩家控制器系统',
      Parents: ['UBlueprintFunctionLibrary'],
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
      Event: null,
      Delegate: null,
      Language: 'Lua'
    },
    outputPath: 'docs/api/class/和平全局接口/角色系统/UGCPlayerControllerSystem.md',
    outputPathBySourcePath: new Map([
      ['cppstruct/detail/FVector.json', 'docs/api/cppstruct/F/FV/FVector.md'],
      ['cppenum/detail/AI_Phase.json', 'docs/api/cppenum/A/AI/AI_Phase.md']
    ]),
    uniqueOutputPathByName: new Map([
      ['UBlueprintFunctionLibrary', 'docs/api/class/Others/UBlueprintFunctionLibrary.md']
    ])
  });

  assert.match(markdown, /^# UGCPlayerControllerSystem/m);
  assert.match(markdown, /^## Parents$/m);
  assert.match(markdown, /\[UBlueprintFunctionLibrary\]\(\.\.\/\.\.\/Others\/UBlueprintFunctionLibrary\.md\)/);
  assert.match(markdown, /^## Variables$/m);
  assert.match(markdown, /\[FVector\]\(\.\.\/\.\.\/\.\.\/cppstruct\/F\/FV\/FVector\.md\)/);
  assert.match(markdown, /^## Functions$/m);
  assert.match(markdown, /### GetCurrentPhase/);
  assert.match(markdown, /\[AI_Phase\]\(\.\.\/\.\.\/\.\.\/cppenum\/A\/AI\/AI_Phase\.md\)/);
});

test('renderApiMarkdown renders enum, struct, and global function markdown', () => {
  const enumMarkdown = renderApiMarkdown({
    family: 'cppenum',
    detail: {
      Name: 'AI_Phase',
      Description: '阶段枚举',
      Variables: [
        { Name: 'Born', Value: '0', Description: '出生' }
      ]
    },
    outputPath: 'docs/api/cppenum/A/AI/AI_Phase.md',
    outputPathBySourcePath: new Map(),
    uniqueOutputPathByName: new Map()
  });

  const structMarkdown = renderApiMarkdown({
    family: 'cppstruct',
    detail: {
      Name: 'FVector',
      Description: '三维向量',
      Variables: [
        { Name: 'X', Type: 'float', Description: 'X 分量', Redirect: '' }
      ]
    },
    outputPath: 'docs/api/cppstruct/F/FV/FVector.md',
    outputPathBySourcePath: new Map(),
    uniqueOutputPathByName: new Map()
  });

  const functionMarkdown = renderApiMarkdown({
    family: 'globalfunc',
    detail: {
      Name: 'TagLogRawPrint',
      Description: '输出原始日志',
      Params: [
        { Name: 'LogContent', Type: 'string', Description: '日志内容', Redirect: '' }
      ],
      Return: {
        Type: 'bool',
        Description: '是否成功'
      }
    },
    outputPath: 'docs/api/globalfunc/T/TA/TagLogRawPrint.md',
    outputPathBySourcePath: new Map(),
    uniqueOutputPathByName: new Map()
  });

  assert.match(enumMarkdown, /^## Values$/m);
  assert.match(enumMarkdown, /\| Born \| 0 \| 出生 \|/);
  assert.match(structMarkdown, /^## Fields$/m);
  assert.match(structMarkdown, /\| X \| `float` \| X 分量 \|/);
  assert.match(functionMarkdown, /^## Parameters$/m);
  assert.match(functionMarkdown, /^## Return$/m);
});
