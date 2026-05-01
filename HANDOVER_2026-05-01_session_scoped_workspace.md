# HANDOVER — NoDesign session-scoped 重构（2026-05-01 H5 收尾）

> 给未来接手的人 / 未来的自己（cold-start 时）。
>
> 本段把 NoDesign 从"P0+ stage 1（项目级共享 canvas）"重构成 "Anthropic Projects 模式
> （Project = workspace dir + .claude/ 配置；Session = 独立沙盒 含 canvas/spec/.git）"。
> **11 个 commit 一天推完**（S1-S4 + H1-H5）。
>
> 上一段总览：`HANDOVER_2026-05-01_phase123.md`（agent 层 SDK 用法精度对齐）+
> `HANDOVER_2026-04-30_stage1.md`（stage 1 SDK 接通基础）。
> 本段 memory：`~/.claude/projects/-Users-edy-Desktop-panel-workplace-Nodesign/memory/nodesign_session_scoped_summary.md`

---

## 1. 一句话定位

NoDesign 现在按 **Anthropic Projects 模式** 工作：

- **Project** = 用户视角的项目（name + description + workspace 目录）
- **Workspace** = `shared/` 共享配置 + `sessions/<sid>/` 独立沙盒
- **Project Hub**（二级页 `/projects/:id`）= 控制台：Memory / Instructions / Files
  cards + sessions list + 新会话 input
- **Project Workspace**（三级页 `/projects/:id/work` 或 `/projects/:id/sessions/:sid`）
  = chat + canvas + context 工作台

之前所有 session 共享同一份 canvas.html → 现在每 session 独立 canvas/spec/.git。

---

## 2. 11 个 commit（按顺序，按主题）

### S 阶段：per-project + .claude/ + sessions（4 commit）

| Commit | 主题 | 关键改动 |
|---|---|---|
| `a871696` S1 | per-project workspace + SDK 自持久化 | persistSession=true / settingSources=['project'] / `<workspace>/.claude/CLAUDE.md`+settings.json 模板 / projects.description 列 / 老 active_session_id 一次性清洗 / per-project CLAUDE_CONFIG_DIR via Options.env |
| `11e0f7e` S2 | sessions API 走 SDK + 前端 hydrate | GET /sessions（listSessions 薄壳）/ GET /sessions/:sid（getSessionMessages）/ withConfigDir mutex 串行化 process.env 切换 / sessionMessagesToDisplay 转换 helper / mount 时拉最新 session 历史填 messages |
| `a87c6ba` S3 | description UI + 项目背景 tab + instruction API | CreateProjectModal 加 description textarea / ProjectCard 显示 description 片段 / ContextPanel "项目背景" tab 编辑 .claude/CLAUDE.md / GET/PUT instruction endpoint |
| `a47f7ac` S4 | SessionListModal + fork/rename/tag/delete + sessionId override | 后端 fork/PATCH/DELETE endpoint / 前端 SessionListModal（modal 列 + actions）/ ChatPanel header session selector / Turn.send 加 sessionId 参数（null=新建 / string=续约） |

### H 阶段：Project Hub + session-scoped canvas（6 commit）

| Commit | 主题 | 关键改动 |
|---|---|---|
| `beb1d0a` H1 | routing 重构 | `/projects/:id` → ProjectHub（新页）/ `/work` + `/sessions/:sid` → ProjectWorkspace（原 Project.jsx 重命名） / URL 驱动 sid（删 currentSessionId state，useParams 取 urlSid）/ run.done 后 navigate replace 真 sid |
| `84071e9` H2 | Hub 两栏布局 | 对齐 Anthropic 参考图：左 1fr（← All projects + name/desc/⋯/钉 + HubInput + sessions list view）+ 右 340px sticky 三 cards 占位 |
| `afe63cc` H3 | **session-scoped workspace 核心改造** | shared/ + sessions/<sid>/ 二级结构 / 5 个软链共享 shared/.claude/{CLAUDE.md, settings.json, skills, agents, agent-memory} / cwd=sessions/<sid>/ + CLAUDE_CONFIG_DIR per-session / additionalDirectories=[shared] / canvas/spec/exports API 全加 sid / forkSessionWorkspace cp -r 含 .git history / removeRootLegacyArtifacts 一次性清老结构 |
| `8c31cff` H4a | Workspace auto-send + ContextPanel 清理 | location.state.initialMessage → mount 后 setTimeout 250ms auto-send（HubInput 链路终点）/ initialMessageSentRef 防双发 / ContextPanel 删 background+inputs tab，默认 inspect / 顺手解决 7 tab 挤压 |
| `19b9873` H4b | Hub 三 cards 真接后端 | InstructionsCard（GET/PUT /instruction，弹 modal 编辑）/ FilesCard（GET/POST/DELETE /assets，文件 grid + 上传删除）/ MemoryCard（新建 GET/PUT/DELETE /memory，每 agentType 一行 + 编辑 modal）/ 修 H3 漏改的 instruction.js / assets.js 路径（指 shared/）|
| `90720f6` H5 | timeline done 时机 + thinking 折叠 + thinking config | groupMessages 重写：assistant 中间 text 进 group + isStreaming 决定 closed + final text 抽出 group / ThinkingMessage > 320 字符折叠 show more / loop.js thinking adaptive→enabled budgetTokens 8192 |

