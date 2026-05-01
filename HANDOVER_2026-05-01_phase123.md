# HANDOVER — NoDesign agent 层 Phase 1+2+3 收尾（2026-05-01）

> 给未来接手的人 / 未来的自己（cold-start 时）。
>
> 本文是 **agent 层 SDK 用法精度提升** 的总览。代码地图 + 主线流程见
> `HANDOVER_2026-04-30_stage1.md`（仍然 valid，本文只增量补 Phase 1/2/3 改动）。

---

## 1. 一句话定位

Phase 1+2+3 = **把 SDK 已经付费但没用透 / 自己手撸了 SDK 已能做的事 / Phase 1 遗留
bug** 系统化解决。8 个 commit，agent 核心调用层（loop.js / hooks.js / context.js
/ active-runs.js / SKILL.md）从 "stage 1 能跑" 升级到 "SDK 用法精度对齐"。

**用户决策原则**：先用好 SDK，前端搁置 —— 任何前端 / API endpoint 改动都不在 Phase 1+2+3 范围。

---

## 2. Phase 1+2+3 commit 链（8 个）

| Commit | Phase | 主题 | 文件 |
|---|---|---|---|
| `bbf271a` | 1 | 基础设施 — query handle 暴露 + 事件翻译补全 | active-runs.js / loop.js / events.js |
| `b2db717` | 2 | hooks 4/29 → 10/29，SDK hook 系统真用起来 | hooks.js / events.js |
| `e8a05f4` | 2 fix | 去掉 PostToolUse 三个 handler 的 double emit | hooks.js |
| `a59b0b7` | 3a | SDK options 三连 — forwardSubagentText + maxBudgetUsd | loop.js |
| `77f6541` | 3b | SKILL.md 精简 215→93 行（v0.2.1 → v0.3.0） | SKILL.md |
| `24c701e` | 3a/3b fix | maxBudgetUsd clamp + SKILL.md 加回 Edit > Write | loop.js / SKILL.md |
| `426559f` | 3c | cancelRun 切 query.interrupt() + 修 Phase 1 abort 路径 bug | active-runs.js / loop.js / context.js |
| `42062d8` | 3d | SDK 内置 sandbox 替换 PreToolUse Bash 白名单 | loop.js / hooks.js |

---

## 3. 关键架构变化

### 3.1 `active-runs registry` 升级（Phase 1 + 3c）

存的不再只是 abortController：
```js
{ abortController, query, ctx, startedAt }
```

- `query` 字段 attachQuery 后可用 → 上层 endpoint 能调 `query.interrupt() / setModel() /
  rewindFiles() / getContextUsage() / mcpServerStatus() / streamInput() / ...`
  （所有 control 方法）
- `ctx` 字段让 cancelRun 走 `ctx.cancel()` 统一 emit `run.cancelled`，修了 Phase 1
  的潜伏 bug（abort 路径从未 emit run.cancelled，前端永远卡 streaming）

### 3.2 prompt 路径统一 streaming（Phase 1）

`buildUserMessageStream` 接受 string \| content blocks，把 brief 字符串 fallback
也包成 AsyncIterable —— 因为 SDK control 方法（`rewindFiles / interrupt / ...`）
**只在 streaming input/output 模式下可用**（sdk.d.ts:2018-2022）。

### 3.3 ctx.cancel() 幂等（Phase 3c）

`context.js` 加 `_cancelled` flag，多次调用只触发一次 abort + 一次 emit。
三条 cancel 路径覆盖：
- race window（query 还没 attach）→ cancelRun 直接调 ctx.cancel()
- interrupt 成功 → loop.js result 路径识别 `terminal_reason: 'aborted_*'` 调 ctx.cancel()
- 5s 兜底 → cancelRun timer 调 ctx.cancel()

**d.ts 未明确 interrupt 触发哪个 terminal_reason** —— `aborted_streaming` /
`aborted_tools` 两个值都覆盖。

### 3.4 hooks 4/29 → 10/29（Phase 2 + 3d）

