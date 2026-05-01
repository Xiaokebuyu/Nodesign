# Claude Design 产品对标参考（NoDesign 北极星）

> ## 🟢 NoDesign 当前状态（2026-05-01 Phase 3 收尾）
>
> 本文是 P1 时代（2026-04-29）写的 Claude Design **产品形态拆解**，作为 NoDesign
> 的产品对标。stage 1 + Phase 1+2+3 SDK 接通后，**所有"技术实现推断"段已删除** ——
> 因为 NoDesign 实际架构基于 Claude Agent SDK，与本文当时推断的"自定义 agent loop /
> 4 轮 orchestrator / 自撸 sandbox" 完全不同。
>
> **本文当前用途**：仅看**产品形态描述** —— 用户看到什么、有哪些原子功能、该
> 有什么交互。
>
> **不要再看**：本文中任何架构推断 / 实现链路 / 模块拆解 —— 以 SDK 实际行为
> + 项目代码为准。
>
> ## 已删除的过时章节（2026-05-01 清理）
>
> 以下"技术实现推断"章节在 Phase 3 收尾时删除（git history 可查回滚）：
>
> - § 7.2 Context ingestion pipeline
> - § 8.3 Design System Extraction
> - § 9.3 生成链路推断
> - § 13.3 Codebase Intelligence
> - § 14.3 Deck compiler
> - § 15.2 协作技术推断
>
> 都是 P1 时代对 Claude Design 内部架构的猜测，对 NoDesign 基于 SDK 的实际架构
> 零参考价值。
>
> ## 实施真相（cold-start 必读）
>
> - **agent 能力来自 Claude Agent SDK** @anthropic-ai/claude-agent-sdk 0.2.123
> - **工具集 = SDK 内置 + Nodesign MCP**：Read/Write/Edit/Glob/Grep/TodoWrite/Bash/AskUserQuestion + mcp__nodesign__{screenshot_canvas, export_handoff, record_decision}
> - **session / file checkpoint / hooks (10/29) / subagent / MCP / sandbox** 全部走 SDK
> - **架构边界 audit 干净**：grep 验证 SDK 接触面只有 6 处 import，业务层零 SDK 直接依赖
>
> **实施细节优先看**：
> - `HANDOVER_2026-05-01_phase123.md`（Phase 1+2+3 改动总览，cold-start 入口）
> - `HANDOVER_2026-04-30_stage1.md`（stage 1 代码地图）
> - `server/engine/skills/deskskill-engine-mini/SKILL.md`（agent 行为约束 v0.3.0）
>
> ## ⚠️ 工作形态差异（防误导）
>
> Claude Design 是 **Anthropic 封闭产品**，可能用预定义 orchestration pipeline /
> 自撸 agent loop / 自撸 sandbox / 复杂层级架构。
>
> NoDesign 是 **基于 Claude Agent SDK 的薄壳工作台**：
>
> | 维度 | Claude Design（推断）| NoDesign（实际）|
> |---|---|---|
> | agent loop | 自撸多轮 orchestrator | SDK `query()` |
> | 工具 | 自定义 tools + 预定义 schema | SDK 内置 8 个 + 3 个 MCP 工具 |
> | 上下文 ingestion | pipeline（detection → extraction → chunking → indexing）| SDK Read 工具 + UserPromptSubmit hook 注入 |
> | Design System 抽取 | 4 层 pipeline 推断 | 子代理 ds-extractor（stage 2 候选，未实施）|
> | 沙箱 | "sandboxed preview" 自实现推断 | SDK 内置 `sandbox: SandboxSettings`（macOS sandbox-exec / Linux bubblewrap）|
> | 协作 | RBAC + Group chat + Enterprise toggle | 单用户单 project，无协作 |
> | 计费 / 配额 | Per-user weekly allowance / metering layer | 走 Anthropic gateway，无独立 metering |
> | 版本 / 分支 | 产品级 candidate / fork | git commit + 双轨 file checkpoint（rewindFiles 未接通）|
>
> **最重要的一点**：原 § 3 列的 8-Layer 架构图（已删）暗示"需要自撸 8 个 Layer"。
> **NoDesign 完全不需要这个架构** —— SDK 已经把 agent loop / 工具 / session /
> hooks / sandbox / file checkpoint 全部包好了。我们只做画布层 + 业务桥接 +
> 1 SKILL.md + hooks/MCP/subagent 业务逻辑。
>
> 阅读本文产品形态描述时，**仅参考"Claude Design 用户能用什么"**，不要默认
> "我们也要这样实现"。

---

> 调研口径：截至 **2026-04-29** 的公开资料。
> 核心来源：Anthropic 官方发布稿、Claude Help Center、Claude 官方教程、Canva 官方新闻稿、TechCrunch 报道。
> 重要说明：Anthropic 没有公开 Claude Design 的内部架构、代码、服务拆分、Prompt Orchestration 细节或渲染沙箱实现。因此本文会把内容分成三类：
> **事实** = 官方或可信公开来源明确写了；
> **强推断** = 由多个公开功能可以高置信推出的工程实现；
> **弱推断** = 可能性较高，但没有公开证据确认。

---

## 1. 一句话结论

Claude Design 不是“AI 画图工具”，而是一个以 **Claude Opus 4.7 + 组织级设计系统 + HTML/Canvas 工作台 + 多轮设计代理 + 导出/工程交付链路** 组成的视觉生产系统。它的真正产品内核不是生成漂亮页面，而是把“需求 → 上下文 → 品牌/组件约束 → 可交互设计 → 局部迭代 → 团队协作 → Canva/PPT/PDF/HTML/Claude Code 交付”串成闭环。

官方发布稿把它定义为 Anthropic Labs 产品，用于和 Claude 协作创建 designs、prototypes、slides、one-pagers 等视觉工作，并明确说它由 **Claude Opus 4.7** 驱动、面向 Pro、Max、Team、Enterprise 订阅用户以 research preview 形式开放。([Anthropic][1])

---

## 2. 产品定位：Claude Design 到底是什么

### 2.1 它的产品形态

Claude Design 的基本形态是：**左侧聊天界面 + 右侧画布 Canvas**。用户在聊天里描述要做什么，Claude 在画布里生成一个可工作的视觉结果，然后用户继续通过聊天和 inline comments 迭代，最后导出或分享。官方 Help Center 明确写到，Claude Design 有两个主区域：左侧 chat interface 和右侧 canvas；典型流程是创建项目、添加截图或代码库等上下文、描述需求、查看画布生成结果、用聊天和 inline comments 迭代、最后导出或分享。([Claude Help Center][2])

更准确地说，它像下面这几个工具的交叉体：

| 维度   | 类似工具                              | Claude Design 的位置                                |
| ---- | --------------------------------- | ------------------------------------------------ |
| 视觉生成 | Canva AI、Gamma、Tome               | 能生成 deck、one-pager、landing page、campaign visuals |
| 产品原型 | Figma、Framer、v0、Lovable           | 能做 wireframe、mockup、interactive prototype        |
| 工程交付 | Claude Code、Cursor、v0             | 能把设计意图 handoff 给 Claude Code                     |
| 品牌系统 | Figma library、Canva Brand Kit     | 能从代码库、deck、品牌文件中抽取 design system                 |
| 多轮代理 | Claude Artifacts / Custom visuals | 通过对话、评论、滑杆、直接编辑持续迭代                              |

TechCrunch 的报道也把它描述成一个用 Claude 创建 prototypes、slides、one-pagers 等视觉产物的 experimental product，并提到 Anthropic 对外说它更像是补充 Canva，而不是替代 Canva，因为它面向的是那些“不从设计工具开始，但需要快速把想法变成视觉结果”的用户。([TechCrunch][3])

---

## 3. ~~总体架构 8-Layer 推断~~（已删除，见顶部"工作形态差异"声明）

