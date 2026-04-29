# Plan: Nodesign MVP

> **这份 plan 是 living document**——跟代码一起 commit，每完成一个 phase 更新状态 + 实施日志。
> 起点：`~/.claude/plans/plan-parallel-harbor.md`（2026-04-29 plan mode 通过）；2026-04-29 迁入 repo。

## 完成度速查

| Phase | 状态 | 完成日期 | Commit | 工作量（实际）|
|---|---|---|---|---|
| **P1 前端骨架** | ✅ 完成 | 2026-04-29 | `c7ddf23` | 半天 |
| **P2 前端交互层 + 产品壳** | ✅ 完成（A+B+C 全做） | 2026-04-29 | `abf20f9` | 半天 |
| **P2.5 Claude Design 补刀（7 项）** | ✅ 完成 | 2026-04-29 | `6479177` | 半天 |
| **P3 后端最小集** | 🟡 进行中（agent 模块 + e2e ✅，REST/WS 待做）| 2026-04-29 部分 | `4381663` + e2e | 估剩 2-3 天 |
| **P4 真 agent 接入** | ⚪ 待启动 | — | — | 估 1-2 周 |
| **P5 inline comment + slider 真接** | ⚪ 待启动 | — | — | 估 1 周 |
| **P6 参照模式 + 多 skill** | ⚪ 部分占位 | UI 占位已完成 | `abf20f9` | 估 2 周 |
| **P7 导出** | ⚪ 部分占位 | HTML 已通，PDF/PPTX 占位 | `abf20f9` | 估 1 周 |
| **v2 CAD 拖动** | ⚪ 远期 | — | — | 待估 |

**整体进度（按阶段权重粗估）**：~30%（前端壳 100% + 后端骨架 30% + 业务 0%）。
前端"产品形态"已经 95%+ 完整（用户能看到 + 操作的部分齐全），剩下是把交互真正接通到后端。

## 修订历史

| 日期 | 改动 | 原因 |
|---|---|---|
| 2026-04-29 | 初版（plan mode 通过） | 把产品形态从想法落成可执行的 MVP phase 切割 |
| 2026-04-29 | 增 §7 §8 Design Principles：参照系统 + Inspector 双视图 | 用户在 P1 验证时给出的两个产品差异化方向 |
| 2026-04-29 | §4.1 Floating Card：从"layout 钉死"调整为"待真实参考激活" | 整体 layout floating card 实验撤回，仅保留 popover/modal/Tweaks 浮窗用 |
| 2026-04-29 | P2 范围扩展为 A+B+C（含产品壳全套）| 用户全要 |
| 2026-04-29 | 迁入 Nodesign repo（PLAN.md），改成 living doc | 跟代码一起 versioned |
| 2026-04-29 | P2.5：对照 Claude_design.md 1591 行做 gap 审计，补 7 项核心交互 | 进 P3 前端形态对齐 Claude Design 完整度 |
| 2026-04-29 | P3 战略转向：弃自写 agent-loop，包 Claude Agent SDK 的 query() | 用户提供 tokendance gateway，确认 Kimi 在 Claude Code/SDK 全功能可用，借力 SDK 23 工具 + 30 hooks + sub-agents + plan mode + budget control + checkpoint，省下 1 周自写工作量 |

## 实施日志

### P1（2026-04-29，commit `c7ddf23`）
- 14/14 验证项过；除 `useIframeBridge.js` 没单独建（功能集成到 Project lift state + DirectEditBridge），其余文件清单 100% 落地
- 顺手做：ChatComposer 双层（参考用户给的 Claude Design 截图）
- 视觉实验插曲：尝试整体 floating card 三栏，用户撤回，回到平铺贴边 + 1px border

### P2（2026-04-29，commit `abf20f9`）
**A 级核心闭环**：Project CRUD（zustand persist localStorage）+ CreateProjectModal + 顶栏 ⋯ 菜单 + ShareModal + ExportMenu（HTML 真下载）+ ToastContainer + Inputs FileReader 缩略图 + Code mode Monaco 可编辑（debounce → srcDoc reload）
**B 级 Inspect 三动作**：DirectEditModal（颜色/字号/字重/对齐/行高/字距）+ chatDraft 跨组件注入（触发新 run）+ patches state（text-edit/attr）+ CommentsTab（按页分组+jump+resolve）+ EditOverlay 实时跟随 fix
**C 级次要页面**：DS list/new/detail mock + Skill list mock
**技术教训**：iframe display:flex column 链路 + EditOverlay 不能用 stale anchor.bbox + 跨组件文本注入用 store 比 forwardRef 简单 + Monaco 改源 → iframe reload 用 800ms debounce

### P2.5（2026-04-29，本次）
对照 `Claude_design.md` 完整功能原子表（44 条）做 gap 审计，补齐 7 项前端核心交互：

