# NoDesign

> agent 驱动的可参数化 deck 设计工作台 —— chat 一句 brief，得到一份带专属控制
> 面板的 HTML deck，用户能拖 slider 实时调样式，导出 PDF / PPTX / 工程包。

---

## 这是什么

NoDesign 把"做 deck"从**人手工拼图层**变成**跟 agent 协作 + 可参数化的产品**：

- **agent 写 HTML deck**（单文件 `canvas.html`，`<section data-page="N">` 分页，1280×720 视口）
- **可调维度暴露成 Tweaks 面板**（5-8 个 slider / color picker），用户拖动实时预览
- **跨 session 长期记忆**（项目品牌档案 / 通用偏好），agent 跨 session 续做不忘
- **多种交付**：HTML / PDF（矢量）/ PPTX（位图）/ 工程包（zip 含源 + assets + readme）

跟"普通 LLM 写 HTML 服务"区别：13 个业务 mcp 工具让 agent 真正**有眼睛**（截图自检）、**有 DOM 雷达**（query_elements + computed_styles）、**能感知用户**（pending-changes buffer）。详见 [server/engine/skills/deskskill-engine-mini/SKILL.md](server/engine/skills/deskskill-engine-mini/SKILL.md)。

---

## 快速开始（dev）

```bash
# 1. 装依赖
npm install
cd web && npm install && cd ..
npx playwright install chromium

# 2. 配 .env（敏感值不入 git）
cp .env.example .env
# 编辑 .env 填 NODESIGN_GATEWAY_URL / NODESIGN_GATEWAY_KEY

# 3. 起 dev server
npm run dev          # 后端 :4001（hot reload）
cd web && npm run dev # 前端 :5174（Vite）

# 4. 访问 http://localhost:5174
```

dev 模式 server 自动热重载（`node --watch`）。生产部署看 [DEPLOY.md](DEPLOY.md)。

---

## 主要功能

### Agent 设计协作

- **多轮深度对齐**：默认 2-3 轮 AskUserQuestion（深度对齐 toggle 3-5 轮）含可视 preview HTML 让用户对比方向 / 配色 / 字体
- **streamInput 模式**：一个 query 横跨 session，cancel 不丢上下文，追加消息排队
- **subagent 工作流**：explorer 找参考 / vision-checker 自检视觉，子代理转录不污染主上下文

### Canvas 操作

- **三模式**：edit（双击改字 + 选中评论）/ preview / code（Monaco 直接改 HTML）
- **Tweaks 面板**：agent expose_tweaks 后用户拖 slider 实时预览样式
- **多页导览**：SlideNavigator 自动扫 `<section data-page>` 切页

### 多种导出

| 格式 | 实现 | 适合 |
|---|---|---|
| HTML | 单文件复制 | 网页演示 / 双击打开 |
| PDF | playwright `page.pdf()` | 投屏 / 邮件分享（矢量文字）|
| PPTX | playwright 截图 + pptxgenjs 嵌入 | PowerPoint 编辑 / 传统会议（位图，文字不可编辑）|
| 工程包 | JSZip：HTML + spec.json + assets + README | 设计师二次开发 |

### 跨 session 记忆

- `./.claude/agent-memory/memory.md` — main agent 通用记忆（前端 MemoryCard 读）
- `./.claude/agent-memory/brand/memory.md` — 品牌档案（前端 BrandCard 读）

不跨项目 —— 每个 project 独立 `shared/.claude/agent-memory/` 软链空间。

---

## 架构概览

