# server/engine/ — Skill Runner

Nodesign 后端核心。**通用的 agent loop 框架**，可加载任意 skill（首个客户：`deskskill-engine-v0.7.5`）。

## 设计哲学

- 不做 R0/R1/R2/R3 的硬编码 orchestrator——agent **自己**按 SKILL.md 推进
- 跟 Cursor / Claude Code 同范式：**一个 agent 一直跑，自己用工具落盘中间产物**
- Skill 是 prompt + 文档（加载到 system prompt 带 cache_control）
- 工具是能力，可加装（FS / preview / web / 自定义）
- Runtime 是沙盒（每个 run 一个 workspace 目录）

## 计划目录结构（待实现）

```
engine/
├── agent/
│   ├── loop.js                # 包 server/shared/agent-loop.js
│   ├── system-prompt.js       # 基础 prompt（不含 skill 内容）
│   └── context.js             # AgentContext（runId / workspace / signal / streamer）
├── skills/
│   ├── loader.js              # 读 SKILL.md + references/ → 拼 system prompt
│   └── registry.js            # 已注册 skill 列表
├── tools/
│   ├── _registry.js           # 工具注册表
│   ├── filesystem.js          # read_file / write_file / edit_file / list_dir
│   ├── shell.js               # execute_command（受限，限定 cwd=workspace）
│   ├── todo.js                # todo_write
│   └── preview/               # preview 子模块（playwright）
│       ├── start.js, stop.js, screenshot.js, eval.js, inspect.js
│       └── _server.js         # 内嵌 http server + Playwright 控制
├── runtime/
│   ├── workspace.js           # runs/<run-id>/workspace/ 沙盒
│   ├── sandbox.js             # 路径越界检查 / 命令白名单
│   └── artifact.js            # 产物收集
└── runs/
    ├── store.js               # engine_runs 表 CRUD
    └── status.js              # 状态机：pending → running → done/failed/cancelled
```

## 入口（待对齐后选）

- HTTP：`POST /engine/runs { skill, brief, tools? }` → 异步返回 run_id
- SSE：`GET /engine/runs/:id/stream` → 实时进度
- 内部：`engineApi.createRun(...)` 给小合调用

## 第一个客户：deskskill-engine

放在 [server/skills/installed/deskskill-engine/](../skills/installed/) （symlink 自 `/Users/edy/Desktop/html_designer/v0.7.5/deskskill-engine-v0.7.5/`）。

⚠️ `postprocess.py` 不接入——组长已决定移除。G1-G11 gates 改成 JS 工具实现（阶段 P3）。
