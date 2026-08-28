/**
 * engine/agent/stage-broadcast.js —— 台上广播（2026-08-28，转发机）
 *
 * ## 它解决的事故（08-28 真会话，proj_mtck9xlr）
 *
 * GM 叙完事，角色永远接不上：角色挂在 await_user 里只听收件箱（deliver 通道），
 * 而 GM 手里只有 SendMessage —— 那条路要等阻塞工具返回的间隙才送到，实测迟到
 * 整整 300 秒（四条催促在 await_user 第二次超时返回时一起到账）。用户拍板：
 * 「让角色接话」不该靠 GM 的纪律，要有一套自动转发的机器。
 *
 * ## 机制
 *
 * 话**落板**（write_on_board 的单条板书 / 用户落痕）= 台上公开的一拍，服务端把
 * 指针投进在场角色的收件箱（deliver 即刻唤醒挂着等的角色）。keep=false 的私语
 * 不落板也就不广播 —— 「板上 = 人人听得见」是判据，不是巧合。
 *
 * 按 scene.mode 分发（没设过场 = free）：
 *   free     广播给所有在场角色（除作者/已直投者）——谁有话谁接，无话 pass
 *   solo     只投 order 里那（几）个；order 没排就退化成 free
 *   rounds   不广播。GM 旁白交给轮次机开轮（scene.onStageNote → cue order[0]，
 *            后续由 onRoleWait 挨个推）；广播会让全桌同时醒、抢话，毁掉轮次感
 *   directed 不自动 —— GM 逐拍点人（cue_role）
 *
 * ## 级联阻尼
 *
 * 角色的发言也广播（群像戏要互相听见），但 A 说→B 醒→B 说→A 醒会滚雪球。
 * 每条广播带链深：GM/用户的话是 0（新的一拍，全场链深清零），角色被链深 h 的
 * 动静唤醒后自己的发言是 h+1；超过 MAX_HOP 的只进队列不唤醒（deliver wake:false），
 * 角色下次自己醒来时批量看。角色台规里的「无话别硬编」是软阻尼，这条是硬闸。
 *
 * ## 在场名册
 *
 * 用 inbox 的 knownRoles（碰过收件箱的角色）。角色一开口这里就顺手 touchInbox
 * 登记，窗口只剩「刚上场、一句没说也没等过」—— 那时它正忙着演开场词，漏一条无害。
 *
 * 状态全在内存、跟会话走（同 inbox/scene 的寿命边界），clearStage 随会话收摊。
 */

import { deliver, knownRoles, touchInbox } from './inbox.js';
import { getScene, onStageNote } from './scene.js';
import { isResidentRole } from './cast.js';
import { getProject } from '../../projects/store.js';

/** 链深超过它就只排队不唤醒（用户拍板 2~3，取 2：GM→角色→角色 两层回声后静音） */
export const MAX_HOP = 2;

const hopsByProject = new Map();   // projectId → Map<slug, 最近一次收到的广播链深>
const hopsFor = (pid) => {
  if (!hopsByProject.has(pid)) hopsByProject.set(pid, new Map());
  return hopsByProject.get(pid);
};

/** 广播话术（纯函数，可断言）。nd:rp-prompt */
export function stageNoteMessage({ rel, by, excerpt, facts = null }) {
  const who = by === 'agent' ? '旁白' : by === 'user' ? '用户' : `「${by}」`;
  // 场况档（08-28 文风节食）：GM 填了 facts 就投干货不投散文 —— 角色按事实演，
  // 原文只在要引用原句时才读。防的是「每拍读旁白散文 → 嗓子染上旁白腔」。
  if (Array.isArray(facts) && facts.length) {
    return `（台上动了 —— ${who}这一拍的场况：\n${facts.map((f) => `  · ${f}`).join('\n')}\n`
      + `原文在 ${rel}，要引用原句才去读 —— 那是另一支笔的文风，句式和腔调别学。`
      + `这不是点名：你的角色此刻有话就接（write_on_board 用 reply_to 指它），没话就接着 await_user 等。）`;
  }
  return `（台上动了：${who}写了「${excerpt}」→ ${rel}。这不是点名 —— 你的角色此刻有话就接`
    + `（write_on_board 用 reply_to 指它），没话就别硬编，接着 await_user 等。）`;
}

const excerptOf = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60);

/**
 * 一条话落板了，按场分发。fail-soft 由调用方包（广播坏了不拦落板）。
 * @param {string} projectId
 * @param {{rel: string, by: string, text: string, exclude?: string[], facts?: string[]|null}} note
 *   by：板书作者（'agent' | 'user' | 角色 slug）。exclude：已经直投过的收件人。
 *   facts：GM 随旁白填的场况条目（只认 by='agent'）—— 投给角色的换成这份干货，
 *   角色不用每拍吞旁白散文（文风节食，08-28 用户拍板：工具参数不走 helper 蒸馏）。
 * @returns {{mode: string, line: string|null, scene: object|null}|null}
 *   line 是给工具返回值的一句话（GM 据此知道机器在转、不用自己转发）；
 *   scene 非空 = rounds 开了一轮，调用方拿去 emit。design 项目返回 null。
 */
export function broadcastStageNote(projectId, { rel, by, text, exclude = [], facts = null }) {
  if (!projectId || (getProject(projectId)?.mode || 'design') !== 'rp') return null;
  if (isResidentRole(by)) touchInbox(projectId, by);   // 能开口 = 在场，进名册
  const beatFacts = by === 'agent' && Array.isArray(facts) && facts.length ? facts : null;

  const scene = getScene(projectId);
  const mode = scene?.mode || 'free';

  if (mode === 'rounds') {
    // 角色发言的推进走 onRoleWait，用户开轮走 onUserSay —— 这里只管旁白开轮
    if (by !== 'agent') return { mode, line: null, scene: null };
    const sc = onStageNote(projectId, rel, beatFacts);
    return { mode, scene: sc, line: sc ? `轮次机：这条开了新一轮，已 cue「${sc.turnSlug}」。` : null };
  }
  if (mode === 'directed') return { mode, line: null, scene: null };

  const hops = hopsFor(projectId);
  let hop = 0;
  if (by === 'agent' || by === 'user') hops.clear();          // 新的一拍，回声计数归零
  else hop = (hops.get(by) ?? 0) + 1;

  const skip = new Set([by, ...exclude]);
  let targets = knownRoles(projectId).filter((s) => !skip.has(s));
  if (mode === 'solo' && scene?.order?.length) targets = targets.filter((s) => scene.order.includes(s));
  if (!targets.length) return { mode, line: null, scene: null };

  const wake = hop <= MAX_HOP;
  const msg = { from: 'stage', text: stageNoteMessage({ rel, by, excerpt: excerptOf(text), facts: beatFacts }), note: rel };
  const parts = targets.map((slug) => {
    const r = deliver(projectId, slug, msg, { wake });
    hops.set(slug, hop);
    return `${slug}${r.delivered === 'waiting' ? '（在等，已送达）' : '（没在等，进了队列）'}`;
  });
  const line = wake
    ? `台上广播：已投给 ${parts.join('、')} —— 不用你转发。`
    : `台上广播：回声太深（链深 ${hop}），只进了 ${targets.join('、')} 的队列，没唤醒。`;
  return { mode, line, scene: null };
}

/** 会话收摊（跟 inbox.clearProject / scene.clearScene 一起调） */
export function clearStage(projectId) { hopsByProject.delete(projectId); }

/** 测试用 */
export function _resetStage() { hopsByProject.clear(); }