```
┌────────────────────────────────────────────────────────────────┐
│ 浏览器 (Vite :5174 / nginx :443)                                │
│  ┌─ ChatPanel ──┐ ┌─ CanvasFrame ────────┐ ┌─ Tweaks Panel ──┐│
│  │ chat /        │ │ iframe (canvas.html)  │ │ slider /        ││
│  │ session UI    │ │ + InspectFloating     │ │ color picker    ││
│  │               │ │ + DirectEdit bridge   │ │ (浮窗 toggle)   ││
│  └───────────────┘ └────────────────────────┘ └─────────────────┘│
│         │                  │                          │          │
│         └────── HTTP /api  └── WS /ws ────────────────┘          │
└──────────┬──────────────────────────────────────────────────────┘
           │
┌──────────▼──────────────────────────────────────────────────────┐
│ NoDesign server (:4001, pm2 单实例)                              │
│                                                                   │
│  HTTP API (express) ── projects / sessions / canvas / pending /   │
│                        memory / exports / brand / turn            │
│                                                                   │
│  WS broker ── EventBus per project，stream agent 事件给前端       │
│                                                                   │
│  Engine                                                           │
│   └── session-loop.js ── 每个 active session 一个 long-running    │
│       │                  SDK Query（streamInput 模式）             │
│       │                                                            │
│       ├── Claude Agent SDK ── spawn claude binary subprocess      │
│       │                       SDK 通过 stdio 跟 binary 通信         │
│       │                       binary 通过 ANTHROPIC_BASE_URL        │
│       │                       连 LLM gateway                         │
│       │                                                            │
│       ├── 13 个业务 mcp 工具 (in-process)                          │
│       │   screenshot_canvas / read_page / query_elements /        │
│       │   get_computed_styles / list_pages / navigate / ...        │
│       │                                                            │
│       └── 4 个 subagent (Task fork)                                │
│           explorer / vision-checker / ds-extractor / tweak-proposer│
└──────────┬──────────────────────────────────────────────────────┘
           │
┌──────────▼──────────────────────────────────────────────────────┐
│ Persistent Volume                                                │
│  server/projects-data/<projectId>/                                │
│    ├── shared/                  跨 session 共享                   │
│    │   ├── .claude/agent-memory/  长期 memory                     │
│    │   └── assets/              用户素材 / curl 下载              │
│    └── sessions/<sid>/          per-session 沙盒                  │
│        ├── canvas.html          主产物                             │
│        ├── spec.json            决策日志                           │
│        ├── pending-changes.json buffer                             │
│        ├── exports/             handoff zip / pdf / pptx           │
│        ├── .claude/             SDK jsonl + 软链                   │
│        └── .git                 per-session git history             │
│                                                                    │
│  server/db/nodesign.db        SQLite（projects / runs metadata）  │
└──────────────────────────────────────────────────────────────────┘
```

详细架构 / 设计决策 / 历史交接看 [HANDOVER.md](HANDOVER.md)。

---

## 文档导航

| 文档 | 内容 | 受众 |
|---|---|---|
| **README.md**（本文） | 项目入口 / 速览 | 第一次接触的人 |
| [DEPLOY.md](DEPLOY.md) | 生产部署 SOP（pm2 + nginx + 故障排查） | 运维 / SRE |
| [HANDOVER.md](HANDOVER.md) | 完整交接：产品定位 / 架构决策 / 阶段历史 | 接手开发 / 产品经理 |
| [PLAN.md](PLAN.md) | living document：当前阶段执行清单 | 持续开发 |
| [Canvas.md](Canvas.md) | Canvas 工作面设计：agent + 用户协作模式 | UX / 前端 |
| [server/engine/skills/deskskill-engine-mini/SKILL.md](server/engine/skills/deskskill-engine-mini/SKILL.md) | agent 业务规则（设计师视角的工具触发时机 / paradigm） | agent 行为调优 |
| [server/engine/agent/prompts/nodesign-prelude.md](server/engine/agent/prompts/nodesign-prelude.md) | agent 通用 prelude（NoDesign 共性约束）| agent 行为调优 |

---

## 当前状态

**v0.1.0-mvp** — 内部测试基线（2026-05-03 起）。

主要能力已通：
- streamInput query 跨 turn 连续 + 追加消息
- 13 个 mcp 工具完整接通（视觉感知 / 精准编辑 / 用户互联 / 产物加值 / 研究）
- 4 大类 export（HTML / PDF / PPTX / handoff）
- pm2 生产部署 SOP 落档（[DEPLOY.md](DEPLOY.md)）

已知限制：

- **单实例 only**（in-memory state，多 pm2 instance 会数据错乱），P1 改 Redis pub/sub
- **重启丢活跃 session**：用户在 agent 跑时 `pm2 restart` 会让 query 死，需重发 chat
- **SDK binary 偶发错**：process uncaughtException 守护住 server 不 crash，但用户偶尔看到 ⚠️ toast，刷新即可
- **PPTX 文字不可编辑**（每页位图嵌入），矢量重建工程量大几个数量级，MVP 接受
- **多用户协作未做**：agent-memory / canvas / sessions 都是单用户视角，多用户共编同 deck 的并发是 P1+

---

## 技术栈

- **后端**：Node.js 20+ / Express / WebSocket / better-sqlite3 / @anthropic-ai/claude-agent-sdk
- **前端**：React 19 / Vite 6 / lucide-react / 纯 inline style（无 CSS framework）
- **playwright**：截图 / PDF / PPTX 图片源
- **pptxgenjs**：HTML → PPTX 拼装
- **JSZip**：handoff 工程包

native 依赖：`better-sqlite3`、`playwright` 需要 OS 系统库（Linux `npx playwright install-deps chromium`）。

---

## License

私有项目，不公开发布。

---

> 部署 / 运维问题看 [DEPLOY.md](DEPLOY.md)。
> 开发 / 设计决策看 [HANDOVER.md](HANDOVER.md)。
> 反馈：直接 commit / 提 issue / 内部群。
