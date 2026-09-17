/**
 * helpers/image-facts.js — 出图之后量真尺寸（2026-09-14）
 *
 * 问题库 09-13：aspectRatio:"21:9" 两次拿回 1672×941（16:9），返回文字却照抄请求写「21:9」，agent 自己拿 PIL 量才发现。
 * 比例只是转给后端的指令（codex 那条路写在 prompt 里），拿到什么要量出来说实话；透明同理（gpt-image-2 其实给得出 alpha）。
 */
import sharp from 'sharp';

const RATIO_TOLERANCE = 0.06;

/**
 * @param {Buffer} buf
 * @param {string} requested  请求的比例，如 '21:9'
 * @returns {Promise<string|null>} 如 `1672×941 ≈1.78:1 ⚠️ 请求的 21:9（2.33:1）没拿到` / 带「含透明像素」；量不出来返回 null
 */
export async function describeImageFacts(buf, requested) {
  try {
    const meta = await sharp(buf).metadata();
    const w = meta.width || 0; const h = meta.height || 0;
    if (!w || !h) return null;
    const parts = [`${w}×${h} ≈${(w / h).toFixed(2)}:1`];
    const m = /^(\d+):(\d+)$/.exec(String(requested || ''));
    if (m) {
      const want = Number(m[1]) / Number(m[2]);
      if (Math.abs((w / h) / want - 1) > RATIO_TOLERANCE) {
        parts.push(`⚠️ 请求的 ${requested}（${want.toFixed(2)}:1）没拿到 —— 要超宽/超长就拿这张走 variationOf 扩画布，或在页面里裁`);
      }
    }
    if (meta.hasAlpha) {
      const stats = await sharp(buf).stats();
      if ((stats.channels[3]?.min ?? 255) < 255) parts.push('含透明像素（RGBA）');
    }
    return parts.join('，');
  } catch {
    return null;
  }
}
