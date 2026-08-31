/**
 * mcp/tools/pin_to_board — 把一件东西摆到用户画布上的某个位置。
 *
 * 写 board.json（board-store 单锁原子操作，与前端 PATCH 互不覆盖），然后广播
 * board.updated（sessionId: null → project 全连接都收到，前端整份重拉）。
 *
 * 物件 id 约定（与前端 BoardCanvas 派生一致）：**id = kind 前缀 + 工作区相对路径**
 *   - 普通文件（图片 / 便签 / 数据）：路径本身，`assets/generated/a.webp`
 *   - deck：`deck:<路径>`，如 `deck:稿件/主稿.html`
 *   - 站点：`site:<目录>`
 *
 * ## 2026-08-13：这个工具的职权范围缩小了
 *
 * 以前它有个 `zone` 参数，语义是"放进哪块工作区"。**在 id = 路径的模型下这件事
 * 不成立** —— 一个物件属于哪个文件夹，答案就写在它的路径里。让工具单独写一个
 * "显式归属"字段，等于允许画布说"它在 A 文件夹"而磁盘说"它在 B 文件夹"，
 * 正是 2026-07-28 把「拖出工作区解绑」停用掉的那个理由（两边对不上，且很容易
 * 误触）。要换文件夹就 `mv` —— 那是真的搬，画布跟着走。
 *
 * 所以现在它只剩一件事：**给这件东西一个位置并置顶**（"把它摆到用户眼前"）。
 *
 * ⚠️ 顺带修掉的两个僵尸：`zone` 原来被校验成 `/^[A-Za-z0-9-]{8,64}$/`（= 一个
 * sessionId），于是任何中文文件夹名、任何带斜杠的嵌套路径都过不了，一律静默
 * 回落到 sessionId —— 然后在 board.json 里新建一块根本不存在的"工作区"。
 * agent 每帮一次忙就制造一条死数据。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import path from 'path';
import { promises as fs } from 'fs';
import { pinToZone, readBoard, patchBoard } from '../../../projects/board-store.js';
import { layerOf, bareTag } from '../../../lib/canvas-id.js';
import { applyFollows } from '../../../lib/board-follow.js';
import { currentSheet, slotRectOf, nextSpotInSlot, placeAtOnSheet } from '../../../lib/board-sheets.js';
import { estimateSizeOn } from '../../../lib/board-kind-sizes.js';
import { currentSheetIdOf } from '../../../lib/sheet-state.js';
import { cardIdForPath, KIND_PREFIX_RE } from '../../../lib/kinds/index.js';

// （folderOfObjectId 08-24 拆除：它按 dirname 硬算，会给 assets/generated 这类
//  前端不当层渲染的路径发"层"标签 —— 改问 layerOf + board.zones，跟渲染同口径）

/**
 * @param {object} deps
 * @param {string} [deps.sharedRoot]   工作区根（校验文件存在用）
 * @param {string} [deps.projectId]
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makePinToBoardTool({ sharedRoot, projectId, sessionId = null, ctx }) {
  return tool(
    'pin_to_board',
    `Bring an item to the front of the user's canvas, at a free spot in whatever
folder it lives in. The canvas is their desktop: whatever you write appears
there automatically — you do NOT need this tool for your own outputs.
Use it only to deliberately surface something:

- Place a staged arrival: new files land on the staging shelf (the vertical
  strip of unplaced cards the status block names) — pin_to_board{path, slot}
  moves one into a block you planned
- Pull a reference (an uploaded asset, a memory note, an older image) into view
- Restore something the user dragged off-screen, when they ask for it back

This does NOT change which folder the item belongs to — that is decided by
where the file is on disk. To move it, \`mv\` the file; the canvas follows.

Paths are workspace-relative, exactly as they are on disk. Accepted forms:
- any file path: 'assets/generated/hero.webp', 'notes/灵感.md', '稿件/数据.csv'
- a deck: 'deck:<path>.html'   a site: 'site:<dir>'
  (a bare '<path>.html' is read as a deck)`,
    {
      path: z
        .string()
        .min(1)
        .max(300)
        .describe('Item to surface — see accepted forms in the tool description'),
      slot: z.string().max(40).optional()
        .describe('Drop it into a planned block on the current sheet (names from open_sheet / read_board). This is how a produced file lands where you planned it instead of wherever there was room.'),
      at: z.object({ x: z.number(), y: z.number() }).optional()
        .describe('Exact spot on the sheet, pixels from its top-left writable corner. Use slot unless this one file needs a precise place.'),
      sheet: z.string().max(40).optional()
        .describe('Which sheet (default: the one you are working on)'),
      tag: z.string().max(40).optional()
        .describe('Put it in a group. Produced files (images, sites, docx) are never created by you, so this is the one place they can get a tag at all — and a tag is what follow{group_tag,target_tag} matches on, on both ends.'),
    },
    async ({ path: rawPath, slot, at, sheet, tag }) => {
      try {
        if (!projectId) {
          return { content: [{ type: 'text', text: 'No project bound; cannot pin.' }], isError: true };
        }

        // 归一化成前端物件 id（id = kind 前缀 + 工作区相对路径）
        let objectId = String(rawPath).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
        if (!objectId || objectId.includes('..')) {
          return { content: [{ type: 'text', text: 'Invalid path.' }], isError: true };
        }
        if (!KIND_PREFIX_RE.test(objectId)) {
          // 裸路径：先确认它在磁盘上，再问**正字法卡 id 是什么**。
          // ⛔ 这里原来是 `if (/\.html?$/i.test(objectId)) objectId = 'deck:'+objectId`
          //    —— 只认 .html 的一句猜测。.docx 因此停在裸路径，而裸 id 在前端
          //    根本不渲染（assets.js 的 docxClaimedFiles 把它滤掉了），工具却照样
          //    报「Placed ... at (x,y)」，连它身上的关系线也一条画不出来。
          //    单页站更阴：裸 .html 会被提升成 deck:，可它的正字法是 site:。
          //    现在一律交给 kinds/index.js 的 cardIdForPath（注册表 + 产物扫描）。
          if (sharedRoot) {
            const abs = path.join(sharedRoot, objectId);
            try { await fs.access(abs); } catch {
              return {
                content: [{ type: 'text', text: `File not found: ${objectId}. Paths are workspace-relative, same as on disk.` }],
                isError: true,
              };
            }
            const canonical = await cardIdForPath(sharedRoot, objectId);
            if (canonical) objectId = canonical;
          }
        }

        // 可见性预检（08-21 案：钉 assets/ 深处的图报成功，用户画布上根本没有）。
        // 画布扫描只认 assets 顶层 / assets/generated / assets/notes 这三个口，
        // 更深的（references/web/… 之类）有座位也不渲染 —— 钉了等于没钉。
        if (/^assets\//.test(objectId)
          && !/^assets\/[^/]+$/.test(objectId)
          && !/^assets\/(generated|notes)\/[^/]+$/.test(objectId)) {
          return {
            content: [{
              type: 'text',
              text: `${objectId} 在画布扫描范围之外（assets/ 只有顶层、generated/、notes/ 三个口上墙），pin 了用户也看不到。`
                + '先把文件 cp 到工作区根或某个文件夹里再 pin（用户要看的素材放看得见的地方）。',
            }],
            isError: true,
          };
        }
        // 层归属按**真实存在的层**算（'' 或 zones 里的文件夹）——跟前端渲染同口径。
        // dirname 硬算的老写法会把 assets/generated 当层写进 zone，arrange 就此拒摆
        const boardNow = await readBoard(projectId);
        const zoneId = layerOf(objectId, null, new Set(Object.keys(boardNow.zones || {})));

        /**
         * 点名落位（2026-08-30 刀 G）：`slot` / `at` 给了就走纸上落位，跟 write_on_board
         * 同一套几何。这是「产物也由 agent 规划位置」的那只手 —— 暂存架上的东西，
         * agent 规划出地方之后就用它请下来（seat 改写成 agent，自然离架）。
         */
        if (slot || at) {
          const sh = (sheet && boardNow.sheets?.[sheet])
            ? { id: sheet, ...boardNow.sheets[sheet] }
            : currentSheet(boardNow, currentSheetIdOf(sessionId));   // 会话正写的那张优先
          if (!sh) {
            return { content: [{ type: 'text', text: 'No sheet yet — open_sheet first (plan the page, then place things into its blocks).' }], isError: true };
          }
          const box = estimateSizeOn(boardNow, objectId, boardNow.objects?.[objectId] || null);
          let spot = null; let where = '';
          if (slot) {
            const rect = slotRectOf(sh, slot);
            if (!rect) {
              const names = Object.keys(sh.slots || {});
              return { content: [{ type: 'text', text: names.length
                ? `Sheet ${sh.id} has no slot "${slot}". It has: ${names.join(', ')}.`
                : `Sheet ${sh.id} has no slots planned. Plan the page first: open_sheet{plan:[{slot,at,w,h,about}…]}.` }], isError: true };
            }
            const p = nextSpotInSlot(boardNow, rect, box);
            if (p.tooWide) {
              return { content: [{ type: 'text', text: `⛔ Slot "${slot}" on sheet ${sh.id} is only ${p.freeW}px wide — ${objectId} is a ${p.needW}px-wide card and would spill ${p.needW - p.freeW}px into whatever is next to it. `
                + 'Nothing moved. Re-plan that block wider (replan it by name, omit at — it resizes in place), or point it at another slot.' }], isError: true };
            }
            if (p.full) {
              return { content: [{ type: 'text', text: `⛔ Slot "${slot}" on sheet ${sh.id} is full — ${objectId} needs ${box.h}px, ~${p.freeH}px left. `
                + 'Nothing moved. Re-plan the page with a taller block, or point it at another slot.' }], isError: true };
            }
            spot = p; where = ` in slot "${slot}"`;
          } else {
            const p = placeAtOnSheet(sh, at, box);
            spot = p; where = p.clamped ? ' (clamped into the sheet)' : '';
          }
          /**
           * ⛔ 摆到纸上 = 摆到**根层**，zone 必须写 ''（不是文件所在的文件夹层）。
           *
           * spot 是 nextSpotInSlot 在根层纸矩形里算出来的**世界坐标**；zone 写成
           * 文件夹层的话，这两个字段当场互相矛盾：前端 dirOf 按 zone 把它渲染进
           * 那个文件夹里（世界坐标在那儿是没意义的局部坐标），根层画布上根本
           * 看不见它 —— 而工具还报了「Placed on sheet p3 in slot refs at (24,2941)」。
           *
           * 更实的后果：rootObjects 只收根层，membersInRect 跟着看不见它，于是
           * **下一件 pin 进同一个版位的东西算出来还是同一个坐标**。真案
           * proj_mtg61or1 19:18 连 pin 五张官方参考图，后四张全落 (24,3405)，
           * 工具四次都报 success。对照组（同样五张放根层）落点正常且装不下时
           * 如实报「版位满」。
           *
           * 把文件夹里的文件 pin 到纸上，语义就是把它拎到桌面上摆着 —— 跟用户
           * 从文件夹里拖一张卡出来是同一件事（前端注释：拖出来的写 ''）。
           */
          const prev = boardNow.objects?.[objectId] || {};
          const nextPending = (boardNow.pending || []).filter(r => r !== objectId && `deck:${r}` !== objectId && `site:${r}` !== objectId);
          await patchBoard(projectId, {
            objects: { [objectId]: {
              ...prev, x: Math.round(spot.x), y: Math.round(spot.y), w: Math.round(box.w), h: Math.round(box.h),
              zone: '', seat: 'agent', ...(tag ? { tag: bareTag(tag) } : {}),
            } },
            ...(nextPending.length !== (boardNow.pending || []).length ? { pending: nextPending } : {}),
          });
          // 产物也能当跟随目标（2026-08-31）：带 tag 落板 = 这个 tag 有新成员，
          // 跟 write_on_board 写一条带 tag 的板书是同一件事。fail-soft。
          if (tag) { try { await applyFollows(projectId, { tag: bareTag(tag), newId: objectId }); } catch { /* */ } }
          try {
            ctx?.emit?.({ type: 'board.updated', sessionId: null, objectId, zoneId: '', summary: `已把 ${objectId} 摆到 ${sh.id}${where}` });
          } catch { /* emit fail-safe */ }
          return { content: [{ type: 'text', text: `Placed ${objectId} on sheet ${sh.id}${where} at (${Math.round(spot.x)}, ${Math.round(spot.y)}).`
            + (nextPending.length !== (boardNow.pending || []).length ? ` It is no longer waiting for a spot (${nextPending.length} still are).` : '') }] };
        }

        const { zone: placedZone, placed } = await pinToZone(projectId, { objectId, zoneId });

        try {
          ctx?.emit?.({
            type: 'board.updated',
            sessionId: null,          // project 级广播：显式压掉 ctx 的 sessionId enrich
            objectId,
            zoneId,
            summary: zoneId ? `已把 ${objectId} 摆到「${zoneId}」里` : `已把 ${objectId} 摆到桌面上`,
          });
        } catch { /* emit fail-safe */ }

        const where = placedZone?.id ? `in ${placedZone.id}` : 'on the desktop';
        return {
          content: [{
            type: 'text',
            text: `Surfaced ${objectId} ${where} at (${placed.x}, ${placed.y}). The user's canvas updates live.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `pin_to_board failed: ${err.message}` }], isError: true };
      }
    },
  );
}
