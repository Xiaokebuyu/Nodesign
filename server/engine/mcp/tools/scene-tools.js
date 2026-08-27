/**
 * mcp/tools/scene-tools.js —— 场务三件（2026-08-27，编排）
 *
 *   set_scene   GM 声明这出戏怎么调度（模式 / 发言顺序 / 自己的戏份）
 *   read_scene  谁都能看当前的场（角色想知道轮到谁）
 *   pass_turn   角色这一拍不想说，轮次跳过它（用户拍板要的「跳过对话的工具」）
 *
 * 状态和机器都在 engine/agent/scene.js；这里只是工具皮 + 权限守卫 + 广播。
 * nd:rp-prompt —— 描述与话术属于 RP 教义。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { byOf } from '../actor.js';
import { isResidentRole } from '../../agent/cast.js';
import { setScene, getScene, passTurn } from '../../agent/scene.js';
import { Events } from '../../agent/events.js';

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

function renderScene(s) {
  if (!s) return '还没设过场（free 语义：谁被叫到谁说）。';
  const lines = [
    `模式：${s.mode}`,
    s.order.length ? `顺序：${s.order.join(' → ')}` : '顺序：（未排）',
    `GM 戏份：${s.gm}`,
    s.turnSlug ? `⭐ 此刻轮到：${s.turnSlug}` : '此刻没有进行中的轮次',
  ];
  if (s.note) lines.push(`场记：${s.note}`);
  return lines.join('\n');
}

export function makeSetSceneTool({ projectId, ctx = null }) {
  return tool(
    'set_scene',
    `Declare how this scene is orchestrated (GM only). Fields you pass change; others keep.
mode: solo (one role 1v1, GM offstage) | free (whoever is addressed speaks) |
rounds (strict turn order — the ONLY mode with machinery: when the user speaks to someone
in the order, each role after them gets cued automatically once the previous one finishes
its beat) | directed (you cue each beat yourself).
order: speaking order for rounds — you pick it, you know the characters' temperaments.
gm: your own part — narrator | offstage | referee. Declare it and stick to it.
Change scene at scene boundaries, not mid-beat.`,
    {
      mode: z.enum(['solo', 'free', 'rounds', 'directed']).optional(),
      order: z.array(z.string().max(80)).max(12).optional()
        .describe('Speaking order (role slugs like rp-mo-li), used by rounds'),
      gm: z.enum(['narrator', 'offstage', 'referee']).optional(),
      note: z.string().max(500).optional().describe('One line: what scene is this (shown to user)'),
    },
    async (args, extra) => {
      if (byOf(extra) !== 'agent') {
        return text('只有主控能设场。你是台上的角色 —— 对场有意见就在戏里说，或 SendMessage 跟主控提。', true);
      }
      if (!projectId) return text('No project bound.', true);
      try {
        const { scene, warn } = setScene(projectId, args);
        try { ctx?.emit?.(Events.scene(scene)); } catch { /* fail-soft */ }
        return text(`${renderScene(scene)}${warn ? `\n⚠️ ${warn}` : ''}`);
      } catch (err) {
        return text(err.message, true);
      }
    },
  );
}

export function makeReadSceneTool({ projectId }) {
  return tool(
    'read_scene',
    'Read the current scene declaration: mode, speaking order, whose turn it is.',
    { _: z.string().max(1).optional().describe('(no arguments)') },
    async () => {
      if (!projectId) return text('No project bound.', true);
      return text(renderScene(getScene(projectId)));
    },
  );
}

export function makePassTurnTool({ projectId, ctx = null }) {
  return tool(
    'pass_turn',
    `Skip your beat in a rounds scene (roles only). Use it when your character genuinely
would not speak right now — silence is a valid move. The turn passes to the next role.
Not for leaving the stage: to keep listening, call await_user after this as usual.`,
    { _: z.string().max(1).optional().describe('(no arguments)') },
    async (_args, extra) => {
      const me = byOf(extra);
      if (!isResidentRole(me)) {
        return text('pass_turn 是台上角色的工具。你是主控 —— 轮次本来就不点你。', true);
      }
      if (!projectId) return text('No project bound.', true);
      const { scene, msg } = passTurn(projectId, me);
      if (scene) { try { ctx?.emit?.(Events.scene(scene)); } catch { /* fail-soft */ } }
      return text(msg);
    },
  );
}
