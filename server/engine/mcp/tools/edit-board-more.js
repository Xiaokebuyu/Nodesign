/**
 * edit-board-more.js —— edit_board 09-18 并进来的五个操作
 *
 * 站主 09-18：「要不要把现有的 board 编辑工具都整合到 edit_board 里？pin_to_board 并不是很必要，
 * 完全可以作为 edit_board 中的一个参数」。整合之后画布这一族剩四个工具：写（write_on_board）、
 * 改（edit_board）、读（read_board）、看（look_at_board）。
 *
 *   pin          原 pin_to_board：把已有文件摆上画布 / 拎出文件夹（真搬，引用跟着改）；多了 paths[] 一次排一排
 *   into_folder  原 organize_board：真把东西搬进某个文件夹，引用跟着改
 *   set_vars     原 set_vars：只改状态表那几格
 *   add_trend    原 draw_trend：画一条状态值的趋势
 *   arrange      新（站主同日「给 agent 一个很方便的位置调整工具，批量编辑位置」）：几件东西按给定顺序
 *                排成一排 / 一列 / 网格，整块放到某件东西旁边
 *
 * 前四个的主体**没重写**：原工具的处理函数原样留在各自文件里（makePinOp 等），这里只做参数翻译和
 * 报文收拢。它们直接落盘（搬文件、写板），不走 edit_board「最后一次 patch」那条路，做完 refresh 一下
 * 本调用的 live 副本，后面的操作才看得见它们的结果。arrange 走 live 副本，跟 move 一样最后统一落盘。
 */
import { makePinOp } from './pin-to-board.js';
import { makeIntoFolderOp } from './organize-board.js';
import { makeSetVarsOp } from './set-vars.js';
import { makeTrendOp } from './draw-trend.js';
import { readBoard } from '../../../projects/board-store.js';
import { UNIT } from '../../../lib/rect.js';
import { bareTag } from '../../../lib/canvas-id.js';

const textOf = (r) => (r?.content || []).map((c) => c?.text).filter(Boolean).join('\n');
const bare = (id) => String(id).replace(/^[a-z]+:/, '');
const AS_WORD = { row: '一排', column: '一列', grid: '网格' };
/** 演出模式下状态表与趋势图 09-06 已下架（状态归显示器的 vitals / panels；原来是 RP 模式不注册这两个工具） */
const RP_OFF = '演出模式下状态归显示器的 vitals / panels，板上状态表这一族不用（只在设计模式可用）';

/**
 * 排版（纯函数）：按顺序把几个矩形排成一排 / 一列 / 网格，返回相对左上角的偏移和整块尺寸。
 * 网格按列取最宽、按行取最高，格子对齐不挤。
 */
export function arrangeLayout(sizes, as = 'row', cols = null, gap = UNIT) {
  const n = sizes.length;
  if (as === 'row') {
    let x = 0; const at = sizes.map((s) => { const p = { dx: x, dy: 0 }; x += s.w + gap; return p; });
    return { at, w: x - gap, h: Math.max(...sizes.map((s) => s.h)) };
  }
  if (as === 'column') {
    let y = 0; const at = sizes.map((s) => { const p = { dx: 0, dy: y }; y += s.h + gap; return p; });
    return { at, w: Math.max(...sizes.map((s) => s.w)), h: y - gap };
  }
  const c = Math.max(1, Math.min(n, cols || Math.ceil(Math.sqrt(n))));
  const colW = Array.from({ length: c }, (_, j) => Math.max(...sizes.filter((_, i) => i % c === j).map((s) => s.w)));
  const rows = Math.ceil(n / c);
  const rowH = Array.from({ length: rows }, (_, r) => Math.max(...sizes.slice(r * c, r * c + c).map((s) => s.h)));
  const xs = colW.reduce((acc, w, j) => [...acc, j ? acc[j - 1] + colW[j - 1] + gap : 0], []);
  const ys = rowH.reduce((acc, h, r) => [...acc, r ? acc[r - 1] + rowH[r - 1] + gap : 0], []);
  const at = sizes.map((_, i) => ({ dx: xs[i % c], dy: ys[Math.floor(i / c)] }));
  return { at, w: xs[c - 1] + colW[c - 1], h: ys[rows - 1] + rowH[rows - 1] };
}

/**
 * @param {object} deps  { projectId, sharedRoot, sessionId, ctx }
 * @returns {Object<string, (o, env) => Promise<boolean>>}  返回 true = 这一条算成功
 *   env：{ n, fail, report, rid, rectOf, setObj, placeTo, sayWhere, moveHuggers, live, objects, liveZones }
 */
