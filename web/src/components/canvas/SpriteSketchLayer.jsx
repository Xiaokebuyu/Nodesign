import { useEffect, useMemo, useRef, useState } from 'react';
import { PAPER } from '../../lib/paper.js';
import { STAGE_CARD_W } from '../../lib/board-geometry.js';
import { TEXT_FONT_CSS } from '../../lib/text-fonts.js';
import { isImeEnter } from '../../lib/helpers.js';
import { SpriteFigure, FIGURE_KEYFRAMES, MARK_DRAW_MS, figureWidth } from './sprite-figures.jsx';
import { useCurrentModelBrand } from '../../lib/model-brand.js';
import { MAIN_AGENT_ID } from '../../lib/board-presence.js';

/**
 * SpriteSketchLayer —— 铅笔定格精灵（2026-08-14，日记本批）
 *
 * 范式来自用户点名的里德尔日记：agent 在画布上的存在不是"浮着的徽章"，而是
 * **铅笔在纸上画出来的东西**。出场三拍：
 *   1. 描线 —— Claude 星芒按 path 走一遍铅笔稿（pathLength=1 归一化 +
 *      dashoffset，steps() 计时让它一格一格前进，定格动画的手感）
 *   2. 显影 —— 品牌橙从铅笔稿里浮出来（opacity steps，像墨水渗进纸）
 *   3. 手写 —— 内容用楷体逐字写出，每个字带一点确定性的歪斜（伪随机取自
 *      字符码，同一句话每次歪得一样 —— 抖动是笔迹不是噪声）
 *
 * 两种场合共用同一个视觉（SpriteSketch），谁来摆位各管各的：
 *   - 工作时：BoardCanvas 把它放在目标物件上（世界坐标，跟着卡片走）
 *   - 闲时：AmbientSpriteLayer 跟着**用户镜头**（屏幕坐标）——首选落位是
 *     视口中心到顶边连线的中点，被产物占了就换备选槽，全占就不出现
 *     （用户定的规矩：宁可不显示，不压在别人的作品上）
 *
 * 没有底、没有框、没有影 —— 它不是 UI 控件，是画在纸上的一笔。
 */

/** 手写字显影用的那条 —— 身体那几条在 sprite-figures.jsx（谁的动画归谁管） */
const KEYFRAMES = `
  @keyframes ndInkIn { to { opacity: 1; } }
`;

/**
 * 逐字显影。笔迹用**画布手写那套栈**（TEXT_FONT_CSS.pen：拉丁走 Caveat、
 * 中文落龙藏体）—— 精灵写的字和用户在白板上写的字必须是同一支笔
 * （2026-08-14 用户点名：之前用楷体，太工整像印出来的）。
 * per-char 延迟随长度收缩：整句写完 ≤ ~1.8s，长句不拖堂。
 */
function Handwriting({ text, delay = MARK_DRAW_MS, size = 26, maxWidth = 340 }) {
  const chars = useMemo(() => Array.from(String(text || '')), [text]);
  if (!chars.length) return null;
  const per = Math.min(60, Math.max(22, Math.round(1600 / chars.length)));
  return (
    <div style={{
      fontFamily: TEXT_FONT_CSS.pen, fontSize: size, lineHeight: 1.45,
      color: PAPER.ink2, maxWidth, wordBreak: 'break-word',
    }}>
      {chars.map((ch, i) => {
        const j = ((ch.codePointAt(0) || 1) * 31 + i * 7) % 7;
        return (
          <span
            key={`${i}:${ch}`}
            style={{
              display: 'inline-block',
              opacity: 0,
              transform: `rotate(${(j - 3) * 0.8}deg) translateY(${(j % 3) - 1}px)`,
              animation: `ndInkIn 90ms steps(2, end) ${delay + i * per}ms forwards`,
            }}
          >{ch === ' ' ? ' ' : ch}</span>
        );
      })}
    </div>
  );
}

