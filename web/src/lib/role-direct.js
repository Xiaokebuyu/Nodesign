/**
 * lib/role-direct.js —— 用户在角色写的板书上回话时，直达那个角色（2026-08-26 块 4）
 *
 * 为什么不绕主 agent：绕一圈要烧它一个回合，而且它会忍不住替角色答话/加戏。
 * 用户在某个角色写的字上回应，那句话就是说给那个角色听的。
 *
 * 服务端叫不醒子代理（SDK 没有给子代理投消息的口，`SendMessage` 是模型的工具），
 * 所以直达能不能成，取决于角色此刻在不在 `await_user` 上挂着等：
 *   waiting → 当场交到它手里
 *   queued  → 没在等，先攒着，等它下次被唤醒自己来取
 * **这两种必须分开告诉用户** —— 把积压说成送达，用户会对着没人听的板子说话。
 */

/**
 * 这批标注是不是全指着同一个常驻角色。
 * 混选了别人的东西就说不清是在跟谁说话 —— 那种情况老实走主 agent。
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

/** 直达的提示话术（两种结果分开说） */
export function deliveryToast(who, delivered) {
  return delivered === 'waiting'
    ? { text: `说给${who}了`, kind: 'success' }
    : { text: `${who}这会儿没在等回话，先攒着（它下次醒来会看到）`, kind: 'info' };
}

/**
 * 试着把这句话直达角色。返回 true = 已处理（调用方就此收手），false = 不该直达。
 *
 * 整个动作收在这里而不是留在调用点：调用点是那个 2400 行的工作台组件，
 * 而这件事有自己的判据、自己的两种结果话术、自己的失败路径 —— 它是一件事，不是三行。
 */
export async function trySayToRole({ list, projectId, text, api, showToast, onSend }) {
  const direct = soleRoleTarget(list);
  if (!direct) return false;
  onSend?.();
  try {
    const r = await api.sayToRole(projectId, direct.slug, {
      text, about: list.map((t) => t.title).join('、').slice(0, 300),
    });
    const t = deliveryToast(direct.who, r?.delivered);
    showToast(t.text, t.kind);
  } catch (err) {
    showToast(`没送到${direct.who}：${err.message}`, 'error');
  }
  return true;
}
