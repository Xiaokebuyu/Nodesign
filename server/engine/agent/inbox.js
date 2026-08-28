/**
 * engine/agent/inbox.js —— 常驻角色的收件箱（2026-08-26，块 4）
 *
 * ## 它解决的问题
 *
 * 用户在画布上回角色的话，这句话得**直达那个角色**，不惊动主 agent。
 * 但 SDK 没给这条路：`query()` 的输入流只喂主 agent，`Query` 上没有任何
 * 「给某个子代理投消息」的方法；子代理唯一的入口是 `SendMessage`，而那是**工具**，
 * 只有模型能调，服务端调不了（2026-08-26 通盘查过 SDK 接口）。
 *
 * 所以这条路得我们自己铺：服务端一个队列 + 一件角色能调的 MCP 工具。
 * 角色主动来取，而不是我们推给它 —— 方向反过来，就绕开了「服务端没法唤醒子代理」。
 *
 * ## 两种取法，对应两种在场状态
 *
 * - **挂着等**（`await_user`）：角色写完一段就来等下一句。它的回合一直没结束，
 *   用户一说话就立刻 resolve —— 这是「像主 agent 一样对话」的真形态，主 agent 零参与。
 * - **顺手看**（`check_inbox`）：非阻塞。角色被别的方式唤醒时（主 agent 寄信、
 *   或它自己干完一件事）顺手看一眼有没有积压。
 *
 * ## 没人在等的时候
 *
 * 消息进队列。这时**服务端叫不醒它**（上面那条限制），得等它下次被唤醒时自己来取。
 * 这是设计内的降级，不是 bug —— 但用户必须看得见：投递结果会如实回报「已直达」
 * 还是「进了队列，角色不在等」，前端据此提示。**不要把队列积压伪装成送达。**
 *
 * ## 生命周期
 *
 * 队列和等待者都在内存里，寿命跟会话一样（角色本来也活不过会话）。
 * 进程重启 = 角色和它的收件箱一起没了，跟「角色转录也没了」是同一个边界，
 * 不会出现"角色还在但话丢了"的错位。会话结束时 `clearProject` 收干净，
 * 免得等待者永远挂着。
 */

const MAX_QUEUE = 50;
const boxes = new Map();      // `${projectId}::${slug}` → { queue, waiters, emptyStreak }

const keyOf = (projectId, slug) => `${projectId}::${slug}`;
function boxFor(projectId, slug) {
  const k = keyOf(projectId, slug);
  if (!boxes.has(k)) boxes.set(k, { queue: [], waiters: [], emptyStreak: 0 });
  return boxes.get(k);
}

/**
 * 投一条消息给某个角色。
 * @param {{wake?: boolean}} opts wake:false = 只进队列不唤醒（台上广播的级联阻尼档：
 *   链太深的动静让角色下次自己醒来时批量看，别一层层把全场炸醒）
 * @returns {{ delivered: 'waiting'|'queued', queueDepth: number }}
 *   'waiting' = 角色正挂着等，已经当场交到它手里
 *   'queued'  = 没人在等（或 wake:false），进了队列，等它下次自己来取
 */
export function deliver(projectId, slug, message, { wake = true } = {}) {
  const box = boxFor(projectId, slug);
  const item = { ...message, at: message.at || new Date().toISOString() };

  const waiter = wake ? box.waiters.shift() : null;
  if (waiter) {
    clearTimeout(waiter.timer);
    box.emptyStreak = 0;                 // 有人说话了，散场计数归零
    waiter.resolve([item]);
    return { delivered: 'waiting', queueDepth: box.queue.length };
  }

  box.queue.push(item);
  // 满了丢**最旧**的：新消息是用户刚说的话，比十分钟前那句更该留
  if (box.queue.length > MAX_QUEUE) box.queue.splice(0, box.queue.length - MAX_QUEUE);
  return { delivered: 'queued', queueDepth: box.queue.length };
}

/** 非阻塞取走全部积压 */
export function drain(projectId, slug) {
  const box = boxFor(projectId, slug);
  const out = box.queue;
  box.queue = [];
  if (out.length) box.emptyStreak = 0;   // 积压里有话 = 有人在跟它说话
  return out;
}

/**
 * 阻塞等待下一批消息。队列里有就立刻返回，没有就挂着。
 * @returns {Promise<Array>} 超时返回空数组（**不是抛错**：没人说话是正常情形，
 *   角色该据此决定是继续等还是收工，不该当异常处理）
 */
