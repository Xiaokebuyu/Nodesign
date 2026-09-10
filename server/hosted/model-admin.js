/**
 * server/hosted/model-admin.js — 站点模型管理台（2026-09-10）。
 *
 * 站主要的两件事：
 *   1. **总闸**：把某一行从全站收走 / 放回来（落库在 lib/model-switches.js，留痕）。
 *   2. 看清楚**此刻**每一行是什么状态：开着还是关着、是不是撞在钟点闸里、挂哪个上游、什么价、
 *      谁把它当 helper 或备用行 —— 停用之前得先知道会牵连谁。
 *
 * 挂在 /api/admin/models（外层 admin.js 已经过 adminGuard）：
 *   GET   /api/admin/models          全景清单（含内置 helper 行）
 *   GET   /api/admin/models/slots    站点自己配的那份（原样 + 校验结果 + 表单要的枚举）
 *   PUT   /api/admin/models/slots    {upstreams, models} 整份存回 → **当场重建索引**，不重启
 *   PATCH /api/admin/models/:id      {enabled?: boolean, unavailable?: {why,tz,windows}|null|'reset'}
 *                                    开 / 关；以及**改这行几点关门**（含内置行 —— 表里那份只是出厂默认）。
 *                                    unavailable: 对象 = 这么关；null = 明确不关门；'reset' = 撤回、回到出厂那份
 *
 * ⭐ 站点插槽跟本地分发版的插槽是**同一套字段、同一个校验**（runtime/slot-config.js），只是存放处不同。
 *   保存之后调 rebuildModelIndex()：整套索引重建好了才换上去，建不成就原样抛出、旧表继续跑。
 * ⚠️ 重建只发生在**处理这个请求的那个进程里**。今天 pm2 是 fork 单进程（`pm2 list` 里的 mode），
 *   所以"保存即生效"成立；哪天开了 cluster / 多实例，别的进程还跑着旧表 —— 到那天要么让它们也收到信号，
 *   要么老老实实说"要重启"。这句话写在这儿是因为它坏起来完全没声音：页面显示已生效，一半用户看不见新行。
 *
 * ⛔ 停用**不动正在跑的会话**（站主 09-10：先别加 fallback）：下一发被拦下、话里告诉用户换一行。
 *    也就是说停用是"不许再发"，不是"把人搬走"。
 * ⚠️ helper / 备用行的引用**不受总闸影响**：它们不走选择器那条路（会话级路由直接按 id 发），
 *    关掉一行不会让引用它的行当场坏掉，但那行的标题/压缩会一直落在一个你以为已经关了的模型上。
 *    所以清单里把"谁引用了它"摆出来，别让站主关完才发现。
 */

import express from 'express';
import { MODEL_ROWS, MODEL_CONFIG_ERRORS, rebuildModelIndex, externalModelIds, shadowedBuiltinModelIds } from '../engine/agent/model-context.js';
import { listModelSwitches, setModelEnabled, setModelHours } from '../lib/model-switches.js';
import { closureNow, effectiveHoursOf, validateUnavailableSpec } from '../lib/model-availability.js';
import { loadSiteConfig } from '../runtime/slot-config.js';
import { writeSiteSlots } from '../lib/site-model-slots.js';
import { configPath, CONFIG_ENUMS, RESERVED_UPSTREAM_IDS, RESERVED_MODEL_IDS, SHADOWABLE_MODEL_IDS } from '../runtime/local-config.js';
import { UPSTREAMS_BUILTIN } from '../engine/agent/model-table.js';

/**
 * 站点侧的全景清单。不按用户判资格（那是 selectableModelsFor 的事）。
 * @param {Date} [now] 钟点闸的"此刻"（测试钉时间用）
 */
