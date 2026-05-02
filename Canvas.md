# Canvas — NoDesign 协作画板

> v0.6 / 2026-05-02 — C1 → C6 重构后版本
>
> Canvas 不只是"deck 渲染窗"——它是**用户 + agent 共同操作**的可参数化
> artifact 工作面：用户在画布上看、点、改；agent 通过 MCP 工具看、查、改、
> 暴露可调参数。两边的动作互相可见，闭环。

---

## 1. 是什么 · 为什么

**它是什么**：一个 iframe + 一组浮卡 + 一套 MCP 工具，让 agent 写 HTML 这个
"原本静态的设计稿"变成**可微调、可反馈、可参数化**的 artifact。

**对照 Claude Design 的核心定位**：

| Claude Design 关键能力 | Canvas 落地 |
|---|---|
| Inline comments（贴元素的评论） | InspectFloatingCard 内嵌 textarea + 评论自动绑 anchor |
| Direct edits（直接改文本） | 双击 contenteditable + 自动落盘 |
| Custom sliders（参数化控制台） | TweaksPanel 按 agent expose 的 schema 渲染 |
| Inspector（元素人话视图） | InspectFloatingCard 选中即弹 + 元素角色/样式/可调维度 |
| Iteration loop（chat / comment / edit / slider 共同作用） | 全部进 pending-changes buffer，下个 turn agent 主动拉 |

**一句话定位**：**Canvas = artifact viewer + 可编辑面 + agent 操作面**，不是单
向 preview。

---

## 2. 架构

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (web/)                                                  │
│  ┌─────────┐    ┌──────────────────────────────────────────────┐ │
│  │  Chat   │    │  Canvas Section (CanvasFrame)                │ │
│  │  Panel  │    │  ┌───────────────────────────────────────┐   │ │
│  │ (固定栏)│    │  │  Toolbar: Mode / Zoom / A11y / System / Reload  │ │
│  │         │    │  ├───────────────────────────────────────┤   │ │
│  │         │    │  │  Slide Navigator                       │   │ │
│  │         │    │  ├───────────────────────────────────────┤   │ │
│  │         │    │  │   ┌─────────┐  ┌──────────┐           │   │ │
│  │         │    │  │   │ HtmlIframe (deck render)│  ← EditOverlay │ │
│  │         │    │  │   │ + DirectEditBridge      │  + Inspect Floating│ │
│  │         │    │  │   └─────────┘  Card (贴选中元素) │           │ │
│  │         │    │  │   ↑ user 双击改字 / 单击选中    │           │ │
│  │         │    │  └───────────────────────────────────────┘   │ │
│  │         │    │   ┌──────────┐                                │ │
│  │         │    │   │ Tweaks 浮窗 (agent expose 后激活)│        │ │
│  │         │    │   └──────────┘                                │ │
│  └────┬────┘    └──────────────────────────────────────────────┘ │
│       │ POST /turn                                               │
│       └────────────────┐                                         │
│                        ▼                                         │
└────────────────────────┼─────────────────────────────────────────┘
                         │
                         │ WebSocket /ws/projects/:pid (双向)
                         │