/**
 * 精灵本体：图标 + 手写行。`drawKey` 变化 = 整体重画（换了地方/重新出场）；
 * 只有 `text` 变 = 图标原地不动、那行字重写 —— 像在同一页上划掉重写。
 */
export function SpriteSketch({ brand, drawKey = 0, text, size = 44, maxWidth = 340, active = false, quiet = false, nameTag = null, onMarkClick, onMarkDragMove, onMarkDragEnd }) {
  return (
    // ⚠️ width 必须显式给：世界容器是零宽的变换锚点（大家都显式传宽，BindingLayer
    // 的 width/height、舞台卡的 STAGE_CARD_W 同理），绝对定位 + auto 宽在里面会
    // 按 min-content 收缩 —— 真机症状是手写行竖排成一字一列（2026-08-14 踩到）
    // 宽度按**这枚身体**的实际外框算：各家标的比例不同（星芒是方的、鲸是横的、方块是竖的），
    // 一律拿 size 当宽会让横的那枚把手写行挤出去
    <div key={drawKey} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, width: figureWidth(brand, size) + 10 + maxWidth, pointerEvents: 'none' }}>
      <style>{KEYFRAMES + FIGURE_KEYFRAMES}</style>
      <SpriteFigure brand={brand} size={size} active={active} onClick={onMarkClick} onDragMove={onMarkDragMove} onDragEnd={onMarkDragEnd} />
      {/* quiet = 用户正往输入行里写字：精灵的话让位（病例是当年 recap 长文
          盖住输入行；recap 已退役，但闲时问候一样会挡，而且"它闭嘴听你说"
          本来就是对的礼节） */}
      {/* nameTag（2026-08-28，常驻角色用）：名牌贴在标**旁边**，手写行落到名牌下面。
          一块板上同时有叙事者 / NPC / 主控在写字，光看笔迹分不出谁是谁；名牌跟标
          同一行，视线不用二次搜寻。主 agent 不传这个 prop，版面一如既往。 */}
      {(nameTag || !quiet) && (
        <div style={{ paddingTop: Math.round(size * 0.04), minWidth: 0 }}>
          {nameTag}
          {!quiet && <Handwriting key={text} text={text} maxWidth={maxWidth} />}
        </div>
      )}
    </div>
  );
}

/**
 * 对话通道的输入行（2026-08-14，用户拍板"icon 也是跟 agent 说话的口子"）：
 * 点星芒 → 精灵脚下浮出一道铅笔虚线，直接打字。没有框没有按钮 ——
 * 在纸上写字给它，Enter 递过去（里德尔日记的吸墨面）。
 * 世界坐标由 BoardCanvas 摆；Esc / 失焦收起。
 */
export function SpriteAskInput({ x, y, width = 350, onSubmit, onClose }) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div
      style={{ position: 'absolute', left: x, top: y, width, zIndex: 320, pointerEvents: 'auto' }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        ref={ref}
        placeholder="写一句给它…"
        style={{
          width: '100%', border: 0, outline: 'none', background: 'transparent',
          borderBottom: `1.5px dashed ${PAPER.pencil}`,
          fontFamily: TEXT_FONT_CSS.pen, fontSize: 24, color: PAPER.ink,
          padding: '2px 4px',
        }}
        onKeyDown={(e) => {
          // 拦住：画布上单键换工具、Esc 回上层 —— 不拦就变成打字换工具
          // （产物卡改名输入框同一套拦法）
          e.stopPropagation();
          if (e.key === 'Enter' && !isImeEnter(e)) {
            const t = e.currentTarget.value.trim();
            if (t) onSubmit?.(t);
            onClose?.();
          }
          if (e.key === 'Escape') onClose?.();
        }}
        onBlur={() => onClose?.()}
      />
    </div>
  );
}

// ── 闲时：跟镜头找空位 ──

/** 精灵的身位（找空位按它的外接矩形算；字号放大后 2026-08-14 二调） */
const SPRITE_W = 400;
const SPRITE_H = 100;