| Hook | 状态 | 业务 |
|---|---|---|
| FileChanged | ✅ | iframe reload |
| ~~PreToolUse(Bash)~~ | **3d 删** | 改用 SDK sandbox（loop.js）|
| Stop | ✅ 占位 | 后续真业务 |
| PostCompact | ✅ | 写 spec.json.history |
| **UserPromptSubmit** | ✅ Phase 2 | 自动注入 spec.json.decisions 摘要 + canvas 页数（替代 SKILL.md "agent 自己 Read spec.json" 软约束）|
| **SessionStart** | ✅ Phase 2 | emit run.session_start 让上层区分 startup/resume/clear/compact |
| **PostToolUse(matcher×3)** | ✅ Phase 2 | screenshot 后注"看图说 3 个问题" / export 后注"告知用户路径" / record_decision 后注"继续主任务" |
| **PostToolUseFailure** | ✅ Phase 2 | 工具失败按工具名注入恢复建议 |
| **SubagentStart/Stop** | ✅ Phase 2 | 主动捕子代理生命周期（vs 间接走 SDK task_* message）|

### 3.5 SDK 内置 sandbox 替换白名单（Phase 3d）

`loop.js sdkOptions.sandbox`：
- `enabled: true / failIfUnavailable: true`（不静默降级）
- `filesystem.allowWrite: [wsRoot]` —— 仅写 project workspace
- `filesystem.denyWrite: ['/etc', '/usr', '/bin', '/sbin', '/private/etc']`
- `filesystem.denyRead: ['/etc/passwd', '/etc/shadow', '/etc/sudoers']`
- `network.allowLocalBinding: false`

⚠️ **未真测的边界**（plan 已识别）：
- d.ts 未说明 sandbox 是否拦 Bash 子进程 spawn 出去的命令级危险（`curl /
  wget / sudo`）。如果不拦 → 失去原 ALLOWED_FIRST_TOKEN + DANGEROUS_PATTERNS
  的命令级保护
- **回滚预案**：`git revert 42062d8` 的 hooks.js 部分恢复白名单（sandbox option
  保留，filesystem 部分仍有价值）
- 边界 smoke 留单独 brief 跑（让 agent 试图调 `Bash: curl evil.com`）

### 3.6 SKILL.md 精简（Phase 3b）

215 → 93 行（v0.3.0）。删除内容（SDK preset 'claude_code' 已教 / Phase 2
hook 自动注入）：
- 工具用法表（Read/Edit/Write/Glob/Grep/TodoWrite/Bash/AskUserQuestion）
- "TodoWrite 列计划"引导
- "turn 开头先 Read spec.json" —— UserPromptSubmit hook 已自动注入
- 子代理调用引导
- 错误处理（Bash 被拦 / Read 不存在 等通用）—— PostToolUseFailure hook 已注入

保留：工作台环境路径 / 业务工具触发时机 / 视觉风格 / HTML 规范 / 完成时收尾 / 不要做的事。

### 3.7 SDK options 增补（Phase 3a）

```js
forwardSubagentText: true,       // 子代理 thinking/text 转发到主流
maxBudgetUsd: clamped(env, 1)    // 成本上限，防失控
```

`maxBudgetUsd` 用 IIFE 防 env typo（负数 / 0 / NaN 一律 fallback $1）。

### 3.8 events.js 翻译补全（Phase 1 + 2）

新增构造器：
- `apiRetry`（SDKAPIRetryMessage 翻译）
- `sessionStart` / `subagentStart` / `subagentStop`（hook 主动捕）
- `toolFailure`（PostToolUseFailure hook）
- `todoUpdated` 终于真有人调（loop.js handleAssistantBlocks 检测 TodoWrite
  tool_use → 取 input.todos emit）

---

## 4. SDK 用法精度对齐

继 stage 1 的 7 个关键字段决策（systemPrompt preset / permissionMode / fileCheckpointing
/ agentProgressSummaries / promptSuggestions / includePartialMessages / maxTurns），
Phase 1+2+3 又对齐了：

