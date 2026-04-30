# HANDOVER — NoDesign Stage 1 收尾（2026-04-30）

> 给未来接手的人 / 未来的自己（cold-start 时）。
>
> 这份不是流水账（流水账看 SESSION 文档），是**代码地图 + 主线流程指针 + debug 入口**。
> 一图看清"我们在哪一层工作 / 什么放在哪 / 怎么找东西"。

---

## 1. 一句话定位

NoDesign = **Claude Code 之上的画布编辑层**。底层 agent 能力（LLM / agent loop /
工具集 / session / file checkpoint / hooks / MCP / subagent / permission）**完全
来自 Claude Agent SDK**（`@anthropic-ai/claude-agent-sdk@0.2.123`）。我们的代码
集中在 4 件事：

| 我们做的 | 在哪里 |
|---|---|
| ① 薄壳后端（包 SDK + REST/WS） | `server/` |
| ② 前端画布编辑层（chat / iframe / direct edit） | `web/src/` |
| ③ 1 个默认 SKILL.md（教 agent 做 deck） | `server/engine/skills/deskskill-engine-mini/` |
| ④ 4 hooks + 3 MCP tools + 3 subagents（业务逻辑） | `server/engine/{hooks,mcp,agents}/` |

**偏不远**：把 server / web 全删，SDK 直接 `npx claude` 在 workspace 里仍能跑。

---

## 2. 项目结构（按层 + 每层关键文件 + 哪个 commit 改的）

### 2.1 Server 层 (`server/`)

```
server/
├── index.js                  Express 4001 + WS upgrade（P0 C2）
├── ws/
│   ├── index.js              WS upgrade handler（P0 C2）
│   └── broker.js             per-project EventBus + subscribe/emit（P0 C2）
├── projects/
│   ├── store.js              SQLite projects 表（P0 C1）
│   └── workspace.js          ensureProjectWorkspace + git init（P0 C1）
├── api/
│   ├── projects.js           CRUD（P0 C3）
│   ├── canvas.js             read/write/history/revert/undo + spec reader
│   │                         （P0 C3 + C12 undo + C29 spec endpoint）
│   ├── assets.js             multipart upload（P0 C3）
│   ├── exports.js            HTML/PDF/Handoff + list/file 下载
│   │                         （P0 C4 + C10 buildHandoffZip 抽公共 + C31 list/file）
│   ├── turn.js               POST /turn 唯一 LLM 入口 + cancel endpoint
│   │                         （P0 C5 + C2 prompt 切流式 + cancel 终止生成）
│   └── skills.js             GET /skills（P0 C3）
└── engine/
    ├── agent/
    │   ├── loop.js           ★ runAgent 主入口；SDK options 配置；message 翻译
    │   │                     （P0 C1 起，stage 1 大量改动 C1/C2/C3/C8/C13 + hotfix）
    │   ├── context.js        AgentContext（P0 C1）
    │   ├── events.js         EventBus + 30+ 种事件构造器
    │   │                     （P0 C1 + C1 stage 1 扩展）
    │   ├── hooks.js          ★ 4 件套 hook：FileChanged/PreToolUse/Stop/PostCompact
    │   │                     （C3 骨架 → C4-C7 逐个填实）
    │   └── skill.js          loadSkill（读 SKILL.md frontmatter+body）
    ├── skills/
    │   └── deskskill-engine-mini/
    │       └── SKILL.md      ★ agent 行为约束（C2 起 → C37 v0.2 正式版 → hotfix）
    ├── mcp/
    │   ├── index.js          MCP server 工厂（C8）
    │   └── tools/
    │       ├── screenshot.js     screenshot_canvas（playwright headless，C9）
    │       ├── export-handoff.js export_handoff（复用 buildHandoffZip，C10）
    │       └── record-decision.js record_decision（写 spec.json，C11）
    ├── agents/
    │   ├── index.js                AgentDefinition 集合（C13）
    │   ├── vision-checker.md       prompt（C14）
    │   ├── ds-extractor.md         prompt（C15）
    │   ├── tweak-proposer.md       prompt（C16）
    │   └── schemas/
    │       ├── design-system.json  H 流 schema（C15）
    │       └── tweak-schema.json   F 流 schema（C16）
    ├── runs/
    │   ├── store.js                SQLite runs 表（P0 C1）
    │   └── active-runs.js          ★ AbortController registry（终止生成）
    └── runtime/
        └── workspace.js            旧 runId workspace utils（兼容旧 smoke）
```

### 2.2 Web 层 (`web/src/`)