export function adminModelList(now = new Date()) {
  const switches = listModelSwitches();
  const fastRefs = new Map();      // 被谁当 helper
  const standbyRefs = new Map();   // 被谁当备用行
  const push = (map, key, id) => { if (!key) return; map.set(key, [...(map.get(key) || []), id]); };
  for (const m of MODEL_ROWS) {
    push(fastRefs, m.api?.fastModel, m.id);
    push(standbyRefs, m.standby, m.id);
  }
  return MODEL_ROWS.map((m) => {
    const sw = switches.get(m.id);
    const hours = effectiveHoursOf(m);            // 站主设过就是他那份，没设过是表里那份
    const closed = closureNow(hours.spec, now);
    return {
      id: m.id,
      brand: m.brand,
      window: m.window,
      external: !!m.external,                    // 插槽行（本机配置 / 站点插槽）
      subscription: !m.api,                      // 订阅通路（没有 api 段）
      label: m.select?.label || null,
      desc: m.select?.desc || null,
      selectable: !!m.select,                    // 没有 select = 只在内部当 helper 用，选择器里不出现
      gate: m.select?.gate || null,              // 'subscription' | 'localGen' | null
      only: m.select?.only || null,              // 'stage' = 只在演出显示器出现
      upstream: m.api?.upstream || null,
      wireModel: m.api?.wireModel || null,
      prices: m.api?.prices || null,
      standby: m.standby || null,
      unavailable: hours.spec,                   // **此刻真在用的**那份关门时段（null = 不关门）
      unavailableSource: hours.source,           // 'admin' 站主设的 | 'row' 表里出厂的 | 'none' 没有
      builtinUnavailable: m.unavailable || null, // 出厂那份（站主想"改回默认"时给他看的参照）
      enabled: !sw || sw.enabled,                // 没记录 = 启用
      switchedAt: sw?.updatedAt || null,
      switchedBy: sw?.updatedBy || null,
      switchNote: sw?.note || null,
      closedNow: closed
        ? { why: closed.why, resumesAt: closed.resumesAt.toISOString(), minutesLeft: closed.minutesLeft }
        : null,
      usedAsFastBy: fastRefs.get(m.id) || [],
      usedAsStandbyBy: standbyRefs.get(m.id) || [],
    };
  });
}

/**
 * 关掉这一行会不会让全站一条可选模型都不剩。
 * 单独一个纯函数是为了能测：真去把行一条条关掉来验这道闸，会把测试库搅成别的用例看不懂的样子。
 * 只数**选择器里出现的行**：helper 行关光了不至于让人发不出话（只是标题/压缩会退化）。
 */
export function wouldLeaveNoModels(list, id) {
  return !list.some((m) => m.selectable && m.enabled && m.id !== id);
}

const router = express.Router();

router.get('/', (_req, res) => {
  res.json({ models: adminModelList() });
});

/**
 * 页面要显示的错**以此刻真在跑的那份表为准**（MODEL_CONFIG_ERRORS）：
 * 它比"拿存下来的配置再校验一遍"多了 buildIndex 那一趟丢掉的行（上游不存在、窗口写坏、别名撞车…），
 * 而那恰恰是站主最需要看见的一类 —— 保存成功、页面干净、行却没进表，是这类页面最常见的骗法。
 * ⚠️ 只有站点那份是活的时候才这么取；实例读的是本地文件时（configPath），活着的错说的是另一份配置。
 */
const liveErrors = (cfg) => (configPath ? cfg.errors : [...MODEL_CONFIG_ERRORS]);

/**
 * 站点自己配的那份 + 表单要的一切（枚举、内置上游名、哪些 id 被占了）。
 * ⚠️ 名字规则跟本地配置页共用一套：内置上游名不许同名顶替、内置订阅行 id 不许当插槽 id、
 *    内置 API 行可被同名插槽顶替（编辑器据此在保存前就提示，别等保存才红）。
 */
router.get('/slots', (_req, res) => {
  const cfg = loadSiteConfig();
  res.json({
    raw: cfg.raw || { upstreams: {}, models: [] },
    errors: liveErrors(cfg),
    enums: CONFIG_ENUMS,
    // 这份配置里的行此刻有没有真在表里（校验没过的行会被整条丢掉）
    activeExternalModels: externalModelIds(),
    shadowedBuiltinModels: shadowedBuiltinModelIds(),
    reservedUpstreamIds: RESERVED_UPSTREAM_IDS, reservedModelIds: RESERVED_MODEL_IDS, shadowableModelIds: SHADOWABLE_MODEL_IDS,
    // 内置上游只报名字和有没有配钥匙，**不报钥匙**：站点插槽可以直接引用这些名字
    builtinUpstreams: Object.fromEntries(Object.entries(UPSTREAMS_BUILTIN).map(([id, u]) => [id, { label: u.label, keyPresent: u.authStyle === 'none' || !!(u.keyEnv && process.env[u.keyEnv]) }])),
    updatedAt: cfg.updatedAt, updatedBy: cfg.updatedBy,
    readOnly: !!configPath,
  });
});

