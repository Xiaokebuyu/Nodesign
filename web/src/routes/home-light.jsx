/**
 * 光源层的挂载与那枚开关（2026-08-30）。
 *
 * 分工：怎么画在 home-canopy.js（着色器），几点了在 lib/daylight.js（太阳的模型），
 * 这里只管三件事 —— 挂画布、拿不到 WebGL 就退回 CSS 版、把「跟着时间 / 白天 /
 * 夜晚」这枚开关和光源接上。
 *
 * 模式存在模块作用域而不是某个组件的 state：开关挂在顶栏（AppShell 的 actions），
 * 光源层挂在板子上，两处离得很远，硬要提到共同祖先就得把 Home.jsx 撑开一截。
 * 一个 12 行的订阅比一条穿过三层的 props 便宜。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Sun, Moon, SunMoon } from 'lucide-react';
import { lightAt, castAt, sunFrom, readMode, writeMode, nextMode, GAIN_REF } from '../lib/daylight.js';
import { LIFT_VAR, castCss, contactCss } from '../lib/paper.js';
import { mountCanopy } from './home-canopy.js';
import { t } from '../lib/i18n.js';
import { seasonOf } from '../lib/season.js';
import { alpha, CHROME } from '../lib/theme.js';

// ── 模式：一个模块级的小订阅 ──────────────────────────────────
let mode = null;
const subs = new Set();

function getMode() {
  if (mode === null) mode = readMode();
  return mode;
}

export function setDayMode(v) {
  mode = v;
  writeMode(v);
  for (const f of subs) f(v);
}

export function useDayMode() {
  const [m, set] = useState(getMode);
  useEffect(() => {
    subs.add(set);
    set(getMode());
    return () => { subs.delete(set); };
  }, []);
  return m;
}

/**
 * ⭐ 光的实验台（在地址后面加 `?light=lab`）。
 *
 * 起因：09-01 做完「光源方向跟着钟点和季节走」之后，用户说「感觉视觉表现没什么
 * 变化」。查下来有两半，这是其中一半 —— **产品里只有三档（跟着时间 / 白天 /
 * 夜晚），没有任何地方能扫过一天**，所以「会变」这件事根本没有可看的入口。
 *
 * ⛔ 不能挂 `import.meta.env.DEV`：要看的地方是 exp 和生产，那儿跑的是生产构建，
 *   DEV 恒为 false，挂上去等于这个面板永远不出现。判据是地址栏，不是构建模式。
 *
 * 开着的时候强制走自动挡（手动挡会把钟点挪到 11:30 / 22:30，滑杆就失效了）。
 */
let lab = null;               // { hour, month } 或 null
/** useLightVars 挂上来的「立刻按当前的光重写一遍变量」（拖滑杆时不能走那 640ms 的缓动）*/
let writeNow = null;

function labDate() {
  if (!lab) return undefined;
  const d = new Date();
  d.setMonth(lab.month - 1, 15);
  d.setHours(Math.floor(lab.hour), Math.round((lab.hour % 1) * 60), 0, 0);
  return d;
}

/** ⭐ 全站取「此刻的光」只走这一个口子：着色器每帧读它，CSS 变量每分钟读它。 */
export function currentLight() {
  return lightAt(lab ? 'auto' : getMode(), labDate());
}

function setLab(next) {
  lab = next;
  writeNow?.();
}

const still = () => typeof window !== 'undefined'
  && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** 夜色压到多深就算「夜里」（sunAt 的 night 是 0→1 的连续量） */
const NIGHT_AT = 0.5;
/** 自动挡自己会跨过黄昏。这是换一次颜色不是动画，一分钟看一眼绰绰有余。 */
const WATCH_MS = 60_000;

/** 正在显示的那一份影子。模块级：换挡时要从上一份缓过去，而不是从头来。 */
let shownCast = null;

/**
 * ⭐⭐ 着色器已经替它们把长影子真投出来的那几档，CSS 这边只留接触影。
 *
 * 这张表要跟 home-occluders.js 的 OCCLUDERS **对齐**：列进遮挡图的元素在这儿降档，
 * 没列进去的（弹窗、浮层、菜单）保持原样 —— 着色器不认识它们，降了就一点影子都没有。
 * ⛔ 两张表分叉的后果是安静的：要么一张纸有两个影子，要么一张纸一个都没有。
 */