export function waitFor(projectId, slug, timeoutMs) {
  const box = boxFor(projectId, slug);
  if (box.queue.length) return Promise.resolve(drain(projectId, slug));

  return new Promise((resolve) => {
    const waiter = { resolve, timer: null };
    waiter.timer = setTimeout(() => {
      const i = box.waiters.indexOf(waiter);
      if (i >= 0) box.waiters.splice(i, 1);
      box.emptyStreak += 1;
      resolve([]);
    }, timeoutMs);
    box.waiters.push(waiter);
  });
}

/**
 * 连着几次等空了（没人说话）。`await_user` 据此决定是「接着挂」还是「散场」。
 *
 * ⚠️ 为什么需要这个计数：角色循环挂 `await_user` 会**给整个会话续命** ——
 * `session-loop.js` 里每条 SDK message 都调 markSessionActivity（那是为了修
 * 「长 turn 被 idle timeout 掐死」加的），而角色每轮循环都要说话。
 * 于是 15 分钟一次心跳，永远撞不到 30 分钟的 idle 窗口：用户关了标签页走人，
 * 角色还在空转，会话永不关闭，CLI 进程一直驻着（而它的 RSS 单调不减）。
 * 所以散场必须由角色自己数着来，不能指望 idle timeout 兜底。
 */
export function emptyStreakOf(projectId, slug) {
  return boxes.get(keyOf(projectId, slug))?.emptyStreak || 0;
}

/** 这个角色此刻在不在等（前端提示「墨璃在等你回话」用） */
export function isWaiting(projectId, slug) {
  return (boxes.get(keyOf(projectId, slug))?.waiters.length || 0) > 0;
}

/** 积压深度 */
export function queueDepth(projectId, slug) {
  return boxes.get(keyOf(projectId, slug))?.queue.length || 0;
}

/**
 * 这个项目里收件箱认识的角色（台上广播的名册）。
 * 「认识」= 它碰过自己的收件箱（await_user/check_inbox/被投递过）或被 touchInbox 登记过。
 * 角色刚被派、还没等过第一次的窗口期会漏 —— 所以 stage-broadcast 在角色**开口**时
 * 顺手登记（能写板 = 在场），窗口收窄到「上场后一句话没说也没等过」，那时它正忙着
 * 演 GM 派它时给的开场词，漏一条广播无害。
 */
export function knownRoles(projectId) {
  const prefix = `${projectId}::`;
  return [...boxes.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
}

/** 显式登记（只建箱不投递）。 */
export function touchInbox(projectId, slug) { boxFor(projectId, slug); }

/** 这个项目里有谁在等 / 有积压（给前端一次问清） */
export function inboxStates(projectId) {
  const out = {};
  const prefix = `${projectId}::`;
  for (const [k, box] of boxes) {
    if (!k.startsWith(prefix)) continue;
    const slug = k.slice(prefix.length);
    if (box.waiters.length || box.queue.length) {
      out[slug] = { waiting: box.waiters.length > 0, queued: box.queue.length };
    }
  }
  return out;
}

/**
 * 角色退场：把它的散场计数清零。
 *
 * ⛔ 不清的后果（2026-08-26 fable 验收跑出复现）：角色连着 2 次等空 → 散场 → GM 用
 * SendMessage 把它召回 → 它**第一次**等空就是第 3 次 → 当场又被劝退。N=2 的宽限对
 * 召回的角色完全失效，「召回」这个能力等于废掉。
 * 语义上 streak 数的是「这一趟在场期间连着几次没人理」，退场就是这一趟结束。
 *
 * ⚠️ 不删整个 box：积压的队列要留着 —— 角色不在的时候用户说的话正是它下次
 * 该看到的（deliver 回 'queued' 就是这个约定）。
 */
export function clearStreak(projectId, slug) {
  const box = boxes.get(keyOf(projectId, slug));
  if (box) box.emptyStreak = 0;
}

/** 会话收摊：把这个项目的等待者全放掉，别让它们永远挂着 */
export function clearProject(projectId) {
  const prefix = `${projectId}::`;
  for (const [k, box] of [...boxes]) {
    if (!k.startsWith(prefix)) continue;
    for (const w of box.waiters) { clearTimeout(w.timer); w.resolve([]); }
    boxes.delete(k);
  }
}

/** 测试用 */
export function _resetInboxes() { boxes.clear(); }
