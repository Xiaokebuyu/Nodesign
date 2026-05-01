/**
 * server/_probe-binary-thinking.js — Claude Agent SDK binary 行为诊断 probe
 *
 * # 定位
 *
 * 启动 HTTP proxy on :4099 转发到真实 gateway，拦截 binary 实际发出去的
 * request body 看 binary 怎么处理 SDK options。lib/binary-fixup-proxy.js
 * 是基于这个 probe 的发现写的生产级 proxy。
 *
 * # 已验证的发现（留档作未来 debug 起点）
 *
 * 1. binary 对**非白名单 model id**（含 kimi-*）一律 fallback 到
 *    `thinking: { type: 'adaptive' }`，即使我们传 enabled 也被强转
 * 2. binary 默认即使不传 thinking 也会自动加 `{type:'adaptive'}`
 * 3. 唯一不发 thinking 字段的方式是显式 `{type:'disabled'}`（但那等于关）
 * 4. `ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES=thinking` 在 LLM
 *    gateway 模式下不生效（Anthropic 文档明确："take effect on Bedrock /
 *    Vertex / Foundry only"）
 * 5. `ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES=thinking` 同样
 *    不生效（即使配合 sonnet alias resolve 让 model id 映射成功）
 *
 * # 用法
 *
 *   PROBE_VARIANT=baseline                # 默认：thinking enabled + effort
 *   PROBE_VARIANT=disabled                # 显式 disabled
 *   PROBE_VARIANT=none                    # 完全不传
 *   PROBE_MODEL=claude-sonnet-4-5         # 默认：kimi-k2.6（NODESIGN_MODEL）
 *   PROBE_CAPS=thinking                   # 试 CUSTOM_MODEL_OPTION 路径
 *   PROBE_PIN_SONNET=thinking             # 试 DEFAULT_SONNET_MODEL 路径
 *   DUMP_FULL_BODY=1                      # 完整 body 写到 /tmp 看字段
 *
 *   node --env-file-if-exists=.env server/_probe-binary-thinking.js
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';

const REAL_GATEWAY = process.env.NODESIGN_GATEWAY_URL;
if (!REAL_GATEWAY) {
  console.error('需要 NODESIGN_GATEWAY_URL 环境变量');
  process.exit(1);
}

const target = new URL(REAL_GATEWAY);
const proxyPort = 4099;

// 记录所有 request 的 body
const requestLog = [];

const proxy = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    let parsed = null;
    try { parsed = JSON.parse(body); } catch {}

    // 关键：log 出 thinking / model / 跟 thinking 相关的字段
    const summary = {
      url: req.url,
      method: req.method,
      hasThinkingField: parsed && 'thinking' in parsed,
      thinkingValue: parsed?.thinking ?? null,
      maxThinkingTokens: parsed?.max_thinking_tokens ?? null,
      thinkingBudget: parsed?.thinking_budget ?? null,
      model: parsed?.model ?? null,
      stream: parsed?.stream ?? null,
      headers: Object.fromEntries(
        Object.entries(req.headers).filter(([k]) =>
          /anthropic-beta|anthropic-version|x-api-key|authorization/i.test(k)
        ),
      ),
      bodySize: body.length,
    };
    requestLog.push(summary);
    console.log('\n=== INTERCEPTED ===');
    console.log(JSON.stringify(summary, null, 2));

    // DUMP_FULL_BODY=1 时把完整 body 落盘，方便看是不是有意外字段
    if (process.env.DUMP_FULL_BODY && parsed) {
      const dumpName = `/tmp/nodesign-binary-req-${Date.now()}.json`;
      fs.writeFileSync(dumpName, JSON.stringify(parsed, null, 2));
      console.log(`>>> full body dumped to ${dumpName}`);
      // 同时打印 top-level 字段名 + 前 30 行
      console.log('>>> top-level keys:', Object.keys(parsed).join(', '));
    }

    // 转发
    const targetReq = (target.protocol === 'https:' ? https : http).request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname.replace(/\/$/, '') + req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: target.hostname,
      },
    }, (tres) => {
      res.writeHead(tres.statusCode, tres.headers);
      tres.pipe(res);
    });

    targetReq.on('error', (err) => {
      console.error('proxy forward error:', err.message);
      try { res.writeHead(502); res.end(err.message); } catch {}
    });

    targetReq.write(body);
    targetReq.end();
  });
});

await new Promise((resolve) => proxy.listen(proxyPort, resolve));
console.log(`proxy listening on http://localhost:${proxyPort} → ${REAL_GATEWAY}`);

// 让 SDK binary 走 proxy
process.env.ANTHROPIC_BASE_URL = `http://localhost:${proxyPort}`;
process.env.ANTHROPIC_API_KEY = process.env.NODESIGN_GATEWAY_KEY;

// 实验：通过 ANTHROPIC_CUSTOM_MODEL_OPTION 注册 kimi-k2.6 + 只声明
// 'thinking' capability（不声明 adaptive_thinking）→ 看 binary 是否
// 改用 enabled 而不是 fallback 到 adaptive
if (process.env.PROBE_CAPS) {
  process.env.ANTHROPIC_CUSTOM_MODEL_OPTION = process.env.NODESIGN_MODEL || 'kimi-k2.6';
  process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = 'Kimi K2.6 (NoDesign)';
  process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION = 'Kimi via tokendance gateway';
  process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES = process.env.PROBE_CAPS;
  console.log(`>>> Set ANTHROPIC_CUSTOM_MODEL_OPTION + SUPPORTED_CAPABILITIES=${process.env.PROBE_CAPS}\n`);
}

// 备选路径：用 _DEFAULT_SONNET_MODEL 把 sonnet alias resolve 到 kimi-k2.6
// 然后通过 _SUPPORTED_CAPABILITIES 声明 capability。设置后请用
// PROBE_MODEL=sonnet 触发 alias 路径
if (process.env.PROBE_PIN_SONNET) {
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = process.env.NODESIGN_MODEL || 'kimi-k2.6';
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = 'Kimi K2.6 (sonnet alias)';
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = process.env.PROBE_PIN_SONNET;
  console.log(`>>> Pin sonnet alias → kimi-k2.6 + SUPPORTED_CAPABILITIES=${process.env.PROBE_PIN_SONNET}\n`);
}

console.log('\n开始跑 SDK query()，让它走 proxy...\n');

// A/B 切换：看哪些 options 触发 binary 把 enabled → adaptive
const VARIANT = process.env.PROBE_VARIANT || 'baseline';
const optionsByVariant = {
  // baseline: NoDesign 当前生产 options 同款
  baseline: {
    thinking: { type: 'enabled', budgetTokens: 1024 },
    effort: 'medium',
  },
  // 不传 effort
  no_effort: {
    thinking: { type: 'enabled', budgetTokens: 1024 },
  },
  // 不传 thinking（看 binary 默认）
  no_thinking: {
    effort: 'medium',
  },
  // 完全不传两个
  none: {},
  // 传 maxThinkingTokens (deprecated 字段)
  max_thinking_tokens: {
    maxThinkingTokens: 1024,
    effort: 'medium',
  },
  // 显式 disabled
  disabled: {
    thinking: { type: 'disabled' },
  },
};

const v = optionsByVariant[VARIANT];
if (!v) {
  console.error(`unknown VARIANT=${VARIANT}, choose: ${Object.keys(optionsByVariant).join(', ')}`);
  process.exit(1);
}
console.log(`\n>>> VARIANT=${VARIANT}, options keys: ${Object.keys(v).join(', ') || '(none)'}\n`);

// PROBE_MODEL 让我们也能 A/B 测 model id（看 binary 是否按 id 走不同 path）
const TEST_MODEL = process.env.PROBE_MODEL || process.env.NODESIGN_MODEL || 'kimi-k2.6';
console.log(`>>> PROBE_MODEL=${TEST_MODEL}\n`);

try {
  const iter = query({
    prompt: '请思考一下：1+1 等于几？',
    options: {
      model: TEST_MODEL,
      ...v,
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
    },
  });

  for await (const msg of iter) {
    if (msg.type === 'assistant') {
      const blocks = msg.message?.content || [];
      console.log(`\n=== ASSISTANT MESSAGE ===`);
      for (const b of blocks) {
        if (b.type === 'thinking') {
          console.log(`  - thinking block: ${(b.thinking || '').length} chars`);
        } else if (b.type === 'text') {
          console.log(`  - text block: ${(b.text || '').slice(0, 80)}`);
        } else {
          console.log(`  - ${b.type}`);
        }
      }
    }
    if (msg.type === 'result') {
      console.log(`\n=== RESULT ===`);
      console.log(`  subtype: ${msg.subtype}, turns: ${msg.num_turns}, cost: $${msg.total_cost_usd?.toFixed(4)}`);
    }
  }
} catch (err) {
  console.error('query error:', err.message);
}

console.log(`\n\n=== 汇总：拦截到 ${requestLog.length} 个 request ===`);
for (const r of requestLog) {
  console.log(`\n  ${r.method} ${r.url}`);
  console.log(`    model: ${r.model}`);
  console.log(`    hasThinkingField: ${r.hasThinkingField}`);
  console.log(`    thinking value: ${JSON.stringify(r.thinkingValue)}`);
  if (r.maxThinkingTokens != null) console.log(`    max_thinking_tokens: ${r.maxThinkingTokens}`);
  if (r.thinkingBudget != null) console.log(`    thinking_budget: ${r.thinkingBudget}`);
  if (r.headers['anthropic-beta']) console.log(`    anthropic-beta: ${r.headers['anthropic-beta']}`);
}

console.log(`\n\n=== 解读 ===`);
const messagesReq = requestLog.filter(r => r.url.includes('/messages'));
const sentThinking = messagesReq.some(r => r.hasThinkingField);
const hasInterleavedHeader = messagesReq.some(r =>
  /interleaved-thinking/.test(r.headers['anthropic-beta'] || '')
);

if (sentThinking) {
  console.log('✅ binary 把 thinking 字段传到 gateway 了');
  console.log('   → 问题在 gateway → Kimi 的链路');
} else {
  console.log('❌ binary 没把 thinking 传到 gateway！');
  console.log('   可能根因：');
  console.log('     1. binary 内部对非 claude-* model id 跳过 thinking 字段');
  console.log('     2. SDK options.thinking 在 binary spawn 时被 strip');
  console.log('     3. 字段名转换（thinking → thinking_budget 之类）');
  if (messagesReq.length > 0 && messagesReq[0].maxThinkingTokens != null) {
    console.log(`   实际看到 max_thinking_tokens=${messagesReq[0].maxThinkingTokens} → 字段名换了`);
  }
}

console.log(`\nbeta header: ${hasInterleavedHeader ? '有 interleaved-thinking' : '无'}`);

proxy.close();
process.exit(0);