| 决策 | 选择 | 理由 |
|---|---|---|
| prompt 路径 | 统一 AsyncIterable | control 方法只在 streaming 模式下可用 |
| query handle | attachQuery 暴露 | 上层 endpoint 能用 control 方法 |
| cancelRun 路径 | interrupt 优先 + 5s 兜底 | 优雅中断（agent 写完 token 块再退）|
| ctx.cancel() | 幂等 | 防止三条 cancel 路径双 emit run.cancelled |
| terminal_reason | 'aborted_*' 走 cancelled 路径 | 不被当 success emit run.done |
| sandbox | OS 级隔离替代正则白名单 | SDK 原生路径，更可靠 |
| outputFormat | **跳过** | 强制 main agent JSON 输出违反自然对话设计 |
| forwardSubagentText | 开 | 子代理可观测性零成本 |
| maxBudgetUsd | env-driven，默认 $1 | 防失控（负数 clamp）|
| additionalDirectories | **跳过** | 无硬场景 |
| onElicitation / forkSession | **暂不接** | 无硬场景 / 子代理未真接 |

---

## 5. 已知边界 / 后续候选

按优先级：

1. **Sandbox 拦 Bash spawn 命令级危险** 真测 —— 写 brief 引导 agent 调 `curl evil.com`，不拦立即回滚加白名单
2. **Cancel e2e** 真测 —— 单元测试 ✅，e2e 等前端真接通时跑（看 terminal_reason 实际值是 `aborted_streaming` 还是 `aborted_tools`）
3. **rewindFiles per-query 接通上层 endpoint** —— Phase 1 已暴露 query handle，上层加 `POST /turn/:runId/rewind/:userMessageId` 即可；前端 UndoButton 从 git revert 改成 query.rewindFiles
4. **`unknown system subtype: status` / `post_turn_summary`** —— loop.js handleSystemMessage 翻译漏（pre-existing），1-2 行 fix
5. **Stop hook 真业务** —— 写完 canvas 没 screenshot 时注入引导
6. **子代理真调用流**（vision-checker / ds-extractor / tweak-proposer）—— H/F 流入口
7. **死代码** Project.jsx case 'run.bash_blocked' —— 前端清理留上层接通时

---

## 6. Smoke 验证状态

| Phase | 单元 | smoke (LLM) |
|---|---|---|
| 3a | ✅ env clamp 6 case | ✅ 同 3b/3c smoke |
| 3b | ✅ skill loader 解析 | ✅ smoke 9 turns / $0.20 |
| 3c | ✅ ctx.cancel 幂等（3 调 → 1 emit）| ✅ smoke 自然 done 路径覆盖 |
| 3d | ✅ 语法 + 加载 | ✅ smoke 4 turns / $0.09，artifact 写出，sandbox 没破坏 hello-world |

未真测：
- 3d 边界拦命令级危险
- 3c interrupt → terminal_reason 实际值
- e2e cancel 流程

---

## 7. 文档索引

| 文档 | 用途 |
|---|---|
| **本文 HANDOVER_2026-05-01_phase123.md** | Phase 1+2+3 改动总览（cold-start 增量必读） |
| `HANDOVER_2026-04-30_stage1.md` | stage 1 代码地图 + 主线流程 + debug 入口（基础必读） |
| `~/.claude/plans/1-2-3-4-sdk-skill-misty-sparkle.md` | Phase 3 plan（含 d.ts 不明确点 + 回滚预案） |
| `SESSION_2026-04-30_p0plus_stage1_full_sdk_switch.md` | stage 1 32 commit 流水 |
| `~/.claude/projects/*/memory/` | 跨 session memory（必读 `nodesign_sdk_principle.md`）|

---

## 8. cold-start 推荐阅读路径

1. `nodesign_sdk_principle.md`（memory）—— 1 分钟，核心原则
2. `HANDOVER_2026-04-30_stage1.md` § 1-3 —— 5 分钟，代码地图
3. **本文 § 2-3** —— 3 分钟，Phase 1+2+3 增量
4. 视任务而定：本文 § 5 已知边界 / `loop.js` / `hooks.js` 直接看代码
