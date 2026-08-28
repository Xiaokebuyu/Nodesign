/**
 * engine/agent/scene.js —— 场：这出戏此刻怎么调度（2026-08-27，编排第一块）
 *
 * ## 它是什么
 *
 * 一份**运行时声明**：说话模式、发言顺序、GM 的戏份。GM 用 `set_scene` 声明，
 * 三处机制读它——轮次机（本文件下半）、前端的台上横幅（run.scene 事件）、
 * rp 模式的提示词教义。它不管「谁在场」（那是 roster 和收件箱的事），只管
 * 「什么时候该谁说」。
 *
 * ## 四种说话模式（2026-08-27 用户拍板）
 *
 * - solo     一个角色跟用户 1v1，GM 隐身。没有机器，纯声明（提示词 + UI 用）。
 * - free     谁被叫到谁说，角色间用 SendMessage 自组织。没有机器。
 * - rounds   严格轮次。**唯一有机器的模式**：用户对着 order 里某人说话 = 开一轮，
 *            那人写完（重新挂上 await_user）→ 机器把 cue 投给下一个的收件箱，
 *            直到走完一圈。顺序由 GM 排（GM 懂人物性格，机器只负责执行）。
 * - directed GM 逐拍点人（SendMessage / 寄 cue），机器不插手。
 *
 * ## 轮次机为什么长在这而不是长在模型身上
 *
 * 块 6 的教训：把调度写成话术 GM 不听（代笔照旧）。机器用的信号全是现成的：
 * `deliver`（投收件箱）+ `run.role.wait`（角色重新挂上等待 = 「我这拍说完了」，
 * 这是 08-26 就有的事件，角色挂着时事件流静默，只有它能标出节拍边界）。
 *
 * ## 边界（想清楚了的，不是漏了）
 *
 * - **机器只管在场挂着的角色**。cue 投给没在等的角色会进队列（inbox 的既有语义），
 *   它回来自会看到；散场的角色机器叫不醒（服务端投不进闲置子代理）——那条线走
 *   SubagentStop 通知 GM 用 SendMessage 召回，08-26 已建好。轮次因此可能停在某人
 *   身上：状态在 run.scene 里，用户和 GM 都看得见卡在谁，不会无声烂掉。
 * - 生命周期与收件箱一致：内存态、跟会话走。进程重启 = 场散了，跟角色一起。
 * - ⚠️ scene 是**模型声明的**（set_scene 是 GM 的工具），但它只是调度策略不是权限：
 *   接续权闸（write-on-board）不读 scene，永远按板上对象的作者判 —— 判据不建在
 *   模型可写的东西上（feedback-verify-the-instrument）。
 */

import { deliver, isWaiting, queueDepth } from './inbox.js';
import { isResidentRole } from './cast.js';

const MODES = new Set(['solo', 'free', 'rounds', 'directed']);
const GM_PARTS = new Set(['narrator', 'offstage', 'referee']);

const scenes = new Map();   // projectId → scene

function blank() {
  return { mode: 'free', order: [], gm: 'narrator', note: '', round: null };
}

/** 只给外面看的快照（round 的内部指针换算成「轮到谁」） */
export function sceneSnapshot(projectId) {
  const s = scenes.get(projectId);
  if (!s) return null;
  const turnSlug = s.round?.active ? (s.order[s.round.idx] || null) : null;
  return { mode: s.mode, order: [...s.order], gm: s.gm, note: s.note, turnSlug };
}

/**
 * GM 声明/改场。patch 里给什么改什么，不给的不动。
 * @returns {{scene: object, warn: string|null}}
 * @throws mode/gm 非法、order 里有非角色 slug
 */
export function setScene(projectId, patch = {}) {
  const s = scenes.get(projectId) || blank();
  let warn = null;
  if (patch.mode != null) {
    if (!MODES.has(patch.mode)) throw new Error(`mode 非法（${patch.mode}）：solo|free|rounds|directed`);
    s.mode = patch.mode;
  }
  if (patch.gm != null) {
    if (!GM_PARTS.has(patch.gm)) throw new Error(`gm 非法（${patch.gm}）：narrator|offstage|referee`);
    s.gm = patch.gm;
  }
  if (patch.order != null) {
    const bad = patch.order.filter((x) => !isResidentRole(x));
    if (bad.length) throw new Error(`order 里不是角色 slug：${bad.join(', ')}（用 rp-<id>，read_scene/名册里那种）`);
    s.order = [...patch.order];
  }
  if (patch.note != null) s.note = String(patch.note).slice(0, 500);
  // 换模式/换顺序 = 进行中的一轮作废（旧指针指进新顺序是乱指）
  if (patch.mode != null || patch.order != null) s.round = null;
  if (s.mode === 'rounds' && s.order.length < 2) {
    warn = 'rounds 模式 order 少于 2 人：机器没得排，等价于 free。';
  }
  scenes.set(projectId, s);
  return { scene: sceneSnapshot(projectId), warn };
}

export function getScene(projectId) {
  return sceneSnapshot(projectId);
}

