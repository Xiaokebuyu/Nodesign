import { useCallback, useEffect, useReducer, useRef, useState, useMemo } from 'react';
import { TERM } from '../../lib/theme.js';
import { Image as ImageIcon } from 'lucide-react';
import { COLOR, GAP, RADIUS, FONT_MONO, FONT_SIZE, CANVAS, alpha } from '../../lib/theme.js';
import { sizeOf } from '../../lib/board-kinds.js';
import { MARGIN_X, DESKTOP_W, ROW_GAP } from '../../lib/board-geometry.js';

/**
 * PhantomLayer —— 生图占位的幻影物件（2026-08-14，用户拍板"幻影入座+座位过户"）
 *
 * ## 在这之前
 *
 * 生图等待卡（shimmer）住在舞台层：浮在画布**上方**、落点由舞台自算（贴工作区
 * 下沿铺），真图落地时走正常入座逻辑**另排一个座** —— 于是占位卡和成品不在
 * 同一个位置，图一出来就跳位。跟精灵曾经的毛病同一个：不在纸上，位置不受管控。
 *
 * ## 现在
 *
 * 占位卡是一个**幻影物件**：出生时按正常入座逻辑排一个座（一次算好就钉死，
 * 不反流），渲染在纸面层（和产物同一平面）；真图落地时 BoardCanvas 的入座
 * memo 把幻影的座位**直接过户**给它（layout[真图] = 幻影.seat，由 seatFixes
 * 照常落盘）—— 占位在哪，成品就在哪，不跳位。
 *
 * ## 生命周期（数据源 = 舞台状态机的 image 条目，血统不变）
 *
 *   出生   stageCards 出现 kind==='image' → 算座、入表
 *   等待   shimmer 流光（跑动中）
 *   过户   入座 memo 撞见"新来的图"→ 认领最老的未过户幻影 → 图坐幻影的座
 *   蒸发   过户完成（下一帧清）/ 失败红态 10s / 90s 没等到图（图落进了别的
 *          文件夹之类）—— 幻影是转瞬态，绝不落盘
 *
 * v1 边界：幻影只排**根桌面层**。生成图片的常见落点 assets/generated/ 归属
 * 到根，命中大多数情况；落进具体文件夹的图走不到过户（幻影超时蒸发），
 * 文件夹卡的橙圈仍然指示"里面在干活"。
 */

/** 认领窗：过了这个时长还没等到图，认命蒸发 */
const PHANTOM_TTL_MS = 90_000;
/** 失败红态展示时长 */
const PHANTOM_FAIL_MS = 10_000;

/** 图片卡的身位（和真图入座同一个 sizeOf 口径 —— 过户后不缩不胀） */
const IMG_SIZE = sizeOf({ type: 'image' });

const hitRect = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);

/**
 * 给幻影找个座：从"已有内容的最低边"下面开始，一行行从左往右扫第一个空位 ——
 * 跟新物件入座（packRow 起排线）同一个精神，只是单件版。
 * obstacles = 这一层的物件 + 文件夹卡 + 已就座的其他幻影。
 */
export function findPhantomSeat(obstacles, contentBottom) {
  const w = IMG_SIZE.w; const h = IMG_SIZE.h;
  const xMax = DESKTOP_W - MARGIN_X - w;
  let y = Math.max(MARGIN_X, Math.round(contentBottom) + ROW_GAP);
  for (let row = 0; row < 40; row += 1) {
    for (let x = MARGIN_X; x <= xMax; x += w + 16) {
      const r = { x, y, w, h };
      if (!obstacles.some(o => hitRect(r, o))) return { x, y };
    }
    y += h + 16;
  }
  return { x: MARGIN_X, y };   // 扫不到就叠底部（幻影是转瞬态，压着也就几秒）
}

/**
 * 幻影表管理。phantomsRef 是给入座 memo 消费的那份（认领时 memo 直接在 ref
 * 上标 consumedBy —— movingRef 在同一个 memo 里就是这么用的，有先例）；
 * state 那份只管渲染。
 */
