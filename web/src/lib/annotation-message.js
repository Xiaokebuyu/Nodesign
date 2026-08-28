/**
 * lib/annotation-message.js —— 把「画布标注」那条消息拆成「机械描述」和「用户的话」
 *
 * 用户在板上圈一段字回话时，前端拼的是一整条：
 *
 *   【画布标注】板书「20260828-192124-第一章-放学后.md」（notes/板书/…md），agent 写的，
 *   原文「# 第一章 · 放学后 八月的尾巴还挂在下午五点半的天上。…」；
 *   回应请 write_on_board reply_to=notes/板书/…md：按下怀表
 *
 * 这一整条**必须原样发给 agent**（它要靠里面的路径接线程、靠摘录知道那段字说了什么）。
 * 但侧边栏把它原样显示出来，用户自己那句「按下怀表」淹在一堆机械里 —— 用户报的就是这个。
 * 所以拆在**渲染层**：发出去的内容一个字不动，只是显示时把机械那半折起来。
 *
 * ## 分隔符怎么找（这是全文件唯一有难度的地方）
 *
 * 格式是 `<描述>：<用户的话>`，但全角冒号在两边都可能出现 ——
 * 摘录里有（正文随便什么字），用户的话里也有。
 *
 * 判据：**第一个不在「」里的全角冒号**。因为标题和摘录都裹在「」里，
 * 它们内部的冒号一律在「」深度 ≥1；而描述剩下的部分（`（路径）`、`，agent 写的`、
 * `；回应请 write_on_board reply_to=<路径>`）都不含冒号。
 * 找不到就返回 null —— **别猜**，原样显示总比把用户的话切掉半句强。
 */

const PREFIX = '【画布标注】';

/** 按「」深度扫一遍，回调每个深度为 0 的字符 */
function scanTopLevel(s, onChar) {
  let depth = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '「') depth += 1;
    else if (ch === '」') depth = Math.max(0, depth - 1);
    else if (depth === 0 && onChar(ch, i)) return i;
  }
  return -1;
}

/**
 * @returns {{ desc: string, text: string } | null} null = 不是标注消息，或者格式不认得
 */
export function parseAnnotationMessage(raw) {
  const s = typeof raw === 'string' ? raw : '';
  if (!s.startsWith(PREFIX)) return null;
  const body = s.slice(PREFIX.length);
  const at = scanTopLevel(body, (ch) => ch === '：');
  if (at < 0) return null;
  return { desc: body.slice(0, at), text: body.slice(at + 1) };
}

/** 多个目标用「、」连；同样只认深度 0 的那些（摘录里的顿号不算） */
function splitTargets(desc) {
  const out = [];
  let last = 0;
  let depth = 0;
  for (let i = 0; i < desc.length; i += 1) {
    const ch = desc[i];
    if (ch === '「') depth += 1;
    else if (ch === '」') depth = Math.max(0, depth - 1);
    else if (ch === '、' && depth === 0) { out.push(desc.slice(last, i)); last = i + 1; }
  }
  out.push(desc.slice(last));
  return out.filter(Boolean);
}

/** 板书文件名去掉时间戳前缀和扩展名：`20260828-192124-第一章-放学后.md` → `第一章-放学后` */
function prettyTitle(t) {
  return t.replace(/^\d{8}-\d{6}-/, '').replace(/\.md$/i, '');
}

/**
 * 折起来之后那行小字要写什么。
 * @returns {string[]} 形如 ['板书「第一章-放学后」']；认不出就空数组（调用方回落到通用措辞）
 */
export function annotationTargets(desc) {
  return splitTargets(String(desc || ''))
    .map((piece) => {
      const m = /^([^（，；]*)「([^」]*)」/.exec(piece);
      return m ? `${m[1]}「${prettyTitle(m[2])}」` : null;
    })
    .filter(Boolean);
}