┌────────────────────────┼─────────────────────────────────────────┐
│  Server (server/)      ▼                                         │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │  Express + WebSocket + EventBus                              ││
│  │  ┌─────────────────┐  ┌──────────────────────────────────┐  ││
│  │  │ HTTP API        │  │ Agent Loop (Claude Agent SDK)    │  ││
│  │  │ - /canvas       │  │ ┌──────────────────────────────┐ │  ││
│  │  │ - /spec         │  │ │ MCP nodesign server (in-proc)│ │  ││
│  │  │ - /pending-     │  │ │ - screenshot_canvas          │ │  ││
│  │  │   changes       │  │ │ - list_pages                 │ │  ││
│  │  │ - /turn         │  │ │ - query_elements             │ │  ││
│  │  └─────────────────┘  │ │ - get_computed_styles        │ │  ││
│  │         │             │ │ - navigate_to_page  ─────────┐│  ││
│  │         │             │ │ - highlight         ─────────┤│  ││
│  │         │             │ │ - expose_tweaks     ─────────┤│  ││
│  │         │             │ │ - get/clear_pending_changes  ││  ││
│  │         │             │ │ - record_decision            ││  ││
│  │         │             │ │ - export_handoff             ││  ││
│  │         │             │ │ - read_page / web_search     ││  ││
│  │         │             │ └──────────────────────────────┘│  ││
│  │         ▼             │ ▲    ▲                          │  ││
│  │  workspace/sessions/  │ │    │                          │  ││
│  │  └ canvas.html        │ │    │ ctx.emit (反向通道)      │  ││
│  │  └ spec.json          │ │    └──────────────────────────┘  ││
│  │  └ pending-changes.json│ │    │                              ││
│  │                       │ │    └──→ EventBus → ws → 前端 ←───┘│
│  └──────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
```

**核心信道**：
- 用户 → server：HTTP（PUT canvas / POST pending-changes / POST turn）
- server → agent：in-process MCP server（同进程函数调用，无 IPC）
- agent → server：MCP tool handler 直接读写文件 + emit EventBus 事件
- server → 用户：WebSocket（订阅 `*`，所有事件实时推前端）

---

## 3. 用户视角能做什么

### 3.1 在 iframe 内直接操作

| 操作 | 触发 | 后果 |
|---|---|---|
| 选中元素 | 单击 | 弹 InspectFloatingCard 贴在元素右上角 |
| 关闭浮卡 | ESC / 点空白 / 切元素 | 浮卡收起 |
| 改文本 | 双击文本元素 | contenteditable + 全选 → 输入 → blur 自动 PUT canvas + push pending buffer |
| 撤销改字 | 编辑中按 ESC | 文本 revert，不落盘 |
| 跨页跳转 | 点 Slide Navigator 页码 | iframe scrollIntoView 该 section |

### 3.2 InspectFloatingCard 三段

```
┌──────────────────────────────────────┐
│ <h1> 第 1 页 · 一级标题      [X]     │  ← Header (tag / role / 页号 / 关闭)
├──────────────────────────────────────┤
│ ◑ 评论 (2)                           │
│  · "字号再大一点" [✓][🗑]              │  ← Comments thread
│  · "颜色换成蓝色" [✓][🗑]              │
│  ┌──────────────────────────────┐    │
│  │ 评论这个元素，让 AI 看看…    │    │  ← Inline textarea
│  │ (Enter 提交, Shift+Enter 换行)│   │
│  └──────────────────────────────┘    │
├──────────────────────────────────────┤
│ ◐ 当前样式                           │
│  颜色  rgb(45,36,24)   ▢            │
│  字号  56px                         │
│  ...                                 │
│ ⚙ 可调维度                           │
│  [颜色] [字号] [字重] ...           │
│ ◎ 改动范围                           │
│  ◉ 仅这一处  ○ 同类(页内)  ...      │
│  [直接改属性]                        │
│  [触发新 run（改设计意图）]          │
└──────────────────────────────────────┘
```

### 3.3 Canvas Toolbar

| 按钮 | 功能 |
|---|---|
| Edit / Preview / Code | mode 切换（Code = Monaco 直编辑） |
| Fit / − % + | 自适应 / 手动 zoom |
| A11y | popover：启发式扫描（alt / 标题层级 / lang / 对比度） |
| Settings (System) | popover：Skill / DS / Model / Spec 摘要 + 折叠"项目档案"(Decisions + History) |
| Reload | iframe 重 fetch（清选中） |

### 3.4 Tweaks 浮窗（agent 暴露后激活）

```
┌─────────────────────────────────────┐
│ ⋯ Tweaks                       [X]  │
├─────────────────────────────────────┤
│ 可调参数 (5)                         │
│                                     │
│ Hero 字号                  56px     │
│ ▬▬▬▬▬◯─────────                     │
│                                     │
│ 主色                       #2d2418  │
│ ▣                                   │
│                                     │
│ 排版密度                            │
│ [紧凑] [均衡] [舒展]               │
│                                     │
│ 暗色模式                  [○━━●]   │
│                                     │
├─────────────────────────────────────┤
│ [↺ Reset]              [✓ Apply]   │
└─────────────────────────────────────┘
```

- 拖任何控件 → iframe `:root` CSS variable 实时改 → 不落盘（轻预览）
- **Reset** = 控件回 default + 清所有 inline style
- **Apply** = 发 chat 让 agent 把当前数值固化进 canvas.html 的 `:root`

### 3.5 多候选 tab

session 内 N 个 deck 候选切换 / 重命名 / 删；agent 真生成时各 candidate 独立。

---

## 4. Agent 视角能做什么（MCP 工具）

agent 端工具名都加前缀 `mcp__nodesign__<tool>`。13 个工具按用途分组：

### 感知（看 deck）

| 工具 | 输入 | 用途 |
|---|---|---|
| `screenshot_canvas` | viewport? / fullPage? / selector? / pageIndex? | playwright 截图，回 image content block 让 agent vision 看 |
| `list_pages` | （无） | 全 deck 摘要：每页 index / layout / anchor / 标题 / bbox |
| `read_page` | page (1-based) | 拿某页完整 outerHTML |
| `query_elements` | selector / page? | CSS selector 找一组元素 → anchor + bbox + text + dataAttrs |
| `get_computed_styles` | selector / props? / page? | 真渲染后的 CSS 值（不是源码 raw 值） |

### 控制（操作 canvas / 写档案）

| 工具 | 输入 | 用途 |
|---|---|---|
| `navigate_to_page` | index | emit 反向事件 → 前端切到第 N 页 |
| `highlight` | selector / durationMs? | emit → 前端 pulse 元素 1.5s |
| `expose_tweaks` | controls[] / replace? | 写 spec.tweaks → 前端 TweaksPanel reload schema |
| `record_decision` | title / rationale / scope? / alternatives? | 沉淀设计决策到 spec.decisions[] |

### 反馈（拿用户行为）

| 工具 | 输入 | 用途 |
|---|---|---|
| `get_pending_changes` | （无） | 拉用户在 chat 间隔做的直接编辑 + 评论 buffer |
| `clear_pending_changes` | ids? | 清 buffer（处理完必调） |

### 其他

| 工具 | 用途 |
|---|---|
| `web_search` | 4 provider 联网搜（baidu/tavily/exa/zhipu，CJK 自动 baidu） |
| `export_handoff` | 打包 zip 交付 |
| `ping` | 通路验证 |

### SDK 内置（agent 默认有）

`Read` / `Edit` / `Write` / `Bash`（受 sandbox） / `Glob` / `Grep` / `WebFetch` /
`Task`（派 explorer 子代理） / `TodoWrite` / `AskUserQuestion`（弹卡片问用户）

---

## 5. 核心交互链路

### 5.1 用户改字 → agent 看见

```
用户双击 h1 改字
   ↓
