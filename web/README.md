# Nodesign Web — P1 前端骨架

Nodesign 工作台前端。三栏布局：chat / canvas / context。

## 当前阶段：P1（前端骨架）

参考 plan：`/Users/edy/.claude/plans/plan-parallel-harbor.md`

## 跑起来

```bash
cd Nodesign/web
npm install
npm run dev      # 起在 5174（避开 dev/ 的 5173）
```

打开 `http://localhost:5174/`。

## P1 验证清单

打开浏览器后逐项确认：

1. ✅ Home 页（`/`）显示 5 个 mock 项目 + 两个入口卡片（自由创作 / 参照模式）
2. ✅ 点项目进入 `/projects/proj-002`（"Nodesign 内部介绍"）三栏页
3. ✅ 三栏布局：左 360px chat / 中 auto canvas / 右 340px context panel
4. ✅ 顶栏：亮黑系 + 项目名 breadcrumb + Share/Export/⋯ 按钮
5. ✅ Canvas iframe 加载 `/mock/deck.html`（5 页 DeskSkill 风格 self-contained HTML）
6. ✅ Canvas Toolbar 三模式切换（Edit / Preview / Code）
7. ✅ **Edit 模式下双击 iframe 内的文字** → 进入 contenteditable，blur 后控制台 log 出 patch
8. ✅ Preview 模式下不能编辑（双击无效）
9. ✅ Code 模式下 Monaco 显示 HTML 源码（只读）
10. ✅ Inputs tab：拖文件 / 点击选文件 / 粘贴 URL（FileReader 本地预览，不发请求）
11. ✅ SystemTab 显示 mock spec 摘要（metaphor / intent / outline 列表）
12. ✅ ChatPanel：mock 6 条对话历史，输消息 + 发送（800ms 后伪 mock 回执）
13. ✅ 视觉跟 dev/ 完全一致（亮黑按钮 / 深棕标题 / cubic-bezier 入退场）
14. ✅ 路由：Home ↔ Project ↔ DesignSystemList 占位 ↔ SkillList 占位 切换流畅

## 目录结构

```
src/
├── main.jsx                    # ReactDOM 入口
├── App.jsx                     # 路由根（react-router-dom 7 createBrowserRouter）
├── routes/
│   ├── Home.jsx
│   ├── Project.jsx             # ★ 三栏组装
│   ├── DesignSystemList.jsx    # 占位
│   └── SkillList.jsx           # 占位
├── components/
│   ├── layout/                 # AppShell / TopBar / ThreeColumnLayout
│   ├── chat/                   # ChatPanel / MessageList / Message / ChatComposer
│   ├── canvas/                 # CanvasFrame / Toolbar / HtmlIframe / EditOverlay / DirectEditBridge / CodeCanvas
│   ├── context-panel/          # ContextPanel / InputsTab / SystemTab
│   └── ui/                     # 12+ 从 dev/src/components/ui copy 来的通用组件
├── lib/
│   ├── theme.js                # ← 从 dev/src/constants/theme.js copy（COLOR / GAP / FONT_SIZE / cubic-bezier）
│   ├── html-utils.js           # serializeAnchor / findElementByAnchor / ensureNodeId
│   └── helpers.js              # newId / formatDate / timeAgo
├── hooks/                      # （P2 加：useEngineRun / useHtmlArtifact / useIframeBridge）
├── stores/globalStore.js       # zustand：toast / canvas mode / selectedAnchor
├── mock/
│   ├── deck-spec.js            # mock DeckSpec
│   └── projects.js             # mock 5 个项目
└── styles/globals.css          # 极小 reset

public/
└── mock/
    └── deck.html               # ★ 5 页 self-contained HTML（DeskSkill 风格）
```

## 设计原则（来自 plan-parallel-harbor）

1. **不污染**：v0.7.5 是参考不是约束
2. **探索 → 反向优化**：Nodesign 反向给 skill 提需求
3. **spec 与 HTML 角色分离**：
   - spec：agent 生成阶段的 commitment device + 上下文记忆，**用户不直接编辑**
   - HTML：产物 + 用户局部交互的修改对象（comment / direct edit / slider / 未来 CAD 都改 HTML）
4. **视觉沿用 DeskSkill**：亮黑 #2d2418 / 深棕 #3a2a18 / F9F8F6 / cubic-bezier(0.25, 1, 0.5, 1)
5. **复用 dev/src**：12+ UI 组件直接搬

## 下一阶段：P2 前端交互层

- inline comment UI（点元素弹气泡 + 评论列表）
- inputs tab 上传后真预览（FileReader 显示截图缩略图）
- Code mode 改 HTML（本地 state，blur 触发 iframe reload）
- tweak slider UI 占位（mock schema）
- 项目 CRUD（localStorage 持久化）

P3 起接后端 WS。
