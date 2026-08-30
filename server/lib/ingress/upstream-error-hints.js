/**
 * 上游 4xx 的人话翻译（08-30 建）。
 *
 * 为什么需要：上游的错是**给开发者看的英文**，可它会原样穿过 SDK 落到用户的聊天框里。
 * 用户看到的是「API Error: 400 GLM requests accept at most 8 inline PNG, JPEG, WEBP…」——
 * 这句话没有一个字告诉他该怎么办，而这里恰好有个一句话就能给出的出路（换一条线）。
 *
 * ⭐ 只翻译**用户自己能处理**的那几条。上游挂了、限流、鉴权坏了这些他做不了什么，
 *   翻译过去只是把英文换成中文，没有增益，反而把原文这个排查线索藏了 —— 所以不收。
 * ⚠️ 原文一律保留在括号里：翻译是加一句，不是换一句。看日志和看聊天框的是同一个人。
 */

/** 一条上游原文里的图片张数上限（particle 是 8）。这条闸只有 particle 有，zai 到 20 张都收 */
const INLINE_IMAGE_CAP = /accept at most (\d+) inline/i;

/**
 * @param {string} raw       上游回的错误正文
 * @param {object} [wire]    这一发用的行（要 bodyExtra.vendors 判是不是"只走 particle"那条）
 * @returns {string|null}    加了人话的完整文案；没有可翻译的就回 null（调用方原样透传）
 */
export function upstreamErrorHint(raw, wire) {
  const text = String(raw || '');
  const cap = text.match(INLINE_IMAGE_CAP);
  if (cap) {
    const n = cap[1];
    // 只有"演出"那条线（点死 particle）才该建议换线；默认那条线不该撞到这条闸，
    // 真撞到了说明是别的原因，别把人往一条同样会挂的线上引。
    const onlyParticle = Array.isArray(wire?.bodyExtra?.vendors)
      && wire.bodyExtra.vendors.length === 1 && wire.bodyExtra.vendors[0] === 'particle';
    const hint = onlyParticle
      ? `「演出」这条线整场最多带 ${n} 张图，这一轮超了。在模型菜单里换成「GLM-5.3-Flash · 设计」就没有这个限制 —— 同一个模型、同样的价钱，只是每一步稍慢一点。`
      : `这一轮带的图超过了上游的 ${n} 张上限。少发几张、或者开一个新会话再继续。`;
    return `${hint}（上游原文：${text.slice(0, 200).replace(/\s+/g, ' ')}）`;
  }
  return null;
}
