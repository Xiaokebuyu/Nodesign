/**
 * model-ingress 修补流水线测试（纯函数半；带 HTTP server 的转发半在
 * server/lib/_ingress-check.mjs 真跑校验 —— 对照组是 08-19 探针里已知
 * 会丢图的中转站 Gemini 桥）。
 */

import { describe, it, expect } from 'vitest';
import {
  transformForUpstream, liftImagesFromToolResult, estimateInputTokens,
  resolveSessionWire, registerIngressSession, unregisterIngressSession,
} from './model-ingress.js';
import { resolveWireModel, UPSTREAMS } from '../engine/agent/model-context.js';
import sharp from 'sharp';

const IMG = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } };

function geminiBody(extra = {}) {
  return {
    model: 'claude-opus-4-6',   // SDK 序列化时剥了 [1m] 的 alias 形态
    max_tokens: 32000,
    messages: [
      { role: 'user', content: '看一眼' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'peek', input: {} }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ ...IMG }] }],
      },
    ],
    ...extra,
  };
}

describe('transformForUpstream（Gemini 路：rename + strip thinking + lift）', () => {
  it('model 还原成上游真名', async () => {
    const body = geminiBody();
    await transformForUpstream(body, resolveWireModel(body.model));
    expect(body.model).toBe('反重力-流式抗截断/gemini-3.7-flash-high');
  });

  it('thinking 字段被整个删掉（strip 档）', async () => {
    const body = geminiBody({ thinking: { type: 'enabled', budget_tokens: 8192 } });
    await transformForUpstream(body, resolveWireModel('claude-opus-4-6'));
    expect('thinking' in body).toBe(false);
  });

  it('⭐tool_result 里的图提升到 user message 顶层，原位留占位文本', async () => {
    const body = geminiBody();
    await transformForUpstream(body, resolveWireModel('claude-opus-4-6'));
    const userMsg = body.messages[2];
    const toolResult = userMsg.content[0];
    expect(toolResult.content[0].type).toBe('text');            // 原位变占位
    const last = userMsg.content[userMsg.content.length - 1];
    expect(last.type).toBe('image');                            // 图在顶层末尾
    expect(last.source.data).toBe(IMG.source.data);
  });

  it('enabled8k 档（原 Kimi 路，kimi 行 08-21 深夜删了，逻辑留着）：adaptive 改写成 enabled+budget，已是 enabled 的不动', async () => {
    // 表里已无 enabled8k 的行，直接喂一个字面 wire 钉住流水线行为
    const wire = { appModel: 'fake-kimi', wireModel: 'fake-kimi-wire', upstreamId: 'lament', upstream: UPSTREAMS.lament, thinking: 'enabled8k', liftImages: false };
    const a = { model: 'claude-opus-4-7', thinking: { type: 'adaptive' }, messages: [] };
    await transformForUpstream(a, wire);
    expect(a.model).toBe('fake-kimi-wire');
    expect(a.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });

    const b = { model: 'claude-opus-4-7', thinking: { type: 'enabled', budget_tokens: 4096 }, messages: [] };
    await transformForUpstream(b, wire);
    expect(b.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
  });
});

