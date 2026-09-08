/**
 * lib/ingress/standby.js — 会话级换线（09-08，新用户第一句话撞 402 / 连续 503 案）。
 *
 * 病例（09-08 审计最近 7 天）：两个新用户第一句话撞 GMI 402 余额不足，一个撞 merge 连续四次 503，
 * 回合以 API Error 收场，人当场走了。CLI 对 5xx 会退避重试、对 401/402/403 不重试，所以两种失败要分开处理：
 *   - 5xx / 网络错：主行**第 2 次**连续失败时换线（第 1 次让 CLI 自己重试一下，上游抖一下很常见）
 *   - 401/402/403：立刻换线，并把回给 CLI 的状态码改成 503，它才会重试、下一发落到备用行
 * 换线只发生在主行（helper 的失败不换），一个会话只换一次（session-routes.switchSessionToStandby 保证），
 * 换完清掉连续失败计数让备用行有新的机会。哪一行备哪一行写在模型表的 `standby` 字段。
 */

import { switchSessionToStandby } from './session-routes.js';
import { recordIssue } from '../issues-store.js';

/** CLI 不会重试的上游状态码：换线后要改写成 503 */
export const PERMANENT = new Set([401, 402, 403]);

/**
 * @returns {(reason: string) => boolean}  换成功 true（已清计数、已通知用户）；没得换 false
 */
export function makeStandbySwitcher({ sessionTag, sidShort, streakKey, failStreaks, label, noticeSession, upstreamId = null, record = recordIssue }) {
  return (reason) => {
    // 告警先于换线：不管有没有备用行，上游出事这件事本身要进问题库（source=auto，按上游+原因去重累加，
    // 管理台问题列表直接看）。09-08 GMI 余额空了 5 个会话才有人知道，就是缺这一条。
    record({ source: 'auto', toolName: `upstream:${upstreamId || label}`, kind: 'bug',
      summary: `上游 ${label} 不可用：${reason}`,
      detail: `会话 ${sidShort} 主行请求失败（${reason}）。${['HTTP 401', 'HTTP 402', 'HTTP 403'].includes(reason) ? '这是凭据或余额问题，不会自愈，查一下上游账户。' : '连续失败已触发换线（有备用行时）。'}`,
      sessionId: sessionTag });
    const sw = switchSessionToStandby(sessionTag);
    if (!sw) return false;
    failStreaks.clear(streakKey);
    console.warn(`[model-ingress] sid=${sidShort} 换线：${sw.from} → ${sw.to}（${reason}）`);
    noticeSession(sessionTag, { key: 'upstream_standby', text: `${label} 线路不可用（${reason}），已切换到备用模型 ${sw.to}，正在重试。`, priority: 'warn' });
    return true;
  };
}
