/**
 * generate_image 的支持件（2026-09-12，从 generate-image.js 拆出：行数棘轮）：输出命名 + 批量扇出 + 会话出图池。
 */
import { makeSlotPool } from '../../../lib/slot-pool.js';

function safeBaseName(s) {
  return String(s || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** 同一毫秒里第几个名字（进程内单调）。只在没给 outputName 时参与 */
let nameSeq = 0;

export function buildOutputName(outputName, assetRole) {
  if (outputName) {
    const safe = safeBaseName(outputName);
    if (safe) return safe;
  }
  // ⛔ 09-13 查实：批量（prompts[]）不给 outputName 时，4 个并发请求在同一个 tick 里算名字（generateOne 在第一个 await
  // 之前就定名），`gen-<毫秒>-<用途>` 撞车 —— 复现 4 张只出 2 个不同的名字，后写的覆盖先写的，画布上少图。
  // 加一段进程内递增序号：同一毫秒也不会重名；老名字形状（gen-<毫秒>-…）不变，按前缀找图的地方照旧认得
  const ts = Date.now();
  const role = safeBaseName(assetRole || 'image');
  nameSeq = (nameSeq + 1) % 1_000_000;
  return `gen-${ts}-${nameSeq}-${role}`;
}


/** 一个会话同时出几张：上游是网络调用，4 张同时飞不比 1 张慢多少 */
export const IMAGE_CONCURRENCY = 4;

/**
 * 会话出图池（2026-09-13）。generate_image 登记成可并行（tool-concurrency.js）之后，同一条消息里的几次调用会
 * 同时跑，每次调用又可能是一批 prompts[]。上限要按会话算，不能按调用算：不然 3 个批量调用就是 12 张同时飞，
 * 额度闸（每张各自过）也会被同时穿透。池子在 makeGenerateImageTool 里每个 MCP server 实例（= 每个会话）建一个。
 * 不做进程级：托管版多个用户各自出图互不排队，那是以前就有的行为。
 */
export function makeImagePool() { return makeSlotPool(IMAGE_CONCURRENCY); }

/**
 * 批量扇出（2026-09-12 站主：「agent 能够连续并发生图，而不是阻拦」）。
 * 一个 prompt 一张图的老路照旧；给 prompts[] 就在**一次调用里**并发出 N 张 —— 不依赖 CLI 对
 * 多个 tool_use 块的调度（MCP 写工具在 CLI 里是串行跑的），每张各自过档位/额度闸、各自
 * 当场上墙（file_changed），最后把 N 张的说明和缩略图合在一个返回里。一张失败不拖累其余。
 * 09-13 起单张和批量都从会话出图池拿槽位：同一条消息里并行的几次调用加起来也不超过 IMAGE_CONCURRENCY。
 *
 * @param {ReturnType<typeof makeImagePool>} [pool]  会话出图池；不给（单测）就本次调用自建一个
 */
export async function fanOutImages(args, extra, one, pool = makeImagePool()) {
  const prompts = Array.isArray(args?.prompts) ? args.prompts.map((s) => String(s || '').trim()).filter(Boolean) : [];
  if (!prompts.length) return pool.run(() => one(args, extra));
  if (args.variationOf) {
    return { content: [{ type: 'text', text: 'generate_image failed: `prompts` (batch) cannot be combined with variationOf — one variation per call.' }], isError: true };
  }
  const { prompts: _p, outputName, ...rest } = args;
  // 排队顺序 = prompts 顺序（池子先来先服务），跟以前 worker 按下标取的顺序一致
  const results = await Promise.all(prompts.map((p, i) => pool.run(async () => {
    const one_args = { ...rest, prompt: p, ...(outputName ? { outputName: `${outputName}-${i + 1}` } : {}) };
    try { return await one(one_args, extra); } catch (err) {
      return { content: [{ type: 'text', text: `generate_image[${i + 1}] error: ${err.message}` }], isError: true };
    }
  })));
  const failed = results.filter((r) => r?.isError).length;
  const content = [{
    type: 'text',
    text: `Batch: ${prompts.length} prompts, generated up to ${IMAGE_CONCURRENCY} at a time; ${prompts.length - failed} succeeded`
      + `${failed ? `, ${failed} failed` : ''}. Each finished image is already on the canvas.`,
  }];
  results.forEach((r, i) => {
    content.push({ type: 'text', text: `— [${i + 1}/${prompts.length}] ${prompts[i].slice(0, 80)}` });
    content.push(...(r?.content || []));
  });
  return { content, ...(failed === prompts.length ? { isError: true } : {}) };
}
