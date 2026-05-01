# HANDOVER — Phase 2: Thinking 修复 + 上下文修复 + Timeline UI 精修（2026-05-01 下半场）

> 给下一段接手做 canvas 智能编辑 / design 能力的 session（cold-start）。
>
> 上一段（同日上午）：S1-H5 session-scoped workspace 重构，11 commit
> （见 [HANDOVER_2026-05-01_session_scoped_workspace.md](HANDOVER_2026-05-01_session_scoped_workspace.md)）。
>
> 本段（同日下半场）：17 commit，主题"agent 跑得对 + 用户看得清"。

---

## 1. 一句话定位

NoDesign 现在 **agent 端可用** —— Kimi thinking 通了、上下文不爆、上下文使用观察到位、timeline UI 跟 Claude Code native 视觉对齐。**下一段做真正的 canvas 智能编辑**（让 deck 设计 agent 真好用）。

---

## 2. 17 commit 按主题（按重要度排）

### 主题 A：Kimi thinking 修复（核心，2 commit）

| Commit | 内容 |
|---|---|
| `28c48f9` | probe 留档：T1-T6 直连测试 + binary intercept proxy 诊断证据 |
| `069e595` | **binary-fixup-proxy** —— NoDesign server 进程内 mini HTTP proxy，binary 出口拦 `/v1/messages` POST 把 `thinking.type adaptive→enabled` |

**根因**：SDK binary 对**非白名单 model id** 一律 fallback `thinking.type=adaptive`，但 Kimi gateway 不支持 adaptive。详见 memory `feedback_kimi_thinking_blocks.md`。

**关键代码**：[server/lib/binary-fixup-proxy.js](server/lib/binary-fixup-proxy.js)。仅匹配 `^kimi/i` model + adaptive thinking 才改，其他请求一律透传，未来 Anthropic 修了删这个文件就可以。

### 主题 B：上下文管理（3 commit）

| Commit | 内容 |
|---|---|
| `a7d20e4` | thinking config 按 model id 自动选 type（Opus 4.6/4.7 → adaptive，其他 → enabled+budgetTokens 8192） |
| `fa21c33` | **settings.json 全局生效 + autoCompactEnabled/Window** — `DEFAULT_NODESIGN_SETTINGS` 代码 = source of truth；每次 ensureProjectWorkspace merge defaults；autoCompactWindow=230000（Kimi 256k 留 10% 阈值） |
| `1255383` | **PostToolUse Edit\|Write trim originalFile** — `FileEditOutput.originalFile` 默认含完整原文件（25KB canvas.html ≈ 6k tokens / Edit），30 turn 累积 180k+ → 触发 256k 上限。hook 用 `updatedToolOutput` 把 originalFile=null，保留 structuredPatch（diff 行）+ filePath 给 model。**只影响 model 视图，jsonl 持久化不动**。每次 Edit 节省 99%。 |

### 主题 C：MCP 工具扩展（3 commit）

| Commit | 内容 |
|---|---|
| `08df134` | **web_search MCP tool**（4 provider 0 依赖）：baidu/tavily/exa/zhipu，按 query 语言自动路由（CJK→baidu，英文→tavily），移植自 `~/.deskclaw/skills/deskclaw-search-pro` |
| `8892a3e` | **WebFetch 用 SDK 内置**（白名单加进 `DEFAULT_TOOL_ALLOWLIST`），不自实现（SDK 自带 LLM 总结控制上下文，比手撸 stdlib 强）|
| `3812cf0` | hooks.js 移除 `record_decision` 冗余 additionalContext 引导（"继续做用户的当前任务" 跟 SDK preset 'claude_code' 重复） |

**Key 配置**：`.env` 已加 `NODESIGN_BAIDU_QIANFAN_KEY=bce-v3/...`（来自 deskclaw skill 复用）。`.env` 在 .gitignore 不进 commit。其他 provider key 未配，调对应 provider 时返 isError 让 agent fallback。

### 主题 D：Timeline UI 精修（9 commit）

| Commit | 内容 |
|---|---|
| `3bceb76` | timeline group 标题从第一段 thinking 自动提取（纯字符串截取，无 LLM 调用） |
| `cb61f81` | PLAN.md follow-up 列表更新 |
| `583745e` | 修 timeline 线段溢出（DONE icon 之下 + 第一节点之上不再多线，用 React Context 传 position 给 TimelineNode）|
| `f913912` | group title button 视觉强化（用户反馈"根本没有"）|
| `f4ce82c` | group title 缩小克制（参照 Claude Code 图 1：13px / weight 500 / 中灰 / 无底色 / chevron 14px）|
| `a2cbf56` | **工具 icon 实时显示** — handleStreamEvent 加 content_block_start handling，emit `run.tool_use.started`；前端 upsert 模式（同 blockId 存在 update 不重 push） |
| `5a6a2d4` | **删 ThinkingMessage "▼ THINKING" inner label** — Clock icon 已传递语义，冗余装饰删除；保留长 thinking preview + Show more |