> 原内容是基于公开功能反推的 Claude Design 8-Layer 系统地图（Web Workspace /
> Project Context / Design System / Agent Orchestration / Render & Execution /
> Collaboration & Governance / Export & Interop / Metering 等）。这是 Claude
> Design 这个**封闭产品的功能 inventory**，不是 NoDesign 的实施蓝图。
>
> NoDesign 的实际架构基于 Claude Agent SDK，**不需要自撸 8 个 Layer**。
> 详见 `HANDOVER_2026-04-30_stage1.md`（代码地图）+ `HANDOVER_2026-05-01_phase123.md`（架构边界 audit）。

---

## 4. 功能原子拆解总表

下面是“庖丁解牛”式拆分：每一行是一个产品功能原子，以及它背后大概率需要的技术模块。

| 功能原子                   | 用户看到的功能                                               | 官方事实                                                                                                     | 技术实现推断                                                             |
| ---------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 订阅可见性                  | Pro/Max/Team/Enterprise 可用，Enterprise 默认关闭            | Research preview；Enterprise 默认关闭                                                                         | Feature flag + plan entitlement + org-level capability toggle      |
| 组织启用                   | 管理员在设置里开启 Claude Design                               | Team/Enterprise admins 可在 Organization settings > Capabilities 打开 Anthropic Labs 下的 Claude Design toggle | Admin console + RBAC policy service                                |
| 自定义角色                  | 指定谁能用、谁能编辑 design system                              | Design system setup 权限和 general access 可分开控制                                                             | Role-based authorization + capability matrix                       |
| Project 工作区            | 每个设计在项目里生成和迭代                                         | 新项目继承组织 design system                                                                                    | Project DB + artifact state + conversation state                   |
| Chat panel             | 用户自然语言描述需求                                            | 左侧 chat，右侧 canvas                                                                                        | LLM conversation orchestrator                                      |
| Canvas preview         | 右侧实时显示设计                                              | Claude generates a working design on the canvas                                                          | Web runtime / iframe sandbox / DOM preview                         |
| 上下文添加                  | 上传截图、图片、资产、deck、文档、代码库                                | Help Center 明确列出 screenshots/images/assets、codebases/design files                                        | File parser + asset store + multimodal encoder + code indexer      |
| 有效 prompt 结构           | goal/layout/content/audience                          | 官方建议 prompt 包含目标、布局、内容、受众                                                                                | Prompt template / instruction decomposition                        |
| Chat 全局修改              | 改整体配色、布局、添加 panel、多方案                                 | 官方把 chat 定位为 broad changes                                                                               | Whole-artifact regeneration or patching                            |
| Inline comments        | 点画布某元素要求局部修改                                          | 官方说可点击 canvas 特定部分请求 targeted change                                                                     | Element selection + coordinate/DOM anchor + localized patch prompt |
| 直接编辑                   | 直接编辑文本/细节                                             | 发布稿明确提到 direct edits                                                                                     | WYSIWYG edit layer + artifact patch update                         |
| Custom sliders / knobs | Claude 生成调节控件，用滑杆调 spacing/color/layout               | 发布稿明确提到 custom sliders 和 adjustment knobs                                                                | Model-generated parameter schema + CSS variables/state controls    |
| 多方向探索                  | 生成 2–3 个 alternative layouts                          | Help Center 建议 ask for variations                                                                        | Parallel generation branches + comparison layout                   |
| 保存当前版本                 | “Save what we have and try another direction”         | 官方说 Claude 会保存当前项目并确认位置                                                                                  | Snapshot/version record                                            |
| Accessibility review   | 让 Claude 审核 contrast、hierarchy、usability              | Help Center 明确可让 Claude review accessibility/contrast/hierarchy/usability                                | Design critique prompt + heuristics + maybe DOM/style inspection   |
| 产品原型                   | 设置页、onboarding、search、approval workflow               | UX 教程列出 rapid feature prototyping                                                                        | Multi-screen app generation + interactive state machine            |
| 完整用户流                  | 从 dashboard 到 payment 到 confirmation                  | UX 教程说可 prototype complete user flows                                                                    | Flow graph + screen states + navigation wiring                     |
| 内部工具                   | admin dashboard、content moderation panel、ops workflow | UX 教程列为适合场景                                                                                              | Data-table UI patterns + CRUD mock interactions                    |
| 代码库连接                  | GitHub import、本地目录                                    | 官方教程说可 import from GitHub 或 attach local directories                                                     | Repo ingestion + file tree selection + code summarization          |
| 组件理解                   | 识别 buttons/cards/modals/layouts                       | 官方说 Claude 能理解 component structure、styling、framework patterns、file organization                          | AST/text search + component catalog + design token extractor       |
| 生产感原型                  | 用真实组件和架构生成                                            | 官方说连接代码库后不再是 generic prototype                                                                           | Component-aware generation                                         |
| 大 repo 处理              | 不建议整个 monorepo                                        | 官方说大型 repo 可能 lag/browser issues，建议只挂子目录                                                                 | Frontend upload/file-tree bottleneck + context budget management   |
| Presentation 生成        | 通过 prompt 生成完整 deck                                   | 官方教程说能生成 polished presentations 和 slide decks                                                            | Deck schema + HTML slide renderer                                  |
| Slide 单页编辑             | “On slide 3...”                                       | 官方教程说明可按 slide reference 修改                                                                              | Slide ID / page index targeting                                    |
| 增删 slides              | 添加 slide、展开 section                                   | 官方教程明确支持                                                                                                 | Deck outline mutator                                               |
| 图表和数据可视化               | 生成 charts                                             | 官方教程说可将 data visualizations 放入 slides                                                                    | Chart component generator + data binding                           |
| 动画叙事                   | HTML deck 跨 slides animation                          | 官方说 HTML 相比 PPT 可做动画叙事                                                                                   | CSS/JS animation timeline                                          |
| 图片/logo 嵌入             | 加入 logos、images、visual elements                       | 官方教程明确支持                                                                                                 | Asset library + image embedding                                    |
| Approved imagery       | 从 design system 里取 approved imagery                   | 官方教程提到有 approved imagery 时自动使用                                                                           | Asset registry + brand-safe selection                              |
| 团队分享                   | Private/view/comment/edit                             | 官方列出权限                                                                                                   | Share link ACL                                                     |
| Group chat             | 多人一起和 agent 对话                                        | 官方教程说 multiple users 可 group chat-style interface                                                        | Shared conversation state + concurrency controls                   |
| ZIP 导出                 | 下载项目包                                                 | 官方列出 Download as .zip                                                                                    | Artifact bundler                                                   |
| PDF 导出                 | 输出静态 PDF                                              | 官方列出 PDF export                                                                                          | Headless browser print-to-PDF                                      |
| PPTX 导出                | 输出 PowerPoint                                         | 官方列出 PPTX export                                                                                         | HTML/deck → PPTX conversion                                        |
| Standalone HTML        | 输出独立 HTML                                             | 官方列出 standalone HTML，presentation 中称最适合交互和动画                                                             | Static asset bundling + runtime packaging                          |
| Send to Canva          | 发到 Canva 可继续编辑                                        | 官方和 Canva 新闻稿均确认                                                                                         | HTML/artifact import bridge + Canva Design Model conversion        |
| Claude Code handoff    | 把原型交给 Claude Code                                     | 官方说 bundle 包含 design files、chat、README 和可粘贴 prompt                                                       | Handoff bundle + signed URL + implementation prompt                |
| 用量独立计量                 | 不占 chat/Claude Code 额度                                | 官方计费文档明确                                                                                                 | Separate meter + allowance bucket                                  |
| 每周额度                   | 每 7 天 reset                                           | 官方计费文档明确                                                                                                 | User-level quota reset job                                         |
| 资产持久存储                 | 上传资产 persistent storage                               | Admin guide 明确                                                                                           | Object storage + retention policy                                  |
| 暂无 audit logs          | Labs 版本不支持                                            | Admin guide 明确                                                                                           | Enterprise telemetry gap                                           |
| 暂无 usage tracking      | Labs 版本不支持                                            | Admin/pricing 文档明确                                                                                       | Analytics gap                                                      |
| 不支持 data residency     | 官方明确                                                  | Compliance limitation                                                                                    | Region pinning未完成或未开放                                              |
| Web-only               | 当前只在 claude.ai/design                                 | Admin guide 明确                                                                                           | 独立 web app / web route                                             |

