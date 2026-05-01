/**
 * Kimi K2.6 兼容性 probe（HANDOVER §7）
 *
 * 跑 4 个验证点，输出 markdown 报告到 stdout。
 * 用法：
 *   1) cp .env.example .env，填入 KIMI_API_KEY
 *   2) npm install
 *   3) npm run probe:kimi  ［或 node --env-file=.env server/_probe-kimi.js］
 *
 * 这 4 个点的实测结果决定阶段 1 怎么实现 engine：
 *   T1 基础流式调用              — 不通则 SDK 兼容层有问题，需要换路径
 *   T2 Tool use 流式             — 不通则 agent loop 跑不起来
 *   T3 cache_control 是否生效    — 不通则每轮重传 SKILL.md ~15K tokens 成本翻倍
 *   T4 interleaved-thinking beta — 不通需要查 Kimi reasoning 参数（可能不是同名 header）
 */

import Anthropic from '@anthropic-ai/sdk';

// ── 配置 ──
// 优先 KIMI_*（直连 Moonshot），fallback NODESIGN_GATEWAY_*（tokendance gateway，
// 同样转 Kimi 后端但走团队代理 + 计费）。
const apiKey = process.env.KIMI_API_KEY || process.env.NODESIGN_GATEWAY_KEY;
const baseURL = process.env.KIMI_BASE_URL
  || process.env.NODESIGN_GATEWAY_URL
  || 'https://api.moonshot.ai/anthropic';
const model = process.env.KIMI_MODEL || process.env.NODESIGN_MODEL || 'kimi-k2.6';

if (!apiKey) {
  console.error('❌ 没找到 API key');
  console.error('   设 KIMI_API_KEY 或 NODESIGN_GATEWAY_KEY 后再跑');
  process.exit(1);
}

const client = new Anthropic({
  apiKey,
  baseURL,
  maxRetries: 1,        // probe 阶段不要静默重试，方便观察首次行为
  timeout: 120_000,
});

console.log(`# Kimi K2.6 Probe Report\n`);
console.log(`- baseURL: \`${baseURL}\``);
console.log(`- model: \`${model}\``);
console.log(`- 时间: ${new Date().toISOString()}\n`);

const results = {};

// ── T1: 基础流式调用 ──
async function t1_basicStreaming() {
  console.log('## T1 基础流式调用\n');
  const stream = client.messages.stream({
    model,
    max_tokens: 200,
    messages: [{ role: 'user', content: '用一句话介绍北京。' }],
  });

  let chunkCount = 0;
  let collected = '';
  stream.on('text', (delta) => {
    chunkCount++;
    collected += delta;
  });

  const final = await stream.finalMessage();
  const ok = chunkCount > 0 && collected.length > 0;
  console.log(`- 流式 text 块数: **${chunkCount}**`);
  console.log(`- 累计字符: ${collected.length}`);
  console.log(`- stop_reason: \`${final.stop_reason}\``);
  console.log(`- usage: in=${final.usage?.input_tokens}, out=${final.usage?.output_tokens}`);
  console.log(`- 输出预览: ${collected.slice(0, 80)}...`);
  console.log(`- 结论: ${ok ? '✅ 通过' : '❌ 流式没有 text delta'}\n`);
  results.t1 = ok;
}

// ── T2: Tool use 流式 ──
async function t2_toolUse() {
  console.log('## T2 Tool use 流式\n');
  const tools = [{
    name: 'add',
    description: '计算两个整数相加',
    input_schema: {
      type: 'object',
      properties: { a: { type: 'integer' }, b: { type: 'integer' } },
      required: ['a', 'b'],
    },
  }];

  // 第一轮：让模型调工具
  const r1 = await client.messages.stream({
    model,
    max_tokens: 500,
    tools,
    messages: [{ role: 'user', content: '请用 add 工具算 17 + 25 是多少。' }],
  }).finalMessage();

  const toolUse = r1.content.find(b => b.type === 'tool_use');
  console.log(`- round 1 stop_reason: \`${r1.stop_reason}\``);
  console.log(`- round 1 blocks: [${r1.content.map(b => b.type).join(',')}]`);

  if (!toolUse) {
    console.log(`- 结论: ❌ 模型未发起 tool_use（content: ${JSON.stringify(r1.content).slice(0, 200)}）\n`);
    results.t2 = false;
    return;
  }
  console.log(`- tool_use: name=\`${toolUse.name}\` input=${JSON.stringify(toolUse.input)} id=\`${toolUse.id}\``);

  // 第二轮：把工具结果回灌给模型
  const r2 = await client.messages.stream({
    model,
    max_tokens: 500,
    tools,
    messages: [
      { role: 'user', content: '请用 add 工具算 17 + 25 是多少。' },
      { role: 'assistant', content: r1.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: '42' }] },
    ],
  }).finalMessage();

  const finalText = r2.content.filter(b => b.type === 'text').map(b => b.text).join('');
  console.log(`- round 2 stop_reason: \`${r2.stop_reason}\``);
  console.log(`- round 2 输出: ${finalText.slice(0, 200)}`);
  const ok = finalText.includes('42');
  console.log(`- 结论: ${ok ? '✅ 通过（模型识别并消费了 tool_result）' : '⚠️ 工具调用通了但回填后输出不含答案'}\n`);
  results.t2 = ok;
}

