/**
 * server/lib/async-queue.js — push/pull 解耦的异步队列
 *
 * 用途：SDK Query streamInput 模式下，runAgent 需要一个 AsyncIterable<SDKUserMessage>
 * 持续 yield user message 让 query 一直活着；前端 POST /turn 把 message push 进
 * 队列，generator 那头 pull 后 yield 给 SDK。
 *
 * 行为：
 *   - push(item) 立即返回；waiter 等着就唤醒一个，否则进 items 数组
 *   - next() 返回 Promise；items 有就立刻 resolve，否则 Promise 挂着等 push / close
 *   - close() 终结流；所有 pending waiter 收到 { done: true }；后续 push 抛错
 *   - return() 自动调 close（让 for-await-of 的 break 能正确收尾）
 *
 * 不是通用线程安全 queue —— 单事件循环内用，order 保证 FIFO。
 *
 * @template T
 */
export class AsyncQueue {
  constructor() {
    /** @type {T[]} */
    this.items = [];
    /** @type {Array<(r: IteratorResult<T>) => void>} */
    this.waiters = [];
    this.closed = false;
  }

  /**
   * 当前积压 item 数量（已 push 未 pull 的）。
   * 给 UI "已排队 N 条" 显示用。
   */
  get size() {
    return this.items.length;
  }

  /**
   * 是否还有 active waiter 在等（agent 已 pull 完积压，正等下一条）。
   * 给"agent idle"判定用。
   */
  get isPending() {
    return this.waiters.length > 0;
  }

  /**
   * 推一个 item 进队列。
   * @param {T} item
   * @throws {Error} 已 close 时抛
   */
  push(item) {
    if (this.closed) {
      throw new Error('AsyncQueue: push after close');
    }
    if (this.waiters.length > 0) {
      const w = this.waiters.shift();
      w({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  /**
   * 终结流。pending waiter 全部收到 done，items 里残留的 item 仍可 pull
   * 直到清空，再之后 next() 返回 done。
   *
   * 幂等：多次调用 noop。
   */
  close() {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      w({ value: undefined, done: true });
    }
  }

  // ── AsyncIterator protocol ──

  [Symbol.asyncIterator]() {
    return this;
  }

  /**
   * @returns {Promise<IteratorResult<T>>}
   */
  next() {
    if (this.items.length > 0) {
      return Promise.resolve({ value: this.items.shift(), done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /**
   * for-await-of 提前 break / throw 时被 runtime 调；触发 close。
   * @returns {Promise<IteratorResult<T>>}
   */
  return() {
    this.close();
    return Promise.resolve({ value: undefined, done: true });
  }
}
