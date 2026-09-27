# oasis-skill-plus

这是一个面向《和平精英》绿洲启元编辑器与 UGC 开发的纯 Rust 官方 Wiki/API 文档同步与本地检索工具。

它可以：

- 并发同步官方 Wiki，生成 Markdown、文章索引和增量 manifest；
- 并发同步四类 API（`class`、`cppenum`、`cppstruct`、`globalfunc`），生成交叉链接、family 索引和符号索引；
- 下载 Wiki 图片并采用临时目录发布，失败时保留上一份完整文档树；
- 使用本地 TSV 索引和 Markdown 进行结构化 JSON 或文本查询；
- 使用 Tokio、Reqwest 和有界并发任务处理网络、解析和文件写入。

## 环境

- Rust stable（MSVC toolchain）；
- Windows 构建需要 Visual Studio Build Tools 的 C++ 工具链；
- 运行时不需要 Node.js 或 Go。

## 构建与测试

```bash
cargo build --release
cargo test
cargo clippy --all-targets -- -D warnings
```

## 同步

```bash
# 同步 Wiki
cargo run -- sync

# 同步 API
cargo run -- sync-api

# 并发同步 Wiki 和 API
cargo run -- sync-all
```

所有同步命令支持 `--root` 指定输出根目录。测试或镜像环境可以用 `--base-url`、`--wiki-base-url` 和 `--api-base-url` 指向本地 HTTP 服务；并发数可以用 `--article-concurrency`、`--image-concurrency` 和 `--detail-concurrency` 调整。

Windows 下也可以直接双击根目录中的 `双击运行同步Wiki.bat`、`双击运行同步API.bat` 或 `双击运行同步Wiki+API.bat`。脚本会调用 Rust release 程序；首次运行找不到程序时，会自动执行 `cargo build --release`。

批处理输出保留旧版的 `[信息]`、进度条、统计摘要和 `[完成]/[失败]` 文案；`sync-all` 在终端中并排显示 Wiki 与 API 进度，两个同步任务同时运行。

## 查询

```bash
# 核对 API 是否存在
cargo run -- query --project-root . --scope api --mode verify-api --query AActor

# 查询 Wiki，输出文本
cargo run -- query --project-root . --scope wiki --mode search --query 生命周期 --format text --limit 10

# 按 API family 查询并要求索引精确匹配
cargo run -- query --project-root . --scope api --family class --query AActor --exact
```

查询支持：

- `--scope api|wiki|all`；
- `--mode verify-api|search`；
- `--format json|text`；
- `--limit <正整数>`；
- `--family class|cppenum|cppstruct|globalfunc`；
- `--exact`。

当索引缺失时，普通搜索会回退到 Markdown；精确搜索会报告 warning 并跳过回退。

## 目录

```text
src/
├─ main.rs          # Rust CLI
├─ api.rs           # Wiki/API HTTP 客户端与重试
├─ sync.rs          # Wiki 同步、图片发布与 manifest
├─ api_sync.rs      # API catalog/detail 同步与增量清理
├─ markdown.rs      # Markdown、链接和图片处理
├─ api_markdown.rs  # API Markdown 渲染
├─ manifest.rs      # manifest、哈希和增量 diff
├─ index.rs         # TSV 索引生成
└─ search.rs        # 本地索引与 Markdown 查询
tests/
└─ integration.rs   # Wiki/API 端到端 fixture 测试
docs/
├─ wiki/            # 同步后的 Wiki 文档
└─ api/             # 同步后的 API 文档
```

## 为其他项目接入 skill

其他项目仍可把本仓库放在 `oasis-skill-plus` 目录下。查询时调用编译后的 Rust 二进制：

```bash
oasis-skill-plus query --project-root "<游戏项目根目录>" \
  --scope api --mode verify-api --query AActor --format json
```

skill 默认读取 `docs/api`、`docs/wiki` 及其 TSV 索引，不会自动刷新远端数据。只有明确需要最新资料时才运行同步命令。
