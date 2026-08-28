// @vitest-environment happy-dom
/**
 * 轮播时序的回归（2026-08-17）。
 *
 * ## 这条测试为什么存在
 *
 * 第一版的定时器换完场就按「站着的那一拍」起计时，**没把进场那 5.5 秒算进去** ——
 * 纸还在一张张往上钉，收起的倒计时已经烧到一半了。旧参数下看不出来：那时
 * `hold` 是 15 秒，比进场长得多，正好把这个错盖住。是把节奏改成"一轮 10 秒、
 * 一直在动"之后，真跑抓帧才现形（第二套进场才 2.5 秒就被报成 leave）。
 *
 * 所以这里钉的是**相位的先后**，不是某个具体毫秒数：
 *   进场没跑完，不许进 leave；跑完 + 站一拍，才换下一套。
 * 数字改了这条测试照样成立 —— 它读的是 MOTION，不是硬编码。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { useSceneCarousel } from './useSceneCarousel.js';
import { MOTION, enterMs, leaveMs } from './wall-css.js';

const PAPERS = 20;
const SCENES = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

function mount(scenes = SCENES) {
  const seen = [];
  function Probe() {
    const { scene, phase } = useSceneCarousel(scenes, { paperCount: PAPERS });
    seen.push(`${scene.id}:${phase}`);
    return null;
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(<Probe />); });
  return { seen, last: () => seen[seen.length - 1], cleanup: () => act(() => root.unmount()) };
}

const tick = (ms) => act(() => { vi.advanceTimersByTime(ms); });

describe('墙的轮播时序', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

  it('第一套直接站着（不播进场），多站一会儿才开始收', () => {
    const w = mount();
    expect(w.last()).toBe('a:');
    tick(MOTION.still + 100);          // 只过了常规那一拍，首屏还有额外的停留
    expect(w.last()).toBe('a:');
    w.cleanup();
  });

  it('⭐ 进场没跑完不许收：换到第二套之后，leave 必须等在进场之后', () => {
    const w = mount();
    tick(MOTION.still + 2600 + 50);    // 首屏站完 → 起 leave
    expect(w.last()).toBe('a:leave');
    tick(leaveMs(PAPERS) + 10);        // 摘干净 → 换第二套，开始钉
    expect(w.last()).toBe('b:enter');

    // 进场进行中：哪怕已经过了「站着的那一拍」，也不许进 leave
    tick(MOTION.still + 50);
    expect(w.last()).toBe('b:enter');

    // 钉完 → 相位交还给常驻的风吹纸摆
    tick(enterMs(PAPERS) - MOTION.still - 50 + 10);
    expect(w.last()).toBe('b:');

    // 再站一拍才轮到 leave
    tick(MOTION.still + 20);
    expect(w.last()).toBe('b:leave');
    w.cleanup();
  });

  it('一轮 ≈ 10 秒（钉上去 + 站一拍 + 摘下来）', () => {
    const round = enterMs(PAPERS) + MOTION.still + leaveMs(PAPERS);
    expect(round).toBeGreaterThan(9000);
    // 08-28 上限从 11000 放到 11600：用户拍板把**卡与卡之间的间隔**拉大
    // （定格感放在这儿，而不是让每张卡自己抖），二十张纸一轮就多出 0.3 秒。
    // 这条守的是"别跑成二十秒"，不是守某个精确值。
    expect(round).toBeLessThan(11600);
  });

  it('只有一套场景就不转（定时器都不装）', () => {
    const w = mount([{ id: 'solo' }]);
    tick(60000);
    expect(w.seen.every(s => s === 'solo:')).toBe(true);
    w.cleanup();
  });
});
