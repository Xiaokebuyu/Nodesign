# HANDOVER — A4-A6 batch（agent paradigm 落地 + Canvas v0.6 对齐，2026-05-02）

> 给下一段接手做"5 阶段 paradigm 接通"的 cold-start。
>
> 上一段（同日上午-下午）：F0-F3 FloatingPanel 布局重构（P 系列收尾）+ canvas 焕新升级 S1-S4。本段（同日傍晚-夜）：Canvas v0.6 (C1-C6) + agent capability overhaul (A1-A6)，**21 commit**。
>
> Canvas v0.6 完整架构见 [Canvas.md](Canvas.md) 510 行。

---

## 1. 一句话定位

NoDesign 现在 **agent paradigm 框架成型 + Canvas v0.6 完整能力 + HTML 标准锁定**，剩下是把 paradigm 5 阶段全部接通（plan mode + vision-checker 真接通 + 多变体 + per-user taste），让 agent 真正按 senior designer 工作流走。

---

## 2. 21 commit 按主题（按依赖顺序）

### 主题 A：agent capability overhaul（14 commit，本人）

#### A1 explorer 子代理（研究员）
| Commit | 内容 |
|---|---|
| `31e11cc` | A1.1 explorer subagent + 修 Task 工具白名单 bug（Task 不在 DEFAULT_TOOL_ALLOWLIST → 此前所有 subagent 都形同摆设，4 个 subagent 全调不起来）|

#### A2 实时 context usage 显示
| | | |
|---|---|---|
| `cd8efcd` | A2.1 | 后端 loop.js 每个 assistant message 后 `query.getContextUsage()` fire-and-forget emit `run.context_usage` |
| `cf6795d` | A2.2a | ContextUsageBar 组件升级支持 `liveUsage` prop，进度条 + 百分比 + breakdown tooltip + autoCompact 阈值竖线 |
| `4377a59` | A2.2b/A2.3 | 前端 ProjectWorkspace 接 `run.context_usage` 事件 + compact_boundary toast 升级（带 pre/post token 数） + 阈值预警 toast（>= 90% threshold）|

#### A3 assets symlink 修 Read 图片
| `062df88` | A3.1 | session 加 `assets/` 软链 → `../../shared/assets/` —— 修 H3 重构后路径漂移：prelude 教 `./assets/` 但实际是 `../../shared/assets/`，agent Glob `assets/**/*` 永远 0 结果，连带 Read 图片 ENOENT |

#### A4 AskUserQuestion 走 SDK 原生路径
**根因发现**：cli.js 源码挖到 AskUserQuestion 是 `shouldDefer:true + requiresUserInteraction:true` 的特殊工具，`checkPermissions` 总返 `behavior: 'ask', message: 'Answer questions?'` 等 SDK 调 `canUseTool` callback 让 host 程序提供 input.answers。我们之前撤了 canUseTool（hotfix-sdk-usage 时撤错了），导致 binary 直接 fail tool_result `is_error: true / "Answer questions?"`。

| | | |
|---|---|---|
| `4a4e262` | A4.1+A4.2 | 后端 `canUseTool` callback 拦 AskUserQuestion + emit `run.ask_user_question` + await Promise；`active-runs.js` 加 pendingQuestions Map + registerPendingQuestion / provideAnswer；`turn.js` POST `/api/projects/:pid/runs/:runId/answer` endpoint |
| `08bee85` | A4.3 | 前端 AskUserQuestionView 改走 `Turn.answer({pid, runId, toolUseId, answers})`；prelude 加"怎么问 — AskUserQuestion 工具"完整教学 |
| `91e7e68` | A4.4 | wizard 重写：一次只显示 1 题（之前 N 题平铺）+ collected state 累积 + [← 上一题] [跳过] [下一题 →] 导航 + 末题 [✓ 提交全部 (X/N)] —— 修 bug "点任一选项立即 POST 单题答案" |
| `3e56282` | A4.5 | AskUserQuestion 卡片接上时间轴 icon（HelpCircle）+ status 色 |
| `0e67da9` | A4.6 | thinking 流式超 1000 字自动收起到 500 字 + 字数提示 —— 防视觉爆炸 |
| `51681e6` | A4.7 | 去 isShortNarration 启发式 —— 任何 assistant text 都 break group → DONE 出现（Kimi 交错模式真实内容被当过场过的 bug）|