1. **Slide Navigator**：扫描 `iframe.contentDocument.querySelectorAll('section[data-page]')` → 顶部水平 thumbnail 条 + IntersectionObserver 跟踪当前页 + 点击 scrollIntoView。响应 Claude_design §14.2"On slide 3..."用法。
2. **A11y Review Popover**：CanvasToolbar `✓ A11y` 按钮 → floating popover 跑 6 个启发式扫描（img alt / 标题层级 / button 文本 / lang / 对比度 mock / 焦点顺序 mock）。Claude_design §10.1。
3. **Multi-candidate Compare**：`CanvasCandidateBar` 候选切换条 + projectStore.addCandidate/removeCandidate/renameCandidate/selectCandidate。Claude_design §11 / §12.2。
4. **Snapshot 机制**：projectStore.saveSnapshot/deleteSnapshot/renameSnapshot + ⋯ 菜单"保存快照" + "快照与历史"入口 + SnapshotModal 列表 UI。Claude_design §11。
5. **Engineering Handoff Bundle**：ExportMenu 加"工程交付包"项（HTML + chat history + spec + README + prompt），P7 mock toast。Claude_design §16.3。
6. **GitHub Repo Connection**：InputsTab 拆出独立"连接代码库"按钮（github icon）+ 原有"网页 URL"按钮。Claude_design §13。
7. **Structured Prompt Fields**：CreateProjectModal 加"更详细"折叠区，4 字段（goal / audience / keyMessages / stylePref）展开后填写 → 提交时拼进 brief。Claude_design §4 第 8 条。

**遗留待修**（P3 进行中或之后再来）：
- #7 CreateProjectModal 更详细字段提交后 brief 拼装效果待打磨（用户报告：UX 还不顺）
- #6 GitHub 连接按钮的实际 ingest 行为待真接（P6 时连 git → 子目录 picker；当前只是 prompt 加 type='repo' 条目）

**关键文件**：
- 新建：`web/src/components/canvas/SlideNavigator.jsx`、`CanvasCandidateBar.jsx`、`A11yReviewPopover.jsx`、`web/src/components/project/SnapshotModal.jsx`
- 改造：`CanvasFrame.jsx`（toolbar 上挂 candidate bar + slide nav + a11y）、`CanvasToolbar.jsx`（加 A11y 按钮）、`projectStore.js`（snapshots/candidates + version 1→2 migrate）、`Project.jsx`（wire 全部 handler）、`InputsTab.jsx`（连接代码库独立按钮）、`CreateProjectModal.jsx`（更详细字段）、`ExportMenu.jsx`（加 handoff 项）、`ProjectActionsMenu.jsx`（加快照入口）、`mock/projects.js`（每条加 snapshots/candidates）

### P3 第一阶段（agent 模块，2026-04-29，进行中）

**战略转向**：弃自写 agent-loop，包 Claude Agent SDK 的 `query()`。
- SDK 实际是 Claude Code 子进程的程序化包装（spawn native `claude` binary）
- 通过 `ANTHROPIC_BASE_URL` env 透传给子进程，路由到 tokendance gateway → Kimi
- 借力：23 工具 / 30 hooks / sub-agents / plan mode / file checkpointing / budget control / output_format json_schema / sessions / effort levels / adaptive thinking

**已完成**：
- 装 `@anthropic-ai/claude-agent-sdk` (devDep, ~80MB native binary 各平台 fat bundle)
- 删废文件：`shared/agent-loop.js` / `shared/anthropic-client.js` / `engine/agent/tool-registry.js` / `engine/agent/tools/read-file.js`
- `engine/agent/context.js`：AgentContext（runId / EventBus / abort / counters）+ 适配 SDK message 流
- `engine/agent/events.js`：EventBus（pattern 订阅）+ Events 构造器
- `engine/agent/loop.js`：包 SDK query() 的 orchestrator（cwd 沙盒 / env 路由 gateway / 工具白名单 / SDK message → Nodesign EventBus 翻译层 / 状态机切换 / metadata 落库）
- `engine/agent/skill.js`：SKILL.md loader（YAML frontmatter + body → systemPrompt）
- `engine/skills/hello-world/SKILL.md`：P3 链路验证 skill
- `engine/agent/_smoke.js`：4 类测试全过（EventBus / AgentContext / parseFrontmatter / loadSkill），live LLM 等 key

**Live E2E 验证 ✅**（2026-04-29，跟 commit `4381663` 同日）：
- 实际 gateway URL：`https://tokendance.space/gateway`（不带 `/anthropic` 段，最终发到 `/v1/messages`）
- run_mojy3ii6_lkmn：8 turns / 7 工具调用 / cache read 43k tokens / 花费 $0.103
- agent 真生成一份 5 页 DeskSkill 风格 deck.html（cover/text/cards 三种 layout，亮黑 + 深棕 配色对齐）
- 全套事件流推 EventBus：run.start / sdk.session / 7×tool_use / 7×tool_result / text / done
- SQLite 状态机正确流转 + metadata 落库（cost/turns/cacheRead/toolCalls）

**P3 后续**（按依赖顺序）：
- `server/index.js`：Express 启动入口（4001 端口，CORS，/api 路由）
- `server/api/projects.js`：REST CRUD
- `server/api/runs.js`：POST 创建 run（背景调 runAgent）
- `server/api/assets.js`：multipart 上传
- `server/ws/`：WebSocket（每 project 一连接，订阅 EventBus）
- 前端 `useProjectStore` 切真后端

### P4-P7 / v2
（待启动；每完成一阶段补一段日志）

## Context

Nodesign 是个新产品线（跟 dev/ team dashboard 平级），定位为**云端 SaaS skill engine**——用户输入 brief / 上传参考素材 → 自动生成可分享的 HTML 演示稿；产物可在浏览器里元素级编辑。

