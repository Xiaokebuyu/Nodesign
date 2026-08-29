/**
 * lib/role-target.js —— 「这句话是对哪个角色说的」（2026-08-26 建；08-29 改写）
 *
 * 08-29 之前这个文件负责**直投**：用户在角色写的那段上回话，绕开主持人直接进角色的
 * 收件箱。收件箱整族随编排收敛退役之后，去向只剩一个 —— 用户的话一律经主持人，
 * 它本来这一拍就要写场上的变化、排下一步。所以这里只剩两件事：
 *
 *   1. 认出这批标注是不是全指着同一个角色（决定浮层显示「说给谁」）
 *   2. 把这句话变成一条**说清了收件人**的主对话消息
 *
 * ⚠️ 判据用的是板上对象的 `by`（harness 盖的章），不是展示名 —— 展示名住在角色文件里，
 * 那份文件模型能写。
 */

/**
 * 这批标注是不是全指着同一个角色。
 * 混选了别人的东西就说不清是在跟谁说话 —— 那种情况当作跟主持人说。
 * @returns {{ slug: string, who: string } | null}
 */
export function soleRoleTarget(list) {
  const slugs = new Set(
    (list || []).map((t) => t.by).filter((b) => typeof b === 'string' && b.startsWith('rp-')),
  );
  if (slugs.size !== 1) return null;
  if (!list.every((t) => slugs.has(t.by))) return null;
  const slug = [...slugs][0];
  return { slug, who: list[0].byName || slug };
}

/**
 * 把「对某个角色说的话」写成给主持人的一条消息。
 *
 * 格式固定：收件人写在方括号里、原话一个字不改（主持人的规矩是照抄转交）。
 * echo 是这句话在画布上的落点 —— 有的话一并给出去，主持人转交时角色才接得上线。
 */
export function sayToRoleText({ who, slug, text, echo = null }) {
  return `【说给「${who}」（${slug}）】${text}`
    + (echo ? `\n（这句已经落在画布上：${echo}）` : '');
}

/** 把一句话交给主对话（ChatComposer 挂着唯一的监听，收起也不卸载） */
export function sendViaMainChat(text) {
  if (!text) return;
  window.dispatchEvent(new CustomEvent('nd:to-main-chat', { detail: { text } }));
}
