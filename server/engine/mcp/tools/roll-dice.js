/**
 * mcp/tools/roll-dice.js —— roll_dice：服务端真随机骰（2026-08-28，沉浸感机制刀①）
 *
 * ## 为什么必须是工具
 *
 * 「明骰」此前是教义（GM 手写骰表），骰子本身却只能由模型**编一个数** ——
 * 玩家一旦意识到骰运是编的，跑团的信任根基当场塌掉。这里用 crypto 真随机投，
 * 结果同时走两条路：工具返回给 GM（写进正文与骰表），`run.dice` 事件直达前端
 * （用户看到与 GM 笔无关的第一手骰面 —— 明骰才真的"明"）。
 *
 * 只注册给 GM（不进角色工具白名单）：判定归后台的笔，角色要检定就在故事里喊。
 * 参数 ASCII（feedback-ascii-tool-params）。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import crypto from 'node:crypto';

/** 判定结果一句话（纯函数可断言）。nd:rp-prompt */
export function describeRoll({ label, n, sides, modifier, advantage, rolls, kept, total, dc }) {
  const adv = advantage === 'adv' ? '（优势取高）' : advantage === 'dis' ? '（劣势取低）' : '';
  const mod = modifier ? (modifier > 0 ? `+${modifier}` : `${modifier}`) : '';
  const faces = rolls.length > 1 ? `[${rolls.join(', ')}]` : `[${rolls[0]}]`;
  const crit = sides === 20 && n === 1
    ? (kept === 20 ? ' —— **自然 20**，给它一个镜头' : kept === 1 ? ' —— **自然 1**，给它一个镜头' : '')
    : '';
  const vs = dc != null ? ` vs DC ${dc} —— ${total >= dc ? '**成功**' : '**失败**'}` : '';
  return `🎲 ${label}：${n}d${sides}${mod}${adv} → ${faces}${mod ? ` ${mod}` : ''} = **${total}**${vs}${crit}`;
}

export function makeRollDiceTool({ projectId, ctx = null, rngInt = crypto.randomInt } = {}) {
  return tool(
    'roll_dice',
    `Roll real server-side dice (cryptographic RNG) for a check. The result also fires a
run.dice event straight to the user's screen — open dice the GM's pen cannot fake, which
is the whole point: never make up a roll yourself. After rolling: write the outcome into
the beat (a TRPG-style hint beats reporting raw numbers) and log it in the 明骰表.
Failure buys information or a cost; success buys a new problem — never a flat nothing.`,
    {
      label: z.string().min(1).max(60)
        .describe('What this check is, shown to the user (e.g. "斥候·侦查" or "哥布林·突袭")'),
      sides: z.number().int().min(2).max(1000).default(20).optional().describe('Die faces (default 20)'),
      n: z.number().int().min(1).max(20).default(1).optional().describe('How many dice (default 1)'),
      modifier: z.number().int().min(-100).max(100).default(0).optional().describe('Flat bonus/malus added to the total'),
      advantage: z.enum(['none', 'adv', 'dis']).default('none').optional()
        .describe('adv = roll twice keep high, dis = keep low (n must be 1)'),
      dc: z.number().int().min(1).max(1000).optional().describe('Difficulty class; result line says success/failure'),
    },
    async (args, _extra) => {
      if (!projectId) return { content: [{ type: 'text', text: 'No project bound.' }], isError: true };
      const sides = args.sides ?? 20;
      const n = args.n ?? 1;
      const modifier = args.modifier ?? 0;
      const advantage = args.advantage ?? 'none';
      if (advantage !== 'none' && n !== 1) {
        return { content: [{ type: 'text', text: 'advantage/disadvantage 只对单骰（n=1）有意义。' }], isError: true };
      }
      const rolls = [];
      const times = advantage === 'none' ? n : 2;
      for (let i = 0; i < times; i += 1) rolls.push(rngInt(1, sides + 1));
      const kept = advantage === 'adv' ? Math.max(...rolls)
        : advantage === 'dis' ? Math.min(...rolls)
          : null;
      const total = (advantage === 'none' ? rolls.reduce((a, b) => a + b, 0) : kept) + modifier;
      const outcome = args.dc != null ? (total >= args.dc ? 'success' : 'failure') : null;
      const line = describeRoll({
        label: args.label, n, sides, modifier, advantage,
        rolls, kept: kept ?? rolls[0], total, dc: args.dc ?? null,
      });
      // 明骰直达用户（fail-soft：事件坏了不拦骰）—— 这条是"骰子可信"的另一半
      try {
        ctx?.emit?.({
          type: 'run.dice', sessionId: null,
          label: args.label, sides, n, modifier, advantage,
          rolls, total, ...(args.dc != null ? { dc: args.dc, outcome } : {}),
        });
      } catch { /* fail-soft */ }
      return { content: [{ type: 'text', text:
        `${line}\n（用户已在屏幕上看到这一骰 —— 正文按结果写后果，骰表记一行。）` }] };
    },
  );
}
