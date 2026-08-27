/**
 * server/_probe-sdk-loop.mjs — 真 claude-agent-sdk 循环 → 本进程 ingress（openai-chat 转换层）→ 上游。
 * 验：工具循环转得动、tool_result 回图能看见、流式事件 SDK 吃得下、usage/cost 记账形状。
 *   node --env-file=.env server/_probe-sdk-loop.mjs [appModel]
 *
 * 08-26 从 _probe-ox-sdk.mjs 改名；08-27 默认行换成 glm-5.3-flash-merge（zenGo 那条 glm 撤了）。这支探针查的
 * 从来不是某个模型，是**接一条新行之后 SDK 那一圈还转不转得动**。接下一条 openai-chat 行时直接拿它跑。
 */
import sharp from 'sharp';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { getOrStartIngress, registerIngressSession, stopIngress } from './lib/model-ingress.js';
import { resolveModelRoute, pickThinkingConfig } from './engine/agent/model-context.js';

const APP = process.argv[2] || 'glm-5.3-flash-merge';
const route = resolveModelRoute(APP);
const { baseUrl } = await getOrStartIngress();
const SID = `sdkprobe-${Date.now()}`;
registerIngressSession(SID, APP);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><rect width="480" height="320" fill="#102040"/><polygon points="240,40 120,220 360,220" fill="#ffd21e"/><text x="240" y="285" font-size="44" font-family="monospace" fill="#ffffff" text-anchor="middle">ND-7342</text></svg>`;
const pngB64 = (await sharp(Buffer.from(svg)).png().toBuffer()).toString('base64');
let toolCalled = 0;
const probeServer = createSdkMcpServer({ name: 'probe', version: '1.0.0', tools: [
  tool('peek_screen', 'Take a screenshot of the current screen and return it as an image.', {}, async () => { toolCalled += 1; return { content: [{ type: 'image', data: pngB64, mimeType: 'image/png' }] }; }),
] });

console.log(`===== SDK e2e: ${APP} (alias ${route.sdkAlias}) via ingress ${baseUrl} =====`);
const t0 = Date.now(); let finalText = ''; let resultMsg = null; let sawThinking = false;
try {
  const q = query({
    prompt: '调用 peek_screen 工具看一眼屏幕，然后告诉我：图片里写着什么文字、画的是什么形状、什么颜色。',
    options: {
      model: route.sdkAlias,
      thinking: pickThinkingConfig(APP),
      // ⚠️ SMALL_FAST_MODEL 注的是 fastModel 的 **app id**，跟生产一致（session-loop.js:373）——
      // 注 alias 的话 helper 请求和主请求同名，入口分不出 role，这条分岔就白验了
      env: { ...process.env, ANTHROPIC_BASE_URL: `${baseUrl}/__nd/${encodeURIComponent(SID)}`, ANTHROPIC_API_KEY: 'nd-ingress-managed', ANTHROPIC_SMALL_FAST_MODEL: route.fastModel, CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(route.window) },
      mcpServers: { probe: probeServer },
      allowedTools: ['mcp__probe__peek_screen'],
      permissionMode: 'bypassPermissions',
      maxTurns: 4,
    },
  });
  for await (const m of q) {
    if (m.type === 'assistant') {
      const kinds = (m.message?.content || []).map(b => b.type).join(',');
      console.log(`  [assistant] blocks=[${kinds}] stop=${m.message?.stop_reason}`);
      for (const b of m.message?.content || []) {
        if (b.type === 'thinking') sawThinking = true;
        if (b.type === 'text' && b.text?.trim()) finalText = b.text;
        if (b.type === 'tool_use') console.log(`    tool_use → ${b.name}`);
      }
    } else if (m.type === 'result') resultMsg = m;
    // 仪表 vs 真 usage：CLI 的 getContextUsage 在「最近一条有 usage」时用真数，否则退回按字符估算
    // （图片 base64/4 → 一张 200KB 图估成 5 万 token）。这里每条 assistant 后读一次对照
    if (m.type === 'assistant' && process.env.PROBE_CTX && typeof q.getContextUsage === 'function') {
      try { const cu = await q.getContextUsage(); console.log(`  [ctx] meter total=${cu.totalTokens} toolResult=${cu.messageBreakdown?.toolResultTokens} | real usage=${JSON.stringify(m.message?.usage || {})} | pngB64=${pngB64.length}`); }
      catch (e) { console.log('  [ctx] n/a', e.message); }
    }
    else if (m.type === 'system' && m.subtype === 'init') console.log(`  [init] model=${m.model} tools=${(m.tools || []).length}`);
    else console.log(`  [${m.type}${m.subtype ? '/' + m.subtype : ''}]`);
  }
} catch (e) { console.log('✗ SDK 循环抛错：', e?.message || e); }
const ms = Date.now() - t0;
console.log(`\n工具被真调了 ${toolCalled} 次；总耗时 ${Math.round(ms / 1000)}s；看到 thinking 块：${sawThinking}`);
console.log(`最终回答（前 200 字）：「${finalText.slice(0, 200)}」`);
console.log(`${toolCalled > 0 ? '✓' : '✗'} SDK 循环进了工具`);
console.log(`${/7342/.test(finalText) && /(三角|triangle)/i.test(finalText) ? '✓' : '✗'} 回答对上真值（文字 ND-7342 + 三角形）`);
if (resultMsg) { console.log(`result: subtype=${resultMsg.subtype} turns=${resultMsg.num_turns} cost=$${resultMsg.total_cost_usd}`); console.log('modelUsage:', JSON.stringify(resultMsg.modelUsage || {}).slice(0, 400)); }
await stopIngress();
process.exit(0);