**这次 plan 解决的问题**：把产品形态从"想法 + 散落的设计文档"落成可执行的前端骨架 + 架构选择。负责人明确"先搞前端固定思路"——前端是产品契约，前端定型后端 API 自然推导出来。

**触发的关键架构调整**（基于本轮对话）：

1. **不绑定 deskskill-engine v0.7.5 的产出格式**。v0.7.5 已经是 4-Round 编译范式，但效果不达标 + 颗粒度太粗。Nodesign 不复用 R3 的 Python 装配 / 不复用 G1-G11，从产品工作台层面探索新流程，**反向优化 skill 内容**。
2. **page-spec 是生成阶段的 commitment device + 项目上下文记忆**，不是前端 canvas 的渲染源。agent 看 spec、用 spec 保持设计一致性、可改 spec；用户**不直接编辑 spec**。
3. **HTML 是真正的产物 + 用户交互的修改对象**。inline comment / direct edit / slider / 未来 CAD 拖动都直接改 HTML 代码；全局意图变化（"重新规划"）才触发新 run（agent 可能改 spec + 重生成 HTML）。
4. **前端先行**。后端 mock 配合，等前端形态稳定后反推后端 API。

## Design Principles（必须长期遵守 — 也写入 memory）

1. **不污染原则**：v0.7.5 是参考不是约束。Nodesign 的 spec / HTML 生成 / 渲染 / 验证 全部独立设计，不让旧 skill 的实现细节污染产品架构。
2. **探索 → 反向优化**：Nodesign 是工作台，目的是探索更好的 deck 生成流程。skill 是被探索的对象，不是天花板。Nodesign 反过来给 skill 提需求。
3. **spec 与 HTML 角色分离**：
   - **spec**：agent 生成阶段的 commitment device + 跨 run 的设计意图记忆 + 项目上下文。结构化 JSON，存项目数据库，给 LLM / 设计历史 / 多 skill 协作看。
   - **HTML**：用户面前的产物，所有局部交互（comment / edit / slider / CAD）的修改对象。自包含单文件（参考 v0.7.5 deck.html 形态：内嵌 CSS/JS、`<section data-page>` 分页）。
   - **修改流向**：spec → HTML 是生成；HTML → spec **不回流**（局部 HTML 修改不动 spec）；用户要改 spec 必须通过 chat 触发新 run。
4. **视觉沿用 DeskSkill 风格**（dev/ 设计速查表权威）：亮黑主按钮 #2d2418 / 深棕标题 #3a2a18 / F9F8F6 页面底 / layered shadows / Container Transform 入退场 / cubic-bezier(0.25, 1, 0.5, 1) / inline style + theme.js token。

   **4.1 Floating Card（待真实参考激活，不要硬上）**：
   - **范围**：仅适用于 popover / modal / Tweaks 浮窗 / inline comment 气泡 / inspect popover —— **不适用于整体三栏 layout**（实验过 → 撤回，因为 chat/context 浮起 + canvas 浮起会产生"视觉重量过载 / 间距纠结"，不如平铺贴边干净）
   - **状态**：当前 ThreeColumnLayout 走"平铺贴边 + 1px border 分隔"路线（最初 P1 设计），跟 dev/ 一致
   - **激活条件**：等用户给出明确的"这个东西要 floating card"参考实例（Claude Design 的 Tweaks 浮窗、Plasmic 的 Property panel 等），再针对那个具体 case 做
   - **不再钉死的具体值**：之前 radius 8 / PAD 8 / 4 层 shadow 等数值是一次实验，不再约束未来——下次激活时按真实参考重新调
   - 教训：视觉实验在没有明确产品参考时容易反复，不要预先把"layout 范式"钉死
5. **能复用 dev/src 就复用**：12+ UI 组件可直接搬，不重写。
6. **HANDOVER §11 禁忌清单本轮 review 结果**：
   - ✅ 仍 sticky："不要把 postprocess.py 搬过来"、"不要在 deskskill-engine 上加新机制"、"不要急着 monorepo"
   - 🟡 调整：原本"G1-G11 改 JS 工具"暂搁置（MVP 不做验证），未来根据探索新流程的发现再决定要不要做、做哪些
   - ⚪ 不冲突："不要 4 轮 orchestrator" 仍合理（v0.7.5 的 4 轮是 skill 内部，Nodesign 外层不做 orchestrator）

7. **参照系统 = 工作流产品化**（用户认定核心要素，不是 nice-to-have）：design system extraction 不只是"上传 PPT 抽颜色字体 token"。完整工作流：用户给现有作品（PPT / PDF / HTML / 网站 / 代码库 / 已有 deck）→ Nodesign 扫风格/组件/布局/节奏完整描述 → 设计师 review/调整 → 应用到新项目（含"惯用法"不只是 token）。P6 实施按这个深度，不能简化。

