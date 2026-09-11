/**
 * server/hosted/relay/catalog.js —— relay 目录（GET /api/relay/models）下发什么（2026-09-11 从 router.js 拆出并扩字段）。
 *
 * ## 为什么目录要带整行
 *
 * 以前只给 id / locked / lockReason，标签和描述靠桌面安装包自带的那张表 —— 于是站点每加一行、改一次 id
 * 或名字，都得跟发一版桌面（09-10 一天两次）。现在每条 API 行把**桌面建这一行要用的全部字段**一起给，
 * 桌面照着建（engine/agent/model-rows.js 的 mergeRelayRows）。字段只增不减：老桌面只读 id / locked /
 * lockReason，照旧能用。
 *
 * 给的是「怎么展示、怎么起会话」，不给「怎么打上游」：wireModel / 上游地址 / 钥匙都不出这台机器 ——
 * relay 会话的推理、转换、记账全在站点上，桌面用不着。
 *
 *   id / locked / lockReason   跟以前一样（老桌面只认这三个）
 *   lockKind                   锁的种类：'closed'（按钟点关门，桌面据 unavailable 现算）/ 'disabled' / 'subscription' / 'tier'
 *   mode                       'api' | 'subscription'。**只有 api 行桌面才会照着建**；订阅行 CLI 自己认名字，站点代替不了
 *   label / desc / only / stageDefault / default   选择器那些字段（= 表里的 select）
 *   brand / window             身份标、压缩窗口
 *   sdkAlias                   ⛔ 必须跟站点这行一致：站点的会话路由只认本行的 id / 别名，别的名字一律改道 helper
 *   fastModel                  helper 行 id（那一行也会出现在目录里，带 helper: true，不进选择器）
 *   protocol                   这行上游说哪种协议（桌面换模型的协议闸要用）
 *   prices                     表价（桌面自己那本展示账用；真账在站点）
 *   unavailable                **实际生效**的关门时段（站主在管理台覆盖过就是他那份），桌面的钟点闸照它现算
 *   renames（顶层）             改名表：桌面存量里的旧 id 顺着它落到新行上
 */

import { selectableModelsFor, resolveModelRoute, PICKER_SCOPES, MODEL_ROWS, UPSTREAMS } from '../../engine/agent/model-context.js';
import { RENAMED_MODELS } from '../../engine/agent/model-renames.js';
import { effectiveHoursOf } from '../../lib/model-availability.js';
import { relaySubscriptionAllowed, RELAY_SUBSCRIPTION_CLOSED_REASON } from './gates.js';

const rowById = (id) => MODEL_ROWS.find((r) => r.id === id) || null;

/** 一条 API 行里桌面起会话要用的那部分（主行和 helper 行共用） */
function apiContract(row) {
  const route = resolveModelRoute(row.id);
  const hours = effectiveHoursOf(row).spec;
  return {
    mode: 'api', brand: row.brand, window: row.window,
    sdkAlias: route.sdkAlias, fastModel: route.fastModel,
    protocol: UPSTREAMS[route.upstreamId]?.protocol || 'anthropic',
    ...(row.api.prices ? { prices: row.api.prices } : {}),
    ...(hours ? { unavailable: hours } : {}),
  };
}

/**
 * 这个账号在 relay 上的目录：两个选择器面（canvas / stage）的并集，面的过滤桌面自己做。
 * @param {object} user
 * @param {{ now?: Date }} [opts]  钟点闸的"此刻"（测试钉时间用）
 * @returns {{ models: object[], renames: Record<string,string> }}
 */
export function relayCatalogFor(user, { now } = {}) {
  const byId = new Map();
  for (const scope of PICKER_SCOPES) {
    for (const m of selectableModelsFor(user, { scope, now })) {
      if (byId.has(m.id)) continue;
      const route = resolveModelRoute(m.id);
      // 订阅行在 relay 上还要过订阅腿的总开关：站内 pro 不锁，桌面版照样锁（原因写明白，客户端选择器直接显示）
      const subClosed = route.mode === 'subscription' && !relaySubscriptionAllowed(user);
      const locked = !!m.locked || subClosed;
      const lockReason = subClosed && !m.locked ? RELAY_SUBSCRIPTION_CLOSED_REASON : m.lockReason;
      const lockKind = !locked ? null : m.unavailableKind || (subClosed && !m.locked ? 'subscription' : 'tier');
      const row = rowById(m.id);
      byId.set(m.id, {
        id: m.id, locked, ...(locked && lockReason ? { lockReason } : {}), ...(lockKind ? { lockKind } : {}),
        label: m.label, desc: m.desc || '',
        ...(m.only ? { only: m.only } : {}), ...(m.stageDefault ? { stageDefault: true } : {}), ...(m.default ? { default: true } : {}),
        ...(route.mode === 'api' && row?.api ? apiContract(row) : { mode: 'subscription', brand: m.brand }),
      });
    }
  }
  // helper 行：列出来的 API 行指着的那几条。不进选择器（没有 label），桌面建表时 fastModel 要能在表里找到它
  for (const e of [...byId.values()]) {
    if (e.mode !== 'api' || !e.fastModel || byId.has(e.fastModel)) continue;
    const row = rowById(e.fastModel);
    if (row?.api) byId.set(row.id, { id: row.id, locked: false, helper: true, ...apiContract(row) });
  }
  return { models: [...byId.values()], renames: RENAMED_MODELS };
}
