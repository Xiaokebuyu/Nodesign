/**
 * hooks/slot-alias.js —— 演员位实例的 agentId→实例名 学名器（2026-08-28 重构）
 *
 * 同型多实例后 hook input 只有 agent_id / agent_type（=rp-actor），没有实例名字段
 * （探针实录见 actor-trail.js 头注）。名字只在两处露面，都在 tool_result 里：
 *
 *   派发   Agent(subagent_type:"rp-actor", name:"rp-x") 的结果文本带 `agentId: <id>`
 *   唤醒   SendMessage({to:"rp-x"}) 的结果 JSON 带 `resumedAgentId` 与 pin.name
 *
 * 所以挂 PostToolUse 从这两处学。第二条路顺带覆盖服务器重启后的场景：名册空了、
 * 别名表也空了，但 GM 按教义 SendMessage 唤醒时这里立刻重新学到。
 *
 * 匹配用正则怼序列化文本而不是解构对象：tool_response 的形状（数组/对象/字符串）
 * 随 SDK 版本漂，id 的形状（十六进制串）比包装稳定得多。
 */

import { isSlotType, ROLE_SLUG_RE } from '../cast.js';
import { noteAgentName, callerOf } from '../actor-trail.js';

// 不带前导 \b：正文常是 "...\nagentId: ..."，JSON.stringify 后换行变成字面 `\n`，
// 'n' 和 'a' 都是词字符，词边界在那儿不存在（首版真栽在这，测试逮住的）
const AGENT_ID_RE = /agentId:\s*([0-9a-f]{8,32})\b/;
// 引号写成 \\?"：结果 JSON 常作为字符串再被包一层（stringify 转义成 \"），两层都认
const RESUMED_RE = /\\?"resumedAgentId\\?"\s*:\s*\\?"([0-9a-f]{8,32})\\?"/;

export function makePostToolUseSlotAliasHandler() {
  return async function slotAlias(input, toolUseId) {
    const t = input?.tool_input;
    if (!t || typeof t !== 'object') return {};
    const body = JSON.stringify(input?.tool_response ?? '');

    // 派发：演员位 → 结果里的 agentId 就是这个实例的真身。名字有两个来源：
    // ① tool_input.name（schema 宽松线传得出）②派发闸推断后 noteToolCaller 记在
    // 本次 toolUseId 上的名字（⛔ PostToolUse 拿到的是模型原始入参，闸的 updatedInput
    // 不在里面 —— 08-28 泉此方场实锤：推断路径落盘全成 rp-actor，就是这里只看了①）。
    if (isSlotType(t.subagent_type)) {
      let nm = (typeof t.name === 'string' && ROLE_SLUG_RE.test(t.name) && !isSlotType(t.name)) ? t.name : null;
      if (!nm) {
        const c = callerOf(toolUseId || input?.tool_use_id);
        if (c?.agentType && ROLE_SLUG_RE.test(c.agentType) && !isSlotType(c.agentType)) nm = c.agentType;
      }
      if (nm) {
        const m = AGENT_ID_RE.exec(body);
        if (m) noteAgentName(m[1], nm);
      }
      return {};
    }
    // 唤醒：按名寄信的恢复结果 → 重新学（覆盖重启后别名表清零的窗口）
    if (typeof t.to === 'string' && ROLE_SLUG_RE.test(t.to) && !isSlotType(t.to)) {
      const m = RESUMED_RE.exec(body);
      if (m) noteAgentName(m[1], t.to);
    }
    return {};
  };
}