后续还有 1 commit（待加 + 这份 HANDOVER）：

- `*pending*` 改 `groupMessages` 让 assistant 全 break group + ThinkingMessage 流式中加 shimmer 动画 + TimelineNode 删 spin + PLAN.md 加 inspect 能力 follow-up + 这份 HANDOVER

---

## 3. 关键架构变更（必读）

### 3.1 Server 进程多了一个内嵌 proxy

**[server/lib/binary-fixup-proxy.js](server/lib/binary-fixup-proxy.js)** —— NoDesign server 启动后第一次 `runAgent` 时懒启动一个 HTTP server on `127.0.0.1:动态端口`，转发到真实 `NODESIGN_GATEWAY_URL`。Server shutdown 时 `stopProxy()` close。

**调用链**：
```
loop.js → getOrStartProxy(realUrl) 拿到 baseUrl
       → SDK options.env.ANTHROPIC_BASE_URL = proxy baseUrl（不是真 gateway）
       → binary spawn 子进程发 HTTP 到 proxy
       → proxy 拦 /v1/messages POST 改 body.thinking 后转发真 gateway
```

测试时记得：**probe / smoke test 跑 NoDesign 链路时**会自动启 proxy，不用手动起。

### 3.2 settings.json merge 不再 if-not-exists

**[server/projects/workspace.js:130-180](server/projects/workspace.js)** —— `ensureProjectWorkspace` 每次都跑 `mergeSettingsDefaults`，merge 顺序 `defaults < existing`（用户字段优先）。代码层面 `DEFAULT_NODESIGN_SETTINGS` 升级时现存 project 自动升级。

### 3.3 PostToolUse hook 不只引导，还能改 tool_result

