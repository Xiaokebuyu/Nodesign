import { useState, useRef, useCallback, useEffect } from 'react';
import {
  IDENTITY_CAMERA, ZOOM_MIN, ZOOM_MAX, ROAM_MARGIN, CAMERA_PADDING, CAMERA_ORIGIN,
  constrainCamera, zoomAtScreenPoint, stepZoom, fitBox, boxExpand, screenToWorld,
} from '../../lib/board-camera.js';
import { onBlankCanvas, onChrome } from '../../lib/board-hit.js';
import { useTouchGestures } from './useTouchGestures.js';
import { useDeviceClass } from '../../lib/device-class.js';

/**
 * useBoardCamera —— 画布相机的状态、输入与动画（2026-08-07）
 *
 * 数学全在 `lib/board-camera.js`（纯函数、28 条测试）。这里只管三件事：
 * 存相机、把输入事件翻译成相机动作、把镜头移动做成动画。
 *
 * ## 输入约定（跟主流无限画布对齐，用户不用学）
 *
 * - 滚轮 / 触控板双指     → 平移（垂直；按住 Shift 变水平）
 * - Ctrl / Cmd + 滚轮     → 在光标处缩放
 * - 拖空白背景            → 平移
 * - 中键拖                → 平移（任何位置，包括压在卡片上）
 * - 按住空格拖            → 平移（任何位置；"画面塞满找不到空地"时用这条）
 * - **双指捏合 / 双指拖** → 缩放 / 平移（触屏，2026-08-21；实现在 useTouchGestures.js）
 *   上面五条在手机上一条都用不上（没滚轮、没中键、没键盘），双指那两条是手指版的
 *   "空格 + 拖"。
 *
 * **抓手工具 2026-08-17 退役**（2026-08-08 加的）。当初加它是因为「平移」只有
 * 空白背景这一个常驻入口，画布越满空白越少；工具化还能把"我在挪镜头还是挪
 * 东西"变成一个看得见的状态。撤它的理由是账算下来它是第五条平移路（前四条
 * 见上），唯一独有的只是"不用按住任何键"，而代价是模式工具的通病 —— 选了
 * 忘了切回来，画布就变得什么都点不动。空格态留着，它才是那个场景的正解。
 *
 * 2026-07-27 那版曾定「滚轮=缩放、平移只靠拖背景」。**这次不沿用**：那时候
 * 画布只占右半屏、内容一屏多点，滚轮缩放尚可；现在画布全屏、内容纵向长得多，
 * 滚轮的第一直觉必须是"翻页"。缩放交给 Ctrl+滚轮和工具栏档位。
 *
 * ## 用户接管
 *
 * agent 跟随（followTo）与用户操作会抢镜头。规则沿用 2026-07-28 那版：
 * **用户任何主动操作后 8 秒内，跟随不许动镜头**。相机动画本身不算用户操作。
 */

/** 用户接管冷却（毫秒） */
const TAKEOVER_MS = 8000;
/** 镜头动画时长 */
const FLY_MS = 420;
/** 滚轮平移速度（触控板一格约 100，乘 1 就够跟手） */
const PAN_SPEED = 1;
/** 滚轮缩放灵敏度 */
const ZOOM_SPEED = 0.0022;

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * @param {boolean|null} [p.fingerPansAnywhere]  单指按在哪儿都是推画面。
 *   缺省（null）= **按设备档自己判**，只有手机为真。给显式值是为了测试和以后的
 *   用户偏好，别在调用方那边再抄一遍这个判据。
 *
 * ## 单指归谁：2026-08-31 拆开手机和平板
 *
 * 08-21 为了修「双指捏合把卡带跑」，定的是「手指按在哪儿都是推画面」。那条规矩
 * 在**手机**上是对的：390 宽的屏上卡片几乎铺满，要求先找一块空地才能推画面，
 * 等于没法推。但它在**平板**上只有代价没有收益 —— 810 的屏上空地到处都是，
 * 而这条规矩让平板上落不了笔、选不中、拖不动，一整套工具跟着被撤掉。
 *
 * 现在的规矩一句话：**两根手指永远是相机**（那条路在 useTouchGestures，跟这里
 * 无关，任何时候都成立）；**单根手指归当前工具** —— 指针工具按在空地上就是推
 * 画面，按在卡上就是拿卡，跟鼠标一模一样。手机保留旧规矩（fingerPansAnywhere），
 * 因为那里"空地"这个前提本身不成立。
 */
