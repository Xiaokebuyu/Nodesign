/**
 * lib/ingress/image-cap.js —— 按行裁图：一次 prompt 最多带 N 张图，多出来的**最早的**换成占位文字。
 *
 * 为什么要有机制而不是翻译报错（09-07 站主在桌面版撞的）：Zen 上的 DeepSeek V4 Flash Vision 一次 prompt
 * 最多 4 张图，而会话里的截图是累积的 —— 过了 4 张之后**每一发都 400**，会话等于死了，换线也救不回历史。
 * GLM 演出线那条 8 张的闸做的是人话翻译（upstream-error-hints.js），因为它有一条同价的无限张线可换；
 * 这条没有替代线，只能裁。
 *
 * 裁谁：按出现顺序数全部 image 块（user 顶层的和 tool_result 里的），保留最后 N 张，前面的换成一段文字
 * 让模型知道那里曾经有图、为什么没了。裁掉的是最早的：最近的截图才是它正在看的东西。
 * 走在 transformForUpstream 的最后（liftImages / 下采样之后），两条腿（Anthropic 透传 / openai-chat）都吃得到。
 */

export function omittedImageText(max) {
  return `[图片已省略：这条模型线一次最多带 ${max} 张图，只保留了最近的 ${max} 张]`;
}

/**
 * @param {object[]} messages  Anthropic Messages 的 messages（原地改）
 * @param {number} max         上限；<=0 或非数 = 不裁
 * @returns {number} 裁掉了几张
 */
export function capImages(messages, max) {
  const n = Number(max);
  if (!Array.isArray(messages) || !Number.isFinite(n) || n <= 0) return 0;
  // 先数：每个 image 块记 (容器数组, 下标)
  const slots = [];
  for (const msg of messages) {
    if (!Array.isArray(msg?.content)) continue;
    msg.content.forEach((block, i) => {
      if (block?.type === 'image') slots.push({ arr: msg.content, i });
      else if (block?.type === 'tool_result' && Array.isArray(block.content)) {
        block.content.forEach((inner, j) => { if (inner?.type === 'image') slots.push({ arr: block.content, i: j }); });
      }
    });
  }
  const over = slots.length - n;
  if (over <= 0) return 0;
  const text = omittedImageText(n);
  for (const { arr, i } of slots.slice(0, over)) arr[i] = { type: 'text', text };
  return over;
}
