/**
 * 登录墙的帧钟（2026-08-28）。
 *
 * 定格动画成立的前提是**整个画面按同一个快门走**。08-27 之前墙上同时跑着好几种
 * 节拍（纸 8.7fps、板上的墨 11.9fps、红线 8.6fps、风吹纸摆平滑 60fps），被看见的
 * 只有最粗的那一种，于是它读起来像"坏了"而不像"手做的"—— 用户报的「帧率太低、
 * 观感不好」就是这个。
 *
 * 一个数飘出格子不会报错，也不会明显难看，只是那一样东西悄悄脱拍。所以钉在这儿：
 * WALL_CSS 里**每一个时长、每一处延迟**都得是 FRAME 的整数倍。
 */
import { describe, it, expect } from 'vitest';
import { WALL_CSS, MOTION, FRAME } from './wall-css.js';

/** 剥注释再看 —— 注释里写着 460ms/90ms 这些历史数字，不剥会误伤 */
const CODE = WALL_CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');

describe('登录墙：所有动效钉在同一格胶片上', () => {
  it('MOTION 里每个数都是一格的整数倍', () => {
    const bad = Object.entries(MOTION).filter(([, v]) => v % FRAME !== 0);
    expect(bad, `这几项不在 ${FRAME}ms 的格子上：${JSON.stringify(bad)}`).toEqual([]);
  });

  it('CSS 里每个 animation 时长都是一格的整数倍', () => {
    const durs = [...CODE.matchAll(/animation:\s*[\w-]+\s+(\d+)ms/g)].map((m) => Number(m[1]));
    expect(durs.length, '一条 animation 都没找到？写法变了，这条 lint 要跟着改')
      .toBeGreaterThanOrEqual(6);
    expect(durs.filter((v) => v % FRAME !== 0), '这些时长脱拍了').toEqual([]);
  });

  it('CSS 里每个延迟（含 calc 里的每一项）都是一格的整数倍', () => {
    // 延迟错半格比时长脱拍更隐蔽：那一样东西会在别人的两格之间自己跳一下
    const delays = [...CODE.matchAll(/animation-delay:([^;]+);/g)]
      .flatMap((m) => [...m[1].matchAll(/(-?\d+)ms/g)].map((x) => Number(x[1])));
    expect(delays.length, '一条 animation-delay 都没找到？').toBeGreaterThanOrEqual(4);
    expect(delays.filter((v) => v % FRAME !== 0), '这些延迟脱拍了').toEqual([]);
  });

  /**
   * ⛔⛔ 这条是全场最容易写错的一处，而且**错了不报错、只是变得更平滑**（跟本意
   * 正好相反）：`steps()` 是按**每两个关键帧之间**算的，不是按整条动画算的。
   *
   * 08-28 给 ndw-pin-in 加了两个中间帧做"过一点再回来"，格数当场被乘以 3 ——
   * 字面上还写着 6 格，实测画面每 26ms 就变一次。是 getAnimations() 加两张
   * 33ms 截图逐字节比才逮住的。
   *
   * 所以这条不看字面数字，按三样东西对账：**时长 ÷ (关键帧数-1) ÷ (steps-1)**
   * 必须正好等于一格。这也顺带钉死了"关键帧必须等距"。
   */
  it('每格正好一帧：时长 ÷ 关键帧区间 ÷ steps = FRAME', () => {
    /** 一条 @keyframes 有几个停格位（0%, 100% { } 这种一行挂多个的也要数对） */
    const stopsOf = (name) => {
      const blk = CODE.match(new RegExp(`@keyframes\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1];
      if (!blk) return 0;
      const stops = new Set();
      for (const m of blk.matchAll(/([\d.,%\s]*?|from|to)\s*\{/g)) {
        for (const one of String(m[1]).split(',')) {
          const v = one.trim();
          if (v) stops.add(v === 'from' ? 0 : v === 'to' ? 100 : parseFloat(v));
        }
      }
      return stops.size;
    };
    const rows = [...CODE.matchAll(/animation:\s*([\w-]+)\s+(\d+)ms\s+steps\((\d+)/g)]
      .map((m) => {
        const stops = stopsOf(m[1]);
        const perFrame = stops > 1 ? (Number(m[2]) / (stops - 1)) / (Number(m[3]) - 1) : null;
        return { 动画: m[1], 时长: Number(m[2]), 关键帧: stops, steps: Number(m[3]), 每格: perFrame };
      });
    expect(rows.length, '一条 steps 动画都没找到？写法变了，这条 lint 要跟着改')
      .toBeGreaterThanOrEqual(6);
    const bad = rows.filter((r) => r.每格 !== FRAME);
    expect(bad, `这几条没落在 ${FRAME}ms 的格子上（记住 steps 是按关键帧区间算的）：`
      + JSON.stringify(bad)).toEqual([]);
  });

  it('风吹纸摆也在格子上（它曾经是墙上唯一一个平滑的东西）', () => {
    expect(CODE, 'sway 又变回平滑的了 —— 那是墙上唯一脱拍的东西').toMatch(/ndw-sway\s+\d+ms\s+steps\(/);
    expect(CODE, 'sway 不许再读每张纸自带的周期：周期不统一就没法钉在格子上')
      .not.toMatch(/ndw-sway\s+var\(--dur/);
  });
});