#### A5 SKILL.md 对齐 Canvas（部分被 A6.1 撤回）
| `cbc9043` | A5.1 | SKILL.md 加 read_page + expose_tweaks 工具表 + 用户直接编辑协议 + Tweaks 暴露协议 + data-node-id 教学（**注**：用户直接编辑协议 + Tweaks 暴露协议两段在 A6.1 dedupe 时删了，因为跟 C4/C5 段重复 —— C4/C5 版更详细）|

#### A6 HTML 规范升级 + scoped tweak（本批核心）
| `6c79fdc` | A6.1 | SKILL.md 大重写：dedupe + HTML 规范升级（5-style-block head / 6 named layouts / 6 件套 data-* 标记 / scoped tweak vars / 完整 example）+ 中文字体 4 项 CDN（思源黑/宋/霞鹜文楷/HarmonyOS Sans）|
| `e8ca5f3` | A6.2 | `expose_tweaks` 加 `target_scope` 字段 — backend zod schema + 前端 TweaksPanel resolveScopeEl helper + applyToIframe / Reset / Apply chat 全部 scope-aware + SKILL.md C5 教 per-page scoped tweak |

### 主题 C：Canvas v0.6 重构（7 commit，外部并行）
| `abc3263` | 前置 | canvas fit-to-canvas + 选中框 zoom 适配 |
| `6ca83dc` | C1 | 8 个新 MCP 工具基建（list_pages / read_page / query_elements / get_computed_styles / navigate_to_page / highlight / expose_tweaks / get-clear_pending_changes）|
| `52c6744` | C2 | System popover 收口（吞掉 Decisions 浮窗）|
| `3cfe6e0` | C3 | Inspect 改 contextual 浮卡（贴选中元素，不再 floating panel）+ Comments 嵌入 |
| `914e780` | C4 | 用户直接编辑 + 评论 buffer，agent 主动拉 |
| `58f1aba` | C5 | Tweaks schema 驱动（5 种控件类型）|
| `a48e53b` | C6 | 反向通道前端消费（navigate_to_page / highlight）|

---

## 3. 当前状态：5 阶段 paradigm 接通度

paradigm 框架（用户 2026-05-02 锚定，必读 memory `nodesign_paradigm_5stage.md`）：

```
[ask] ←─→ [plan] ─→ [explore] ─→ [generate] ─→ [vision-check]
   ↑________________________________________________↓
                    (反馈进下一轮)
```

| 阶段 | ✅ 已通 | ❌ 待接 |
|---|---|---|
| **ask** | canUseTool 路径（A4.1+）+ wizard 卡片（A4.4）+ prelude 完整教学（A4.3）+ 时间轴 icon（A4.5）| "intent extraction" 教学还可深化（多变体 preview 当问题 / 何时停问） |
| **plan** | — | SDK `permissionMode: 'plan'` + 前端 PlanReview 卡片；Kimi binary 链路要先 probe |
| **explore** | explorer subagent（A1.1）+ web_search + WebFetch | 图搜 MCP（Unsplash/Pexels）/ palette+texture curated MCP / per-user taste memory |
| **generate** | Canvas v0.6 完整 13 MCP 工具（C1）+ HTML 单文件 5-style-block 标准（A6.1）+ scoped tweak vars（A6.2）+ pending-changes 回路（C4）+ Tweaks schema（C5）+ 反向通道（C6）| 多变体并发（candidate UI 占位但 generation 没接通）/ list_layouts MCP（暂用 SKILL.md 列）|
| **vision-check** | screenshot_canvas（已 telegraph 多年）| vision-checker subagent skeleton 在但 prompt 没真写 / 主 agent 没被教何时调 / transcript 出口前端没消费 |

---

## 4. 关键架构 / 文件 cheatsheet