关键证据集中在 Help Center 的入门文档、设计系统文档、Admin guide、UX 教程、presentation 教程和计费文档：入门文档描述 chat/canvas、context、comments、export、known limitations；设计系统文档描述设计系统抽取与发布；Admin guide 描述 RBAC、rollout、隐私和企业限制；UX 教程描述代码库连接和 Claude Code handoff；presentation 教程描述 HTML deck、slide 编辑、协作和导出。([Claude Help Center][2])

---

## 5. 原子层拆解一：入口、权限、组织与产品开关

### 5.1 计划与可用性

Claude Design 是 research preview，面向 Pro、Max、Team、Enterprise 开放；Enterprise 默认关闭。这个定位意味着 Anthropic 把它放在“新能力探索”而非“完全成熟企业产品”状态。([Claude Help Center][2])

技术上，这通常意味着三个判断：

1. **产品开关和灰度发布**：需要按订阅计划、组织、用户逐步开放。
2. **企业默认关闭**：需要 admin-level capability toggle。
3. **Labs 标记**：功能稳定性、审计、分析、合规能力可能不完整。

官方 Admin guide 证实，Team 和 Enterprise 管理员可以在组织设置的 Capabilities 中找到 Claude Design toggle，并可通过 custom roles 控制访问。([Claude Help Center][4])

### 5.2 RBAC 权限模型

Claude Design 至少有两类权限：

| 权限                              | 说明                          |
| ------------------------------- | --------------------------- |
| General Claude Design access    | 用户能不能创建/使用 Claude Design 项目 |
| Design system setup/edit access | 用户能不能设置和修改组织设计系统            |

官方明确说，design system setup 权限可以和 general Claude Design access 分开控制，这样可信设计师可以编辑设计系统，而更广泛团队只获得普通使用权限。([Claude Help Center][4])

**强推断**：这背后需要一个能力级 RBAC 系统，而不是简单的“组织内所有人都能用”。典型权限对象可能包括：

```text
capability: claude_design.use
capability: claude_design.create_project
capability: claude_design.comment
capability: claude_design.edit_project
capability: claude_design.design_system.create
capability: claude_design.design_system.publish
capability: claude_design.export
capability: claude_design.handoff_to_code
```

---

## 6. 原子层拆解二：项目 Project 与工作台 Workspace

### 6.1 项目制

Claude Design 用 project 作为基本工作单元。新项目会自动继承组织设计系统，用户不需要每次上传品牌资产、配置品牌色或字体。([Claude Help Center][2])

**强推断：Project 至少保存这些状态：**

```text
Project
├─ project_id
├─ organization_id
├─ design_system_id / version
├─ owner_id
├─ permission_set
├─ chat_threads
├─ canvas_artifacts
├─ uploaded_assets
├─ linked_codebase_context
├─ comments
├─ versions / snapshots
├─ export_history
└─ usage_meter_events
```

### 6.2 Chat + Canvas 双区结构

用户在 chat 中输入意图，Claude 在 canvas 中生成 working design。这个设计不是纯文本，而是可以被查看、交互、评论和导出的视觉对象。([Claude Help Center][2])

**强推断：Canvas 不是图片预览，而是 Web artifact runtime。**

证据：

* Claude Design presentation 被官方描述为 **interactive HTML rendered in the canvas**。([Claude][5])
* 导出支持 standalone HTML。([Claude Help Center][2])
* Claude 的 custom visuals 官方说明是用 HTML 构建，而不是照片或插画。([Claude Help Center][6])
* Claude 可以生成 HTML/SVG 视觉内容，这些内容可以交互、跟进修改。([Claude Help Center][7])

所以，Claude Design 大概率在画布中运行的是一个类似 Artifact 的代码渲染沙箱，可能包含 HTML/CSS/JS/SVG，也可能在某些情况下包含 React 组件、Canvas/WebGL/Three.js 等前端代码。官方没有确认具体框架，所以 React/iframe/WebGL 属于推断。

---

## 7. 原子层拆解三：输入与上下文系统

Claude Design 的输入不只是 prompt。它的核心能力之一是“把项目上下文吃进去”。

### 7.1 官方明确支持的上下文类型

| 上下文类型                      | 官方说明                               |
| -------------------------- | ---------------------------------- |
| 文本 prompt                  | 描述要构建什么                            |
| 截图 / 图片 / 现有资产             | 用于参考现有设计、竞品、wireframe、视觉灵感         |
| 现有 slide deck / document   | 用于复刻或参考某种设计风格                      |
| 代码库 / 设计文件                 | 让 Claude 理解组件、架构、样式模式              |
| DOCX / PPTX / XLSX         | 发布稿明确提到可上传                         |
| Web capture                | 从网站抓取元素，让 prototype 更像真实产品         |
| GitHub / local directories | UX 教程提到可通过 Import 从 GitHub 或本地目录附加 |

入门文档明确说，用户可以随时给项目添加参考材料，包括截图、图片、现有资产、竞品产品、wireframe、视觉灵感、现有 slide deck 或文档；也可以链接代码仓库，让 Claude 理解已有组件、架构和样式模式。([Claude Help Center][2])

发布稿还补充了 DOCX、PPTX、XLSX 上传，以及 web capture 工具。([Anthropic][1])

UX 教程明确说 Claude Design 可以通过 Import 按钮从 GitHub import，也可以 attach local directories。([Claude][8])

### 7.2 ~~技术实现推断：Context ingestion pipeline~~（已删除，见顶部声明）

### 7.3 上下文不是越多越好

官方建议“上下文越多，输出越好”，但同时也警告大型代码库会造成性能问题。UX 教程说，如果 codebase 是 monorepo 或有超过 100 人活跃贡献，建议只链接包含相关组件的 package 或 directory；还提醒 Chrome 对巨大 file tree 处理不好，应避免包含 `.git`、`node_modules` 等超大目录。([Claude][8])

**结论**：Claude Design 的上限不只取决于模型，还取决于“上下文治理”。一个高质量 Claude Design 项目应该像工程项目一样控制输入边界。

---

## 8. 原子层拆解四：Design System 是核心护城河

### 8.1 Design system 的官方定义

Claude Design 的设计系统会从用户提供的资产中抽取 reusable components、colors、typography、patterns，并作为账户/组织内项目的基础。官方列出的素材包括 codebases、slide decks、design references、brand guideline assets、logos、color palettes、typography specs 等。([Claude Help Center][9])

生成后的 design system 通常包括：

| 内容              | 官方示例                                 |
| --------------- | ------------------------------------ |
| Color palette   | primary、secondary、accent colors      |
| Typography      | font families、sizes、weights          |
| Components      | buttons、cards、navigation elements    |
| Layout patterns | spacing、grid systems、page structures |

这些内容都在官方设计系统设置文档中明确列出。([Claude Help Center][9])

### 8.2 为什么它重要

Admin guide 说得很直接：rollout Claude Design 之前最重要的事情，是让有经验的设计师设置组织设计系统；一旦设置好，团队创建的每个项目都会自动反映品牌。官方还说，如果没有 design system 就放开，团队会得到 functional but generic output。([Claude Help Center][4])

这说明 Claude Design 的产品逻辑不是“让每个用户写更好的 prompt”，而是把风格、品牌、组件、布局模式变成组织级基础设施。

### 8.3 ~~技术实现推断：Design System Extraction~~（已删除，见顶部声明）

### 8.4 Design system 的生命周期

官方描述了一个生命周期：

```text
创建/选择组织
    ↓
onboarding flow
    ↓
上传品牌和产品资产
    ↓
Claude 分析并生成 design system / UI kit
    ↓
设计师 review
    ↓
发布 Published toggle
    ↓
组织内新项目默认使用
    ↓
品牌变化时通过 Remix 继续修改
```

发布后，从 Claude Design homescreen 创建的新项目会使用组织 design system，而不是默认系统。品牌变化时，用户可以在 organization settings 中打开 design system，点击 Remix 进入 chat 界面继续修改。([Claude Help Center][9])