8. **Inspector 级元素选择 +「人话/AI 双视图」**（用户认定核心要素）：canvas 不是"comment 黑盒"。点元素后弹 dev-tool 级审查面板，但分两套表达：
   - **人话视图**（给设计师）：元素用途（"第 2 页左列标题"）+ 当前样式（"32px SF Mono 深棕"）+ 可调维度（颜色/字号/字体/字重/行高/对齐/换行...）+ 改动 ripple 范围（"仅这处" / "所有同类" / "改 spec 重生成"）
   - **AI 上下文视图**（给 LLM 工具调用）：path / outerHTML / computed styles / spec field 引用 / siblings 位置 / data-node-id —— 不需要翻译，机器精确即可
   - 翻译层是产品差异化关键。元素语义识别（"标题"/"按钮"/"图表柱"）建词典 + 联动 page-spec 的 layout 字段。
   - 落实位置：P2 inline comment UI 直接做 inspect 雏形（不是简单评论气泡）；P5 真接 simple-LLM 时双视图分别用作 UI 渲染 vs LLM input。

## Architecture Decision

### 统一 iframe canvas（HTML 中心）

| Canvas 模式 | 用途 | 实现 |
|---|---|---|
| **Edit** (默认) | inline comment / direct edit / slider live preview / 未来 CAD 拖动 | iframe 加载 HTML + 顶层 overlay（评论锚点 / 选中框） + postMessage 桥接（进 iframe 装 contenteditable / 监听点击 / DOM 操作） |
| **Preview** | 看最终效果，无交互 | 同 iframe，关闭 overlay 和 postMessage 编辑钩子 |
| **Code** | 高级用户直接改 HTML 源码 | Monaco editor，blur 落库 |

**理由**：
- HTML 是产物，自包含单文件，跟 v0.7.5 的 deck.html 形态一致 → iframe 加载零改造
- Claude Design 报告 §6.2 明说他们的 canvas 就是"interactive HTML rendered in canvas"
- 不做 React spec renderer 省一大块前端工程量
- iframe + postMessage 是业界 visual builder 标准（Stackblitz / CodePen / Plasmic 都这样）
- 安全边界天然有（sandbox 属性 + postMessage origin 校验）

### 双向流：WebSocket

负责人选 #3 双向流。每个 project 一个 WS session（带 reconnect）。事件类型：
- `run.start` / `run.delta.{text|thinking|tool}` / `run.done` / `run.error`
- `spec.updated`（agent 改了 spec，前端可以选择展示给用户）
- `html.updated`（agent 重生成了 HTML，前端 iframe 重载）
- `comment.applied`（局部 patch 完成）
- `tweak.schema`（agent 暴露可调参数，前端渲染 slider）

### page-spec Schema v0.1（commitment device，不是渲染源）

> 这份 schema **存在数据库 + 给 LLM 用 + 给项目历史看**，前端不直接渲染它。前端只在 SystemTab / RunDetail 页展示 spec 的人类可读摘要（"这个 deck 的 metaphor 是 X，palette 是 Y..."）

```typescript
interface DeckSpec {
  version: '0.1';
  meta: {
    title: string;
    skill?: string;
    designSystemId?: string;
    metaphor?: string;        // 核心隐喻（参考 v0.7.5 的 PEER round 产出）
    audience?: string;
    intent?: string;          // 200-400 字设计意图（参考 v0.7.5 的 design-intent.md）
  };
  designTokens: {
    colors: Record<string, string>;
    typography: { display, body };
    spacing: number[];
    radius: Record<string, number>;
    shadow: Record<string, string>;
  };
  outline: PageOutline[];     // 每页结构化 outline（不含具体 HTML）
}

interface PageOutline {
  id: string;                 // 'page-01' / 'cover' / 'thank-you'
  index: number;
  layout: 'cover' | 'title-content' | 'two-column' | 'hero-image' | 'chart' | 'quote' | 'custom';
  intent: string;             // 100-200 字这页要表达什么（commitment device）
  keyPoints: string[];        // 关键点列表
  motionHint?: string;        // 入场/过渡的语义（"fade slow" / "slide-from-left"）
  notes?: string;             // 演讲者备注
}
```

**MVP 字段范围**：先做 cover / title-content / two-column / chart 4 种 layout 的 outline 字段。spec 进一步细化随探索迭代。

### 项目数据流

```
brief + 上传素材 + previousSpec?
    ↓
agent loop（思考 → 产出/更新 spec）
    ↓
spec 存项目（version N）
    ↓
agent 继续（基于 spec 生成 HTML）
    ↓
HTML 存项目（version N，关联 specVersion N）
    ↓
canvas iframe 加载 HTML

用户局部修改 HTML：
    ├─ direct edit  → 前端 contenteditable → blur 落 HTML（不动 spec）
    ├─ comment apply → 后端 simple-LLM 收 element + 指令 → 返 patched HTML
    ├─ slider apply  → 改 CSS var 落 HTML（不动 spec）
    └─ (v2) CAD     → DOM 操作落 HTML（不动 spec）

用户全局意图变化：
    └─ chat "整体重新规划/改设计风格" → 新 run（agent 可能改 spec + 重生成 HTML）
```

## 前端设计

### 技术栈

- React 19 + Vite 6（与 dev/ 一致）
- React Router v7（data router 模式）
- WebSocket 客户端：原生 WebSocket（不上 socket.io）
- 状态：useReducer + Context（项目作用域）+ Zustand（全局 toast/modal）
- Markdown 渲染：react-markdown（chat 消息）
- 图标：lucide-react
- Monaco Editor（Code mode）
- 拖拽（v2 CAD）：dnd-kit（不入 P1）
- 图表：recharts（用在数据可视化的 mock，不在 spec renderer 里）