export function usePhantoms({ stageCards, phantomsRef, obstaclesRef, contentBottomRef }) {
  const [phantoms, setPhantoms] = useState([]);
  /**
   * 拖动幻影用的重渲染扳机。
   *
   * **不能改成"造个新对象塞进 state"**：`phantoms` 里装的必须是**表里那一个**
   * 对象 —— 认领是在入座 memo 里就地把 `consumedBy` 标在表对象上的，渲染那行
   * 靠同一个引用当帧过滤掉它（不等状态清扫，所以过户瞬间幻影即隐）。
   * 复制一份就等于把这条断了。所以座位改在表上、渲染靠这个计数器推一下。
   */
  const [, bumpSeat] = useReducer(n => n + 1, 0);

  useEffect(() => {
    const table = phantomsRef.current;
    let changed = false;
    const now = Date.now();

    // 出生 / 状态同步
    for (const c of Object.values(stageCards)) {
      if (c.kind !== 'image') continue;
      const cur = table.get(c.blockId);
      if (!cur) {
        const taken = [...table.values()].filter(p => !p.consumedBy).map(p => ({ ...p.seat, w: IMG_SIZE.w, h: IMG_SIZE.h }));
        const seat = findPhantomSeat(
          [...(obstaclesRef.current || []), ...taken],
          contentBottomRef.current || 0,
        );
        table.set(c.blockId, {
          blockId: c.blockId, seat, prompt: c.prompt || '', status: c.status,
          bornAt: now, consumedBy: null,
        });
        changed = true;
      } else if (cur.status !== c.status || cur.prompt !== (c.prompt || cur.prompt)) {
        cur.status = c.status;
        if (c.prompt) cur.prompt = c.prompt;
        changed = true;
      }
    }

    // 蒸发：过户完成 / 失败到时 / 认领窗超时
    for (const [key, p] of table) {
      const dead = p.consumedBy
        || (p.status === 'fail' && now - p.bornAt > PHANTOM_FAIL_MS)
        || now - p.bornAt > PHANTOM_TTL_MS;
      if (dead) { table.delete(key); changed = true; }
    }

    if (changed) {
      setPhantoms([...table.values()].filter(p => !p.consumedBy));
    }
    // 没有新事件也要能蒸发（stageCards 静止时的超时）：挂一个懒扫
    const t = setTimeout(() => {
      const tbl = phantomsRef.current;
      let dirty = false;
      const n = Date.now();
      for (const [key, p] of tbl) {
        if (p.consumedBy || n - p.bornAt > PHANTOM_TTL_MS
          || (p.status === 'fail' && n - p.bornAt > PHANTOM_FAIL_MS)) {
          tbl.delete(key); dirty = true;
        }
      }
      if (dirty) setPhantoms([...tbl.values()].filter(p => !p.consumedBy));
    }, 5000);
    return () => clearTimeout(t);
  }, [stageCards, phantomsRef, obstaclesRef, contentBottomRef]);

  /**
   * 挪座（2026-08-17）：**拖幻影 = 指定这张图待会儿落在哪**。
   *
   * 不需要新的持久化 —— 座位本来就是这张图落点的唯一真相，过户时原样交给
   * 真图、由 seatFixes 照常落盘。在这之前只有算法能写它，用户不能，于是
   * 占位卡摆得不合适也只能干看着（用户 2026-08-17 的原话是"我觉得可以给一个
   * layout，或者说这才是我想要的"）。
   *
   * 写在表上，不进 state：理由见上面那个计数器。
   */
  const moveSeat = useCallback((blockId, seat) => {
    const p = phantomsRef.current.get(blockId);
    if (!p || p.consumedBy) return;
    p.seat = { x: Math.round(seat.x), y: Math.round(seat.y) };
    bumpSeat();
  }, [phantomsRef]);

  return { phantoms, moveSeat };
}

/**
 * 还没过户的幻影占的地方（2026-08-17，issue #1 第 9 条）。
 *
 * 幻影原来对入座算法**完全不可见**：它自己找座时躲开所有真卡（出生那一下），
 * 可反过来没人躲它 —— 而两边的起排线是同一条（都从"已有内容的最低边"往下
 * 排一行），于是"生图等着的时候又落了一件新东西"必然把新卡排在幻影身上。
 * 用户报的「加载动画和已经渲染出来的图叠在一起」就是这么来的。
 *
 * 幻影不落盘、不可拖，所以它没法自己让开 —— 只能让排座的那边知道它在。
 * 在 memo 里现算（跟 movingRef 同一种 ref 用法），拿到的是那一趟的现实。
 */
export function phantomRects(phantomsRef) {
  return [...phantomsRef.current.values()]
    .filter(p => !p.consumedBy)
    .map(p => ({ x: p.seat.x, y: p.seat.y, w: IMG_SIZE.w, h: IMG_SIZE.h }));
}

/**
 * 入座 memo 的认领口（在 memo 里调用，跟 movingRef 同一种 ref 用法）：
 * 新来的图 → 最老的未过户幻影的座。认领即标记，同一个幻影不会发两次座。
 */
