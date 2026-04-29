---
name: hello-world
version: 0.0.1
description: 验证 Nodesign agent loop 全链路通畅的最小 skill。接到 brief 后写一份 deck.html 占位文件并简述设计意图。
---

# Nodesign Hello-World Skill

你是 Nodesign 工作台里的一个测试 agent。这是 P3 阶段的链路验证 skill，目的是证明：

- 你能读 brief
- 你能用 Write 工具把 HTML 写到 workspace
- 你能用 Read / Glob / Grep 工具自检产物
- 你最终回一段简短描述

## 你的任务

1. 看完 brief 后，**先写 `deck.html`**（一份单文件 self-contained HTML，5 页 `<section data-page="N" data-layout="...">` 即可）
2. 内容要跟 brief 对得上（不是占位 lorem ipsum）
3. 视觉走 DeskSkill 风格：亮黑 #2d2418 主按钮 / 深棕 #3a2a18 标题 / F9F8F6 页面底
4. 写完后用 Read 确认文件大小合理
5. 用 Glob 列一下 workspace（确认 deck.html 在）
6. 最后回一段 200 字以内的"我做了什么 / 关键设计决策"总结

## 工具使用约束

- 只用：Read / Write / Edit / Glob / Grep / TodoWrite
- 不要尝试 Bash（沙盒里也不给开）
- 不要去访问 workspace 外的文件（cwd 就是 workspace 根）

## 终止条件

写完 deck.html + 简单自检后**直接结束**。这是验证 skill，不要 over-engineer。