### 路由层级

```
/                              Home（项目网格 + 入口卡片 + 最近设计系统）
/projects/new                  创建项目（modal，从 / 触发）
/projects/:id                  项目工作台 ★ 三栏核心
/projects/:id/runs/:rid        单 run 详情（思考流 + 工具日志 + spec 历史，v2 详细化）
/design-systems                设计系统列表
/design-systems/new            抽取向导（上传 → 流式抽取 → review → 发布）
/design-systems/:id            设计系统详情（tokens / components / patterns / Remix）
/skills                        skill 注册表
/skills/:id                    单 skill 详情（v2）
/settings                      模型/默认 skill/导出偏好（v2）
```

**P1 必做页**：`/`、`/projects/:id`、`/projects/new`（modal 形式）  
**P2 之后**：其余路由

### 项目工作台 `/projects/:id` 三栏布局（核心）

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ AppShell 顶栏 (h: 56px, 亮黑系)                                              │
│  [≡] [Logo Nodesign] / [Project Crumb]   ●运行中    [Share] [Export ▾] [⋯]   │
├──────────────┬───────────────────────────────────┬──────────────────────────┤
│  Chat Panel  │           Canvas (iframe)         │  Context Panel           │
│  (~360px)    │           (auto)                  │  (~340px)                │
│              │                                   │                          │
│  ┌─message ──│  ┌─Toolbar─────────────────────┐ │  ┌─TabBar──────────────┐ │
│  │ assistant │  │  Edit | Preview | Code       │ │  │Inputs|Cmts|Twk|Sys │ │
│  │ thinking ▼│  │  - + zoom 100%  [⟳ Reload]   │ │  └─────────────────────┘ │
│  │ tool ✓    │  └─────────────────────────────┘ │                          │
│  │ user      │                                   │  · 截图1.png         🗑  │
│  │ ...       │  ┌──────────────────────────────┐│  · brief.pdf         🗑  │
│  └───────────│  │                              ││  · github/react-ui   🗑  │
│              │  │  iframe                       │  · web: stripe.com   🗑  │
│  StreamIndic │  │  src="/api/.../deck.html"    ││                          │
│  ────────────│  │  + overlay (Edit only):      ││  [+ 添加上下文]          │
│              │  │    - comment markers          ││                          │
│  ┌─Composer──│  │    - selection box            ││  ─────────────           │
│  │ ✏ ...     │  │    - direct-edit handles      ││  Skill: deskskill-eng    │
│  │ @ref ⨯ ⨯ │  │  + postMessage bridge:        ││  DS: ACME 品牌系统 v3    │
│  │     [Send]│  │    - inject contenteditable   ││  Model: kimi-k2.6        │
│  └───────────│  │    - listen to clicks         ││  Spec metaphor: ...      │
│              │  │    - apply CSS var changes    ││  (展开 spec 摘要)         │
│              │  └──────────────────────────────┘│                          │
└──────────────┴───────────────────────────────────┴──────────────────────────┘
```

**Canvas 三模式细节**：
- **Edit**：iframe `sandbox="allow-scripts allow-same-origin"` + 顶层 absolute-positioned overlay div + 通过 `iframe.contentWindow.postMessage` 注入编辑助手脚本（contenteditable 双击、点击元素 anchor、CSS var 实时更新）。
- **Preview**：同 iframe，但不注入脚本、关闭 overlay。
- **Code**：Monaco 显示 HTML 源码，可改可保存（保存后 iframe 重载）。

**右栏 Context Panel 4 tab**：
- **Inputs**：上传/链接资料（drop zone + URL paste），支持 截图/PDF/PPTX/DOCX/HTML/repo URL/网页
- **Comments**：评论列表（按元素分组，点击切到画布定位 + 弹气泡）
- **Tweaks**：agent 暴露的 slider/colorpicker/segmented control
- **System**：当前 skill / DS / model 显示 + spec 摘要（展开看 metaphor / intent / outline）+ 切换入口

### 9 个核心交互流

| # | 流名 | 触发改 spec | 触发改 HTML | 触发新 run |
|---|---|---|---|---|
| **A** 自由创作首跑 | brief → spec → HTML | ✓ | ✓（生成）| ✓ |
| **B** 引用上下文跑 | A 但带 refs | ✓ | ✓（生成）| ✓ |
| **C** chat 全局重规划 | "重新设计 / 整体改风格" → 可能改 spec → 重生成 HTML | 可能 | ✓ | ✓ |
| **D** inline comment | 点元素 + 写指令 → simple-LLM 改这个元素的 HTML | ✗ | ✓ patch | 轻 run（不走 skill loop）|
| **E** direct edit | 双击文字 → contenteditable → blur | ✗ | ✓ patch | ✗ |
| **F** custom slider | agent 暴露 tweaks → 拖动 → CSS var 实时 → "应用" | ✗ | ✓ patch | ✗ |
| **G** 多方向探索 | "给我 2-3 个 layout" → 多 candidate | ✓ multiple | ✓ multiple | ✓（mode='variations'）|
| **H** 参照 DS 抽取 | 上传 → 流式抽取 → review → 发布 → 项目用 | DS 影响 spec.designTokens | 无 | DS 抽取 task |
| **I** 导出 | HTML 直接打包 / playwright print PDF / HTML→PPTX | ✗ | ✗ | ✗ |

**P1 MVP**：A 流的前端壳（chat panel UI + iframe 加载 mock HTML）+ E（direct edit）  
**P2 MVP**：B、D（comment UI 但不接 simple-LLM）  
**P3 MVP**：A 后端串起来（mock skill 返回固定 spec + HTML）  
**P4 MVP**：A 真 agent + skill loader  
**P5 MVP**：D 接 simple-LLM、F（slider）  
**P6 MVP**：G、H  
**P7 MVP**：I  
**v2**：CAD 拖动

### 数据实体

```
Project        # 项目（含当前活跃的 specId / htmlArtifactId）
Run            # 一次 agent 跑（pending/running/succeeded/failed/cancelled）
DeckSpec       # 项目的设计意图记录（多版本，可回溯）
HtmlArtifact   # HTML 产物（多版本，关联 specVersion 但可独立 patch）
Patch          # HTML 局部修改记录（direct edit / comment apply / slider apply）
Asset          # 上传/链接的资料
Comment        # HTML 元素锚点 + 文本 + apply 状态
Tweak          # agent 暴露的可调参数（带 schema）
DesignSystem   # 设计系统
Skill          # 已安装 skill
Snapshot       # 用户主动 checkpoint
```

### 组件树（前端）

```
src/
├── App.jsx                       # 路由根
├── main.jsx                      # ReactDOM 入口
├── routes/
│   ├── Home.jsx                  # /
│   ├── Project.jsx               # /projects/:id  ← 三栏 layout
│   ├── DesignSystemList.jsx      # /design-systems (P1 占位)
│   ├── DesignSystemNew.jsx       # /design-systems/new (P6)
│   ├── DesignSystemDetail.jsx    # /design-systems/:id (P6)
│   └── SkillList.jsx             # /skills (P1 占位)
│
├── components/
│   ├── layout/
│   │   ├── AppShell.jsx
│   │   ├── ThreeColumnLayout.jsx # resize handle 可选
│   │   └── TopBar.jsx
│   ├── chat/
│   │   ├── ChatPanel.jsx
│   │   ├── MessageList.jsx
│   │   ├── Message.jsx           # user/assistant/thinking/tool
│   │   ├── ChatComposer.jsx
│   │   └── StreamingIndicator.jsx
│   ├── canvas/                   # ★ 核心：iframe + overlay + bridge
│   │   ├── CanvasFrame.jsx       # 三模式切换容器
│   │   ├── CanvasToolbar.jsx
│   │   ├── HtmlIframe.jsx        # iframe 加载 HTML，含 sandbox/onLoad/postMessage 设置
│   │   ├── EditOverlay.jsx       # 选中框、评论锚点 markers
│   │   ├── CommentMarker.jsx
│   │   ├── DirectEditBridge.js   # 注入 iframe 的脚本（contenteditable + 监听）
│   │   └── CodeCanvas.jsx        # Monaco 编辑 HTML 源
│   ├── context-panel/
│   │   ├── ContextPanel.jsx
│   │   ├── InputsTab.jsx
│   │   ├── CommentsTab.jsx
│   │   ├── TweaksTab.jsx
│   │   ├── SystemTab.jsx         # spec 摘要 + skill/DS/model 显示
│   │   └── DropZone.jsx
│   ├── design-system/            # P6
│   │   ├── TokenPanel.jsx
│   │   ├── ComponentInventory.jsx
│   │   └── ExtractWizard.jsx
│   ├── ui/                       # ★ 12 个从 dev/src 直接 copy
│   │   ├── DataCard.jsx
│   │   ├── DetailModal.jsx
│   │   ├── FullPanel.jsx
│   │   ├── Accordion.jsx
│   │   ├── ChartCarousel.jsx
│   │   ├── ToggleSwitch.jsx
│   │   ├── Form.jsx
│   │   ├── BrowsePage.jsx
│   │   ├── MiniBar.jsx
│   │   ├── StarRate.jsx
│   │   ├── Stat.jsx
│   │   └── BaseCard.jsx
│   └── export/
│       └── ExportMenu.jsx        # P7
│
├── hooks/
│   ├── useProject.js
│   ├── useEngineRun.js           # WS 连接 + 状态机
│   ├── useHtmlArtifact.js        # 当前 HTML 状态 + patch 记录
│   ├── useDeckSpec.js            # 读 spec 摘要（不暴露编辑接口）
│   ├── useComments.js
│   ├── useTweaks.js
│   ├── useFileUpload.js
│   └── useIframeBridge.js        # ★ postMessage 双向通信封装
│
├── lib/
│   ├── api.js                    # REST 调用
│   ├── ws-client.js              # WebSocket 封装（reconnect / heartbeat）
│   ├── html-utils.js             # DOM 操作 / patch / element anchor 序列化
│   ├── theme.js                  # ← 从 dev/src/constants/theme.js copy
│   └── helpers.js
│
├── stores/
│   └── globalStore.js            # zustand
│
├── mock/                         # P1 用，P3 后逐步替换
│   ├── deck.html                 # 一份示例自包含 HTML（5 页 DeskSkill 风格）
│   ├── deck-spec.js              # 对应的 mock spec
│   └── projects.js               # mock 项目列表
│
└── styles/
    └── globals.css               # reset
