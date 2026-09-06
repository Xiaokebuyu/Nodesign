/**
 * server/hosted/relay/gates.js — relay 的判决层（纯函数，不碰 HTTP）
 *
 * ## 为什么判决要跟传输分开
 *
 * 这条路上的每个判断都关系到钱（额度）或者封号（外审）。混在请求处理里就只能靠
 * 起真服务器打真请求来测，那种测试贵、慢、而且碰不到边界。拆开之后判决是个纯函数：
 * 给它一个用户和一份请求体，它回一个放行或者拒绝。传输那边只负责把结论翻成 HTTP。
 *
 * ## 为什么这些判断必须在服务器上做一遍
 *
 * 客户端（桌面版）自己也有同一套闸，但那份是**提示**：提前告诉用户"你这档用不了
 * 订阅模型"，省得他白等一轮。判决只认这里这份。客户端在用户手里，代码能改、库能改、
 * 环境变量能改，它说什么都不算数。
 *
 * 尤其是记账：现在的费用循环整个在客户端（session-loop 拿 takeUpstreamBilling
 * 写进自己的库），桌面版那本账写在用户自己机器上，服务器一分钱都看不见。所以额度
 * 只能按服务器这边独立算出来的数判。
 *
 * ## 闸的顺序
 *
 * 便宜且决定性的在前：档位（查内存表）→ 额度（查库）→ 外审（要打一次网络）。
 * 外审放最后，因为前两道拦下的请求根本不该为它花钱和时间。
 */

import crypto from 'node:crypto';
import { hasSubscriptionAccess, resolveModelRoute } from '../../engine/agent/model-context.js';
import { checkQuota, fmtUsd } from '../../lib/quota.js';
import { levelFor, moderateText, recordViolation, shouldModerate } from '../../lib/moderation.js';

/**
 * 已审过的内容指纹。agent 一个回合往上游打几十次，每次都带着整段历史，
 * 里面只有最新那条是新的；不去重的话审查成本会超过推理成本。
 *
 * 只记指纹不记原文。上限之外按插入序淘汰 —— 会话是有头有尾的，老指纹再出现的
 * 概率很低，为它做 LRU 不值得。
 */
const seen = new Map();          // `${userId}:${sha1(text)}` → true
const SEEN_MAX = 20_000;

function markSeen(key) {
  if (seen.size >= SEEN_MAX) {
    // Map 迭代按插入序，删最老的一批（一次删够，别每次都触发）
    let n = SEEN_MAX / 10;
    for (const k of seen.keys()) { seen.delete(k); if (--n <= 0) break; }
  }
  seen.set(key, true);
}

/** 测试用：清掉去重表，让每个用例从干净状态开始 */
export function _resetSeen() { seen.clear(); }

/**
 * 从 Anthropic Messages 请求体里取出**这一发新出现的用户原创内容**。
 *
 * 只看最后一条 role==='user' 的消息，且只取它的文本块：
 *   - 更早的用户消息在之前的请求里已经审过（同一个指纹）
 *   - tool_result 不是用户写的，是工具回来的东西，审它等于审我们自己
 *   - 图片不走这条（外审是文本模型）
 */
export function newUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content.trim();
    if (!Array.isArray(m.content)) return '';
    return m.content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }
  return '';
}

const deny = (status, code, message, extra = {}) => ({ ok: false, status, code, message, ...extra });

/**
 * 判一发 relay 请求放不放行。
 *
 * @param {object}  args
 * @param {object}  args.user       设备令牌校验出来的用户（调用方保证非空）
 * @param {object}  args.body       解析过的请求体（Anthropic Messages 形状）
 * @param {string}  args.appModel   **会话登记的**模型（sessions.js），不是 body.model。
 *   body.model 是 SDK 的 spoof 别名或 helper 的默认 Claude 名，按它判通路会把所有 API 会话
 *   都判成订阅（别名不在 BY_ID 里 → resolveModelRoute 落到 subscription）。通路、外审档位、
 *   订阅资格全按登记的那一行算。
 * @param {object} [deps]           注入点，只为测试：默认就是真的外审
 * @returns {Promise<{ok:true, route:object, moderated:boolean} | {ok:false, status:number, code:string, message:string}>}
 */
export async function decideRelay({ user, body, appModel }, { moderate = moderateText } = {}) {
  if (typeof appModel !== 'string' || !appModel) throw new Error('decideRelay: appModel 必填（来自会话登记，不是 body.model）');
  const model = appModel;
  const route = resolveModelRoute(model);

  // ── 闸 1：档位。订阅通路骑的是站主账号，basic 档不给（auth/tier.js 的能力表） ──
  if (route.mode === 'subscription' && !hasSubscriptionAccess(user)) {
    return deny(403, 'SUBSCRIPTION_REQUIRED', '这个账号没有订阅通路资格，换一个 API 模型。');
  }

  // ── 闸 2：额度。服务器自己算的数，不看客户端报什么 ──
  const quota = checkQuota(user);
  if (!quota.ok) {
    const which = quota.kind === 'lifetime' ? '总额度' : '今日额度';
    return deny(402, 'QUOTA_EXCEEDED',
      `${which}已用完（${fmtUsd(quota.used)} / ${fmtUsd(quota.limit)}）。`,
      { quota });
  }

  // ── 闸 3：外审。要打网络，所以放最后；只审这一发新出现的用户原创内容 ──
  if (!shouldModerate(user, model)) return { ok: true, route, moderated: false };

  const text = newUserText(body);
  if (!text) return { ok: true, route, moderated: false };

  const key = `${user.id}:${crypto.createHash('sha1').update(text).digest('hex')}`;
  if (seen.has(key)) return { ok: true, route, moderated: false };

  const level = levelFor(user, model);
  // ⚠️ moderateText 的口径是 `ok`：ok:false 才是拦截。它没有 blocked 字段 ——
  // 写成 verdict.blocked 的话恒为 undefined，这道闸会静默地永不触发。
  // 服务挂了它返回 { ok:true, failedOpen:true }，也就是 fail-open，这是它的既定纪律：
  // 这道闸的价值是留证加封号，不是绝对拦截。
  const verdict = await moderate(text, level);
  if (verdict && verdict.ok === false) {
    recordViolation({
      userId: user.id,
      category: verdict.category || 'other',
      severity: verdict.severity || 'normal',
      reason: verdict.reason || null,
      excerpt: text.slice(0, 500),
      level,
    });
    return deny(403, 'CONTENT_BLOCKED', verdict.reason || '内容未通过审核。');
  }

  // 审过了才记指纹。fail-open 那一发不记 —— 服务恢复之后同样的内容应该被重新审，
  // 否则一次网络抖动就等于给这段文本发了永久通行证。
  if (!verdict?.failedOpen) markSeen(key);
  return { ok: true, route, moderated: true };
}