```
web/src/
├── main.jsx + App.jsx        入口 + 路由（P0 不动）
├── routes/
│   ├── Home.jsx              项目列表 + 新建入口（P0 C6 + C30 移除 mode）
│   ├── Project.jsx           ★ 三栏工作台主战场（700+ 行）
│   │                         (P0 C6 真接 → C17 加 11 种新事件 case + 4 state →
│   │                          C19/C18/C20/C29/C31 各组件 wire → 终止生成)
│   ├── DesignSystemList.jsx + DesignSystemNew/Detail.jsx  mock（P1 占位）
│   └── SkillList.jsx         mock（P1 占位）
├── components/
│   ├── layout/
│   │   ├── AppShell.jsx              顶栏 + breadcrumb + actions
│   │   └── ThreeColumnLayout.jsx     左 chat / 中 canvas / 右 context
│   ├── chat/
│   │   ├── ChatPanel.jsx             header + MessageList + Composer（C20 progress chip + 终止按钮）
│   │   ├── MessageList.jsx           滚动容器
│   │   ├── Message.jsx               ★ user/assistant/thinking/tool/system role 渲染
│   │   │                             (C23 tool 强化 + C24 image + C25 SystemMessage +
│   │   │                              C26 thinking 默认展开 + C27 AskUserQuestion +
│   │   │                              C28 Task→agentType)
│   │   ├── ChatComposer.jsx          textarea + tray + Send（C19 SuggestionChip）
│   │   ├── ComposerTray.jsx          附件托盘 chip（P0 C8）
│   │   └── SuggestionChip.jsx        promptSuggestions 预测下条 prompt（C19）
│   ├── canvas/
│   │   ├── CanvasFrame.jsx           中栏壳（toolbar + iframe + overlay）
│   │   ├── HtmlIframe.jsx            iframe 加载 canvas.html（C32 scroll 保留）
│   │   ├── DirectEditBridge.js       双击文字 contentEditable + blur 上抛 outerHTML
│   │   ├── EditOverlay.jsx           选中元素 outline（D 流盲区，P0 已有）
│   │   ├── CanvasToolbar.jsx         Edit/Preview/Code 切换 + zoom
│   │   ├── CanvasCandidateBar.jsx    候选切换条（P0+ stage 2 接通）
│   │   ├── SlideNavigator.jsx        顶部 thumbnail 条
│   │   ├── A11yReviewPopover.jsx     a11y 评审 popover
│   │   ├── DirectEditModal.jsx       多属性 modal（P0+ stage 2）
│   │   └── UndoButton.jsx            撤销按钮（C12）
│   ├── context-panel/
│   │   ├── ContextPanel.jsx          6 tab 容器（C29 加 Decisions tab）
│   │   ├── InputsTab.jsx             附件上传
│   │   ├── InspectTab.jsx            元素检查（D 流盲区）
│   │   ├── CommentsTab.jsx           评论列表（D 流不在 P0+ s1）
│   │   ├── DecisionsTab.jsx          ★ spec.json viewer（C29）
│   │   └── SystemTab.jsx             skill / DS / model 信息
│   ├── project/
│   │   ├── CreateProjectModal.jsx    新建项目向导（C30 移除 mode）
│   │   ├── ShareModal.jsx
│   │   ├── ExportMenu.jsx            导出 dropdown（C31 加"已生成"入口）
│   │   ├── ExportsListModal.jsx      ★ workspace/exports/ 列表（C31）
│   │   ├── ContextUsageBar.jsx       顶栏 chip（C18）
│   │   ├── ProjectActionsMenu.jsx    ⋯ 菜单
│   │   └── SnapshotModal.jsx         快照管理（P0+ stage 2 真接通）
│   └── ui/
│       └── Modal.jsx + DetailModal/FullPanel/Form 等 UI 原语
├── lib/
│   ├── api.js                ★ REST 客户端（Projects/Canvas/Spec/Assets/Exports/Turn/Health）
│   ├── ws-client.js          openProjectWS（指数退避重连）
│   ├── theme.js              COLOR/GAP/FONT_SIZE 等 token
│   ├── helpers.js            newId / timeAgo
│   ├── html-utils.js         findElementByAnchor 等
│   └── element-semantics.js  元素语义识别（D 流盲区）
├── stores/
│   ├── projectStore.js       Zustand：projects 数组 + hydrate + applyRunEvent
│   └── globalStore.js        toast / chatDraft（跨组件注入）
└── mock/
    └── deck-spec.js          MOCK_DECK_SPEC（dev fallback）
```

