/**
 * lib/ingress/anthropic-usage.js —— 从 Anthropic Messages 响应里**旁听**用量，不动响应本身。
 *
 * 透传腿（model-ingress 的 Anthropic 协议上游、relay 的订阅腿）以前是 pipe 过去什么都不看：
 * 站内会话的账由 SDK 的 modelUsage 差分算，入口不需要知道。relay 不一样：账本在服务器，
 * 客户端报什么都不算数，服务器只信自己从响应流里读出来的数。
 *
 * ## 口径
 *
 * 流式：`message_start` 带 input_tokens / cache_read_input_tokens / cache_creation_input_tokens
 * （和一个几乎恒为 1 的 output_tokens 占位）；`message_delta` 带**累计**的 output_tokens
 * （新版还会重复 input 三项）。同名字段后到的覆盖先到的 —— delta 里的数是最终数。
 * 非流式：响应体顶层 `usage`，字段名相同。
 *
 * 错误响应（4xx/5xx）没有 usage，onUsage 不触发 —— 没花钱就别记账。
 *
 * 只旁听 data 事件，pipe 由调用方自己接。这里绝不 pause / 改写流：
 * 看门狗（stream-watchdog）和下游 pipe 都挂在同一个 proxyRes 上，改写它就是给它们埋雷。
 */

const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];

/** 把 usage 对象里认识的数字字段合进 acc（后到覆盖先到） */
function absorb(acc, usage) {
  if (!usage || typeof usage !== 'object') return acc;
  for (const k of USAGE_KEYS) {
    const v = Number(usage[k]);
    if (Number.isFinite(v)) acc[k] = v;
  }
  acc._seen = true;
  return acc;
}

/** SSE 数据行 → 事件对象；不是 JSON 的行（注释、空行、[DONE]）返回 null */
function parseSseData(line) {
  if (!line.startsWith('data:')) return null;
  const raw = line.slice(5).trim();
  if (!raw || raw === '[DONE]') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * 纯函数：喂进一段段响应体，最后取用量。方便单测，也让流式和非流式共用一个累加器。
 *
 * @param {{ stream: boolean }} opts
 * @returns {{ feed(chunk: Buffer|string): void, finish(): object|null }}
 */
export function createAnthropicUsageScanner({ stream }) {
  const acc = {};
  let buf = '';
  const chunks = [];   // 非流式攒整个 body（上限之内）
  let bytes = 0;
  const NONSTREAM_MAX = 4 * 1024 * 1024;   // 非流式 body 超过这个就不解析了（响应体不该这么大，防被喂爆）

  function scanLine(line) {
    const ev = parseSseData(line);
    if (!ev) return;
    if (ev.type === 'message_start') absorb(acc, ev.message?.usage);
    else if (ev.type === 'message_delta') absorb(acc, ev.usage);
  }

  return {
    feed(chunk) {
      if (stream) {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          scanLine(buf.slice(0, nl).replace(/\r$/, ''));
          buf = buf.slice(nl + 1);
        }
      } else if (bytes <= NONSTREAM_MAX) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += b.length;
        if (bytes <= NONSTREAM_MAX) chunks.push(b);
      }
    },
    /** @returns {{ input, output, cacheRead, cacheCreate } | null} 归一后的 token 数；没见到 usage → null */
    finish() {
      if (stream) {
        if (buf) scanLine(buf.replace(/\r$/, ''));
      } else if (chunks.length && bytes <= NONSTREAM_MAX) {
        try { absorb(acc, JSON.parse(Buffer.concat(chunks).toString('utf8')).usage); } catch { /* 不是 JSON 就当没有 */ }
      }
      if (!acc._seen) return null;
      return {
        input: acc.input_tokens ?? 0,
        output: acc.output_tokens ?? 0,
        cacheRead: acc.cache_read_input_tokens ?? 0,
        cacheCreate: acc.cache_creation_input_tokens ?? 0,
      };
    },
  };
}

/**
 * 挂到一条上游响应上旁听。只对 2xx 上岗；结束（end 或 close）时回一次 onUsage。
 *
 * @param {import('node:http').IncomingMessage} proxyRes
 * @param {{ onUsage: (tokens: object) => void }} opts
 */
export function tapAnthropicUsage(proxyRes, { onUsage }) {
  if (!proxyRes || proxyRes.statusCode >= 300) return;
  const stream = String(proxyRes.headers?.['content-type'] || '').includes('event-stream');
  const scanner = createAnthropicUsageScanner({ stream });
  let done = false;
  const settle = () => {
    if (done) return;
    done = true;
    let tokens = null;
    try { tokens = scanner.finish(); } catch { tokens = null; }
    if (tokens) { try { onUsage(tokens); } catch (err) { console.error(`[anthropic-usage] onUsage 抛错: ${err?.message || err}`); } }
  };
  proxyRes.on('data', (c) => { try { scanner.feed(c); } catch { /* 旁听出错不影响透传 */ } });
  proxyRes.on('end', settle);
  // 被看门狗掐断的流没有 end 只有 close：能读到多少记多少（message_start 那份 input 通常已经到了）
  proxyRes.on('close', settle);
}