```

### 状态管理

- **全局**：Zustand store，存 toast、全局 modal、auth-stub（MVP 单用户用 localStorage 假装）
- **项目级**：每个 `/projects/:id` 用 `useReducer + Context`，holds messages / inputs / comments / spec / htmlArtifact / runStatus
- **WS 连接**：每个 project 一个 WS，进入项目时建连，离开时断
- **乐观更新**：direct edit / slider 改 HTML 立即反映，后端 ack 后 confirm

## 复用清单（节省 ~60% UI 代码）

| 直接搬 | 来源 |
|---|---|
| DataCard / DetailModal / FullPanel / Accordion / ChartCarousel / ToggleSwitch / Form / BrowsePage / MiniBar / StarRate / Stat / BaseCard | `dev/src/components/ui/` |
| theme.js（COLOR / GAP / FONT_SIZE / cubic-bezier） | `dev/src/constants/theme.js` |
| 弹窗 mounted+visible 双状态 + rAF 双帧入场 / setTimeout 串行关 | 设计速查表（拷贝模式） |

| 不能搬 | 原因 |
|---|---|
| WoCard / WoDeskRow / WoBrowse / WoFullPanel / ScorePanel / VariantManager / DocReader | 深度耦合 Plan/Variant/Score/Dim 业务 |
| Sidebar | dev/ 是 tab + 角色，Nodesign 是 router + 多用户雏形 |

## MVP Phase 切割

| Phase | 时长估 | 交付 | 解锁条件 |
|---|---|---|---|
| ✅ **P1 前端骨架** | 1 周 | Vite scaffold + React Router + 三栏 layout 容器 + theme.js + 12 个 UI 组件搬进来 + Canvas iframe 加载 mock HTML（5 页）+ direct edit（双击文字 contenteditable 落本地 state）+ chat panel UI（消息流不接后端，发送先存本地）+ 4 个路由（/、/projects/:id、占位的 /design-systems、/skills）| 此 plan 通过 |
| ✅ **P2 前端交互层 + 产品壳（A+B+C）** | 1.5 周 | **★ inspect-grade 元素选择面板**（点 canvas 元素 → 弹双视图）+ DirectEditModal（属性 form）+ comment 完整 UI（按页分组 + jump + resolve）+ chatDraft 跨组件注入（触发新 run）+ patches state + Inputs FileReader 真预览 + Code mode Monaco 可编辑 + 项目 CRUD（zustand persist localStorage）+ CreateProjectModal + 顶栏 ⋯ 菜单 + ShareModal + ExportMenu（HTML 真下载）+ ToastContainer + EditOverlay 实时跟随 + 元素语义词典 + DS/Skill 列表 mock + DS new/detail 占位 | P1 done |
| ⚪ **P3 后端最小集** | 1 周 | Express + better-sqlite3 + WS 通道 + 项目/资料/run/spec/html CRUD + mock skill（返回固定 spec + 固定 HTML 验证全链路）+ 前端接真 WS | P1+P2 done ✅ |
| **P4 真 agent 接入** | 1-2 周 | engine/agent/loop.js（包 server/shared/agent-loop.js）+ skills/loader + 5 个核心工具（read/write/edit/list_dir/todo）+ 一个真实 brief 跑通（用最简单的 SKILL.md，不接 v0.7.5 全套）| P3 done + Kimi probe pass |
| **P5 inline comment 真接 + slider** | 1 周 | comment apply 接 simple-LLM 端点（HTML element patch）+ tweak schema 真生成（agent 暴露）+ slider live preview + apply 落 HTML | P4 done |
| **P6 参照模式 + 多 skill** | 2 周 | 设计系统 list/new/detail 页 + .html 路径的 DS 抽取（最小通路，影响 spec.designTokens）+ skill registry 页面 | P5 done |
| **P7 导出** | 1 周 | HTML 直接下载 + PDF（playwright print）+ PPTX（先标"WIP"，调研 pptxgenjs / 自写转换） | P6 done |
| **v2 CAD 拖动** | 待估 | dnd-kit + 拖动改 HTML DOM 顺序/位置/尺寸 + 嵌套支持 | P7 done + 探索期反馈足够 |

**P1 是这次 plan 的 actionable 范围**。P2 之后等 P1 通过后再细化。

## 关键文件清单（P1 创建）

```
Nodesign/web/                          ← 新目录，前端工作区
├── package.json                        # vite + react 19 + react-router 7 + zustand + lucide
├── vite.config.js                      # 端口 5174 避开 dev/ 5173
├── index.html
├── src/
│   ├── main.jsx                        # ReactDOM 入口
│   ├── App.jsx                         # 路由根
│   ├── routes/Home.jsx
│   ├── routes/Project.jsx              # 三栏壳，加载 mock HTML
│   ├── routes/DesignSystemList.jsx     # 占位（"建设中"）
│   ├── routes/SkillList.jsx            # 占位
│   ├── components/layout/AppShell.jsx
│   ├── components/layout/ThreeColumnLayout.jsx
│   ├── components/layout/TopBar.jsx
│   ├── components/chat/ChatPanel.jsx
│   ├── components/chat/MessageList.jsx
│   ├── components/chat/Message.jsx
│   ├── components/chat/ChatComposer.jsx
│   ├── components/canvas/CanvasFrame.jsx
│   ├── components/canvas/CanvasToolbar.jsx
│   ├── components/canvas/HtmlIframe.jsx
│   ├── components/canvas/EditOverlay.jsx       # P1 简化：先只显示选中边框
│   ├── components/canvas/DirectEditBridge.js   # 注入 iframe 的脚本
│   ├── components/context-panel/ContextPanel.jsx
│   ├── components/context-panel/InputsTab.jsx  # UI 壳
│   ├── components/context-panel/SystemTab.jsx  # 显示 mock skill/DS/spec
│   ├── components/ui/                  # 从 dev/src/components/ui/ 直接 copy 12 个文件
│   ├── lib/theme.js                    # 从 dev/src/constants/theme.js copy
│   ├── lib/html-utils.js               # 基础 DOM 工具（生成 element anchor 序列化）
│   ├── lib/helpers.js
│   ├── hooks/useIframeBridge.js
│   ├── stores/globalStore.js
│   ├── mock/
│   │   ├── deck.html                   # 5 页自包含 HTML（DeskSkill 风格）
│   │   ├── deck-spec.js                # 对应 spec mock
│   │   └── projects.js                 # 5 个 mock 项目
│   └── styles/globals.css
└── README.md                           # 跑法 + P1 验证步骤
```

**注意**：前端代码在 `Nodesign/web/`，跟现有 `Nodesign/server/` 平级；HANDOVER §11 说"不要急着 monorepo"，我们走 web/ 跟 server/ 各自 npm（暂不共享 package）。

## Verification（P1 完成的判据）

```bash
cd Nodesign/web
npm install
npm run dev      # 起在 5174
```

打开 `http://localhost:5174/` 应能：