---

## 9. 原子层拆解五：生成引擎

### 9.1 它生成什么

官方列出的产物包括：

| 产物类型                       | 官方来源中的表达                                           |
| -------------------------- | -------------------------------------------------- |
| designs                    | polished visual work                               |
| prototypes                 | realistic prototypes / interactive prototypes      |
| slides / presentations     | pitch decks、presentations、slide decks              |
| one-pagers                 | one-pagers                                         |
| wireframes / mockups       | product wireframes and mockups                     |
| design explorations        | multiple directions                                |
| marketing collateral       | landing pages、social media assets、campaign visuals |
| microsites / landing pages | interactive microsites、polished single-page sites  |
| frontier design            | voice、video、shaders、3D、built-in AI                 |

发布稿列出了 realistic prototypes、product wireframes/mockups、design explorations、pitch decks/presentations、marketing collateral、frontier design 等场景。([Anthropic][1])

Admin guide 也列出 prototypes/mockups、presentations/slide decks、microsites/landing pages、inline comments 和 handoff to engineering。([Claude Help Center][4])

### 9.2 生成方式：大概率是 HTML-first

Claude Design 并不是传统意义的 diffusion/image generation。这个判断基于几条公开证据：

1. 官方说 Claude Design presentations 是 **interactive HTML rendered in the canvas**。([Claude][5])
2. 导出支持 standalone HTML，而且 presentation 教程说 standalone HTML 最适合 interactivity and animations。([Claude][5])
3. Claude 官方文档说 Claude 的 custom visuals 是用 HTML 构建，不是照片或插画。([Claude Help Center][6])
4. Claude 官方文档也说 Claude 可生成 HTML/SVG 视觉内容。([Claude Help Center][7])

**强推断**：Claude Design 的渲染对象大概率是代码化 artifact，而不是静态图像。可能生成：

```text
index.html
styles.css
script.js
assets/*
or
React component tree
or
HTML + SVG + CSS variables
or
Canvas/WebGL/Three.js for advanced cases
```

### 9.3 ~~生成链路推断~~（已删除，见顶部声明）

> 关键产品事实仍 valid：**Claude 不是只回答文本，而是生成可执行/可渲染的设计工件**。

---

## 10. 原子层拆解六：Chat、Inline Comments、Direct Edits、Sliders

这是 Claude Design 的交互核心。

### 10.1 Chat：全局意图层

官方建议 chat 用于 broad changes，比如：

* Make the color scheme darker and more minimal.
* Rearrange the dashboard so metrics are in the top row and chart below.
* Add a settings panel on the right side.
* Show me 2–3 alternative layouts.

官方还说可以让 Claude 解释设计决策、提出改进建议，或从 accessibility 角度 review。([Claude Help Center][2])

**技术推断**：Chat 会把用户指令作为“全局修改请求”传给模型，模型拿到当前 artifact 状态和设计系统上下文后，生成新的 artifact 或 patch。

### 10.2 Inline comments：局部定位层

Inline comments 允许用户直接点击画布上的某个部分，然后请求 targeted change，例如按钮 padding 更大、radio 改 dropdown、使用 primary brand color、让 section collapsible。官方还说，如果 comments 没被读取，可以把文本粘到 chat，因为存在 comments 消失的间歇性问题。([Claude Help Center][2])

**技术实现推断**：

```text
User clicks element on canvas
    ↓
Frontend captures target
    ├─ DOM node id / component id
    ├─ bounding box coordinates
    ├─ screenshot crop maybe
    └─ current style / text / metadata
    ↓
User writes comment
    ↓
Comment anchored to element
    ↓
Model receives:
    "Apply this feedback to this element/context"
    ↓
Patch specific component/style/content
```

这个功能如果要稳定，需要对画布元素做可寻址化。否则模型无法知道“这个按钮”到底是哪一个按钮。

### 10.3 Direct edits：所见即所得层

发布稿明确说可以通过 direct edits 迭代。([Anthropic][1])

**强推断**：Direct edit 可能用于文本内容、简单属性、局部样式。实现上需要把用户在画布里的直接修改同步回 artifact state，否则下一次模型迭代会覆盖掉用户手改的内容。

### 10.4 Custom sliders / adjustment knobs：参数化控制层

发布稿写到，用户可以使用 Claude 生成的 custom sliders，也可以用 adjustment knobs live tweak spacing、color、layout，再让 Claude 把变化应用到完整设计。([Anthropic][1])

这是非常关键的一个设计。它说明 Claude Design 不只做“prompt → regenerate”，还会临时生成一个“当前设计专用控制面板”。

**技术实现强推断**：

```text
Claude generates artifact
    ↓
Claude identifies tunable parameters:
    ├─ spacingScale
    ├─ primaryColor
    ├─ density
    ├─ cardRadius
    ├─ animationSpeed
    ├─ heroLayoutVariant
    └─ chartEmphasis
    ↓
Frontend renders sliders/toggles/color pickers
    ↓
User adjusts controls
    ↓
CSS variables / JS state update live preview
    ↓
User asks Claude to apply globally
    ↓
Model patches design system/artifact accordingly
```

这本质是把设计稿从“静态输出”变成“可参数化 artifact”。

---

## 11. 原子层拆解七：版本、分支与多方向探索

Claude Design 不是完整 Git，也不是 Figma 历史版本系统，但它有轻量“保存当前版本再探索新方向”的能力。官方入门文档说，如果用户想探索另一个方向但不丢掉当前工作，可以告诉 Claude：“Save what we have and try a completely different approach.” Claude 会保存当前项目并确认保存位置，方便后续引用。([Claude Help Center][2])

**技术推断**：

```text
current_artifact_state
    ↓ save snapshot
snapshot_id = vN
    ↓ generate alternate direction
artifact_state = vN+branch
```

这不是严格版本控制，更像自然语言触发的 checkpoint。

对于多方向探索，官方建议用户在不确定方向时让 Claude 生成 2–3 options，比较 alternatives 比猜测更快。([Claude Help Center][2])

---

## 12. 原子层拆解八：产品原型与 UX 工作流

### 12.1 Rapid feature prototyping

官方 UX 教程把 rapid feature prototyping 作为最常见产品场景：从一个功能想法，在一次对话中生成 interactive prototype。示例包括 settings page、onboarding flow、search experience、approval workflow。([Claude][8])

**技术要点**：

* 多屏生成；
* 交互状态；
* 导航关系；
* 伪数据；
* 组件结构；
* 可点击体验。

### 12.2 Stakeholder alignment

官方说 Claude Design 足够快，可以生成 2–3 alternative approaches 并 side by side 展示，用于 design review。([Claude][8])

这背后是“多候选生成”。与单稿输出相比，多候选生成更像：

```text
Prompt
  ├─ Candidate A: card-based layout
  ├─ Candidate B: left-sidebar layout
  └─ Candidate C: top-tab layout
```

### 12.3 Complete user flow mapping

官方说 Claude Design 可以 prototype complete user flows，而不只是单个 screen；示例是从 dashboard 升级提示，到 plan comparison、payment form、confirmation、premium dashboard。([Claude][8])

**技术推断**：这里需要生成一个用户流图：

```text
Dashboard
  → Plan comparison
  → Payment form
  → Confirmation
  → Premium dashboard
```

画布产物需要把这些 screen 连接起来，而不只是把几张图放一起。

### 12.4 Internal tools / admin panels

官方特别提到，内部工具、admin dashboard、content moderation panel、ops workflow 很适合 Claude Design，因为这类场景速度比像素级完美更重要。([Claude][8])

**产品判断**：这说明 Claude Design 的 PMF 初期可能不在“高保真最终视觉稿”，而在“快速把复杂业务流程变成可看可点的 UI”。

---

## 13. 原子层拆解九：代码库连接与生产感原型

### 13.1 代码库接入的意义

官方 UX 教程说，对产品团队来说，连接代码库会让 Claude Design 显著更有用：它不再生成 generic prototypes，而是使用实际 components、styling、architecture。([Claude][8])

