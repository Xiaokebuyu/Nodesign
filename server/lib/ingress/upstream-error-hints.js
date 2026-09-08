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

/** 一条上游原文里的图片张数上限（particle 是 8）。zai 曾经到 20 张都收，09-08 它在网关上没了 */
const INLINE_IMAGE_CAP = /accept at most (\d+) inline/i;

/**
 * @param {string} raw       上游回的错误正文
 * @param {object} [_wire]   这一发用的行。09-08 起没有分支要看它了（两条 GLM 行同厂商），留着是因为调用方在传，
 *                           下次真要按行分文案时不用再改调用点
 * @returns {string|null}    加了人话的完整文案；没有可翻译的就回 null（调用方原样透传）
 */
export function upstreamErrorHint(raw, _wire) {
  const text = String(raw || '');
  const cap = text.match(INLINE_IMAGE_CAP);
  if (cap) {
    const n = cap[1];
    // ⛔ 09-08 起两条 GLM 行都点死 particle，并在入口按 maxImages=8 裁图（lib/ingress/image-cap.js），
    // 所以正常情况下**撞不到这条闸**；还能撞到说明有图没被裁到（例如上游数法跟我们不一样）。
    // 原来那句「换到设计那条线」已删：那条线现在也是 particle，指过去一样挂 —— 别把人往同样的墙上引。
    const hint = `这一轮带的图超过了上游的 ${n} 张上限。少发几张、或者开一个新会话再继续。`;
    return `${hint}（上游原文：${text.slice(0, 200).replace(/\s+/g, ' ')}）`;
  }
  return null;
}