### 后端 agent 层
| 文件 | 用途 |
|---|---|
| `server/engine/agent/loop.js` | runAgent 总入口；canUseTool 在这（A4.1）；context usage emit（A2.1）；Task 在 toolAllowlist（A1.1）|
| `server/engine/agent/prompts/nodesign-prelude.md` | 通用 prelude；AskUserQuestion 教学（A4.3）；子代理段（A1.1）|
| `server/engine/agent/events.js` | Events.askUserQuestion / contextUsage / canvasNavigate / canvasHighlight / tweaksExposed / pendingChangesCleared 全在这 |
| `server/engine/agent/hooks.js` | UserPromptSubmit 注入 spec.json 摘要 + canvas 页数；PostToolUse 改 originalFile=null 省 token |
| `server/engine/runs/active-runs.js` | pendingQuestions Map（A4.1）+ registerPendingQuestion / provideAnswer |
| `server/engine/skills/deskskill-engine-mini/SKILL.md` | deck 业务规约；HTML 5-style-block 标准 + 6 named layouts + 6 件套 data-* + scoped tweak（A6.1）；C4 用户直接编辑协议；C5 Tweaks 暴露协议（含 target_scope，A6.2 加）|
| `server/engine/agents/explorer.md` | 研究员 subagent prompt（A1.1）|
| `server/engine/agents/index.js` | 注册 4 个 subagent（explorer / vision-checker / ds-extractor / tweak-proposer），后 3 个有 skeleton 没接通 |
| `server/engine/mcp/index.js` | 注册 13 MCP 工具 |
| `server/engine/mcp/tools/expose-tweaks.js` | ControlSchema 含 target_scope（A6.2）|
| `server/projects/workspace.js` | ensureSessionWorkspace 加 assets symlink（A3.1）|
| `server/api/turn.js` | POST /turn + /cancel + /answer endpoints |
| `server/lib/binary-fixup-proxy.js` | Kimi thinking 修复（拦 /v1/messages POST 改 thinking.type adaptive→enabled）|

### 前端
| 文件 | 用途 |
|---|---|
| `web/src/components/chat/Message.jsx` | AskUserQuestionView wizard（A4.3-A4.5）；ThinkingMessage 1000 字自动收起（A4.6）|
| `web/src/components/chat/MessageList.jsx` | groupMessages 任何 assistant text 都 break（A4.7）|
| `web/src/components/project/ContextUsageBar.jsx` | 实时进度条 + breakdown（A2.2a）|
| `web/src/components/context-panel/TweaksPanel.jsx` | scope-aware applyToIframe / Reset / Apply（A6.2）|
| `web/src/components/canvas/InspectFloatingCard.jsx` | C3 contextual 卡贴选中元素 |
| `web/src/components/canvas/SystemPopover.jsx` | C2 toolbar Settings popover |
| `web/src/lib/api.js` | Turn.answer + PendingChanges API |
| `web/src/stores/globalStore.js` | activeRun: { pid, runId } 让 AskUserQuestionView 不必 prop drilling |
| `web/src/routes/ProjectWorkspace.jsx` | run.context_usage / run.ask_user_question / run.compact_boundary 等事件 handler；setActiveRun lifecycle |

### 文档
- `Canvas.md` —— Canvas v0.6 权威架构文档（510 行，C1-C6 + 之前体系全在这）
- `PLAN.md` —— roadmap + 历史决策
- 历史 HANDOVER：S1-H5 / Phase123 / P2 thinking proxy / stage1 等

---

## 5. 给下段 cold-start 的核心信号

### 5.1 你接手的是什么状态

- ✅ **agent 跑得对**：Kimi thinking 通了 + autoCompact 不爆 + Edit 不累积 + canUseTool 接通让 AskUserQuestion 真能用
- ✅ **agent 看得见**：Timeline group 标题 + thinking shimmer + 工具 icon 实时 + 实时 context usage 进度条 + autoCompact 预警
- ✅ **agent 工具齐**：canvas v0.6 13 MCP + 4 subagents（explorer 真通，其他 skeleton）+ 完整反向通道
- ✅ **agent 写得规范**：HTML 5-style-block 标准 + 6 named layouts + 6 件套 data-* + scoped tweak 全锁定
- ⚪ **paradigm 全接通**：**这是你下一段的事**（详见 § 6）

### 5.2 你下一段优先做什么

按 ROI 排，paradigm 缺口里最值得做的：

**Tier 0 — paradigm 关键 missing piece（高 ROI）**

