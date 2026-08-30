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
import { useEffect, useRef, useState } from 'react';
import { Sun, Moon, SunMoon } from 'lucide-react';
import { lightAt, readMode, writeMode, nextMode } from '../lib/daylight.js';
import { mountCanopy } from './home-canopy.js';
import { t } from '../lib/i18n.js';
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

const still = () => typeof window !== 'undefined'
  && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

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

  useEffect(() => {
    if (!under.current || !over.current) return undefined;
    const h = mountCanopy({
      under: under.current,
      over: over.current,
      // 每帧现读：模式换了、跨过了黄昏，都不用重新挂
      getLight: () => lightAt(getMode()),
      still: quiet,
    });
    if (!h) { setGl(false); return undefined; }
    return () => h.stop();
    // 静止模式下画的是一帧，模式换了得重画；动起来的那条路每帧现读，不用重挂
  }, [quiet, quiet ? m : null]);

  if (!gl) {
    // 退回 CSS 版（home-sun.js）：形状固定的渐变层，看得出是贴图，但有总比没有好
    return (
      <>
        <div className="ndd-sun" aria-hidden="true"><i /><i /></div>
        <div className="ndd-sun over" aria-hidden="true"><i /><i /></div>
      </>
    );
  }
  return (
    <>
      <canvas className="ndd-canopy" ref={under} aria-hidden="true" />
      <canvas className="ndd-canopy over" ref={over} aria-hidden="true" />
    </>
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
