/**
 * PreToolUse(nodesign 工具族) —— 数值越界按边界执行（2026-09-17，站主拍板）
 *
 * 以前：agent 传的数值越过 schema 的上下限（browser_find limit 传 30、上限 20；
 * screenshot_canvas settleMs 传 14000、上限 10000；write_on_board nodes[].w 传 240、上限 120），
 * MCP server 侧 zod 直接拒（MCP error -32602），整个调用不执行。工具定义里明明写着
 * minimum/maximum，模型照样越界，每次越界都白白多一个回合。
 *
 * 现在：执行前把越界数值夹到边界，返回完整的新入参（updatedInput），并用 additionalContext
 * 逐项告诉模型「参数 X 传了 30，上限 20，已按 20 执行」—— 工具体不知道被夹过，只有这里能说。
 * 边界表在 mcp/index.js 的 TOOL_NUMERIC_BOUNDS（从 zod schema 转出，见 mcp/numeric-bounds.js）。
 * batch 工具的 actions[].input 按子工具的边界夹；写在 action 那一层、会被 batch 归位进 input 的
 * 参数，和多包了一层的 input.input，也按子工具的边界夹。
 *
 * ⛔ 返回值**不许带 permissionDecision**（09-17 三轮 SDK 探针实测，CLI 0.3.269）：
 *   - 同一次调用挂着的其它钩子（未知参数探针、板上动静、首调注入族）都返回
 *     permissionDecision:'allow' 且不带 updatedInput。CLI 对权限结果是后到的覆盖先到的，
 *     带了 allow 的 updatedInput 会被它们抹掉 → 工具照样被 zod 拒，而模型读到的说明却是
 *     「已按 20 执行」（探针 3 复现）。
 *   - 不带 permissionDecision 时 CLI 走另一条路：直接替换这次调用的入参，再照常过权限
 *     （生产 bypassPermissions、默认模式 + permissions.allow 的 mcp__nodesign 两种都实测生效，
 *     别的钩子返回 allow 不影响）。所以不需要、也不该为此放宽任何权限。
 * ⛔ 对 nodesign 工具返回 updatedInput 的钩子只许这一个：两个钩子各返回 updatedInput，
 *   后到的会把先到的整份替换掉（与 Grep 那条的教训相同，见 hooks.js）。
 */
import { TOOL_NUMERIC_BOUNDS, TOOL_PARAM_KEYS } from '../../mcp/index.js';
import { clampToBounds, describeClamp } from '../../mcp/numeric-bounds.js';
import { BATCH_TOOLS, lookupToolTable } from './pre-unknown-params.js';

const PREFIX = 'mcp__nodesign__';
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const bare = (n) => (typeof n === 'string' && n.startsWith(PREFIX) ? n.slice(PREFIX.length) : n);

/** batch 里的一步：input、action 层的散落参数、input.input 双层信封，都按子工具边界夹 */
function clampAction(action, i, lines) {
  if (!isPlainObject(action)) return action;
  const bounds = lookupToolTable(TOOL_NUMERIC_BOUNDS, action.name);
  if (!bounds) return action;
  const own = lookupToolTable(TOOL_PARAM_KEYS, action.name);
  const label = `第 ${i + 1} 步 ${bare(action.name)} 的`;
  let out = action;
  const note = (changes) => { for (const c of changes) lines.push(`${label}${describeClamp(c)}`); };

  if (isPlainObject(action.input)) {
    const r = clampToBounds(bounds, action.input);
    let input = r.value;
    note(r.changes);
    if (!own?.has('input') && isPlainObject(input.input)) {
      const inner = clampToBounds(bounds, input.input);
      if (inner.changes.length) {
        input = { ...input, input: inner.value };
        note(inner.changes);
      }
    }
    if (input !== action.input) out = { ...out, input };
  }
  const stray = {};
  for (const k of Object.keys(action)) if (k !== 'name' && k !== 'input') stray[k] = action[k];
  if (Object.keys(stray).length) {
    const r = clampToBounds(bounds, stray);
    if (r.changes.length) {
      out = { ...out, ...r.value };
      note(r.changes);
    }
  }
  return out;
}

export function makePreToolUseNumericClamp() {
  // 具名函数：装配测试（hooks-assembly.test.js）按 fn.name 认出它挂没挂对
  return async function numericClamp(input) {
    try {
      const name = input?.tool_name;
      if (typeof name !== 'string' || !name.startsWith(PREFIX)) return {};
      const args = input?.tool_input;
      if (!isPlainObject(args)) return {};
      const lines = [];
      let next = args;

      const own = lookupToolTable(TOOL_NUMERIC_BOUNDS, name);
      if (own) {
        const r = clampToBounds(own, args);
        next = r.value;
        for (const c of r.changes) lines.push(describeClamp(c));
      }
      if (BATCH_TOOLS.has(name) && Array.isArray(next.actions)) {
        let actions = next.actions;
        next.actions.forEach((a, i) => {
          const na = clampAction(a, i, lines);
          if (na !== a) {
            if (actions === next.actions) actions = next.actions.slice();
            actions[i] = na;
          }
        });
        if (actions !== next.actions) next = { ...next, actions };
      }
      if (!lines.length) return {};

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: next,
          additionalContext: `数值越界，已按边界执行（这次调用照常执行，没有被拒）：${lines.join('；')}。`
            + '边界写在工具定义的 minimum/maximum 里，下次直接传范围内的值。',
        },
      };
    } catch { return {}; }
  };
}
