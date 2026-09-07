/**
 * engine/stage/gates.js —— 玩家往台上说一句话之前要过的闸（2026-09-07）。
 *
 * ## 为什么以前一道都没有
 *
 * 演出这条路上没有主 agent：玩家的话不经 turn.js，直接进 sayToStage。而额度闸和外审
 * 一直只装在 turn.js（站上）与 hosted/relay/gates.js（桌面版经 relay 那条）。于是同一个人
 * 在浏览器里演不受限也不受审、在桌面版两样都受 —— 这个岔口是通路造成的，不是谁设计的。
 *
 * ## 顺序照 turn.js：先额度后外审
 *
 * 额度是本地一次 SQL，外审要打一次网络。用完额度的人不该再为他打那一发。
 *
 * ## 判决都不在这里
 *
 * 额度口径在 lib/quota.js（按金额、Asia/Shanghai 日界、admin 不限、免费行不看金额），
 * 外审的判什么 / 多严 / 留证 / 连坐在 lib/moderation.js。这里一个字都不复制，只负责
 * 把「谁在说」「这场戏用哪个模型」交过去，并把拒绝翻成 HTTP 形状。
 *
 * ⚠️ 外审的口径是 `ok`，没有 blocked 字段。写成 verdict.blocked 会恒为 undefined，
 * 这道闸就静默地永不触发（relay 那边栽过一次，这里照抄它的判法）。
 *
 * ## 两道闸管的范围不一样
 *
 *   额度：**每一句都算**，机器合成的开场指令也算 —— 它一样要付钱给上游。
 *   外审：只审玩家原创的那句。开场指令是 stage/opening.js 拼出来的模板，不是人打的字，
 *         拦下等于故事开不了而玩家什么都没做错。是不是玩家原创由服务端说了算
 *         （HTTP 路由那条永远不传 row），不是客户端能声称的。
 */

import { checkQuota, fmtUsd } from '../../lib/quota.js';
import { modelIsFree } from '../agent/model-context.js';
import { shouldModerate, moderateText, recordViolation, levelFor } from '../../lib/moderation.js';

/**
 * 拦下就抛（带 status + code，api/stage.js 的 sendErr 原样回给显示器）。
 * 放行返回这一发到底过了哪几道，只为测试与日志看得见。
 *
 * @param {object} a
 *   user       说话的人（没有就两道都不判：本地版关登录墙时也拿得到 LOCAL_OWNER）
 *   model      这场戏实际用的模型（appModel，manager.modelOfConfig 给的同一个）
 *   text       这一发的正文
 *   projectId  留证用
 *   byPlayer   这句是玩家原创的吗（false = 机器合成的开场指令，只过额度不过外审）
 * @param {{ moderate?: Function }} deps 注入分类器（测试用，跟 hosted/relay/gates.js 同一个姿势）
 */
export async function assertSayAllowed({ user, model, text, projectId = null, byPlayer = true }, { moderate = moderateText } = {}) {
  const out = { quota: false, moderated: false };
  if (!user) return out;

  // ── 闸 1：额度。免费行按金额算没有意义（quota.js 对它们另有轮次闸），跟 turn.js 同一条判据 ──
  if (!modelIsFree(model)) {
    const q = checkQuota(user);
    out.quota = true;
    if (!q.ok) {
      throw Object.assign(
        new Error(q.kind === 'lifetime'
          ? `试用额度已用完（${fmtUsd(q.used)} / ${fmtUsd(q.limit)}），这一句没有送上台。想继续用可以联系站主`
          : `今日额度已用完（${fmtUsd(q.usedToday)} / ${fmtUsd(q.limit)}），这一句没有送上台，明天零点刷新`),
        { status: 429, code: 'QUOTA_EXCEEDED' },
      );
    }
  }

  // ── 闸 2：外审 ──
  if (!byPlayer || !String(text || '').trim()) return out;
  if (!shouldModerate(user, model)) return out;

  const level = levelFor(user, model);
  const verdict = await moderate(text, level);
  out.moderated = true;
  if (!verdict || verdict.ok !== false) return out;

  const rec = recordViolation({
    userId: user.id, projectId,
    category: verdict.category, severity: verdict.severity,
    reason: verdict.reason, excerpt: text, level: verdict.level || level,
  });
  throw Object.assign(
    new Error(rec?.disabled
      ? '这句话涉及违规内容，账号已停用。如有疑问请联系站主'
      : '这句话涉及违规内容，没有送上台。请换个说法'),
    { status: 451, code: 'MODERATION_BLOCKED' },
  );
}
