/**
 * 在画布上"造一件东西"（2026-08-17 从 BoardCanvas 拆出 —— 行数棘轮）。
 *
 * 三条造物的路，共用一套落盘口（useBoardData 的 patchLayout / removeLayoutEntry）：
 *   写一段字   handleCreateText / openTextEditor / commitTextEdit
 *   写便利贴   createNoteAt   —— **这条落成 notes/*.md，是给 agent 看的**
 *   画一笔     handleCreateScribble —— 挨着旧墨迹就并成一组
 *
 * 前两条的分野是这个模块存在的意义，别再合并：画布原生的字/墨只活在
 * board.json（agent 读不到，那是白板），便利贴是真文件（agent 下一轮就看见）。
 * 2026-08-13 用户拍板要白板，「写字一律落成 .md」那版被推翻了。
 *
 * `editingText` 也住这儿：它是 commitTextEdit 的另一半，分居两个文件必然有
 * 一天只改一边。
 */
import { useCallback, useState } from 'react';
import { Assets } from '../../lib/api.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { sizeOf } from '../../lib/board-kinds.js';
import { estimateTextBox, TEXT_FONT_CSS, TEXT_SIZE_PX } from '../../lib/text-fonts.js';
import { PAPER } from '../../lib/paper.js';
import { CANVAS } from '../../lib/theme.js';
import { pointsToPath, pointsBounds, pathPoints, translatePath } from './useCanvasTools.js';

const SCRIBBLE_INK = { ink: PAPER.ink, red: PAPER.red, pencil: PAPER.pencil, brass: CANVAS.brass };