1. **vision-checker 真接通** —— skeleton 在 `server/engine/agents/vision-checker.md`，缺：
   - 写"挑剔老设计师"prompt（具体 anti-pattern 列：通体渐变 / 玻璃拟态过度 / 通用 emoji icon / 一切等 padding / 不该居中的居中）
   - 主 agent SKILL.md 教何时调（写完关键页 / deck 完成 / 用户问"看着怎么样" → Task 派 vision-checker）
   - 子代理 transcript 在 chat 渲染（用户能看挑剔评审过程，建立信任）
   - Hook 触发：Stop hook 检测 canvas 改过 + 用户没说"差不多了" → 自动派 vision-checker
2. **plan mode 接通** —— SDK `permissionMode: 'plan'`，需要：
   - 先 probe Kimi binary 链路下 plan mode 是否 stuck（之前 follow-up #6 就提了，没真做）
   - 后端：loop.js 加 plan mode 选项，emit `run.plan_proposed` 事件
   - 前端：PlanReview 卡片让用户 review/edit/approve plan 才放行
   - SKILL.md 教 agent："新 deck / 大改" 时先 plan，"小 tweak" 时跳过
3. **多变体并发** —— candidate UI 占位已有（CanvasCandidateBar 在 web 里），缺：
   - 后端：1 个 turn fork 出 2-3 个 sub-runs 各跑各的 generate
   - 前端：candidate 切换 + 同屏并排（不只是切换）+ "选这个继续" / "取消其他"
   - 要谨慎成本（3 倍 token）—— SKILL.md 加触发条件（首跑 / 用户主动要 "给我多看几个"）

**Tier 1 — explore 阶段 starter pack**

4. **图搜 MCP**（Unsplash + Pexels API 包装）—— 当前 explorer 只能拿 URL 列表 / WebFetch 解析页面，hotlinkable 图源不稳。Unsplash API 有 hourly free quota
5. **palette + texture curated MCP** —— `mcp__nodesign__pick_palette({ mood, count })` / `pick_texture({ style, count })` 从 server-bundled JSON 返 N 套精选。**注**：不是当 agent 大脑义肢，是 explore 阶段 local cache（详见 memory `feedback_agent_not_junior.md`）
6. **per-user taste memory** —— agent-memory 累积"该用户接受 / 拒过什么"，3-5 turn 后能预测 taste 省 ask 阶段问题

**Tier 2 — paradigm 内优化**

7. **anti-AI-pattern hook** —— PostToolUse(Edit canvas.html) 扫"通体渐变 / shadow 数 / 通用 emoji" 触发阈值要求 agent 返工
8. **a11y 硬约束 hook** —— 改 canvas.html 后扫对比度 < 4.5 emit warning
9. **list_layouts MCP** —— 当前 6 layouts 在 SKILL.md 列；加进 MCP 后未来加新 layout 不动 SKILL.md

### 5.3 不要做的事（用户已 push back）

- ❌ **字体配对库 / 调色板库 / 布局模板库 / 风格 preset 库 / 反例库**（"喂 agent" 思路）—— K2.6 万亿参数知道这些。详见 memory `feedback_agent_not_junior.md`
- ❌ 拆多文件 HTML / 改 React component / 改 reveal.js framework —— 单文件仍最优。详见 memory `nodesign_canvas_v06_html_standard.md`

---

## 6. 待 verify 的事（cold-start 第一天跑一次新 chat）

### A4 AskUserQuestion 真链路 verify

发 brief："用 AskUserQuestion 问我 2-3 个 deck 的方向问题"
- ✅ 卡片显示 wizard（一次 1 题 + 进度 "1/N"）
- ✅ 点选项**不立即提交**（旧 bug 是立即提交单题），可 [上一题] [跳过] [下一题 →]
- ✅ 末题按 [✓ 提交全部] 后 agent 收到完整 answers map，正常继续（不再 "Answer questions?" 报错）
- ✅ 时间轴左侧有 HelpCircle icon

### A6 HTML 标准 verify

发 brief："做一个 3 页 deck"
- ✅ agent 在 head 输出 4-5 个 `<style id="...">` 块（design-tokens / base / layouts / page-styles + CDN imports）
- ✅ 用 `data-layout="cover|title-content|..."` 选 named layout 不自创 grid
- ✅ 关键元素带 `data-node-id` + `data-purpose` + `data-edit-role`
- ✅ 不主动引中文字体 CDN（除非用户要求"更精致"），用 PingFang SC fallback

