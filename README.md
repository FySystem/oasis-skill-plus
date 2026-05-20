# oasis-skill-plus

`oasis-skill-plus` 是一个面向绿洲启元官方文档的本地化工具仓库，提供两类能力：

1. 把 Oasis 官方 Wiki 与 API 文档同步到本地，生成可检索、可版本管理的 Markdown。
2. 提供 `oasis-official-docs` 查询型 skill，供其他项目在回答问题、核对 API、编写代码前先查本地官方文档。

这个仓库适合两类使用方式：

- 直接把它当作文档同步仓库使用。
- 把它作为其他项目中的固定目录或子模块使用，为 AI / skill 提供本地官方文档数据源。

## 核心能力

- 同步 Oasis Wiki 到 `docs/wiki`
- 同步 Oasis API 到 `docs/api`
- 自动生成索引页与本地图片资源
- 使用 manifest 记录同步状态，支持增量更新、重命名、删除清理
- 提供 `query-oasis-docs.mjs` 脚本，按 API / Wiki / 全量范围做本地检索
- 提供 `oasis-official-docs` skill，约束 AI 先查证再回答，减少 API 幻觉

## 目录结构

```text
oasis-skill-plus/
├─ docs/
│  ├─ api/                          # 同步后的 API Markdown
│  ├─ wiki/                         # 同步后的 Wiki Markdown
│  └─ skills/
│     └─ oasis-official-docs.md     # skill 的安装与使用说明
├─ skills/
│  └─ oasis-official-docs/
│     ├─ SKILL.md
│     ├─ agents/
│     └─ scripts/
│        └─ query-oasis-docs.mjs    # 本地文档查询脚本
├─ src/
│  ├─ cli.mjs
│  ├─ cli-runner.mjs
│  ├─ sync.mjs                      # Wiki 同步
│  └─ api-sync.mjs                  # API 同步
├─ tests/
├─ .oasis-sync/                     # 同步 manifest
├─ 双击运行同步Wiki.cmd
├─ 双击运行同步API.cmd
└─ 双击运行同步Wiki+API.cmd
```

## 环境要求

- Node.js 18+

说明：

- 仓库使用了原生 `fetch` 和 `node:test`，因此建议直接使用 Node.js 18 或更高版本。
- `package.json` 中没有第三方依赖，通常不需要安装额外 npm 包即可运行。

## 快速开始

### 1. 克隆仓库

```bash
git clone <your-repo-url>
cd oasis-skill-plus
```

### 2. 执行同步

使用 npm script：

```bash
npm run sync
npm run sync:api
npm run sync:all
```

或直接执行：

```bash
node src/cli.mjs sync
node src/cli.mjs sync-api
node src/cli.mjs sync-all
```

在 Windows 下，也可以直接双击以下脚本：

- `双击运行同步Wiki.cmd`
- `双击运行同步API.cmd`
- `双击运行同步Wiki+API.cmd`

## 同步命令说明

### `sync`

同步 Oasis Wiki 文档。

- 远端来源：`https://developer.gp.qq.com/wikieditor`
- 输出目录：`docs/wiki`
- 额外产物：
  - `docs/wiki/000_索引.md`
  - `docs/wiki/_assets/images/`
  - `.oasis-sync/manifest.json`

### `sync-api`

同步 Oasis API 文档。

- 远端来源：`https://developer.gp.qq.com/api`
- 输出目录：`docs/api`
- 当前覆盖的 API 家族：
  - `class`
  - `cppenum`
  - `cppstruct`
  - `globalfunc`
- 额外产物：
  - `docs/api/000_索引.md`
  - `docs/api/<family>/000_索引.md`
  - `.oasis-sync/api-manifest.json`

### `sync-all`

按顺序先同步 Wiki，再同步 API，并输出总耗时。

## 输出结果说明

同步完成后，这个仓库会成为一个本地官方文档镜像，适合直接阅读、全文检索、纳入版本管理，或被其他项目当作只读文档源使用。

### Wiki 输出

- 每篇词条会生成到 `docs/wiki/<分类路径>/<文章ID>_<标题>.md`
- 词条中的官方 Wiki 链接会被改写为本地相对链接
- 词条中的远程图片会下载到 `docs/wiki/_assets/images/`
- 会自动生成 `docs/wiki/000_索引.md`

### API 输出

- API 详情页会生成到 `docs/api/<family>/.../*.md`
- API 文档之间的类型链接会改写为本地相对链接
- 会自动生成根索引和各 family 索引

### Manifest

`.oasis-sync` 下的 manifest 用于记录：

