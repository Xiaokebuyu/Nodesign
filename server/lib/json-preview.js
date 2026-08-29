/**
 * server/lib/json-preview.js —— json 文件卡的结构预览（2026-08-29 占位契约刀 B）
 *
 * 站主点名「给 json 一个预览器和显示器」。原来 json 跟 txt/csv 走同一条路：
 * 截前 1KB 原样塞进等宽 <pre>，于是卡面上是半行 `{"name":"…` 就没了 —— 既看不出
 * 结构，也**没法在前端画折叠树**（截断的 json parse 不动）。
 *
 * 这里做的是"裁剪"不是"截断"：按深度/数组长度/字符串长度各自设限，产出的仍然是
 * **合法 json**，前端 JSON.parse 得动就能画可折叠的键值树。被裁掉的地方留一句人话
 * （`… +42 more`），不假装内容到此为止 —— 跟卡的折叠角标同一条纪律：
 * 省略要看得见。
 */

const MAX_DEPTH = 4;
const MAX_ITEMS = 12;      // 数组/对象每层最多留几项
const MAX_STR = 120;       // 单个字符串值
const MAX_OUT = 4096;      // 产出上限，超了降一档深度重来

/** 折叠标记：值是以这个开头的字符串 = 这里被裁过（前端据此画成灰色省略号） */
export const ELLIPSIS = '…';

function shrink(v, depth, maxDepth) {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > MAX_STR ? `${v.slice(0, MAX_STR)}${ELLIPSIS}` : v;
  if (Array.isArray(v)) {
    if (depth >= maxDepth) return [`${ELLIPSIS} ${v.length} items`];
    const out = v.slice(0, MAX_ITEMS).map(x => shrink(x, depth + 1, maxDepth));
    if (v.length > MAX_ITEMS) out.push(`${ELLIPSIS} +${v.length - MAX_ITEMS} more`);
    return out;
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (depth >= maxDepth) return { [ELLIPSIS]: `${keys.length} keys` };
    const out = {};
    for (const k of keys.slice(0, MAX_ITEMS)) out[k] = shrink(v[k], depth + 1, maxDepth);
    if (keys.length > MAX_ITEMS) out[ELLIPSIS] = `+${keys.length - MAX_ITEMS} more keys`;
    return out;
  }
  return String(v);
}

/**
 * @param {string} raw  文件原文
 * @returns {string|null}  裁剪后的合法 json 文本；不是合法 json 时返回 null（调用方退回原样预览）
 */
export function jsonPreview(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;    // 不是合法 json（或本来就是片段）：退回等宽原样，别假装看得懂
  }
  for (let d = MAX_DEPTH; d >= 1; d -= 1) {
    const text = JSON.stringify(shrink(data, 0, d), null, 2);
    if (text.length <= MAX_OUT || d === 1) return text.slice(0, MAX_OUT);
  }
  return null;
}
