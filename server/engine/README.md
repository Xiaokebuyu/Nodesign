# server/engine/ — Skill Runner

Nodesign 后端核心。**包 Claude Agent SDK 的 query() 跑 agent 循环**，加载任意 SKILL.md。

## 设计哲学（2026-04-29 战略调整后）

- 不再造 agent loop 轮子 —— 包 Claude Agent SDK 的 `query()`（SDK 是 Claude Code 子进程的程序化包装）
- 通过 `ANTHROPIC_BASE_URL` env 透传给子进程，路由到 Kimi gateway（tokendance 等）
- 工具用 SDK 内置 23 个，按 Nodesign 业务 allowlist：`Read / Write / Edit / Glob / Grep / TodoWrite`
- Skill 是 `SKILL.md`（YAML frontmatter + Markdown body），body 直接当 systemPrompt
- Workspace 是沙盒（每 run 独占 `runs/<runId>/workspace/`），SDK `cwd` 指过去
- Run 状态机走 SQLite（`runs/store.js`），SDK 自己的 session 持久化关掉（`persistSession: false`）

## 当前目录结构

```
engine/
├── agent/                       ★ Agent 模块（包 SDK）
│   ├── context.js               AgentContext（runId / EventBus / abort / counters）
│   ├── events.js                EventBus + 标准事件 schema
│   ├── loop.js                  ★ 包 SDK query() 的 orchestrator
│   ├── skill.js                 SKILL.md loader（frontmatter + body）
│   └── _smoke.js                烟雾测试（无 key 也能跑非 LLM 部分）
│
├── skills/                      内置 skill 库
│   └── hello-world/SKILL.md     P3 链路验证 skill
│
├── runs/
│   └── store.js                 SQLite 状态机（pending → running → succeeded/failed/cancelled）
│
├── runtime/
│   └── workspace.js             沙盒路径解析 + safeResolve + read/write/list 包装
│
└── _smoke.js                    底层骨架烟雾测试（store + workspace）
```

## 入口（待 P3 起 Express 后实现）

- HTTP：`POST /api/runs { skillId, brief }` → 异步返回 runId
- WebSocket：每 project 一条连接，订阅 EventBus 把事件推前端
- 内部：`runAgent({ runId, skillId, brief, eventBus })` from `agent/loop.js`

## 跑测试

```bash
# 不需要 gateway key，验证非 LLM 部分（EventBus / AgentContext / parseFrontmatter / loadSkill）
npm run smoke:agent

# 验证底层骨架（runs/store + runtime/workspace）
npm run smoke:engine

# Live LLM 调用（需要 NODESIGN_GATEWAY_KEY 在 .env）
NODESIGN_GATEWAY_KEY=xxx npm run smoke:agent
```

## SDK 配置要点

```js
import { query } from '@anthropic-ai/claude-agent-sdk';

query({
  prompt: brief,
  options: {
    cwd: workspaceRoot,                        // 沙盒
    abortController: ctx.abortController,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: NODESIGN_GATEWAY_URL,
      ANTHROPIC_API_KEY:  NODESIGN_GATEWAY_KEY,
    },
    model: 'kimi-k2.6',
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite'],
    allowedTools: [...同上...],                // 自动允许，不弹权限
    systemPrompt: skill.systemPrompt,         // 我们自己拼，不用 claude_code preset
    persistSession: false,                    // 不写 ~/.claude/projects 的 session
    settingSources: [],                       // 不读外部 settings 文件
    includePartialMessages: true,             // 流增量
    thinking: { type: 'adaptive' },
    effort: 'medium',
    maxTurns: 50,
  },
});
```

## 事件流（EventBus 标准 schema）

```
run.start
run.sdk.session         { sessionId }
run.delta.text          { round, text }
run.delta.thinking      { round, text }
run.delta.tool_use      { round, blockId, name, input }
run.delta.tool_result   { round, blockId, name, ok, output | error }
run.compact_boundary    { compactMetadata }       // 上下文压缩点
run.status              { status }                 // compacting | requesting | null
run.rate_limit          { info }
run.cancelled           { reason }
run.done                { finalText, artifactPath?, snapshot }
run.error               { message, code, stack }
```

外层把 `eventBus.subscribe('*', handler)` 桥到 WebSocket / 审计日志 / 测试 buffer。

## 决定 / 不做的事

- ❌ 不消费 MCP（HANDOVER §11；Nodesign 暴露 REST/WS，不做 MCP client）
- ❌ 不开 Bash 工具（沙盒 cwd 隔离了，但 shell 越界风险高；P5+ 真要 chart 库时再开）
- ❌ 不开 WebFetch/WebSearch（P5 真做参考系统时再开，需要 SSRF 防护）
- ❌ 不开 Sub-agents/Task（P5+ 多方向探索可考虑，前期单 agent 单 run）
- ❌ 不用 SDK 的 `skills: ['xxx']` 自动加载（我们自己读 SKILL.md，给 systemPrompt 字段）
