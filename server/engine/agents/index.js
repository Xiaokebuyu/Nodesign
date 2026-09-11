/**
 * server/engine/agents/index.js — subagent 定义集合
 *
 * 通过 SDK 的 query options.agents 字段挂载子代理：
 *
 *   explorer          — ⏸ 停用中（2026-08-14）。研究员（搜索 + 读资料 + 验证事实）
 *   vision-checker    — 截图 + a11y / 视觉合理性评审（C14 真实 prompt 在 vision-checker.md）
 *   ds-extractor      — 抽 design system tokens（C15 真实 prompt + design-system.json schema）
 *   tweak-proposer    — ⛔ 已埋（2026-09-07）：唯一写口 expose_tweaks 08-24 退役后它交不了活
 *
 * 调用：main agent 用 Task 工具调（SDK 自动暴露）。
 * **注意**：'Task' 必须在主 agent 的 toolAllowlist 里（session-loop.js DEFAULT_TOOL_ALLOWLIST）
 * 否则 SDK 拒绝调用，所有子代理形同摆设。
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
import { resolveModelRoute } from '../agent/model-context.js';

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
 * 给定主 model，挑一个搭配的快速 model（subagent + SDK helper 共用）。
 *
 * 2026-08-19 起查表：API 通路模型的 fastModel 在 model-context.js 表里逐行配
 * （必须同表可路由 —— 订阅 haiku 在 API 模式会 404，旧的 DMXAPI haiku-cc
 * 硬编码就是"换了 api 之后 helper 起不来"的病根之一）。订阅模型沿用主 model
 * 自己（不强制降级避免拼错模型名导致 404）。env NODESIGN_FAST_MODEL 显式覆盖
 * 只对订阅路生效，见 session-loop 的通路注释。
 */
export function resolveDefaultFastModel(mainModel) {
  if (!mainModel) return null;
  const route = resolveModelRoute(mainModel);
  return route.mode === 'api' ? route.fastModel : mainModel;
}

/**
 * 按 role 决定子代理 model。
 *
 * - **structural / search 类**（explorer / ds-extractor）→ subModel
 *   功能是搜外链 / 抽 token / 推 slider，capability 不需跟主同级，走 fast model 省成本。
 *
 * - **judgment 类**（vision-checker）→ sdkSpoofMain
 *   视觉评审要看出 plan compliance / palette match / 反 AI 套路这些细节，
 *   capability 必须跟主 agent 同级——直接喂主 agent **SDK 视角的 model**
 *   （Kimi 主时是 spoofing alias `claude-opus-4-7[1m]`，SDK 信 1M context；
 *   binary-fixup-proxy 出口反向还原成真 `kimi-k2.6` 给 gateway）。
 *
 *   绕开两个坑：
 *   1. memory part4 — 喂 SDK 真 `kimi-k2.6` → SDK 不识别 → rawMaxTokens
 *      fallback 200k → 子代理 context window 被腰斩
 *   2. memory feedback_kimi_split_messages — `'inherit'` 字面虽被 retract 为非
 *      root cause，但从未独立验证过；走"具体 sdkModel id 直传"绕开字面解析路径
 */
function pickAgentModel(role, { sdkSpoofMain, subModel }) {
  if (role === 'vision-checker') return sdkSpoofMain || subModel;
  return subModel;
}

/**
 * 创建 agents 配置 —— 喂给 query options.agents 字段。
 *
 * @param {object} [opts]
 * @param {string} [opts.mainModel]    主 agent appModel（如 'kimi-k2.6'）
 * @param {string} [opts.sdkModel]     主 agent SDK 视角 model（spoofing 后的 alias，如 'claude-opus-4-7[1m]'）。
 *                                     缺省 = mainModel（非 Kimi 主时两者本就相等）。vision-checker 用这个。
 * @param {string} [opts.fastModel]    显式覆盖 fast model；优先级：fastModel > NODESIGN_FAST_MODEL > resolveDefaultFastModel(mainModel)
 * @returns {Record<string, AgentDefinition>}
 */
