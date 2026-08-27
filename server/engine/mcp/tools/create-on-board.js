/**
 * mcp/tools/create-on-board.js —— create_on_board（deprecated 薄别名）
 *
 * 2026-08-27 审计后铲平：原来这里自带第三份 textBox（裸 t.length，无 CJK 加权）
 * 和第七套"撞了往下推"避让循环 —— 是 08-25 落位统一（resolvePlacement）的漏网
 * 之鱼，中文便签走它和走 write_on_board 会得到系统性不同的尺寸和落位。
 *
 * 现在它是**真转发**：一行不留实现，全量转 write_on_board {ink:'hand'}（同一支
 * 手写字，外加救援入座 / 视口落位 / 精灵身位避让整套新机制）。名字留着只为
 * 老会话 resume 不断粮；老默认字体 pen（龙藏手写）原样保留。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export function makeCreateOnBoardTool({ write }) {
  return tool(
    'create_on_board',
    `Deprecated alias — use write_on_board {text, ink:'hand'} (same handwritten note,
plus rescue-seating / viewport placement / sprite avoidance). This name stays for
old sessions only.`,
    {
      text: z.string().min(1).max(200).describe('The note text (≤200 chars, one thought)'),
      near: z.string().max(300).optional()
        .describe('Canvas id to place the note next to'),
      relation: z.object({
        type: z.enum(['annotates', 'link']),
        to: z.string().min(1).max(300),
        label: z.string().max(60).optional(),
      }).optional().describe('Line from the note (label not supported by this alias — use edit_board add_edge for labeled lines)'),
      font: z.enum(['pen', 'kai', 'sans', 'serif', 'mono']).optional()
        .describe('Handwriting style (default pen — same as the user\'s default)'),
      size: z.enum(['sm', 'md', 'lg', 'xl']).optional().describe('Text size (default md)'),
    },
    // ⚠️ extra 必须跟着走：署名从它查（角色写的字要署角色的名）
    async (a, extra) => {
      const r = await write({
        text: a.text, ink: 'hand',
        near: a.near || a.relation?.to || undefined,
        relation: a.relation?.type, font: a.font || 'pen', size: a.size,
      }, extra);
      if (a.relation?.label && !r?.isError && Array.isArray(r?.content)) {
        r.content.push({ type: 'text', text: '（这个 deprecated 别名不画带字的线 —— 要 label 用 edit_board add_edge）' });
      }
      return r;
    },
  );
}
