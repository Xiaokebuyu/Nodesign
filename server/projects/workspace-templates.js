/**
 * 新工作区的起手模板（2026-08-15 从 workspace.js 拆出 —— 行数棘轮；
 * 这几坨是纯数据，跟工作区的逻辑没有耦合）。
 *
 * ⚠️ DEFAULT_GITIGNORE 是**按行合并**进已有项目的（workspace.js 的
 * ensureGitignore），所以往里加一行，全站老项目下次开会话都会补上。
 */

export const DEFAULT_GITIGNORE = `node_modules/
.DS_Store
*.log
.tmp/
# SDK 转录：一个会话一个 jsonl，一轮几百 KB，不进项目历史
.claude/projects/
# 会话私档（压缩摘要 / plan 弧）——属于对话不属于产物
.nd/
# generate_image 产物 — 通常很大且能从 spec.json 的 prompt 重生
assets/generated/
# 参考素材（web-search 下载的图 + browser_capture 从参照站带回来的）—— 同理：
# 大、可再取、而且不是"你做出了什么"。⚠️ 2026-08-18 加这条时线上已有 8 个项目
# 共 205 文件 / 76MB references 全被 track 进了 per-project git（.git 最大 95M）。
# 这条只管新写入；存量要清得手动 git rm --cached（没做，列进欠账）。
assets/references/
# 画布布局 —— 属于"你怎么摆的"，不属于"你做出了什么"。
# 进历史的坏处是具体的：每拖一次卡就弄脏工作区，而且 revertWorkspace
# 会连着把画布布局一起回退（卡片弹回旧位置、清掉的死 id 复活）。
board.json
# 演出记录（RP）—— 用户的台词是隐私不是产物：不进项目历史，回滚也不该动它。
# 顺带一层防误食：Grep 走 ripgrep，默认跳过被 gitignore 的文件。
对话.jsonl
摘要.json
`;

export const DEFAULT_SPEC_JSON = JSON.stringify(
  { version: '0.1', meta: {}, designTokens: {}, outline: [] },
  null, 2,
) + '\n';

// 2026-08-24 记忆体系改版：CLAUDE.md 挪到工作区根（画布可见），承载三类
// **人工筛选过的**长期事实——项目指引 / 风格档案 / 用户习惯。每会话被 SDK
// 确定性全量注入（settingSources 'project' 原生行为，二进制实证根目录也读）。
// 生长中的记忆（agent 自动记）住 记忆/，两层各干各的。
export const DEFAULT_CLAUDE_MD = `# 项目档案

这份文件每次会话都会完整进入 agent 的上下文。放**定了就不常变**的东西；
会生长的记忆 agent 自己记在 记忆/ 里。改这份文件里的硬约束要经用户点头。

## 项目指引
（设计意图、硬约束、必须做/不许做。例：主色永远不用红色。）

## 风格档案
（定案的视觉锚：调色板 / 字体 / 材质 / 艺术方向。）

## 用户习惯
（称呼、语气、工作方式偏好。）
`;

// rp（演出）项目的档案模板（2026-08-28）。⚠️ 这份文件**每个角色子代理也强制吃**
// （项目 CLAUDE.md 进所有子代理上下文，omitClaudeMd 透不过去 —— 08-26 实测），
// 所以栏目按"戏"设而不是按"设计"设：给角色看的世界观锚放这，给 GM 看的硬约束也放这。
// 详细设定别塞 —— 放世界书文件让角色自己 grep，这份是每次唤醒都重发的常驻开销。
export const DEFAULT_CLAUDE_MD_RP = `# 演出档案

这份文件每次会话都完整进入 agent **和每个角色**的上下文。放**定了就不常变**的东西；
会生长的记忆 agent 自己记在 记忆/ 里。详细设定放世界书文件（角色会自己 grep），
别塞进这里 —— 这份是每次唤醒都重发的常驻开销。改硬约束要经用户点头。

## 世界观锚
（一句话定调：什么世界、什么时代、什么基调。例：低魔剑与魔法，冒险者公会体系。）

## 台面规矩
（玩法与判定的硬约束：轮次怎么走 / 骰子规则 / 禁区题材 / 谁执哪支笔。）

## 称呼与习惯
（用户扮演谁、怎么称呼；语气与节奏偏好。）
`;