describe("thinking 'adaptive' 档（08-25 MiniMax M3）", () => {
  const wire = (t) => ({ appModel: 'minimax-m3', wireModel: 'MiniMaxAI/MiniMax-M3', upstreamId: 'gmi', upstream: UPSTREAMS.gmi, thinking: t, liftImages: false });

  it('本站发的 enabled+budget 改写成 adaptive —— 让"该不该想"由模型自己判断', async () => {
    // pickThinkingConfig 给每条 API 行发的都是 enabled+8192，对 M3 等于逐轮强制想满预算
    const body = { model: 'minimax-m3', thinking: { type: 'enabled', budget_tokens: 8192 }, messages: [] };
    expect(await transformForUpstream(body, wire('adaptive'))).toBe(true);
    expect(body.thinking).toEqual({ type: 'adaptive' });
  });

  it('已经是 adaptive 的不动；没有 thinking 字段的不凭空加', async () => {
    const a = { model: 'minimax-m3', thinking: { type: 'adaptive' }, messages: [] };
    await transformForUpstream(a, wire('adaptive'));
    expect(a.thinking).toEqual({ type: 'adaptive' });
    const b = { model: 'MiniMaxAI/MiniMax-M3', messages: [] };
    expect(await transformForUpstream(b, wire('adaptive'))).toBe(false);
    expect('thinking' in b).toBe(false);
  });

  it('⚠️ disabled 不动：那是调用方明确要求别想，行的默认档不该压过它', async () => {
    const body = { model: 'minimax-m3', thinking: { type: 'disabled' }, messages: [] };
    await transformForUpstream(body, wire('adaptive'));
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it("helper 行仍是 strip：M3 不传 thinking 就是不想，标题不该想八千字", async () => {
    const body = { model: 'deepseek-v4-flash-helper', thinking: { type: 'enabled', budget_tokens: 8192 }, messages: [] };
    await transformForUpstream(body, wire('strip'));
    expect('thinking' in body).toBe(false);
  });
});

describe('liftImagesFromToolResult', () => {
  it('assistant message / 无图 tool_result / 字符串 content 都不动', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'n', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'plain text' }] },
      { role: 'user', content: 'string content' },
    ];
    const snapshot = JSON.stringify(messages);
    expect(liftImagesFromToolResult(messages)).toBe(false);
    expect(JSON.stringify(messages)).toBe(snapshot);
  });

  it('同一条消息里多个 tool_result 各自的图都提升且保序', () => {
    const messages = [{
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: [{ ...IMG }, { type: 'text', text: 'cap' }] },
        { type: 'tool_result', tool_use_id: 'b', content: [{ ...IMG, source: { ...IMG.source, data: 'd29ybGQ=' } }] },
      ],
    }];
    expect(liftImagesFromToolResult(messages)).toBe(true);
    const imgs = messages[0].content.filter((b) => b.type === 'image');
    expect(imgs.map((b) => b.source.data)).toEqual(['aGVsbG8=', 'd29ybGQ=']);
  });
});

describe('estimateInputTokens', () => {
  it('中英混合有量级正确的估算（不是 0 也不是天文数字）', () => {
    const n = estimateInputTokens({
      system: '你是一个设计助手。'.repeat(100),
      messages: [{ role: 'user', content: 'hello world '.repeat(200) }],
      tools: [{ name: 'peek', description: 'take a screenshot', input_schema: { type: 'object' } }],
    });
    expect(n).toBeGreaterThan(1000);
    expect(n).toBeLessThan(10000);
  });

  it('解析不了（如循环引用进 JSON.stringify）返回保守值', () => {
    const cyclic = {};
    cyclic.self = cyclic;
    expect(estimateInputTokens({ tools: [{ name: 'x', input_schema: cyclic }] })).toBe(50000);
  });
});

/**
 * 图片归一（2026-08-19）：生产真撞过 —— llama.cpp 走 stb_image 解不开 webp，
 * 上游返回一句看不出真因的 400。断言用**真图字节**（sharp 现造），不用假 base64：
 * 这条路的全部逻辑都在 sharp 的 metadata 上分流，喂假数据等于什么都没测。
 */