---

## 3. Commit 时间线（按阶段，63 个 commit）

| 阶段 | commit 数 | 范围 | 关键内容 |
|---|---|---|---|
| **P0**（重做）| 11 | `f489a3d`...`9e27924` | 主线 5 流（A/B/C/E/I）真接：projects + workspace + agent loop + REST + WS + 前端真接 + 自动起首跑 + direct edit + attachments + 导出 |
| **P0+ stage 1** | 22 | `05b5a11`...`d9582b9` | 全量切到 SDK 现成能力：4 hooks + 3 MCP tools + 3 subagent 骨架 + file checkpoint 双轨 + multimodal user message + 流式 + 前端 11 种新事件 + ContextUsageBar/SuggestionChip/agentProgress |
| **Phase H** | 10 | `6e904dc`...`36f5199` | 前端可视化补完：Tool 图标/elapsed/折叠/image 渲染/流式打字/Thinking 暴露/SystemMessage/AskUserQuestion 卡片/Subagent Task→agentType/Decisions tab/ExportsList/移除 mode/iframe scroll 保留 |
| **Phase I**（文档对齐）| 5 | `85ca3f6`...`90d746b` | SESSION + PLAN 同步 / Claude_design 顶部加现状 / memory.md 同步 + 新 SDK 原则文件 / SKILL.md v0.2 正式版 |
| **Hotfix**（撞 bug 修）| 5 | `9e27924` (vite proxy) / `c880384` (api.js) / `dbc173f` (SDK 用法) / `761a1c0` (revert 工具禁用) / 终止生成 | 见下面"已撞过的坑"段 |
| **终止生成** | 2 | `e97f64d` + `007691d` | 后端 active-runs registry + cancel endpoint + 前端 Stop 按钮 |
| **本文档** | 1 | 本 commit | HANDOVER 文档 |

---

## 4. 主线流程（怎么找东西）

### 4.1 用户输入 → agent 跑 → 产物显示

```
用户在 chat 输入文字 + 上传素材
  ↓ web/src/components/chat/ChatComposer.jsx (textarea + tray)
  ↓ web/src/components/context-panel/InputsTab.jsx (附件上传 → Assets.upload)
  ↓
前端 send → POST /api/projects/:pid/turn
  ↓ web/src/routes/Project.jsx handleSend
  ↓ web/src/lib/api.js Turn.send
  ↓
后端 server/api/turn.js POST /turn
  ↓ composeUserMessage(chat, attachments) → BetaContentBlockParam[]
  ↓ createRun + 立即 res.status(202) { runId }
  ↓ 异步 runAgent({ workspaceRoot, eventBus, userContentBlocks, ... })
  ↓
server/engine/agent/loop.js runAgent
  ↓ registerRun(runId, ctx.abortController)  ← 终止生成
  ↓ 拼 sdkOptions（含 systemPrompt preset/permissionMode/hooks/mcpServers/agents/...）
  ↓ const stream = query({ prompt: userMessageStream, options })
  ↓
SDK spawn claude binary → LLM 调用
  ↓ agent 调工具：Read/Write/Edit/Bash/AskUserQuestion + mcp__nodesign__*
  ↓
SDK 推 message 流（28+ 种 type）
  ↓ loop.js handleSDKMessage / handleSystemMessage / handleStreamEvent
  ↓ → events.js Events.* 构造事件
  ↓ ctx.emit → EventBus
  ↓
server/ws/broker.js 订阅 EventBus → ws.send(JSON)
  ↓
web/src/lib/ws-client.js 透传给 onEvent
  ↓
web/src/routes/Project.jsx handleEvent (30+ 种 case)
  ↓ 各组件消费：Message / ChatPanel / ContextPanel / DecisionsTab / iframe
```

### 4.2 agent 写完文件 → iframe 自动 reload

```
agent Write canvas.html
  ↓ SDK 检测文件变化 → FileChanged hook 触发
  ↓ server/engine/agent/hooks.js makeFileChangedHandler
  ↓ ctx.emit({ type: 'run.file_changed', filePath, event })
  ↓ WS 推前端
  ↓ Project.jsx handleEvent case 'run.file_changed'
  ↓ if filePath endsWith canvas.html → setReloadToken(t+1)
  ↓ HtmlIframe.jsx src 变化 → reload + useEffect cleanup 捕 scrollY → handleLoad 还原 scrollY (C32)
```

### 4.3 用户点"停止生成"