/**
 * 整份存回，然后**当场重建索引**（不重启）。
 * ⭐ 半成品照存（跟本地配置页一个口径）：站主编到一半保存，页面标红告诉他哪儿不对，坏行不进表就是了。
 */
router.put('/slots', (req, res) => {
  if (configPath) {
    return res.status(409).json({ error: `这个实例的插槽读的是文件（${configPath}），不是站点配置。改那个文件，或者去掉 NODESIGN_MODELS_CONFIG。` });
  }
  const raw = req.body;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return res.status(400).json({ error: '配置必须是一个对象 { upstreams, models }' });
  }
  try {
    writeSiteSlots(raw, { updatedBy: req.user?.id || null });
  } catch (err) {
    return res.status(500).json({ error: `写配置失败：${err.message}` });
  }
  try {
    const applied = rebuildModelIndex();
    // errors 是"哪几行没进表"，不是"没保存"。前端据它标红，别当成失败
    res.json({ ok: true, errors: applied.errors, activeExternalModels: externalModelIds(), models: applied.models });
  } catch (err) {
    // 建不成 = 旧索引原样还在跑（rebuildModelIndex 保证）。配置**已经存下来了**，改好再存一次就行
    res.status(500).json({ error: `配置已保存，但这份表建不起来，站上仍在跑上一份：${err.message}`, saved: true });
  }
});

router.patch('/:id', (req, res) => {
  const list = adminModelList();
  const row = list.find((m) => m.id === req.params.id);
  if (!row) return res.status(404).json({ error: `没有这一行：${req.params.id}` });
  // 关门时段：单独一条路，跟开关互不影响（改时段不该顺手把一行打开，反过来也是）
  if ('unavailable' in (req.body || {})) {
    const spec = req.body.unavailable;
    if (spec === 'reset') setModelHours(row.id, undefined, { updatedBy: req.user?.id || null });
    else if (spec === null) setModelHours(row.id, null, { updatedBy: req.user?.id || null });
    else {
      const bad = validateUnavailableSpec(spec);
      if (bad.length) return res.status(400).json({ error: bad.join('；') });
      setModelHours(row.id, spec, { updatedBy: req.user?.id || null });
    }
    if (!('enabled' in (req.body || {}))) {
      return res.json({ model: adminModelList().find((m) => m.id === row.id) });
    }
  }
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled 需为 true / false' });
  const enabled = req.body.enabled;
  // ⛔ 别把最后一条能选的行关掉：全站没有可用模型 = 谁都发不出消息，而且那一刻管理台自己也在站里。
  // 只数"选择器里出现的行"（helper 行关光了不至于让人发不出话，只是标题/压缩会退化）
  if (!enabled && wouldLeaveNoModels(list, row.id)) {
    return res.status(400).json({ error: '这是最后一条还开着的可选模型，关掉全站就没有模型可用了' });
  }
  const note = typeof req.body?.note === 'string' && req.body.note.trim() ? req.body.note.trim().slice(0, 200) : null;
  setModelEnabled(row.id, enabled, { note, updatedBy: req.user?.id || null });
  const after = adminModelList().find((m) => m.id === row.id);
  // 关掉一条别人在当 helper / 备用行用的行：不拦，但要说出来（它们不走选择器，关了也照发）
  const refs = [...new Set([...row.usedAsFastBy, ...row.usedAsStandbyBy])];
  const warning = !enabled && refs.length
    ? `${row.id} 还被这些行当 helper / 备用行：${refs.join('、')}。它们走的是会话级路由、不过选择器这道闸，所以停用**拦不住**那条路 —— 真要断，得把引用它的行也改掉。`
    : null;
  res.json({ model: after, ...(warning ? { warning } : {}) });
});

export default router;