这句话很重要。它说明 Claude Design 不是单纯审美工具，而是试图让原型接近可实现代码。

### 13.2 Claude 从代码中理解什么

官方列出四类：

| 官方类别                | 解释                                                 |
| ------------------- | -------------------------------------------------- |
| Component structure | UI building blocks 及其组合方式                          |
| Styling and theming | color system、spacing scale、typography、CSS approach |
| Framework patterns  | state management、hooks、data flow 等惯例               |
| File organization   | 组件和目录的命名/组织方式                                      |

这些内容在 UX 教程中明确列出。([Claude][8])

### 13.3 ~~技术实现推断：Codebase Intelligence~~（已删除，见顶部声明）

### 13.4 与 Claude Code 的接口

代码库连接的另一个目的，是缩小 prototype 和 shippable code 的距离。官方说，当 prototype ready for implementation 时，Claude Design 可以 hand off to Claude Code，并保留 design intent、component choices、architectural decisions，让工程师基于原型工作，而不是重新解释设计。([Claude][8])

---

## 14. 原子层拆解十：Presentation / Slide Deck 系统

### 14.1 Deck 不是传统 PPT 内核，而是 HTML deck

官方 presentation 教程明确说，Claude Design presentations 是 **interactive HTML rendered in the canvas**，因此它具备超出静态 slide software 的能力，用户可以在对话中实时迭代、看到变化。([Claude][5])

这意味着 Claude Design 的 deck 很可能是：

```text
Deck
├─ slides[]
│  ├─ title
│  ├─ content blocks
│  ├─ visual components
│  ├─ chart components
│  ├─ animation metadata
│  └─ speaker/story structure
└─ theme/design-system tokens
```

而不是一开始就生成 PowerPoint 原生对象。PPTX 只是导出目标之一。

### 14.2 Deck 功能原子

官方列出的 deck 功能包括：

| 功能                      | 说明                                                |
| ----------------------- | ------------------------------------------------- |
| 从 prompt 生成完整 deck      | 用户描述 audience、key messages、organizational context |
| 单页编辑                    | “On slide 3...” 这种引用式修改                           |
| 添加/删除 slides            | 请求新增 slide 或把 section 展开成多页                       |
| 数据可视化                   | 描述数据后生成合适图表                                       |
| 动画叙事                    | HTML 相比 PPT 可做跨 slide storytelling animation      |
| 图片/logo/visual elements | 可要求加入                                             |
| Approved imagery        | 有设计系统资产时自动拉取                                      |
| 导出                      | standalone HTML、PPTX、PDF、ZIP、Canva、Claude Code    |

这些功能都在官方 presentation 教程中列出。([Claude][5])

### 14.3 ~~技术实现推断：Deck compiler~~（已删除，见顶部声明）

---

## 15. 原子层拆解十一：协作与分享

### 15.1 权限层级

Presentation 教程列出的分享权限包括：

| 权限                                                    | 含义          |
| ----------------------------------------------------- | ----------- |
| Private                                               | 私有          |
| Anyone in your organization with the link can view    | 组织内链接可查看    |
| Anyone in your organization with the link can comment | 组织内链接可评论，默认 |
| Anyone in your organization with the link can edit    | 组织内链接可编辑    |

官方还说，多人有权限时，可以在 group chat-style interface 中一起和 agent 对话。([Claude][5])

入门文档也确认，Claude Design 项目可以用组织内 shareable link 分享，权限包括 view-only、comment、edit。([Claude Help Center][2])

### 15.2 ~~技术实现推断：协作不是 Figma 式实时多人编辑~~（已删除，见顶部声明）

> 关键产品事实仍 valid：Claude Design 协作更像"共享 agent 工作区 + 权限 + 评论 + 共同聊天"，不是 Figma 式多人矢量实时编辑。

---

## 16. 原子层拆解十二：导出、Canva 与 Claude Code Handoff

### 16.1 导出目标

官方入门文档列出：

* Download as `.zip`
* Export as PDF
* Export as PPTX
* Send to Canva
* Export as standalone HTML
* Handoff to Claude Code

  * Send to local coding agent
  * Send to Claude Code Web

这些是 Help Center 明确列出的导出选项。([Claude Help Center][2])

Presentation 教程也列出 standalone HTML、PPTX、PDF、ZIP、Send to Canva、Hand off to Claude Code。([Claude][5])

### 16.2 Canva 互操作

Canva 官方新闻稿说，Claude Design 用户可以生成想法和 draft content，然后把它们带入 Canva Visual Suite，变成 fully editable、structured designs。Canva 还提到 HTML importing，支持把 Claude 的 coded creations 直接带入 Canva，用 drag-and-drop editor 编辑颜色、移动元素、更新布局，而不必每次重新生成代码。([canva.com][10])

这说明“Send to Canva”不是简单截图导入，而是把 Claude 的 HTML/artifact 转成 Canva 可编辑结构。Canva 官方把这称为 bringing Canva Design Engine and Visual Suite into Claude Design。([canva.com][10])

**技术推断**：

```text
Claude Design artifact
    ↓
Export/intermediate representation
    ↓
Canva HTML/artifact import
    ↓
Canva Design Model transforms draft into structured editable design
    ↓
Canva editor layers/components
```

### 16.3 Claude Code Handoff

官方 UX 教程说，点击 Export → Hand off to Claude Code 后，默认会打包项目设计文件、chat、README，并给用户一个可粘贴到本地 Claude Code 或其他 coding agent 的 prompt，其中包含 bundle URL；也可以 hand off 到 Claude Code Web。([Claude][8])

这意味着 handoff 包不是单一 HTML 文件，而是一个包含“设计文件 + 对话历史 + README + prompt + URL”的工程交付包。

**技术推断：Handoff bundle 可能长这样：**

```text
handoff-bundle.zip
├─ README.md
├─ prompt.txt
├─ design/
│  ├─ index.html
│  ├─ styles.css
│  ├─ script.js
│  └─ assets/
├─ conversation/
│  └─ chat-history.md
├─ design-decisions.md
├─ edge-cases.md
└─ metadata.json
```

官方还给了 clean handoff 建议：清晰命名 prototype 中的对象；在 chat 中记录设计决策；交付前让 Claude 展示 empty states、error states、loading states 和不同数据量状态。([Claude][8])

这其实是 Claude Design 最有战略价值的地方：它把“设计产物”升级为“实现上下文”。

---

## 17. 原子层拆解十三：用量、计费与资源约束

### 17.1 独立计量

Claude Design 的用量和普通 Claude chat、Claude Code 分开。官方计费文档明确说，Claude Design has its own usage tracking、allowances，并且 subscription plans 下有自己的 weekly limits，不在 existing chat 或 Claude Code limits 里面。([Claude Help Center][11])

个人计划中：

| Plan    | 官方定位                                         |
| ------- | -------------------------------------------- |
| Pro     | Quick explorations, one-off use              |
| Max 5x  | PMs and engineers producing regular mock-ups |
| Max 20x | Designers and creatives power use            |

Team 和 Enterprise 也有 Standard/Premium 不同定位；Enterprise usage-based 按 existing agreement 下的 standard API rates 计费。([Claude Help Center][11])

### 17.2 技术含义

Claude Design 比普通聊天更耗资源，原因大概率包括：

```text
一次 Claude Design 请求 ≈
  long prompt/context
+ design system context
+ uploaded assets summaries
+ current artifact code
+ visual reasoning
+ code generation
+ possible retries/validation
+ canvas render
+ export/handoff processing
```

Opus 4.7 本身也更偏高能力模型。Anthropic 发布稿说 Opus 4.7 在高级软件工程、复杂长任务、视觉分辨率、professional tasks 中更强，并能产生更高质量的 interfaces、slides、docs。([Anthropic][12])

---

## 18. 原子层拆解十四：数据、隐私、治理与企业限制

### 18.1 上传资产持久存储

Admin guide 明确说，团队可能上传 design assets、brand guidelines、screenshots 等材料；uploaded assets 会 persistent storage，并遵循 Anthropic enterprise products 的 data retention and deletion policies。([Claude Help Center][4])

