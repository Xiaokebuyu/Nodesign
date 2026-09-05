/**
 * 一天的光的契约（2026-08-30）。
 *
 * 跟 season.test.js 一样，钉的是**这一层不许做什么**，而不是复述它算了什么：
 * 一个装饰层最容易的坏法是有天有人「顺手」让它去动墨色、或者让太阳绕到左边。
 */
import { describe, it, expect } from 'vitest';
import {
  sunAt, lightAt, hourOf, nextMode, readMode, writeMode, sunFrom, castAt,
  DAY_MODES, SUN_HOURS, SUN_ARC, SUN_FROM, LAMP_AT,
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

/**
 * 2026-09-01：太阳开始走了。
 *
 * 这一组替换掉从前那条「太阳和台灯都在右半边」—— 那条守的是「影子是烤死的，
 * 所以光不许换边」，而影子现在是这一层驱动的。守的东西换了，判据也得换：
 * 不再是「光在哪一边」，而是**光和影是不是同一个光源的两个后果**。
 */
describe('太阳一天里真的走过去', () => {
  const arcAt = (h, month) => {
    const l = lightAt('auto', at(h, 0, month));
    return { l, from: sunFrom(l), cast: castAt(l) };
  };

  it('从右边（东）升起，往左边（西）落下，中间不回头', () => {
    // ⭐ 屏幕上"东"在右边，因为这张桌子**朝北**（09-02 站主拍板）：
    //   坐北朝北，日出的东边就在你的右手边。这是个选择不是天文，理由写在
    //   daylight.js 的 sunFrom() 里。要改朝向就改那一行，然后改这里。
    //   ⚠️ 真正不能坏的是下面两条：**单调不回头**、**两头分处两个半边**。
    let prev = 2;
    for (let m = 7 * 60; m <= 17 * 60; m += 15) {
      const l = lightAt('auto', at(Math.floor(m / 60), m % 60));
      const x = sunFrom(l)[0];
      expect(x, `${(m / 60).toFixed(2)} 点太阳往回走了`).toBeLessThanOrEqual(prev + 1e-9);
      prev = x;
    }
    // 一天两头分别落在两个半边 —— 不越过中线就谈不上"走过去"
    expect(arcAt(7, 9).from[0]).toBeGreaterThan(0.5);
    expect(arcAt(17, 9).from[0]).toBeLessThan(0.5);
  });

  it('正午最高（屏上最靠顶），而且夏天的正午比冬天高', () => {
    expect(arcAt(12, 9).from[1]).toBeLessThan(arcAt(8, 9).from[1]);
    expect(arcAt(12, 6).from[1]).toBeLessThan(arcAt(12, 12).from[1]);
  });

  it('⭐ 冬天的太阳不往两边跑（横向摆幅比夏天小）', () => {
    // ⚠️ 取**绝对值**。第一版用带符号的跨度，09-02 桌子改朝北（太阳右→左）
    //   之后跨度全变成负数，判据当场作废 —— 而它要守的本来就是"摆得宽不宽"，
    //   跟朝哪边无关。这么写它对朝向免疫。
    const span = (mo) => Math.abs(arcAt(16, mo).from[0] - arcAt(9, mo).from[0]);
    expect(span(12)).toBeLessThan(span(6));
    expect(SUN_ARC.winter.swing).toBeLessThan(SUN_ARC.summer.swing);
  });
});

describe('⛔ 影子的契约', () => {
  it('⛔ 光永远在纸的上方：影子的 y 恒为正（逐分钟扫四季）', () => {
    // 这一条一破，纸就不是摊在桌上而是立起来了。它是这一层唯一还钉死的方向。
    // ⚠️ 扫一万多个点，但**只断言一次**：expect() 比这里的算术贵几个数量级，
    //   逐点断言会让这条测试在满负载的机器上跑到超时（真踩过：单跑 1s，
    //   全套并发时 23s，5s 就判超时 —— 一条会看天吃饭的判据比没有还糟）。
    let worst = { y: Infinity };
    for (const mo of [3, 6, 9, 12]) {
      for (let m = 0; m < 24 * 60; m += 3) {
        const c = castAt(lightAt('auto', at(Math.floor(m / 60), m % 60, mo)));
        if (c.y < worst.y) worst = { y: c.y, where: `${mo} 月 ${Math.floor(m / 60)}:${m % 60}` };
      }
    }
    expect(worst.y, `${worst.where} 影子朝上了`).toBeGreaterThan(0.3);
  });

  it('方向是单位向量 —— 长短只许 len 一个数管', () => {
    for (let h = 0; h < 24; h += 3) {
      const c = castAt(lightAt('auto', at(h)));
      expect(Math.hypot(c.x, c.y)).toBeCloseTo(1, 9);
    }
  });

  it('⭐ 影子背着太阳：太阳偏右影子就偏左，反过来也一样', () => {
    for (const h of [7, 9, 11, 13, 15, 17]) {
      const l = lightAt('auto', at(h));
      const sx = sunFrom(l)[0];
      const c = castAt(l);
      if (Math.abs(sx - 0.5) < 0.02) continue;          // 正上方，左右都不算错
      expect(Math.sign(c.x), `${h} 点影子跟太阳同一边`).toBe(-Math.sign(sx - 0.5));
    }
  });

  it('太阳越低，影子越长、越虚、越淡', () => {
    const noon = castAt(lightAt('auto', at(12)));
    const low = castAt(lightAt('auto', at(17)));
    expect(low.len).toBeGreaterThan(noon.len);
    expect(low.blur).toBeGreaterThan(noon.blur);
    expect(low.alpha).toBeLessThan(noon.alpha);
  });

  it('⭐⭐ 冬天正午的影子比夏天正午长（alt 分不出这件事，elev 才行）', () => {
    // 正弦那条曲线每一季的正午都是 1.0。要是拿 alt 去算影子长度，四季的正午
    // 会长得一模一样 —— 而冬天的太阳正午也低低地挂在南边，影子一整天都是长的。
    const noonLen = (mo) => castAt(lightAt('auto', at(12, 0, mo))).len;
    expect(noonLen(12)).toBeGreaterThan(noonLen(6) * 1.5);
    expect(noonLen(9)).toBeGreaterThan(noonLen(6));
  });

  it('⭐ 夜里影子归台灯：钟点不再影响它，方向偏左下，而且偏冷', () => {
    const a = castAt(lightAt('auto', at(22)));
    const b = castAt(lightAt('auto', at(2)));
    for (const k of ['x', 'y', 'len', 'blur', 'alpha', 'cool']) expect(a[k]).toBeCloseTo(b[k], 9);
    // 灯钉在右上角那个位置，所以影子朝左下
    expect(a.x).toBeLessThan(0);
    expect(a.cool).toBeGreaterThan(0.4);
    expect(castAt(lightAt('auto', at(12))).cool).toBe(0);
  });

  it('⛔ 一整天连续，跨黄昏也不许跳（逐分钟扫十二个月）', () => {
    // 真正的风险不在今天这张表，在于哪天有人给夜里那一档换个常量、或者让
    // sunFrom 在 u 越界时折返 —— 那些坏法都是**某一分钟影子忽然甩到另一边**，
    // 页面上看是一屏的纸同时抖一下，而且不报错。
    // ⚠️ 同上：一分钟一格扫十二个月，但只断言一次。
    let worst = { d: 0 };
    for (let mo = 1; mo <= 12; mo++) {
      let prev = null;
      for (let m = 0; m < 24 * 60; m += 1) {
        const c = castAt(lightAt('auto', at(Math.floor(m / 60), m % 60, mo)));
        if (prev) {
          for (const k of ['x', 'y', 'len', 'blur', 'alpha', 'cool']) {
            const d = Math.abs(c[k] - prev[k]);
            if (d > worst.d) worst = { d, where: `${mo} 月 ${Math.floor(m / 60)}:${m % 60} 的 ${k}` };
          }
        }
        prev = c;
      }
    }
    expect(worst.d, `${worst.where} 跳了`).toBeLessThan(0.05);
  });
});

describe('台灯', () => {
  it('比太阳的兜底位置低一点 —— 灯照的是纸，不是天花板', () => {
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
    expect(Object.keys(v).sort()).toEqual(
      ['alt', 'elev', 'gain', 'hour', 'mode', 'night', 'phase', 'season', 'u', 'warm'],
    );
  });
});

describe('hourOf', () => {
  it('带上分和秒', () => {
    expect(hourOf(new Date(2026, 0, 1, 13, 30, 0))).toBeCloseTo(13.5, 6);
  });
});
