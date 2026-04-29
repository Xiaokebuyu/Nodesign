/**
 * 两层并发控制
 *
 * 来源：从 dev/server/bot/concurrency.js 复制改造（语义从飞书消息泛化为 run/任务）
 *
 * 第一层：per-key mutex（async-mutex-lite）
 *   同一 key（用户 id / run id / IP）的请求严格串行，不同 key 并行
 *
 * 第二层：全局信号量
 *   限制同时进行的 LLM 调用总数，防止 Kimi API 过载（也兼顾本机 playwright 资源）
 *
 * 背压：per-key 队列超 N 条时拒绝排队，返回 backpressure 状态
 *
 * Nodesign 用法：
 *   - HTTP 入口：以请求 IP 或登录 user id 作为 key
 *   - 内部小合调用：以 user open_id 作为 key（同源仍要串行）
 *   - 长任务（engine run）：以 run_id 作为 key（避免同一任务并发推进）
 *
 * 注意：MAX_CONCURRENT_LLM 默认 5 是为飞书私聊设计的。SaaS 上线前请基于
 *   Kimi 配额 + 单机 playwright 实例数 重新算。
 */

import { mutex } from 'async-mutex-lite';

// ── 全局信号量 ──

const MAX_CONCURRENT = Number(process.env.ENGINE_MAX_CONCURRENT_LLM) || 5;
let running = 0;
const waitQueue = [];

function acquireSemaphore() {
  if (running < MAX_CONCURRENT) {
    running++;
    return Promise.resolve();
  }
  return new Promise(resolve => waitQueue.push(resolve));
}

function releaseSemaphore() {
  if (waitQueue.length > 0) {
    waitQueue.shift()();
  } else {
    running--;
  }
}

// ── 背压跟踪 ──

const queueDepth = new Map();
const MAX_QUEUE_DEPTH = Number(process.env.ENGINE_MAX_QUEUE_DEPTH) || 3;

/**
 * 将任务排入 per-key 队列
 *
 * @param {string} key - 隔离 key（user id / run id / IP）
 * @param {() => Promise<any>} task - 任务函数
 * @returns {Promise<{ status: 'ok' | 'backpressure', result?: any }>}
 */
export async function enqueueTask(key, task) {
  const depth = (queueDepth.get(key) || 0) + 1;

  // 背压：队列已满，拒绝排队
  if (depth > MAX_QUEUE_DEPTH) {
    console.log(`[Concurrency] 背压: key=${String(key).slice(0, 12)}... depth=${depth} > max=${MAX_QUEUE_DEPTH}`);
    return { status: 'backpressure' };
  }

  queueDepth.set(key, depth);

  try {
    const result = await mutex(key, async () => {
      console.log(`[Concurrency] 开始处理: key=${String(key).slice(0, 12)}... (running=${running}/${MAX_CONCURRENT})`);

      await acquireSemaphore();
      try {
        return await task();
      } finally {
        releaseSemaphore();
      }
    });

    return { status: 'ok', result };
  } finally {
    const current = queueDepth.get(key) || 1;
    if (current <= 1) {
      queueDepth.delete(key);
    } else {
      queueDepth.set(key, current - 1);
    }
  }
}

/** 给健康检查/管理面板用：返回当前并发指标 */
export function getConcurrencyMetrics() {
  return {
    running,
    maxConcurrent: MAX_CONCURRENT,
    waitingForSemaphore: waitQueue.length,
    perKeyQueueDepth: Object.fromEntries(
      [...queueDepth.entries()].map(([k, d]) => [String(k).slice(0, 12) + '...', d])
    ),
    maxQueueDepth: MAX_QUEUE_DEPTH,
  };
}