这意味着企业使用时不能把 Claude Design 当成“临时对话窗口”。上传资产会进入持久存储，至少在政策允许的保留期内存在。

### 18.2 暂不支持的治理能力

官方明确写到：

| 限制                 | 说明                      |
| ------------------ | ----------------------- |
| 不支持 audit logs     | Labs release 当前没有       |
| 不支持 usage tracking | 当前没有                    |
| 不支持 data residency | 当前没有                    |
| 仅 Web interface    | 目前只能通过 claude.ai/design |

这些在 Admin guide 中明确列出。([Claude Help Center][4])

### 18.3 企业 rollout 建议

官方建议四阶段 rollout：

1. **Design system setup**：2–4 名可信设计师/设计负责人；
2. **Design team onboarding**：完整设计团队 stress-test；
3. **Product and UX onboarding**：PM、UX researchers、相邻职能；
4. **Broader organization**：全组织或特定部门。

Admin guide 明确建议分阶段 rollout，以先验证设计系统、积累内部经验，再扩大采用。([Claude Help Center][4])

---

## 19. 原子层拆解十五：已知限制与产品成熟度

官方 Help Center 列出的已知限制包括：

| 限制                               | 官方 workaround / 说明                       |
| -------------------------------- | ---------------------------------------- |
| Inline comments 偶尔在 Claude 读取前消失 | 把 comment 文本粘贴到 chat                     |
| Compact layout mode 可能触发保存错误     | 切回 full view 重试                          |
| 大型代码库可能导致 lag 或 browser issues   | 链接 specific subdirectories，不要整仓 monorepo |
| Chat upstream error              | 在同一 project 中开新 chat tab                 |

这些都在入门文档中列出。([Claude Help Center][2])

**产品判断**：Claude Design 当前不是成熟 Figma 替代品，而是一个高潜力的 AI-native visual workspace。它的强项是“从想法到可交互视觉草案/交付包”的速度；弱项是企业审计、使用分析、data residency、大型 repo 性能、评论稳定性和可能的像素级精修能力。

---

## 20. 技术实现深拆：每个关键模块可能怎么做

下面是更接近工程视角的拆解。

---

### 20.1 Web Workspace Layer

#### 官方事实

Claude Design 当前通过 web interface `claude.ai/design` 提供；界面包含 chat 和 canvas。([Claude Help Center][4])

#### 强推断

前端大概率由以下部分组成：

```text
Workspace Shell
├─ Project picker
├─ Chat panel
├─ Canvas panel
├─ Comment overlay
├─ Export menu
├─ Share dialog
├─ Import/context panel
├─ Tweaks/custom control panel
└─ Design system selector/context
```

#### 可能技术

| 子模块             | 可能实现                                           |
| --------------- | ---------------------------------------------- |
| Canvas preview  | iframe sandbox 或隔离 webview                     |
| Comment overlay | DOM coordinate mapping + overlay layer         |
| Direct edits    | contenteditable 或 component-level edit handles |
| Tweaks          | dynamic form generated from parameter schema   |
| Export          | frontend 调用后端 export jobs                      |
| Share           | org-scoped ACL service                         |

---

### 20.2 Artifact Runtime / Render Sandbox

#### 官方事实

Claude Design presentations 是 interactive HTML rendered in canvas，且可导出 standalone HTML。Claude 的 custom visuals 也用 HTML 构建，HTML/SVG 视觉内容可交互并可继续调整。([Claude][5])

#### 强推断

Claude Design 的 canvas runtime 需要：

```text
Sandbox
├─ HTML render
├─ CSS execution
├─ JS execution
├─ Asset loading
├─ Interaction handling
├─ Error isolation
├─ Security boundary
└─ Serialization for export
```

如果它允许 voice、video、shaders、3D、built-in AI 这类 frontier design，那么 runtime 还可能支持：

```text
Web Audio / media elements
WebGL shaders
Canvas API
Three.js-like 3D rendering
Client-side interaction state
API/mock-AI interaction layer
```

发布稿明确说 frontier design 可以包括 voice、video、shaders、3D、built-in AI。([Anthropic][1])

---

### 20.3 Model Orchestration Layer

#### 官方事实

Claude Design 由 Claude Opus 4.7 驱动。Opus 4.7 在复杂长任务、视觉分辨率、professional tasks、interfaces/slides/docs 质量方面提升；Anthropic 还说它更擅长 instruction following。([Anthropic][1])

#### 强推断

一次 Claude Design 生成请求可能被包装成类似：

```text
System:
  You are Claude Design. Generate a polished visual artifact...
Developer:
  Use the organization's design system...
  Respect export/runtime constraints...
  Use accessible UI...
Context:
  Design system tokens
  Component catalog
  Uploaded assets summary
  Codebase excerpts
  Current artifact code
  User prompt
Task:
  Generate / patch / critique / export / handoff
```

#### 可能需要的内部步骤

```text
1. Classify request:
   ├─ new design
   ├─ local edit
   ├─ global restyle
   ├─ variation
   ├─ accessibility review
   ├─ export
   └─ handoff

2. Retrieve context:
   ├─ design system
   ├─ relevant files
   ├─ current artifact
   └─ comments/direct edits

3. Generate plan:
   ├─ layout
   ├─ components
   ├─ interactions
   ├─ content
   └─ visual style

4. Generate code/artifact.

5. Render and maybe validate.

6. Present to user.
```

---

### 20.4 Context Retrieval / RAG Layer

#### 官方事实

Claude Design 可以添加 screenshots、codebase 等 context；代码库会成为 project context；Claude 可引用具体组件名，例如 “use the ProductCard component”。([Claude Help Center][2])

#### 强推断

这里大概率需要 RAG 或上下文选择。否则代码库、deck、设计文件过大，无法每次全部放入模型。

可能流程：

```text
User prompt: "Use ProductCard and follow settings page layout"
    ↓
Retriever searches:
    ├─ ProductCard component file
    ├─ ProductCard stories/examples
    ├─ settings page layout files
    ├─ theme/tokens
    └─ relevant CSS
    ↓
Prompt assembly
```

#### 可能索引对象

| 对象           | 索引内容                                         |
| ------------ | -------------------------------------------- |
| 代码文件         | path、exports、component names、props、usage     |
| 样式文件         | tokens、class names、CSS variables             |
| 截图           | visual summary、detected UI elements          |
| deck         | slide layout、colors、typography、visual motifs |
| design files | components、layers、tokens                     |
| web capture  | DOM structure、CSS、assets、screenshot          |

---

### 20.5 Design System Registry

#### 官方事实

组织可以有多个 design systems；发布后组织内项目自动使用；design system 可随时间 refine。([Anthropic][1])

#### 强推断

需要一个设计系统 registry：

```text
DesignSystem
├─ id
├─ organization_id
├─ name
├─ status: draft/published
├─ version
├─ tokens
├─ components
├─ layout_patterns
├─ assets
├─ instructions/rules
├─ source_materials
├─ created_by
├─ updated_by
└─ permissions
```

这比普通 prompt 模板强得多，因为它是可发布、可复用、可权限控制的组织资产。

---

### 20.6 Inline Comment Anchoring

#### 官方事实

用户可以点击 canvas 的具体部分添加 inline comment，Claude 会实现对应 targeted change。([Claude Help Center][2])

#### 强推断

实现方式可能有三种，按可能性排序：

| 方式                | 说明                       | 优点        | 难点              |
| ----------------- | ------------------------ | --------- | --------------- |
| DOM anchor        | 给生成元素加 data-node-id      | 精准定位      | 生成代码需带 metadata |
| Coordinate anchor | 保存点击坐标 + screenshot crop | 通用        | 页面变化后容易失效       |
| Component anchor  | 生成时维护组件树                 | 最适合 patch | 需要中间表示          |

最稳的是组合式：

```text
comment = {
  text,
  boundingBox,
  screenshotCrop,
  domPath,
  dataNodeId,
  nearbyText,
  currentStyles
}
```

评论偶尔消失的官方限制说明，这个 comment persistence/dispatch 机制目前还不完全稳定。([Claude Help Center][2])

