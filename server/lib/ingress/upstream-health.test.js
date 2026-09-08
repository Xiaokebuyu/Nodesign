/**
 * upstream-health.test.js —— 环形账的判据。
 *
 * ⭐ 最要紧的一条是「半小时没请求要说无数据」：那是这本账**唯一会主动骗人**的地方 ——
 * 全绿的历史 + 一发没跑 = 界面显示绿点 = 用户据此挑了一条其实已经死了的线。
 * 所以那条单独测，而且测的是"过期之后**不再**是 ok"，不是"过期之后是 nodata"（后者
 * 光看返回值对了也可能是别的原因蒙对的）。
 */
import { describe, it, expect } from 'vitest';
import { UpstreamHealth, STALE_MS, DOWN_RUN, MIN_SAMPLES } from './upstream-health.js';

/** 可控时钟：所有跟"多久以前"有关的判据都得能拨表，不然只能靠真等 */
function at(t0) {
  let now = t0;
  const h = new UpstreamHealth({ now: () => now });
  return { h, tick: (ms) => { now += ms; }, at: () => now };
}

describe('UpstreamHealth', () => {
  it('没记过 → 无数据（不是"正常"）', () => {
    const { h } = at(0);
    const s = h.stateOf('merge');
    expect(s.state).toBe('nodata');
    expect(s.samples).toBe(0);
  });

  it('一路成功 → 正常', () => {
    const { h, tick } = at(0);
    for (let i = 0; i < 10; i++) { h.note('merge', { ok: true, ms: 800 }); tick(1000); }
    const s = h.stateOf('merge');
    expect(s.state).toBe('ok');
    expect(s.failRate).toBe(0);
    expect(s.medianMs).toBe(800);
  });

  it(`⭐ 连挂 ${DOWN_RUN} 发就是不可用 —— 不等失败率爬上来`, () => {
    const { h, tick } = at(0);
    // 先垫一堆成功，让**比例**远低于降级线：如果判据是比例，这里不会判 down
    for (let i = 0; i < 30; i++) { h.note('merge', { ok: true, ms: 500 }); tick(100); }
    for (let i = 0; i < DOWN_RUN; i++) { h.note('merge', { ok: false, reason: '503', status: 503, ms: 200 }); tick(100); }
    const s = h.stateOf('merge');
    expect(s.state, `失败率才 ${s.failRate?.toFixed(2)}，靠比例判不出来，必须靠"连续"`).toBe('down');
    expect(s.lastReason).toBe('503');
  });

  it('挂几发又好了 → 回到正常（连挂被打断就不算 down）', () => {
    const { h, tick } = at(0);
    for (let i = 0; i < 20; i++) { h.note('merge', { ok: true, ms: 500 }); tick(100); }
    h.note('merge', { ok: false, reason: '503', ms: 200 }); tick(100);
    h.note('merge', { ok: false, reason: '503', ms: 200 }); tick(100);
    h.note('merge', { ok: true, ms: 500 });
    expect(h.stateOf('merge').state).not.toBe('down');
  });

  it('失败率过线 → 降级', () => {
    const { h, tick } = at(0);
    // 交替成败：比例 50% 过线，但从不连挂 DOWN_RUN 发
    for (let i = 0; i < 12; i++) {
      h.note('merge', { ok: i % 2 === 0, reason: i % 2 ? 'timeout' : '', ms: 900 });
      tick(100);
    }
    const s = h.stateOf('merge');
    expect(s.state).toBe('degraded');
    expect(s.failRate).toBeGreaterThanOrEqual(0.34);
  });

  it(`样本少于 ${MIN_SAMPLES} 不下降级判断（一两发失败可能只是网络抖）`, () => {
    const { h, tick } = at(0);
    h.note('merge', { ok: true, ms: 500 }); tick(100);
    h.note('merge', { ok: false, reason: 'x', ms: 500 });
    expect(h.stateOf('merge').state).toBe('ok');
  });

  it('⛔⛔ 超过陈旧窗口 → 必须不再是 ok（不许拿旧数据装绿）', () => {
    const { h, tick } = at(1_000_000);
    for (let i = 0; i < 20; i++) { h.note('merge', { ok: true, ms: 500 }); tick(100); }
    expect(h.stateOf('merge').state, '刚跑完当然是 ok').toBe('ok');

    tick(STALE_MS + 1);
    const s = h.stateOf('merge');
    // 判据写成"不再是 ok"而不是"等于 nodata"：前者才是真正要防的事
    expect(s.state, '半小时没请求还报 ok，就是拿昨天的绿点骗人挑一条可能已经死了的线').not.toBe('ok');
    expect(s.state).toBe('nodata');
    expect(s.samples, '过期之后不该再拿旧样本算比例').toBe(0);
    expect(s.failRate).toBe(null);
  });

  it('陈旧之后又来了新的一发 → 立刻按新的算', () => {
    const { h, tick } = at(0);
    h.note('merge', { ok: false, reason: 'old', ms: 100 });
    tick(STALE_MS + 1);
    expect(h.stateOf('merge').state).toBe('nodata');
    h.note('merge', { ok: true, ms: 300 });
    expect(h.stateOf('merge').state).toBe('ok');
  });

  it('环形账只留最近 50 条', () => {
    const { h } = at(0);
    for (let i = 0; i < 80; i++) h.note('merge', { ok: true, ms: 1 });
    expect(h.peek('merge').length).toBe(50);
  });

  it('各条上游各记各的，互不串账', () => {
    const { h, tick } = at(0);
    for (let i = 0; i < DOWN_RUN; i++) { h.note('a', { ok: false, reason: 'x', ms: 1 }); tick(10); }
    for (let i = 0; i < 10; i++) { h.note('b', { ok: true, ms: 1 }); tick(10); }
    expect(h.stateOf('a').state).toBe('down');
    expect(h.stateOf('b').state).toBe('ok');
  });
});
