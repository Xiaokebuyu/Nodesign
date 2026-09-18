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
import { estimateSizeOn, RUNTIME_SINGLETONS } from '../../../lib/board-kind-sizes.js';
import { layerOf, bareTag } from '../../../lib/canvas-id.js';
import { relationsDigest, bindingLine } from '../../../lib/board-relations.js';
import { asciiMinimap, bboxOfRects } from '../../../lib/board-groups.js';
import { laneSummaries } from '../../../lib/board-lanes.js';

import { rollCardRect } from '../../../lib/board-place.js';
import { boardLineage } from '../../../lib/lineage.js';
import { outlineOf } from '../../../lib/board-outline.js';
import { historyCounts } from '../../../lib/chalk-history.js';
import { getViewpoint } from '../../../projects/viewpoint-store.js';
import { chalkExcerpts, CHALK_DIR } from '../../../lib/chalk.js';
import { getSharedDir } from '../../../projects/workspace.js';
import { promises as fs } from 'node:fs';
import { byOf, describeBy } from '../actor.js';
import { listRoleNames } from '../../agent/role-card.js';
import path from 'node:path';
import { GENERATED_DIR, GENERATED_TITLE } from '../../../lib/generated-folder.js';

/** 同一"行"的 y 容差：入座算法一行内顶对齐，40 世界像素内视作同行 */
const ROW_TOLERANCE = 40;

function describeEntry(board, id, entry, glyph = null, excerpts = null, staleIds = null, view = null) {
  // view = { by: 当前读者, names: slug→展示名 }。读 read_board 的可能是主 agent，
  // 也可能是常驻角色 —— 同一句「你写的」对两个读者含义相反，所以称呼要带视角。
  const who = (b) => describeBy(b || 'agent', view?.by || 'agent', view?.names);
  const mine = (b) => (b || 'agent') === (view?.by || 'agent');
  const sz = estimateSizeOn(board, id, entry);
  // 位置按关系说（09-11）：像素只在 coords:true 时给 —— 读到像素的 agent 会在坐标系里推算（那条「离组 600+px」的误报就是这么来的）
  const at = view?.coords ? ` @(${Math.round(entry.x)},${Math.round(entry.y)}) ${Math.round(sz.w)}x${Math.round(sz.h)}` : '';
  const g = glyph ? `[${glyph}] ` : '';
  // 谱系收叠（09-17）：旧版叠在这张身后，用户看不见；点名给出，要看旧版直接 Read 路径
  const hist = view?.history?.get(id);
  const olds = view?.stacks?.get(id);
  const stacked = olds?.length ? ` 〔身后叠着 ${olds.length} 个旧版：${olds.slice(0, 4).join('、')}${olds.length > 4 ? ' 等' : ''}〕` : '';
  const flags = `${entry.staging ? ' 〔草稿〕' : ''}${entry.tag ? ` #${entry.tag}` : ''}${hist ? ` 〔历史 ${hist} 版〕` : ''}${stacked}`;
  const ch = excerpts?.get(id);
  if (ch) return `- ${g}[板书·${who(ch.by)}写的] 「${ch.first}」${at} (path: ${id})${ch.anchor ? ` 关于 ${ch.anchor}` : ''}${ch.replyTo ? ` 回应 ${ch.replyTo}` : ''}${flags}`;
  if (entry.kind === 'text') {
    const t = String(entry.data?.t || '').replace(/\s+/g, ' ').slice(0, entry.data?.format === 'md' ? 60 : 24);
    const md = entry.data?.format === 'md' ? 'md' : '手写';
    return `- ${g}[${md}] 「${t}」${at} (id: ${id})${entry.by ? ` ·${who(entry.by)}写的` : ''}${flags}`;
  }
  if (entry.kind === 'scribble') return `- ${g}[涂鸦]${at} (id: ${id})${entry.by ? ` ·${who(entry.by)}画的` : ''}${flags}`;
  // 过期座位要明说（iss_mt38ucyq：旧路径条目被 agent 当"失效卡"差点建议删素材母版）
  // 09-14：确实删掉了的要给出口（edit_board remove 只摘座位），但「搬走了」那种仍以磁盘为准、别据此去删文件
  const stale = staleIds?.has(id) ? ' 〔⚠️磁盘上已无此路径 —— 被移动/改名的以磁盘上的新位置为准，别据此去删任何文件；确实删掉了就 edit_board remove 摘掉这个座位（只摘座位）〕' : '';
  return `- ${g}${id}${at}${entry.by ? ` ·${who(entry.by)}摆的` : ''}${flags}${stale}`;
  // eslint-disable-next-line no-unused-vars -- mine 留给后续按视角过滤用
}