1. ✅ 看到 Home 页（项目网格 mock 5 个项目，配 DataCard / BaseCard 组件）
2. ✅ 点项目进入 `/projects/proj-001` 三栏页
3. ✅ 三栏布局正确：左 360px chat / 中 auto canvas / 右 340px context panel
4. ✅ 顶栏正确（亮黑系 + 项目名 + Share/Export 按钮，按钮先 mock）
5. ✅ Canvas iframe 加载 mock deck.html（5 页 DeskSkill 风格 self-contained HTML）
6. ✅ Canvas Toolbar 三模式切换（Edit / Preview / Code）
7. ✅ Edit 模式下双击 iframe 内的文字进入 contenteditable，blur 后控制台 log 出 patch
8. ✅ Preview 模式下不能编辑（postMessage 桥接关闭）
9. ✅ Code 模式下 Monaco 显示 HTML 源码
10. ✅ Inputs tab dropzone UI（不发请求，FileReader 本地预览）
11. ✅ SystemTab 显示 mock spec 摘要（metaphor / intent / outline 列表）
12. ✅ ChatPanel 输消息 + 发送（先 push 到本地 messages 数组）
13. ✅ 视觉跟 dev/ 完全一致（亮黑按钮 / 深棕标题 / cubic-bezier 入退场）
14. ✅ 路由切换流畅（Home ↔ Project ↔ DesignSystemList 占位 ↔ SkillList 占位）