export function useBoardAuthoring({
  projectId, canvasFont,
  patchLayout, reload, removeLayoutEntry,
  layoutRef, zMaxRef,
  positionedRef, zoneAtPoint,
}) {
  /** 正在改内容的那段字：{ id, at, initial }。null = 没在改 */
  const [editingText, setEditingText] = useState(null);

  /**
   * 写一段字 → **画布原生文字**（2026-08-08 改）。
   *
   * 以前它一律落成 `.md` 便签，理由是"canvas-native 的东西 agent 读不到，
   * 而用户写字十有八九是想说给 agent 听"。那个判断被推翻了：用户要的是
   * **白板** —— 在工程文件旁边随手写一句、画一笔，跟涂鸦是同一件事。
   * 想说给 agent 听的走右键「新建便利贴」，那条路原样还在。
   *
   * 字体走设置里选的默认值（fontPref），跟涂鸦一样只活在 board.json。
   */
  const handleCreateText = useCallback((text, at) => {
    const t = String(text || '').trim();
    if (!t) return null;
    const id = `text:${Date.now().toString(36)}${Math.floor(performance.now() % 1000)}`;
    // 尺寸按字数估：一行约 26 个全角字符，行高 1.6。估不准也没关系 ——
    // 卡体是 height:auto，这个值只用来定命中区和避让矩形（同涂鸦那条教训）。
    const box = estimateTextBox(t, canvasFont.size);
    // 归属跟涂鸦同一条规则：落点被谁的文件夹卡框住就归谁。原来这里漏写 zone，
    // 在文件夹层里写的字会静默归到根上（2026-08-13 查实补齐）
    const zid = zoneAtPoint({ x: at.x, y: at.y });
    patchLayout(id, {
      x: Math.round(at.x), y: Math.round(at.y), z: ++zMaxRef.current,
      w: box.w, h: box.h,
      kind: 'text',
      data: { t, font: canvasFont.font, size: canvasFont.size, color: 'ink' },
      ...(zid ? { zone: zid } : {}),
    });
    return id;
  }, [patchLayout, canvasFont, zoneAtPoint]);

  /**
   * 打开某段字的就地编辑（双击 / 文字工具点在字上，两个入口共用）。
   * 手写字：预填 data.t；板书（文件）：先把文件拉下来，frontmatter 留在 head 里、正文进编辑框
   * （o.text 是 4KB 截断的展示副本，不能当原文改）。框的宽/字体/字号照着这块来（style）。
   */
  const openTextEditor = useCallback(async (o) => {
    const sz = sizeOf(o);
    const isMd = o.chalk || o.data?.format === 'md';
    const style = {
      fontFamily: TEXT_FONT_CSS[o.chalk ? 'kai' : (o.data?.font || 'kai')] || TEXT_FONT_CSS.kai,
      fontSize: TEXT_SIZE_PX[o.chalk ? 'md' : (o.data?.size || 'md')] || TEXT_SIZE_PX.md,
      color: o.chalk ? PAPER.ink : (SCRIBBLE_INK[o.data?.color] || PAPER.ink),
    };
    if (o.chalk) {
      let head = ''; let body = o.text || '';
      try {
        const raw = await (await fetch(Assets.artifactFileUrl(projectId, o.path))).text();
        head = /^---\n[\s\S]{0,800}?\n---\n?/.exec(raw)?.[0] || '';
        body = raw.slice(head.length).replace(/^\n+/, '').replace(/\n+$/, '');
      } catch { /* 拉不到原文就用展示副本 */ }
      setEditingText({ id: o.id, at: { x: o.pos.x, y: o.pos.y }, initial: body, w: sz.w, style, chalk: { name: o.name, head } });
      return;
    }
    setEditingText({ id: o.id, at: { x: o.pos.x, y: o.pos.y }, initial: o.data?.t || '', w: isMd ? sz.w : null, style });
  }, [projectId]);

  const commitTextEdit = useCallback(async (text) => {
    const ed = editingText;
    setEditingText(null);
    if (!ed) return;
    const t = String(text || '').trim();
    // 板书：写回文件（frontmatter 拼回去）；清空 = 删（连座位一起，服务端 DELETE 管）
    if (ed.chalk) {
      try {
        if (!t) await Assets.removeChalk(projectId, ed.chalk.name);
        else if (t !== String(ed.initial || '').trim()) await Assets.putChalk(projectId, ed.chalk.name, `${ed.chalk.head || ''}${t}\n`);
        else return;
        reload();
      } catch (err) { console.warn('[board] save chalk failed:', err.message); }
      return;
    }
    const old = layoutRef.current[ed.id];
    if (!old) return;
    if (!t) {
      // 清空 = 删掉这段字（服务端对空文本也是整条丢弃，两边同一个语义）
      removeLayoutEntry(ed.id);
      return;
    }
    // 尺寸按新内容重估（只定命中区和避让矩形；渲染后 useMeasuredSize 会按真值回写）
    const box = estimateTextBox(t, old.data?.size);
    patchLayout(ed.id, { w: box.w, h: box.h, data: { ...old.data, t } });
  }, [editingText, patchLayout, removeLayoutEntry]);

  /** 写一张便利贴 → `notes/*.md`（**这条是给 agent 看的**，走右键菜单） */
  const createNoteAt = useCallback(async (at) => {
    const text = window.prompt('便利贴写点什么？（agent 下一轮就能看到）');
    if (!text?.trim()) return;
    try {
      const name = `${Date.now().toString(36)}.md`;
      await Assets.putTaskNote(projectId, name, text.trim());
      const file = `notes/${name}`;
      // 落在右键处（而不是让它自动入座）—— 用户是**指着地方**写的
      patchLayout(file, { x: Math.round(at?.x ?? 0), y: Math.round(at?.y ?? 0), z: ++zMaxRef.current });
      reload();
    } catch (err) {
      useGlobalStore.getState().showToast(`便利贴写不进去：${err.message}`, 'error');
    }
  }, [projectId, patchLayout, reload]);

  /** 新笔画跟旧墨迹"有结合点"的判距（世界像素）：笔尖挨着就算一伙 */
  const MERGE_DIST = 24;

  /** 画一笔 → 画布原生物件（只活在 board.json）；挨着旧墨迹就并进去成一组 */
  const handleCreateScribble = useCallback((points) => {
    const box = pointsBounds(points, 8);
    const d = pointsToPath(points, box.x, box.y);
    if (!d) return;

    /**
     * 归组（2026-08-13 用户定）：判据是**点到点的最小距离**，不是包围盒相交 ——
     * 一条长对角线的 bbox 大得离谱，按 bbox 合并会把半屏的墨迹吸成一坨。
     * bbox 只做快筛。已被旋转/缩放过的组不并（合并数学在变换下不成立，
     * 且用户既然特意摆过它，新笔画多半不是它的一部分）。
     */
    const host = (() => {
      for (const o of positionedRef.current) {
        if (o.type !== 'scribble' || !o.native) continue;
        if (o.data?.rotation || (o.data?.scale && o.data.scale !== 1)) continue;
        const sz = sizeOf(o);
        if (box.x > o.pos.x + sz.w + MERGE_DIST || box.x + box.w < o.pos.x - MERGE_DIST
          || box.y > o.pos.y + sz.h + MERGE_DIST || box.y + box.h < o.pos.y - MERGE_DIST) continue;
        const oldPts = pathPoints(o.data?.d).map(p => ({ x: p.x + o.pos.x, y: p.y + o.pos.y }));
        for (const q of points) {
          for (const p of oldPts) {
            if (Math.hypot(p.x - q.x, p.y - q.y) <= MERGE_DIST) return o;
          }
        }
      }
      return null;
    })();

    if (host) {
      const sz = sizeOf(host);
      const nx = Math.min(host.pos.x, box.x);
      const ny = Math.min(host.pos.y, box.y);
      const nw = Math.max(host.pos.x + sz.w, box.x + box.w) - nx;
      const nh = Math.max(host.pos.y + sz.h, box.y + box.h) - ny;
      const merged = `${translatePath(host.data.d, host.pos.x - nx, host.pos.y - ny)} ${pointsToPath(points, nx, ny)}`;
      // 服务端 8000 字符闸门：并不进去就各过各的（丢笔画是最差的结果）
      if (merged.length < 7900) {
        patchLayout(host.id, {
          x: Math.round(nx), y: Math.round(ny), w: Math.round(nw), h: Math.round(nh),
          data: { ...host.data, d: merged },
        });
        return;
      }
    }

    const id = `scribble:${Date.now().toString(36)}${Math.floor(performance.now() % 1000)}`;
    const zid = zoneAtPoint({ x: box.x + box.w / 2, y: box.y + box.h / 2 });
    patchLayout(id, {
      x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h),
      z: ++zMaxRef.current,
      kind: 'scribble', data: { d, color: 'ink', width: 2 },
      ...(zid ? { zone: zid } : {}),
    });
  }, [zoneAtPoint, patchLayout]);

  return {
    editingText, setEditingText,
    handleCreateText, openTextEditor, commitTextEdit,
    createNoteAt, handleCreateScribble,
  };
}