/**
 * 贴着工作目标时，精灵下沿离目标上边线留多少（世界单位，2026-08-15 用户报
 * "贴太紧、摘要压产物"后加）。跟纸上题字一样：字要在画的上方留一条呼吸缝。
 */
const WORK_GAP = 26;

/**
 * 备选槽（视口比例坐标）。第一个就是用户点名的落点：视口中点到顶边这条线
 * 的中点。其余从它往两侧、再往下半屏退让。
 */
const SLOT_CANDIDATES = [
  [0.5, 0.25], [0.32, 0.25], [0.68, 0.25],
  [0.5, 0.72], [0.32, 0.72], [0.68, 0.72],
];

const hitRect = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);

/**
 * 屏幕候选点 → **世界坐标**槽位。精灵住在画布层（2026-08-14 用户定的：
 * 和产物同一平面，不是覆在上面的现实层），所以槽位算出来就落成世界坐标，
 * 之后跟着纸走。第一个不压任何产物的槽赢；全占 = null。
 *
 * ⚠️ 身位口径（08-24 体检修正）：精灵是世界层子节点，CSS px 就是世界单位，
 * 真实脚印**恒为 SPRITE_W×SPRITE_H 世界单位**，跟镜头无关。老写法除了一次
 * cam.z（"镜头拉远它跟着变小"的错误心智模型）——z>1 时脚印被低估，判"不压"
 * 其实压着；z<1 时过度保守，六槽全占精灵凭空消失。slotVisible / findFrameSpot
 * 一直是对的口径，这里跟它们对齐。
 */
export function findAmbientSlot(cam, viewport, obstacles, candidates = SLOT_CANDIDATES) {
  if (!viewport?.w || !viewport?.h || !cam?.z) return null;
  for (const [fx, fy] of candidates) {
    const world = {
      x: (viewport.w * fx) / cam.z - cam.x - SPRITE_W / 2,
      y: (viewport.h * fy) / cam.z - cam.y - SPRITE_H / 2,
      w: SPRITE_W, h: SPRITE_H,
    };
    if (!(obstacles || []).some(o => hitRect(world, o))) {
      return { x: Math.round(world.x), y: Math.round(world.y) };
    }
  }
  return null;
}

/**
 * 贴目标（工作态）的落点也要避让（08-24 体检的主病根之一：老写法一律
 * "目标上方 WORK_GAP"，一次避让都不跑 —— 目标不在第一行时必压上一行的卡）。
 * 候选按偏好序：头顶（老落点，底边吊在目标上沿之上）→ 右 → 左 → 脚下。
 * 第一个不压别人的赢；全压就认最小遮挡（正在干活的精灵不能消失，跟
 * findFrameSpot 同一条规矩）。目标自己不会和任何候选相交（候选都在它外侧）。
 * @returns {{ x, y, hang: boolean }}  hang = 头顶位，渲染时底边吊装（translateY(-100%)）
 */
export function findWorkSpot(anchor, obstacles) {
  if (!anchor) return null;
  const aw = anchor.w || 0; const ah = anchor.h || 0;
  const candidates = [
    { x: anchor.x - 14, y: anchor.y - WORK_GAP, hang: true },
    { x: anchor.x + aw + 24, y: anchor.y, hang: false },
    { x: anchor.x - SPRITE_W - 24, y: anchor.y, hang: false },
    { x: anchor.x - 14, y: anchor.y + ah + WORK_GAP, hang: false },
  ];
  let best = candidates[0]; let bestCost = Infinity;
  for (const c of candidates) {
    const rect = { x: c.x, y: c.hang ? c.y - SPRITE_H : c.y, w: SPRITE_W, h: SPRITE_H };
    let cost = 0;
    for (const o of obstacles || []) {
      const ow = Math.min(rect.x + rect.w, o.x + o.w) - Math.max(rect.x, o.x);
      const oh = Math.min(rect.y + rect.h, o.y + o.h) - Math.max(rect.y, o.y);
      if (ow > 0 && oh > 0) cost += ow * oh;
    }
    if (cost === 0) return c;
    if (cost < bestCost) { bestCost = cost; best = c; }
  }
  return best;
}