export function makeMoreOps({ projectId, sharedRoot, sessionId = null, ctx, mode = 'design' }) {
  const pinOne = makePinOp({ sharedRoot, projectId, sessionId, ctx });
  const intoFolder = makeIntoFolderOp({ projectId, ctx });
  const setVars = makeSetVarsOp({ projectId, sharedRoot });
  const trend = makeTrendOp({ projectId, sharedRoot, sessionId, ctx });

  /** 直接落了盘的操作之后：live 副本对齐磁盘上的板（本调用里已经改过、还没落盘的不动） */
  const refresh = async (env) => {
    const fresh = await readBoard(projectId);
    for (const k of Object.keys(env.live)) if (!(k in (fresh.objects || {})) && !(k in env.objects)) delete env.live[k];
    for (const [k, e] of Object.entries(fresh.objects || {})) if (!(k in env.objects)) env.live[k] = e;
    Object.assign(env.liveZones, fresh.zones || {});
  };

  return {
    async pin(o, env) {
      const list = o.paths?.length ? o.paths : (o.path ? [o.path] : []);
      if (!list.length) { env.fail('要给 path（一件）或 paths（几件）'); return false; }
      let prev = null; let good = 0;
      for (const [k, p] of list.entries()) {
        // 第一件落在 to 指的地方；后面的一件接一件贴在前一件的右边（as:column 就是下面）
        const place = k > 0 && prev ? { by: prev, side: o.as === 'column' ? 'below' : 'right' } : o.to;
        const r = await pinOne({ path: p, ...(place ? { place } : {}), ...(o.tag ? { tag: o.tag } : {}) });
        if (r?.isError) { env.fail(`${p}：${textOf(r)}`); continue; }
        good += 1; prev = r?.objectId || prev;
        env.report(`· #${env.n} pin ${textOf(r)}`);
      }
      await refresh(env);
      return good > 0;
    },

    async into_folder(o, env) {
      const r = await intoFolder({ items: o.ids.map(bare), into: o.folder, rewrite_refs: o.rewrite_refs });
      await refresh(env);
      if (r?.isError) { env.fail(textOf(r)); return false; }
      env.report(`· #${env.n} into_folder\n${textOf(r)}`);
      return !/^✗/m.test(textOf(r)) || /^✓/m.test(textOf(r));
    },

    async set_vars(o, env) {
      if (mode === 'rp') { env.fail(RP_OFF); return false; }
      const r = await setVars({ vars: o.vars });
      if (r?.isError) { env.fail(textOf(r)); return false; }
      await refresh(env);
      env.report(`· #${env.n} set_vars：${textOf(r)}`);
      return true;
    },

    async add_trend(o, env) {
      if (mode === 'rp') { env.fail(RP_OFF); return false; }
      const r = await trend({ key: o.key, ...(o.to ? { place: { by: o.to.by, side: o.to.side } } : {}) });
      if (r?.isError) { env.fail(textOf(r)); return false; }
      await refresh(env);
      env.report(`· #${env.n} add_trend：${textOf(r)}`);
      return true;
    },

    async arrange(o, env) {
      const ids = []; const missing = [];
      for (const raw of o.ids) { const id = env.rid(raw); if (id && env.live[id]) ids.push(id); else missing.push(raw); }
      if (missing.length) { env.fail(`这几件不在板上：${missing.join('、')}（id 用 read_board 印出来的写法）`); return false; }
      if (new Set(ids).size !== ids.length) { env.fail('ids 里有重复的'); return false; }
      const rects = ids.map((id) => env.rectOf(id));
      const as = o.as || (ids.length > 4 ? 'grid' : 'row');
      const lay = arrangeLayout(rects.map((r) => ({ w: r.w, h: r.h })), as, o.cols || null);
      let origin = { x: rects[0].x, y: rects[0].y }; let where = '留在第一件原来的位置';
      if (o.to) {
        const p = await env.placeTo(o.to, { w: lay.w, h: lay.h }, new Set(ids));
        if (p.error) { env.fail(p.error); return false; }
        origin = { x: p.x, y: p.y }; where = env.sayWhere(p);
      }
      const tag = o.tag ? bareTag(o.tag) : null;
      ids.forEach((id, k) => {
        const e = env.live[id];
        const x = Math.round(origin.x + lay.at[k].dx); const y = Math.round(origin.y + lay.at[k].dy);
        env.moveHuggers(id, x - e.x, y - e.y);
        env.setObj(id, { ...e, x, y, seat: 'agent', ...(tag ? { tag } : {}) });
      });
      env.report(`· #${env.n} arrange：${ids.length} 件排成${AS_WORD[as]}（${Math.round(lay.w)}×${Math.round(lay.h)}）${tag ? `，归进 #${tag}` : ''}，${where}`);
      return true;
    },
  };
}
