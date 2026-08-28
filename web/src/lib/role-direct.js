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

/** 直达的提示话术（两种结果分开说；echoed = 这句也以用户署名落成了板书） */
export function deliveryToast(who, delivered, echoed = false) {
  const trace = echoed ? '，这句也落在板上了' : '';
  return delivered === 'waiting'
    ? { text: `说给${who}了${trace}`, kind: 'success' }
    : { text: `${who}这会儿没在等回话，先攒着（它下次醒来会看到）${trace}`, kind: 'info' };
}

/**
 * 托主持人召回一个散场的角色（2026-08-28 自动召回）。
 *
 * 服务端叫不醒散场的子代理（进程里已经没有它在跑的回合），唯一的召回通道是
 * 主 agent 的 SendMessage —— 所以这里替玩家给主对话发一句场务请托，GM 收到就召。
 * 走 window 事件是为了不做三层 prop 钻孔（RoleTalkPanel 住在画布世界层深处）；
 * ProjectWorkspace 挂着唯一的监听，转成一次 handleSend。
 *
 * 去抖：同一个角色 90 秒内只托一次 —— 玩家连发三句话不该把 GM 叫醒三回，
 * 但召回失手时也别让玩家干等五分钟（08-28 用户拍板：自动唤醒，过程尽量无扰）。
 */
const nudgedAt = new Map();   // slug → ts
const NUDGE_COOLDOWN_MS = 90 * 1000;
export function nudgeGmRecall(slug, who) {
  const last = nudgedAt.get(slug) || 0;
  if (Date.now() - last < NUDGE_COOLDOWN_MS) return false;
  nudgedAt.set(slug, Date.now());
  window.dispatchEvent(new CustomEvent('nd:gm-nudge', {
    detail: { slug, text: `【场务】「${who || slug}」已散场，我有话给TA（已进TA的收件箱）——`
      + `用 SendMessage({to: "${slug}"}) 把TA召回，让TA先 check_inbox。**静默处理**：`
      + `不上板、不写旁白、不用回我，召回完这个回合就收。` },
  }));
  return true;
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
    // 落痕（2026-08-27）：从画布说的话就该在画布留痕（回复跟着入口走的对偶）。
    // anchor 优先挑板书目标 —— 服务端会 reply_to 它把线程接上；不是板书就 annotates。
    const anchor = (list.find((t) => typeof t.id === 'string' && t.id.startsWith('notes/板书/')) || list[0])?.id || null;
    const r = await api.sayToRole(projectId, direct.slug, {
      text, about: list.map((t) => t.title).join('、').slice(0, 300),
      keep: true, ...(anchor ? { anchor } : {}),
    });
    // GM 中介路由（08-28）：rounds/directed 里公开发言不直达 —— 服务端只落痕，
    // 这里返回 false 让调用方走主对话那条现成的路，把话递给主持人去编排。
    if (r?.routed === 'gm') {
      showToast(`这一场由主持人调度——话转给主持人了`, 'info');
      return false;
    }
    const t = deliveryToast(direct.who, r?.delivered, !!r?.echo);
    showToast(t.text, t.kind);
    // 自动召回（08-28）：角色真散场了（不是忙着写），托主持人用 SendMessage 去叫
    if (r?.asleep && nudgeGmRecall(direct.slug, direct.who)) {
      showToast(`${direct.who}已散场——已托主持人去召回`, 'info');
    }
  } catch (err) {
    showToast(`没送到${direct.who}：${err.message}`, 'error');
  }
  return true;
}