---

## 3. 核心架构（必读）

### 3.1 Workspace 结构（H3 后）

```
<projects-data>/<projectId>/
├── shared/                          ← project 共享（agent 看，跨 session）
│   ├── .claude/
│   │   ├── CLAUDE.md                ← 用户写的项目 instruction
│   │   ├── settings.json            ← 项目级 SDK config
│   │   ├── skills/                  ← 项目级 skills
│   │   ├── agents/                  ← 项目级 subagents
│   │   └── agent-memory/<type>/     ← agent 跨 session 长期记忆
│   ├── assets/                      ← 用户上传文件
│   └── .gitignore
└── sessions/<sid>/                  ← 每 session 独立沙盒
    ├── canvas.html
    ├── spec.json
    ├── .claude/
    │   ├── CLAUDE.md      → softlink → ../../../shared/.claude/CLAUDE.md
    │   ├── settings.json  → softlink → ../../../shared/.claude/settings.json
    │   ├── skills         → softlink
    │   ├── agents         → softlink
    │   ├── agent-memory   → softlink
    │   └── projects/<encoded-cwd>/<sid>.jsonl  ← SDK 转录
    └── .git/                        ← per-session history
```

### 3.2 SDK options（loop.js 关键 fields）

```js
{
  cwd: sessionWorkspaceRoot,          // sessions/<sid>/
  env: {
    ...process.env,
    ANTHROPIC_BASE_URL: NODESIGN_GATEWAY_URL,
    ANTHROPIC_API_KEY:  NODESIGN_GATEWAY_KEY,
    CLAUDE_CONFIG_DIR:  process.env.NODESIGN_CONFIG_DIR
                        || path.join(sessionWorkspaceRoot, '.claude'),
  },
  additionalDirectories: [sharedRoot],  // 让 agent 跨目录 Read shared/assets
  sessionId: <pre-generated-uuid>,      // 新建场景；续约时不传
  resume: <sid>,                        // 续约场景；新建时不传
  persistSession: true,
  settingSources: ['project'],
  thinking: { type: 'enabled', budgetTokens: 8192 },  // adaptive 仅 Opus 4.6+
  sandbox: {
    filesystem: {
      allowWrite: [
        sessionWorkspaceRoot,                        // session 沙盒
        path.join(sharedRoot, '.claude', 'agent-memory'),  // 跨 session memory
      ],
      // ... denyWrite/denyRead
    },
  },
}
```

### 3.3 路由 + URL（H1 后）

```
/                              Home
/projects/:id                  ProjectHub  ← 二级控制台
/projects/:id/work             ProjectWorkspace（无 sid，新会话）
/projects/:id/sessions/:sid    ProjectWorkspace（带 sid，恢复）
```

URL = sid 唯一 source of truth。切 session 走 navigate（不 setState）。
run.done 时 /work → navigate replace `/sessions/<sid>`（SDK 建好真 sid 后）。

### 3.4 关键 helpers / 文件

**workspace.js**（重写）：
- `getProjectWorkspace(pid)` / `getSharedDir(pid)` / `getSessionWorkspace(pid, sid)`
- `ensureProjectWorkspace(pid)` — 启动跑 removeRootLegacyArtifacts + 建 shared/
- `ensureSessionWorkspace(pid, sid)` — 建 sessions/<sid>/ + 5 软链 + git init
- `forkSessionWorkspace(pid, srcSid, newSid)` — fs.cp recursive verbatimSymlinks 跳 .claude/projects（filter）
- `commitWorkspace(pid, sid, msg)` / `listHistory(pid, sid)` / `revertWorkspace(pid, sid, hash)` — 全 per-session
- `removeRootLegacyArtifacts(pid)` — 一次性清老结构

**lib/sdk-session.js**（S2）：
- `withConfigDir(configDir, fn)` — async-mutex-lite 串行化 process.env.CLAUDE_CONFIG_DIR mutation

**前端 routes**：
- `routes/ProjectHub.jsx` — 二级控制台
- `routes/ProjectWorkspace.jsx` — 三级工作台（原 Project.jsx 重命名）

