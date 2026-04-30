# SESSION 2026-04-30 — P0+ stage 1: 全量切换到 Claude Agent SDK 现成能力

## 起因

P0（同日早些时候）完成 11 commit ship，跑通 5 流（A/B/C/E/I）。

之后深度吃了 `@anthropic-ai/claude-agent-sdk@0.2.123` 的 5524 行
`sdk.d.ts`，发现我们手撸了一批 SDK 已经提供的能力（git checkpoint /
multimodal user message / iframe reload bust / Bash 沙盒），并且没用上
SDK 大量上层能力（hooks / MCP / agents / outputFormat / progress
summaries / prompt suggestions / context usage / canUseTool）。

本 stage 1：用 SDK 现成能力替代手撸部分 + 引入新能力，为后续 D/F/H
流和 agent 主动行为打基础。

## 关键架构判断（用户拍版）

1. **Checkpoint 双轨**：session 内 SDK rewindFiles + 跨 session git。git 不删。
2. **User msg 切流式**：`prompt: AsyncIterable<SDKUserMessage>` + content blocks。附件仍按文本路径 + Read 工具读取（不 base64 内联）。
3. **Hooks 4 件套**：FileChanged / Stop / PreToolUse(Bash) / **PostCompact**（plan 原写 PreCompact，C7 修正为 PostCompact，因 PreCompact 没 compact_summary 字段）。
4. **MCP 工具集**：screenshot_canvas / export_handoff / record_decision。
5. **agents 子代理**：vision-checker / ds-extractor / tweak-proposer 三个骨架（这次只挂定义，主线不主动调）。
6. **outputFormat: json_schema**：只为 ds-extractor / tweak-proposer 准备 schema 文件。**SDK AgentDefinition 没有 outputFormat 字段**（C15 实测发现），所以子代理走 **prompt 内嵌 schema 引导** + main agent JSON.parse 路线。
7. **零风险默认带**：agentProgressSummaries / promptSuggestions / canUseTool 占位 / getContextUsage（前端用 system_init 元信息替代真实 token 数）。

「opus 有的功能 Kimi 都有」按这个先验定，不为模型差异加 fallback。

## 22 commit 改动清单

### Phase A — 后端基础切换（2 commits）

| # | 改动 | 文件 |
|---|---|---|
| C1 | loop.js 加 4 个 SDK options（enableFileCheckpointing / agentProgressSummaries / promptSuggestions / canUseTool 占位）+ events.js 翻译 28+ 种 SDK message 类型 | events.js, loop.js |
| C2 | prompt 切 `AsyncIterable<SDKUserMessage>` + composeBrief 改名 composeUserMessage 返回 content blocks | turn.js, loop.js |

### Phase B — Hooks 4 件套（5 commits）

| # | 改动 | 文件 |
|---|---|---|
| C3 | hooks.js 骨架 + loop.js 装 hooks option（noop SessionStart 通路验证） | hooks.js, loop.js |
| C4 | FileChanged hook → EventBus emit `run.file_changed` → Project.jsx 自动 reload iframe | events.js, hooks.js, Project.jsx |
| C5 | PreToolUse(Bash) 命令白名单（30 个白名单 token + 12 条危险正则） | hooks.js |
| C6 | Stop hook agent 收尾自检（占位 emit run.stop_reflection，不强迫继续） | hooks.js |
| C7 | PostCompact hook 把 compact_summary 写入 spec.json.history（修正 plan PreCompact → PostCompact） | hooks.js |

### Phase C — MCP 自定义工具集（4 commits）

| # | 改动 | 文件 |
|---|---|---|
| C8 | MCP server 骨架（createSdkMcpServer + ping 占位）+ loop.js 挂 mcpServers: { nodesign } | mcp/index.js, loop.js |
| C9 | screenshot_canvas tool（playwright headless → image content block，agent vision 直接看） | mcp/tools/screenshot.js, mcp/index.js |
| C10 | export_handoff tool（buildHandoffZip 抽公共 + MCP tool 写到 workspace/exports/） | api/exports.js, mcp/tools/export-handoff.js, mcp/index.js |
| C11 | record_decision tool（写入 spec.json.decisions[] 设计意图档案） | mcp/tools/record-decision.js, mcp/index.js |

### Phase D — file checkpoint 双轨（1 commit）

| # | 改动 | 文件 |
|---|---|---|
| C12 | POST /canvas/undo 简版（git checkout HEAD~1）+ 前端 UndoButton + Project.jsx wire | canvas.js, api.js, UndoButton.jsx, Project.jsx |

### Phase E — agents 子代理定义（4 commits）

