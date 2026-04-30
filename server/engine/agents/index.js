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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 同步读 agents/<name>.md 作为 agent prompt。模块加载时一次性读完，
 * 后续每次 createAgents() 复用 cache，避免 spawn 时 IO。
 *
 * 缺失或读失败时降级到 STUB_PROMPT —— SDK 不至于 crash，main agent
 * 调用时收到说明文字。
 */
const PROMPT_CACHE = {};
function loadPrompt(name) {
  if (PROMPT_CACHE[name] !== undefined) return PROMPT_CACHE[name];
  const file = path.join(HERE, `${name}.md`);
  try {
    PROMPT_CACHE[name] = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.warn(`[agents] failed to load ${name}.md (${err.message}); using stub`);
    PROMPT_CACHE[name] = STUB_PROMPT(name);
  }
  return PROMPT_CACHE[name];
}

const STUB_PROMPT = (name) =>
  `(P0+ stage 1 placeholder for ${name} agent. agents/${name}.md not found — `
  + `the file should ship with this commit. If you're an agent reading this, `
  + `report "agents/${name}.md missing" and stop.)`;

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
      prompt: loadPrompt('vision-checker'),
      // C14 read-only; 主要工具是 mcp__nodesign__screenshot_canvas + Read（看 spec.json）
      // omit tools 让 SDK 继承父 agent 的工具集 + MCP server 自动可见
    },

    'ds-extractor': {
      description:
        'Extract a design system spec (color tokens, type scale, spacing scale, '
        + 'shadow tokens, border radius) from the current canvas.html. Returns a '
        + 'JSON document conformant to schemas/design-system.json. '
        + 'Use this when the user asks "抽 design system" / "extract design tokens" / '
        + '"capture the visual rules" — typically right before reusing the style.',
      prompt: loadPrompt('ds-extractor'),
      // SDK AgentDefinition 没有 outputFormat 字段（query options 级别才有）。
      // 子代理走 prompt 内嵌 JSON Schema 引导输出，main agent 收到后 JSON.parse。
      // schema 文件在 agents/schemas/design-system.json，prompt 里有完整摘录。
    },

    'tweak-proposer': {
      description:
        'Propose 4–10 tweakable dimensions of the current canvas (e.g., heading '
        + 'scale, spacing density, accent color, corner style). Returns JSON '
        + 'conformant to schemas/tweak-schema.json — the frontend renders each '
        + 'tweak as slider / select / color picker / toggle. Use this when the '
        + 'user wants to fine-tune without rewriting.',
      prompt: loadPrompt('tweak-proposer'),
      // 同 ds-extractor：SDK 不支持 per-agent outputFormat，schema 内嵌 prompt
    },
  };
}
