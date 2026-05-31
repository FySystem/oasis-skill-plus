# oasis-official-docs Skill 安装与使用

`oasis-official-docs` 是给其他项目使用的查询型 skill，不是给本仓库自身交互用的业务功能。
它依赖目标项目根目录下存在一个 `oasis-skill-plus` 子模块，并优先通过 `rg` 检索该子模块里的 TSV 索引与本地 Markdown 文档，查询绿洲启元官方 API 与 Wiki。

## 目录约定

目标项目建议采用下面的结构：

```text
ProjectA/
├─ oasis-skill-plus/              # 本仓库，作为子模块或独立克隆目录
│  ├─ docs/api/
│  ├─ docs/wiki/
│  └─ skills/oasis-official-docs/
└─ skills/
   └─ oasis-official-docs/        # 安装到目标项目可发现的 skill 目录
```

关键约束：

- skill 运行时默认把“当前项目根目录”视为 `ProjectA/`
- 文档仓库固定查找 `ProjectA/oasis-skill-plus`
- 官方文档真源固定为 `ProjectA/oasis-skill-plus/docs/api` 与 `ProjectA/oasis-skill-plus/docs/wiki`

## 安装步骤

1. 在目标项目根目录下放置本仓库，目录名保持为 `oasis-skill-plus`
2. 确保已经执行过同步，或者仓库里已经存在 `docs/api` 与 `docs/wiki`
3. 将 `skills/oasis-official-docs` 安装到目标项目可发现的 skill 目录
4. 在目标项目中优先用 `rg` 查询 API/Wiki；需要结构化输出或自动化校验时再调用该 skill 脚本，而不是直接让 AI 凭记忆回答

如果目标环境支持仓库内 skills 目录，也可以直接复用该目录；如果需要复制，请保持 `oasis-official-docs` 目录名不变。

## 默认行为

- API 相关问题、API 用法说明、API 代码生成前，先校验 API 是否存在
- Wiki 问题排查、功能说明、解决方法查询前，先搜索本地 Wiki
- 默认只读本地同步好的 Markdown
- 普通查询优先直接使用 `rg` 检索 TSV 索引：`docs/api/symbol-index.tsv` 与 `docs/wiki/article-index.tsv`
- 查询脚本仅作为稳定 JSON/text 输出与自动化校验包装层
- 只有用户明确要求“最新”“当前”“刷新后再看”时，才执行同步命令刷新数据

## 常用命令

从目标项目根目录优先直接执行：

```bash
rg --fixed-strings --line-number "AActor" oasis-skill-plus/docs/api/symbol-index.tsv
rg --fixed-strings --line-number "生命周期" oasis-skill-plus/docs/wiki/article-index.tsv oasis-skill-plus/docs/wiki
rg --fixed-strings --line-number "Actor" oasis-skill-plus/docs/api/class
```

使用建议：

- 确认 API 是否存在：先查 `docs/api/symbol-index.tsv`，再打开命中的 Markdown。
- 搜索 Wiki 问题：先查 `docs/wiki/article-index.tsv`，再查 `docs/wiki` 正文。
- 搜索 API 上下文：按需查 `docs/api/<family>`，例如 `docs/api/class`。
- 需要正则时去掉 `--fixed-strings`；需要忽略大小写时加 `--ignore-case`。

### 结构化脚本

从目标项目根目录执行：

```bash
node oasis-skill-plus/skills/oasis-official-docs/scripts/query-oasis-docs.mjs --project-root . --scope api --mode verify-api --query "AActor" --format json
node oasis-skill-plus/skills/oasis-official-docs/scripts/query-oasis-docs.mjs --project-root . --scope wiki --mode search --query "生命周期" --format text --limit 10
node oasis-skill-plus/skills/oasis-official-docs/scripts/query-oasis-docs.mjs --project-root . --scope api --mode search --query "Actor" --family class --limit 10
```

返回结果根据 `--format` 输出 JSON 或文本。JSON 常用字段包含：

- `matches[].type`：命中来源，`api` 或 `wiki`
- `matches[].matchType`：命中方式，当前可能为 `symbol-index`、`article-index`、`content`
- `matches[].title`：文档标题或符号名
- `matches[].relativePath`：相对 `oasis-skill-plus` 仓库根目录的 Markdown 路径
- `matches[].absolutePath`：本地绝对路径
- `matches[].lineNumber`：`rg --json` 命中的行号；索引命中或无法定位时可能为空
- `matches[].sourceJsonUrl`：API 索引命中的源 JSON URL；非 API 索引命中时为空
- `matches[].sourceUrl`：Wiki 索引命中的源页面 URL；非 Wiki 索引命中时为空
- `matches[].excerpt`：用于快速归纳的命中片段
- `warnings[]`：非致命告警，例如 `INDEX_MISSING`

参数补充：

- `--format json|text`：控制输出格式，默认适合机器解析时使用 `json`
- `--limit <数量>`：限制返回命中数量
- `--exact`：精确查询；索引缺失时不会回退搜索 Markdown，避免把模糊内容当成 API 存在性证据
- `--family class|cppenum|cppstruct|globalfunc`：仅在 API 范围内按家族过滤，例如只查 `class`

## 刷新官方文档

当用户明确要求最新资料时，在 `oasis-skill-plus` 仓库根目录执行：

```bash
node src/cli.mjs sync
node src/cli.mjs sync-api
node src/cli.mjs sync-all
```

刷新后再重新运行 `rg` 查询；需要结构化输出时再运行查询脚本，并基于新的本地文档回答。

## 适用边界

适合：

- 先确认某个绿洲启元 API 是否真实存在
- 先查官方 Wiki 再总结解决方法
- 在写 API 代码前先核对类名、结构体、函数名和相关文档

不适合：

- 在缺少 `oasis-skill-plus` 子模块时硬猜 API
- 在没有本地文档的情况下把记忆当成官方事实
- 把这个 skill 当成当前仓库运行时功能的一部分