```
ChatPanel header 红色"停止"按钮（streaming 时渲染）
  ↓ onClick → onStop
  ↓ Project.jsx handleStop → Turn.cancel({ pid, runId })
  ↓ POST /api/projects/:pid/runs/:runId/cancel
  ↓
server/api/turn.js cancel handler
  ↓ cancelRun(runId, 'user_cancel')
  ↓ active-runs.js → activeControllers.get(runId).abort('user_cancel')
  ↓
SDK 看到 abort signal → query 中断
  ↓ loop.js for await throw → catch
  ↓ ctx.signal.aborted=true → 走 cancelled 路径
  ↓ ctx.emit Events.cancelled
  ↓ finally unregisterRun(runId)
  ↓
WS 推前端 → Project.jsx case 'run.cancelled'
  ↓ setIsStreaming(false) + setCurrentRunId(null) + 清 progress + toast
```

---

## 5. SDK 用法关键决策（不要踩老路）

### 5.1 sdkOptions 7 个必设字段

`server/engine/agent/loop.js` 拼 sdkOptions 时这 7 个字段是**关键架构决策**，别瞎改：

| 字段 | 值 | 为什么 |
|---|---|---|
| `systemPrompt` | `{ type: 'preset', preset: 'claude_code', append: skill.systemPrompt }` | 继承 SDK 默认约束（何时停 / be concise / task completion）；SKILL.md 仅 append 业务约束。**string 模式会让 agent 失去这些约束 → 一个 turn 做 30 件事停不下来** |
| `permissionMode` | `'bypassPermissions'` + `allowDangerouslySkipPermissions: true` | 跳过 binary stdio prompt；危险命令拦截走 PreToolUse hook。**默认 'default' 会让 binary 等 stdin → spawn 没接 stdin → hang（"ask 不 pending"真根因）** |
| `enableFileCheckpointing` | `true` | session 内 rewindFiles 能用；跨 session 走 git commit 双轨 |
| `agentProgressSummaries` | `true` | subagent 30s 摘要事件，piggyback prompt cache 几乎免费 |
| `promptSuggestions` | `true` | 每轮预测下条 prompt 给 SuggestionChip |
| `includePartialMessages` | `true` | stream_event → 流式打字（loop.js handleStreamEvent 处理 text_delta/thinking_delta） |
| `maxTurns` | 15 | **一个 turn 上限**。50 太宽（agent 反复优化）；15 够写完 canvas + 1-2 次自检；不够时该收尾让用户反馈 |

### 5.2 5 条新设计原则

1. **agent 能力 = SDK**。不要自撸 LLM/agent loop/工具/session/checkpoint。
2. **可见性优先**。"agent 在做什么"必须在前端可见。
3. **不框定模式**。SDK 接通后 agent 自决；不要前端预设 mode/skill type。
4. **双轨持久化**。session 内 rewindFiles + 跨 session git。
5. **沙盒分阶段**。stage 1 cwd + Bash 白名单；stage 2 上 Docker via `spawnClaudeCodeProcess` 钩子。

### 5.3 已撞过的坑（不要重蹈）

- ❌ `systemPrompt: skill.systemPrompt`（string 完全覆盖）→ 失去 SDK 默认约束
- ❌ 默认 permissionMode + spawn 没接 stdin → AskUserQuestion / 危险操作 prompt 卡死
- ❌ `canUseTool always-allow` 不能 override binary stdio prompt（要 permissionMode）
- ❌ 自撸 git commit/revert/history endpoint（SDK 有 `enableFileCheckpointing` + `rewindFiles`）
- ❌ brief 字符串拼附件路径（用 content blocks）
- ❌ iframe reloadToken 手动 bump（用 FileChanged hook）
- ❌ "自由创作 vs 参照模式" 等 mode 框定（agent 自决）
- ❌ 自定义 ask 工具（SDK 内置 AskUserQuestion）
- ❌ 自作主张禁用 SDK 工具（治标不治本，应该改 SDK options）

---

## 6. Debug 入口

