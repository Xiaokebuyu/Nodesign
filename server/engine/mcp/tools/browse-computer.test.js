/**
 * browse-computer：坐标 1:1 的前提 + 键名/修饰键翻译 + 坐标校验（2026-08-21）
 *
 * 最要紧的是第一条：视口必须落在 shot-pipeline 不缩图的范围内。视口和阈值分住
 * 两个文件，谁改了一边另一边不会知道 —— 这条断言就是把两边钉在一起的钉子。
 */
import { describe, it, expect, vi } from 'vitest';
import { _limits } from '../../browse/registry.js';
import { API_IMAGE_LIMITS } from './helpers/shot-pipeline.js';
import { ACTIONS, parseChords, parseModifiers, checkCoord, liveFrame, viewportShot, BROWSE_FRAME } from './browse-computer.js';

// 存桌面卡预览那一步要写盘，跟这组测的东西无关，挡掉
vi.mock('../../browse/state.js', () => ({ saveFrame: async () => {}, recordVisit: async () => {} }));

describe('browser_computer 坐标空间', () => {
  it('视口在归一化阈值内：截图不缩，截图像素 = 视口像素', () => {
    const { width: w, height: h } = _limits.VIEWPORT;
    const scale = Math.min(1, API_IMAGE_LIMITS.longEdge / Math.max(w, h), Math.sqrt(API_IMAGE_LIMITS.maxPixels / (w * h)));
    expect(scale).toBe(1);
  });

  it('动作表 = browser_toolset_20260801 的指针/键盘/截图成员', () => {
    expect(ACTIONS).toEqual([
      'screenshot', 'zoom',
      'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'hover',
      'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'mouse_move',
      'scroll', 'scroll_to',
      'type', 'key', 'hold_key', 'wait',
    ]);
  });

  it('checkCoord：视口内放行，越界/畸形给可读错误', () => {
    expect(checkCoord([0, 0])).toBeNull();
    expect(checkCoord([_limits.VIEWPORT.width, _limits.VIEWPORT.height])).toBeNull();
    expect(checkCoord([-1, 10])).toMatch(/outside/);
    expect(checkCoord([10, 99999])).toMatch(/outside/);
    expect(checkCoord([1])).toMatch(/\[x, y\]/);
    expect(checkCoord(['a', 'b'])).toMatch(/\[x, y\]/);
  });

  it('checkCoord 按传入的 frame（截图空间）判界，不按视口', () => {
    const frame = { w: 1000, h: 500, scale: 0.5 };   // 2000×1000 的页缩一半
    expect(checkCoord([999, 499], frame)).toBeNull();
    expect(checkCoord([1001, 10], frame)).toMatch(/1000×500 screenshot/);
  });

  it('08-21 视觉档参数：长边 2000（>20 图时每边 ≤2000 的硬限制）、3.75MP；常见产物视口不再被缩', () => {
    expect(API_IMAGE_LIMITS.longEdge).toBe(2000);
    expect(API_IMAGE_LIMITS.maxPixels).toBe(3_750_000);
    const scaleOf = (w, h) => Math.min(1, API_IMAGE_LIMITS.longEdge / Math.max(w, h), Math.sqrt(API_IMAGE_LIMITS.maxPixels / (w * h)));
    expect(scaleOf(1920, 1080)).toBe(1);   // deck 全幅 1:1（旧档会缩到 1568）
    expect(scaleOf(1440, 900)).toBe(1);    // 站点桌面 1:1
    expect(scaleOf(1440, 4000)).toBeCloseTo(0.5, 2);   // 超长整页才缩（长边 2000）
  });
});

describe('键名翻译（xdotool 风格 → Playwright）', () => {
  it('单键 / 和弦 / 序列', () => {
    expect(parseChords('Return')).toEqual([['Enter']]);
    expect(parseChords('Enter')).toEqual([['Enter']]);
    expect(parseChords('ctrl+s')).toEqual([['Control', 's']]);
    expect(parseChords('cmd+shift+a')).toEqual([['Meta', 'Shift', 'a']]);
    expect(parseChords('Backspace Backspace Delete')).toEqual([['Backspace'], ['Backspace'], ['Delete']]);
    expect(parseChords('shift+Tab Tab')).toEqual([['Shift', 'Tab'], ['Tab']]);
    expect(parseChords('Page_Down')).toEqual([['PageDown']]);
    expect(parseChords('F5')).toEqual([['F5']]);
    expect(parseChords('Escape')).toEqual([['Escape']]);
    expect(parseChords('a')).toEqual([['a']]);
  });
  it('只有修饰键没有主键 → 报错（别静默按个空）', () => {
    expect(() => parseChords('ctrl')).toThrow(/only modifiers/);
    expect(() => parseChords('')).toThrow(/needs a key/);
  });
  it('parseModifiers', () => {
    expect(parseModifiers('')).toEqual([]);
    expect(parseModifiers(undefined)).toEqual([]);
    expect(parseModifiers('ctrl+shift')).toEqual(['Control', 'Shift']);
    expect(parseModifiers('super')).toEqual(['Meta']);
    expect(() => parseModifiers('hyper')).toThrow(/unknown modifier/);
  });
});