// ── T3: cache_control 是否生效 ──
async function t3_cacheControl() {
  console.log('## T3 cache_control: ephemeral 是否生效\n');

  // 凑一个 >1024 tokens 的长 system prompt（Anthropic 缓存最小写入门槛）
  const longBoilerplate = ('你是一个资深演示稿设计师。以下是你必须遵守的规范：\n' +
    '1. 颜色对比度满足 WCAG AA。2. 字体不超过两种。3. 不使用 emoji。4. 中文用思源黑体。'
    .repeat(40));
  const systemBlocks = [
    { type: 'text', text: longBoilerplate, cache_control: { type: 'ephemeral' } },
  ];
  const userMsg = [{ role: 'user', content: '简短自我介绍。' }];

  const r1 = await client.messages.create({
    model,
    max_tokens: 100,
    system: systemBlocks,
    messages: userMsg,
  });
  console.log(`- 第一次 usage: in=${r1.usage?.input_tokens}, ` +
              `cacheW=${r1.usage?.cache_creation_input_tokens || 0}, ` +
              `cacheR=${r1.usage?.cache_read_input_tokens || 0}`);

  // 第二次：完全相同的 system，期望 cacheR > 0
  const r2 = await client.messages.create({
    model,
    max_tokens: 100,
    system: systemBlocks,
    messages: userMsg,
  });
  const cacheR = r2.usage?.cache_read_input_tokens || 0;
  const cacheW = r2.usage?.cache_creation_input_tokens || 0;
  console.log(`- 第二次 usage: in=${r2.usage?.input_tokens}, cacheW=${cacheW}, cacheR=${cacheR}`);

  let conclusion;
  if (cacheR > 0) {
    conclusion = '✅ cache_control 生效（第二次命中缓存）';
    results.t3 = true;
  } else if (cacheW > 0) {
    conclusion = '⚠️ 第二次仍写入缓存而非命中——可能 cache key 计算方式不同 / TTL 极短';
    results.t3 = false;
  } else {
    conclusion = '❌ cache_creation/cache_read 字段全为 0，可能 Kimi 兼容端点未实现 cache_control';
    results.t3 = false;
  }
  console.log(`- 结论: ${conclusion}\n`);
}

// ── T4: interleaved-thinking-2025-05-14 beta header ──
async function t4_interleavedThinking() {
  console.log('## T4 interleaved-thinking beta header\n');

  // 试 Anthropic 标准用法：thinking + interleaved beta header
  const headers = { 'anthropic-beta': 'interleaved-thinking-2025-05-14' };
  try {
    const stream = client.messages.stream(
      {
        model,
        max_tokens: 1500,
        thinking: { type: 'enabled', budget_tokens: 1024 },
        messages: [{ role: 'user', content: '请思考后回答：为什么天空是蓝色的？' }],
      },
      { headers }
    );

    let thinkingChunks = 0;
    let textChunks = 0;
    stream.on('streamEvent', (evt) => {
      if (evt.type === 'content_block_delta') {
        if (evt.delta?.type === 'thinking_delta') thinkingChunks++;
        if (evt.delta?.type === 'text_delta') textChunks++;
      }
    });

    const final = await stream.finalMessage();
    const blockTypes = final.content.map(b => b.type).join(',');
    console.log(`- 请求 header: \`anthropic-beta: interleaved-thinking-2025-05-14\``);
    console.log(`- thinking_delta 块数: **${thinkingChunks}**`);
    console.log(`- text_delta 块数: ${textChunks}`);
    console.log(`- final.content blocks: [${blockTypes}]`);
    console.log(`- stop_reason: \`${final.stop_reason}\``);

    if (thinkingChunks > 0 && blockTypes.includes('thinking')) {
      console.log(`- 结论: ✅ Kimi 接受同名 beta header 且产出 thinking blocks\n`);
      results.t4 = true;
    } else if (blockTypes.includes('thinking')) {
      console.log(`- 结论: ⚠️ thinking blocks 出现但流式没有 thinking_delta（可能只是非流式）\n`);
      results.t4 = 'partial';
    } else {
      console.log(`- 结论: ❌ 未产出 thinking block——header 可能被静默忽略，需查 Kimi reasoning 参数\n`);
      results.t4 = false;
    }
  } catch (err) {
    console.log(`- 错误: \`${err.message}\``);
    console.log(`- 结论: ❌ 报错——记录错误信息后查 Kimi 文档对应参数\n`);
    results.t4 = false;
  }
}

// ── 跑全部 ──
async function main() {
  const tests = [
    ['T1', t1_basicStreaming],
    ['T2', t2_toolUse],
    ['T3', t3_cacheControl],
    ['T4', t4_interleavedThinking],
  ];

  for (const [name, fn] of tests) {
    try {
      await fn();
    } catch (err) {
      console.log(`### ${name} 抛异常\n`);
      console.log(`\`\`\`\n${err.stack || err.message}\n\`\`\`\n`);
      results[name.toLowerCase()] = false;
    }
  }

  console.log('## 汇总\n');
  console.log('| 测试 | 结果 |');
  console.log('|---|---|');
  console.log(`| T1 基础流式 | ${results.t1 ? '✅' : '❌'} |`);
  console.log(`| T2 Tool use | ${results.t2 ? '✅' : '❌'} |`);
  console.log(`| T3 cache_control | ${results.t3 ? '✅' : '❌'} |`);
  console.log(`| T4 interleaved-thinking | ${results.t4 === true ? '✅' : results.t4 === 'partial' ? '⚠️' : '❌'} |`);
  console.log('\n下一步：把这份报告贴到 server/shared/README.md 的"待验证"章节，决定阶段 1 实现细节。');
}

main().catch(err => {
  console.error('\n❌ Probe 异常退出:', err);
  process.exit(1);
});
