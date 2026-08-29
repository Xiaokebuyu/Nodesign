/**
 * hooks/slot-alias.js —— 唤醒时重新认一遍角色的 agent_id（2026-08-28 建；08-29 收窄）
 *
 * 派发那条路 08-29 搬去 `SubagentStart`（harness 亲手给 id，不解析文本，见
 * resident-role-lifecycle.js 的 makeSubagentStartRoleAlias）。这里只剩**唤醒**一条：
 * `SendMessage({to:"rp-x"})` 的结果 JSON 带 `resumedAgentId`，服务器重启后别名表
 * 清零、而角色还活着时，靠这一条重新学回来。
 *
 * 匹配用正则怼序列化文本而不是解构对象：tool_response 的形状（数组/对象/字符串）
 * 随 SDK 版本漂，id 的形状（十六进制串）比包装稳定得多。
 */

import { isSlotType, ROLE_SLUG_RE } from '../cast.js';
import { noteAgentName } from '../actor-trail.js';

// 引号写成 \\?"：结果 JSON 常作为字符串再被包一层（stringify 转义成 \"），两层都认
const RESUMED_RE = /\\?"resumedAgentId\\?"\s*:\s*\\?"([0-9a-f]{8,32})\\?"/;

export function makePostToolUseSlotAliasHandler() {
  return async function slotAlias(input) {
    const t = input?.tool_input;
    if (!t || typeof t !== 'object') return {};
    // 按名寄信的恢复结果 → 重新学（覆盖重启后别名表清零的窗口）
    if (typeof t.to === 'string' && ROLE_SLUG_RE.test(t.to) && !isSlotType(t.to)) {
      const m = RESUMED_RE.exec(JSON.stringify(input?.tool_response ?? ''));
      if (m) noteAgentName(m[1], t.to);
    }
    return {};
  };
}
