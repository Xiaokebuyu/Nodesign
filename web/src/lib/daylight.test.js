/**
 * 一天的光的契约（2026-08-30）。
 *
 * 跟 season.test.js 一样，钉的是**这一层不许做什么**，而不是复述它算了什么：
 * 一个装饰层最容易的坏法是有天有人「顺手」让它去动墨色、或者让太阳绕到左边。
 */
import { describe, it, expect } from 'vitest';
import {
  sunAt, lightAt, hourOf, nextMode, readMode, writeMode,
  DAY_MODES, SUN_HOURS, SUN_FROM, LAMP_AT,
} from './daylight.js';

const at = (h, m = 0, month = 9) => new Date(2026, month - 1, 15, h, m, 0);

describe('太阳的高度曲线', () => {
  it('正午最高、日出日落擦着地平线、深夜在地平线下', () => {
    const [rise, set] = SUN_HOURS.autumn;
    const noon = (rise + set) / 2;
    expect(sunAt(at(Math.floor(noon), 30), 'autumn').alt).toBeGreaterThan(0.98);
    expect(Math.abs(sunAt(at(Math.floor(rise), Math.round((rise % 1) * 60)), 'autumn').alt)).toBeLessThan(0.02);
    expect(sunAt(at(23, 0), 'autumn').alt).toBeLessThan(-0.5);
    expect(sunAt(at(3, 0), 'autumn').alt).toBeLessThan(-0.5);
  });

  it('⭐ 白天之外的每一分钟，太阳都在地平线下（逐分钟扫四季）', () => {
    // ⚠️ 第一版这条只抽查了几个钟点，**攻它攻不动** —— 把 sunAt 里的夹取删掉
    // 也照样绿。真正的风险不在今天这张表，在于哪天有人把某一季的白天改短：
    // u 会越过 2，sin(πu) 绕回正半周 = 半夜忽然天亮，而且不报错。
    // 所以判据改成扫全天全季，且钉的是「白天之外不许有正的太阳高度」这条不变量。
    for (const season of Object.keys(SUN_HOURS)) {
      const [rise, set] = SUN_HOURS[season];
      for (let m = 0; m < 24 * 60; m += 5) {
        const s = sunAt(at(Math.floor(m / 60), m % 60), season);
        const inDay = s.hour >= rise && s.hour <= set;
        if (!inDay) {
          expect(s.alt, `${season} ${s.hour.toFixed(2)} 点不该有太阳`).toBeLessThanOrEqual(0.001);
        }
        // 日出前 / 日落后一小时开外必须是全黑（中间那段是暮光，本来就该是小数）
        if (s.hour < rise - 1 || s.hour > set + 1) {
          expect(s.night, `${season} ${s.hour.toFixed(2)} 点该是全黑`).toBe(1);
        }
      }
    }
  });

  it('白天到夜是连续过渡，不是一刀切', () => {
    const seq = [16, 17, 18, 19].map((h) => sunAt(at(h), 'autumn').night);
    expect(seq[0]).toBe(0);
    expect(seq[3]).toBe(1);
    // 单调不减
    for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1]);
    expect(seq.some((v) => v > 0 && v < 1), '中间要有一档暮光').toBe(true);
  });

  it('夏天的白天比冬天长', () => {
    const day = (s) => SUN_HOURS[s][1] - SUN_HOURS[s][0];
    expect(day('summer')).toBeGreaterThan(day('winter'));
    // 同一个钟点，夏天还亮着，冬天已经黑了
    expect(sunAt(at(18, 30), 'summer').night).toBeLessThan(sunAt(at(18, 30), 'winter').night);
  });

  it('光在贴地平线的时候最暖，正午最白', () => {
    const [rise, set] = SUN_HOURS.autumn;
    expect(sunAt(at(Math.floor((rise + set) / 2), 30), 'autumn').warm).toBeLessThan(0.05);
    expect(sunAt(at(17, 30), 'autumn').warm).toBeGreaterThan(0.6);
  });
});

describe('⛔ 光向只有一边', () => {
  it('太阳和台灯都在右半边', () => {
    // 全站影子一律偏左下（PAPER_SHADOW），光源跑到左边就会跟满屏的纸打架。
    // 这一层表达时间靠的是**高度**（光斑的长短软硬），不是换边。
    expect(SUN_FROM[0]).toBeGreaterThan(0.5);
    expect(LAMP_AT[0]).toBeGreaterThan(0.5);
  });
  it('台灯比太阳低 —— 灯照的是纸，不是天花板', () => {
    expect(LAMP_AT[1]).toBeGreaterThan(SUN_FROM[1]);
  });
});

describe('手动挡', () => {
  it('白天挡在半夜也是白天，夜晚挡在正午也是夜', () => {
    expect(lightAt('day', at(3)).night).toBe(0);
    expect(lightAt('night', at(12)).night).toBe(1);
  });

  it('auto 就是真实时间', () => {
    const d = at(3);
    expect(lightAt('auto', d).night).toBe(sunAt(d).night);
  });

  it('⭐ 手动的白天和真实的正午是同一个东西', () => {
    // 手动挡是把时间挪到一个有代表性的钟点，不是另写一套常量 ——
    // 不然「白天」会看起来跟中午不一样，那就成了两套光。
    const manual = lightAt('day', at(3));
    const real = lightAt('auto', at(11, 30));
    expect(manual.alt).toBeCloseTo(real.alt, 6);
    expect(manual.warm).toBeCloseTo(real.warm, 6);
  });

  it('点一下换下一档，转一圈回到原处', () => {
    let m = 'auto';
    for (let i = 0; i < DAY_MODES.length; i++) m = nextMode(m);
    expect(m).toBe('auto');
    expect(nextMode('auto')).toBe('day');
  });
});

describe('存的模式坏了不许炸', () => {
  const fake = (v) => ({ getItem: () => v, setItem: () => {} });
  it('没存过 / 存了垃圾 / 读的时候抛异常，一律 auto', () => {
    expect(readMode(fake(null))).toBe('auto');
    expect(readMode(fake('日光浴'))).toBe('auto');
    expect(readMode({ getItem() { throw new Error('隐私模式'); } })).toBe('auto');
  });
  it('存不下也不炸（无痕窗口里 setItem 会抛）', () => {
    expect(() => writeMode('night', { setItem() { throw new Error('quota'); } })).not.toThrow();
  });
});

describe('⛔ 这一层只报「几点了」，不发颜色', () => {
  it('lightAt 的返回里没有任何色值', () => {
    // 夜晚模式在这套语言里是**把光收走**（光源层压一层暗），不是换一套深色 token。
    // 一旦这里开始返回颜色，就等于开了「白天一套色板、夜里另一套」那条路 ——
    // 而板上的字是铅笔、纸上的字是墨，那条路要重算两套对比度。见文件头。
    const v = lightAt('night', at(22));
    for (const [k, x] of Object.entries(v)) {
      expect(typeof x === 'string' && /^#|rgba?\(/.test(x), `${k} 看着像个色值`).toBe(false);
    }
    expect(Object.keys(v).sort()).toEqual(['alt', 'hour', 'mode', 'night', 'phase', 'season', 'warm']);
  });
});

describe('hourOf', () => {
  it('带上分和秒', () => {
    expect(hourOf(new Date(2026, 0, 1, 13, 30, 0))).toBeCloseTo(13.5, 6);
  });
});
