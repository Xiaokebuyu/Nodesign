# HANDOVER — S0-S8 batch（paradigm 5 阶段全接通 + Kimi vision fix，2026-05-02）

> 接 A4-A6 batch 之后的同日深夜段。**16 commit**，主线两件大事：
>
> 1. **paradigm 5 阶段全接通**（vision-checker 真接通 / plan-mode = design-plan.md 流程 / explorer 加 hotlink 验证 + audio）
> 2. **Kimi vision 真坑修了**（tool_result 嵌套 image 网关不识别，binary-fixup-proxy 加 lift transform）
>
> 副线：撤节流措辞（ask 默认 1-3 轮 + 主动引外部资源）/ subagent 图标分类 / context usage 显眼版 / 2 个 hotfix。

---

## 1. 一句话定位

**paradigm 框架完整接通**：ask 默认激进 → 复杂主题自动 plan-doc 流 → 主 agent 按计划执行 → vision-checker 拿计划当 spec critique。Kimi 在本地 dev 跑 deck 全链路通（含 vision input）。

---

## 2. 16 commit 按主题

### 主题 A：paradigm 5 阶段接通（10 commit）

#### S0-S2 基础 + explorer
| | | |
|---|---|---|
| `8a9d474` | S0 | 撤 CDN 白名单（hooks.js TRUSTED_CDN_HOSTS / events.js cdnWarning factory / SKILL.md 4 处 trusted 措辞）—— 加图片+音频源 cheatsheet |
| `7c3dfe7` | S1 | HTML 标记轻量化：6 件套 data-* → 3 必装（page/anchor/node-id）+ 1 可选（layout 自由命名）；6 named layout cookbook 撤 |
| `393cb17` | S2 | explorer 加 WebFetch HEAD hotlink 验证 + Content-Type 过滤 + 扩 audio/* + 推荐源 cheatsheet（unsplash/pexels/pixabay-audio CC0 等）+ maxTurns 5→8 |

#### S3 vision-checker 真接通
| | | |
|---|---|---|
| `f52bf8e` | S3a | SKILL.md 加 § vision-checker 协议（70 行）：何时派 / 不派 + 3 个 prompt 模板 + critique 处理决策 + ≤2 次/turn-cluster 防 self-criticism loop |
| `41100cd` | S3b | events.js subagentStop 加 toolUseId / 前端 ProjectWorkspace run.subagent.stop 路由到 Task message / Message.jsx 加 VisionCheckerCard 组件（解析 VERDICT/ISSUES/OVERALL，染色 chip + severity 列表 + 解析失败 fallback 显原文）|

#### S4 plan-mode = design-plan.md 流程
| | | |
|---|---|---|
| `066cf95` | S4a | SKILL.md 加 § "深度对齐 + 设计计划档"（80 行）：触发条件 + 4 步流程 + plan-doc 模板（port 0.7.7：core metaphor + 拒掉的默认 + 4-stage chain + per-page 反默认决策三段式 + sealed-test）+ 反模式 |
| `16ba8e0` | S4b-1 | vision-checker.md 加 Tier 0 plan compliance 段（最高优先级 when plan exists）+ Tier 1 sealed-test |
| `f9ec3cd` | S4b-2 | events.js planDocReady factory / hooks.js PostToolUse(Write design-plan.md) handler / canvas.js GET /plan endpoint / api.js DesignPlan client |
| `f77aadb` | S4b-3 | DesignPlanModal 新组件（fetch + react-markdown + esc/遮罩/× 关闭）/ globalStore designPlanOpen action / ProjectWorkspace mount + run.plan_doc_ready 接通 / Message.jsx Write design-plan.md 加"📄 查看设计计划"按钮 |

#### S5 cleanup
| `b2fb16f` | S5 | hooks.js makePostToolUseCanvasObservableHandler → makePostToolUseCanvasFocusPageHandler 重命名 + 去孤编号注释（S0 撤 cdn 后留下的）|

### 主题 B：撤节流措辞（1 commit）

| `114d809` | S6 | prelude "信息不足先问"段重写：默认 1-3 轮 ask + 每轮 2-4 题 + agent 自判停（描清才停）；escape hatch 仅当用户明说"别问/赶时间/单参数指令清晰"才跳。SKILL.md 5 处节流措辞撤掉：CDN 资源段（"节流不是品质借口"）/ 视觉默认风格降级为兜底（不是首选）/ web_search 加分流原则（信息缺口大派 explorer）|

### 主题 C：UI 强化（2 commit + 1 hotfix）

| | | |
|---|---|---|
| `dcf560f` | S7 | Subagent icon 分类（explorer→Compass / vision-checker→ScanEye / ds-extractor→Palette / tweak-proposer→Sliders）；ContextUsageBar 加 fallback "📊 等待 context 数据"；移到 ChatPanel header 下方显眼条带；loop.js getContextUsage 加 ok/fail count 诊断日志 |
| `93cbb46` | S7 hotfix | ChatPanel 漏 ContextUsageBar import 修白屏 |

### 主题 D：Kimi vision 真坑修复（3 commit）

| | | |
|---|---|---|
| `92a4728` | S8.1 | binary-fixup-proxy 加 NODESIGN_DEBUG_VISION=1 诊断日志（统计 image block 位置 + schema sample dump）|
| `b201bfa` | S8.2 | **核心 fix**：liftImagesFromToolResult transform — 把 tool_result.content 里的 image block lift 到 user message 顶层，原位置替换为占位文本。仅对 kimi-* model 生效 |
| `6aea170` | S8 hotfix | AskUserQuestionView useMemo 在 early return 之后 → React rules-of-hooks 违规 → 改 inline 表达式 |

---

## 3. Kimi vision 真坑（值得长期记忆）

**症状**：用户报 SDK Read 图片 Kimi 看不到；但 mcp__nodesign__screenshot_canvas 完美工作。

**诊断链**：
1. binary-fixup-proxy 加 image block scanner → 确认 base64 image 真到了 outgoing body，schema 完全标准
2. 直接 curl Kimi 网关带 user msg 顶层 image → 准确识别 Goblin Slayer 5 主角
3. curl 同 image 嵌 tool_result.content → Kimi thinking 自报"我无法解析图像"凭文件名 hallucinate
4. curl image lift 出 tool_result 到 user msg 顶层 → Kimi 完美识别

**根因**：**Kimi K2.6 / 网关 vision pipeline 不识别 tool_result.content 嵌套里的 image block**，只识别 user message **顶层** image content block。

**修复**（binary-fixup-proxy.js liftImagesFromToolResult）：扫 outgoing /v1/messages，把 user message 里 tool_result.content 的 image block lift 到该 user message 的 content 顶层；原位置替换为占位文本说明。仅对 kimi-* 生效。

**重要**：未来切到别的 model（Claude / OpenAI / 其他网关）时这个 lift 可能反而**破坏正常**（其他 model 可能要求 image 留在 tool_result 内才能 attribute）。当前 lift 仅 `if (/^kimi/i.test(model))` 进入，安全。

---

## 4. paradigm 5 阶段接通度更新

| 阶段 | A6 batch 后状态 | S0-S8 后状态 |
|---|---|---|
| **ask** | ✅ canUseTool + wizard + prelude 教学 | ✅ + 默认 1-3 轮 + agent 自判停 + 撤节流 escape |
| **plan** | ❌ 未接 | ✅ **新通**：design-plan.md 流（agent Write + run.plan_doc_ready + 前端 modal） |
| **explore** | 🟡 explorer subagent + web_search | ✅ + hotlink 验证 + audio mime + 推荐源 cheatsheet + 撤节流（默认积极引外部）|
| **generate** | ✅ Canvas v0.6 完整 13 MCP + HTML 标准 | ✅ + HTML 标记轻量化（layout 自由命名）/ Kimi vision 通 |
| **vision-check** | 🟡 prompt ready，未接通 | ✅ **新通**：SKILL.md 教 + 前端 critique 卡 + Tier 0 plan compliance |

---

## 5. 关键文件 cheatsheet（新加 / 大改）

### 后端
- [server/lib/binary-fixup-proxy.js](server/lib/binary-fixup-proxy.js) — **lift image transform** + vision 诊断日志（关键 fix）
- [server/engine/agent/events.js](server/engine/agent/events.js) — subagentStop +toolUseId / 加 planDocReady / 删 cdnWarning
- [server/engine/agent/hooks.js](server/engine/agent/hooks.js) — 删 cdn_warning / 加 PostToolUse(Write design-plan.md) handler / 重命名 focus_page handler
- [server/engine/agent/loop.js](server/engine/agent/loop.js) — getContextUsage ok/fail count 诊断
- [server/engine/agents/explorer.md](server/engine/agents/explorer.md) — hotlink 验证 + audio 支持 + 推荐源
- [server/engine/agents/vision-checker.md](server/engine/agents/vision-checker.md) — Tier 0 plan compliance + sealed-test
- [server/engine/skills/deskskill-engine-mini/SKILL.md](server/engine/skills/deskskill-engine-mini/SKILL.md) — 主战场（深度对齐 / vision-checker 协议 / design-plan 流程 / 撤节流 / HTML 标记轻量化）
- [server/engine/agent/prompts/nodesign-prelude.md](server/engine/agent/prompts/nodesign-prelude.md) — ask 默认激进
- [server/api/canvas.js](server/api/canvas.js) — 加 GET /plan endpoint

### 前端
- [web/src/components/project/DesignPlanModal.jsx](web/src/components/project/DesignPlanModal.jsx) — **新组件**（react-markdown + esc/遮罩关闭 + ENOENT 友好降级）
- [web/src/stores/globalStore.js](web/src/stores/globalStore.js) — designPlanOpen action
- [web/src/components/chat/ChatPanel.jsx](web/src/components/chat/ChatPanel.jsx) — header 下方 context usage strip
- [web/src/components/chat/Message.jsx](web/src/components/chat/Message.jsx) — VisionCheckerCard / subagent icon 分类 / design-plan.md 按钮 / hooks 顺序 hotfix
- [web/src/components/project/ContextUsageBar.jsx](web/src/components/project/ContextUsageBar.jsx) — variant='full' + null fallback "📊 等待数据"
- [web/src/routes/ProjectWorkspace.jsx](web/src/routes/ProjectWorkspace.jsx) — run.subagent.stop / run.plan_doc_ready handler + DesignPlanModal mount
- [web/src/lib/api.js](web/src/lib/api.js) — DesignPlan.read

### .env
- 加 `NODESIGN_TAVILY_KEY` + `NODESIGN_EXA_KEY`（dev key，不 commit；baidu 已有）
- 加 `NODESIGN_DEBUG_VISION=1`（诊断用，prod 关掉）

---

## 6. 给下段 cold-start 的核心信号

### 6.1 你接手的状态

- ✅ **Paradigm 5 阶段全接通**：ask → plan → explore → generate → vision-check 闭环可跑
- ✅ **Kimi vision 通**（lift transform 修复 tool_result 嵌套 image bug）
- ✅ **agent 协作 UI 完整**：subagent icon 分类 / context usage 显眼版 / critique 卡 / plan-doc modal
- ✅ **agent 默认主动**（撤节流措辞，1-3 轮 ask + 默认引外部资源）

### 6.2 待 verify（cold-start 第一天）

1. **复杂主题 deck 全流跑通**：`brief="做一份中医文化主题 deck"` → 触发 2-4 轮 ask → Write design-plan.md → modal 弹 → 主 agent 按计划写 → vision-checker 拿计划 critique
2. **音频引用真链路**：`brief="找一段适合雨天阅读 deck 的背景音"` → explorer 派工 → hotlink 验过 audio/* → agent Edit 加 `<audio>` → preview 能播
3. **Kimi vision 跨场景**：用户上传不同图片格式（png/webp/svg）测 lift transform 兼容性

### 6.3 不要做的事（用户已 push back）

- ❌ 简单 brief 就跳 ask（撤节流后默认仍要问 1 题对齐方向）
- ❌ "节流是设计师的纪律" 这类措辞（已撤）
- ❌ 把 lift transform 推广到非 kimi-* model（其他 model 可能依赖 tool_result image attribution）
- ❌ 重启 server 用 `pkill` pattern 杀（共享机风险），用 `kill <PID>` 精准

---

## 7. 已知 follow-up（不阻塞主路径）

- 🟡 **base64 image token 消耗大** — anthropic API 的 ImageBlockParam 仅支持 base64 / url；NoDesign 本地 dev 没公网 url，用 base64 inline。改进方向：A) screenshot resize+jpeg quality 80 砍体积 60-80% / B) 加 cache_control: ephemeral 让 image 走 prompt cache / C) 上 prod 时建公网图床切 URL form
- 🟡 **mock fixture 旧 layout 名** [web/src/mock/deck.html](web/src/mock/deck.html) 仍用 `data-layout="cover" / "title-content"`，自包含 fixture 不影响功能；下次顺手更新
- 🟡 **上段并行 12 文件 unstaged** — UpgradeQuickModal / RecentQuickSection / DesignSystem* 等不是我的工作，留给原作者
- 🟡 **Canvas.md 仍 untracked**（A6 batch 遗留），未 commit
- ⚪ **autoCompact 阈值预警 toast** — 之前实施过但本次没触发实测验证，需要长 chat 跑到 ≥90% 看真效果
- ⚪ **lift transform vs cache_control** — 现在 image 每次都被 lift（结构变化）= prompt cache key 变化 = cache miss。如果同 image 重复使用，cache 友好性需要再设计

---

## 8. memory 状态（更新到本批）

| memory file | 状态 |
|---|---|
| `nodesign_sdk_principle.md` | 不动（核心原则） |
| `nodesign_paradigm_5stage.md` | **更新** — 接通度（plan / vision-check / explore audio 全 ✅）|
| `nodesign_canvas_v06_html_standard.md` | **更新** — 6 件套 → 3 必装 + 1 可选；6 named layout 撤 → 自由命名 |
| `feedback_agent_not_junior.md` | 不动 |
| **`feedback_ask_proactive_default.md`** | **新** — 撤节流，ask 默认 1-3 轮 + 主动引外部资源 |
| **`feedback_kimi_image_in_toolresult.md`** | **新** — Kimi vision pipeline 不识别 tool_result 嵌套 image，binary-fixup-proxy lift 修复（仅 kimi-*） |
| 其他历史 memory | 不动 |

MEMORY.md 索引同步更新，"当前状态" 指针指向本文档。