export function makeReadBoardTool({ projectId, sharedRoot = null }) {
  return tool(
    'read_board',
    `Read the workbench canvas as an OUTLINE: what hangs under what (a reply under the note it
answers, a note under the thing it is about, the next beat of a thread under the previous one),
then relation lines. Notes that were rewritten carry 〔历史 N 版〕 — the older wording lives in
notes/板书/.history/<same name>; read the first 60 lines of that file (or Grep it) only when the
user asks about it or you need their earlier words.

Use this BEFORE moving things (edit_board) or writing/sketching (write_on_board) —
placement without looking is guessing. Positions are described as RELATIONS — reading order,
how many columns a group has, which group sits right of / below which — the same language you
place and move things in (place:{by,side,with}); coords:true adds raw world pixels, for debugging
only. Only seated items appear (files you just wrote are seated automatically within a couple of seconds).
Items marked 〔草稿〕 are still staging (yours from this turn, half-transparent until
edit_board commit / end of turn). The user's current viewport (if known) is drawn as a box
on the minimap and listed with what is inside it.`,
    {
      layer: z.string().max(300).optional()
        .describe("Folder path to read ('' or omitted = the root desktop plus a folder list)"),
      tag: z.string().max(40).optional()
        .describe('Only list items/lines carrying this #tag (one group, e.g. a sketch you made)'),
      minimap: z.boolean().optional().describe('Also print an ASCII minimap (off by default — the relative-position summary is usually enough)'),
      coords: z.boolean().optional().describe('Also print world-pixel positions (debugging only — nothing you call takes pixels)'),
    },
    async ({ layer, tag: rawTag, minimap, coords = false }, extra) => {
      const tag = rawTag ? bareTag(rawTag) : rawTag;   // #状态板 也认（查询侧统一剥 #）
      // 视角：谁在读这块板。常驻角色读到自己写的板书才该显示「你写的」，
      // 读到别人的显示那个人的名字（展示名只是渲染，判断一律用 slug）。
      const view = { by: byOf(extra), names: await listRoleNames(sharedRoot), coords };
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

      // 根层的谱系收叠跟前端同口径（默认收起）：被叠住的旧版不逐件列，挂在现役版那一行
      const lineage = want ? null : boardLineage(board);
      view.stacks = lineage?.olds;
      const lines = [];
      const root0 = getSharedDir(projectId);
      const excerpts = await chalkExcerpts(root0, (byLayer.get(want) || []).map(it => it.id));
      const items = (byLayer.get(want) || [])
        .filter(({ entry }) => !tag || entry.tag === tag)
        // 收卷（2026-08-27 收纳器）：收着的组不逐件列 —— 版图里压成一行，这是 agent
        // 上下文的收纳（跟画布收纳同一刀）。显式 tag= 点名看某组时照常展开列。
        .filter(({ entry }) => tag || !entry.tag || !board.rolls?.[entry.tag])
        // 板书条目但文件已经没了 = 幽灵座位，别列给 agent（删文件那条路会清座位，这是兜底）
        .filter(({ id }) => !id.startsWith(`${CHALK_DIR}/`) || excerpts.has(id))
        .filter(({ id }) => !lineage?.hidden.has(id))
        .sort((a, b) => (a.entry.y - b.entry.y) || (a.entry.x - b.entry.x));
      // 改写过的板书标「历史 N 版」（09-17 刀二）：旧正文在 .history/ 同名文件里
      const histByName = await historyCounts(path.resolve(root0, CHALK_DIR),
        items.map(({ id }) => id).filter(id => id.startsWith(`${CHALK_DIR}/`)).map(id => id.slice(CHALK_DIR.length + 1)));
      view.history = new Map([...histByName].map(([name, n]) => [`${CHALK_DIR}/${name}`, n]));
      // 座位 vs 磁盘对账（iss_mt38ucyq）：文件挪走后旧座位可能还挂几十秒
      // （改名对账/前端回写有时差）。查一遍真身，过期的在条目上点名。
      const root = root0;
      const staleIds = new Set();
      await Promise.all(items.map(async ({ id, entry }) => {
        if (entry.kind === 'text' || entry.kind === 'scribble' || RUNTIME_SINGLETONS.has(id)) return;
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

      lines.push(want ? `文件夹「${want}」的大纲（谁挂在谁下面）${tag ? `（只看 #${tag}）` : ''}：` : `桌面（根层）的大纲（谁挂在谁下面）${tag ? `（只看 #${tag}）` : ''}：`);
      if (!items.length) {
        lines.push('（这一层还没有摆过的东西）');
      } else {
        if (mini && minimap) {
          lines.push(`小地图（一格≈${mini.cell}px，左上=(${mini.bbox.x},${mini.bbox.y})，范围 ${mini.bbox.w}x${mini.bbox.h}${vpRect ? '，┌┐└┘ 框=用户视口' : ''}）：`);
          lines.push(mini.grid);
        }
        // 大纲（09-17 板书树刀一）：按父子关系印，先根后子、同辈按阅读序。
        // 座次表回答「谁在哪」，回答不了「这块板在说什么、说到哪」，而且随时间变长。
        const whole = bboxOfRects(rects);
        if (whole && coords) lines.push(`这一层内容范围：(${Math.round(whole.x)},${Math.round(whole.y)}) ${Math.round(whole.w)}x${Math.round(whole.h)}${vpRect ? `；用户视口 (${Math.round(vpRect.x)},${Math.round(vpRect.y)}) ${Math.round(vpRect.w)}x${Math.round(vpRect.h)}` : ''}`);
        const rows = outlineOf(items, { excerpts, bindings: board.bindings || {} });
        for (const r of rows) {
          const line = describeEntry(board, r.id, r.entry, glyphOf.get(r.id), excerpts, staleIds, view);
          lines.push(`${'  '.repeat(Math.min(r.depth, 8))}${line}`);
        }
      }
      if (!want && !tag) {
        const folders = Object.keys(board.zones || {}).sort();
        if (folders.length) {
          lines.push('', `文件夹卡：${folders.map(f => {
            const zz = board.zones[f];
            const name = f === GENERATED_DIR ? `${f}（${GENERATED_TITLE}）` : f;
            return coords ? `${name}@(${Math.round(zz.x)},${Math.round(zz.y)})` : name;
          }).join('、')}`);
        }
      }
      if (board.hero && !tag) lines.push('', `★ 显式主角：${board.hero}（edit_board 的 feature/unfeature 管它）`);

      // 还没入座的到货（入座器一轮封顶截流的那几件）：点名即可，位置由 pin_to_board{place} 定
      if (!want && !tag) {
        const pend = Array.isArray(board.pending) ? board.pending : [];
        if (pend.length) lines.push('', `📦 ${pend.length} 件到货还没上墙：${pend.slice(0, 6).join('、')}${pend.length > 6 ? '…' : ''} —— pin_to_board{path, place:{by:…}} 请它们上来。`);
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
                + `${rc && coords ? `，卷卡占位约 @(${rc.x},${rc.y}) ${rc.w}x${rc.h}` : ''}`
                + ` —— 座位和文件都在（Read 照常），edit_board unroll 展开；别往收着的线里接新话`);
              continue;
            }
            const dirTxt = '';
            lines.push(l.registered
              ? `  #${l.tag}：${l.count} 节${l.parent ? `，岔自 ${l.parent}` : ''}${coords ? `，列头 (${l.x},${l.y})` : ''}`
                + `${l.frontier ? (coords ? `，接着写会落 (${l.frontier.x},${l.frontier.y}) 附近` : '，接着写会落在最新一节下面') : ''}${l.lastId ? `，最新 ${l.lastId}` : ''}${dirTxt}`
              : `  #${l.tag}：${l.count} 件（未登记的线，仍可用 chain:true 续写）${dirTxt}`);
          }
        }
      }

      // 用户视点（有上报才有）
      if (vp && !tag) {
        const inside = vpRect ? rects.filter(r =>
          !(r.x + r.w < vpRect.x || r.x > vpRect.x + vpRect.w || r.y + r.h < vpRect.y || r.y > vpRect.y + vpRect.h))
          .map(r => r.id) : [];
        const bits = [];
        if (vpRect) bits.push(coords ? `视口 (${Math.round(vpRect.x)},${Math.round(vpRect.y)}) ${Math.round(vpRect.w)}x${Math.round(vpRect.h)} 缩放 ${vp.zoom ?? '?'}` : `缩放 ${vp.zoom ?? '?'}`);
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

      lines.push('', '（口径：稀疏表只列摆过的；缩进=谁挂在谁下面（回应/注/同一条线的后一节）；位置按关系说，coords:true 才给像素；'
        + '层归属为服务端近似；尺寸=存档真值优先、缺了按形态估；改自链的旧版叠在现役版身后不单列；'
        + '角色精灵贴着该角色最新一条板书（那条四周留了 60px 身位）；带⚠️的条目=座位与磁盘对不上账）');
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}
