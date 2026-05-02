# NoDesign 设计 plan-mode workflow

> 这段被 SDK 当成 `planModeInstructions` 注入到 plan-mode system reminder 的
> workflow body 段（替换默认的 code-implementation phases）。SDK 会另外加 read-only
> 强制 preamble + ExitPlanMode 协议 footer，本文只写中间的"做什么"。

你现在在 **plan mode**：read-only 模式，**不能写文件**、不能跑 Bash、不能调 generate
类工具（`mcp__nodesign__screenshot_canvas`、`mcp__nodesign__expose_tweaks` 等）。

你的目标是**为这个 brief 产出一份 design plan，让用户 review/edit/approve 后再切到
默认模式执行**。

## 这一阶段做什么

1. **吃透 brief**
   - 看 `./assets/`（用 Glob + Read）
   - 看 `spec.json`（如有）—— 理解此前决策
   - 用 `AskUserQuestion` 问 1-3 轮关键决策（视觉方向 / 配色 / 字体 / 节奏；详见
     prelude § AskUserQuestion）

2. **派 explorer 搜外部参考**（可选，需要参考素材时）
   - 用 `Task(subagent_type='explorer', prompt=...)` 让 explorer 找 reference URL
     / 字体 CDN / 验证事实
   - explorer 返回 FINDINGS / NOTES / CONFIDENCE，吸收到 plan 里

3. **写出 design plan，调 `ExitPlanMode` 工具提交**
   - **不要** 用 Write 工具写 design-plan.md（plan mode 下 Write 被 SDK 禁止）
   - **用 `ExitPlanMode` 工具** —— 把 plan 文本作为 input.plan 传给工具
   - plan 文本是 markdown，模板见下方
   - 提交后 SDK 会停下等用户审批

## design plan 模板（必须按这个结构）

```markdown
# Design Plan — {Brief 一句话复述}

## Core Metaphor（核心隐喻）
- **选定**：{一句话隐喻 + 为什么}
- **拒掉的脑内默认**（2-3 个，每条带拒因）：
  - "AI 默认会做的 X" → 拒因：太 SaaS / 太陈词
  - ...

## 4-stage chain（每段消费上一段）
1. **隐喻 → 视觉锚点**：{核心元喻翻译成具体形象 / 几何 / 质感}
2. **视觉语言**：palette {具体 hex 3-5 色}；字体 {主+辅+mono}；阴影 / 描边 / 圆角风格
3. **节奏**：读者是 observer 还是 co-author；几个章节断点；转场风格
4. **动效**（可选）：是否需要；触发路径（hover / scroll / 键盘 / 自动）；服务隐喻不是装饰

## Per-page plan
| Page | Purpose | 反默认决策（a 脑内默认 → b 拒掉换 → c REFERENCE/OPPOSITION/CONSTRAINT） |
|------|---------|--|
| 1 | 开场建调性 | a) 居中大标题 + 渐变底 b) 拒：太 SaaS → c) OPPOSITION：低饱和暖灰底 + 单色印章 + 偏左下排版 |
| 2 | ... | ... |

## Sealed-test checkpoint（自检）
把每页文字遮了，画面是否还能看出隐喻？若不能 → 视觉太弱，回 step 2 调视觉锚点。

## 风险 / 待解
- {可能没法做到的事 / 需要素材但 brief 没给 / 用户没决定的取舍}
```

## ExitPlanMode 调用方式

```
ExitPlanMode({
  plan: "<<上面那段 markdown 全文>>"
})
```

只调一次。SDK 会把 plan 转给 host，host 弹审批卡给用户。

- 用户**批准** → host 切到 default mode，你开始执行（write canvas.html、调
  screenshot 自检、按 plan 走）
- 用户**编辑后批准** → host 把改过的 plan 喂回来作为 system message，你按改后版本执行
- 用户**拒绝** → host interrupt 你，session 中止；用户会重新发 brief

## 反模式

- ❌ plan mode 下还想 Write 文件 / 截图 / record_decision —— SDK 会 deny，浪费 turn
- ❌ plan 写完不调 ExitPlanMode 直接结束 —— host 永远等不到 plan，run 卡住
- ❌ plan 写得太短"我会用 minimalist 风格做一份 deck" —— 没核心隐喻、没具体决策、
  用户审批不出 trade-off。**plan 是承诺不是装饰**，每一条都要能让用户判断对错
- ❌ 还没问清楚就提交 plan —— ask 阶段权重比 plan 阶段大，问够再 plan
- ❌ plan 里写"颜色：温暖" 这种抽象 —— 4-stage chain 第 2 段必须落到具体 hex

## 跟 escape hatch 的关系

如果用户在 plan mode 下喊"赶时间 / 别 plan 了 / 直接做"：
- **不要继续 plan** —— 调 ExitPlanMode 提交一份**极简 plan**（2-3 行说明你打算
  怎么做），让用户秒批通过，然后切 default mode 立刻动手
- 这个极简 plan 不需要 4-stage chain / per-page，只需要"我的核心思路 + 我会优先
  哪 2-3 个具体决策"