export function createAgents({ mainModel, sdkModel, fastModel } = {}) {
  const subModel = fastModel
    || process.env.NODESIGN_FAST_MODEL
    || resolveDefaultFastModel(mainModel)
    || mainModel
    || 'claude-haiku-4-5';
  // sdkSpoofMain：vision-checker 用的"主 agent SDK 视角 model"。
  // 调用方未传 sdkModel 时 fallback 到 mainModel（非 Kimi 主时两者相等无害）。
  const sdkSpoofMain = sdkModel || mainModel;
  return {
    // explorer —— 研究员子代理。主 agent 在做 deck/产物时遇到"需要外部素材
    // / 参考 / 事实验证" 就 Task 派给它。它去搜 + 读 + 总结，给主 agent 一份
    // 结构化研究报告（URLs / 字体 / 数据 / 趋势）。主 agent 拿报告直接 Edit
    // canvas.html 用，不必自己分心去搜。
    //
    // tools 显式收窄到 read-only researcher：
    //   - mcp__nodesign__web_search（多 provider 联网搜）
    //   - mcp__nodesign__screenshot_url（外站截图 —— 找视觉参考要能看见视觉，
    //     2026-07-29 前只能 WebFetch 文本转述"这个站是深色的"，等于瞎子摸象）
    //   - WebFetch（SDK 内置，按 prompt 总结 URL 内容）
    //   - Read / Glob / Grep（看本地 ./assets 和 ./spec.json）
    // 不给：Write/Edit（不写代码）/ Bash（不要 shell shenanigans）/
    //       AskUserQuestion（子代理不直接跟用户说话）/ screenshot/export/
    //       Task（不允许嵌套子代理）
    // ⏸ explorer 研究员（2026-08-14 用户暂时停用："有点没用"）。定义与
    // prompt（explorer.md）原样保留，恢复 = 取消注释 + prelude 补回子代理
    // 清单那两行。停用期间搜索/读外链由主 agent 直接用 web_search / WebFetch。
    // explorer: {
    //   description: 'Research/explorer subagent. …',
    //   prompt: loadPrompt('explorer'),
    //   model: pickAgentModel('explorer', { sdkSpoofMain, subModel }),
    //   tools: [
    //     'mcp__nodesign__web_search', 'mcp__nodesign__screenshot_url',
    //     'WebFetch', 'Read', 'Glob', 'Grep',
    //   ],
    //   // maxTurns 12 的来历：8 轮在真实多维 brief 上会被 SDK 硬掐断流
    //   // （2026-08-05 两次报告全损），提级 + explorer.md「随手记」纪律。
    //   maxTurns: 12,
    // },

    'vision-checker': {
      description:
        'Visually inspect the current canvas.html design via screenshot. '
        + 'Use this when you need an independent second-pair-of-eyes review on '
        + 'whether the design looks right — alignment, contrast, hierarchy, spacing, '
        + 'a11y readability, and (when design-plan.md exists) per-page plan compliance. '
        + 'Returns a structured per-page critique with concrete fix suggestions.',
      prompt: loadPrompt('vision-checker'),
      // judgment 类——视觉评审 capability 必须跟主 agent 同级，走 sdkSpoofMain
      // （Kimi 主时是 'claude-opus-4-7[1m]' alias，SDK 信 1M context；proxy 出口
      // 反向还原成真 'kimi-k2.6' 给 gateway）。详见 pickAgentModel 注释。
      model: pickAgentModel('vision-checker', { sdkSpoofMain, subModel }),
      // 显式列 tools：read-only 视觉评审需要的最小集合。
      // SDK doc 说"omit tools 继承父" 但跨 mcp 工具的继承行为不确定（explorer 也
      // 显式列 mcp__nodesign__web_search 是同样的稳妥做法）。Phase 1.1 audit 后
      // 改成显式声明，保证 vision-checker.md 里写的 mcp__nodesign__screenshot_canvas
      // 真实可调。
      //
      // 2026-05-10：新增 list_pages（枚举页数 → 决定循环 pageIndex 上界）。
      // 09-12 撤掉 TodoWrite：CLI 里已经没有这件工具（详见 agent-shared 的 DEFAULT_TOOL_ALLOWLIST）。
      tools: [
        'mcp__nodesign__screenshot_canvas',
        'mcp__nodesign__list_pages',
        'Read', 'Glob',
      ],
      // maxTurns：逐页评审下界估算 = 1 (Read plan) + 1 (list_pages) + 1
      // (fullPage 总览) + N (per-page 截图) + 1-2 (think + report)。N 页 deck
      // 至少 N+5 turn。16 容纳到 ~10 页 deck；超长 deck 主 agent 应 prompt
      // 里点名分批评审。
      maxTurns: 16,
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
      // structural 类（结构化抽 token），走 fast model
      model: pickAgentModel('ds-extractor', { sdkSpoofMain, subModel }),
      tools: [
        'Read', 'Glob', 'Grep',
        'mcp__nodesign__list_pages',
        'mcp__nodesign__read_page',
        'mcp__nodesign__get_computed_styles',
      ],
    },
  };
}
