# 绿洲文档同步工具（oasis-skill-plus）

> 面向《和平精英》绿洲启元编辑器与 UGC 开发的官方 Wiki/API 文档同步工具：把远端资料同步为本地 Markdown、索引和可检索文档。

![Language](https://img.shields.io/badge/Language-Rust-000000?style=flat-square&logo=rust&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-Windows-0078D6?style=flat-square&logo=windows&logoColor=white)
![Content](https://img.shields.io/badge/Content-Wiki%20%2B%20API-2F80ED?style=flat-square)
![Repository](https://img.shields.io/badge/Repository-Documentation%20Sync-orange?style=flat-square)

`oasis-skill-plus` 是一个纯 Rust CLI 工具，用于同步绿洲启元官方 Wiki 和 API 文档，并将远端内容整理成本地资料库。同步完成后，可以直接使用本地 Markdown、TSV 索引和查询命令检索文档，也可以把仓库中的 `oasis-official-docs` skill 接入其他 UGC 项目。

## 同步内容

| 文档范围 | 同步结果 |
| --- | --- |
| 官方 Wiki | 分类目录、文章 Markdown、图片资源、Wiki 总索引、文章 TSV 索引 |
| 官方 API | `class`、`cppenum`、`cppstruct`、`globalfunc` 四类 API Markdown、family 索引、符号 TSV 索引 |
| 增量状态 | `.oasis-sync/manifest.json` 与 `.oasis-sync/api-manifest.json` |
| 查询资料 | `docs/wiki`、`docs/api` 及其索引文件 |

Wiki 默认来源为 `https://developer.gp.qq.com/wikieditor`，API 默认来源为 `https://developer.gp.qq.com/api`。同步命令支持自定义地址，便于测试或使用镜像服务。

## 同步文档

```bash
# 同步 Wiki
cargo run -- sync-wiki

# 同步 API
cargo run -- sync-api

# 同时同步 Wiki 和 API
cargo run -- sync-all
```

所有同步命令支持 `--root` 指定输出根目录；还可以使用 `--base-url`、`--wiki-base-url`、`--api-base-url` 指定服务地址，并通过 `--article-concurrency`、`--image-concurrency`、`--detail-concurrency` 调整并发数。

Windows 下可以直接双击：

- `双击运行同步Wiki.bat`
- `双击运行同步API.bat`
- `双击运行同步Wiki+API.bat`

脚本会调用 `target/release/oasis-skill-plus.exe`；如果 release 程序不存在，会先自动执行 `cargo build --release`。

## 查询本地文档

```bash
# 精确核对 API 是否存在
cargo run -- query --project-root . \
  --scope api --mode verify-api --query AActor

# 搜索 Wiki，输出文本
cargo run -- query --project-root . \
  --scope wiki --mode search --query 生命周期 \
  --format text --limit 10

# 在指定 API family 中查询
cargo run -- query --project-root . \
  --scope api --family class --query AActor --exact
```

查询支持：

- `--scope api|wiki|all`
- `--mode search|verify-api`
- `--format json|text`
- `--limit <数量>`
- `--family class|cppenum|cppstruct|globalfunc`
- `--exact`：只接受索引命中，不回退到 Markdown

普通查询优先使用 TSV 索引；索引不完整时会继续搜索 Markdown。API 存在性核验建议使用 `--mode verify-api --scope api --exact`，避免把正文中的普通提及当成 API 证据。

## 为其他项目接入文档 skill

将本仓库放在目标项目的 `oasis-skill-plus/` 子目录下，并把 `skills/oasis-official-docs` 放到目标项目可发现的 skill 目录：

```text
ProjectA/
├─ oasis-skill-plus/
│  ├─ docs/api/
│  ├─ docs/wiki/
│  └─ skills/oasis-official-docs/
└─ skills/
   └─ oasis-official-docs/
```

需要结构化结果时，可以调用编译后的二进制：

```bash
oasis-skill-plus query \
  --project-root "<游戏项目根目录>" \
  --scope api --mode verify-api \
  --query AActor --format json
```

skill 默认只读取本地同步结果，不会自动刷新远端文档。只有明确需要最新资料时，再运行 `sync-wiki`、`sync-api` 或 `sync-all`。

## 仓库结构

```text
src/
├─ main.rs          # CLI 入口、同步命令和查询命令
├─ api.rs           # Wiki/API HTTP 客户端
├─ sync.rs          # Wiki 同步与图片发布
├─ api_sync.rs      # API 同步与增量清理
├─ markdown.rs      # Wiki Markdown 与资源链接处理
├─ api_markdown.rs  # API Markdown 渲染
├─ index.rs         # TSV 索引生成
├─ manifest.rs      # 哈希、manifest 和增量 diff
└─ search.rs        # 本地索引与 Markdown 查询
docs/
├─ wiki/            # Wiki 文档、图片和文章索引
├─ api/             # API 文档和符号索引
└─ skills/          # skill 接入说明
skills/
└─ oasis-official-docs/ # 可接入其他项目的查询 skill
tests/              # 同步、查询和 Windows 启动脚本测试
```

## 构建环境

- Rust stable，edition 2021；
- Windows 构建使用 MSVC toolchain 和 Visual Studio Build Tools C++ 工具链；
- 同步需要网络，查询已有文档时不需要 Node.js 或 Go。

```bash
cargo build --release
cargo test
cargo clippy --all-targets -- -D warnings
```
