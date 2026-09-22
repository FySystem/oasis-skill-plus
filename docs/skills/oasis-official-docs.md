# oasis-official-docs Skill 安装与使用

`oasis-official-docs` 是给其他项目使用的查询型 skill，不是给本仓库自身交互用的业务功能。
它依赖目标项目根目录下存在一个 `oasis-skill-plus` 子模块，通过 `rg` 或 Rust CLI 检索该子模块里的 TSV 索引与本地 Markdown 文档，查询绿洲启元官方 API 与 Wiki。

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
4. 临时全文查询优先用 `rg`；需要结构化输出、精确 API 查证或自动化校验时优先调用 Rust CLI，而不是直接让 AI 凭记忆回答

如果目标环境支持仓库内 skills 目录，也可以直接复用该目录；如果需要复制，请保持 `oasis-official-docs` 目录名不变。

## 自动使用

`skills/oasis-official-docs/agents/openai.yaml` 是面向模型的 agent 配置。它会在问题涉及绿洲启元 API、Wiki、编辑器、玩法或故障排查时提示模型自动调用 `$oasis-official-docs`，先查本地官方文档再回答或编写代码。

具体查询规则仍由 `skills/oasis-official-docs/SKILL.md` 负责：API 存在性优先使用 Rust CLI 的 exact 查询，Wiki 全文排查优先使用 `rg`。安装或接入时需要同时保留 `SKILL.md` 和 `agents/openai.yaml`。

## 默认行为

- API 相关问题、API 用法说明、API 代码生成前，先校验 API 是否存在
- Wiki 问题排查、功能说明、解决方法查询前，先搜索本地 Wiki
- 默认只读本地同步好的 Markdown
- 临时全文查询优先直接使用 `rg` 检索 TSV 索引或 Markdown：`docs/api/symbol-index.tsv`、`docs/wiki/article-index.tsv`、`docs/api`、`docs/wiki`
- Rust CLI 用于精确 API 存在性查证、稳定 JSON/text 输出、统一路径和来源字段，以及自动化校验
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

工具选择：

- 临时全文检索、正则匹配、人工快速定位：优先 `rg`。
- 需要 JSON、稳定文本、命中限制、标准路径和来源 URL：优先 Rust CLI。
- 核实 API 是否真实存在：优先 Rust CLI 的 `--mode verify-api --scope api --exact`，只接受 API 索引精确命中。
- Wiki 关键词排查：优先 `rg`；需要被脚本消费或统一处理 warning 时使用 Rust CLI。
- 已知 API family 或需要重复调用时，使用 Rust CLI 并传入 `--family`；单次探索可以直接使用 `rg`。

### 结构化查询

从目标项目根目录执行：

```bash
cargo run --manifest-path oasis-skill-plus/Cargo.toml -- query --project-root . --scope api --mode verify-api --query "AActor" --format json
cargo run --manifest-path oasis-skill-plus/Cargo.toml -- query --project-root . --scope wiki --mode search --query "生命周期" --format text --limit 10
cargo run --manifest-path oasis-skill-plus/Cargo.toml -- query --project-root . --scope api --mode search --query "Actor" --family class --limit 10
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
cargo run -- sync
cargo run -- sync-api
cargo run -- sync-all
```

刷新后再重新运行 `rg` 查询；需要结构化输出时再运行 Rust CLI，并基于新的本地文档回答。

## 适用边界

适合：

- 先确认某个绿洲启元 API 是否真实存在
- 先查官方 Wiki 再总结解决方法
- 在写 API 代码前先核对类名、结构体、函数名和相关文档

不适合：

- 在缺少 `oasis-skill-plus` 子模块时硬猜 API
- 在没有本地文档的情况下把记忆当成官方事实
- 把这个 skill 当成当前仓库运行时功能的一部分