export function claimPhantomSeat(phantomsRef, newImageId) {
  const free = [...phantomsRef.current.values()]
    .filter(p => !p.consumedBy)
    .sort((a, b) => a.bornAt - b.bornAt);
  if (!free.length) return null;
  free[0].consumedBy = String(newImageId);
  return { ...free[0].seat };
}

/**
 * 纸面层上的整排幻影。
 *
 * `consumedBy` 是入座 memo 认领时**就地标在表对象上**的，而这一层是
 * BoardCanvas 的子组件、渲染发生在它 render 之后 —— 所以这里过滤到的
 * 永远是那一趟的最新结果，过户瞬间幻影即隐，不用等状态清扫。
 */
export function PhantomCards({ phantoms, draggable, toWorld, onSeatChange }) {
  return phantoms.filter(p => !p.consumedBy).map(p => (
    <PhantomImageCard
      key={p.blockId} p={p}
      draggable={draggable} toWorld={toWorld} onSeatChange={onSeatChange}
    />
  ));
}

/**
 * 幻影卡本体：纸面层的 shimmer（视觉从舞台版搬家，身位换成真图卡口径）。
 *
 * **可拖**（2026-08-17）：拖它就是指定这张图落在哪。位移在世界坐标里算
 * （当前相机下光标处的世界点 − 按下时的抓点），跟真卡那条路同一个算法 ——
 * 原因也一样：公式里没有相机项的话，拖着卡滚一格滚轮目标就丢了（08-13 事故）。
 *
 * @param {boolean}  draggable  只在指针工具在手时可拖（跟真卡同一条规矩：
 *                              手里拿着画笔按在卡上是要在卡上画，不是要挪它）
 * @param {Function} toWorld    camera.toWorld
 * @param {Function} onSeatChange (blockId, seat) => void
 */
export function PhantomImageCard({ p, draggable = false, toWorld, onSeatChange }) {
  const running = p.status === 'running';
  const dragRef = useRef(null);

  const onPointerDown = (e) => {
    if (!draggable || e.button !== 0 || !toWorld) return;
    // 不让画布把这一下当平移/框选。board-hit 的 OBJECT_SELECTOR 里也加了
    // [data-phantom]（相机的判据是共享的那一份），这里是第二道。
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      id: e.pointerId,
      grab: toWorld(e.clientX, e.clientY),
      orig: { ...p.seat },
    };
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    const w = toWorld(e.clientX, e.clientY);
    onSeatChange?.(p.blockId, {
      x: d.orig.x + (w.x - d.grab.x),
      y: d.orig.y + (w.y - d.grab.y),
    });
  };
  const endDrag = (e) => {
    if (dragRef.current?.id === e.pointerId) dragRef.current = null;
  };

  return (
    <div
      data-phantom="image"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      title={draggable ? '拖动它 = 指定这张图落在哪' : undefined}
      style={{
        position: 'absolute', left: p.seat.x, top: p.seat.y,
        width: IMG_SIZE.w, height: IMG_SIZE.h,
        borderRadius: RADIUS.xl, overflow: 'hidden',
        border: `1px solid ${p.status === 'fail' ? TERM.edgeErr : alpha(CANVAS.brass, 0.5)}`,
        background: COLOR.bgCard, boxShadow: '0 6px 18px rgba(60,48,20,0.14)',
        pointerEvents: draggable ? 'auto' : 'none',
        cursor: draggable ? 'grab' : 'default',
        touchAction: 'none',
        userSelect: 'none',
      }}
    >
      <div style={{
        height: IMG_SIZE.h - 24,
        background: running
          ? 'linear-gradient(100deg, #ece7db 30%, #faf8f2 45%, #ece7db 60%)'
          : COLOR.bgCard,
        backgroundSize: '200% 100%',
        animation: running ? 'ndShimmer 1.5s linear infinite' : 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <ImageIcon size={22} color="#b3a58a" />
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', padding: `${GAP.xxs}px ${GAP.md}px`,
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, color: COLOR.sub,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {running ? '生成图片中…' : p.status === 'ok' ? '就位中…' : '生成失败'}
        {p.prompt ? ` · ${p.prompt}` : ''}
      </div>
    </div>
  );
}

/**
 * 幻影占地（给视点上报用，2026-09-05）：服务端落位要躲它，而它不落盘。
 * 按签名 memo —— 签名不变引用不变，上报 hook 的 dep 才不会每帧抖。
 */
export function usePhantomOccupied(phantomsRef) {
  const sig = phantomRects(phantomsRef).map((r) => `${r.x},${r.y}`).join(';');
  return useMemo(() => phantomRects(phantomsRef), [sig]);   // eslint-disable-line react-hooks/exhaustive-deps
}
