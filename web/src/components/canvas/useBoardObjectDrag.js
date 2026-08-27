/**
 * useBoardObjectDrag —— 画布物件拖拽全家（2026-08-25 从 BoardCanvas 抽出，行数棘轮）
 *
 * 管：pointerdown 起手（含板书双按武装 —— ⛔武装不能靠 dblclick：画布把闲置板书
 * 那一按当空地后平移层 setPointerCapture，click/dblclick 被重定向到公共祖先，卡上
 * 的 onDoubleClick 永远收不到，08-25 探针实锤）、逐帧移动（世界坐标差值，多选/
 * 整组一起走）、相机补帧、边缘跟车、#tag 包络小标整组抓手、松手落点判定
 * （进夹/成夹/落地 + seat:'user' 标记）。语义与注释自 BoardCanvas 原样搬入。
 */
import { useEffect } from 'react';
import { useDragEdgePan } from './useDragEdgePan.js';
import { computeDropHint } from '../../lib/board-drop-hint.js';

export function useBoardObjectDrag({
  camera, cam, positioned, folderView, dragActive,
  dragRef, dropHintRef, setDropHint, setDragActive,
  recentDragMovedRef, layoutRef, setLayout, patchLayout, dirtyRef, scheduleSave,
  zMaxRef, toolRef, drawModeRef, chalkEditModeRef, selectedIdsRef,
  setSelectedIds, clickSelect, noteUserTakeover, camApiRef, scrollRef,
  moveEntry, groupInto,
}) {
  const onObjectPointerDown = (e, o) => {
    if (e.button !== 0) return;
    if (e.target.closest('[data-board-action]')) return;   // 按钮不触发拖拽
    // 按着空格 = 挪镜头：这一下归相机。卡片的 handler 挂在卡片上、画布的
    // 挂在外层，事件是**先卡片后画布**冒泡上去的 —— 卡片不主动让路的话，
    // 按在卡片上会同时起一个物件拖拽和一次平移，两边各拽各的。
    if (camApiRef.current?.isHandMode?.()) return;
    // 板书防误触（08-25 拍板收严）：只认「改板书」开关 —— 关着时未被选中的
    // 板书对手势就是空地（平移/框选照旧；框选选中后可整批拖）。曾有"双按武装"
    // 一档，让开关名存实亡（怎么按都能拖能编辑），当天撤掉：要动板书，开开关
    //（agent 会替你开：edit_board chalk_edit）或框选。
    if (o.chalk && !chalkEditModeRef.current && !selectedIdsRef.current.includes(o.id)) return;
    // 工具在手（画笔/批注）时这一下归工具：按在卡上是要在卡上画、标，不是要
    // 拖卡。少了这条，笔画起点落在卡上会同时武装一次物件拖拽 —— 抬 z、写盘，
    // 而笔画提交又吞掉抬手，dragRef 残骸让那张卡黏住光标
    // （2026-08-13 查实的真 bug，三个症状同一根）。
    //
    // 两条豁免：
    //   - 涂鸦的**摆放模式**对墨类放行 —— 那个模式存在的意义就是挪墨迹。
    //   - **文字工具**整个放行 —— 它 2026-08-13 起只认双击（见 useCanvasTools），
    //     单击这一下本来就该按指针工具那套走："单击不触发，当作操作文字本身"。
    if (toolRef.current !== 'select' && toolRef.current !== 'text') {
      const arrange = toolRef.current === 'draw' && drawModeRef.current === 'arrange';
      if (!(arrange && o.native)) return;
    }
    recentDragMovedRef.current = false;
    noteUserTakeover();
    setDragActive(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    const z = ++zMaxRef.current;
    patchLayout(o.id, { x: o.pos.x, y: o.pos.y, z });
    // 多选拖动（08-25 用户提）：拖的是选中集里的一员且选了多件 → 整批一起走
    const group = {};
    if (selectedIdsRef.current.length > 1 && selectedIdsRef.current.includes(o.id)) {
      for (const gid of selectedIdsRef.current) {
        const gp = layoutRef.current[gid];
        if (gid !== o.id && gp && Number.isFinite(gp.x)) group[gid] = { x: gp.x, y: gp.y };
      }
    }
    dragRef.current = {
      kind: 'object', id: o.id, startX: e.clientX, startY: e.clientY,
      // 抓点存**世界坐标**：move 时用「当前相机下光标处的世界点 − 抓点」求
      // 位移。相机在拖拽中怎么动（滚轮平移、Ctrl+滚轮缩放），卡都钉在光标下。
      grabWorld: camera.toWorld(e.clientX, e.clientY),
      lastClientX: e.clientX, lastClientY: e.clientY,
      origX: o.pos.x, origY: o.pos.y, moved: false, group,
    };
  };

  /** 整组拖拽（08-25）：按住 #tag 包络小标 = 选中整组并拖着走 */
  const onTagGrab = (tag, e) => {
    const members = positioned.filter(it => (it.tag || it.pos?.tag) === tag && layoutRef.current[it.id]);
    if (!members.length) return;
    e.preventDefault();
    noteUserTakeover();
    setSelectedIds(members.map(m => m.id));
    setDragActive(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    const anchor = members[0];
    const group = {};
    for (const m of members) {
      if (m.id === anchor.id) continue;
      const gp = layoutRef.current[m.id];
      if (gp && Number.isFinite(gp.x)) group[m.id] = { x: gp.x, y: gp.y };
    }
    dragRef.current = {
      kind: 'object', id: anchor.id, startX: e.clientX, startY: e.clientY,
      grabWorld: camera.toWorld(e.clientX, e.clientY),
      lastClientX: e.clientX, lastClientY: e.clientY,
      origX: anchor.pos.x, origY: anchor.pos.y, moved: false, group,
    };
  };

  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX; const dy = e.clientY - d.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    d.lastClientX = e.clientX; d.lastClientY = e.clientY;
    {
      // 位移在**世界坐标系**里算：当前相机下光标处的世界点 − 按下时的抓点。
      //
      // 老算法是 `origX + 屏幕位移/scale`，公式里没有相机项 —— 拖着卡滚一格
      // 滚轮，相机平移了，卡却按屏幕位移原地不动，光标底下的目标就这么丢了
      // （2026-08-13 用户报）。Ctrl+滚轮缩放还会叠一个瞬间跳变（历史总位移
      // 除以新 scale）。两次 screenToWorld 相减把相机自然消掉，怎么动都跟手。
      //
      // 落点不再夹范围（原来 x∈[-800,2160]、y≥-800）：画布已全向无限，
      // "拖丢了找不回来"由小地图和 Shift+1 兜底，不由夹子兜底。
      const w = camera.toWorld(e.clientX, e.clientY);
      const nx = d.origX + (w.x - d.grabWorld.x);
      const ny = d.origY + (w.y - d.grabWorld.y);
      const gdx = nx - d.origX; const gdy = ny - d.origY;
      setLayout(prev => {
        const next = { ...prev, [d.id]: { ...prev[d.id], x: nx, y: ny } };
        for (const [gid, gp] of Object.entries(d.group || {})) {
          if (next[gid]) next[gid] = { ...next[gid], x: gp.x + gdx, y: gp.y + gdy };
        }
        return next;
      });
      // 实时落点提示：这个物件松手会归到哪（工作区高亮 / 文件夹卡高亮）。
      //
      // **只提示归属，不预告坐标**：2026-08-07 前这里还会算一个 244×210 的
      // 吸附格并画成虚线 ghost，松手时把卡吸过去。那就是「拖动往鼠标反方向
      // 跑」的全部原因 —— 拖拽过程逐帧是像素级跟手的，是松手那一下被吸到
      // 格点上，向左拖 30px 能落到 −34px。落点由用户的手决定，不由格子决定。
      // 落点提示抽去 lib/board-drop-hint.js（08-25 棘轮拆件）；多选/整组拖不提示
      const hint = Object.keys(d.group || {}).length ? null : computeDropHint({
        id: d.id, nx, ny, pos: layoutRef.current[d.id], positioned, folderView,
      });
      if (JSON.stringify(dropHintRef.current) !== JSON.stringify(hint)) {
        dropHintRef.current = hint;
        setDropHint(hint);
      }
    }
  };

  // 拖拽中相机动了：滚轮不产生 pointermove，光标停着纯滚轮时上面那条换算
  // 没机会跑，卡会在原世界坐标上"漂走"，直到鼠标动一像素才猛地追上。
  // 这里在相机每次变化时用最后一次已知的光标位置补一帧。
  useEffect(() => {
    const d = dragRef.current;
    if (!d || d.kind !== 'object' || !d.grabWorld) return;
    const w = camera.toWorld(d.lastClientX, d.lastClientY);
    const dx = w.x - d.grabWorld.x; const dy = w.y - d.grabWorld.y;
    setLayout(prev => {
      const next = { ...prev, [d.id]: { ...prev[d.id], x: d.origX + dx, y: d.origY + dy } };
      for (const [gid, gp] of Object.entries(d.group || {})) {
        if (next[gid]) next[gid] = { ...next[gid], x: gp.x + dx, y: gp.y + dy };
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cam]);

  // 拖到视口边缘 → 画布自动跟着走。只推相机，卡由上面那条 [cam] effect 补帧（道理在 useDragEdgePan.js）
  useDragEdgePan({ active: dragActive, dragRef, paneRef: scrollRef, camApiRef });

  /**
   * ⚠️ 这里曾有「拖到空白处 = 搬出当前文件夹」（DRAG_OUT_DETACHES / DETACH_MARGIN）。
   * **2026-08-13 删掉，因为它在当前目录模型下必然误触** —— 用户报「我总是拖一下
   * 就把文件移出文件夹了」，查出来是判据本身错了：
   *
   *   判定拿的是「物件在**这一层**的坐标」跟「`zones[当前文件夹]` 的矩形」比，
   *   可后者是**那张文件夹卡在它父层里的位置**（288×352 的一张卡）。两个数字
   *   活在不同的坐标空间里，比较毫无意义 —— 进了文件夹随便拖一下，中心大概率
   *   就落在那张卡的 48px 之外，于是"明确拖出去了"，文件真的被搬回根目录。
   *
   * 修法不是给它换个正确的矩形（一层桌面是无限的，压根没有"这一层的边界"这种
   * 东西），而是换成**显式动作**：右键「移动到…」挑目标（用户 2026-08-13 定）。
   * 拖拽只剩两条语义，都要求落点上真有个东西：落在文件夹卡上=搬进去、
   * 摞在另一件东西上=归成一夹。落在空地上就只是挪了个位置。
   */

  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragActive(false);
    // click/dblclick 在 pointerup 之后才派发，此时 dragRef 已清 —— 拖完的
    // "余韵"记在这个 ref 上，让点击类 handler 能区分"拖完松手"和"真点击"
    recentDragMovedRef.current = !!d?.moved;
    // 点了一下没拖动 = 选中（2026-08-27 操作条重制：**所有**物件点选都进选中态，
    // 产物卡也选 —— 选中出操作条。下翻/几何命中收在 BoardCanvas 的 clickSelect，
    // 这里只报「点了这件、点在屏幕哪儿」）
    if (d?.kind === 'object' && !d.moved) {
      clickSelect?.(d.id, d.lastClientX, d.lastClientY);
    }
    if (d?.kind === 'object') {
      // 落点判定 → **真的搬文件**（2026-08-08）：
      //   落在文件夹卡上 = 搬进那个目录
      //   摞在另一件东西上 = 两件归成一个新文件夹
      //   落在空地 = 只是挪了个位置，什么也不搬（搬出去走右键「移动到…」）
      if (d.moved) {
        const obj = positioned.find(o => o.id === d.id);
        const pos = layoutRef.current[d.id];
        const hint = dropHintRef.current;
        if (obj && pos) {
          const prevZone = obj.zoneId || null;
          let target = null;                       // null = 不搬；字符串 = 搬到这个目录（'' = 根）
          if (hint?.kind === 'group') {
            const other = positioned.find(it => it.id === hint.id);
            if (other) groupInto(obj, other);
            dropHintRef.current = null;
            setDropHint(null);
            // ⛔ 不再给旧 id 排写入：搬家发起后旧键的迟到 flush 会经 board-store
            // 转发表把**新条目**删掉（null 删除也走 fwd，08-24 案）。位置与清账
            // 由 moveEntry/groupInto 拿服务端回包处理。
            return;
          }
          if (hint?.kind === 'folder' || hint?.kind === 'zone') {
            if (hint.id !== prevZone) target = hint.id;
          }
          if (target !== null) {
            moveEntry(obj, target, { x: pos.x, y: pos.y });
            dropHintRef.current = null;
            setDropHint(null);
            return;   // 同上：搬家路上不给旧 id 排写入
          }
        }
      }
      dropHintRef.current = null;
      setDropHint(null);
      // 用户亲手拖过 = 座位出处 'user'：服务端排座/跟随从此不许覆盖这个座。
      // 多选/整组拖拽：组员一起标、一起落盘
      const movedIds = [d.id, ...Object.keys(d.group || {})];
      if (d.moved) {
        setLayout(prev => {
          const next = { ...prev };
          for (const mid of movedIds) if (next[mid]) next[mid] = { ...next[mid], seat: 'user' };
          return next;
        });
      }
      for (const mid of movedIds) dirtyRef.current.objects.add(mid);
      scheduleSave();
    }
  };

  // 「刚拖完」的余韵，点击类 handler 靠它区分"拖完松手"和"真点击"。

  return { onObjectPointerDown, onPointerMove, onPointerUp, onTagGrab };
}
