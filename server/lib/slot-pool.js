/**
 * server/lib/slot-pool.js —— 带权重、按来源轮转的槽位池（2026-09-13）
 *
 * 用处：CLI 让标了 readOnlyHint 的工具在同一条消息里同时跑之后，「同时跑几个」要由资源决定，
 * 不能由模型一条消息里写了几个调用决定。两个用户：
 *   - 感知浏览器（mcp/tools/helpers/browser-slots.js）：进程级，一台机器同时开几只 chromium；
 *   - generate_image（generate-image-support.js）：会话级，一个会话同时出几张图。
 *
 * 语义：
 *   - acquire(weight=1, key) 返回 release 函数；release 幂等（调多次只还一次）。
 *   - 同一个 key（来源，比如项目）内先来先服务；不同 key 之间轮转：每次放行「最久没被放行过」的来源，
 *     从没放行过的最先，平手按排队先后。
 *     ⛔ 09-13 fable 审查 P1-2：进程级单槽位如果全局先来先服务，一个用户一条消息发 6 张截图，
 *     另一个用户的一张要等整批跑完。轮转后，另一个来源最多等「正在跑的那一个」。
 *   - 轮到的队头拿不到时整体等，不跳过去放后面的小请求：要独占的（weight=size）不会被饿死。
 *   - weight 大于 size 按 size 算（「独占」写 weight: Infinity 即可）。
 * 单事件循环内用，不是跨进程锁。
 */

/**
 * @param {number} size  槽位总数（≥1）
 */
export function makeSlotPool(size) {
  const cap = Math.max(1, Math.floor(Number(size) || 1));
  let used = 0;
  let waiting = 0;
  /** 来源 → 该来源的等待队列（Map 插入顺序 = 排队先后，平手时用） @type {Map<string, Array<{ weight: number, grant: (release: () => void) => void }>>} */
  const queues = new Map();
  /** 来源 → 上次放行的序号。队列空了也留着，免得刚跑完一批的来源回来又排到最前 */
  const lastGrant = new Map();
  let grants = 0;

  const releaser = (weight) => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      used -= weight;
      pump();
    };
  };

  function nextKey() {
    let best = null; let bestAt = Infinity;
    for (const key of queues.keys()) {
      const at = lastGrant.has(key) ? lastGrant.get(key) : -1;
      if (at < bestAt) { best = key; bestAt = at; }
    }
    return best;
  }

  function pump() {
    while (queues.size) {
      const key = nextKey();
      const queue = queues.get(key);
      if (used + queue[0].weight > cap) break;   // 轮到的拿不到就整体等，不跳过它（独占不被饿死）
      const { weight, grant } = queue.shift();
      if (!queue.length) queues.delete(key);
      lastGrant.set(key, ++grants);
      if (lastGrant.size > 1000) {   // 来源是项目 id，只增不减；太多时丢掉没在排队的
        for (const k of lastGrant.keys()) { if (!queues.has(k)) lastGrant.delete(k); if (lastGrant.size <= 500) break; }
      }
      used += weight;
      waiting -= 1;
      grant(releaser(weight));
    }
  }

  return {
    size: cap,
    get used() { return used; },
    get waiting() { return waiting; },
    /** @param {number} [weight] @param {string} [key] 来源；不给 = 同一个来源（纯先来先服务） @returns {Promise<() => void>} */
    acquire(weight = 1, key = '') {
      const w = Math.min(cap, Math.max(1, Math.floor(Number(weight) || 1)));
      const k = String(key ?? '');
      return new Promise((grant) => {
        const queue = queues.get(k);
        if (queue) queue.push({ weight: w, grant });
        else queues.set(k, [{ weight: w, grant }]);
        waiting += 1;
        pump();
      });
    },
    /** 拿槽位跑 fn，结束（含抛错）必还 */
    async run(fn, weight = 1, key = '') {
      const release = await this.acquire(weight, key);
      try { return await fn(); } finally { release(); }
    },
  };
}
