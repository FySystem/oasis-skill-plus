# oasis-official-docs Skill 安装与使用

`oasis-official-docs` 是给其他项目使用的查询型 skill，不是给本仓库自身交互用的业务功能。
它依赖目标项目根目录下存在一个 `oasis-skill-plus` 子模块，并从该子模块里的本地 Markdown 文档查询绿洲启源官方 API 与 Wiki。

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
4. 在目标项目中调用该 skill 查询 API/Wiki，而不是直接让 AI 凭记忆回答

如果目标环境支持仓库内 skills 目录，也可以直接复用该目录；如果需要复制，请保持 `oasis-official-docs` 目录名不变。

## 默认行为

- API 相关问题、API 用法说明、API 代码生成前，先校验 API 是否存在
- Wiki 问题排查、功能说明、解决方法查询前，先搜索本地 Wiki
- 默认只读本地同步好的 Markdown
- 只有用户明确要求“最新”“当前”“刷新后再看”时，才执行同步命令刷新数据

## 常用命令

从目标项目根目录执行：

```bash
node skills/oasis-official-docs/scripts/query-oasis-docs.mjs --project-root . --scope api --mode verify-api --query "AActor"
node skills/oasis-official-docs/scripts/query-oasis-docs.mjs --project-root . --scope wiki --mode search --query "生命周期"
node skills/oasis-official-docs/scripts/query-oasis-docs.mjs --project-root . --scope all --mode search --query "背包"
```

返回结果为 JSON，包含：

- `matches[].type`：命中来源，`api` 或 `wiki`
- `matches[].matchType`：命中方式，如 `exact-title`、`title`、`content`
- `matches[].title`：文档标题或符号名
- `matches[].relativePath`：相对 `oasis-skill-plus` 仓库根目录的 Markdown 路径
- `matches[].absolutePath`：本地绝对路径
- `matches[].excerpt`：用于快速归纳的命中片段

## 刷新官方文档

当用户明确要求最新资料时，在 `oasis-skill-plus` 仓库根目录执行：

```bash
node src/cli.mjs sync
node src/cli.mjs sync-api
node src/cli.mjs sync-all
```

刷新后再重新运行查询脚本，并基于新的本地文档回答。

## 适用边界

适合：

- 先确认某个绿洲启源 API 是否真实存在
- 先查官方 Wiki 再总结解决方法
- 在写 API 代码前先核对类名、结构体、函数名和相关文档

不适合：

- 在缺少 `oasis-skill-plus` 子模块时硬猜 API
- 在没有本地文档的情况下把记忆当成官方事实
- 把这个 skill 当成当前仓库运行时功能的一部分