### A6.2 expose_tweaks target_scope verify

让 agent 调 `expose_tweaks` 暴露一个带 `target_scope: "section[data-page=\"1\"]"` 的封面字号 slider
- ✅ 拖 slider **只第 1 页变化**，其他页字号不动
- ✅ 前端 console 不报"target_scope not found"
- ✅ 拖完点 Apply → chat 里 agent 收到 `(target_var, target_scope, value) @ scope` 摘要
- ✅ agent 用 Edit 把 `section[data-page="1"] { --hero-size: ... }` 加到 design-tokens style 块
- ✅ 重新调 expose_tweaks 更新 default 反映新值

### A2 实时 context usage verify

跑任意 chat
- ✅ 顶部 ContextUsageBar 显示进度条（< 60% 绿 / 60-85% warn / ≥ 85% error）+ 百分比 + 当前/max k tokens
- ✅ hover 看 breakdown（toolCallsByType top 3 + 类目级聚合）
- ✅ autoCompact 阈值竖线在进度条上有标记
- ✅ usage 接近阈值（≥ 90%）出 toast "⚠ 上下文接近自动压缩阈值，剩 X k tokens"
- ✅ compact 触发后 toast "上下文已自动压缩 187k → 64k tokens"

---

## 7. 已知 follow-up（不阻塞主路径）

旧的 PLAN.md follow-up #1-#13 仍部分有效。本批解决 / 升级了：
- ✅ #1 Kimi thinking blocks（已修，本批前已修）
- ✅ #5/#12 vision-checker → 部分（subagent 注册了 + Task 工具白名单修了，prompt + 调用流程没接）
- ✅ #8 NoDesign agent 接 inspect 能力 → Canvas v0.6 13 MCP 已经覆盖大部分（agent 能 list_pages / query_elements / screenshot 任意）
- ✅ #9 上下文容量实时显示（A2.2 完成）
- ✅ #11 Kimi 反思 3 个痛点 → 11a 先追问已在 SKILL.md / 11b assets 路径修了（A3.1）/ 11c "派 explorer" 已在 SKILL.md A1.1
- 🟡 #2 agent 主动用 agent-memory（未做）
- 🟡 #3 多 user 并发隔离（未做）
- ⚪ #6 plan mode（未做，下段优先）
- ⚪ #7 ds-extractor / tweak-proposer subagent 真接通（subagent 注册了，没接通）
- ⚪ #10 放开 CDN 外部资源引用 → 部分（中文字体 CDN 在 A6.1 加了，整体 CDN 白名单本就放开了）

新增 follow-up：
- ⚪ AskUserQuestion 教学还可加 "intent extraction" 深化段（多变体 preview 当问题 / 何时停问）
- ⚪ list_layouts MCP（如果未来加新 layout 频繁）
- ⚪ Canvas.md § 11 列了几个 issues：e2e 验证 / Playwright pool / InspectTab 重复代码 / Tweaks Apply 重新 expose hard enforcement

---

## 8. memory 状态（更新到本批）

| memory file | 状态 |
|---|---|
| `nodesign_sdk_principle.md` | 不动（核心原则） |
| **`nodesign_paradigm_5stage.md`** | **新** — 5 阶段 paradigm 框架 |
| **`feedback_agent_not_junior.md`** | **新** — 别再喂素材库给 agent |
| **`nodesign_canvas_v06_html_standard.md`** | **新** — Canvas v0.6 + HTML 单文件标准 |
| `feedback_kimi_thinking_blocks.md` | 不动 |
| `feedback_pacing.md` | 不动 |
| `feedback_sandbox_replaces_whitelist.md` | 不动 |
| `nodesign_session_scoped_summary.md` | 不动（S1-H5 历史档案，仍准确）|
| `nodesign_p0plus_stage1_summary.md` | 不动 |
| `p3_full_stack_progress_2026-04-29.md` | 不动（已废弃）|

MEMORY.md 索引已更新，"当前状态"指向本文档。

---

## 9. Plan 文件

`/Users/edy/.claude/plans/ok-plan-partitioned-pillow.md` — A6 batch 的 plan 文档，含本批的 verify 清单 + 不在本批做的延后清单。下段开新 plan 文件不要继续在这个文件追加。
