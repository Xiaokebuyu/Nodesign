/**
 * server/lib/slot-pool.js —— 带权重的先来先服务槽位池（2026-09-13）
 *
 * 用处：CLI 让标了 readOnlyHint 的工具在同一条消息里同时跑之后，「同时跑几个」要由资源决定，
 * 不能由模型一条消息里写了几个调用决定。两个用户：
 *   - 感知浏览器（mcp/tools/helpers/browser-slots.js）：进程级，一台机器同时开几只 chromium；
 *   - generate_image（generate-image-support.js）：会话级，一个会话同时出几张图。
 *
 * 语义：
 *   - acquire(weight=1) 返回 release 函数；release 幂等（调多次只还一次）。
 *   - 严格先来先服务：队头拿不到时后面的也不插队，要独占的（weight=size）不会被小请求饿死。
 *   - weight 大于 size 按 size 算（「独占」写 weight: Infinity 即可）。
 * 单事件循环内用，不是跨进程锁。
 */

/**
 * @param {number} size  槽位总数（≥1）
 */
export function makeSlotPool(size) {
  const cap = Math.max(1, Math.floor(Number(size) || 1));
  let used = 0;
  /** @type {Array<{ weight: number, grant: (release: () => void) => void }>} */
  const queue = [];

  const releaser = (weight) => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      used -= weight;
      pump();
    };
  };

  function pump() {
    while (queue.length && used + queue[0].weight <= cap) {
      const { weight, grant } = queue.shift();
      used += weight;
      grant(releaser(weight));
    }
  }

  return {
    size: cap,
    get used() { return used; },
    get waiting() { return queue.length; },
    /** @param {number} [weight] @returns {Promise<() => void>} */
    acquire(weight = 1) {
      const w = Math.min(cap, Math.max(1, Math.floor(Number(weight) || 1)));
      return new Promise((grant) => { queue.push({ weight: w, grant }); pump(); });
    },
    /** 拿槽位跑 fn，结束（含抛错）必还 */
    async run(fn, weight = 1) {
      const release = await this.acquire(weight);
      try { return await fn(); } finally { release(); }
    },
  };
}