/** 这个世界矩形当前在不在视口里（world_visible = screen/z - cam） */
function slotVisible(slot, cam, viewport) {
  if (!slot || !viewport?.w || !cam?.z) return false;
  const view = { x: -cam.x, y: -cam.y, w: viewport.w / cam.z, h: viewport.h / cam.z };
  // 身位按放置时刻的尺寸近似（缩放变了也就差一圈，判"在不在视野"够用）
  return hitRect({ x: slot.x, y: slot.y, w: SPRITE_W, h: SPRITE_H }, view);
}

/** 精灵离开视野多久才追过来。太快 = 用户一动画布它就跳，像牛皮糖。 */
const OFFSCREEN_RELOCATE_MS = 3000;

// ── 输出框（代码直播 / 终端）的落位 ──

/** 输出框身位：宽沿用舞台卡口径，高按"头 + 代码体 maxHeight 280"估 */
const FRAME_W = STAGE_CARD_W;
const FRAME_H_EST = 340;

/**
 * 输出框绕着精灵找位（2026-08-14 用户拍板：代码直播框跟精灵同层同住，
 * 以精灵为圆心保持在一定范围内；可以压产物，但要有算法尽量别压）。
 * 候选四方位按偏好序（脚下 → 右 → 左 → 头顶），第一个不压任何产物的赢；
 * 全都压着东西就挑压得最少的 —— "宁可压也不消失"，这跟精灵本体的
 * "全占就不出现"规矩刻意相反：闲话可以不说，正在写的代码必须看得见。
 */
export function findFrameSpot(at, obstacles) {
  if (!at) return null;
  const candidates = [
    { x: at.x, y: at.y + SPRITE_H + 14 },
    { x: at.x + SPRITE_W + 24, y: at.y },
    { x: at.x - FRAME_W - 24, y: at.y },
    { x: at.x, y: at.y - FRAME_H_EST - 22 },
  ];
  let best = candidates[0];
  let bestCost = Infinity;
  for (const c of candidates) {
    let cost = 0;
    for (const o of obstacles || []) {
      const ow = Math.min(c.x + FRAME_W, o.x + o.w) - Math.max(c.x, o.x);
      const oh = Math.min(c.y + FRAME_H_EST, o.y + o.h) - Math.max(c.y, o.y);
      if (ow > 0 && oh > 0) cost += ow * oh;
    }
    if (cost === 0) return c;
    if (cost < bestCost) { bestCost = cost; best = c; }
  }
  return best;
}

/**
 * 精灵层（**世界层**，挂在被相机变换的容器里）。2026-08-14 五批起是**唯一**
 * 的精灵家：工作/闲时不再是两个挂载点 —— 那套的缝隙正是用户报的"活跃真空"
 * （run 早期 / 纯思考 / 无文件工具阶段既没有目标矩形也不算闲，精灵整段消失，
 * 放射条动画从来没机会出现）。
 *
 * 位置只有一条决策链：
 *   - workAnchor 给了（agent 正在动某件东西且解析得到矩形）→ 贴着它（位置
 *     过渡"走过去"），槽位状态冻结在原地
 *   - 没有 anchor → 槽位逻辑：首次出场按视口找槽；平移缩放钉在纸上不动；
 *     离开视野 3 秒才追过来重新落位重画；视口全被占就不出现。
 *     **活跃与否不影响这条链** —— 活跃只换图标（转轮）和台词。
 */
