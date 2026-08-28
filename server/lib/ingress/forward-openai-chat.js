/**
 * lib/ingress/forward-openai-chat.js — openai-chat 协议上游的转发体（08-21）。
 * 从 model-ingress.js 拆出来（行数棘轮）：转换在 ./openai-chat.js，这里只管 HTTP 往返。
 * 调用方给 target/path/agent（出站连接池与 joinPath 住 model-ingress，不反向依赖）。
 *
 * ## 就地重发（08-21 夜，跟 OpenCode 对齐）
 *
 * Zen 常常"只想了没说就把流断了"（无 finish_reason、零可见输出；08-21 生产 8 次）。以前我们
 * 发 error 事件让 CLI 重试 —— 但 CLI 对流内 error 只试 4 次，用户看到的就是一句失败文案。
 * OpenCode 的做法是：这种收尾归成 `unknown`，**它自己的回合循环直接再打一次模型**，对用户隐形
 * （见 prompt.ts 的 `!["tool-calls","unknown"].includes(finish)`）。我们隔着 CLI 学不了它的循环，
 * 但可以在**同一条 SSE 里**重发：客户端只看到一条消息，块号接着往下排。
 *
 * 只有「零可见输出 + 收尾原因不可信」才重发（转换层 verdict() 的 'empty'）：
 *   - 说了一半被掐 → 不重发，走 session-loop 的续接（正文已经流给用户了，重发会重复）
 *   - 已知 finish（stop/length）+ 零可见 → 不重发，上游明说它收完了（OpenCode 同样不重试）
 * 额度：NODESIGN_INGRESS_EMPTY_RETRIES（默认 2）+ 墙钟预算 NODESIGN_INGRESS_RETRY_BUDGET_MS
 * （默认 120s，超了就不再开新的一发 —— Zen 一发能挂 185 秒，不设预算会把回合拖过 CLI 自己的
 * 300 秒流空闲超时）。等待期间发 `event: ping` 保活（Anthropic 官方流也发 ping，SDK 会忽略）。
 */
import http from 'node:http';
import https from 'node:https';
import { toOpenAIChatRequest, fromOpenAIChatResponse, toAnthropicError, OpenAIToAnthropicSSE, truncationOfChatResponse } from './openai-chat.js';
import { upstreamCostOf } from './upstream-billing.js';

export const DEFAULT_EMPTY_RETRIES = 2;
export const DEFAULT_RETRY_BUDGET_MS = 120_000;
export const RETRY_DELAY_MS = 1_000;
const PING_INTERVAL_MS = 15_000;

