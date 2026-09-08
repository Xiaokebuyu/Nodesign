/**
 * mcp/image-diet.js —— 工具回给模型的图，统一减重（2026-09-08 深夜站主定）
 *
 * ## 为什么
 *
 * 桌面 DSv4.1 会话「首字节 23s」案：每一轮把整个上下文重新上传，请求体 3.9～4.1 MB，其中几乎全是图 ——
 * web_search include_images 把下载的原图（单张上限 5MB）原样 base64 进工具结果，look_at_board / 截图系 PNG
 * 一张几百 KB。模型按约 1568 token 算一张图，**线上按字节走**：token 数看不出上下文有多重。
 * 用户走代理时上行 65KB/s，4MB 就是一分钟；直连也是白白的流量和 CF/nginx/node 负担。
 *
 * ## 甜点：长边 1280、JPEG q80
 *
 * Anthropic 长边 1568 封顶、超了自己缩；OpenAI 按 512 方块切；Claude Code 自己把 >2000 的缩掉。1280 低于
 * 1568 所以 API 不再采样，约 0.9MP ≈ 1200 token；JPEG q80 一张 100～200KB。截图里的小字在 1280 与 1366
 * 之间肉眼无差。透明图铺白（视觉模型本来不看 alpha；ingress 送上游前也是这么铺的）。
 *
 * ## 只动回模型的那份
 *
 * 原图照旧落盘（参考图目录 / assets），下游要全分辨率（generate_image 的 referenceImages、发布）读的是文件，
 * 不是上下文里那份。这里是 mcp/index.js 出口的第三层包装（能力闸 / 参数消毒 / 图片减重），13 个回图工具一处收，
 * 别在工具里各写各的。
 */
import { recordIssue } from '../../lib/issues-store.js';

export const DIET_MAX_EDGE = Number(process.env.NODESIGN_IMAGE_DIET_EDGE) || 1280;
export const DIET_QUALITY = Number(process.env.NODESIGN_IMAGE_DIET_QUALITY) || 80;
/** 已经是 JPEG 且不超过这个体积、长边也不超的，原样放行（别为了省 10KB 再解码一遍） */
const PASS_BYTES = 160 * 1024;
const REENCODE = /^image\/(png|jpe?g|webp|gif|avif|tiff|bmp)$/i;

/**
 * 一块 image content block → 减重后的块；不需要动 / 动不了 → 原块。
 * @param {{type:'image', data:string, mimeType:string}} block
 */
export async function dietImageBlock(block) {
  const mime = String(block?.mimeType || '').toLowerCase();
  if (block?.type !== 'image' || typeof block.data !== 'string' || !REENCODE.test(mime)) return block;
  let sharp;
  try { ({ default: sharp } = await import('sharp')); } catch { return block; }
  try {
    const buf = Buffer.from(block.data, 'base64');
    const meta = await sharp(buf).metadata();
    const edge = Math.max(meta.width || 0, meta.height || 0);
    const isJpeg = /jpe?g/.test(mime);
    if (isJpeg && buf.length <= PASS_BYTES && edge <= DIET_MAX_EDGE) return block;
    let p = sharp(buf, { animated: false });
    if (edge > DIET_MAX_EDGE) p = p.resize({ width: meta.width >= meta.height ? DIET_MAX_EDGE : null, height: meta.height > meta.width ? DIET_MAX_EDGE : null, fit: 'inside', withoutEnlargement: true });
    if (meta.hasAlpha) p = p.flatten({ background: '#ffffff' });
    const out = await p.jpeg({ quality: DIET_QUALITY, mozjpeg: true }).toBuffer();
    // 重编码反而更大（极小的 PNG 图标之类）→ 留原样
    if (out.length >= buf.length) return block;
    return { ...block, data: out.toString('base64'), mimeType: 'image/jpeg' };
  } catch {
    return block;
  }
}

/**
 * 包一个工具定义：handler 返回的 content 里每个 image block 过一遍 dietImageBlock。
 * 失败不挡工具（原块放行）；一次调用减掉的字节数只在 >1MB 时记一条 auto 问题（signature 按工具），
 * 让「谁在往上下文里塞大图」有账可查而不刷屏。
 */
export function withImageDiet(toolDef, deps = {}) {
  const inner = toolDef.handler;
  if (typeof inner !== 'function') return toolDef;
  toolDef.handler = async (args, extra) => {
    const result = await inner(args, extra);
    const content = result?.content;
    if (!Array.isArray(content) || !content.some((b) => b?.type === 'image')) return result;
    let before = 0; let after = 0;
    const next = await Promise.all(content.map(async (b) => {
      if (b?.type !== 'image' || typeof b.data !== 'string') return b;
      const d = await dietImageBlock(b);
      before += b.data.length; after += d.data.length;
      return d;
    }));
    if (before - after > 1024 * 1024) {
      try {
        recordIssue({
          source: 'auto', toolName: toolDef.name,
          summary: `${toolDef.name} 一次回了 ${(before / 1048576).toFixed(1)}MB 图（减重后 ${(after / 1048576).toFixed(1)}MB）`,
          detail: '图片减重层（mcp/image-diet.js）在出口压过了；原图落盘不受影响。这条只是记「谁在塞大图」。',
          projectId: deps.projectId, sessionId: deps.sessionId, signature: `image-diet|${toolDef.name}`,
        });
      } catch { /* 记账失败不挡工具 */ }
    }
    return { ...result, content: next };
  };
  return toolDef;
}
