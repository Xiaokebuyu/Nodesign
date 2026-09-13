/**
 * generate_image 的支持件（2026-09-12，从 generate-image.js 拆出：行数棘轮）：输出命名 + 批量扇出。
 */

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


/** 一次 generate_image 里并发出几张：上游是网络调用，4 张同时飞不比 1 张慢多少 */
export const IMAGE_CONCURRENCY = 4;

/**
 * 批量扇出（2026-09-12 站主：「agent 能够连续并发生图，而不是阻拦」）。
 * 一个 prompt 一张图的老路照旧；给 prompts[] 就在**一次调用里**并发出 N 张 —— 不依赖 CLI 对
 * 多个 tool_use 块的调度（MCP 写工具在 CLI 里是串行跑的），每张各自过档位/额度闸、各自
 * 当场上墙（file_changed），最后把 N 张的说明和缩略图合在一个返回里。一张失败不拖累其余。
 */
export async function fanOutImages(args, extra, one) {
  const prompts = Array.isArray(args?.prompts) ? args.prompts.map((s) => String(s || '').trim()).filter(Boolean) : [];
  if (!prompts.length) return one(args, extra);
  if (args.variationOf) {
    return { content: [{ type: 'text', text: 'generate_image failed: `prompts` (batch) cannot be combined with variationOf — one variation per call.' }], isError: true };
  }
  const { prompts: _p, outputName, ...rest } = args;
  const results = new Array(prompts.length);
  let next = 0;
  const worker = async () => {
    while (next < prompts.length) {
      const i = next++;
      const one_args = { ...rest, prompt: prompts[i], ...(outputName ? { outputName: `${outputName}-${i + 1}` } : {}) };
      try { results[i] = await one(one_args, extra); } catch (err) {
        results[i] = { content: [{ type: 'text', text: `generate_image[${i + 1}] error: ${err.message}` }], isError: true };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, prompts.length) }, worker));
  const failed = results.filter((r) => r?.isError).length;
  const content = [{
    type: 'text',
    text: `Batch: ${prompts.length} prompts, generated ${IMAGE_CONCURRENCY} at a time; ${prompts.length - failed} succeeded`
      + `${failed ? `, ${failed} failed` : ''}. Each finished image is already on the canvas.`,
  }];
  results.forEach((r, i) => {
    content.push({ type: 'text', text: `— [${i + 1}/${prompts.length}] ${prompts[i].slice(0, 80)}` });
    content.push(...(r?.content || []));
  });
  return { content, ...(failed === prompts.length ? { isError: true } : {}) };
}