/** cue 话术（纯函数，可断言）。nd:rp-prompt */
export function cueMessage(prevSlug, noteRel = null) {
  return `（轮到你了${prevSlug ? `，上一个说话的是「${prevSlug}」` : ''}`
    + `${noteRel ? `。台上刚落了一条：${noteRel}，先读它` : ''}。看看板上刚发生的，接一段——`
    + `写完记得再挂 await_user。这一拍不想说就调 pass_turn，轮次会跳过你。）`;
}

/**
 * 内部：把轮次推进一格并 cue 下一个人。
 * @returns {{cued: string|null, done: boolean}}
 */
function advance(projectId, s, prevSlug) {
  s.round.idx += 1;
  if (s.round.idx >= s.order.length) {
    s.round = null;                       // 一圈走完，等用户开下一轮
    return { cued: null, done: true };
  }
  const next = s.order[s.round.idx];
  // 没在等也照投（进队列，它回来会看到）—— 但轮次指针停在它身上，状态可见
  deliver(projectId, next, { text: cueMessage(prevSlug), from: 'scene' });
  return { cued: next, done: false };
}

/**
 * 用户对某个角色说了话（roles.js 的 say 端点调）。
 * rounds 模式下，对 order 里的人说话 = 从那个人开一轮。
 * @returns {object|null} 场快照（变了才返回，调用方拿去广播），没变返回 null
 */
export function onUserSay(projectId, slug) {
  const s = scenes.get(projectId);
  if (!s || s.mode !== 'rounds') return null;
  const idx = s.order.indexOf(slug);
  if (idx < 0) return null;               // 不在轮次表里的角色不归机器管
  s.round = { idx, active: true };
  return sceneSnapshot(projectId);
}

/**
 * GM 的旁白落板了（stage-broadcast 调，2026-08-28 转发机）。
 * rounds 模式下，旁白写完一拍 = 从 order[0] 开一轮 —— 补上「用户只跟 GM 说话，
 * GM 叙完事没人 cue 角色」的洞（08-28 真会话事故的直接病根之一）。
 * 已有进行中的轮次不重开（GM 轮中插旁白是场记，不是新一拍）。
 * @returns {object|null} 场快照（开了轮才返回，调用方拿去广播）
 */
export function onStageNote(projectId, noteRel = null) {
  const s = scenes.get(projectId);
  if (!s || s.mode !== 'rounds' || s.round?.active || !s.order.length) return null;
  s.round = { idx: 0, active: true };
  deliver(projectId, s.order[0], { text: cueMessage(null, noteRel), from: 'scene' });
  return sceneSnapshot(projectId);
}

/**
 * 角色挂上/离开 await_user（role-inbox 的工具调）。
 * waiting=true 且正轮到它 = 「这一拍说完了」→ 推进。
 * @returns {object|null} 场快照（推进了才返回）
 */
export function onRoleWait(projectId, slug, waiting) {
  if (!waiting) return null;
  const s = scenes.get(projectId);
  if (!s || s.mode !== 'rounds' || !s.round?.active) return null;
  if (s.order[s.round.idx] !== slug) return null;
  // ⚠️ 时序闸：emit 发生在 waitFor **之前**，此刻队列里还有货 = 它是带着积压来挂的，
  // 马上就会当场消费（waitFor 见队列非空立即返回）—— 这是「拾取」不是「拍尾」，
  // 不推进。顺带把「用户连发几句」也接住了：队列没清空前轮次不走，话不会被截走。
  if (queueDepth(projectId, slug) > 0) return null;
  advance(projectId, s, slug);
  return sceneSnapshot(projectId);
}

/**
 * 角色这一拍不想说（pass_turn 工具调）。
 * @returns {{scene: object|null, msg: string}}
 */
export function passTurn(projectId, slug) {
  const s = scenes.get(projectId);
  if (!s || s.mode !== 'rounds') {
    return { scene: null, msg: '现在不是轮次模式（rounds），没有轮可跳。想沉默就直接接着 await_user。' };
  }
  if (!s.round?.active || s.order[s.round.idx] !== slug) {
    return { scene: null, msg: '现在没轮到你，不用跳。接着等就好。' };
  }
  const { cued, done } = advance(projectId, s, null);
  return {
    scene: sceneSnapshot(projectId),
    msg: done ? '跳过了。这一轮到你收尾，场上安静下来了 —— 接着 await_user 等下一轮。'
      : `跳过了，轮到「${cued}」。你接着 await_user 等。`,
  };
}

/** 会话收摊（跟 inbox.clearProject 一起调） */
export function clearScene(projectId) { scenes.delete(projectId); }

/** 测试用 */
export function _resetScenes() { scenes.clear(); }

// isWaiting 引进来是给将来「advance 时跳过确定散场的人」用的；今天先不用，
// 防 lint 报未使用，显式导出一个探测口（前端横幅也可能要）。
export function turnStalled(projectId) {
  const s = scenes.get(projectId);
  if (!s || !s.round?.active) return false;
  const cur = s.order[s.round.idx];
  return !!cur && !isWaiting(projectId, cur);
}
