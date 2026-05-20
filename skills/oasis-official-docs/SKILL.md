---
name: oasis-official-docs
description: 当其他项目以 `oasis-skill-plus` 作为子模块或固定目录接入，并且需要查询本地绿洲启元官方 API 或 Wiki 文档、在回答问题或编写代码前先核实 API 是否真实存在、通过官方 Wiki 排查编辑器或玩法问题，或在用户明确要求最新资料时刷新本地文档时使用。
---

# 绿洲启元官方文档查询

## 概述

用这个 skill 查询 `oasis-skill-plus` 子模块导出的本地官方 API 和 Wiki Markdown 文档。
把它当作一个强约束防幻觉护栏：在声称某个 API 存在、解释 API 用法、或编写相关代码之前先查证；在给出问题排查建议前先查官方 Wiki。

## 仓库约定

- 默认当前项目根目录下存在 `oasis-skill-plus` 子模块或固定目录。
- 官方文档默认从 `oasis-skill-plus/docs/api` 和 `oasis-skill-plus/docs/wiki` 读取。
- 优先使用附带脚本进行稳定查询：

```bash
node skills/oasis-official-docs/scripts/query-oasis-docs.mjs \
  --project-root "<游戏项目根目录>" \
  --scope api|wiki|all \
  --mode verify-api|search \
  --query "<关键词或API名称>"
```

- 如果脚本返回 `OASIS_REPO_NOT_FOUND` 或 `DOCS_SCOPE_MISSING`，停止继续推断，并明确告诉用户缺少哪个目录或布局不符合约定。

## 必须遵守的流程

### API 查询与代码生成

- 在回答 API 是否存在、API 用法、参数、返回值，或编写绿洲启元 API 相关代码之前，先执行 `verify-api`。
- 查询具体符号时，优先使用 `--scope api --mode verify-api`，例如 `AActor`、`UGCPlayerControllerSystem`、`FVector`。
- 如果 `verify-api` 没有找到精确结果，再使用 `search` 在 `api` 或 `all` 范围内补查，之后再决定是否能下结论。
- 如果本地官方文档依然不能支持某个说法，要直接说明“本地官方文档未确认”，不要编造 API 或行为。

示例：

```bash
node skills/oasis-official-docs/scripts/query-oasis-docs.mjs \
  --project-root "<游戏项目根目录>" \
  --scope api \
  --mode verify-api \
  --query "AActor"
```

### Wiki 检索与问题排查

- 当用户询问绿洲启元编辑器问题、玩法逻辑问题或常见故障排查时，先搜索 `wiki`。
- 特性名、报错场景、生命周期概念、排查关键词，优先用 `--scope wiki --mode search`。
- 如果问题可能同时涉及 Wiki 说明和 API 定义，再扩展到 `--scope all`。

示例：

```bash
node skills/oasis-official-docs/scripts/query-oasis-docs.mjs \
  --project-root "<游戏项目根目录>" \
  --scope wiki \
  --mode search \
  --query "生命周期"
```

### 最新资料请求

- 默认只使用子模块里已经同步好的本地文档。
- 只有用户明确要求“最新”“当前”“刷新后再看”之类的资料时，才执行刷新。
- 在 `oasis-skill-plus` 仓库根目录执行刷新命令：

```bash
node src/cli.mjs sync
node src/cli.mjs sync-api
node src/cli.mjs sync-all
```

- 刷新后重新执行查询，再基于新的本地 Markdown 回答。

## 回答约定

- 先给简洁结论，再给依据。
- 必须引用实际使用到的本地 Markdown 路径，路径来自 `oasis-skill-plus/docs/...`。
- 如果引用了多份文档，按用途组织：API 证据、Wiki 说明、相关补充。
- 如果文档证据不足，要明确说“不足以确认”，不要用猜测补洞。
- 如果输出代码，标明关键 API 来自哪份已核实文档。

## 常见错误

- 跳过 `verify-api`，直接凭记忆或命名习惯猜 API 是否存在。
- 把 Wiki 说明当成 API 存在性的证据。Wiki 可以解释流程，但 API 是否真实存在仍然要查 `docs/api`。
- 每次查询都自动刷新文档。只有用户明确要求最新资料时才刷新。
- 回答时不附本地文档路径，只给口头结论。
- 出现 `OASIS_REPO_NOT_FOUND` 后仍继续编造答案，而不是告诉用户缺少 `oasis-skill-plus` 子模块。

### scripts/

使用 `scripts/query-oasis-docs.mjs` 做可重复的检索和查证。脚本返回 JSON，便于在生成最终回答前稳定提取命中项、摘录和引用路径。