/**
 * 坐标空间现量（2026-09-10）。
 *
 * 为什么值得一组测试：写死 1366×768 的错法**全是静默的**。桌面版共视那条路页面视口
 * 由 Electron 的 bounds÷zoom 决定，只要那两个数错开一个倍率，模型收到的就是
 * 「一张更宽的图（画面缩在一角）+ 一个按 1366 判界的 frame（右半边全成越界）」——
 * 两个症状一个根，而且两边都不报错。所以这里钉住：量到多少就说多少。
 */
describe('liveFrame：坐标空间按实测走', () => {
  const fakePage = (vp) => ({ evaluate: async () => (typeof vp === 'function' ? vp() : vp) });

  it('常规视口：跟标称一致，scale=1，不喊警报', async () => {
    const f = await liveFrame(fakePage({ w: _limits.VIEWPORT.width, h: _limits.VIEWPORT.height }));
    expect(f).toMatchObject({ w: _limits.VIEWPORT.width, h: _limits.VIEWPORT.height, scale: 1, measured: true, off: false });
  });

  it('视口被撑宽（共视对不上位）：frame 跟着变大，并标记 off', async () => {
    const f = await liveFrame(fakePage({ w: 2073, h: 1166 }));
    expect(f.off).toBe(true);
    expect(f.pageW).toBe(2073);
    // 2073×1166 = 2.4MP，仍在 3.75MP 内且长边 <2000？长边 2073 > 2000 → 要缩
    expect(f.scale).toBeCloseTo(2000 / 2073, 5);
    expect(f.w).toBe(Math.round(2073 * f.scale));
    // 坐标判界跟着实测走：按标称 1366 会把这一点判成越界
    expect(checkCoord([f.w - 1, f.h - 1], f)).toBeNull();
    expect(checkCoord([f.w - 1, f.h - 1], BROWSE_FRAME)).toMatch(/outside/);
  });

  it('量不到（页面正忙 / 刚导航）就退回标称，不抛', async () => {
    const f = await liveFrame({ evaluate: async () => { throw new Error('Execution context was destroyed'); } });
    expect(f).toMatchObject({ ...BROWSE_FRAME, measured: false });
  });

  it('量到 0 宽（视图 bounds 没设过）也退回标称 —— 别拿 0 当坐标空间', async () => {
    const f = await liveFrame(fakePage({ w: 0, h: 0 }));
    expect(f.measured).toBe(false);
    expect(f.w).toBe(_limits.VIEWPORT.width);
  });
});

/**
 * 出图与坐标空间必须是同一张图（2026-09-10 第二刀）。
 *
 * 现场：站主机器上视口 1366×767，抓回来的位图却是 **3384×1900** —— playwright 的
 * `scale:'css'` 拿 1/devicePixelRatio 当倍率，而共视里页面缩放 <1 时 dpr 也 <1，
 * 于是它不是"按 CSS 像素出图"而是放大出图；再被 2000 长边闸压成 2000×1123。
 * 那一版 frame 说坐标空间是 1366 —— 跟模型手里那张图差 1.46 倍，全在静默里。
 * 现在：比视口大就压回 1:1（往下缩是超采样，比原生渲还清楚），并且**按出图真实尺寸回填 frame**。
 */
describe('viewportShot：图和坐标空间是同一张', () => {
  it('⭐ 3384×1900 的位图 + 1366×767 的视口 → 压回 1366 宽，frame 跟着回到 1:1', async () => {
    const sharp = (await import('sharp')).default;
    const big = await sharp({ create: { width: 3384, height: 1900, channels: 3, background: '#888' } }).png().toBuffer();
    const page = {
      evaluate: async () => ({ w: 1366, h: 767 }),
      screenshot: async () => big,
    };
    const f = await liveFrame(page);
    expect(f.off, '±2px 容差内不该喊「不是常规视口」').toBe(false);
    const r = await viewportShot(page, 'proj_test_shot', '', f);

    const out = await sharp(Buffer.from(r.content[1].data, 'base64')).metadata();
    expect(out.width, '出图压回视口宽').toBe(1366);
    expect(f.w).toBe(out.width);              // frame 就是这张图
    expect(f.h).toBe(out.height);
    expect(f.scale).toBeCloseTo(1, 3);        // 截图像素 = CSS 像素，契约回到一句话
    expect(r.content[0].text).toContain('viewport 1366×767');
    expect(r.content[0].text).not.toContain('⚠');
  }, 20000);

  it('图本来就不大（托管那条路）：一个字不动', async () => {
    const sharp = (await import('sharp')).default;
    const same = await sharp({ create: { width: 1366, height: 768, channels: 3, background: '#fff' } }).png().toBuffer();
    const page = { evaluate: async () => ({ w: 1366, h: 768 }), screenshot: async () => same };
    const f = await liveFrame(page);
    const r = await viewportShot(page, 'proj_test_shot', '', f);
    const out = await sharp(Buffer.from(r.content[1].data, 'base64')).metadata();
    expect([out.width, out.height]).toEqual([1366, 768]);
    expect(f.scale).toBeCloseTo(1, 5);
  }, 20000);
});