export function AmbientSpriteLayer({ agentActive = false, workAnchor = null, cam, viewport, obstacles, text, quiet = false, onAsk, frameCards = [], renderFrameCard }) {
  // 身份跟着会话模型走（08-21）：跑 DeepSeek 就是鲸，跑 Ox 就是 OpenCode 方块。
  // 画布不传这个 prop —— 它自己就住在项目路由里，见 lib/model-brand.js
  const brand = useCurrentModelBrand();
  const [slot, setSlot] = useState(null);      // 世界坐标
  const [drawKey, setDrawKey] = useState(0);
  const stateRef = useRef({});
  stateRef.current = { cam, viewport, obstacles };
  const slotRef = useRef(null);
  slotRef.current = slot;
  const offTimer = useRef(null);
  const healTimer = useRef(null);
  /** 用户亲手拖过（08-24）：拖过的位置不自愈不追随 —— 他放哪就是哪；离屏重落时释放 */
  const userPinnedRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (workAnchor || !viewport?.w || !cam?.z) {
      // 贴着目标时槽位冻结：回到无目标态再说
      clearTimeout(offTimer.current); offTimer.current = null;
      clearTimeout(healTimer.current); healTimer.current = null;
      return undefined;
    }
    if (!slot) {
      const first = findAmbientSlot(cam, viewport, obstacles);
      if (first) { setDrawKey(k => k + 1); setSlot(first); }
      return undefined;
    }
    /**
     * 占位自愈（08-24 体检主修）：脚下被压了（新产物排进这一带 / agent 落了
     * 板书）→ 短防抖后重找空槽。**活跃时也让** —— "工作中不跟镜头"只是不
     * 追随用户视线，不是可以压着别人的作品不动；run.done 弹回旧槽正压着新
     * 产物这条主复现路径就靠它治。用户亲手拖过的位置不自愈（他放哪是哪）。
     * 找不到空槽就原地不动 —— 干活/对话中的精灵消失比压着更糟。
     */
    const meRect = { x: slot.x, y: slot.y, w: SPRITE_W, h: SPRITE_H };
    const pressed = !userPinnedRef.current && (obstacles || []).some(o => hitRect(meRect, o));
    if (pressed) {
      if (!healTimer.current) {
        healTimer.current = setTimeout(() => {
          healTimer.current = null;
          const { cam: c, viewport: vp, obstacles: obs } = stateRef.current;
          const cur = slotRef.current;
          const still = cur && (obs || []).some(o => hitRect({ x: cur.x, y: cur.y, w: SPRITE_W, h: SPRITE_H }, o));
          if (!still) return;
          const next = findAmbientSlot(c, vp, obs);
          if (next) { setDrawKey(k => k + 1); setSlot(next); }
        }, 400);
      }
    } else {
      clearTimeout(healTimer.current); healTimer.current = null;
    }
    // 工作中不跟镜头（2026-08-14 用户定的规则）：agent 干活的地方就是它站的
    // 地方，用户把镜头挪去看别处，它不追过来 —— 追随只是闲时的礼节。
    if (agentActive) {
      clearTimeout(offTimer.current); offTimer.current = null;
      return undefined;
    }
    if (slotVisible(slot, cam, viewport)) {
      clearTimeout(offTimer.current); offTimer.current = null;
    } else if (!offTimer.current) {
      // ⚠️ 计时器不进 effect cleanup —— cleanup 每次相机变化都跑，进去的话
      // 用户持续平移时 3 秒永远数不满。只在可见/换态时显式清。
      offTimer.current = setTimeout(() => {
        offTimer.current = null;
        userPinnedRef.current = false;   // 用户都把镜头挪走 3 秒了：钉住解除，跟过去
        const { cam: c, viewport: vp, obstacles: obs } = stateRef.current;
        const next = findAmbientSlot(c, vp, obs);
        if (next) { setDrawKey(k => k + 1); setSlot(next); }
      }, OFFSCREEN_RELOCATE_MS);
    }
    return undefined;
  }, [workAnchor, agentActive, cam, viewport, obstacles, slot]);

  // 卸载兜底：不走上面的显式清理路径时别让计时器对着空组件开枪
  useEffect(() => () => { clearTimeout(offTimer.current); clearTimeout(healTimer.current); }, []);

  /**
   * 用户拖精灵（08-24 用户报"挪不走"）：闲时可以直接拽走。屏幕位移 ÷ cam.z
   * 换成世界位移。第一下移动就钉住（自愈让路，别跟用户抢）；拖完留在原地。
   * 贴目标（工作态）不给拖 —— 那时它跟着 workAnchor，拖了也会被拽回去。
   */
  const dragBase = useRef(null);
  const onMarkDragMove = (dx, dy) => {
    const base = dragBase.current || (dragBase.current = { ...(slotRef.current || { x: 0, y: 0 }) });
    userPinnedRef.current = true;
    setDragging(true);
    const z = stateRef.current.cam?.z || 1;
    setSlot({ x: Math.round(base.x + dx / z), y: Math.round(base.y + dy / z) });
  };
  const onMarkDragEnd = () => { dragBase.current = null; setDragging(false); };

  // 贴目标时：落点过 findWorkSpot 避让（头顶→右→左→脚下，全压认最小遮挡）。
  // 头顶位以**精灵的下沿**吊在目标上边线之上（translateY(-100%)）—— 手写行
  // 一到三行不等，按上沿钉就等于"句子越长压产物越多"（2026-08-15 用户报）。
  const anchored = !!workAnchor;
  const workSpot = useMemo(
    () => (anchored ? findWorkSpot(workAnchor, obstacles) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [anchored, workAnchor?.x, workAnchor?.y, workAnchor?.w, workAnchor?.h, obstacles],
  );
  const hang = anchored && !!workSpot?.hang;
  const at = anchored
    ? (workSpot ? { x: Math.round(workSpot.x), y: Math.round(workSpot.y) } : null)
    : slot;
  // 输出框和输入行要的是精灵**外接框的左上角**：吊着的时候它在 at 之上一个身位
  const box = at && hang ? { x: at.x, y: at.y - SPRITE_H } : at;

  // 输出框落位：精灵在哪它就绕着哪找位。obstacles 变一次（产物增删/拖动落盘）
  // 才重算 —— 流式打字每拍都重排的话框会来回蹦。
  const hasFrames = frameCards.length > 0 && typeof renderFrameCard === 'function';
  const frameSpot = useMemo(
    () => (hasFrames ? findFrameSpot(box, obstacles) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasFrames, box?.x, box?.y, obstacles],
  );

  if (!at || !text) return null;
  return (
    <>
      <div style={{
        position: 'absolute', left: at.x, top: at.y, zIndex: 305, pointerEvents: 'none',
        // 头顶位整块往上吊一个自身高度：留白就跟手写行有几行无关了
        transform: hang ? 'translateY(-100%)' : undefined,
        // 目标间移动是"走过去"；槽位重落走 drawKey 重画（定格换场），过渡不碍事。
        // 用户拖着走时关过渡 —— 300ms 缓动会让它像橡皮筋一样追手
        transition: dragging ? 'none' : 'left 300ms cubic-bezier(0.32,0.72,0,1), top 300ms cubic-bezier(0.32,0.72,0,1)',
      }}>
        <SpriteSketch
          brand={brand} drawKey={drawKey} text={text} active={agentActive} quiet={quiet}
          // 对话通道：点星芒 → 在它脚下写一句（输入行位置 = 图标右下，
          // 从**当前落点**算 —— 长文遮挡输入行的病由 quiet 让位治）
          onMarkClick={onAsk ? () => onAsk({ x: box.x + 54, y: box.y + 50 }) : undefined}
          // 闲时可拖走（工作态跟着目标，不给拖）
          onMarkDragMove={anchored ? undefined : onMarkDragMove}
          onMarkDragEnd={anchored ? undefined : onMarkDragEnd}
        />
      </div>
      {/* 输出框（代码直播/终端）：跟着精灵走，绕它找不压产物的方位
          （findFrameSpot；全压就认最小遮挡）。并发多张只露最近两张 ——
          第三张起在聊天时间轴里永远有，画布不摆尸体墙。 */}
      {hasFrames && frameSpot && (
        <div style={{
          position: 'absolute', left: frameSpot.x, top: frameSpot.y, width: FRAME_W,
          zIndex: 304, pointerEvents: 'auto',
          display: 'flex', flexDirection: 'column', gap: 10,
          transition: 'left 300ms cubic-bezier(0.32,0.72,0,1), top 300ms cubic-bezier(0.32,0.72,0,1)',
        }}>
          {frameCards.slice(-2).map((c) => (
            <div key={c.blockId}>{renderFrameCard(c)}</div>
          ))}
        </div>
      )}
    </>
  );
}

