/**
 * mcp/tools/role-inbox.js —— 角色的收件箱工具（2026-08-26，块 4）
 *
 * 两件工具，只发给常驻角色（见 cast.js 的白名单）：
 *   await_user   挂着等用户下一句（角色的回合不结束 —— 这是「像主 agent 一样对话」的形态）
 *   check_inbox  顺手看一眼有没有积压，不等
 *
 * ## 为什么是角色来取，不是我们推给它
 *
 * SDK 没有「给某个子代理投消息」的接口，子代理唯一的入口 `SendMessage` 是**工具**，
 * 服务端调不了。把方向反过来（角色主动来取）就绕开了这条限制，而且不用主 agent 转发
 * ——转发要烧它一个回合，它还会忍不住加戏。
 *
 * ## 后台角色为什么调得到这两件
 *
 * 后台子代理的**内置**工具被 CLI 剥得只剩六件（AskUserQuestion 也在被剥之列），
 * 但 **MCP 工具豁免**（过滤链最前面 `name.startsWith("mcp__")` 无条件放行，2026-08-26
 * 读源码 + 实测双证）。所以「角色问用户话」这件事只能是我们自己的 MCP 工具，
 * 不能指望 AskUserQuestion。
 *
 * nd:rp-prompt —— 工具描述与返回话术属于 RP 教义，等提示词层专门过一遍时一起调。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { waitFor, drain, queueDepth } from '../../agent/inbox.js';
import { byOf } from '../actor.js';
import { isResidentRole } from '../../agent/cast.js';

/** 等待上限。挂太久没意义（用户早走了），太短又逼角色反复轮询 */
const WAIT_MIN_S = 30;
const WAIT_MAX_S = 900;      // 15 分钟
const WAIT_DEFAULT_S = 300;

function renderMessages(items) {
  return items.map((m, i) => {
    const head = items.length > 1 ? `【${i + 1}/${items.length}】` : '';
    const where = m.about ? `（关于 ${m.about}）` : '';
    return `${head}用户说${where}：${m.text}`;
  }).join('\n');
}

/** 两件工具共用的守卫：只有常驻角色有收件箱 */
function guard(extra) {
  const me = byOf(extra);
  if (!isResidentRole(me)) {
    return { me: null, err: '只有常驻角色有收件箱。你是主控 —— 用户的话本来就直接进你的对话。' };
  }
  return { me, err: null };
}

export function makeAwaitUserTool({ projectId }) {
  return tool(
    'await_user',
    `Wait for the user's next message to YOU (this character), then continue.

This is how you hold a conversation with the user directly: finish a beat, write it on the
board, then call this and wait. Your turn stays open while you wait, so the reply comes
straight back to you — the main agent is not involved and does not see it.

Returns the user's words, or "(nobody said anything)" when the wait runs out. Timing out is
NOT an error: decide whether to wait again, write something else, or end your turn. If you
end your turn, later messages queue up until someone wakes you — so prefer waiting while a
scene is live.`,
    {
      seconds: z.number().int().min(WAIT_MIN_S).max(WAIT_MAX_S).optional()
        .describe(`How long to wait, ${WAIT_MIN_S}-${WAIT_MAX_S}s (default ${WAIT_DEFAULT_S}).`),
    },
    async (args, extra) => {
      const { me, err } = guard(extra);
      if (err) return { content: [{ type: 'text', text: err }], isError: true };
      if (!projectId) return { content: [{ type: 'text', text: 'No project bound.' }], isError: true };

      const seconds = Math.min(WAIT_MAX_S, Math.max(WAIT_MIN_S, args.seconds || WAIT_DEFAULT_S));
      const items = await waitFor(projectId, me, seconds * 1000);
      if (!items.length) {
        return { content: [{ type: 'text', text:
          `（等了 ${seconds} 秒，没人说话。）这不是错误 —— 你可以接着等、`
          + `先在板上写点别的，或者结束回合待命（待命期间用户的话会积压，等你下次被叫醒才看得到）。` }] };
      }
      return { content: [{ type: 'text', text: renderMessages(items) }] };
    },
  );
}

export function makeCheckInboxTool({ projectId }) {
  return tool(
    'check_inbox',
    `Check whether the user said anything to you while you were busy. Does not wait.

Use it when you were woken for some other reason and want to catch up before writing.
To actually hold a conversation, use await_user instead.`,
    { _: z.string().max(1).optional().describe('(no arguments)') },
    async (_args, extra) => {
      const { me, err } = guard(extra);
      if (err) return { content: [{ type: 'text', text: err }], isError: true };
      if (!projectId) return { content: [{ type: 'text', text: 'No project bound.' }], isError: true };

      const items = drain(projectId, me);
      if (!items.length) return { content: [{ type: 'text', text: '收件箱是空的。' }] };
      return { content: [{ type: 'text', text: `${renderMessages(items)}\n（还剩 ${queueDepth(projectId, me)} 条）` }] };
    },
  );
}