/** 零可见输出时最多再打几发（0 = 关掉就地重发） */
export function emptyRetryLimit(env = process.env) {
  const v = Number(env.NODESIGN_INGRESS_EMPTY_RETRIES);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_EMPTY_RETRIES;
}
/** 墙钟预算：已经花掉这么久就不再开新的一发 */
export function retryBudgetMs(env = process.env) {
  const v = Number(env.NODESIGN_INGRESS_RETRY_BUDGET_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_RETRY_BUDGET_MS;
}

/**
 * OpenAI chat 上游：请求体转换 → POST <base>/chat/completions → 响应转回 Anthropic
 * （流式走 OpenAIToAnthropicSSE，非流式整包转，错误体转 Anthropic error 形状）。
 * ⚠️ 不转发 binary 带来的任何请求头（anthropic-version/beta 头对它无意义，UA 要自己给：
 * Cloudflare 对某些默认 UA 回 1010）。
 *
 * 回调：
 *   onOutcome(ok, reason)  每个**客户端请求**报一次最终结果（不是每一发上游）→ 会话连续失败计数
 *   onBilling({costUsd,usage})  上游自报的费用/用量（含重发那几发，账要算它们）
 *   onTruncated(reason|null)  这次往返是不是「说到一半被掐」→ session-loop 续接
 *   onNotice(text)  想让用户看见的一句话（就地重发时说一声，别让人对着不动的绿点干等）
 */
export function forwardOpenAIChat({ parsed, wire, key, res, sidShort, target, path, agent, onOutcome = () => {}, onBilling = () => {}, onTruncated = () => {}, onNotice = () => {} }) {
  const wantStream = !!parsed.stream;
  const label = wire.upstream?.label || wire.upstreamId;
  const body = toOpenAIChatRequest(parsed, { reasoningEffort: wire.reasoningEffort, maxOutput: wire.maxOutput, bodyExtra: wire.bodyExtra });
  const outBody = Buffer.from(JSON.stringify(body), 'utf8');
  const useHttps = target.protocol === 'https:';
  const headers = {
    host: target.hostname,
    'content-type': 'application/json',
    'content-length': String(outBody.length),
    accept: wantStream ? 'text/event-stream' : 'application/json',
    'user-agent': 'NoDesign-ingress/1 (+https://nodesign.xiaobuyu.trade)',
    authorization: `Bearer ${key}`,
  };
  const t0 = Date.now();

  /**
   * 发一发上游。onError 由调用方给 —— ⛔ **这里绝不碰 res**：
   * 流式那边 res 的收尾权只有一个主人（attemptOver → finish/failHard），
   * 谁顺手 `res.end()` 一下，正在等重发的那条流就死在半空（08-21 夜评审 P0 就是这么来的：
   * 上游 RST 时 req 的 'error' 先到、把流封了，1 秒后重发的输出全丢，客户端拿到一条没有
   * message_stop 也没有 error 的死流，回合永不收场，上游还被打满额度）。
   */
  const request = (onResponse, onError) => {
    const req = (useHttps ? https : http).request({
      hostname: target.hostname,
      port: target.port || (useHttps ? 443 : 80),
      path,
      method: 'POST',
      headers,
      agent,
    }, onResponse);
    req.on('error', (err) => {
      const detail = err.code ? `${err.code}: ${err.message}` : err.message;
      console.error(`[model-ingress] forward error (${wire.upstreamId}): ${detail}`);
      onError(detail);
    });
    req.write(outBody);
    req.end();
    return req;
  };

  // ── 流式：一条 SSE，可能跨多发上游 ──
  if (wantStream) {
    const xf = new OpenAIToAnthropicSSE({ model: parsed.model, label });
    // 每一发 pipe 进来都会在 xf 上挂一组监听器（drain/error/close/finish/unpipe）。放宽重发次数后
    // 会顶到 Node 默认的 10 个上限刷 MaxListeners 告警 —— 收尾时 unpipe（见 attemptOver）是正解，
    // 这条只是保险，别让告警刷屏盖住真问题。
    xf.setMaxListeners(64);
    let pingTimer = null;
    let streaming = false;     // 已经 writeHead(200) 并把 xf 接到 res 上了吗
    let dead = false;          // 客户端走了（点了停止 / 关了页面）：立刻停手，别再打上游
    let currentReq = null;     // 在飞的那一发，客户端一走就掐掉
    let retryTimer = null;
    let outcomeReported = false;
    // 一个客户端请求只报一次结果 —— 会话连续失败计数按"请求"算，报重了止损会提前触发
    const report = (ok, reason) => { if (outcomeReported) return; outcomeReported = true; onOutcome(ok, reason); };

    const stopPing = () => { if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } };
    const startPing = () => {
      stopPing();
      pingTimer = setInterval(() => {
        // 只在"两发之间"发：此刻没有块在流，不会跟转换层的输出交错
        if (dead || res.writableEnded) { stopPing(); return; }
        try { res.write('event: ping\ndata: {"type":"ping"}\n\n'); } catch { stopPing(); }
      }, PING_INTERVAL_MS);
      pingTimer.unref?.();
    };

    // ⛔ 客户端断开（用户点停止 / 关页面）后，重发链会**继续打上游**：烧 token、没人收、
    //   而且 xf 的 'end' 永远不来（pipe 被 unpipe 了）→ onOutcome/onBilling 一次都不触发，
    //   这几发的账和失败计数全部消失（08-21 夜评审 P1）。
    res.on('close', () => {
      // ⚠️ 判据是 writableEnded 而不是 xf.done：**我们自己**回的 HTTP 错误体（第一发就 503）
      // 也会触发 close，那时 xf 根本没用过。用 xf.done 当判据会把它误判成"客户端断开"，
      // 于是同一个请求报两次失败 → 止损计数翻倍 → 用户第 2 个 503 就吃 400（探针实测）。
      if (res.writableEnded) return;
      dead = true;
      stopPing();
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      try { currentReq?.destroy(); } catch { /* */ }
      console.warn(`[model-ingress] sid=${sidShort} upstream=${wire.upstreamId} 客户端断开，停止重发（已打 ${xf.attempts} 发）`);
      report(false, 'client disconnected');
      if (xf.usageTotal || xf.cost != null) onBilling({ costUsd: xf.cost, usage: xf.usageTotal });
    });

    xf.on('error', (err) => {
      console.error(`[model-ingress] sse transform error: ${err.message}`);
      stopPing();
      report(false, `transform: ${err.message}`);
      try { res.end(); } catch { /* ignore */ }
    });
    xf.on('end', () => {
      stopPing();
      if (dead) return;                            // 账在 res 'close' 那里已经结过了
      report(!xf.failReason, xf.failReason || '');
      onTruncated(xf.truncated);
      // ⭐ 记账用**累计**（失败那几发也烧了上游的 token）；给 CLI 的 message_delta 用最后一发（见 openai-chat.js）
      if (xf.cost != null || xf.usageTotal) onBilling({ costUsd: xf.cost, usage: xf.usageTotal });
    });

    const finish = (verdict) => { stopPing(); xf.finalize(verdict); xf.end(); };
    /** 还没开始流就失败：回真正的 HTTP 状态码（CLI 据此退避重试）；已经在流里了：以 error 事件收场 */
    const failHard = (status, msg, reason) => {
      stopPing();
      if (!streaming) {
        report(false, reason);
        const errBody = JSON.stringify(toAnthropicError(status, msg));
        try {
          res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(errBody)) });
          res.end(errBody);
        } catch { /* 客户端已经走了 */ }
        return;
      }
      report(false, reason);
      xf.failWith(toAnthropicError(status, msg).error.message, reason);   // 走 failWith：置 done，_flush 不会再补第二条 error
      xf.end();
    };
    // 额度按**行**取（model-context 的 api.emptyRetries / api.retryBudgetMs），行内没写才走全局默认。
    // 这是模型体质问题不是协议问题：Ox 两个主行放宽到 6 次 / 360 秒，别的行照旧 2 次 / 120 秒。
    const maxRetries = Number.isFinite(wire.emptyRetries) ? wire.emptyRetries : emptyRetryLimit();
    const budgetMs = Number.isFinite(wire.retryBudgetMs) ? wire.retryBudgetMs : retryBudgetMs();
    /** 重发额度还够吗（次数 + 墙钟预算 + 客户端还在） */
    const canRetry = () => !dead && (xf.attempts - 1) < maxRetries && (Date.now() - t0) < budgetMs;

    const runAttempt = () => {
      if (dead) return;
      let over = false;
      let proxyRes = null;
      /**
       * 这一发结束（干净 EOF / RST / 连不上都走这里 —— res 的收尾权只有它一个主人）。
       * @param {string|null} why  非空 = 异常收场的原因
       * @param {boolean} hadResponse  拿到过响应头吗（没拿到 = 连都没连上，判决交给转换层的既有状态）
       */
      const attemptOver = (why, hadResponse = true) => {
        if (over || dead) return;
        over = true;
        currentReq = null;
        if (why) console.warn(`[model-ingress] sid=${sidShort} upstream=${wire.upstreamId} 这一发异常收场（${why}）`);
        try { proxyRes?.unpipe?.(xf); } catch { /* 已经断了就算了 */ }   // 解开这一发的 pipe，别让监听器一发发攒着
        const verdict = xf.attemptEnd();
        if (verdict.kind !== 'empty') { finish(verdict); return; }
        if (!canRetry()) {
          console.warn(`[model-ingress] sid=${sidShort} upstream=${wire.upstreamId} 零可见输出（${verdict.reason}），重发额度用完（第 ${xf.attempts} 发，已花 ${Math.round((Date.now() - t0) / 1000)}s）`);
          if (!streaming) { failHard(502, `${label}${hadResponse ? '返回了空响应' : '连不上'}（${why || verdict.reason}）—— 已自动重发仍失败，稍后再发一次`, verdict.reason); return; }
          finish(verdict);
          return;
        }
        console.warn(`[model-ingress] sid=${sidShort} upstream=${wire.upstreamId} 零可见输出（${verdict.reason}）→ 就地重发第 ${xf.attempts} 次`);
        onNotice(`${label}这一发只想了没说就断了，正在原地重发（第 ${xf.attempts} 次），稍等一下别刷新。`);
        startPing();
        retryTimer = setTimeout(() => { retryTimer = null; if (dead) return; xf.beginAttempt(); runAttempt(); }, RETRY_DELAY_MS);
      };

      currentReq = request((incoming) => {
        proxyRes = incoming;
        const status = proxyRes.statusCode || 502;
        if (status >= 400) {
          const chunks = [];
          let settled = false;
          const done = (text) => {
            if (settled || dead) return;
            settled = true;
            currentReq = null;
            const msg = text?.trim() ? text : `${label} 上游返回 ${status}（模型暂时不可用，稍后再发一次）`;
            console.warn(`[model-ingress] sid=${sidShort} upstream=${wire.upstreamId} ${status} model=${wire.wireModel} body=${String(text || '').slice(0, 200).replace(/\s+/g, ' ')}`);
            failHard(status, msg, `HTTP ${status}${streaming ? ' on retry' : ''}`);
          };
          proxyRes.on('data', (c) => chunks.push(c));
          proxyRes.on('aborted', () => done(''));
          proxyRes.on('error', (err) => done(`${label} 上游返回 ${status}，响应还没传完就断了（${err.code || err.message}）`));
          proxyRes.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
          return;
        }

        stopPing();
        if (!streaming) {
          streaming = true;
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          xf.pipe(res);
        }
        proxyRes.on('aborted', () => attemptOver('aborted'));
        proxyRes.on('error', (err) => attemptOver(err.code || err.message));
        proxyRes.on('end', () => attemptOver(null));
        proxyRes.pipe(xf, { end: false });   // end:false —— 这条 SSE 还要接着用（可能再打一发）
      }, (detail) => attemptOver(detail, false));   // 连不上 / RST：同一条判决路，绝不自己碰 res
    };
    runAttempt();
    return;
  }

  // ── 非流式（CLI 的兜底通路）：整包转，不做就地重发 ──
  request((proxyRes) => {
    const status = proxyRes.statusCode || 502;
    const chunks = [];
    let settled = false;
    proxyRes.on('data', (c) => chunks.push(c));
    // 上游半路掐了，'end' 不来 —— 别让请求悬着，就地回 502（CLI 会重试）
    proxyRes.on('aborted', () => proxyRes.emit('error', Object.assign(new Error('upstream aborted'), { code: 'ECONNRESET' })));
    proxyRes.on('error', (err) => {
      if (settled) return;
      settled = true;
      const detail = err.code || err.message;
      console.warn(`[model-ingress] sid=${sidShort} upstream=${wire.upstreamId} 非流式响应被掐断（${detail}）`);
      onOutcome(false, `upstream stream aborted: ${detail}`);
      if (res.headersSent) { try { res.end(); } catch { /* */ } return; }
      const errBody = JSON.stringify(toAnthropicError(502, `${label} 的响应传到一半断了（${detail}）—— 稍后再发一次`));
      res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(errBody);
    });
    proxyRes.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8');
      if (status >= 400) {
        console.warn(`[model-ingress] sid=${sidShort} upstream=${wire.upstreamId} ${status} model=${wire.wireModel} body=${text.slice(0, 200).replace(/\s+/g, ' ')}`);
        const msg = text.trim() ? text : `${label} 上游返回 ${status}（模型暂时不可用，稍后再发一次）`;
        onOutcome(false, `HTTP ${status}`);
        const errBody = JSON.stringify(toAnthropicError(status, msg));
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(errBody)) });
        res.end(errBody);
        return;
      }
      let out;
      let upstreamJson;
      try { upstreamJson = JSON.parse(text); out = fromOpenAIChatResponse(upstreamJson); }
      catch (err) {
        const errBody = JSON.stringify(toAnthropicError(502, `ingress: upstream JSON unreadable (${err.message})`));
        res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(errBody); return;
      }
      if (!out) {   // 200 但没有 choices / 私货 finish_reason 且零可见输出：别包成成功
        const alienFinish = upstreamJson?.choices?.[0]?.finish_reason;
        const msg = upstreamJson?.error?.message
          || (alienFinish
            ? `${label}以 ${alienFinish} 结束了这次请求，没有输出任何正文 —— 上游自己的链路出错，已自动重试仍失败；稍后再发，或换个模型（upstream ended with finish_reason='${alienFinish}' and no visible output）`
            : `${label}返回了空响应，一个字都没有 —— 上游问题，已自动重试仍失败；稍后再发，或换个模型（upstream returned no choices）`);
        console.warn(`[model-ingress] sid=${sidShort} upstream=${wire.upstreamId} 200-but-empty model=${wire.wireModel} ${String(msg).slice(0, 160)}`);
        onOutcome(false, String(msg).slice(0, 120));
        const errBody = JSON.stringify(toAnthropicError(502, String(msg)));
        res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(errBody); return;
      }
      onOutcome(true);
      onTruncated(truncationOfChatResponse(upstreamJson));
      const costUsd = upstreamCostOf(upstreamJson);   // Zen 放顶层、Merge 网关放 usage.cost
      if (costUsd != null || upstreamJson.usage) onBilling({ costUsd, usage: upstreamJson.usage || null });
      const respBody = JSON.stringify(out);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(respBody)) });
      res.end(respBody);
    });
  }, (detail) => {
    onOutcome(false, `forward: ${detail}`);
    if (res.headersSent) { try { res.end(); } catch { /* */ } return; }
    try { res.writeHead(502); res.end(`ingress forward error: ${detail}`); } catch { /* ignore */ }
  });
}