// ── 文案池 ──

/** 工具在跑：轮播的旁白（用户点名要 cooking 这个味道） */
export const TOOL_PHRASES = ['cooking…', '正在制作', '落笔中', '搭着架子', '打磨细节', 'brewing…'];

/** 没工具没文本（在想）：安静一点的几句 */
export const THINK_PHRASES = ['琢磨着…', 'thinking…', '在打腹稿'];

/** 闲时问候（08-19 recap 退役后，闲时写的就只有它）。按钟点挑一池，进场定一句不轮换。 */
export function pickGreeting(now = new Date()) {
  const h = now.getHours();
  const pool = h < 6 ? ['夜深了，我陪你画完这张', 'late night, soft pencils']
    : h < 11 ? ['早上好，今天画点什么？', 'fresh paper, fresh ideas']
      : h < 18 ? ["it's coffee and claude time", '纸摊好了，随时开工']
        : ['晚上好，灵感夜班', 'good evening — night owl mode'];
  return pool[(now.getDate() + h) % pool.length];
}

/**
 * 精灵此刻该说什么（2026-08-17 从 BoardCanvas 搬来 —— 行数棘轮；而且台词的
 * 挑选逻辑本来就该跟上面那三个文案池住在一起，分居两个文件必然只改一边）。
 *
 * 工作态文案三级：工具在跑 → 轮播旁白（cooking…）；有手写短句（服务端把回复
 * 首句压的）→ 写它；都没有 = 在想 → 思考旁白轮播。轮播节拍 4.2s —— 每换一句就是
 * 一次重写动画，太快会像抽搐。
 *
 * ⚠️ 轮播计时挂在**活跃**上不是"工具在跑"上：纯思考阶段也要有话说 —— 只挂
 * toolsBusy 的话 thinking 台词永远停在第一句（用户报的活跃真空之一）。
 *
 * 闲时写问候语，进场定一句不轮换 —— 闲时的字是"留在纸上的"，不是跑马灯。
 * （2026-08-19 拆除：闲时原本优先写收场 recap"刚才干了什么"，还用
 *  localStorage per-project 记着让刷新也不忘。recap 唯一的产出方式是一发写死
 *  走订阅、不跟随会话模型的 haiku，那条线路整条拆了，这半边跟着走 —— 留着
 *  就是一个永远读不到新值、只会把上个月的旧句子挂在画布上的壳。
 *  ⚠️ 老用户浏览器里遗留的 `nd:recap:<projectId>` 键从此没人读，不清也不影响。）
 *
 * @returns {{ mainActive: boolean, workText: string, ambientText: string }}
 */
export function useSpriteAmbient({ presence, stageCards, spriteLine }) {
  const mainActive = !!presence[MAIN_AGENT_ID]?.active;
  const toolsBusy = useMemo(() => Object.values(stageCards).some(c =>
    c.status === 'running' && c.kind !== 'subagent' && c.kind !== 'question'), [stageCards]);

  const [phraseTick, setPhraseTick] = useState(0);
  useEffect(() => {
    if (!mainActive) return undefined;
    const t = setInterval(() => setPhraseTick(k => k + 1), 4200);
    return () => clearInterval(t);
  }, [mainActive]);

  const workText = toolsBusy
    ? TOOL_PHRASES[phraseTick % TOOL_PHRASES.length]
    : (spriteLine?.text || THINK_PHRASES[phraseTick % THINK_PHRASES.length]);

  const greeting = useMemo(() => pickGreeting(), []);

  return { mainActive, workText, ambientText: greeting };
}
