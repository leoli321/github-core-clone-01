# REBUILD_DONE — github-core-clone-01 重建完成

- 仓库绝对路径：`/home/hatch/workspace/makefun_entries/github-core-clone-01-rebuild/`
- 提交：`4fd895c`（`main` 分支，见 `git log`；本文件写于该提交之后，未再改代码）
- 入口文件：`main.ts`（Node 22，`node --experimental-strip-types main.ts` 启动；`app.ts` 为实现）
- 启动契约：进程自选临时端口（绝不绑 8080），启动后立即 POST `{"port": 端口}` 到
  `$MAKEFUN_ENV_URL/register`；`GET /healthz` 返回 200；长轮询 `GET $MAKEFUN_ENV_URL/done`
  直到 `{"done": true}` 后退出 0。

## grade-local 最终结果（原文）

三轮 `node cli/makefun.mjs grade-local --kit . --bot <仓库> --driver process`
（kit：`~/.makefun/kits/github-core-clone-01-kit`，日志见
`~/workspace/makefun_entries/github-core-clone-01-rebuild-logs/grade-{1,2,3}.txt`）：

- 第 1 轮：`scores {"agent":200,"feature":600,"perf":182,"perf_p50_us":252254,"score":982,"working":1}`
- 第 2 轮：`scores {"agent":200,"feature":600,"perf":145,"perf_p50_us":434506,"score":945,"working":1}`
- 第 3 轮：`scores {"agent":200,"feature":600,"perf":161,"perf_p50_us":343225,"score":961,"working":1}`

三轮 feature 600/600、agent 200/200 全部满分（120/120 checks）；replay 三次全部
matched，`state.json a0e98d49854b961230227867235c8615858e006db3763f341ac6154af1445590`
byte for byte 一致，确定性通过。

perf 在 145–182 间波动：直接跑 kit 内置 conformance runner
（`sdk/run.ts --perf`，日志 `bench-1.txt`/`bench-2.txt`）两次分别为 189、191
（push ~458–520ms、clone ~88–105ms、read ~674–690ms、write ~88–93ms），
与旧版同机实测 190 基本持平。grade-local 三轮 perf 偏低与本机当时负载高有关
（第 2/3 轮期间 load average 2.67–2.83，共享 1.5 CPU），非代码回归。

## 与旧版的功能差异

- 无功能差异：同一功能规格重新实现——git smart HTTP（upload-pack v2、
  receive-pack v0，packfile 含 ofs/ref-delta 解析）、REST v3、GraphQL v4、
  MCP（2026-07-28 / server/discover），内存存储、固定 epoch + 创建序号时间戳、
  场景 seed 派生 viewer、确定性 replay。
- 两处小的加固（行为兼容，不影响已通过的检查）：
  1. MCP 工具名支持 `github__create_issue` 形式的前缀与大小写不敏感匹配；
  2. MCP 参数支持 `full_name: "owner/repo"` 拆分为 owner/repo。
- `main.ts` 与 kit starter 的 lifecycle 文件一致（kit 自带，非旧版作品代码）。

## 未尽事项

- 未执行 bundle、未执行 submit（按任务要求，打包与提交由主代理用本会话的
  agent_id 从 muse.db 生成 usage 后在顶层完成）。
- 仓库尚未推送到 GitHub 公开仓库（repo_url / commit_sha 由主代理在提交时确定）。
- perf 列受运行机负载影响较大；最终成绩以服务器沙箱实测为准。
