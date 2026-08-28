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
import { waitFor, drain, queueDepth, emptyStreakOf } from '../../agent/inbox.js';
import { byOf } from '../actor.js';
import { Events } from '../../agent/events.js';
import { isResidentRole } from '../../agent/cast.js';
import { onRoleWait } from '../../agent/scene.js';

/** 等待上限。挂太久没意义（用户早走了），太短又逼角色反复轮询 */
const WAIT_MIN_S = 30;
const WAIT_MAX_S = 900;      // 15 分钟
const WAIT_DEFAULT_S = 300;

/**
 * 连着这么多次没人说话就散场（用户拍板 N=2）。
 *
 * ⚠️ 这不是省 token 的优化，是**唯一的散场闸**：角色循环挂 await_user 会给会话续命
 * （见 inbox.js 的 emptyStreakOf 注释），30 分钟的 idle timeout 永远兜不住它。
 * 默认 300s × 2 ≈ 10 分钟没人理 → 退场，跟 idle 语义大致对齐。
 */
const EMPTY_STREAK_LIMIT = 2;

export function renderMessages(items) {
  return items.map((m, i) => {
    const head = items.length > 1 ? `【${i + 1}/${items.length}】` : '';
    // from:'scene'/'stage' 是机器（轮次机 cue / 台上广播），不是用户的话 ——
    // 冒充用户口吻会让角色对空气回话，话术已在源头写成旁观视角，原样给
    if (m.from === 'scene' || m.from === 'stage') return `${head}${m.text}`;
    // from:'gm' 是主控点名（cue_role）—— 标清来源，别让角色当成用户在说话
    if (m.from === 'gm') return `${head}主控（GM）：${m.text}`;
    const where = m.about ? `（关于 ${m.about}）` : '';
    // 落痕指针（2026-08-27 solo 画布对话）：用户这句已经以他的署名落在板上了，
    // 回帖 reply_to 它，对话在板上才是一条双声道的线
    const echo = m.echo ? `\n（这句已落在板上：${m.echo} —— 回帖时 write_on_board 用 reply_to 指它，线就接上了。）` : '';
    return `${head}用户说${where}：${m.text}${echo}`;
  }).join('\n');
}

/**
 * 等空了该跟角色说什么。抽成纯函数是为了**能被断言** —— 这段字是角色唯一会读到的
 * 行为指令，措辞错一次的症状是「用户关了标签页，进程空转一整夜」，没有任何报错。
 *
 * nd:rp-prompt —— 散场话术属于 RP 教义
 * ⛔ 别再把「结束回合待命」写成平级选项：那是**唯一会让角色失联**的选择
 *（收了回合服务端就投不进去了，只有模型的 SendMessage 能叫醒它）。
 */
export function emptyWaitMessage(slug, seconds, streak) {
  if (streak < EMPTY_STREAK_LIMIT) {
    return `（等了 ${seconds} 秒，没人说话。第 ${streak}/${EMPTY_STREAK_LIMIT} 次。）`
      + `这不是错误。**别结束回合** —— 场还开着，你一收回合用户就够不到你了。\n`
      + `想推进就在板上写一段（有理由才写，没理由就别硬编），然后**再调一次 await_user 接着等**。`;
  }
  return `（等了 ${seconds} 秒，连着 ${streak} 次没人说话。）**散场吧。**\n`
    + `把这一段收个尾（该落板的落板），然后结束回合。主控会收到通知，`
    + `知道用 SendMessage 寄给「${slug}」就能把你叫回来，你的记忆不会丢。`;
}

/** 两件工具共用的守卫：只有常驻角色有收件箱 */
function guard(extra) {
  const me = byOf(extra);
  if (!isResidentRole(me)) {
    return { me: null, err: '只有常驻角色有收件箱。你是主控 —— 用户的话本来就直接进你的对话。' };
  }
  return { me, err: null };
}

export function makeAwaitUserTool({ projectId, ctx = null }) {
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
      // 挂上/离开都要发：角色挂着的时候事件流是**静默**的，不发这条，画布分不出
      // 「在等」和「死了」，侧栏也分不出「台上有人」和「对话被占用」。
      try { ctx?.emit?.(Events.roleWait(me, true)); } catch { /* fail-soft */ }
      // 轮次机：重新挂上（且没积压）= 这一拍说完了 → 机器 cue 下一个（scene.js）
      try {
        const sc = onRoleWait(projectId, me, true);
        if (sc) ctx?.emit?.(Events.scene(sc));
      } catch { /* 机器坏了不拦角色等人 */ }
      let items;
      try {
        items = await waitFor(projectId, me, seconds * 1000);
      } finally {
        try { ctx?.emit?.(Events.roleWait(me, false)); } catch { /* fail-soft */ }
      }
      if (!items.length) {
        return { content: [{ type: 'text', text:
          emptyWaitMessage(me, seconds, emptyStreakOf(projectId, me)) }] };
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