DirectEditBridge.handleBlur
   ├→ Canvas.write PUT html (source='user') → git commit per-session
   └→ PendingChanges.push { kind:'edit', anchor, aiContext, diff }
   ↓
[用户继续写评论 / 改字 N 次，buffer 累积]
   ↓
用户发 chat 消息
   ↓
turn.js composeUserMessage 看到 buffer 非空
   → prepend "<system>用户在过去时段做了 N 处变更...</system>" block
   ↓
agent 看到 system 提示
   → 主动调 mcp__nodesign__get_pending_changes
   → 区分 edit (done deal 别 revert) vs comment (修改请求 → 用 Edit 工具改)
   → 处理完调 clear_pending_changes
   → 收尾时总结处理了什么
```

### 5.2 用户调参数 → agent 固化

```
agent 写完 deck → 调 mcp__nodesign__expose_tweaks
   → spec.tweaks.controls[] 写入 spec.json
   → emit run.tweaks_exposed
   ↓
前端 ProjectWorkspace ws 收到 → bump tweaksReloadKey
   ↓
TweaksPanel 重 fetch spec → 按 schema 渲染 5 种控件
   ↓
用户拖 slider → setProperty('--hero-size', '64px') → iframe 实时变
   ↓
满意了点 [Apply]
   → handleSend chat: "把当前 tweaks 数值固化到 :root: --hero-size=64px ..."
   ↓
