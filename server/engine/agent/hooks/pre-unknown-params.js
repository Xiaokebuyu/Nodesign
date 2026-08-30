/**
 * PreToolUse(nodesign 工具族) —— 未知参数不许静默消失（2026-08-30）
 *
 * 病根：SDK 按 tool() 的 schema 校验入参，zod 的 object **默认 strip 未知键**
 * —— 不报错、不警告、不留痕。于是模型自造的参数连同它承载的内容一起蒸发，
 * 那一步照跑，只丢半个意图。
 *
 * 真会话实锤（全库 358 份转录）：`write_on_board.facts` 直调 18 次 + batch 内 2 次，
 * 每次都是一长串「本章确立的事实」，一个字没落盘、一句话没报回去。另有
 * `edit_board.op/on`（模型把单条 op 摊平写）4 次、`edit_board.screenshotAfter` 4 次。
 *
 * 工具自己看不见这些键（进 handler 前就没了），只有钩子拿得到原始 tool_input。
 * 所以探针挂这儿，判据只有一条：**这个键不在该工具的 schema 里**。
 *
 * 不 block —— 拦下来会让整批停摆，而多数情况正事是做得成的。做法是放行 + 点名：
 * 「你传的 X 没有生效，内容没落盘」，模型下一轮自己补。
 * 归属：`feedback-tool-input-no-silent-drop`（入参不许静默丢/静默改口径）。
 */
import { TOOL_PARAM_KEYS } from '../../mcp/index.js';

const BATCH_TOOLS = new Set(['mcp__nodesign__board_batch', 'mcp__nodesign__browser_batch', 'mcp__nodesign__artifact_batch']);
/** batch 自己的旋钮，不算未知 */
const BATCH_OWN = new Set(['actions', 'screenshotAfter']);

/**
 * 一个工具的未知键（schema 没登记过的）。台账里没有这个工具 → 返回空，别瞎报。
 *
 * ⚠️ 名字两种写法都要认：台账按 tool() 的**裸名**建（write_on_board），而钩子拿到的
 * tool_name 是**带前缀**的（mcp__nodesign__write_on_board），batch 里模型两种都写过。
 * 第一版只查带前缀那一种，于是钩子从来不响 —— 我自己的冒烟测试给 map 塞的正好是
 * 带前缀的键，把这个洞盖住了（判据本身要先验一遍，量具错得比 bug 还多）。
 */
const PREFIX = 'mcp__nodesign__';
function schemaOf(name) {
  if (typeof name !== 'string') return null;
  return TOOL_PARAM_KEYS.get(name) || TOOL_PARAM_KEYS.get(name.startsWith(PREFIX) ? name.slice(PREFIX.length) : `${PREFIX}${name}`) || null;
}
function unknownKeysOf(name, input) {
  const own = schemaOf(name);
  if (!own || !own.size || !input || typeof input !== 'object') return [];
  return Object.keys(input).filter((k) => !own.has(k) && !k.startsWith('__'));
}

export function makePreToolUseUnknownParamsProbe() {
  return async (input) => {
    try {
      const name = input?.tool_name;
      if (typeof name !== 'string' || !name.startsWith('mcp__nodesign__')) return {};
      const args = input?.tool_input;
      if (!args || typeof args !== 'object') return {};
      const lines = [];

      if (BATCH_TOOLS.has(name)) {
        for (const k of Object.keys(args)) {
          if (!BATCH_OWN.has(k) && !k.startsWith('__')) lines.push(`batch 这一层的 \`${k}\` 不是它的参数`);
        }
        const actions = Array.isArray(args.actions) ? args.actions : [];
        actions.forEach((a, i) => {
          if (!a || typeof a !== 'object') return;
          const bad = unknownKeysOf(a.name, a.input);
          if (bad.length) lines.push(`第 ${i + 1} 步 ${a.name} 的 \`${bad.join('`/`')}\``);
        });
      } else {
        const bad = unknownKeysOf(name, args);
        if (bad.length) lines.push(`\`${bad.join('`/`')}\``);
      }
      if (!lines.length) return {};

      const own = BATCH_TOOLS.has(name) ? null : schemaOf(name);
      const take = own?.size ? `${name.replace(PREFIX, '')} 收的是：${[...own].join(' / ')}。` : '';
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          additionalContext: `⛔ 这次调用里 ${lines.join('；')} —— 不是这个工具的参数，**整个被丢掉了**，`
            + `里面的内容一个字都没到工具手上（这一步其余部分照跑）。${take}`
            + '要保留那些内容就换个真实存在的参数重写一遍，别以为它已经生效了。',
        },
      };
    } catch { return {}; }
  };
}
