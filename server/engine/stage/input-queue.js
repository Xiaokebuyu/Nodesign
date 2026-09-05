/**
 * engine/stage/input-queue.js —— 演出进程的输入队列。
 *
 * SDK 的 streamInput 模式要一个 AsyncIterable 当 prompt 源，会话就靠它跨多轮
 * 活着。服务端往这里 push 一条，就等于"有人对台上说了句话" —— 这是整条直连
 * 路的入口，也是它跟 SDK 子代理的分界：子代理宿主够不着，这个够得着。
 */
export class InputQueue {
  #items = [];
  #waiters = [];
  #closed = false;

  push(message) {
    if (this.#closed) throw new Error('queue closed');
    const w = this.#waiters.shift();
    if (w) w({ value: message, done: false });
    else this.#items.push(message);
  }

  close() {
    this.#closed = true;
    // 所有在等的一次放完，否则 for-await 会永远挂着
    while (this.#waiters.length) this.#waiters.shift()({ value: undefined, done: true });
  }

  get closed() { return this.#closed; }
  get depth() { return this.#items.length; }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.#items.length) return Promise.resolve({ value: this.#items.shift(), done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => this.#waiters.push(resolve));
      },
      return: () => { this.close(); return Promise.resolve({ value: undefined, done: true }); },
    };
  }
}