| # | 改动 | 文件 |
|---|---|---|
| C13 | agents/index.js 骨架（3 个 AgentDefinition 含 STUB prompt）+ loop.js 挂 agents | agents/index.js, loop.js |
| C14 | vision-checker.md 真实 prompt + agents/index.js 切 loadPrompt 同步读 .md | agents/vision-checker.md, agents/index.js |
| C15 | ds-extractor.md + schemas/design-system.json（颜色/字号/间距/阴影/圆角/idiom 完整 schema）+ index.js | agents/ds-extractor.md, agents/schemas/design-system.json, agents/index.js |
| C16 | tweak-proposer.md + schemas/tweak-schema.json（4 种 tweak 类型 oneOf：number/select/color/boolean）+ index.js | agents/tweak-proposer.md, agents/schemas/tweak-schema.json, agents/index.js |

### Phase F — 前端配套（4 commits）

| # | 改动 | 文件 |
|---|---|---|
| C17 | Project.jsx handleEvent 加 11 种新事件 case + 4 个新 state（systemInfo / promptSuggestion / agentProgress / toolElapsed） | Project.jsx |
| C18 | ContextUsageBar 顶栏组件（model/tools/mcp/agents 4 chip，title 详情） | ContextUsageBar.jsx, Project.jsx |
| C19 | SuggestionChip 入 ChatComposer（"使用" 接受立即发 / "×" dismiss） | SuggestionChip.jsx, ChatComposer.jsx, ChatPanel.jsx, Project.jsx |
| C20 | ChatPanel header 显示 subagent 30s 进度摘要（替代固定"思考中…"） | ChatPanel.jsx, Project.jsx |

### Phase G — 文档（2 commits）

| # | 改动 | 文件 |
|---|---|---|
| C21 | 本 SESSION 文档 | SESSION_2026-04-30_p0plus_stage1_full_sdk_switch.md |
| C22 | PLAN.md 推进表 + 实施日志 | PLAN.md |

**总计**：22 commits，每个 ≤ 4 文件（C12/C19 各 4 文件，其他 ≤ 3）。

## e2e 验证步骤（用户跑一遍）

前置：后端 + 前端起来，老 5 流必须仍 e2e 通。

```bash
# Terminal 1: 后端
cd /Users/edy/Desktop/panel-workplace/Nodesign
node server/index.js

# Terminal 2: 前端
cd web && npm run dev
```

打开 `http://localhost:5174/`：

### 老流回归

1. **A 流**：新建项目 + brief → agent 写 canvas.html → iframe 显示
2. **C 流**：chat 输指令 → agent 改 → iframe FileChanged hook 自动 reload（不再依赖 run.done bump，但 run.done 仍兜底 bump 双保险）
3. **E 流**：双击改字 → blur → PUT /canvas + git commit
4. **B 流**：上传图 → 进托盘 → send → user message 是 content blocks 结构 → agent 用 Read 读到
5. **I 流**：导出按钮 HTML / PDF / Handoff

### 新功能

6. **顶栏 ContextUsageBar**：项目打开后，actions 起首应该看到 4 个 chip：model / tools / mcp / agents
7. **UndoButton**：改字 → 点"撤销" → 文字回到改前。已经在最早版本时点 → toast "已经是最早版本"
8. **FileChanged 自动 reload**：构造 chat 让 agent 写 canvas → 不需手动 reload 看到新版本
9. **PreToolUse 拦截**：构造 chat 让 agent 跑 `rm /etc/passwd` → 拦截 deny → chat 留痕"⚠️ 拦截 Bash 命令…"
10. **MCP screenshot_canvas**：chat "截图自检一下" → agent 调 mcp__nodesign__screenshot_canvas → toast "agent 正在视觉自检"
11. **MCP export_handoff**：chat "把这个交付给我" → agent 调 export_handoff → toast "已生成交付包"
12. **MCP record_decision**：chat "记下这次配色决策" → agent 调 record_decision → spec.json.decisions[] 多了一条
13. **PostCompact**：跑超长 session 触发 compact → spec.json.history[] 多了一条 + toast
14. **promptSuggestions**：每轮 chat 后 ChatComposer 上方出 SuggestionChip
15. **agentProgress**：长 turn 时 ChatPanel header 文字变成具体描述（"正在调整字号节奏…"）

任一步 fail 立即停下排查根因，不跳过。

## 已知风险

