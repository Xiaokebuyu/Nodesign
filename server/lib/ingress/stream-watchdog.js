/**
 * server/lib/ingress/stream-watchdog.js —— 上游流断死看门狗（2026-08-29）
 *
 * 现场（proj_mtexu1kp 纸范式验收当晚）：glm-5.3-flash-zai 在开始流 tool_use 入参时
 * 断粮 —— 没有错误、没有 EOF、没有日志，TCP 就那么开着不再来字节。run 无限挂起，
 * 前端还留着一张流到一半的工具卡，直到用户手动中断。**用户不该替我们当看门狗。**
 *
 * 判据：SSE 的正常节奏是亚秒级 chunk（thinking 长停顿也有事件/ping 垫着），静默
 * 超过 IDLE_MS = 死流。掐掉（destroy）让下游走各自现成的错误路：
 *   - Anthropic 直连透传路：CLI 收到流错误 → 自己重试
 *   - openai-chat 转换路：proxyRes 'error' → attemptOver → 就地重发/判决机
 *
 * 只对流式响应上岗（非流式的整包响应可以长时间零字节，是合法的慢）。
 */

const DEFAULT_IDLE_MS = 180_000;
const CHECK_MS = 15_000;

export function idleMsFromEnv() {
  const n = Number(process.env.NODESIGN_INGRESS_IDLE_MS);
  return Number.isFinite(n) && n >= 1_000 ? n : DEFAULT_IDLE_MS;
}

/**
 * 给一条上游响应流装看门狗。返回解除函数（幂等）。
 * @param {import('http').IncomingMessage} stream  上游响应
 * @param {{ idleMs?: number, checkMs?: number, onIdle: (silentMs: number) => void }} opts
 *   onIdle 只会被调用一次；由调用方决定怎么掐（destroy）和记账（noteOutcome/日志）。
 */
export function armIdleWatchdog(stream, { idleMs = idleMsFromEnv(), checkMs = CHECK_MS, onIdle }) {
  let last = Date.now();
  let fired = false;
  const bump = () => { last = Date.now(); };
  stream.on('data', bump);
  const timer = setInterval(() => {
    if (fired) return;
    const silent = Date.now() - last;
    if (silent > idleMs) {
      fired = true;
      stop();
      try { onIdle(silent); } catch { /* 看门狗自己绝不抛 */ }
    }
  }, checkMs);
  timer.unref?.();
  function stop() {
    clearInterval(timer);
    stream.removeListener('data', bump);
  }
  stream.on('end', stop);
  stream.on('close', stop);
  stream.on('error', stop);
  return stop;
}