const SHEET_TIERS = new Set(['sheet', 'sheetHigh', 'stack', 'stackHigh']);

/**
 * 真渲染这一层到底挂上没有。拿不到 WebGL 的机器上它是 false，那时 CSS 那条长影子
 * 是唯一的影子，**一档都不能降**。由 Canopy 挂载时告诉这里。
 */
let rendered = false;
function setRendered(v) {
  if (rendered === v) return;
  rendered = v;
  writeNow?.();
}

/** 模式切换时影子转过去用多久 / 分几步。跟着色器那边 night 的缓动大致同步。 */
const TURN_MS = 640, TURN_STEPS = 8;

/**
 * ⭐⭐ 把这一刻的光写到 `<html>` 上 —— CSS 才够得着这件事。写两样：
 *
 *   `data-nd-light`  是白天还是夜里。台面一黑，**写在板面上的深色笔就跟着灭了**
 *                    （左栏那本账夜里 1.64:1），要救它得换成粉笔，而换笔是一条
 *                    CSS 规则的事，规则得有个能挂的钩子。
 *   `--nd-lift-*`    这一刻的影子（见 paper.js 的 PAPER_SHADOW）。**同一份光既
 *                    照着树影也投出纸的影子** —— 两边读的是同一个 castAt()，
 *                    所以太阳转到哪边，满屏的纸就往哪边投影，不会各走各的。
 *
 * ⚠️ 卸载时两样都摘掉：从首页登出走到登录墙，那块板不参与白天黑夜，留着的话
 *   它会莫名其妙地按夜里那套算，而影子也会停在离开时那个钟点上。
 *   摘掉之后 PAPER_SHADOW 落回 var() 的兜底，也就是站点原来那副样子。
 *
 * ⚠️ 用 useLayoutEffect 不用 useEffect：useEffect 在这一帧画完之后才跑，
 *   于是进页面会先闪一帧兜底的影子再跳到当前钟点。这是一次性的写变量，不是订阅。
 */
function useLightVars() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const write = (cast) => {
      for (const [tier, name] of Object.entries(LIFT_VAR)) {
        const demote = rendered && SHEET_TIERS.has(tier);
        root.style.setProperty(name, (demote ? contactCss : castCss)(cast, tier));
      }
    };
    // 一分钟看一眼。太阳一分钟走 0.1 度，这个粒度上影子是连续的。
    const now = () => {
      const light = currentLight();
      root.dataset.ndLight = light.night > NIGHT_AT ? 'night' : 'day';
      // ⭐⭐ 再发布两个标量，给"被光照到的东西"用：光有多强、有多暖。
      // 输入纸那两片签要按这个调受光 —— 它们跟影子读**同一份光**，
      // 不另算一遍，否则太阳转过去时影子动了而受光没动。
      root.style.setProperty('--nd-lit', ((1 - light.night) * (light.gain / GAIN_REF)).toFixed(3));
      root.style.setProperty('--nd-warm', light.warm.toFixed(3));
      return castAt(light);
    };

    let turn = 0;
    // ⭐ 手动换挡是从中午跳到半夜，影子该**转过去**而不是瞬移。缓的是 cast 那六个
    //   数本身（方向 / 长短 / 虚实 / 浓淡 / 冷暖），不是重算一遍时间 —— 两头的钟点
    //   差着十一个小时，中间插值出来的钟点没有意义，插值出来的影子有。
    // ⚠️ 分八步不是每帧：这几个变量一改，全站带影子的元素都要重画一遍。
    const turnTo = (to) => {
      const from = shownCast;
      if (!from) { write(to); shownCast = to; return; }
      clearInterval(turn);
      let step = 0;
      turn = setInterval(() => {
        step += 1;
        const k = step / TURN_STEPS;
        shownCast = Object.fromEntries(
          Object.keys(to).map((key) => [key, from[key] + (to[key] - from[key]) * k]),
        );
        write(shownCast);
        if (step >= TURN_STEPS) { clearInterval(turn); turn = 0; }
      }, TURN_MS / TURN_STEPS);
    };

    write(shownCast = now());
    // 拖滑杆的时候一路重写，不走缓动（缓动是给「点一下换挡」的）
    writeNow = () => { clearInterval(turn); turn = 0; write(shownCast = now()); };
    // ⛔ **换挡不能靠 effect 的依赖数组。** 试过 useLightVars(m)：模式一变，React
    //   先跑上一轮的清理（把变量摘光、shownCast 归零），新的一轮于是没有"上一份"
    //   可缓，缓动等于没写。所以这一层只挂一次，换挡走光源自己那个订阅。
    const onMode = () => {
      if (still()) writeNow();
      else turnTo(now());
    };
    subs.add(onMode);
    const tick = setInterval(() => { if (!turn) write(shownCast = now()); }, WATCH_MS);
    return () => {
      subs.delete(onMode);
      writeNow = null;
      clearInterval(tick); clearInterval(turn);
      // ⚠️ 走到登录墙那块板不参与白天黑夜，两样都得摘掉：留着的话它会莫名其妙地
      //   按夜里那套算，影子也会停在离开时那个钟点上。摘掉之后 PAPER_SHADOW 落回
      //   var() 的兜底，也就是站点原来那副样子。
      delete root.dataset.ndLight;
      for (const name of Object.values(LIFT_VAR)) root.style.removeProperty(name);
      root.style.removeProperty('--nd-lit');
      root.style.removeProperty('--nd-warm');
      shownCast = null;
    };
  }, []);
}