---

### 20.7 Tweaks / Custom Sliders

#### 官方事实

发布稿明确提到 custom sliders made by Claude，以及 adjustment knobs 可 live tweak spacing、color、layout。([Anthropic][1])

#### 强推断

这是一个“模型生成 UI 控件”的系统，背后可能有 parameter schema：

```json
{
  "controls": [
    {
      "id": "spacing_density",
      "type": "slider",
      "label": "Spacing density",
      "min": 0,
      "max": 100,
      "default": 50,
      "targets": ["--space-scale"]
    },
    {
      "id": "accent_color",
      "type": "color",
      "label": "Accent color",
      "default": "#7C3AED",
      "targets": ["--accent"]
    },
    {
      "id": "layout_variant",
      "type": "segmented_control",
      "options": ["compact", "balanced", "spacious"]
    }
  ]
}
```

然后前端把控件和 artifact 内部 CSS variables / JS state 绑定。用户调整后，如果满意，可以要求 Claude 将变化应用到全局设计。

这很可能是 Claude Design 相比普通 Claude Artifacts 的一个关键差异：它让生成物自带“调参界面”。

---

### 20.8 Export Pipeline

#### 官方事实

支持 ZIP、PDF、PPTX、Canva、standalone HTML、Claude Code handoff。([Claude Help Center][2])

#### 强推断

不同导出格式需要不同后处理：

| 导出格式            | 可能技术                                                     |
| --------------- | -------------------------------------------------------- |
| Standalone HTML | 打包 HTML/CSS/JS/assets                                    |
| ZIP             | 项目文件 + assets + metadata                                 |
| PDF             | Headless browser render + print to PDF                   |
| PPTX            | Slide intermediate representation → PPTX objects         |
| Canva           | HTML/artifact import + Canva Design Model transformation |
| Claude Code     | Bundle + README + chat + prompt + signed URL             |

Canva 官方新闻稿明确说，Claude 的 coded creations 可以直接进入 Canva，并在 Canva drag-and-drop editor 中编辑颜色、移动元素、更新布局，而不用重新生成代码。([canva.com][10])

---

## 21. 与 Artifacts / Custom Visuals 的关系

Claude Design 可以理解为 Artifacts/Custom visuals 的“产品化、组织化、设计工作流化”版本。

| 能力                               | Custom visuals / Artifacts                | Claude Design                                 |
| -------------------------------- | ----------------------------------------- | --------------------------------------------- |
| 生成 HTML/SVG/交互视觉                 | 有                                         | 有，而且更重                                        |
| 画布预览                             | 有                                         | 专门设计的 canvas                                  |
| 持久项目                             | Artifacts 可保存，custom visuals 默认 ephemeral | 项目制                                           |
| 组织 design system                 | 无或弱                                       | 核心                                            |
| Inline comments                  | Claude Design 明确支持                        | 核心                                            |
| Custom sliders                   | Claude Design 明确支持                        | 核心                                            |
| 代码库接入                            | 普通 Claude 也能读代码，但非专门工作流                   | 产品化接入                                         |
| Canva/PPTX/PDF/HTML/Code handoff | 部分可做                                      | 明确导出菜单                                        |
| 企业 rollout/RBAC                  | 普通 Claude 有项目/组织权限                        | Claude Design 有专门能力开关和 design system setup 权限 |

Custom visuals 官方说，它们默认是 ephemeral，只有选择 copy/download/save as artifact 才持久；而 Claude Design 则从一开始就是 project/workspace。([Claude Help Center][6])

---

## 22. Claude Design 的“真实护城河”在哪里

我认为有五层。

### 22.1 第一层：Opus 4.7 的视觉 + 代码能力

Opus 4.7 官方强调更好的高分辨率视觉能力、更强的软件工程和复杂长任务表现，以及更高质量的 interfaces、slides、docs。([Anthropic][12])

Claude Design 依赖的不是单一审美模型，而是一个同时会视觉理解、代码生成、长上下文推理和指令遵循的模型。

### 22.2 第二层：组织级 design system

很多 AI 设计工具会生成“看起来像 AI 的漂亮页面”。Claude Design 试图解决的是：每次生成都符合你公司的颜色、字体、组件和布局模式。官方明确把 design system 放在 rollout 前置位置。([Claude Help Center][4])

### 22.3 第三层：上下文融合

它可以吃截图、deck、文档、代码库、design files、web capture。真正的产品价值来自“在你的上下文里生成”，而不是“凭空生成”。([Claude Help Center][2])

### 22.4 第四层：多模态迭代界面

Chat 负责全局意图，inline comments 负责局部定位，direct edits 负责手动修正，custom sliders 负责参数化调节。这比普通 prompt-to-design 更接近真实设计师工作流。([Claude Help Center][2])

### 22.5 第五层：交付闭环

它不只导出图，还能导出 HTML/PPTX/PDF/Canva，并 handoff 到 Claude Code。尤其 Claude Code handoff 会带上 design files、chat、README 和 prompt，这让设计意图进入工程实现链路。([Claude][8])

---

## 23. 如果要复刻 Claude Design，需要哪些基础设施

下面是“从 0 到 Claude Design-like 产品”的基础设施清单。

### 23.1 必须有的基础设施

| 基础设施                | 为什么必须                                |
| ------------------- | ------------------------------------ |
| 高能力多模态模型            | 要理解截图、设计文件、UI、代码                     |
| 代码生成能力              | 生成 HTML/CSS/JS/交互原型                  |
| 画布渲染沙箱              | 安全运行生成的前端代码                          |
| 项目状态存储              | 保存 artifact、chat、版本、资产               |
| 文件/资产存储             | 保存截图、logo、deck、design files          |
| 上下文解析 pipeline      | 提取文档、deck、代码、图片信息                    |
| 设计系统抽取器             | 抽 tokens、components、layout patterns  |
| 设计系统 registry       | 发布、版本、权限、多系统                         |
| Chat orchestrator   | 将用户意图、上下文、当前 artifact 组装进模型          |
| Patch engine        | 支持局部修改，不每次完全重写                       |
| Comment anchoring   | 把画布评论绑定到元素                           |
| Export workers      | PDF/PPTX/HTML/ZIP/Canva/Code handoff |
| Quota/metering      | 设计生成成本高，必须独立计量                       |
| Org/RBAC            | 企业开关、角色和设计系统权限                       |
| Collaboration layer | 分享、评论、多人 group chat                  |
| Compliance policy   | 数据保留、删除、审计、地域要求                      |

### 23.2 有了会明显更强的基础设施

| 基础设施                          | 增强点                              |
| ----------------------------- | -------------------------------- |
| AST/component parser          | 更准确理解代码库组件                       |
| Storybook/Figma importer      | 更准确抽组件和 variants                 |
| Design token compiler         | 保持品牌一致性                          |
| Visual diff evaluator         | 检查改动前后差异                         |
| Accessibility checker         | 自动 contrast、ARIA、键盘导航检查          |
| Responsiveness simulator      | 自动 mobile/tablet/desktop 检查      |
| Multi-candidate ranking       | 多方案生成后自动筛选                       |
| Screenshot-to-DOM alignment   | inline comment 更稳定               |
| Artifact error recovery       | JS/runtime 错误自动修复                |
| Export fidelity checker       | PPTX/PDF 导出后自动比对                 |
| Engineering handoff evaluator | 检查是否有 empty/error/loading states |

---

## 24. Claude Design 可能的内部数据模型

这是我基于功能反推的弱到强推断混合模型。

