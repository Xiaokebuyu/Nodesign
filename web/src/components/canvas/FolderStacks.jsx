import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronUp } from 'lucide-react';
import { COLOR, FONT_SANS, FONT_MONO, FONT_SIZE, GAP, RADIUS } from '../../lib/theme.js';
import { PAPER } from '../../lib/paper.js';
import { FOLDER_CARD } from '../../lib/board-geometry.js';
import { sizeOf } from '../../lib/board-kinds.js';
import { STACK_AXES, autoAxis, stackGroups, latestFirst } from '../../lib/folder-stacks.js';

/**
 * FolderStacks —— 文件夹窗里的归堆（2026-09-18，站主定「按类型与时间自动归堆，都给」）
 *
 * 借的是 macOS 桌面叠放：一堆只露最上面那张（最近的一件）加件数，点一下摊开，摊开的那堆
 * 独占几行、带一个「收起」。分组本体是纯函数（lib/folder-stacks.js），这里只管三件事：
 *   - 这个文件夹按哪根轴叠（件数少不叠；用户在工具栏换过的记在本机，下次打开照旧）
 *   - 哪几堆摊开着（换文件夹、换轴就全收起）
 *   - 把「堆」和「摊开的堆」排进 FolderWindow 那套 packRow 网格
 */

const PREF_KEY = (dir) => `nd:folder-stack:${dir}`;
const readPref = (dir) => { try { return localStorage.getItem(PREF_KEY(dir)); } catch { return null; } };
const writePref = (dir, v) => { try { localStorage.setItem(PREF_KEY(dir), v); } catch { /* 存不了就只管这一次 */ } };

/** 堆底下那行字的高度（字在卡的外面：卡自带 z 层级，字压在卡里会被盖住） */
const LABEL_H = 22;
/** 摊开那堆的标题行高 */
const HEADER_H = 30;

export function useFolderStacks(dir, items) {
  const [picked, setPicked] = useState({});           // dir → 用户这次挑的轴
  const [open, setOpen] = useState(() => new Set());   // 摊开着的堆
  const axis = picked[dir] || readPref(dir) || autoAxis(items);
  const groups = useMemo(() => stackGroups(items, axis), [items, axis]);
  useEffect(() => { setOpen(new Set()); }, [dir, axis]);

  const setAxis = useCallback((a) => { writePref(dir, a); setPicked((p) => ({ ...p, [dir]: a })); }, [dir]);
  const toggle = useCallback((key) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  }), []);

  /** 工具栏上那一组（两件以上才有得叠） */
  const toolbarGroup = useMemo(() => (items.length > 1 ? {
    id: 'stack',
    type: 'mode',
    value: axis,
    onChange: setAxis,
    items: STACK_AXES.map((a) => ({ id: a.id, label: a.label, title: a.id === 'none' ? '平铺，按名字排' : `${a.label}归成几堆，最近的在最上面` })),
  } : null), [items.length, axis, setAxis]);

  return { axis, groups, open, toggle, toolbarGroup };
}

/**
 * 排进网格的格子：folder / object / pile（收着的一堆）/ header（摊开那堆的标题行）。
 * 只有一堆的时候不叠（叠了等于多点一下），直接按那堆的顺序（最近在前）平铺。
 */
export function stackCells({ folders, items, groups, open, fullW }) {
  const cells = folders.map((z) => ({ kind: 'folder', z, w: FOLDER_CARD.w, h: FOLDER_CARD.h }));
  const obj = (o, extra = {}) => { const sz = sizeOf(o); return { kind: 'object', o, w: sz.w, h: sz.h, ...extra }; };
  if (!groups || groups.length < 2) {
    const list = groups ? latestFirst(items) : items;
    return [...cells, ...list.map((o) => obj(o))];
  }
  let breakNext = false;
  for (const g of groups) {
    if (open.has(g.key) || g.items.length === 1) {
      cells.push({ kind: 'header', g, w: fullW, h: HEADER_H, breakBefore: true, single: g.items.length === 1 });
      g.items.forEach((o) => cells.push(obj(o)));
      breakNext = true;
    } else {
      const sz = sizeOf(g.items[0]);
      cells.push({ kind: 'pile', g, o: g.items[0], w: sz.w, h: sz.h + LABEL_H, breakBefore: breakNext });
      breakNext = false;
    }
  }
  return cells;
}

/** 收着的一堆：最近那张照常画（同一个 renderObject），身后两张错开的纸，点一下摊开 */
export function PileCell({ cell, pos, renderObject, onOpen }) {
  const { g, o } = cell;
  const h = cell.h - LABEL_H;
  const sheet = (d) => ({
    position: 'absolute', left: pos.x + d, top: pos.y + d, width: cell.w, height: h,
    background: PAPER.paper, borderRadius: RADIUS.md, boxShadow: '0 1px 3px rgba(43,33,23,0.18)',
  });
  const stop = (e) => { e.stopPropagation(); e.preventDefault(); };
  return (
    <div
      data-folder-stack={g.key}
      title={`${g.label} · ${g.items.length} 件 · 点开`}
      // 捕获阶段截住：这一下是「摊开这堆」，不是点最上面那张卡
      onClickCapture={(e) => { stop(e); onOpen(g.key); }}
      onDoubleClickCapture={stop}
      onPointerDownCapture={(e) => e.stopPropagation()}
      style={{ cursor: 'pointer' }}
    >
      {g.items.length > 2 && <div style={sheet(8)} />}
      <div style={sheet(4)} />
      {renderObject(o, pos)}
      <div style={{
        position: 'absolute', left: pos.x, top: pos.y + h + 6, width: cell.w,
        display: 'flex', justifyContent: 'space-between', gap: GAP.xs,
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text2,
      }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.label}</span>
        <span style={{ fontFamily: FONT_MONO, color: COLOR.sub, flexShrink: 0 }}>{g.items.length} 件</span>
      </div>
    </div>
  );
}

/** 摊开那堆的标题行（只有一件的堆没有「收起」可言） */
export function StackHeader({ cell, pos, onClose }) {
  const { g } = cell;
  return (
    <div
      data-folder-stack-header={g.key}
      style={{
        position: 'absolute', left: pos.x, top: pos.y, width: cell.w, height: HEADER_H,
        display: 'flex', alignItems: 'center', gap: GAP.sm,
        borderBottom: `1px solid ${COLOR.borderLt}`,
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text,
      }}
    >
      <span style={{ fontWeight: 600 }}>{g.label}</span>
      <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>{g.items.length} 件</span>
      {!cell.single && (
        <button
          type="button"
          onClick={() => onClose(g.key)}
          style={{
            marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2, border: 0, background: 'transparent',
            cursor: 'pointer', color: COLOR.sub, fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
          }}
        ><ChevronUp size={12} />收起</button>
      )}
    </div>
  );
}