## 开放问题（P1 进行中或 P1 完成后再敲定）

1. **page-spec schema v0.1 的具体字段**：上面给的是草案，实际探索 P3-P5 时根据 agent 实际产出迭代。
2. **WS 事件协议**：事件名 + payload schema 在 P3 后端实现时定。
3. **iframe postMessage 编辑桥接的细节**：
   - element anchor 怎么序列化（DOM path? data-id? 二者结合？）
   - direct edit 的 contenteditable scope（只 text node 还是允许结构改）
   - 用 `iframe.contentDocument` 直读还是只 postMessage（同源 iframe 都可，看安全要求）
4. **inputs ingest pipeline 范围**（P3 之后）：MVP 只做 .html / .pdf / 截图（PNG/JPG）；.pptx / .docx / repo / web capture 推后。
5. **CAD 拖动 v2 的具体技术**：dnd-kit vs react-dnd vs 自写。等 v2 启动时再选。
6. **PPTX 导出**（P7）：HTML → PPTX 没有完美方案，要么用 pptxgenjs（HTML 子集）要么自写 page-spec → PPTX 转换器。

## 退出 plan mode 后立刻做的事

1. 把 Design Principles §1-§6 写入 memory（`/Users/edy/.claude/projects/-Users-edy-Desktop-panel-workplace/memory/`）—— 用户明确要求"这些内容都存到记忆中去"
2. 开始 P1 实施：scaffold web/ + 搬 ui/ + theme + iframe canvas + mock HTML + direct edit bridge + 5 个路由

## 不在本 plan 范围

- ❌ 后端 engine 进一步代码（已写的 store.js / workspace.js / smoke.js 保留）
- ❌ Kimi probe 实跑（等用户 npm install + 填 KIMI_API_KEY）
- ❌ Agent SDK 拆包（用户已确定不依赖 SDK，自写）
- ❌ 风格根因诊断（§6）；要做也是 P6 参照模式启动时的事
- ❌ React spec renderer / blocks（已删，不需要这层）
