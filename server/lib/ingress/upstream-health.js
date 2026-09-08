/**
 * lib/ingress/upstream-health.js —— 每个上游一本环形账（2026-09-08）。
 *
 * 给输入框上方那排「模型贴纸」供数：每张贴纸一个状态色点（正常 / 降级 / 不可用 / 无数据）。
 *
 * ## 为什么不复用 upstream-fail-streak
 *
 * 那本账是**按会话**记的连续失败数，用途是止损（连挂 N 次就回 400 打断 CLI 的无上限重试），
 * 一次成功就清零。它回答的是"这个会话现在还能不能继续"，不是"这条上游最近好不好"。
 * 贴纸要的是后者：**跨会话、有历史、能算比例**。两本账目的不同，各记各的。
 *
 * ## ⛔ 半小时没请求 = 无数据，不许拿旧数据装绿
 *
 * 这是这本账最容易做错的地方。一条上游昨天全绿、今天一发没跑过，显示绿点是在撒谎 ——
 * 用户会据此挑一条其实已经死了的线。所以 `STALE_MS` 之外一律 `nodata`（灰点），
 * 界面上写「无数据」而不是留白，让"不知道"这件事本身是可见的。
 *
 * ## ⚠️ 这本账记的是**上游**，不是**厂商**
 *
 * merge 网关那条线上，`vendors` 的语义是「按顺序取第一个**可用的**」，**后备是静默的** ——
 * 同一个 upstreamId 这一发可能是 zai 服务的，下一发就换成 particle，我们这边看不出来。
 * 唯一能知道谁在服务的是响应头 `x-merge-vendor`（09-08 zai 在网关上没了那次的教训）。
 *
 * 所以：**别把这本账的读数当成"某家厂商的健康度"**。它的语义严格是"经这条上游发出去的请求
 * 最近成不成"。真要按厂商拆，得先在转发层把 `x-merge-vendor` 读出来记进条目里 —— 那是另一件事。
 *
 * ## 判据（都可以调，但别偷偷改口径）
 *
 *   nodata    最近一条比 STALE_MS 还老（或压根没有）
 *   down      最近 DOWN_RUN 条**连续**全败 —— 连挂就是挂了，不用等比例上来
 *   degraded  窗口内失败率 ≥ DEGRADED_RATE（且样本 ≥ MIN_SAMPLES）
 *   ok        其余
 *
 * ⭐ down 用「连续」不用「比例」：一条刚死的线，比例要好几发才爬得上来，而连续三发全败
 * 是**立刻**成立的。用户要的是"现在能不能用"，不是"今天的总体表现"。
 */

/** 每条上游留多少条 */
export const RING = 50;
/** 最近一条比这还老就报"无数据" */
export const STALE_MS = 30 * 60 * 1000;
/** 连续这么多条全败 = 不可用 */
export const DOWN_RUN = 3;
/** 窗口内失败率到这个比例算降级 */
export const DEGRADED_RATE = 0.34;
/** 少于这么多样本不下"降级"判断（一两发的失败可能只是网络抖） */
export const MIN_SAMPLES = 4;

/** @typedef {'ok'|'degraded'|'down'|'nodata'} HealthState */

export class UpstreamHealth {
  /** @param {{ now?: () => number }} [opts] */
  constructor({ now = () => Date.now() } = {}) {
    /** upstreamId → { at, ok, reason, status, ms }[]（新的在后面） */
    this.rings = new Map();
    this.now = now;
  }

  /**
   * 记一发的结果。
   * @param {string} upstreamId
   * @param {object} e
   * @param {boolean} e.ok
   * @param {string} [e.reason]  失败原因（成功时忽略）
   * @param {number|null} [e.status] HTTP 状态码
   * @param {number|null} [e.ms]   从收到请求到出结果的毫秒数。
   *   ⚠️ 这是**到结果**的耗时，不是严格的首字节 —— 流式那条路首字节更早。
   *   贴纸上只拿它做「快 / 慢」的粗判，别当 TTFB 用。
   */
  note(upstreamId, { ok, reason = '', status = null, ms = null } = {}) {
    if (!upstreamId) return;
    let ring = this.rings.get(upstreamId);
    if (!ring) { ring = []; this.rings.set(upstreamId, ring); }
    ring.push({
      at: this.now(),
      ok: !!ok,
      reason: ok ? '' : String(reason || '').slice(0, 120),
      status: status ?? null,
      ms: Number.isFinite(ms) ? Math.round(ms) : null,
    });
    if (ring.length > RING) ring.splice(0, ring.length - RING);
  }

  /**
   * 这条上游现在什么状态。
   * @returns {{ state: HealthState, samples: number, failRate: number|null,
   *             lastAt: number|null, lastReason: string, medianMs: number|null }}
   */
  stateOf(upstreamId) {
    const ring = this.rings.get(upstreamId) || [];
    const last = ring[ring.length - 1] || null;
    const blank = { state: /** @type {HealthState} */ ('nodata'), samples: 0, failRate: null, lastAt: null, lastReason: '', medianMs: null };
    if (!last) return blank;
    // ⛔ 陈旧一律作废：宁可说"不知道"，也不拿昨天的绿点骗人挑一条已经死了的线
    if (this.now() - last.at >= STALE_MS) return { ...blank, lastAt: last.at, lastReason: last.reason };

    const fresh = ring.filter((e) => this.now() - e.at < STALE_MS);
    const fails = fresh.filter((e) => !e.ok).length;
    const failRate = fresh.length ? fails / fresh.length : null;
    const times = fresh.map((e) => e.ms).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    const medianMs = times.length ? times[Math.floor(times.length / 2)] : null;

    // 连挂 DOWN_RUN 发就是挂了 —— 不等比例爬上来
    const tail = fresh.slice(-DOWN_RUN);
    const down = tail.length >= DOWN_RUN && tail.every((e) => !e.ok);

    const state = down ? 'down'
      : (fresh.length >= MIN_SAMPLES && failRate >= DEGRADED_RATE) ? 'degraded'
        : 'ok';
    return {
      state,
      samples: fresh.length,
      failRate,
      lastAt: last.at,
      lastReason: fresh.slice().reverse().find((e) => !e.ok)?.reason || '',
      medianMs,
    };
  }

  /** 调试/测试用：倒出某条上游的原始条目 */
  peek(upstreamId) { return (this.rings.get(upstreamId) || []).slice(); }

  /** 测试用：清空 */
  reset() { this.rings.clear(); }
}

/** 进程内单例（跟 failStreaks 同一个范式：ingress 是单进程收口） */
export const upstreamHealth = new UpstreamHealth();
