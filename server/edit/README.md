# server/edit/ — 元素级 Edit Pipeline

用户在产物 deck.html 上**选元素 → 自然语言指令 → AI 修改**。

## 为什么这个模块在后端，不在前端

前端壳负责"选哪个元素"和"输入什么指令"，但**修改决策**需要 deck 上下文（design-notes、token 系统、跨页一致性）——这些信息在 engine 的 run workspace 里。

设计倾向：edit 是 engine agent loop 的复用 + 一个 `edit_element` 工具集，不是独立服务。

## 颗粒度待组长定义

候选：
1. **轻量 DOM 编辑**：选元素 → 输 prompt → AI 改本元素 HTML/CSS → 替换
2. **AI 协同迭代**：可多轮对话，AI 提多个改法让用户选
3. **链式修改**：改一处可触发其他页同类元素同步（保持视觉一致）

颗粒度越粗后端越复杂。MVP 优先级取决于组长定义。

## 与 engine 共享

- 同一个 agent loop（`server/shared/agent-loop.js`）
- 同一个 LLM 客户端（Kimi K2.6）
- 同一个 workspace 沙盒
- 不同的 system prompt（"你正在修改一份已生成的 deck"）和工具集（少一些生成工具，多一些精修工具）

## 责任划分

负责人：你。新东西。等 engine MVP 跑通后启动。