agent 用 Edit 工具改 canvas.html 的 :root 块 → 重新 expose_tweaks 更新 default
```

### 5.3 agent 反向操作 canvas

```
用户 chat: "第 2 页那个 hero 怎么改"
   ↓
agent 调 mcp__nodesign__navigate_to_page(2)
   → emit run.canvas_navigate
   → 前端 iframe scrollIntoView section[data-page="2"]
   ↓
agent 调 mcp__nodesign__highlight('section[data-page="2"] h1.hero')
   → emit run.canvas_highlight
   → 前端 pulse 黄色 outline 1.5s
   ↓
[用户视觉锚定，开始 chat 讨论改法]
```

---

## 6. 数据模型

### 6.1 文件落盘（per-session）

```
workspace/<projectId>/sessions/<sessionId>/
├── canvas.html           # 主产物（agent + 用户 共写）
├── spec.json             # 设计意图档案 + decisions[] + history[] + tweaks
├── pending-changes.json  # 用户在 chat 间隔的 edit + comment buffer
└── .git/                 # per-session 版本历史（commit msg = "user-edit: ts" / "agent-edit: ts"）
```

### 6.2 spec.json schema

```js
{
  meta: { metaphor, audience, intent },        // 设计意图
  outline: [{ id, index, layout, intent }],    // 页面规划
  decisions: [{ ts, title, rationale, scope?, alternatives? }],  // 关键决策
  history: [{ ts, source, summary, trigger? }],                  // compact 摘要
  tweaks: {                                                       // 可调参数 schema
    version: 1,
    updatedAt, updatedBy: 'agent',
    controls: [{
      id, type: 'slider'|'color'|'segmented'|'toggle'|'select',
      label, description?,
      target_var?: '--xxx', target_class_on?,
      min?, max?, step?, default, unit?,
      options?: [{ label, value }],
    }]
  }
}
```

### 6.3 pending-changes.json schema

```js
{
  items: [
    {
      id: uuid,
      kind: 'edit' | 'comment',
      anchor: { dataId, path, textHint, bbox },     // 元素稳定锚点
      aiContext: { tag, role, pageInfo, outerHtml, computed, siblings },
      diff?: { oldText, newText },     // edit 才有
      text?: string,                   // comment 才有
      ts: ISO8601,
    }
  ]
}
```

### 6.4 元素 anchor schema（跨 patch 稳定查找）

```js
{
  dataId: string | null,    // data-node-id 属性（最可靠，agent 写时埋）
  path: string,             // tag:nth-of-type 链（结构稳）
  textHint: string,         // 前 50 字（fuzzy 兜底）
  bbox: { x, y, w, h },     // 选中那刻的位置
}
```

`findElementByAnchor` 三层 fallback：dataId → path → textHint。

### 6.5 HTML 规范（SKILL.md 约束 agent）

- `<section data-page="N" data-layout="cover|content|...">` 分页，视口 1280×720
- 关键元素加 `data-anchor="cover-title"` / `data-tweakable='{"--accent":"any"}'`
- 可调维度走 `:root { --xxx: ... }` CSS variables（让 expose_tweaks 能用 `target_var` 改）

---

## 7. 文件结构

### 前端 (`web/src/components/canvas/`)

| 文件 | 用途 |
|---|---|
| `CanvasFrame.jsx` | 总壳：toolbar + iframe + overlay + popover + InspectFloatingCard |
| `CanvasToolbar.jsx` | Mode / Zoom / A11y / System / Reload 按钮条 |
| `HtmlIframe.jsx` | iframe + zoom 适配（width/height 100/zoom% + transform: scale）|
| `EditOverlay.jsx` | 选中元素的高亮边框（实时 bbox + zoom 适配） |
| `InspectFloatingCard.jsx` | 选中元素的 contextual 浮卡（header + Comments + 元素详情） |
| `DirectEditBridge.js` | iframe 内挂 dblclick / click / blur listeners |
| `SystemPopover.jsx` | Settings 按钮的 popover（Skill/DS/Model + Decisions accordion） |
| `A11yReviewPopover.jsx` | A11y 按钮的启发式扫描 popover |
| `SlideNavigator.jsx` | 扫 `section[data-page]` 渲染页码 tab |
| `CanvasCandidateBar.jsx` | 多候选 tab 条 |
| `CodeCanvas.jsx` | Code mode 下的 Monaco editor |

### 前端复用

- `web/src/components/context-panel/InspectTab.jsx` — InspectFloatingCard 内嵌（compact 模式）
- `web/src/components/context-panel/SystemTab.jsx` — SystemPopover 内嵌
- `web/src/components/context-panel/DecisionsTab.jsx` — SystemPopover 折叠 section 内嵌
- `web/src/components/context-panel/TweaksPanel.jsx` — Tweaks 浮窗内容（schema 驱动）

### 后端 (`server/`)

| 文件 | 用途 |
|---|---|
| `api/canvas.js` | `PUT/GET/.../canvas` + history + revert + undo |
| `api/pending-changes.js` | `POST/GET/DELETE` buffer endpoints + `readPendingSummary` helper |
| `api/turn.js` | `POST /turn` — 拼 SDK content blocks + 注入 pending system 提示 |
| `engine/mcp/index.js` | MCP server 注册 13 个工具 |
| `engine/mcp/tools/*.js` | 各工具 handler（一文件一工具） |
| `engine/agent/events.js` | EventBus 事件构造器 |
| `engine/agent/loop.js` | Agent 主 loop（SDK query 包装 + ctx + bus + hooks 注入） |
| `engine/skills/deskskill-engine-mini/SKILL.md` | agent 收到的 deck 业务规约 |

---

## 8. 怎么扩展

### 8.1 加一个新 MCP 工具

1. 在 `server/engine/mcp/tools/` 新建 `your-tool.js`，参考 `record-decision.js` 三参 pattern：
   ```js
   import { tool } from '@anthropic-ai/claude-agent-sdk';
   import { z } from 'zod';
   export function makeYourTool({ workspaceRoot, ctx }) {
     return tool('your_tool', '描述给 agent 看', { /* zod schema */ },
       async (input) => {
         // 业务逻辑 + 可选 ctx.emit({...})
         return { content: [{ type: 'text', text: '...' }] };
       });
   }
   ```
2. 在 `server/engine/mcp/index.js` import + tools[] 注册
3. 如果 emit 反向事件，在 `server/engine/agent/events.js` 加事件构造器
4. 如果前端要消费事件，在 `ProjectWorkspace.jsx` ws onmessage 加 case
5. SKILL.md 加触发时机（让 agent 知道何时调）

### 8.2 加一个新 Tweaks control type

1. `expose_tweaks` zod schema 的 type enum 加新值（`expose-tweaks.js`）
2. `TweaksPanel.jsx` `renderControl` switch 加 case
3. SKILL.md 「Tweaks 暴露协议」5 种 control 表加新行

### 8.3 加一个新 toolbar 按钮 / popover

1. `CanvasToolbar.jsx` 加按钮 + ref + onClick prop
2. 新建 `XxxPopover.jsx`（参考 `A11yReviewPopover.jsx` / `SystemPopover.jsx` 的
   `position:absolute top:78 right:16` + click-outside + ESC 关 pattern）
3. `CanvasFrame.jsx` 加 state + 跟其他 popover 互斥（同侧 right:16 不抢位）

### 8.4 加一个新文件类型 buffer（类似 pending-changes）

1. `server/api/your-buffer.js` 模仿 `pending-changes.js` 写 POST/GET/DELETE
2. `server/index.js` mount router
3. `web/src/lib/api.js` 加 client
4. 如果要让 agent 主动拉，加对应 MCP 工具 `get_xxx`

---

## 9. 关键设计决策

### 9.1 为什么是 in-process MCP server，不是 stdio / HTTP

agent 跑在 Node 进程，工具直接调 fs / playwright，没有跨进程开销。SDK 的
`createSdkMcpServer` 把工具集合作为同进程函数注入，handler 在闭包里拿到
`workspaceRoot` / `ctx` — 每个 turn 一个新 server 实例避免 cross-talk。

### 9.2 为什么 buffer 在后端不在前端

agent 跑在 server，工具直接读 `sessions/<sid>/pending-changes.json` 最简单。
前端刷页 / 换设备 / 多 tab 都不丢；前端只 push 不 cache。

### 9.3 为什么 system 提示不直接灌详情

省 token + 让 agent 决策"要不要细看"。简单 chat（"你好"）不必拉 buffer；真要
处理变更才调 `get_pending_changes`。

### 9.4 为什么 Inspect 不再 floating panel 而是贴元素 contextual 卡

PLAN.md 旧决策："popover / modal / Tweaks 浮窗 / inline comment 气泡 / inspect
popover" 都是浮在 canvas 上，但 Inspect 跟选中元素强耦合 — 用 floating panel 让
用户每次都要找 / 拖位置很反直觉。Figma / Webflow 都是 contextual。

### 9.5 为什么 Tweaks 仍是 floating panel 而非 popover

用户调参时间长会反复拖 + 反复看 deck 实时变 — 浮窗可任意挪位置不挡 deck，比
popover（点空白就关）合适。

### 9.6 为什么 expose_tweaks Apply 必须走 agent 而不是前端直接 PUT canvas

"当前 hero_size = 64 → 写入 :root" 涉及"改 default 还是改 instance"的判断。让
agent 决定比硬规则灵活：可能 64 是当前页特殊大小，应该写 inline 不改 :root；也
可能是 brand 升级，应该改 :root + 同时 expose_tweaks 把 default 也升到 64。

---

## 10. 演进历史

| 阶段 | 主要变化 |
|---|---|
| ~v0.4 | 单页 floating panel 体系：Inspect / Comments / Decisions / Tweaks / System 五个并列浮窗 |
| v0.5 | canvas 焕新 S1：HTML 加 `data-tweakable` / `data-anchor` 标记规范 + trusted CDN |
| v0.5.5 | session-scoped 改造（H1-H5）：workspace = shared/ + sessions/<sid>/ |
| **v0.6 (本次, C1-C6)** | • C1 8 个新 MCP 工具（感知 + 控制 + 反馈 + Tweaks 暴露）<br>• C2 System 收口为 toolbar popover，吞掉 Decisions<br>• C3 Inspect → contextual 浮卡贴选中元素，Comments 嵌入<br>• C4 用户直接编辑 + 评论进 buffer，agent 主动拉<br>• C5 Tweaks schema 驱动 — agent expose 5 种控件类型<br>• C6 反向通道前端消费（navigate / highlight） |

---

## 11. 待办 / Known issues

- **e2e 验证**：让真 agent 跑一个 turn 验证 SKILL.md 的 "用户直接编辑协议"
  + "Tweaks 暴露协议" 是否被严格执行
- **Playwright 工具性能**：每次 spawn chromium ~1-2s，未来可上 pool（screenshot.js
  注释里已留 P0+ stage 2 计划）
- **InspectTab 重复代码**：compact 模式跳过元素 header 的逻辑跟 InspectFloatingCard
  的 header 重叠，未来可彻底拆 presentational 部分
- **Tweaks Apply 后 agent 必须重新 expose_tweaks**：当前靠 SKILL.md 约束，没有
  hard enforcement — 如果 agent 忘了，前端 default 跟 :root 实际值会脱节

---

## 12. 相关文档

- `Claude_design.md` — 对照 Anthropic 官方 Claude Design 能力清单
- `PLAN.md` — 整体路线图 + 历史决策
- `server/engine/skills/deskskill-engine-mini/SKILL.md` — agent 业务规约（每次跑都注入）
- `~/.claude/plans/robust-prancing-emerson.md` — C1-C6 重构 plan
