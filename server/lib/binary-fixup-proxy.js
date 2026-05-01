/**
 * server/lib/binary-fixup-proxy.js — Claude Agent SDK binary 出口 fixup proxy
 *
 * # 它解决什么问题
 *
 * SDK binary（Anthropic 官方编译的 Claude Code）对**不在白名单的 model id**
 * 走 fallback 到 `thinking: { type: 'adaptive' }`，即使我们传 enabled 也被
 * 强转。Kimi K2.6 不在 binary 白名单里，每次请求都被转 adaptive；但 Kimi
 * gateway 不支持 adaptive type → 0 thinking blocks。
 *
 * 详细诊断证据见 memory `feedback_kimi_thinking_blocks.md`：6 个 SDK option
 * variants + 5 个 model id 对照 + 5 类 env 路径全部试过，确认 LLM gateway
 * 模式下 binary 没暴露任何 capability override 给我们。
 *
 * # 这个 proxy 怎么修
 *
 * NoDesign server 进程内启一个 mini HTTP proxy on 127.0.0.1:动态端口。
 * SDK options.env.ANTHROPIC_BASE_URL 指向 proxy 而不是真实 gateway。
 *
 *   binary → POST proxy → proxy 拦截 body → 改写 thinking → 转发到真 gateway
 *
 * 改写规则（保守，最小副作用）：
 *   仅当 model 匹配 /^kimi/i AND thinking.type === 'adaptive' 时
 *   把 thinking 改成 { type: 'enabled', budget_tokens: 8192 }
 *   其他请求一律原样透传（包括 binary 内部 helper agent 的 claude-haiku
 *   请求 — 这些请求不走 thinking 字段，gateway 反正会拒，跟改前一致）
 *
 * # 为什么不写在 SDK options 层
 *
 * 试过 6 个 SDK option variants 都不行，binary 内部强转 adaptive 是写死的
 * 行为，跟 SDK options 无关。HTTP 层是 binary 唯一对外可见的接口。
 *
 * # 副作用 + 回滚
 *
 * - 增加 1 跳本地 loopback 转发延迟（毫秒级，对 LLM 请求几乎不可见）
 * - 仅匹配 kimi-* model + adaptive thinking 才改，其他请求 0 影响
 * - 未来 Anthropic 修了 fallback / 提供 capability override：删掉这个文件
 *   + 改 loop.js 的 ANTHROPIC_BASE_URL 用回真 gateway 即可
 *
 * # 流式响应
 *
 * Kimi gateway 的 SSE 流式响应通过 res.pipe 直接透传，proxy 不解析也不
 * 改写流式 chunk —— 我们改的是 outgoing request body，incoming response
 * 完全透传。
 */

import http from 'node:http';
import https from 'node:https';

let _instance = null;

/**
 * 启动 fixup proxy（幂等：第一次调启动，后续复用同一个 instance）。
 *
 * @param {string} realUrl  真实 gateway URL（如 https://tokendance.space/gateway）
 * @returns {Promise<{ baseUrl: string, close: () => Promise<void> }>}
 */
export async function getOrStartProxy(realUrl) {
  if (_instance) return _instance;
  if (!realUrl) throw new Error('binary-fixup-proxy: realUrl required');

  const target = new URL(realUrl);
  const useHttps = target.protocol === 'https:';
  const targetPort = target.port || (useHttps ? 443 : 80);
  const reqLib = useHttps ? https : http;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);

      // 仅对 POST /v1/messages 做 fixup（其他 endpoint 直接透传）
      if (req.method === 'POST' && /\/v1\/messages\b/.test(req.url)) {
        body = maybeFixupMessagesBody(body);
      }

      // 转发请求体到真实 gateway
      const headers = { ...req.headers, host: target.hostname };
      headers['content-length'] = String(body.length);
      // host 必须重设 — incoming host 是 localhost:port，target 不接

      const proxyReq = reqLib.request({
        hostname: target.hostname,
        port: targetPort,
        path: joinPath(target.pathname, req.url),
        method: req.method,
        headers,
      }, (proxyRes) => {
        // 透传 status + headers + body（流式）
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
        console.error(`[binary-fixup-proxy] forward error: ${err.message}`);
        try { res.writeHead(502); res.end(`proxy forward error: ${err.message}`); } catch { /* ignore */ }
      });

      proxyReq.write(body);
      proxyReq.end();
    });

    req.on('error', (err) => {
      console.error(`[binary-fixup-proxy] request error: ${err.message}`);
      try { res.writeHead(400); res.end(); } catch { /* ignore */ }
    });
  });

  // 端口 0 = 系统分配空闲端口，避免冲突；只 bind localhost 不暴露外部
  await new Promise((resolve, reject) => {
    const onError = (err) => { server.removeListener('listening', onListening); reject(err); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`[binary-fixup-proxy] listening on ${baseUrl} → ${realUrl}`);

  _instance = {
    baseUrl,
    close: () => new Promise((r) => server.close(() => r())),
    server,
  };

  return _instance;
}

/**
 * Body fixup：只在 model=kimi-* 且 thinking.type='adaptive' 时改 thinking。
 * 其他情况原样返回（不解析 / 不改）。fail-soft：parse 异常一律透传。
 */
function maybeFixupMessagesBody(body) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return body;  // 非 JSON：透传
  }

  if (!parsed || typeof parsed !== 'object') return body;
  if (!parsed.model || typeof parsed.model !== 'string') return body;
  if (!/^kimi/i.test(parsed.model)) return body;  // 只动 kimi-*
  if (!parsed.thinking || parsed.thinking.type !== 'adaptive') return body;

  // 改写：adaptive → enabled + budget_tokens 8192
  parsed.thinking = { type: 'enabled', budget_tokens: 8192 };
  return Buffer.from(JSON.stringify(parsed), 'utf8');
}

/**
 * URL path 拼接：target base path + incoming req path（避免重复 / 或丢段）。
 *
 * 例如：target.pathname='/gateway'，req.url='/v1/messages?beta=true'
 *    → '/gateway/v1/messages?beta=true'
 */
function joinPath(base, reqPath) {
  const cleanBase = (base || '').replace(/\/$/, '');
  const cleanReqPath = reqPath.startsWith('/') ? reqPath : '/' + reqPath;
  return cleanBase + cleanReqPath;
}

/**
 * 进程退出时 close proxy（防 socket 泄漏）。
 *
 * @returns {Promise<void>}
 */
export async function stopProxy() {
  if (!_instance) return;
  await _instance.close();
  _instance = null;
}