| 症状 | 看哪 |
|---|---|
| **agent 不响应** | server console（claude.stderr）+ browser DevTools Network → WS 连接 |
| **iframe 不刷新** | Project.jsx handleEvent 收到 `run.file_changed` 没？filePath 命中 canvas.html 吗？reloadToken bump 了？ |
| **chat 看不到 agent 在做什么** | `events.js` 翻译完整否？`Project.jsx handleEvent` case 全否？Message.jsx tool 渲染 |
| **"ask 不 pending"** | `loop.js` permissionMode 是 `'bypassPermissions'` 吗？`allowDangerouslySkipPermissions: true` 吗？没设的话 binary stdio hang |
| **"停不下来"** | maxTurns 多少？systemPrompt 用 preset 'claude_code' 吗？SKILL.md 引导是否合理 |
| **工具被拦** | `hooks.js` PreToolUse Bash 白名单 + DANGEROUS_PATTERNS；前端会收 `run.bash_blocked` 事件 |
| **spec.json 没更新** | agent 调 `record_decision` 工具了吗？看 chat tool 调用历史；PostCompact hook 触发了吗 |
| **子代理跑不动** | stage 1 不接通主流程；agent SKILL.md 引导"不主动调"；用户明确要求时才 Task 调 |
| **截图返回 base64 字符串而非图** | tool_result 中 image content block 路径 fix 见 C24（`loop.js handleUserBlocks` 提取 images 数组） |
| **导出文件找不到** | agent export_handoff 写到 `workspace/exports/`；前端 ExportMenu 底部"已生成的交付文件"打开 modal 看 |
| **撤销不动** | `Canvas.undo()` → POST /canvas/undo → git checkout HEAD~1 -- canvas.html；最早版本时 code='NO_PREV_COMMIT' |

---

## 7. 关键文件 cheatsheet

读代码先看这几个：

```
server/engine/agent/loop.js                 ★ runAgent 主入口；SDK options 中心
server/engine/agent/hooks.js                ★ 4 件套 hook 业务逻辑
server/engine/agent/events.js               ★ 30+ 种事件构造器（前端事件协议看这里）
server/engine/skills/deskskill-engine-mini/SKILL.md  ★ agent 行为约束
server/engine/mcp/index.js                  MCP server（4 工具注册）
server/engine/agents/index.js               3 子代理 AgentDefinition
server/api/turn.js                          POST /turn + cancel endpoint
server/engine/runs/active-runs.js           AbortController registry

web/src/routes/Project.jsx                  ★ 三栏工作台主战场（700+ 行）
web/src/lib/api.js                          REST 客户端（Projects/Canvas/Spec/Exports/Turn）
web/src/lib/ws-client.js                    WS 透传 + 重连
web/src/components/chat/Message.jsx         ★ 5 种 role 渲染（含 ToolMessage/SystemMessage/AskUserQuestionView）
web/src/components/chat/ChatPanel.jsx       header progress + Stop 按钮
web/src/components/context-panel/DecisionsTab.jsx  spec.json viewer
web/src/components/project/ExportsListModal.jsx    workspace/exports/ 列表
```

---

## 8. 怎么继续推进（stage 2 候选）

详见 `SESSION_2026-04-30_p0plus_stage1_full_sdk_switch.md` "延后清单"。
按优先级简版：

1. **subagent 真调用流**（vision-checker / ds-extractor / tweak-proposer）—— H 流 / F 流接通入口
2. canUseTool 接 UI 权限弹窗（D 流权限交互定型后）
3. SessionStore 自定义实现（多实例部署）
4. streamInput 多轮 query 复用（省 spawn 开销）
5. rewindFiles per-query 真接通
6. **Docker 沙盒 per project**（多用户公测前）—— 用 SDK `spawnClaudeCodeProcess` 钩子，改一处
7. D 流 inline comment（anchor 序列化方案敲定）
8. WS event log + lastEventId replay（断网恢复）
9. screenshot pool（playwright 进程池）
10. PPTX 导出 / Canva 互通

---

## 9. 文档索引

| 文档 | 用途 |
|---|---|
| **本文 HANDOVER_2026-04-30_stage1.md** | 你现在看的——代码地图 + 主线流程 + debug 入口 |
| `PLAN.md` 顶部"🟢 当前状态" | 一句话定位 + 5 条设计原则 + 老段落已替代清单 |
| `SESSION_2026-04-30_p0plus_stage1_full_sdk_switch.md` | 32 commit 完整流水 + e2e 22 步 + 沙盒占用估算 + 延后清单 |
| `SESSION_2026-04-30_P0.md` | P0 11 commit 流水（早些时候） |
| `Claude_design.md` | 1591 行 Claude Design 拆解（产品体验参考；不再作代码实现指南） |
| `~/.claude/projects/*/memory/MEMORY.md` | 跨 session memory index |
| `~/.claude/projects/*/memory/nodesign_sdk_principle.md` | 核心原则 SDK 不要自撸（必读） |
| `~/.claude/projects/*/memory/nodesign_p0plus_stage1_summary.md` | stage 1 + Phase H 总览 |