- 上次同步时间
- 远端版本信息
- 已生成的文档路径
- 已下载的图片映射

这让仓库能够在后续同步时正确处理新增、更新、重命名和删除。

## 在其他项目中接入 `oasis-official-docs`

如果你希望在另一个项目里查询本地绿洲启源官方文档，推荐把本仓库放在目标项目根目录下，目录名保持为 `oasis-skill-plus`。

推荐目录结构：

```text
ProjectA/
├─ oasis-skill-plus/
│  ├─ docs/api/
│  ├─ docs/wiki/
│  └─ skills/oasis-official-docs/
└─ skills/
   └─ oasis-official-docs/
```

关键约定：

- 目标项目根目录默认视为 `ProjectA/`
- 文档仓库默认查找 `ProjectA/oasis-skill-plus`
- 官方文档默认读取 `ProjectA/oasis-skill-plus/docs/api` 与 `ProjectA/oasis-skill-plus/docs/wiki`

接入步骤：

1. 在目标项目根目录放置本仓库，目录名保持为 `oasis-skill-plus`
2. 先执行过一次同步，或确保仓库内已有 `docs/api` 与 `docs/wiki`
3. 将 `skills/oasis-official-docs` 安装或复制到目标项目可发现的 skill 目录
4. 在目标项目中优先通过该 skill 或查询脚本核对本地官方文档，而不是直接凭记忆回答

补充说明：

- 如果当前环境支持直接发现仓库内 skill，也可以直接复用 `skills/oasis-official-docs`
- 如果脚本返回 `OASIS_REPO_NOT_FOUND` 或 `DOCS_SCOPE_MISSING`，说明目录布局或文档范围不符合约定，应先修复目录问题

## 查询脚本用法

查询脚本位于：

```text
skills/oasis-official-docs/scripts/query-oasis-docs.mjs
```

通用用法：

```bash
node skills/oasis-official-docs/scripts/query-oasis-docs.mjs \
  --project-root <path> \
  --scope api|wiki|all \
  --mode verify-api|search \
  --query "<关键词或 API 名称>"
```

常见示例：

```bash
node skills/oasis-official-docs/scripts/query-oasis-docs.mjs --project-root . --scope api --mode verify-api --query "AActor"
node skills/oasis-official-docs/scripts/query-oasis-docs.mjs --project-root . --scope wiki --mode search --query "生命周期"
node skills/oasis-official-docs/scripts/query-oasis-docs.mjs --project-root . --scope all --mode search --query "背包"
```

参数说明：

- `--project-root`：目标项目根目录，脚本会在其下寻找 `oasis-skill-plus`
- `--scope`：查询范围，支持 `api`、`wiki`、`all`
- `--mode`：
  - `verify-api`：优先用于确认某个 API 是否真实存在
  - `search`：用于通用搜索
- `--query`：查询词，必填

返回结果为 JSON，常用字段包括：

- `matches[].type`：命中来源，`api` 或 `wiki`
- `matches[].matchType`：命中方式，如 `exact-title`、`exact-filename`、`title`、`content`
- `matches[].title`：文档标题或符号名
- `matches[].relativePath`：相对 `oasis-skill-plus` 根目录的路径
- `matches[].absolutePath`：本地绝对路径
- `matches[].excerpt`：命中摘录

## 推荐使用方式

### 作为同步仓库

适合以下场景：

- 需要把 Oasis 官方 Wiki 与 API 资料沉淀到本地
- 希望对同步结果进行版本管理
- 希望后续用任意全文检索工具搜索文档

### 作为其他项目的文档子模块

适合以下场景：

- 让 AI 在写绿洲启源相关代码前先核实 API 是否存在
- 让 AI 在回答编辑器、玩法、生命周期等问题前先查官方 Wiki
- 在团队项目里提供统一、可复现的本地官方资料源

## 测试

运行全部测试：

```bash
npm test
```

测试覆盖的重点包括：

- CLI 路由与中文提示
- Wiki / API 同步逻辑
- 索引生成与链接改写
- manifest 稳定性
- Windows 启动脚本行为
- `query-oasis-docs.mjs` 的查询与错误返回

## 注意事项

- 默认使用本地已同步好的 Markdown，不会每次查询都自动刷新远端数据
- 只有在用户明确要求“最新”“当前”“刷新后再看”时，才建议执行同步命令
- `verify-api` 应优先用于确认 API 是否真实存在，避免把猜测当成官方事实
- Wiki 文档可以解释流程和问题排查，但不能替代 API 存在性校验

## 相关文档

- `docs/skills/oasis-official-docs.md`
- `skills/oasis-official-docs/SKILL.md`