/**
 * 树影 / 台灯。两块画布是 `.ndd` 的兄弟节点，靠 z-index 一块压在内容下、
 * 一块压在内容上（见 home-sun.js 里的 CSS）。
 *
 * ⛔ 拿不到 WebGL 时**不是降级成静止的画布**，是整层不挂、退回上一版的 CSS
 * 渐变。一块空画布压在内容上什么都不画，比没有还糟：它会让人以为坏了。
 */
export function Canopy() {
  const under = useRef(null);
  const over = useRef(null);
  const [gl, setGl] = useState(true);
  const m = useDayMode();
  const quiet = still();
  useLightVars();

  useEffect(() => {
    if (!under.current || !over.current) return undefined;
    const h = mountCanopy({
      under: under.current,
      over: over.current,
      // 每帧现读：模式换了、跨过了黄昏、实验台在拖滑杆，都不用重新挂
      getLight: currentLight,
      still: quiet,
    });
    if (!h) { setGl(false); setRendered(false); return undefined; }
    setRendered(true);
    return () => { h.stop(); setRendered(false); };
    // 静止模式下画的是一帧，模式换了得重画；动起来的那条路每帧现读，不用重挂
  }, [quiet, quiet ? m : null]);

  if (!gl) {
    // 退回 CSS 版（home-sun.js）：形状固定的渐变层，看得出是贴图，但有总比没有好
    return (
      <>
        <div className="ndd-sun" aria-hidden="true"><i /><i /></div>
        <div className="ndd-sun over" aria-hidden="true"><i /><i /></div>
        <LightLab />
      </>
    );
  }
  return (
    <>
      <canvas className="ndd-canopy" ref={under} aria-hidden="true" />
      <canvas className="ndd-canopy over" ref={over} aria-hidden="true" />
      <LightLab />
    </>
  );
}

/**
 * 四季各挑一个代表月份（每季的中间那个月）。
 * ⚠️ 标签写月份不写季节名：楷体是切过的子集，「夏」「秋」「冬」三个字不在里面，
 *   写季节名会让这三个按钮逐字回退到系统宋体（font-subset.lint.test.js 会红）。
 *   为一个开发面板重切字体要动登录墙的逐像素基线，不值。
 */
const LAB_SEASONS = [['4月', 4], ['7月', 7], ['10月', 10], ['1月', 1]];
const hhmm = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;

/**
 * 实验台的面板。只在地址带 `?light=lab` 时出现。
 *
 * 它同时是**读数**不只是滑杆：光源在屏上的位置、影子的角度和长度都打在上面，
 * 因为「看着好像没变」和「值确实没变」是两回事，得能当场分开。
 */
