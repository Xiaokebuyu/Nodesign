/**
 * EventBus — agent 事件总线（标准化事件 schema）
 *
 * 设计：
 *   - 极简 EventEmitter（基于 Set<listener>），不依赖 node:events 避免 max listener warn
 *   - 每条事件至少含 { type, runId, ts }
 *   - 监听器订阅时可选择全订（'*'）或按前缀（'run.delta'）或按 type 精确匹配
 *
 * 标准事件 schema（type）：
 *   run.start                  开始
 *   run.round.start            { round }
 *   run.round.end              { round, stopReason, usage? }
 *   run.delta.text             { round, text }
 *   run.delta.thinking         { round, text }
 *   run.delta.tool_use         { round, blockId, name, input }
 *   run.delta.tool_result      { round, blockId, name, ok, output?, error? }
 *   run.todo.updated           { todos }
 *   run.cancelled              { reason }
 *   run.done                   { finalText, artifactPath?, snapshot }
 *   run.error                  { message, code?, stack? }
 *
 * 外层把 EventBus 桥接到：
 *   - WebSocket：subscribe('*') → ws.send(JSON.stringify(evt))
 *   - 文件审计：subscribe('*') → append events.jsonl
 *   - 内存测试：buffer.push(evt) 然后断言
 */

export class EventBus {
  constructor() {
    /** @type {Set<{ pattern: string, fn: (evt: object) => void }>} */
    this._listeners = new Set();
  }

  /**
   * 订阅事件。
   * @param {string} pattern - '*' 全订 / 'run.delta' 前缀 / 'run.done' 精确
   * @param {(evt: object) => void} fn
   * @returns {() => void} 取消订阅
   */
  subscribe(pattern, fn) {
    if (typeof pattern !== 'string') throw new Error('EventBus.subscribe: pattern must be string');
    if (typeof fn !== 'function') throw new Error('EventBus.subscribe: fn must be function');
    const entry = { pattern, fn };
    this._listeners.add(entry);
    return () => this._listeners.delete(entry);
  }

  /**
   * 发布事件。listener 抛错会被吞 + 控制台 warn，不影响其他订阅者。
   */
  publish(event) {
    for (const { pattern, fn } of this._listeners) {
      if (matches(pattern, event.type)) {
        try {
          fn(event);
        } catch (err) {
          console.warn(`[EventBus] listener for "${pattern}" threw:`, err.message);
        }
      }
    }
  }

  /**
   * 同步 collect 所有事件到一个数组（测试用）。返回数组 + 取消函数。
   */
  collect(pattern = '*') {
    const buffer = [];
    const off = this.subscribe(pattern, (evt) => buffer.push(evt));
    return { buffer, stop: off };
  }
}

function matches(pattern, type) {
  if (pattern === '*') return true;
  if (pattern === type) return true;
  // 前缀匹配：'run.delta' 匹配 'run.delta.text'
  return type.startsWith(pattern + '.');
}

// ── 事件构造器（type-safe helpers，调用方少写字面量）──

export const Events = {
  start: () => ({ type: 'run.start' }),
  roundStart: (round) => ({ type: 'run.round.start', round }),
  roundEnd: (round, stopReason, usage) => ({ type: 'run.round.end', round, stopReason, usage }),
  deltaText: (round, text) => ({ type: 'run.delta.text', round, text }),
  deltaThinking: (round, text) => ({ type: 'run.delta.thinking', round, text }),
  deltaToolUse: (round, blockId, name, input) => ({ type: 'run.delta.tool_use', round, blockId, name, input }),
  deltaToolResult: (round, blockId, name, ok, output, error) => ({
    type: 'run.delta.tool_result', round, blockId, name, ok,
    ...(output !== undefined ? { output } : {}),
    ...(error ? { error } : {}),
  }),
  todoUpdated: (todos) => ({ type: 'run.todo.updated', todos }),
  cancelled: (reason) => ({ type: 'run.cancelled', reason }),
  done: (finalText, artifactPath, snapshot) => ({
    type: 'run.done', finalText, artifactPath, snapshot,
  }),
  error: (message, code, stack) => ({ type: 'run.error', message, code, stack }),
};