**前端 components/project**：
- `InstructionsCard.jsx` / `FilesCard.jsx` / `MemoryCard.jsx`
- `SessionListModal.jsx`

**前端 lib**：
- `session-to-messages.js` — SDK SessionMessage[] → 前端展示 messages 转换 helper

---

## 4. 用户决策（落库，不要再争论）

| 决策 | 选项 | 推荐选项 |
|---|---|---|
| cwd 策略 | per-session（sessions/<sid>/）vs project root | **per-session**（真物理隔离） |
| 老项目 canvas/spec/.git 迁移 | 自动迁 / 不迁 / 弹窗问 | **删了**（removeRootLegacyArtifacts） |
| forkSession 复制产物 | 是（cp -r 含 .git）/ 否（只 fork JSONL） | **是** |
| URL 形态 | `/work` + `/sessions/:sid` 两套 vs 单一 | **两套**（功能区分清晰） |
| description 必填 | 必填 / 选填 | **选填** |
| Cowork 链接 | 留 / 砍 | **砍** |

---

## 5. 已知 follow-up（按优先级）

### 高优先

1. **Kimi 走 SDK binary 不输出 thinking blocks** — H5 实测：jsonl 只有 text block，
   无 thinking。直接 Anthropic SDK + beta header probe 能拿到 → SDK binary 协议层
   丢失 thinking。详见 memory `feedback_kimi_thinking_blocks.md` 4 条候选路径：
   1. spawnClaudeCodeProcess hook 改 spawn args 注入 ANTHROPIC_DEFAULT_HEADERS
   2. @ts-ignore 强行传 betas: ['interleaved-thinking-2025-05-14']
   3. 换 Claude 4.x 模型（原生支持，不依赖 beta）
   4. 接受 Kimi 不输出 thinking，只对其他模型显示

2. **SKILL.md 教 agent 用 agent-memory** — 当前 agent 不主动写 memory，要补 SKILL.md
   章节告诉 agent 何时 / 如何写 shared/.claude/agent-memory/

3. **agent 真用 shared/assets 验证** — probe brief 让 agent 引用上传的图，确认
   additionalDirectories 真让 agent Read 跨目录

### 中优先

4. **多 user 并发隔离** — process.env.CLAUDE_CONFIG_DIR mutation 用 mutex 串行化，
   生产部署多 user 上要重审（per-request thread-local 之类）

5. **subagent 真调用流接通** — vision-checker / ds-extractor / tweak-proposer 骨架
   就位但 main agent 不主动调，schemas/ 已就位

6. **Hub HubInput 加附件支持** — 当前只能纯文本起首跑，附件靠 Workspace 内 ChatComposer

### 低优先

7. **rewindFiles per-query 接通上层 endpoint** — query handle 已暴露
8. **canUseTool 接 UI 权限弹窗**
9. **forkSession 选 upToMessageId** — 当前完整复制，未来 chat message 级"从这 fork"
10. **Docker 沙盒 per project**（多 user 公测前）

---

## 6. 验证要怎么跑（cold-start 复测）

### 后端启动

```bash
cd /Users/edy/Desktop/panel-workplace/Nodesign
npm run dev
# 预期 console:
# [engine/runs] SQLite ready ...
# [server] listening on :4001
# 老 project 第一次访问时：[workspace] removed legacy root artifacts for <pid>
```

### 前端启动

dev server 由 Claude Preview launch.json 管，跑 `npm run dev` in `web/`，端口 5174。

### 完整链路验证

```bash
# 1. 创建 project
curl -X POST http://localhost:4001/api/projects \
  -H 'content-type: application/json' \
  -d '{"name":"verify","description":"smoke"}'

# 2. workspace 结构（应只有 shared/）
ls server/projects-data/<pid>/

# 3. 浏览器进 /projects/<pid> → ProjectHub
# 4. Hub input 输 "做一个 hello world deck" → Enter → 跳 /work
# 5. agent 跑 → run.done → navigate replace /sessions/<sid>
# 6. 检查：
ls server/projects-data/<pid>/sessions/<sid>/
# 预期: canvas.html  spec.json  .claude  .git
ls -la server/projects-data/<pid>/sessions/<sid>/.claude/
# 预期: 5 个软链 + projects/ 实目录

# 7. listSessions API
curl http://localhost:4001/api/projects/<pid>/sessions
# 预期: 1 session 含 cwd=sessions/<sid>/

# 8. fork session
curl -X POST http://localhost:4001/api/projects/<pid>/sessions/<sid>/fork \
  -H 'content-type: application/json' -d '{}'
# 预期: 新 sid 返回，sessions/<newSid>/ 含复制产物 + 新 jsonl

# 9. Hub 三 cards
# 浏览器：Memory / Instructions / Files 各自显示真数据
# Instructions 点铅笔编辑 .claude/CLAUDE.md
# Files 点 + 上传文件

# 10. timeline 视觉
# 跑 chat 时观察：thinking + tool + 中间 text 在同一 group，run done 后
# group close 显示 done，final text 在 group 外
```

