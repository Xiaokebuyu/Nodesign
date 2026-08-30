/**
 * mcp/tools/read-board.js —— read_board（2026-08-14，agent 摆位批·读侧）
 *
 * 让 agent **看得见版面**。在这之前它对画布的了解只有关系线摘要 —— 每件东西
 * 坐哪、挨着谁、谁是主角，全是盲区，"摆放"无从谈起。这个工具把 board.json
 * 翻译成一张按层分组、按行排读的座次表。
 *
 * 口径说明（都写进输出，agent 不用猜）：
 *   - 只列**摆过的**：board.json 是稀疏表，刚产出还没排座的产物没有条目
 *     （前端首排后几百毫秒内落盘，通常都在）
 *   - 层归属是服务端近似（zone 字段优先，其次沿路径找已知文件夹）
 *   - 尺寸是形态估算（文字/涂鸦用存档实测值）
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { readBoard } from '../../../projects/board-store.js';
import { estimateSizeOn } from '../../../lib/board-kind-sizes.js';
import { layerOf } from '../../../lib/canvas-id.js';
import { relationsDigest, bindingLine } from '../../../lib/board-relations.js';
import { groupObjects, asciiMinimap, bboxOfRects, relationOf, columnsOf, viewportRelation } from '../../../lib/board-groups.js';
import { laneSummaries } from '../../../lib/board-lanes.js';
import { capacityOf, DEFAULT_CHALK_W } from '../../../lib/sketch-layout.js';
import { sheetSummaries, rollCardRect } from '../../../lib/board-sheets.js';
import { getViewpoint } from '../../../projects/viewpoint-store.js';
import { chalkExcerpts, CHALK_DIR } from '../../../lib/chalk.js';
import { getSharedDir } from '../../../projects/workspace.js';
import { promises as fs } from 'node:fs';
import { byOf, describeBy } from '../actor.js';
import { listRoleNames } from '../../agent/role-card.js';
import path from 'node:path';

/** 同一"行"的 y 容差：入座算法一行内顶对齐，40 世界像素内视作同行 */
const ROW_TOLERANCE = 40;

function describeEntry(board, id, entry, glyph = null, excerpts = null, staleIds = null, view = null) {
  // view = { by: 当前读者, names: slug→展示名 }。读 read_board 的可能是主 agent，
  // 也可能是常驻角色 —— 同一句「你写的」对两个读者含义相反，所以称呼要带视角。
  const who = (b) => describeBy(b || 'agent', view?.by || 'agent', view?.names);
  const mine = (b) => (b || 'agent') === (view?.by || 'agent');
  const sz = estimateSizeOn(board, id, entry);
  const at = `@(${Math.round(entry.x)},${Math.round(entry.y)}) ${Math.round(sz.w)}x${Math.round(sz.h)}`;
  const g = glyph ? `[${glyph}] ` : '';
  const flags = `${entry.staging ? ' 〔草稿〕' : ''}${entry.tag ? ` #${entry.tag}` : ''}`;
  const ch = excerpts?.get(id);
  if (ch) return `- ${g}[板书·${who(ch.by)}写的] 「${ch.first}」 ${at} (path: ${id})${ch.anchor ? ` 关于 ${ch.anchor}` : ''}${ch.replyTo ? ` 回应 ${ch.replyTo}` : ''}${flags}`;
  if (entry.kind === 'text') {
    const t = String(entry.data?.t || '').replace(/\s+/g, ' ').slice(0, entry.data?.format === 'md' ? 60 : 24);
    const md = entry.data?.format === 'md' ? 'md' : '手写';
    return `- ${g}[${md}] 「${t}」 ${at} (id: ${id})${entry.by ? ` ·${who(entry.by)}写的` : ''}${flags}`;
  }
  if (entry.kind === 'scribble') return `- ${g}[涂鸦] ${at} (id: ${id})${entry.by ? ` ·${who(entry.by)}画的` : ''}${flags}`;
  // 过期座位要明说（iss_mt38ucyq：旧路径条目被 agent 当"失效卡"差点建议删素材母版）
  const stale = staleIds?.has(id) ? ' 〔⚠️磁盘上已无此路径 —— 多半被移动/改名了，以磁盘为准，别据此判失效或建议删除〕' : '';
  return `- ${g}${id} ${at}${entry.by ? ` ·${who(entry.by)}摆的` : ''}${flags}${stale}`;
  // eslint-disable-next-line no-unused-vars -- mine 留给后续按视角过滤用
}