export function useBoardCamera({ paneRef, contentBox, enabled = true, fingerPansAnywhere = null }) {
  const deviceClass = useDeviceClass();
  // 判据用设备档不用视口宽：拖窄的桌面窗口没有这个问题，它手里有鼠标。
  const fingerPans = fingerPansAnywhere == null ? deviceClass === 'phone' : fingerPansAnywhere;
  const [cam, setCam] = useState(IDENTITY_CAMERA);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [panning, setPanning] = useState(false);

  const camRef = useRef(cam);
  camRef.current = cam;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const panRef = useRef(null);
  const flyRef = useRef(null);
  const holdUntilRef = useRef(0);
  /**
   * 按住空格 = 临时抓手。**这是"画面塞满、找不到空地下手"时的正解** ——
   * 2026-08-17 抓手工具退役后它就是唯一的那条路了（另外还有滚轮/触控板两指、
   * 中键拖，以及指针拖空地）。
   * ref 而不是 state：shouldPan 要在 pointerdown 那一刻读最新值，不进依赖数组。
   */
  const spaceRef = useRef(false);
  /**
   * 手指按在屏幕上（2026-08-21）。**只记录事实**：这一下归不归相机，由下面的
   * fingerPanRef 决定（2026-08-31 拆开手机和平板，理由在函数头）。
   * 拖卡 / 工作区手势 / 相机三方本来就都在问 isHandMode()，所以这一个开关就够。
   */
  const touchRef = useRef(false);
  /**
   * 上面那条「手指落下就归相机」认不认数（2026-08-31）。
   *
   * ⚠️ 闸装在**读的那一侧**不装在写的那一侧：touchRef 仍然如实记录"有没有手指
   * 按着"，只是平板上不再拿它去抢手势。写的那侧改成条件赋值的话，
   * touchRef 就变成一个有时候撒谎的字段，别处再读它就没法信。
   */
  const fingerPanRef = useRef(fingerPans);
  fingerPanRef.current = fingerPans;
  /** 此刻单指该不该归相机 */
  const fingerOwnsCamera = () => touchRef.current && fingerPanRef.current;
  /**
   * 手指把一张卡「拿起来」了（长按武装成功，2026-08-29）。
   *
   * ⭐ 仲裁只能有一个主人。触屏上「这一串事件到底是推画面、拿卡、还是捏合」
   * 三方都想管，08-21 那次翻车就是三方各拽各的。所以规矩定死：**相机是主人** ——
   * 手指一落下先归它（touchRef），长按到点了才由拖卡来**跟它要**（beginCardGrab），
   * 第二根手指落下它再**收回去**（并回调撤销）。别处一律只读 isHandMode()。
   */
  const cardGrabRef = useRef(null);   // { abort } —— 拿着卡时非空
  // 键盘 effect 挂在最上面、动作定义在下面，用 ref 转一手：
  // 直接依赖那几个 useCallback 会让监听每次重挂，按键在重挂的缝里会丢。
  const zoomToFitRef = useRef(null);
  const zoomByRef = useRef(null);
  const zoomToRef = useRef(null);

  /**
   * 内容边界（外沿放宽一圈）。2026-08-13 起它**不再约束相机** —— 只喂给
   * 小地图做投影范围。留着它是因为"内容聚在哪一片"这个事实本身有用。
   */
  const boundsRef = useRef(null);
  const bounds = contentBox ? boxExpand(contentBox, ROAM_MARGIN) : null;
  boundsRef.current = bounds;

  const constrainOpts = useCallback(() => ({
    bounds: boundsRef.current,
    viewport: viewportRef.current,
    padding: CAMERA_PADDING,
    origin: CAMERA_ORIGIN,
    /**
     * 2026-08-13：`'contain'` → `'free'`，画布本身无限。
     *
     * contain 的体感是三面硬墙：内容装得下的那一轴干脆**钉死不响应平移**
     * （不是撞墙，是拖了没反应），而内容只往下长，于是左/右/上永远是墙。
     * 用户的原话是"用起来很怪"。走丢的兜底不靠夹持：小地图的投影含视口
     * （跑多远都看得见回去的方向），外加 Shift+1 全部内容入镜。
     */
    behavior: 'free',
    zoomMin: ZOOM_MIN,
    zoomMax: ZOOM_MAX,
  }), []);

  /** 落一个新相机（永远过一遍约束，外部拿不到非法相机） */
  const apply = useCallback((next) => {
    setCam(prev => constrainCamera(next, prev, constrainOpts()));
  }, [constrainOpts]);


  const noteTakeover = useCallback(() => {
    holdUntilRef.current = Date.now() + TAKEOVER_MS;
    if (flyRef.current) { cancelAnimationFrame(flyRef.current.raf); flyRef.current = null; }
  }, []);
  // 触屏手势（双指捏合缩放 / 双指平移）。挂在捕获阶段的原生监听上 —— 理由见那个文件。
  // ⚠️ 这四个参数必须都是**稳定引用**：每渲染换一个新函数，原生监听就每渲染重挂一次，
  // 手势状态（那张手指表）跟着被清空，捏到一半就断。
  useTouchGestures({ paneRef, camRef, apply, noteTakeover, handRef: touchRef, enabled });

  // ── 视口尺寸 ──
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const measure = () => setViewport(prev => (
      prev.w === el.clientWidth && prev.h === el.clientHeight
        ? prev : { w: el.clientWidth, h: el.clientHeight }
    ));
    measure();
    let ro = null;
    try { ro = new ResizeObserver(measure); ro.observe(el); } catch { /* 老浏览器 */ }
    window.addEventListener('resize', measure);
    return () => { ro?.disconnect(); window.removeEventListener('resize', measure); };
  }, [paneRef]);

  // 视口或内容变化后，把相机重新夹一遍（否则改窗口大小会留在非法位置）
  useEffect(() => {
    if (!viewport.w || !bounds) return;
    setCam(prev => constrainCamera(prev, prev, constrainOpts()));
    // bounds 每帧都是新对象，用它的四个数当依赖，别用引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport.w, viewport.h, bounds?.x, bounds?.y, bounds?.w, bounds?.h, constrainOpts]);

  // ── 空格 = 抓手 ──
  useEffect(() => {
    if (!enabled) return;
    const down = (e) => {
      if (e.code !== 'Space') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      spaceRef.current = true;
    };
    const up = (e) => { if (e.code === 'Space') spaceRef.current = false; };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [enabled]);

  // ── 键盘档位 ──
  //
  // 跟主流无限画布对齐，用户不用学：
  //   Shift+1  全部内容入镜（迷路了按这个）
  //   Ctrl/Cmd + = / -   放大 / 缩小一档
  //   Ctrl/Cmd + 0       回到 100%
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.shiftKey && !mod && e.code === 'Digit1') { e.preventDefault(); zoomToFitRef.current?.(); return; }
      if (!mod) return;
      if (e.code === 'Equal' || e.code === 'NumpadAdd') { e.preventDefault(); zoomByRef.current?.(1); }
      else if (e.code === 'Minus' || e.code === 'NumpadSubtract') { e.preventDefault(); zoomByRef.current?.(-1); }
      else if (e.code === 'Digit0') { e.preventDefault(); zoomToRef.current?.(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);

  // ── 滚轮 ──
  //
  // 用原生监听而不是 React 的 onWheel：React 挂的是 passive 监听，
  // preventDefault 会被忽略，于是 Ctrl+滚轮会连着触发浏览器自己的页面缩放。
  useEffect(() => {
    const el = paneRef.current;
    if (!el || !enabled) return;
    const onWheel = (e) => {
      e.preventDefault();
      noteTakeover();
      const c = camRef.current;
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        const pt = { x: e.clientX - r.left, y: e.clientY - r.top };
        // 指数映射：每一格滚动改变的是缩放的**比例**不是绝对值，
        // 这样从 0.2 放到 0.3 和从 2 放到 3 手感一致。
        const nextZ = c.z * Math.exp(-e.deltaY * ZOOM_SPEED);
        apply(zoomAtScreenPoint(c, pt, nextZ));
      } else {
        const dx = (e.shiftKey ? e.deltaY : e.deltaX) * PAN_SPEED;
        const dy = (e.shiftKey ? 0 : e.deltaY) * PAN_SPEED;
        apply({ x: c.x - dx / c.z, y: c.y - dy / c.z, z: c.z });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [paneRef, enabled, apply, noteTakeover]);

  // ── 拖背景平移 ──

  /** 这个 pointerdown 该不该起平移。判据是共享的（board-hit.js）—— 见那里的说明。 */
  const shouldPan = useCallback((e) => {
    if (!enabled) return false;
    if (e.button === 1) return true;                    // 中键：任何位置
    if (e.button !== 0) return false;
    // 空格抓手 / 手指：任何位置都平移，**但仍要躲开界面控件** —— 按着空格点工具栏，
    // 按钮会被当成画布抢走指针捕获（board-hit.js 顶上记的第 1 个坑）。
    if (spaceRef.current || fingerOwnsCamera()) return !onChrome(e);
    return onBlankCanvas(e);
  }, [enabled]);

  const onPointerDown = useCallback((e) => {
    if (!shouldPan(e)) return false;
    noteTakeover();
    panRef.current = {
      id: e.pointerId,
      startX: e.clientX, startY: e.clientY,
      camX: camRef.current.x, camY: camRef.current.y,
      moved: false,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    return true;
  }, [shouldPan, noteTakeover]);

  const onPointerMove = useCallback((e) => {
    const p = panRef.current;
    if (!p || p.id !== e.pointerId) return false;
    const dx = e.clientX - p.startX;
    const dy = e.clientY - p.startY;
    if (!p.moved && Math.abs(dx) + Math.abs(dy) < 3) return true;
    if (!p.moved) { p.moved = true; setPanning(true); }
    const z = camRef.current.z;
    // 位移换算成世界单位再加：缩放后 1 屏幕像素 ≠ 1 世界单位
    apply({ x: p.camX + dx / z, y: p.camY + dy / z, z });
    return true;
  }, [apply]);

  const onPointerUp = useCallback((e) => {
    const p = panRef.current;
    if (!p || (e && p.id !== e.pointerId)) return false;
    panRef.current = null;
    setPanning(false);
    return p.moved;   // 返回"这次是不是真拖了"，调用方用它区分点击
  }, []);

  // ── 镜头动画 ──

  const flyTo = useCallback((target, { force = false, duration = FLY_MS } = {}) => {
    if (!force && Date.now() < holdUntilRef.current) return;
    const vp = viewportRef.current;
    if (!vp.w || !vp.h) return;
    const to = constrainCamera(target, camRef.current, constrainOpts());
    const from = { ...camRef.current };
    if (Math.abs(to.x - from.x) < 0.5 && Math.abs(to.y - from.y) < 0.5 && Math.abs(to.z - from.z) < 0.001) return;

    if (flyRef.current) cancelAnimationFrame(flyRef.current.raf);
    const t0 = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - t0) / duration);
      const k = easeInOutCubic(t);
      setCam({
        x: from.x + (to.x - from.x) * k,
        y: from.y + (to.y - from.y) * k,
        z: from.z + (to.z - from.z) * k,
      });
      if (t < 1) flyRef.current = { raf: requestAnimationFrame(tick) };
      else flyRef.current = null;
    };
    flyRef.current = { raf: requestAnimationFrame(tick) };
  }, [constrainOpts]);

  useEffect(() => () => { if (flyRef.current) cancelAnimationFrame(flyRef.current.raf); }, []);

  /**
   * 把一块世界矩形框进视口。
   *
   * 取景参数（axis / alignY / padding / maxZoom）**原样透传给 fitBox** ——
   * 手机上「一件占满一屏」要的是按宽取景 + 顶对齐（见 lib/board-reading.js 的
   * readFocusOpts），而不是两轴都装得下。⚠️ 08-28 之前这里只转了 maxZoom 一个，
   * 别的悄悄被吃掉：调用方写了 axis 也不生效，而且不报错。
   */
  const flyToBox = useCallback((box, opts = {}) => {
    const vp = viewportRef.current;
    if (!box || !vp.w) return;
    flyTo(fitBox(box, vp, {
      maxZoom: opts.maxZoom ?? 1,
      axis: opts.axis, alignY: opts.alignY, padding: opts.padding,
    }), opts);
  }, [flyTo]);

  /**
   * 保持缩放，**立刻**把一点挪到视口中心（不动画）。
   *
   * 小地图拖拽要的是 1:1 跟手：每一帧都 flyTo 的话，每一帧都在重启一段
   * 380ms 缓动，手停下来镜头还在追，拖起来像在拽橡皮筋。同理它也不能吃
   * `holdUntil` 那道门 —— 拖小地图本身就是用户在开镜头，不是别人来抢。
   */
  const jumpToPoint = useCallback((pt) => {
    const vp = viewportRef.current;
    if (!pt || !vp.w) return;
    noteTakeover();
    const z = camRef.current.z;
    apply({ z, x: vp.w / 2 / z - pt.x, y: vp.h / 2 / z - pt.y });
  }, [apply, noteTakeover]);

  /** 保持缩放，把一点挪到视口中心 */
  const flyToPoint = useCallback((pt, opts = {}) => {
    const vp = viewportRef.current;
    if (!pt || !vp.w) return;
    const z = camRef.current.z;
    flyTo({ z, x: vp.w / 2 / z - pt.x, y: vp.h / 2 / z - pt.y }, opts);
  }, [flyTo]);

  /** 全部内容入镜 */
  const zoomToFit = useCallback((opts = {}) => {
    if (contentBox) flyToBox(contentBox, { force: true, ...opts });
  }, [contentBox, flyToBox]);

  const zoomBy = useCallback((dir) => {
    noteTakeover();
    const vp = viewportRef.current;
    const c = camRef.current;
    apply(zoomAtScreenPoint(c, { x: vp.w / 2, y: vp.h / 2 }, stepZoom(c.z, dir)));
  }, [apply, noteTakeover]);

  const zoomTo = useCallback((z) => {
    noteTakeover();
    const vp = viewportRef.current;
    apply(zoomAtScreenPoint(camRef.current, { x: vp.w / 2, y: vp.h / 2 }, z));
  }, [apply, noteTakeover]);

  /**
   * 按**屏幕像素**推一下相机（拖物件到视口边缘时的自动跟随，2026-08-17 issue #1 第 6 条）。
   *
   * 正数 = 视口往右／往下走（内容相对往左／往上跑），跟 onPointerMove 那条
   * 手动平移的符号相反 —— 那边是"抓着内容拖"，这边是"把镜头推过去"。
   *
   * 走 apply 所以照样吃 constrain（不会推出漫游边界）；noteTakeover 让自动
   * 取景在这段时间里别抢镜。
   */
  const panByScreen = useCallback((dxPx, dyPx) => {
    if (!dxPx && !dyPx) return;
    noteTakeover();
    const c = camRef.current;
    apply({ z: c.z, x: c.x - dxPx / c.z, y: c.y - dyPx / c.z });
  }, [apply, noteTakeover]);

  /** 屏幕坐标 → 世界坐标（放置新物件、命中测试都要） */
  const toWorld = useCallback((clientX, clientY) => {
    const el = paneRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return screenToWorld({ x: clientX - r.left, y: clientY - r.top }, camRef.current);
  }, [paneRef]);

  zoomToFitRef.current = zoomToFit;
  zoomByRef.current = zoomBy;
  zoomToRef.current = zoomTo;

  return {
    cam, camRef, viewport, panning, bounds,
    // 按住空格中，或者手指正按在屏幕上（抓手工具 08-17 已退役）
    // 拿着卡的时候不是抓手态：这一串事件已经判给拖卡了，相机和别的手势都让开
    isHandMode: () => !cardGrabRef.current && (spaceRef.current || fingerOwnsCamera()),
    /**
     * 拖卡跟相机要走这一串事件。相机当场停掉在飞的平移（否则画面会跟着手指
     * 一起走，卡和背景双份位移）。abort 存着：第二根手指落下时相机负责调它。
     */
    beginCardGrab: (abort) => { panRef.current = null; setPanning(false); cardGrabRef.current = { abort }; },
    endCardGrab: () => { cardGrabRef.current = null; },
    /** 第二根手指来了：把卡放回去，这一串交给捏合 */
    abortCardGrab: () => {
      const g = cardGrabRef.current;
      cardGrabRef.current = null;
      g?.abort?.();
    },
    noteTakeover,
    onPointerDown, onPointerMove, onPointerUp,
    flyTo, flyToBox, flyToPoint, jumpToPoint, zoomToFit, zoomBy, zoomTo, toWorld,
    panByScreen,
  };
}
