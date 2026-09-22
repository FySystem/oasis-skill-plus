---
name: oasis-official-docs
description: 当需要查询本地绿洲启元官方 API 或 Wiki、核实 API 是否存在、排查编辑器或玩法问题，或用户明确要求刷新官方资料时使用。
---

# 绿洲启元官方文档查询

## 功能

这个 skill 提供三类能力：

- 查询本地同步的官方 Wiki，定位功能说明、编辑器用法和故障排查资料。
- 查询本地同步的官方 API，核实类、结构体、枚举和全局函数是否存在，并返回对应文档路径与来源地址。
- 在用户明确要求最新资料时刷新 Wiki/API，再基于刷新后的文档重新查询。

默认只使用本地同步结果，不凭记忆补充官方 API 行为。

## 查询工具选择

- **优先使用 `rg`**：临时全文检索、正则匹配、人工快速定位或全文排查 Wiki 正文。
- **优先使用 Rust CLI**：需要 JSON/稳定文本、标准化路径、来源 URL、命中数量限制、脚本集成或重复调用。
- **核实 API 是否存在**：优先 Rust CLI 的 `--mode verify-api --scope api --exact`，只接受 API 索引精确命中，避免把正文中的普通提及误判为 API。
- **模糊 API 搜索**：使用 Rust CLI；已知 API family 时加 `--family` 缩小范围。单次探索可以使用 `rg`。

`rg` 示例：

```bash
rg --fixed-strings --line-number "<API名称>" oasis-skill-plus/docs/api/symbol-index.tsv
rg --fixed-strings --line-number "<Wiki关键词>" oasis-skill-plus/docs/wiki/article-index.tsv oasis-skill-plus/docs/wiki
rg --fixed-strings --line-number "<API关键词>" oasis-skill-plus/docs/api/<family>
```

需要正则时去掉 `--fixed-strings`；需要忽略大小写时加 `--ignore-case`。

Rust CLI 示例：

```bash
cargo run --manifest-path oasis-skill-plus/Cargo.toml -- query \
  --project-root "<游戏项目根目录>" \
  --scope api|wiki|all \
  --mode verify-api|search \
  --query "<关键词或API名称>" \
  --format json|text \
  --limit 20
```

Rust CLI 会按 API 索引、API 正文、Wiki 索引、Wiki 正文合并结果。`--exact` 只查索引，不回退到 Markdown；`--family` 支持 `class`、`cppenum`、`cppstruct`、`globalfunc`。

## 必须遵守的流程

### API 查询与代码生成

- 在回答 API 是否存在、API 用法、参数、返回值，或编写相关代码之前，先查 `docs/api/symbol-index.tsv`。
- 核实具体符号时使用 Rust CLI `--mode verify-api --scope api --exact`；需要人工补充上下文时再用 `rg` 查看命中的 Markdown。
- 索引没有精确命中时，再用 `rg` 搜索 `docs/api` 或对应 family，不能直接下结论。
- 需要机器可读结果时使用 Rust CLI 的 `--format json`。
- 本地文档不能支持某个说法时，明确说明“本地官方文档未确认”。

### Wiki 检索与问题排查

- 询问编辑器、玩法逻辑或故障排查时，先用 `rg` 搜索 `docs/wiki/article-index.tsv` 和 `docs/wiki`。
- 特性名、报错场景、生命周期概念和排查关键词，优先查 Wiki 索引及正文。
- 如果问题同时涉及 API 定义，再扩展到 `docs/api` 或使用 Rust CLI 查询 API。

### 最新资料请求

- 只有用户明确要求“最新”“当前”“刷新后再看”时才执行刷新。
- 在文档仓库根目录执行：

```bash
cargo run -- sync
cargo run -- sync-api
cargo run -- sync-all
```

- 刷新后重新执行查询，再基于新的 Markdown 回答。

## 错误处理

- `OASIS_REPO_NOT_FOUND` 或 `DOCS_SCOPE_MISSING`：停止推断，明确说明缺少文档仓库或范围目录。
- `INDEX_MISSING`：这是 warning。非 exact 查询可以继续搜索 Markdown；exact 查询不会回退到 Markdown。
- 文件读取错误或权限错误：先修复文档目录或权限，不能凭记忆猜测 API。

## 回答要求

- 先给简洁结论，再给文档依据。
- 必须引用实际使用的 `oasis-skill-plus/docs/...` 本地 Markdown 路径。
- 多份文档按 API 证据、Wiki 说明和补充资料组织。
- 输出代码时标明关键 API 来自哪份已核实文档。