export function makeReadBoardTool({ projectId, sharedRoot = null }) {
  return tool(
    'read_board',
    `Read the workbench canvas: an ASCII minimap, then GROUPS (things linked by lines or
sharing a #tag), then loose items row by row, then relation lines.

Use this BEFORE moving things (edit_board) or writing/sketching (write_on_board) —
placement without looking is guessing. Coordinates are world pixels. Only seated items
appear (files you just wrote are seated automatically within a couple of seconds).
Items marked 〔草稿〕 are still staging (yours from this turn, half-transparent until
edit_board commit / end of turn). The user's current viewport (if known) is drawn as a box
on the minimap and listed with what is inside it.`,
    {
      layer: z.string().max(300).optional()
        .describe("Folder path to read ('' or omitted = the root desktop plus a folder list)"),
      tag: z.string().max(40).optional()
        .describe('Only list items/lines carrying this #tag (one group, e.g. a sketch you made)'),
      minimap: z.boolean().optional().describe('Also print an ASCII minimap (off by default — the relative-position summary is usually enough)'),
    },
    async ({ layer, tag, minimap }, extra) => {
      // 视角：谁在读这块板。常驻角色读到自己写的板书才该显示「你写的」，
      // 读到别人的显示那个人的名字（展示名只是渲染，判断一律用 slug）。
      const view = { by: byOf(extra), names: await listRoleNames(sharedRoot) };
      if (!projectId) {
        return { content: [{ type: 'text', text: 'No project bound.' }], isError: true };
      }
      const board = await readBoard(projectId);
      const known = new Set(Object.keys(board.zones || {}));
      const want = typeof layer === 'string' ? layer : '';

      // 分层
      const byLayer = new Map();
      for (const [id, entry] of Object.entries(board.objects || {})) {
        if (!Number.isFinite(entry?.x) || !Number.isFinite(entry?.y)) continue;
        const l = layerOf(id, entry, known);
        if (!byLayer.has(l)) byLayer.set(l, []);
        byLayer.get(l).push({ id, entry });
      }

      const lines = [];
      const excerpts = await chalkExcerpts(getSharedDir(projectId), (byLayer.get(want) || []).map(it => it.id));
      const items = (byLayer.get(want) || [])
        .filter(({ entry }) => !tag || entry.tag === tag)
        // 收卷（2026-08-27 收纳器）：收着的组不逐件列 —— 版图里压成一行，这是 agent
        // 上下文的收纳（跟画布收纳同一刀）。显式 tag= 点名看某组时照常展开列。
        .filter(({ entry }) => tag || !entry.tag || !board.rolls?.[entry.tag])
        // 板书条目但文件已经没了 = 幽灵座位，别列给 agent（删文件那条路会清座位，这是兜底）
        .filter(({ id }) => !id.startsWith(`${CHALK_DIR}/`) || excerpts.has(id))
        .sort((a, b) => (a.entry.y - b.entry.y) || (a.entry.x - b.entry.x));
      const entryOf = new Map(items.map(it => [it.id, it.entry]));
      // 座位 vs 磁盘对账（iss_mt38ucyq）：文件挪走后旧座位可能还挂几十秒
      // （改名对账/前端回写有时差）。查一遍真身，过期的在条目上点名。
      const root = getSharedDir(projectId);
      const staleIds = new Set();
      await Promise.all(items.map(async ({ id, entry }) => {
        if (entry.kind === 'text' || entry.kind === 'scribble' || id === 'browse') return;
        const bare = String(id).replace(/^(deck|site|docx):/, '');
        if (!bare || bare.includes('..') || /^(text|scribble|b):/.test(bare)) return;
        try { await fs.access(path.resolve(root, bare)); } catch { staleIds.add(id); }
      }));

      // 小地图（用户视口画框）
      const vp = getViewpoint(projectId);
      const vpRect = (vp && (vp.layer || '') === want && vp.camera) ? vp.camera : null;
      const rects = items.map(({ id, entry }) => ({ id, x: entry.x, y: entry.y, ...estimateSizeOn(board, id, entry) }));
      const mini = asciiMinimap(rects, { viewport: vpRect });
      const glyphOf = new Map(mini ? mini.legend : []);

      lines.push(want ? `文件夹「${want}」的座次${tag ? `（只看 #${tag}）` : ''}：` : `桌面（根层）的座次${tag ? `（只看 #${tag}）` : ''}：`);
      if (!items.length) {
        lines.push('（这一层还没有摆过的东西）');
      } else {
        if (mini && minimap) {
          lines.push(`小地图（一格≈${mini.cell}px，左上=(${mini.bbox.x},${mini.bbox.y})，范围 ${mini.bbox.w}x${mini.bbox.h}${vpRect ? '，┌┐└┘ 框=用户视口' : ''}）：`);
          lines.push(mini.grid);
        }
        // 组：连通分量 + tag；≥2 件的才叫组，单件归「散件」按行列
        const groups = groupObjects(items.map(it => it.id), board.bindings || {}, id => entryOf.get(id)?.tag || null);
        const real = groups.filter(g => g.members.length >= 2);
        const loose = groups.filter(g => g.members.length < 2).flatMap(g => g.members);
        // 相对位置总览：每组的包围盒、列数、相对前一组/用户视口在哪（阅读顺序：先左后右、先上后下）
        const rectOf = new Map(rects.map(r => [r.id, r]));
        const boxes = real.map(g => bboxOfRects(g.members.map(id => rectOf.get(id)).filter(Boolean)));
        const whole = bboxOfRects(rects);
        if (whole) lines.push(`这一层内容范围：(${Math.round(whole.x)},${Math.round(whole.y)}) ${Math.round(whole.w)}x${Math.round(whole.h)}${vpRect ? `；用户视口 (${Math.round(vpRect.x)},${Math.round(vpRect.y)}) ${Math.round(vpRect.w)}x${Math.round(vpRect.h)}` : ''}`);
        if (real.length) {
          lines.push('各组位置（新东西默认排在已有内容的右侧或下方，顺着先左后右、先上后下的阅读顺序）：');
          real.forEach((g, i) => {
            const b = boxes[i]; if (!b) return;
            const tags = [...g.tags].map(t => `#${t}`).join(' ') || `组 ${i + 1}`;
            const cols = columnsOf(g.members.map(id => rectOf.get(id)).filter(Boolean));
            const bits = [`(${Math.round(b.x)},${Math.round(b.y)}) ${Math.round(b.w)}x${Math.round(b.h)}`, cols.length > 1 ? `${cols.length} 列（${cols.map(c => c.n).join('/')} 件）` : '单列'];
            if (i > 0 && boxes[0]) bits.push(`在 ${[...real[0].tags].map(t => `#${t}`).join(' ') || '组 1'} 的${relationOf(boxes[0], b)}`);
            const vr = viewportRelation(vpRect, b); if (vr) bits.push(vr);
            lines.push(`  ${tags}：${bits.join('；')}`);
          });
        }
        real.forEach((g, i) => {
          const tags = [...g.tags].map(t => `#${t}`).join(' ');
          const staging = g.members.every(id => entryOf.get(id)?.staging);
          lines.push('', `组 ${i + 1}${tags ? ` ${tags}` : ''}（${g.members.length} 件 ${g.edges.length} 线${staging ? '，草稿' : ''}）：`);
          const sorted = g.members.map(id => ({ id, entry: entryOf.get(id) }))
            .sort((a, b) => (a.entry.y - b.entry.y) || (a.entry.x - b.entry.x));
          for (const { id, entry } of sorted) lines.push(describeEntry(board, id, entry, glyphOf.get(id), excerpts, staleIds, view));
          for (const bid of g.edges.slice(0, 12)) lines.push(`    ${bindingLine(board.bindings[bid], board)} (line id: ${bid})`);
          if (g.edges.length > 12) lines.push(`    …还有 ${g.edges.length - 12} 条线`);
        });
        if (groups.cross?.length) {
          lines.push('', '组间线：');
          for (const bid of groups.cross.slice(0, 12)) lines.push(`    ${bindingLine(board.bindings[bid], board)} (line id: ${bid})`);
        }
        if (loose.length) {
          lines.push('', real.length ? '散件：' : '');
          let rowY = null;
          const sorted = loose.map(id => ({ id, entry: entryOf.get(id) }))
            .sort((a, b) => (a.entry.y - b.entry.y) || (a.entry.x - b.entry.x));
          for (const { id, entry } of sorted) {
            if (rowY === null || Math.abs(entry.y - rowY) > ROW_TOLERANCE) {
              rowY = entry.y;
              lines.push(`— 行 y≈${Math.round(rowY)} —`);
            }
            lines.push(describeEntry(board, id, entry, glyphOf.get(id), excerpts, staleIds, view));
          }
        }
      }
      if (!want && !tag) {
        const folders = Object.keys(board.zones || {}).sort();
        if (folders.length) {
          lines.push('', `文件夹卡：${folders.map(f => {
            const zz = board.zones[f];
            return `${f}@(${Math.round(zz.x)},${Math.round(zz.y)})`;
          }).join('、')}`);
        }
      }
      if (board.hero && !tag) lines.push('', `★ 显式主角：${board.hero}（edit_board 的 feature/unfeature 管它）`);

      // 纸的清单（2026-08-29 纸范式）：agent 的空间账本 —— 每张纸的名字/位置/件数/
      // 剩余空地。at 坐标以当前纸版心左上为原点，这一节就是坐标系的地图。
      if (!want && !tag) {
        try {
          const ss = sheetSummaries(board);
          if (ss.length) {
            lines.push('', '纸（sheet）：at:{x,y} 写的是纸内像素（版心左上为原点）；写满自动翻纸，新话题 open_sheet：');
            for (const s of ss) {
              // 剩多少地方按**字**报（08-29 刀 D）：agent 手里的东西是字，
              // 只给像素等于让它每次落笔前做一道做不准的算术
              const cap = capacityOf(DEFAULT_CHALK_W, s.freeH);
              lines.push(`  ${s.id}${s.title ? `（${s.title}）` : ''}：世界 (${s.x},${s.y}) ${s.w}x${s.h}，${s.count} 件，剩 ~${s.freeH}px 高（≈${cap.lines} 行 / ${cap.cjk} 字）${s.lastId ? `，最新 ${s.lastId}` : ''}`);
            }
          }
        } catch { /* 纸读不出不挡座次 */ }
      }

      // 版图（2026-08-27 空间规划）：线 = 同 tag 的纵列。这是 agent 的符号地图 ——
      // 摆放按关系（续哪条线/岔自哪条）声明，几何机器排，别按坐标猜。
      if (!tag) {
        const laneList = laneSummaries(board);
        if (laneList.length) {
          lines.push('', '线的清单（一条线 = 同一个 tag 的一纵列；{tag,chain:true} 接着写，open_lane 开新的一条）：');
          for (const l of laneList) {
            // 收着的线一行带过：细节不进上下文（要看就 read_board tag= 点名，或 unroll）
            const roll = board.rolls?.[l.tag];
            if (roll) {
              const rc = rollCardRect(board, l.tag);
              lines.push(`  #${l.tag}：已收卷${roll.label ? `（「${roll.label}」）` : ''}，${l.count} 件收在卷里`
                + `${rc ? `，卷卡占位约 @(${rc.x},${rc.y}) ${rc.w}x${rc.h}` : ''}`
                + ` —— 座位和文件都在（Read 照常），edit_board unroll 展开；别往收着的线里接新话`);
              continue;
            }
            const dirTxt = '';
            lines.push(l.registered
              ? `  #${l.tag}：${l.count} 节${l.parent ? `，岔自 ${l.parent}` : ''}，列头 (${l.x},${l.y})`
                + `${l.frontier ? `，接着写会落 (${l.frontier.x},${l.frontier.y}) 附近` : ''}${l.lastId ? `，最新 ${l.lastId}` : ''}${dirTxt}`
              : `  #${l.tag}：${l.count} 件（未登记的野线 —— chain:true 照样能续）${dirTxt}`);
          }
        }
      }

      // 用户视点（有上报才有）
      if (vp && !tag) {
        const inside = vpRect ? rects.filter(r =>
          !(r.x + r.w < vpRect.x || r.x > vpRect.x + vpRect.w || r.y + r.h < vpRect.y || r.y > vpRect.y + vpRect.h))
          .map(r => r.id) : [];
        const bits = [];
        if (vpRect) bits.push(`视口 (${Math.round(vpRect.x)},${Math.round(vpRect.y)}) ${Math.round(vpRect.w)}x${Math.round(vpRect.h)} 缩放 ${vp.zoom ?? '?'}`);
        if (vp.openWindow) bits.push(`开着窗：${vp.openWindow}${vp.openPage ? `（${vp.openPage}）` : ''}`);
        if (vp.selected?.length) bits.push(`选中：${vp.selected.slice(0, 8).join('、')}`);
        if (inside.length) bits.push(`视口里有：${inside.slice(0, 12).join('、')}${inside.length > 12 ? ' 等' : ''}`);
        const age = Math.round((Date.now() - (vp.at || 0)) / 1000);
        lines.push('', `用户此刻（${age}s 前上报）：${bits.join('；') || '只知道在看这一层'}`);
      }

      if (!tag) {
        try {
          const digest = await relationsDigest(projectId, { limit: 16 });
          if (digest) lines.push('', '关系线：', digest);
        } catch { /* 关系读不到不挡座次 */ }
      }

      lines.push('', '（口径：稀疏表只列摆过的；层归属为服务端近似；尺寸=存档真值优先、缺了按形态估；'
        + '角色精灵贴着该角色最新一条板书（那条四周留了 60px 身位）；带⚠️的条目=座位与磁盘对不上账）');
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}
