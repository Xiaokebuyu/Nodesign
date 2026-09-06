/**
 * mcp/tools/get-pending-changes.js — get_pending_changes MCP tool
 *
 * 用户在 canvas 上的"直接编辑（双击文本改字）"和"评论"会被前端 push 到
 * workspace/pending-changes.json。下次用户发 chat 消息时，turn.js 在
 * composeUserMessage 里 prepend 一个 system 提示告诉 agent "有 N 处变更，
 * 可调本工具查看详情"。agent 决定要不要拉详情。
 *
 * pending-changes.json schema：
 *   {
 *     items: [{
 *       id: string,
 *       kind: 'edit' | 'comment'
 *           | 'pending-move' | 'pending-style' | 'pending-duplicate' | 'pending-delete'
 *           | 'applied-move' | 'applied-style' | 'applied-duplicate',
 *       anchor: { dataId, path, textHint, bbox },
 *       aiContext: { tag, role?, pageInfo?, outerHtml?, computed?, siblings?,
 *                    targetContainerTag?, alignmentHints? },
 *       diff?: { oldText, newText },                          // edit 时有
 *       text?: string,                                        // comment 时有
 *       move?: { container: anchor, before: anchor|null },    // pending-move / -duplicate 时有
 *       styleDelta?: { left?, top?, marginLeft?, ... },       // pending-style 时有
 *       reactMount?: boolean,                                  // 涉及 React mount 区→改 JSX 源码
 *       ts: ISO,
 *     }]
 *   }
 *
 * 2026-05-12 新增 4 个 pending-* kind（画布拖移工具产物）：
 *   - pending-move      用户拖动元素跨/内容器；按 move.container + move.before 改 DOM 树位置
 *   - pending-duplicate 用户 alt-drag 复制；先 clone source 再插入 target
 *   - pending-style     用户 nudge / 调对齐；按 styleDelta 改 inline style 或 class
 *   - pending-delete    用户按 Del 删元素；按 anchor 删 source 节点
 *
 *  reactMount=true 的 item 走 `<script id="__nd-app">` 里的 JSX 改动（不是改 HTML 段）。
 *
 * 2026-07-29 新增 applied-* kind（站点窗拖拽直接落盘）：用户在站点页拖完，
 * 前端已把整页序列化写回文件 —— 这些是 FYI 记录（applied:true），**不要再应用一遍**，
 * 只用来理解用户动了什么；有 path 字段指明改的是哪份文件。
 *
 * 拉完后建议调 mcp__nodesign__clear_pending_changes 清 buffer，避免重复处理。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/** 一次调用最多附几张圈选截图（更早的留路径让 agent 按需自己读） */
const MAX_REGION_SHOTS = 3;