---

## 7. 心智模型（cold-start 容易迷路的地方）

### 7.1 cwd vs CLAUDE_CONFIG_DIR 别混淆

- **cwd** = agent 工作目录（agent Read/Write/Edit 默认相对路径解析）
  - H3 后是 `sessions/<sid>/`
- **CLAUDE_CONFIG_DIR** = SDK 写 JSONL / 读 settings 的 base 目录
  - H3 后是 `sessions/<sid>/.claude/`
  - SDK 实际 JSONL 路径：`<CLAUDE_CONFIG_DIR>/projects/<encoded(cwd)>/<sid>.jsonl`
  - encoded = `cwd.replace(/[^a-zA-Z0-9]/g, '-')`（grep sdk.mjs 验证）

### 7.2 listSessions dir 不扫子树

SDK listSessions({ dir: cwd }) 只列那个 cwd 对应的 jsonl。父目录 dir 不扫子目录。
所以 sessions.js list endpoint **自实现**：readdir sessions/ 后 per-sid getSessionInfo。

### 7.3 forkSession 把新 jsonl 写到 src cwd

调 SDK forkSession({ dir: srcSessionRoot }) 时 SDK 把新 sid 的 jsonl 写到
`<srcSessionRoot>/.claude/projects/<encoded(srcSessionRoot)>/<newSid>.jsonl`，
**不是写到新 session 目录**。需要手动 mv 到新 session 的 encoded-cwd 子目录。
sessions.js fork endpoint 已实现这套（含 fallback：rename 失败时 readdir 找）。

### 7.4 sid 由谁生成

- **新会话**：服务端 `crypto.randomUUID()` 预生成 → 传给 SDK
  options.sessionId（d.ts:1537 单独可传，不跟 resume 同用）
- **续约**：使用前端传的 sid → 走 SDK options.resume
- 这样能在 turn 启动前 ensureSessionWorkspace 建好 sessions/<sid>/，
  cwd 一开始就在 session 沙盒里

### 7.5 Hub vs Workspace 角色边界

- **Hub** = "项目控制台"，编辑项目级配置（CLAUDE.md / agent-memory），看 sessions list，发起新会话（input → navigate /work + auto-send）
- **Workspace** = "工作台"，做实际 chat + canvas + context 工作

Hub 不接 WS（不显示运行时事件流），Workspace 接 WS。

---

## 8. 文档入口

- 本文 — cold-start 入口
- `HANDOVER_2026-05-01_phase123.md` — 上一段（agent 层 SDK 用法精度）
- `HANDOVER_2026-04-30_stage1.md` — 前一段（stage 1 SDK 接通基础，必读代码地图）
- `PLAN.md` 顶部 "🟢 当前状态（2026-05-01 H5 收尾）" 段
- `~/.claude/projects/-Users-edy-Desktop-panel-workplace-Nodesign/memory/`：
  - `MEMORY.md` — index
  - `nodesign_session_scoped_summary.md` — 本段总览
  - `feedback_kimi_thinking_blocks.md` — Kimi thinking 踩坑
  - `nodesign_sdk_principle.md` — agent 能力 = SDK（必读核心原则）
  - `feedback_pacing.md` — 推进节奏（每段 commit 后停下让 review）

---

## 9. 自检清单（接手后第一天）

- [ ] 跑 `npm run dev` 后端 + `npm run dev` 前端（web/）
- [ ] 浏览器 http://localhost:5174 看到 Home + 创建 project + 进 Hub
- [ ] Hub 三 cards 都能 mount 显示数据（Instructions 显示 CLAUDE.md，Files empty，Memory empty）
- [ ] HubInput 输入文字 + Enter → 跳 /work，几秒后跳 /sessions/<sid>，agent 完成生成 canvas.html
- [ ] sessions/<sid>/ 目录结构齐：canvas.html, spec.json, .claude/{5 软链 + projects/<encoded>/<sid>.jsonl}, .git/
- [ ] SessionListModal（点 ChatPanel header session selector）显示当前 session
- [ ] fork session：复制产物 OK，新 sid 含 .git history
- [ ] timeline group：thinking + tool + 中间 text 进同一 group，final text 在 group 外，run done 后 done 节点显示

如果以上都过，那 H5 状态完整复现，可以开 follow-up 列表。
