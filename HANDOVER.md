# Nodesign — 交接文档

> 起点：2026-04-29 晚
> 状态：**雏形阶段**（目录骨架 + 复用基建已就位；业务代码未动）
> 用途：从 dev/ 工作区切换到 Nodesign/ 工作区时的 cold-start 上下文包

---

## 0. 给下一个 session 的开场白

你正在打开的是一个**全新的产品线** —— 跟 [dev/ team dashboard](../dev/) 平级，不是它的子模块。

这个产品叫 **Nodesign**（"No Design"——不需要设计的设计工具）。负责人对它的定位：**这将是我的野心作品**。所以请慎重。

**先别急着写代码**。这个项目处在"雏形阶段，准备和组长对齐"的状态——目录已经搭好、可复用的基建已经从小合搬过来，但**业务架构有几个关键决策点必须等组长输入**。详见本文档 §5。

唯一**今晚就能做、不依赖任何对齐**的事是 [Kimi K2.6 minimal probe](#7-阶段-0--唯一能做的事kimi-probe)，建议先做完它。

---

## 1. 这是个什么产品

### 一句话

**云端 SaaS skill engine**：用户输入 brief（或上传参考素材）→ 自动生成可分享的 HTML 演示稿；产物可在浏览器里**元素级编辑**。

### 两条核心通路

```
官网入口
├── 自由创作模式（现有 deskskill-engine 路径）
│   └── brief → metaphor 推导 → deck
│
└── 参照模式（新分支） ★ 风险/野心点都在这条
    ├── 选模版来源
    │   ├── 平台 curate 模版库（用现有视觉资产）
    │   └── 用户上传 PPT/PDF/HTML
    ├── 风格提取 pipeline → 输出结构化 style tokens
    ├── brief 输入
    └── engine 调用（skill + style tokens）→ deck

输出页
└── 元素级 edit 功能（选元素 → 发送给 AI 修改）
```

### 责任三层

| 层 | 内容 | 负责人 |
|---|------|--------|
| 产品壳 | 网页 / 上传组件 / 模版库 / 作品库 / 导出 / edit UI | input 提供者（不是负责人） |
| **风格提取 pipeline** | PPT/PDF/HTML 解析 → style tokens | **你（新东西）** |
| **skill 引擎** | deskskill-engine 演进 + 模版 skill 复用/重做 | **你（已有基础）** |
| 账号/鉴权/部署 | 复用已有平台基础设施 | 不需要做（组长确认） |

详细产品蓝图见 §10 引用的"DeskClaw 云服务分支交接文档"原文。

---

## 2. 已就位的内容（你打开仓库时能看到什么）

```
Nodesign/
├── HANDOVER.md                       # 你正在读的文件
├── package.json                      # ★ 新写：依赖列表 + 待决策注释
├── .env.example                      # ★ 新写：Kimi + Engine 配置项
├── .gitignore                        # ★ 新写
└── server/
    ├── shared/                       # ★ 从小合搬来的 4 个基建文件
    │   ├── anthropic-client.js       # 改 Kimi baseURL
    │   ├── agent-loop.js             # 改 env 名
    │   ├── concurrency.js            # 改注释/泛化
    │   ├── time.js                   # 零改动
    │   └── README.md                 # 说明每个文件改了什么
    ├── engine/README.md              # 占位（skill runner 设计文档）
    ├── style-pipeline/README.md      # 占位（风格提取设计文档）
    ├── edit/README.md                # 占位（元素级 edit 设计文档）
    ├── api/README.md                 # 占位（HTTP API 路由计划）
    ├── auth/README.md                # 占位（鉴权待对齐）
    ├── runs/                         # 空（每个 run 一个 workspace 子目录）
    ├── skills/installed/             # 空（symlink 各 skill 到这里）
    └── db/                           # 空（SQLite 文件落这里）
```

**核心抉择**：业务代码（engine 实现、style pipeline 实现、API 路由、SQL schema、HTTP 入口）**全是占位 README**。原因见 §5。

---

## 3. 上一版方案的修正

之前在 dev/ 工作区讨论时，方案是"在 dev/server/ 里加一个跟 bot/ 平级的 engine/ 目录"。**这个不对了**。

新格局是：

| 维度 | 上一版（错） | 现在 |
|---|---|---|
| 位置 | `dev/server/engine/` | `panel-workplace/Nodesign/server/engine/` |
| 边界 | 小合的扩展 | **独立产品线**（跟 dev/ 平级） |
| 入口 | 飞书小合 | **Web + HTTP API**（小合降为内部 client） |
| 数据库 | 共用 teamboard.db | **独立**（量大可能切 PostgreSQL） |
| 模型 | MiniMax | **Kimi K2.6**（详见 §4） |
| 范围 | 只有 engine | **engine + style-pipeline + edit + api + auth** 五大模块 |

---

## 4. 模型层：换 Kimi K2.6

### 决策来源

负责人 2026-04-29 决定换 Kimi K2.6。原因：
- $0.60/M input vs Claude Opus 4.7 $5/M — **8 倍便宜**，SaaS 友好
- 256K context（够装 SKILL.md + references）
- 工具调用稳定（4000+ 步不退化，K2.5 几百次就退化）
- 原生 Anthropic 兼容端点 → SDK 不用换

### 相性 quick reference

| 维度 | 状态 |
|---|---|
| `@anthropic-ai/sdk` 兼容 | ✅ 改 baseURL 一行：`https://api.moonshot.ai/anthropic` |
| Tool use 稳定性 | ✅ K2.6 4000+ 步不退化 |
| Context | ✅ 256K |
| `cache_control: ephemeral` | ⚠️ **未验证**（probe 任务首要） |
| `anthropic-beta: interleaved-thinking-2025-05-14` | ⚠️ **未验证**（可能 Kimi 有自己的 reasoning 参数） |
| Temperature 行为 | ⚠️ 兼容层主动缩放 `real_temp = request_temp * 0.6` |
| 创造性长文本 | 🟡 比 Opus 4.7 弱一档（实测 68/100 vs 91/100，但价差 8x） |
| 速度 | 🟡 比 Claude 慢一些，长 reasoning 更明显 |

### 救场预案

如果实测 Kimi 创造性产出不达标，做成 `ENGINE_LLM_PROVIDER` 可切（kimi / anthropic），切官方 Opus。`server/shared/anthropic-client.js` 文件末尾已留注释。

### Sources

- [Kimi K2.6 Officially Released](https://kimi-k2.org/blog/24-kimi-k2-6-release)
- [Kimi K2.6 Quickstart 官方文档](https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart)
- [Kimi vs Claude vs GPT-5.4 Agentic Coding Benchmarks](https://www.verdent.ai/guides/kimi-k2-6-vs-claude-opus-4-6-vs-gpt-5-4)
- [Workflow Orchestration Spec 实测](https://blog.kilo.ai/p/we-gave-claude-opus-47-and-kimi-k26)

---

## 5. 7 个待对齐组长的问题（动业务代码前必答）

| # | 问题 | 决定什么 |
|---|------|---------|
| 1 | "已有平台"具体指什么？ | 后端技术栈、鉴权方式、部署形态 |
| 2 | edit 功能的颗粒度产品定义？（轻量 DOM vs AI 协同迭代 vs 链式修改） | 后端复杂度上限 |
| 3 | 模版页是 NoDeskAI curate 精品库 + 用户作品橱窗 + 还是两个都要？ | 内容运营工作量、style-pipeline 优先级 |
| 4 | "我负责后端服务构建" — 我一个人还是有团队？ | 工作量管理预期 |
| 5 | MVP 时间预算？ | 架构复杂度上限（决定是否一步到位 monorepo / pg / etc） |
| 6 | 自由创作模式 vs 参照模式在产品入口怎么区分？哪个是主推？ | 产品定位 + style-pipeline 优先级 |
| 7 | 模版 skill 之前的资产现状？能跑通基础流程吗？ | v1 是复用还是重新设计 |

⚠️ **必须先告知组长一个盲区**：负责人不是 PPT 重度用户，痛点清单的覆盖范围是 "engine 视角的用户" + 推测，不是真实 PPT 用户。建议组长访谈真实用户 / 团队里其他更重度用户主导这部分 / 组长自己来。

---

## 6. 风格参考根因诊断（动 style-pipeline 前必做）

**背景**：之前用模版 skill 试过风格参考路径，效果不好。这次产品要把"参照模式"做成核心通路，根因不刨清楚 → 在付费用户面前撞同一面墙。

### 待验证假设

- **A**：declarative 路径丢精度 — 让模型用语言描述风格再复述，中间损耗大
- **B**：prompt 容量不够 — 视觉信息塞不进 context（K2.6 256K 后这个假设可能松动）
- **C**：metaphor 推导链跟外部 reference 本质冲突 — engine 是从 metaphor 推审美，reference 是直接给审美，两套逻辑互斥
- **D**：模型对"复刻风格"的指令服从度本来就低 — 即使描述准确，模型仍倾向自由发挥
- **E**：模版 skill 工程实现问题 — 不是上述任何一个

### 诊断流程

1. 找出当时的失败案例和 prompt
2. 对每个假设设计 minimal repro
3. 验证哪些假设站得住，哪些站不住
4. 输出诊断报告 → 决定 pipeline 提取什么、skill 接什么、edit 修什么

---

## 7. 阶段 0 — 唯一能做的事：Kimi probe

**这是不依赖任何组长对齐就能推进的唯一事项**。30 行 JS，跑通三件事：

1. **基础流式调用**：发一条消息，能流式收到 text delta
2. **Tool use 流式**：定义一个简单工具（如 `add(a, b)`），看模型能不能正确调用并接收结果
3. **Cache control 是否生效**：连发两次同样的长 system prompt，看第二次 `cache_read_input_tokens` 是否大于 0
4. **Interleaved thinking beta header**：试 `anthropic-beta: interleaved-thinking-2025-05-14`，看是否被接受 / 报错；如果不行，查 Kimi reasoning 参数

写到 `server/_probe-kimi.js`。`npm run probe:kimi` 触发。

**输出**：一份 markdown 报告记录每个能力的实测结果。这份报告决定阶段 1 怎么实现 engine。

---

## 8. 阶段 1+（对齐后启动）

| 阶段 | 内容 | 阻塞条件 |
|---|---|---|
| **P1 engine MVP** | agent loop 包装 + filesystem/shell/todo 工具 + workspace 沙盒 + skill loader + runs DB + `POST /engine/runs` | 解除：probe 完成、组长 Q1/Q5 确认 |
| **P2 deskskill-engine 跑通** | symlink skill + 跑一个真实 brief，输出 deck.html | 解除：P1 完成 |
| **P3 Preview 加成** | playwright 预览工具 + 截图推送 + agent 自纠错 | 解除：P2 完成 |
| **P4 风格诊断 + style-pipeline 起步** | 先做 §6 根因诊断，再选技术路线 | 解除：组长 Q3/Q6 确认 |
| **P5 edit pipeline** | 元素级 edit | 解除：组长 Q2 确认 + P3 完成 |
| **P6 鉴权 + 公网部署** | 替换 INTERNAL_API_TOKEN 为真鉴权 | 解除：组长 Q1 确认 |

---

## 9. 心态备忘（呼应转向期容易丢的）

- **工作量拉宽是真的，不要假装没事**；管理预期比硬扛更重要
- **组长说"我琢磨琢磨" = 他自己也还在想**；不要替他全想完，留 space
- **"控制感下降" ≠ "工作量爆炸"**；心智负担类型变了，不是单纯工作量增加
- **不必一次吸收完所有变化**；增量信息会持续来，允许自己分批消化
- **从 skill 作者到产品+skill 双肩挑，核心能力是"知道哪些事不该自己做"**

### deskskill-engine 6 条 belief 仍然适用

1. 模型不缺答案缺好的问题 → 在产品层：用户不缺直觉缺表达能力（上传 = 绕过描述）
2. 审美选择由 metaphor 推导不由禁令排除 → skill 内部不变；产品层引入 reference 提供方向
3. 信任前沿模型能力不在执行时再加调度 → 后端架构同样适用：不在 pipeline 里过度预处理
4. Commitment device 比 schema 强 → skill 用 prose 而非 JSON 不变；后端 API 该结构化的还是结构化
5. Mechanical gates 客观 catch + 元认知 prompts 主观避免 → skill 内部不变
6. 失败应被 dogfood 暴露驱动，不被预防性机制压制 → **云服务上更重要**（付费用户 dogfood 信号比内部使用更稀缺）

---

## 10. 引用资料

- **小合基建源码**：[dev/server/bot/](../dev/server/bot/) — 已抠出可用的 4 个文件到 `server/shared/`
- **deskskill-engine v0.7.5**：`/Users/edy/Desktop/html_designer/v0.7.5/deskskill-engine-v0.7.5/` — 第一个客户 skill
- **Team dashboard CLAUDE.md**：[../CLAUDE.md](../CLAUDE.md) — 上一个产品的设计规范（Nodesign 不直接复用，但可参考"内部协作 vs 外部 SaaS"边界）
- **DeskClaw 云服务分支原始交接文档**：见 2026-04-29 与组长对齐的笔记（暂未单独成文件，关键信号在 §1 和 §5）

---

## 11. 不要做的事（禁忌清单）

- ❌ 不要把 `dev/server/` 整个搬过来——只有 `server/shared/` 那 4 个文件值得复用，其他都耦合工单业务
- ❌ 不要在 deskskill-engine 上加新机制——方向已转，问题在产品层解
- ❌ 不要在组长答 Q1（"已有平台"）前选后端技术栈
- ❌ 不要在风格参考根因诊断（§6）前写 style-pipeline 实现
- ❌ 不要把 `postprocess.py` 搬过来——已决定移除，G1-G11 改 JS 工具
- ❌ 不要把 deskskill-engine 改成"4 轮 orchestrator"——agent 自驱才是 SKILL.md 设计本意
- ❌ 不要急着 monorepo / pnpm workspace——MVP 阶段直接 require dev/ 里的文件就够；架构稳定后再合并

---

最后：祝顺利。这是个值得做好的项目。