describe('图片归一：按上游声明的 imageFormats 转码', () => {
  const mk = async (fmt, w = 64, h = 64, alpha = false) => {
    const base = sharp({
      create: { width: w, height: h, channels: alpha ? 4 : 3,
        background: alpha ? { r: 200, g: 30, b: 30, alpha: 0.5 } : { r: 200, g: 30, b: 30 } },
    });
    const buf = await (fmt === 'webp' ? base.webp() : fmt === 'png' ? base.png() : base.jpeg()).toBuffer();
    return { type: 'image', source: { type: 'base64', media_type: `image/${fmt}`, data: buf.toString('base64') } };
  };
  const msgs = (block) => [{ role: 'user', content: [block] }];
  const wireFor = (upstream) => ({ wireModel: 'qwen3.8-27b', upstream });

  it('webp → qwenLocal 会被转码（真因就在这：stb_image 不认 webp）', async () => {
    const parsed = { model: 'x', messages: msgs(await mk('webp')) };
    await transformForUpstream(parsed, wireFor(UPSTREAMS.qwenLocal));
    const out = parsed.messages[0].content[0].source;
    expect(out.media_type).toBe('image/jpeg');                       // 无 alpha → jpeg
    const meta = await sharp(Buffer.from(out.data, 'base64')).metadata();
    expect(meta.format).toBe('jpeg');                                 // 真的是 jpeg 字节，不只是改了标签
    expect(meta.width).toBe(64);                                      // 没顺手缩掉
  });

  it('带 alpha 的 webp 转 png（保住透明），小图不 resize', async () => {
    const parsed = { model: 'x', messages: msgs(await mk('webp', 64, 64, true)) };
    await transformForUpstream(parsed, wireFor(UPSTREAMS.qwenLocal));
    const out = parsed.messages[0].content[0].source;
    expect(out.media_type).toBe('image/png');
    expect((await sharp(Buffer.from(out.data, 'base64')).metadata()).hasAlpha).toBe(true);
  });

  it('png / jpeg 本来就在白名单里 → 一个字节都不动', async () => {
    for (const fmt of ['png', 'jpeg']) {
      const block = await mk(fmt);
      const before = block.source.data;
      const parsed = { model: 'qwen3.8-27b', messages: msgs(block) };
      const mutated = await transformForUpstream(parsed, wireFor(UPSTREAMS.qwenLocal));
      expect(parsed.messages[0].content[0].source.data, `${fmt} 被动了`).toBe(before);
      expect(mutated).toBe(false);
    }
  });

  it('⚠️ 没声明 imageFormats 的上游（中转站）维持原样 —— webp 照旧透传', async () => {
    const block = await mk('webp');
    const before = block.source.data;
    const parsed = { model: 'x', messages: msgs(block) };
    await transformForUpstream(parsed, wireFor(UPSTREAMS.lament));
    expect(parsed.messages[0].content[0].source.media_type).toBe('image/webp');
    expect(parsed.messages[0].content[0].source.data).toBe(before);
  });

  it('tool_result 内嵌的图同样被转码（llama.cpp 那条路 liftImages 是关的，图就留在里面）', async () => {
    const parsed = { model: 'x', messages: [{ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: [await mk('webp')] },
    ] }] };
    await transformForUpstream(parsed, wireFor(UPSTREAMS.qwenLocal));
    expect(parsed.messages[0].content[0].content[0].source.media_type).toBe('image/jpeg');
  });

  it('gif 不进这条路（重 encode 会丢帧），原样透传', async () => {
    const block = { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: 'R0lGOD' } };
    const parsed = { model: 'x', messages: msgs(block) };
    await transformForUpstream(parsed, wireFor(UPSTREAMS.qwenLocal));
    expect(parsed.messages[0].content[0].source.media_type).toBe('image/gif');
  });
});