function LightLab() {
  const [on] = useState(() => {
    try { return new URLSearchParams(window.location.search).get('light') === 'lab'; } catch { return false; }
  });
  const [, bump] = useState(0);

  useLayoutEffect(() => {
    if (!on) return undefined;
    const d = new Date();
    // ⚠️ 月份要**吸附到本季的代表月**，不能直接用今天的月份：今天是 9 月，四个按钮
    //   是 4/7/10/1，于是一个都不高亮，看起来像坏了。季节是对的（9 月和 10 月同属秋），
    //   错的只是「当前在哪一档」这件事没显示出来。
    const here = seasonOf(d);
    const snap = LAB_SEASONS.find(([, m]) => seasonOf(new Date(d.getFullYear(), m - 1, 15)) === here);
    setLab({ hour: d.getHours() + d.getMinutes() / 60, month: snap ? snap[1] : d.getMonth() + 1 });
    bump((n) => n + 1);
    return () => { setLab(null); };
  }, [on]);

  if (!on || !lab) return null;
  const light = currentLight();
  const cast = castAt(light);
  const from = sunFrom(light);
  const set = (next) => { setLab({ ...lab, ...next }); bump((n) => n + 1); };
  const num = (v, n = 2) => v.toFixed(n);

  return (
    <div
      style={{
        position: 'fixed', left: 12, bottom: 12, zIndex: 9990, width: 268,
        padding: '10px 12px 12px', borderRadius: 6,
        background: 'rgba(22,17,12,0.88)', color: '#F2EEE4',
        font: '11px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
        boxShadow: '0 6px 24px rgba(0,0,0,0.4)', userSelect: 'none',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <b>光 · 实验台</b>
        <span style={{ opacity: 0.6 }}>?light=lab</span>
      </div>
      <input
        type="range" min={0} max={23.99} step={0.1} value={lab.hour}
        onChange={(e) => set({ hour: Number(e.target.value) })}
        style={{ width: '100%', margin: '2px 0 6px', accentColor: '#D8A85A' }}
        aria-label="时刻"
      />
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        {LAB_SEASONS.map(([name, month]) => (
          <button
            key={month} type="button" onClick={() => set({ month })}
            style={{
              flex: 1, border: 'none', borderRadius: 3, cursor: 'pointer',
              padding: '3px 0', fontFamily: 'inherit', fontSize: 11,
              background: lab.month === month ? '#D8A85A' : 'rgba(255,255,255,0.10)',
              color: lab.month === month ? '#241B12' : '#F2EEE4',
            }}
          >{name}</button>
        ))}
      </div>
      <div style={{ opacity: 0.85 }}>
        <div>{hhmm(lab.hour)} · {light.phase} · 夜 {num(light.night)} · 强度 {num(light.gain)}</div>
        <div>光源 [{num(from[0])}, {num(from[1])}] · 高度 {num(light.elev)}</div>
        <div>影子 {num(Math.atan2(cast.x, cast.y) * 180 / Math.PI, 1)}° · 长 ×{num(cast.len)} · 虚 ×{num(cast.blur)}</div>
      </div>
      <div style={{ opacity: 0.45, marginTop: 6 }}>开着时走自动，顶栏开关不生效</div>
    </div>
  );
}

const ICON = { auto: SunMoon, day: Sun, night: Moon };

/** 顶栏那枚开关。点一下换一档：跟着时间 → 白天 → 夜晚 */
export function DayToggle({ style, compact = false }) {
  const m = useDayMode();
  const Icon = ICON[m] || SunMoon;
  const label = { auto: t('跟着时间'), day: t('白天'), night: t('夜晚') }[m];
  return (
    <button
      type="button"
      onClick={() => setDayMode(nextMode(m))}
      title={`${t('光线')} · ${label}`}
      aria-label={`${t('光线')} · ${label}`}
      style={{
        // 旁边两个动作是 <a>，这个是 <button>：浏览器默认的边框和字体得先收掉，
        // 否则三个东西在顶栏里长得不一样。
        // ⚠️ 写在 spread **之前** —— 调用方给的 fontSize / color 必须压得住这里，
        // 而且不能用 font 简写（那会把 fontSize 一起重置掉）。
        border: 'none', fontFamily: 'inherit', cursor: 'pointer',
        ...style,
        // 手动挡的时候把按钮点亮一点：现在的光跟外面的天不一样，这事得看得见
        background: m === 'auto' ? 'transparent' : alpha(CHROME.ink, 0.07),
      }}
    >
      <Icon size={14} />{compact ? null : ` ${label}`}
    </button>
  );
}