/**
 * @param {object} deps
 * @param {string} deps.workspaceRoot
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeGetPendingChangesTool({ workspaceRoot, ctx: _ctx }) {
  return tool(
    'get_pending_changes',
    `Read the user's pending changes buffer — a list of direct edits, inline
comments, and drag-tool moves the user made on the canvas in between chat
turns.

When to use:
- You see a <system>用户在过去时段做了 N 处变更...</system> hint at the top
  of the user's message → call this tool to read the actual changes.
- The user references "the change I just made" / "the edit I did" / "the move
  I just did" → check the buffer first.

Each item has:
- kind: one of
    'edit'             (user changed text by double-clicking in the canvas —
                        ALREADY saved to the file; informational)
    'comment'          (user wrote a comment for an element)
    'pending-move'     (user dragged an element to a new container/position)
    'pending-duplicate'(user alt-dragged to copy an element to a new spot)
    'pending-style'    (user nudged / adjusted alignment → inline style delta)
    'pending-delete'   (user deleted an element)
    'applied-move' / 'applied-style' / 'applied-duplicate'
                       (user dragged inside a site page window — the frontend
                        ALREADY serialized the page and wrote it to the file.
                        Do NOT re-apply these; they are FYI so you know what
                        the user changed. You may tidy the source afterwards
                        — e.g. lift baked inline left/top into the stylesheet —
                        but only if asked or clearly beneficial.)
- path (optional): which file the change belongs to (workspace-relative, e.g. about.html or 稿件/about.html).
  Absent = the artifact you are currently working on.
- anchor: stable element reference (dataId / path / textHint / bbox)
- aiContext: element role, page info, outerHTML, computed styles, siblings,
             plus targetContainerTag / alignmentHints for moves
- diff (edit): { oldText, newText }
- becameEmpty (edit): true means the user CLEARED that text. The element is still
  in the source and still takes up vertical space — usually you should delete the
  whole element, not just leave it empty. Ask if you are unsure.
- text (comment): the comment body
- linkedToEditId (comment, optional): when present, this comment is a follow-up
  instruction tied to another pending edit (e.g. "for that drag I just did, keep
  the neighbor element fixed"). Always read the linked edit and treat them as
  one combined operation; both get cleared together.
- move (pending-move / pending-duplicate): { container: anchor, before: anchor|null }
- styleDelta (pending-style): { left?, top?, marginLeft?, ... }
- reactMount: when true, the change touches a React mount subtree → modify
              the JSX inside <script id="__nd-app"> rather than the static HTML

'region-comment' items are different in shape — the user lassoed an AREA of
the preview rather than clicking one element:
- region: { x, y, w, h } in page CSS px, and viewport: the size they saw it at
- elements: what sits inside that box, innermost-first, each with anchor / tag /
  a text excerpt / its own rect / coverage (how much of it the box covers).
  Containers much larger than the box are deliberately excluded — the user was
  pointing at what's inside, not at the wrapper.
- container: the innermost element that fully encloses the box — i.e. WHERE on
  the page this is. The elements list alone can't tell you header from footer.
- text: what they said about it (may be empty — the box itself is the message)
- shot: a screenshot of that area (plus a little margin), attached to this
  tool result as an image right after the JSON. Look at it: it is the ground
  truth of what the user was looking at, and the elements list is only an
  index into it.
- docxPage (present when path is a .docx): the user lassoed on a rendered page
  image of a word document — docxPage is the 1-based page number, region is in
  page-image pixels, and there are NO elements/container (a page image has no
  DOM). The shot is cropped from the same LibreOffice page render the user was
  looking at. To act on it, edit the token JSON source and rebuild with
  build_docx — never edit the .docx itself.

After processing, call mcp__nodesign__clear_pending_changes to clear the
buffer so subsequent turns don't see the same changes again.`,
    {
      // No params; reading is unconditional.
      _placeholder: z.string().optional().describe('Unused; reserved for future filters'),
    },
    async () => {
      try {
        if (!workspaceRoot) {
          return {
            content: [{ type: 'text', text: 'No workspace bound; cannot read pending changes.' }],
            isError: true,
          };
        }

        const bufPath = path.join(workspaceRoot, 'pending-changes.json');
        let buf = { items: [] };
        try {
          const raw = await fs.readFile(bufPath, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.items)) buf = parsed;
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
          // file doesn't exist = empty buffer
        }

        const items = buf.items;
        if (items.length === 0) {
          return {
            content: [{
              type: 'text',
              text: 'No pending changes. The user has not made any direct edits or comments since the last clear.',
            }],
          };
        }

        const content = [{
          type: 'text',
          text: `Pending changes (${items.length} item${items.length === 1 ? '' : 's'}):\n\n`
            + JSON.stringify(items, null, 2),
        }];

        // 圈选的截图直接挂在结果里 —— 那张图就是用户当时看着的画面，让 agent
        // 再去 Read 一次纯属多一跳，而且它多半不会主动去读。
        // 只带最近 MAX_REGION_SHOTS 张：一次拉出十张图，token 全烧在这上面。
        const shots = items.filter(it => it.kind === 'region-comment' && it.shot);
        const attach = shots.slice(-MAX_REGION_SHOTS);
        for (const it of attach) {
          try {
            const buf = await fs.readFile(path.join(workspaceRoot, it.shot));
            content.push({ type: 'text', text: `↓ 圈选 ${it.id}（${it.path}）用户框住的那一块：`
              + (it.shotNote ? `\n${it.shotNote}（所以这张图不等于用户当时看到的画面）` : '') });
            content.push({ type: 'image', data: buf.toString('base64'), mimeType: 'image/webp' });
          } catch (err) {
            content.push({
              type: 'text',
              text: `圈选 ${it.id} 的截图读不到（${err?.code || err?.message}）—— 按 elements 清单和 region 坐标处理。`,
            });
          }
        }
        if (shots.length > attach.length) {
          content.push({
            type: 'text',
            text: `另有 ${shots.length - attach.length} 张更早的圈选截图没有附上（一次最多 ${MAX_REGION_SHOTS} 张）。`
              + `需要的话按 item 里的 shot 路径自己 Read。`,
          });
        }

        return { content };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `get_pending_changes failed: ${err?.message || String(err)}`,
          }],
          isError: true,
        };
      }
    },
  );
}