**[server/engine/agent/hooks.js](server/engine/agent/hooks.js)** —— `Edit|Write` matcher 用 `updatedToolOutput` 改写 tool_response（删 originalFile）。这是 SDK [hookSpecificOutput.updatedToolOutput](node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts#L1944) 的能力 —— `Replaces the tool output before it is sent to the model`，但**不影响 jsonl 持久化**（forkSession / 断线恢复看到的还是完整产物）。

### 3.4 web_search 是自实现 MCP，WebFetch 是 SDK 内置

不要混淆：
- `mcp__nodesign__web_search` —— 我们 `server/engine/mcp/tools/web-search.js`，4 provider，纯 fetch + JSON
- `WebFetch` —— SDK binary 内置，input `{ url, prompt }`，binary 取 URL 后用我们配的 model（Kimi）跑 prompt 总结

### 3.5 Timeline UI 三层结构

```
TimelineGroup（顶部 collapsible title 自动从 thinking 提取 summary）
├─ TimelineNode（thinking, ⏰）  ← ThinkingMessage 内部 render，无 inner label
├─ TimelineNode（tool, 各 icon）  ← ToolUseMessage / Edit/Write/Read 等
├─ TimelineNode（tool）
└─ DONE 节点（仅 closed=true 显示）
```

`MessageList.groupMessages` 现在 **assistant 全 break group**（之前 H5 是 thinking+tool+assistant 都进 group + 末尾 final text 抽出）—— 现在简化：thinking + tool 进 group，assistant/user/system 全 single break。

`TimelineNode` 用 React Context（`TimelineGroupContext.js`）读 `position`（'first'/'middle'/'last'/'only'）决定竖线裁剪范围，不再溢出。

`ThinkingMessage` 流式中**用 shimmer 动画**（`linear-gradient` + `background-clip: text` + 2.4s 扫光）替代 spin icon。Icon 不再旋转。

---

## 4. 给下段 cold-start 的核心信号

### 4.1 你接手的是什么状态

- ✅ **agent 跑得对**：Kimi thinking 通了 + autoCompact 不爆 + Edit 不累积
- ✅ **agent 看得见**：Timeline group 标题 + thinking shimmer + 工具 icon 实时 + 线段不溢出
- ✅ **agent 工具齐**：Read/Write/Edit/Glob/Grep/Bash/TodoWrite/AskUserQuestion + WebFetch（SDK） + web_search（4 provider 自实现） + 3 MCP（screenshot_canvas / export_handoff / record_decision）
- ⚪ **agent 真好用**：**这是你下一段要做的事**

### 4.2 你下一段要做的：让 deck 设计 agent 真做出好 design

按用户原话："下一步我就要真正地完善整个 agent 智能编辑的 canvas，做出真正的 design 了！"

这意味着：
- canvas 编辑能力（agent 写出来的 deck **真好看 + 真符合 brief**）
- 可能要补 SKILL.md（视觉风格 / 排版规范 / 设计 system）
- 可能要补 vision-checker subagent（多页 deck 终审挑刺）
- 可能要做 plan mode（复杂 brief 先 plan 再 do）
- 可能要做 ds-extractor 子代理（用户上传 reference → 抽 design system）

### 4.3 follow-up 列表（按优先级，PLAN.md 内）

1. ~~Kimi thinking blocks~~ ✅ 已修
2. agent 不主动用 agent-memory（SKILL.md 没教）
3. agent 用 shared/assets 验证（probe brief 让 agent 引用上传图）
4. 多 user 并发隔离重审
5. **vision-checker 真接通**（用户认可，多页 deck 终审场景）
6. **Plan mode 接入**（用户明确要做，需先 probe 验证 permissionMode='plan' 跟 'bypassPermissions' 互斥行为）
7. ds-extractor / tweak-proposer 同框架
8. NoDesign agent 接 inspect 能力（看整个应用 UI，不只看自己写的 canvas）

---

## 5. 关键文件 cheatsheet

| 文件 | 改动 | 备注 |
|---|---|---|
| `server/lib/binary-fixup-proxy.js` | **新** | thinking 修复核心，懒启动 |
| `server/projects/workspace.js` | settings.json merge | autoCompact 配置入口 |
| `server/engine/agent/loop.js` | 多处 | model 解析 + thinking config + ANTHROPIC_BASE_URL → proxy + content_block_start |
| `server/engine/agent/hooks.js` | PostToolUse | Edit\|Write trim + record_decision 删 |
| `server/engine/agent/events.js` | 新 toolUseStarted helper | 工具 icon 实时事件 |
| `server/engine/mcp/index.js` | 注册 web_search | |
| `server/engine/mcp/tools/web-search.js` | **新** | 4 provider 联网搜索 |
| `server/engine/skills/deskskill-engine-mini/SKILL.md` | 加 web_search/WebFetch 引导 | |
| `web/src/components/chat/MessageList.jsx` | groupMessages 简化 | assistant 全 break |
| `web/src/components/chat/TimelineGroup.jsx` | summary 自动提取 + 视觉精修 | |
| `web/src/components/chat/TimelineGroupContext.js` | **新** | 给 TimelineNode 传 position |
| `web/src/components/chat/TimelineNode.jsx` | line 范围按 position 裁剪 + 删 spin | |
| `web/src/components/chat/Message.jsx` | ThinkingMessage 删 label + shimmer | |
| `web/src/routes/ProjectWorkspace.jsx` | tool_use upsert + run.tool_use.started case | |
| `server/_probe-kimi.js` | T5 + T6 | 直连 Kimi capability 诊断 |
| `server/_probe-binary-thinking.js` | **新** | binary 出口 intercept 诊断 |
| `.env` | NODESIGN_BAIDU_QIANFAN_KEY | 不进 commit |

---

## 6. memory 状态

| memory file | 状态 |
|---|---|
| `nodesign_sdk_principle.md` | 不动（核心原则） |
| `nodesign_session_scoped_summary.md` | 不动（上半场总结） |
| `nodesign_p0plus_stage1_summary.md` | 不动（更早段总结） |
| `feedback_kimi_thinking_blocks.md` | **重写** —— 真实根因 + binary-fixup-proxy 修复 + 5 类不可行路径留档 |
| `feedback_pacing.md` | 不动（教训反复印证） |
| `feedback_sandbox_replaces_whitelist.md` | 不动 |
| `p3_full_stack_progress_2026-04-29.md` | 不动（已废弃档案） |

下段不需要新 memory。如果做 plan mode 大改，那时再加。

---

## 7. 自检清单（cold-start 第一天）

- [ ] `git log --oneline | head -20` 拉到本日 17+ commit
- [ ] 读本文 + `feedback_kimi_thinking_blocks.md`（修正过的版本）
- [ ] `npm run dev`（server 4001 + web 5174）
- [ ] 起 NoDesign 跑一次新 chat：
  - 工具 icon 在 thinking 完成后**立刻**出现（不等 input 流完）
  - thinking 直接显示内容（无 "▼ THINKING" label）
  - thinking streaming 中文字有"光扫过"（shimmer）
  - assistant 正文打断 timeline group（前一 group 关 done，后段开新 group）
  - DONE 节点下方无溢出竖线
  - group title 是中灰小字 + chevron + 自动 summary
- [ ] context 累积观察：30+ turn 应该不超 230k（autoCompact 触发）
- [ ] thinking blocks 真出现在前端 ThinkingMessage 里（之前 0 → 现在有）
- [ ] web_search 跑一下："2025 mili 乐队最新作品" → 应该返 baidu 结果

如果这些都过 = 17 commit 链路完整生效，可以放心做 canvas 编辑能力。