```ts
type ClaudeDesignProject = {
  id: string
  orgId: string
  ownerId: string
  title: string
  designSystemId?: string
  designSystemVersion?: string
  artifacts: Artifact[]
  chats: ChatThread[]
  comments: CanvasComment[]
  assets: Asset[]
  linkedCodeContexts: CodeContext[]
  snapshots: ProjectSnapshot[]
  permissions: PermissionSet
  exportJobs: ExportJob[]
  createdAt: string
  updatedAt: string
}

type Artifact = {
  id: string
  type: "prototype" | "deck" | "landing_page" | "microsite" | "one_pager"
  sourceFiles: SourceFile[]
  renderedState: unknown
  metadata: {
    pages?: PageSpec[]
    slides?: SlideSpec[]
    componentsUsed?: string[]
    designTokensUsed?: string[]
    interactions?: InteractionSpec[]
  }
}

type DesignSystem = {
  id: string
  orgId: string
  name: string
  status: "draft" | "published"
  version: string
  tokens: DesignTokens
  components: ComponentSpec[]
  layoutPatterns: LayoutPattern[]
  assets: Asset[]
  brandGuidance: string
  sourceMaterials: Asset[]
}
```

官方没有公开这些类型，但这些字段与官方功能一一对应：项目、设计系统、代码库、comments、canvas、export、handoff、权限、版本。([Claude Help Center][2])

---

## 25. Claude Design 的产品范式：不是“生成器”，而是“代理式设计编译器”

我觉得最准确的抽象是：

```text
Claude Design = Design Compiler + Agentic Editor + Context-Aware Renderer
```

它把自然语言和上下文编译成视觉工件：

```text
Prompt + Context + Design System + Codebase
        ↓
Design Intent
        ↓
Intermediate Design Representation
        ↓
HTML / Prototype / Deck / Microsite
        ↓
Canvas Runtime
        ↓
Feedback / Patch / Export / Handoff
```

其中最关键的不是第一稿，而是迭代闭环。

---

## 26. 与现有工具的差异

| 工具               | 核心对象                              | Claude Design 的差异                                                     |
| ---------------- | --------------------------------- | --------------------------------------------------------------------- |
| Figma            | Layer / component / vector design | Claude Design 更自然语言和代码原型导向，不是成熟矢量编辑器                                  |
| Canva            | Editable design document          | Claude Design 从想法和上下文生成，再可送 Canva 深度编辑                                |
| v0 / Lovable     | Web app / frontend code           | Claude Design 更强调组织 design system、deck、one-pager、marketing 和 handoff  |
| Gamma / Tome     | AI deck                           | Claude Design 的 deck 是 HTML interactive canvas，并能 handoff/code/export |
| Claude Artifacts | Chat-generated artifact           | Claude Design 是项目化、组织化、设计系统化的 artifact 工作台                            |
| Claude Code      | 工程实现                              | Claude Design 是前置视觉和设计意图生成层                                           |

Canva 官方也在它的新闻稿里把 Claude Design → Canva 的关系说成“AI-generated drafts and ideas in Claude”进入 Canva 后变成 fully editable designs。([canva.com][10])

---

## 27. 当前短板与风险

### 27.1 产品短板

| 短板                   | 影响                   |
| -------------------- | -------------------- |
| Research preview     | 稳定性和能力边界未完全确定        |
| Inline comments 偶发消失 | 团队评审场景有风险            |
| 大 repo 卡顿            | 代码库接入需要严格裁剪          |
| 无 audit logs         | 企业治理不足               |
| 无 usage tracking     | 管理员难量化采用情况           |
| 不支持 data residency   | 对强合规行业不友好            |
| Web-only             | 桌面/云平台/Office 内集成仍受限 |
| 可能不是像素级生产设计工具        | 不能按 Figma 成熟度期待      |

官方已知限制和企业治理限制支持上述判断。([Claude Help Center][2])

### 27.2 技术风险

| 风险       | 原因                             |
| -------- | ------------------------------ |
| 上下文漂移    | 长对话 + 多资产 + 多版本会让模型遗忘或误用约束     |
| 品牌一致性不足  | design system 抽取不准或未验证         |
| 代码库误解    | 组件 props、样式、状态管理理解不完整          |
| 导出失真     | HTML → PPTX/PDF/Canva 转换可能丢布局  |
| 交互原型过度拟真 | Stakeholder 可能误以为可直接上线         |
| 成本不可控    | Opus 4.7 + 长上下文 + 多轮生成很耗额度     |
| 评论定位失效   | DOM/坐标变化会让 inline comment 锚点过期 |
| 安全边界     | 生成可执行 HTML/JS 必须沙箱隔离           |

---

## 28. 对你做 workflow / skill / agent 产品的启发

如果你想借鉴 Claude Design，不要只学“Prompt 生成 UI”。真正值得学的是这套结构：

```text
1. Context substrate
   先把品牌、代码、文档、资产沉淀为结构化上下文。

2. Design system as first-class object
   不要把风格写在长 prompt 里；把它做成可发布、可版本化、可权限控制的资产。

3. Canvas artifact runtime
   生成物必须可运行、可交互、可保存、可导出。

4. Multi-surface editing
   Chat 处理全局，comment 处理局部，direct edit 处理文字，slider 处理连续参数。

5. Branch and compare
   不要一次给一个答案；让用户比较多个方向。

6. Handoff bundle
   交付的不只是文件，而是设计意图、决策记录、上下文和实现提示。

7. Governance from day one
   企业场景需要 RBAC、配额、审计、数据政策、资产持久化策略。
```

Claude Design 的范式可以概括成：

```text
Design System substrate
    + Project context ingestion
    + Agentic canvas generation
    + Localized critique/editing
    + Parameterized controls
    + Export/handoff bundle
```

这比传统“让模型写一个更长 plan，然后一次性生成”先进得多。

---

## 29. 最终判断

Claude Design 的核心创新不是“Claude 会设计”，而是 **Anthropic 把视觉创作流程拆成了可被 agent 操作的基础设施**：

1. **设计系统基础设施**：让品牌和组件成为默认上下文；
2. **上下文基础设施**：让截图、代码库、deck、文档、web capture 进入项目；
3. **画布基础设施**：让输出成为可运行、可评论、可导出的 HTML/交互工件；
4. **迭代基础设施**：让 chat、inline comments、direct edits、custom sliders 共同作用；
5. **交付基础设施**：让 Canva、PPTX、PDF、HTML、Claude Code 形成出口；
6. **组织基础设施**：让 RBAC、rollout、权限、计量、持久存储进入企业流程。

它现在还不是成熟 Figma 替代品，但它很可能代表了下一代 AI 设计工具的方向：**不是做一个更聪明的画布，而是做一个能理解上下文、品牌、组件和工程约束的设计代理系统。**

[1]: https://www.anthropic.com/news/claude-design-anthropic-labs "Introducing Claude Design by Anthropic Labs \ Anthropic"
[2]: https://support.claude.com/en/articles/14604416-get-started-with-claude-design "Get started with Claude Design | Claude Help Center"
[3]: https://techcrunch.com/2026/04/17/anthropic-launches-claude-design-a-new-product-for-creating-quick-visuals/ "Anthropic launches Claude Design, a new product for creating quick visuals | TechCrunch"
[4]: https://support.claude.com/en/articles/14604406-claude-design-admin-guide-for-team-and-enterprise-plans "Claude Design admin guide for Team and Enterprise plans | Claude Help Center"
[5]: https://claude.com/resources/tutorials/using-claude-design-for-presentations-and-slide-decks "Using Claude Design for presentations and slide decks | Claude"
[6]: https://support.claude.com/en/articles/13979539-custom-visuals-in-chat-and-cowork "Custom visuals in chat and Cowork | Claude Help Center"
[7]: https://support.claude.com/en/articles/9002504-can-claude-produce-images "Can Claude produce images? | Claude Help Center"
[8]: https://claude.com/resources/tutorials/using-claude-design-for-prototypes-and-ux "Using Claude Design for prototypes and UX | Claude"
[9]: https://support.claude.com/en/articles/14604397-set-up-your-design-system-in-claude-design "Set up your design system in Claude Design | Claude Help Center"
[10]: https://www.canva.com/newsroom/news/canva-claude-design/ "Introducing Canva in Claude Design by Anthropic Labs"
[11]: https://support.claude.com/en/articles/14667344-claude-design-subscription-usage-and-pricing "Claude Design subscription usage and pricing | Claude Help Center"
[12]: https://www.anthropic.com/news/claude-opus-4-7 "Introducing Claude Opus 4.7 \ Anthropic"
