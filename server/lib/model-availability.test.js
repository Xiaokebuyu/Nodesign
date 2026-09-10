/**
 * 钟点闸与总闸的判据（2026-09-10）。
 *
 * 为什么值得一组测试：这条闸的错法**全是静默的** —— 窗口写反了不会报错，只会让某一行
 * 一天里有几个钟头莫名其妙点不开；恢复时刻算错了也不会报错，只会在选择器里写一个假的时间。
 * 所以这里钉的是"关门的那一刻"和"开门的那一刻"两个边界，以及跨零点这种最容易写错的形状。
 */
import { describe, it, expect } from 'vitest';
import { parseWindow, validateUnavailableSpec, closureNow, availabilityOf } from './model-availability.js';
import { setModelEnabled } from './model-switches.js';

/** merge 那条 DeepSeek V4.1 Flash 的真实声明（跟 model-table.js 一字不差，抄这儿是为了边界看得见） */
const PEAK = { why: '上游高峰时段涨价', tz: 'UTC', windows: ['01:00-04:00', '06:00-10:00'] };
const utc = (h, m = 0) => new Date(Date.UTC(2026, 8, 10, h, m));

describe('parseWindow / 校验', () => {
  it('认 HH:MM-HH:MM，别的一律 null', () => {
    expect(parseWindow('01:00-04:00')).toEqual({ startMin: 60, endMin: 240 });
    expect(parseWindow('22:30-02:15')).toEqual({ startMin: 1350, endMin: 135 });
    expect(parseWindow('1:00-4:00')).toBeNull();      // 要补零
    expect(parseWindow('01:00')).toBeNull();
    expect(parseWindow('24:00-01:00')).toBeNull();
    expect(parseWindow('03:00-03:00')).toBeNull();    // 起止一样 = 写错了，不是"关一整天"
  });

  it('校验：好的没话说，坏的每条都有一句人话', () => {
    expect(validateUnavailableSpec(undefined)).toEqual([]);
    expect(validateUnavailableSpec(PEAK)).toEqual([]);
    expect(validateUnavailableSpec({ windows: [] })).toHaveLength(1);
    expect(validateUnavailableSpec({ windows: ['bad'] })[0]).toMatch(/HH:MM-HH:MM/);
    expect(validateUnavailableSpec({ tz: 'Mars/Olympus', windows: ['01:00-02:00'] })[0]).toMatch(/时区名/);
    expect(validateUnavailableSpec([])[0]).toMatch(/对象/);
  });
});

describe('closureNow：关门的那一刻与开门的那一刻', () => {
  it('两段高峰窗口，边界按「含头不含尾」', () => {
    expect(closureNow(PEAK, utc(0, 59))).toBeNull();
    expect(closureNow(PEAK, utc(1, 0))?.minutesLeft).toBe(180);     // 刚关门
    expect(closureNow(PEAK, utc(3, 59))?.minutesLeft).toBe(1);
    expect(closureNow(PEAK, utc(4, 0))).toBeNull();                 // 开门那一刻就是开的
    expect(closureNow(PEAK, utc(5, 30))).toBeNull();                // 两段之间
    expect(closureNow(PEAK, utc(9, 59))?.minutesLeft).toBe(1);
    expect(closureNow(PEAK, utc(10, 0))).toBeNull();
    expect(closureNow(PEAK, utc(13, 22))).toBeNull();
  });

  it('恢复时刻 = 窗口结束那一刻（秒被抹平，写给人看的）', () => {
    const c = closureNow(PEAK, utc(6, 45));
    expect(c.resumesAt.toISOString()).toBe('2026-09-10T10:00:00.000Z');
    expect(c.why).toBe('上游高峰时段涨价');
  });

  it('跨零点的窗口两边都算得对', () => {
    const night = { tz: 'UTC', windows: ['22:00-02:00'] };
    expect(closureNow(night, utc(23, 0))?.minutesLeft).toBe(180);
    expect(closureNow(night, utc(1, 0))?.minutesLeft).toBe(60);
    expect(closureNow(night, utc(2, 0))).toBeNull();
  });

  it('窗口按 tz 里的墙上时间算，不是服务器的钟', () => {
    const bj = { tz: 'Asia/Shanghai', windows: ['09:00-12:00'] };   // = UTC 01:00-04:00
    expect(closureNow(bj, utc(2, 0))).not.toBeNull();
    expect(closureNow(bj, utc(5, 0))).toBeNull();
  });

  it('时区名坏了不拖垮请求（校验那层去报错，这里当没关门）', () => {
    expect(closureNow({ tz: 'Nope/Nope', windows: ['01:00-04:00'] }, utc(2))).toBeNull();
  });
});

describe('availabilityOf：总闸 + 钟点闸', () => {
  it('钟点闸拦下时，话里写清楚什么时候回来、并且叫人换一行', () => {
    const row = { id: 'row-peak-test', unavailable: PEAK };
    const a = availabilityOf(row, utc(6, 45));
    expect(a.ok).toBe(false);
    expect(a.kind).toBe('closed');
    expect(a.resumesAt).toBe('2026-09-10T10:00:00.000Z');
    expect(a.reason).toMatch(/恢复/);
    expect(a.reason).toMatch(/换一个模型/);
    expect(a.reason).toMatch(/北京时间 18:00/);       // UTC 10:00 = 北京 18:00
    expect(availabilityOf(row, utc(13)).ok).toBe(true);
  });

  it('站主的总闸压过一切，理由是"停用"不是"关门"', () => {
    const row = { id: 'row-switch-test', unavailable: PEAK };
    expect(availabilityOf(row, utc(13)).ok).toBe(true);
    setModelEnabled(row.id, false, { updatedBy: 'admin-test' });
    const a = availabilityOf(row, utc(13));
    expect(a.ok).toBe(false);
    expect(a.kind).toBe('disabled');
    expect(a.resumesAt).toBeNull();
    setModelEnabled(row.id, true, { updatedBy: 'admin-test' });
    expect(availabilityOf(row, utc(13)).ok).toBe(true);
  });

  it('没记录 = 启用（内置表加新行不用来这儿补一条）', () => {
    expect(availabilityOf({ id: 'row-never-touched' }, utc(13)).ok).toBe(true);
  });
});
