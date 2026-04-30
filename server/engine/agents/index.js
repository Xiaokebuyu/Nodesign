/**
 * server/engine/agents/index.js — subagent 定义集合
 *
 * 通过 SDK 的 query options.agents 字段挂载 3 个子代理：
 *
 *   vision-checker    — 截图 + a11y / 视觉合理性评审（C14 真实 prompt 在 vision-checker.md）
 *   ds-extractor      — 抽 design system tokens（C15 真实 prompt + design-system.json schema）
 *   tweak-proposer    — 推可调 slider schema（C16 真实 prompt + tweak-schema.json schema）
 *
 * 调用：main agent 用 Task 工具调（SDK 自动暴露）。
 *
 * P0+ stage 1 范围：
 *   - 只挂定义骨架，main agent 通过 SKILL.md 引导**不主动调**这些子代理
 *   - 真调用流程留 stage 2（用户测试 + 真接通 H/F 流时再发力）
 *   - prompt 在 C14-C16 用 .md 文件填实，本 commit 用占位短句
 *
 * AgentDefinition 字段（sdk.d.ts:38）：
 *   description: string         自然语言描述何时该用
 *   tools?: string[]            允许的工具，omit 继承父 agent
 *   disallowedTools?: string[]
 *   prompt: string              system prompt
 *   model?: string              alias 或 full id；'inherit' / omit 沿父
 *   mcpServers?: AgentMcpServerSpec[]
 *   skills?: string[]
 *   initialPrompt?: string      首条自动 user 消息
 *   maxTurns?: number
 *   background?: boolean        true = fire-and-forget 不阻塞
 *   memory?: 'user' | 'project' | 'local'
 *   effort?: EffortLevel | number
 *   permissionMode?: PermissionMode
 */

const STUB_PROMPT = (name) =>
  `(P0+ stage 1 placeholder for ${name} agent. Real prompt is filled in C14/C15/C16 — `
  + `read from agents/${name}.md when this agent is invoked. Until then, this stub returns "TODO".)`;

/**
 * 创建 agents 配置 —— 喂给 query options.agents 字段。
 *
 * @returns {Record<string, AgentDefinition>}
 */
export function createAgents() {
  return {
    'vision-checker': {
      description:
        'Visually inspect the current canvas.html design via screenshot. '
        + 'Use this when you need an independent second-pair-of-eyes review on '
        + 'whether the design looks right — alignment, contrast, hierarchy, spacing, '
        + 'a11y readability. Returns a structured critique with concrete fix suggestions.',
      prompt: STUB_PROMPT('vision-checker'),
      // tools: ['Read', 'Bash', 'mcp__nodesign__screenshot_canvas'],  // C14 fills
    },

    'ds-extractor': {
      description:
        'Extract a design system spec (color tokens, type scale, spacing scale, '
        + 'shadow tokens, border radius) from the current canvas.html. Returns a '
        + 'JSON schema-conformant design system document.',
      prompt: STUB_PROMPT('ds-extractor'),
      // outputFormat: { type: 'json_schema', schema: <design-system.json> } — C15 fills
    },

    'tweak-proposer': {
      description:
        'Propose a slider schema describing tweakable dimensions of the current '
        + 'canvas (e.g., heading scale, spacing density, accent color hue range, '
        + 'corner roundness). Returns JSON describing each tweak\'s name / min / max '
        + '/ step / current value, ready for the frontend to render as sliders.',
      prompt: STUB_PROMPT('tweak-proposer'),
      // outputFormat: { type: 'json_schema', schema: <tweak-schema.json> } — C16 fills
    },
  };
}