1. **rewindFiles vs git race**：FileChanged hook 写 git commit 时 SDK 内部正 mark checkpoint。**未测**先后顺序冲突。
2. **playwright spawn 慢**：每次 screenshot_canvas 启 chromium ~1-2s。stage 2 上 pool。
3. **outputFormat 子代理级别不支持**：C15 发现 SDK AgentDefinition 没 outputFormat 字段。改用 prompt 内嵌 schema 引导。stage 2 接通流程时要加 main agent JSON.parse retry on error。
4. **PreToolUse Bash 白名单边角**：`bash -c "..."`/管道/`&&`未测；DANGEROUS_PATTERNS 兜底，但子命令未深度解析。
5. **agents 定义但不主动调**：SDK 加载 agents 后 Task 工具暴露给 main agent。SKILL.md 没引导避免（**stage 1 风险点**）。可能需要 SKILL.md 加一段"暂不主动调子代理"。
6. **events.js 新 message 翻译可能漏**：28 类 SDK message + 14 个 system subtype 都列了 case，但实测一遍要看 console.warn `unknown` 出现频率。
7. **content blocks 结构 vs Kimi 兼容**：`prompt: AsyncIterable<SDKUserMessage>` 切了，但 Kimi 是否完整支持 BetaContentBlockParam 多模态结构未测。如果 Kimi 只接受 string 会 fall back（pure text content block 就是单 element 数组）。
8. **22 commit 跨 Phase 依赖**：Phase 之间有依赖（B 依赖 A 的 hooks option，D 依赖 A 的 enableFileCheckpointing）。**不要 cherry-pick 中间 commit**——拉整个 stage 才一致。

## 延后清单（P0+ stage 2 之后）

按优先级：

1. **canUseTool 接 UI 权限弹窗**（D 流权限交互定型后）
2. **SessionStore 自定义实现**（把 session JSONL 存 SQLite，便于跨实例 / 远端部署）
3. **streamInput 多轮 query 复用**（省 spawn 开销，但要解决 idle 子进程回收）
4. **subagent 真调用流**（vision-checker 自检 / ds-extractor H 流 / tweak-proposer F 流分别落地，含 main agent 的 JSON.parse retry）
5. **rewindFiles per-query 接通**（loop.js 维护 activeQueries Map，POST /canvas/undo 优先用 query.rewindFiles，fallback git）
6. **toolElapsed 渲染**（C17 set state 已就位，C20 没渲染——Message 组件 tool 类型加 elapsed time）
7. **SYSTEM_PROMPT_DYNAMIC_BOUNDARY** prompt cache 精控
8. **agent 主动 fork variant**（forkSession + 前端 CanvasCandidateBar 接真切换）
9. **WS event log + lastEventId replay**（断网 / 重连恢复）
10. **screenshot pool**（playwright 进程池）
11. **Stop hook 真有用版**（要不要 screenshot / export 自检的 systemMessage 注入）
12. **D 流 inline comment**（anchor 序列化方案敲定）
13. **F 流 custom slider 前端**（schema 已就位）
14. **H 流 DS 抽取前端 UI**（schema 已就位）
15. **PPTX 导出 / Canva 互通**

## 关键 SDK 用法笔记（给未来的我看）

- `prompt: AsyncIterable<SDKUserMessage>` → `query()` 接口可流式输入 user message。单次 `yield` 后 generator 结束 → SDK 进 agent loop。多轮 streamInput 复用要 generator 不结束 + 外部 push 队列。
- `enableFileCheckpointing: true` → SDK 在每个 user message 处快照文件，`Query.rewindFiles(userMessageId)` 回滚。**per-query** —— 跨 session 失效，所以双轨 + git 长期。
- `agents` field 接 `Record<string, AgentDefinition>`。**没有 outputFormat 字段**——子代理强制 JSON 输出走 prompt 内嵌 schema。
- `mcpServers: { name: createSdkMcpServer({ tools: [...] }) }` → in-process MCP server。tools 用 `tool(name, desc, zodRawShape, handler)` 创建。agent 端工具名是 `mcp__<server>__<tool>`。
- `hooks: { [HookEvent]: HookCallbackMatcher[] }` → 每个 event 一组 hook。matcher 字段（如 'Bash'）让 SDK 只在匹配工具调用时触发。返回 `SyncHookJSONOutput`（continue/decision/systemMessage/hookSpecificOutput/...）。
- `canUseTool: (toolName, input, ctx) => { behavior: 'allow' | 'deny' }` → 自定义权限处理器。每个工具调用前回调，必须返回。
- `agentProgressSummaries: true` + `promptSuggestions: true` → 几乎免费（piggyback prompt cache）。30s 摘要事件 `task_progress`，prompt suggestion 事件 `prompt_suggestion`。
- SDK 一共 **28+ 种 message type/subtype**（见 events.js 头部注释）。从 sdk.d.ts:2988 SDKMessage union 起读。
- `SDKResultMessage` 的 `subtype: 'success'` 才有 `result` 字段；`error_*` 子类型有 `errors[]`。