describe('会话级路由 resolveSessionWire（⛔ 撞名雷封口，2026-08-20）', () => {
  // 背景：API 行的 sdkAlias 同时是真实 Claude 名。qwen 会话里的 binary 若用
  // 'claude-opus-4-6'（gemini 行的 alias、钥匙配着）发一发 helper 请求，全表反查
  // 会带着 lament 的钥匙静默转发 —— 入口成功转发不留日志，只有记账侧事后看得见。
  const SID = 'ingress-test-qwen';
  it('无会话前缀 / 没注册：全表反查照旧（探针、体检走这条）', () => {
    expect(resolveSessionWire('claude-opus-4-6', null)).toMatchObject({ reason: 'table', wire: { appModel: 'gemini-3.7-flash' } });
    expect(resolveSessionWire('claude-opus-4-6', 'never-registered')).toMatchObject({ reason: 'table', wire: { appModel: 'gemini-3.7-flash' } });
    expect(resolveSessionWire('nonsense-model', null)).toEqual({ wire: null, reason: 'none', role: 'main' });
  });
  it('qwen 会话：自己的 alias（原样 / 剥[1m]）→ 自己那行', () => {
    registerIngressSession(SID, 'qwen3.8-27b');
    try {
      expect(resolveSessionWire('claude-opus-5[1m]', SID)).toMatchObject({ reason: 'table', wire: { appModel: 'qwen3.8-27b' } });
      expect(resolveSessionWire('claude-opus-5', SID)).toMatchObject({ reason: 'table', wire: { appModel: 'qwen3.8-27b' } });
      expect(resolveSessionWire('qwen3.8-27b', SID)).toMatchObject({ reason: 'table', wire: { appModel: 'qwen3.8-27b' } });
    } finally { unregisterIngressSession(SID); }
  });
  it('role：主行 main；fast 行 / 兜底 / 撞名 都是 helper（08-21，helper 降思考档用）', () => {
    // 08-26：这条原先钉在 Ox 三行上，那族随模型下架删了，换成接替它的 glm 行 —— 要点没变：
    // **主行和 fast 行不同名**，入口才分得出 role，helper 才不会跟着主行 high 想
    const S2 = 'ingress-test-glm';
    registerIngressSession(S2, 'glm-5.3-flash');
    try {
      expect(resolveSessionWire('glm-5.3-flash', S2)).toMatchObject({ reason: 'table', role: 'main', wire: { appModel: 'glm-5.3-flash', reasoningEffort: 'high', helperReasoningEffort: 'low' } });
      expect(resolveSessionWire('deepseek-v4-flash-helper', S2)).toMatchObject({ reason: 'table', role: 'helper', wire: { appModel: 'deepseek-v4-flash-helper', reasoningEffort: 'low' } });
      expect(resolveSessionWire('claude-sonnet-5', S2)).toMatchObject({ reason: 'fallback', role: 'helper', wire: { appModel: 'deepseek-v4-flash-helper' } });
      // 别行的**独占** alias 在这个会话里是撞名雷（那是别家的钥匙）→ 改道本会话 fast
      expect(resolveSessionWire('claude-opus-4-7[1m]', S2)).toMatchObject({ reason: 'collision', role: 'helper', collidesWith: 'deepseek-v4-flash-vision', wire: { appModel: 'deepseek-v4-flash-helper' } });
      expect(resolveSessionWire('glm-5.3-flash', null)).toMatchObject({ role: 'main' });
    } finally { unregisterIngressSession(S2); }
  });
  it('⭐共用别名（MiniMax 三行 + 外部插槽同名）：主行优先 —— alias 解成会话主行，helper 按 app id 认', () => {
    const S = 'ingress-test-minimax';
    registerIngressSession(S, 'minimax-m3');
    try {
      // 主行和 fast 行共用同一个 alias，wireNamesOf 两边都包含它 —— 靠 resolveSessionWire 先问主行定胜负
      expect(resolveSessionWire('claude-sonnet-4-6[1m]', S)).toMatchObject({ reason: 'table', role: 'main', wire: { appModel: 'minimax-m3', thinking: 'adaptive' } });
      expect(resolveSessionWire('claude-sonnet-4-6', S)).toMatchObject({ role: 'main', wire: { appModel: 'minimax-m3' } });
      expect(resolveSessionWire('deepseek-v4-flash-helper', S)).toMatchObject({ role: 'helper', wire: { appModel: 'deepseek-v4-flash-helper', thinking: 'strip', protocol: 'openai-chat' } });
      // 别家的 alias 仍然不跨行：改道本会话 fast（minimax 的 helper 行），并标 collision
      expect(resolveSessionWire('claude-opus-4-7[1m]', S)).toMatchObject({ reason: 'collision', collidesWith: 'deepseek-v4-flash-vision', wire: { appModel: 'deepseek-v4-flash-helper' } });
      // SDK 内部 helper 的默认 Claude 名（不在表里）→ fallback 到同一个 fast 行
      expect(resolveSessionWire('claude-sonnet-5', S)).toMatchObject({ reason: 'fallback', role: 'helper', wire: { appModel: 'deepseek-v4-flash-helper' } });
      // 没注册的会话用共用别名发过来 = 查不到 = 502（fail-loud，探针必须带会话前缀）
      expect(resolveSessionWire('claude-sonnet-4-6[1m]', null)).toEqual({ wire: null, reason: 'none', role: 'main' });
    } finally { unregisterIngressSession(S); }
  });
  it('⛔ qwen 会话拿 gemini 行的 alias 发请求 → 不跨行，改道本会话 fast（qwen 自己），且标 collision', () => {
    registerIngressSession(SID, 'qwen3.8-27b');
    try {
      const r = resolveSessionWire('claude-opus-4-6', SID);
      expect(r.reason).toBe('collision');
      expect(r.collidesWith).toBe('gemini-3.7-flash');
      expect(r.wire.appModel).toBe('qwen3.8-27b');
      expect(r.wire.upstreamId).toBe('qwenLocal');
      // deepseek 行的 alias（kimi 退役后转给它）同理
      expect(resolveSessionWire('claude-opus-4-7', SID)).toMatchObject({ reason: 'collision', collidesWith: 'deepseek-v4-flash-vision', wire: { appModel: 'qwen3.8-27b' } });
    } finally { unregisterIngressSession(SID); }
  });
  it('qwen 会话：不在表里的 helper 名 → fast 兜底（fallback）—— haiku 名 08-26 起没主了，也走这条', () => {
    registerIngressSession(SID, 'qwen3.8-27b');
    try {
      expect(resolveSessionWire('claude-sonnet-5', SID)).toMatchObject({ reason: 'fallback', fastModel: 'qwen3.8-27b', wire: { appModel: 'qwen3.8-27b' } });
      // 08-21~08-26 之间 haiku 是 ox-alpha-helper 的独占 alias（那时这里是 collision）；Ox 下架后它退回
      // 「只是一个订阅名」——**订阅行不进 WIRE_LOOKUP**，所以全表反查查不到 → fallback。
      // ⭐ 两种 reason 的处置是同一个（改道本会话 fast，绝不跨行），差别只在日志措辞
      expect(resolveSessionWire('claude-haiku-4-5', SID)).toMatchObject({ reason: 'fallback', fastModel: 'qwen3.8-27b', wire: { appModel: 'qwen3.8-27b' } });
    } finally { unregisterIngressSession(SID); }
  });
  it('gemini 会话拿 deepseek alias → 改道 gemini 自己（反向同样封）；注销后回到全表反查', () => {
    registerIngressSession(SID, 'gemini-3.7-flash');
    try {
      expect(resolveSessionWire('claude-opus-4-7[1m]', SID)).toMatchObject({ reason: 'collision', wire: { appModel: 'gemini-3.7-flash' } });
    } finally { unregisterIngressSession(SID); }
    expect(resolveSessionWire('claude-opus-4-7[1m]', SID)).toMatchObject({ reason: 'table', wire: { appModel: 'deepseek-v4-flash-vision' } });
  });
  it('订阅模型注册 = noop（订阅会话根本不经入口）', () => {
    registerIngressSession(SID, 'claude-sonnet-5[1m]');
    expect(resolveSessionWire('claude-opus-4-6', SID)).toMatchObject({ reason: 'table', wire: { appModel: 'gemini-3.7-flash' } });
    unregisterIngressSession(SID);
  });
});
