/**
 * auth/tier.js —— 账号档位（真相源）与能力（接口）。2026-08-21 开放注册后的收口。
 *
 * 背景：以前"这是不是试用号/公开号"没有名字，五个消费方各自拿一个相关字段去猜
 * （`lifetimeCostLimitUsd != null` ⇒ 试用）。那个猜法写于只有邀请码的年代；开放注册
 * 多出第三类人之后，公开号的该字段是 null，于是 publish_site / paint_still / 外审默认档
 * 全把它当成了正式号。任何靠推断而不是靠声明的分类，下次再多一类人还会错一遍。
 *
 * 形状（两层，别合成一层）：
 *   - **档位是事实**：`users.plan`（'pro' | 'basic'）注册路径写死，admin 由 role 派生。
 *     三档：admin / pro（邀请码）/ basic（公开注册）。用户 08-21 拍板只有这三档。
 *   - **能力是接口**：消费方不读档位名、不写 `if (tier === 'basic')`，只问 `can(user, 'publishSite')`。
 *     加一档只改下面这张表；加一个能力也只改这张表；消费方零改动。
 *     （同仓 kinds 的"问能力不问形态名"规则在账号层的复现。）
 *
 * 两件故意不归这里管的事：
 *   - `lifetimeCostLimitUsd` 是**花费上限**（试用码的终身额度），不是档位 —— quota.js 继续用它封顶，
 *     但任何权限判断都不许再读它（tier.test.js 有 lint 钉着）。
 *   - `allowLocalGen` 是本地产线（站主自己的 GPU 盒子）的**逐人批准**，叠在档位之上：
 *     basic 档永远不行；pro 档还要被批。见 localGenApproved()。
 *
 * ⚠️ 只做"用户档位"隔离，不做"模型"隔离（用户 08-21 拍板：有外审兜着，不再担心无审查
 * 模型的会话把违规提示词送进 generate_image）。工具闸不看会话跑在哪个模型上。
 */

export const TIERS = Object.freeze(['admin', 'pro', 'basic']);
/** users.plan 的合法值（admin 不是 plan，是 role） */
export const PLANS = Object.freeze(['pro', 'basic']);

/**
 * 能力表 —— 唯一一处把档位翻译成"能干什么"。
 *   subscription      能选站主订阅的 Claude 行（model-context 的 gate:'subscription'）
 *   webSearch         web_search（tavily/baidu 花钱；basic 档有日上限 webSearchDailyCap）
 *   imageGen          generate_image（codex 订阅配额）
 *   localGen          本地产线资格（paint_still / roll_film / 演出端点 / 本地无审查模型行）；
 *                     pro 档还要叠 allowLocalGen 批准，见 localGenApproved
 *   publishSite       publish_site 上 CF Pages（占站主四级域名 + 每账户 100 站硬上限）
 *   moderationDefault    订阅通路的外审默认档（用户没被显式钉档时生效）
 *   moderationDefaultApi API 通路（非订阅模型）的外审默认档 —— **两条通路各一个默认**
 *   webSearchDailyCap basic 档 web_search 每日上限（null = 不限）；env NODESIGN_BASIC_WEB_SEARCH_PER_DAY 可调
 *
 * ⭐⭐ **外审默认档 08-30 拆成两个**（用户拍板：「新账户默认按订阅严格、其他模型关闭」）。
 * 在此之前一格值同时管两条通路，于是"订阅要严、非订阅不审"这个口径根本表达不出来 ——
 * 只能一个人一个人去 admin 台钉 moderation_level_api，钉过 41 个号，钉漏的还在按 strict 跑。
 * 现在两条通路各有各的默认，口径的家在这张表里，不在 88 行用户数据里。
 *
 * 为什么这个口径讲得通：外审那道闸（lib/moderation.js）的存在理由是**违规消息不能进站主的
 * Claude 订阅**（骑的是站主账号，封号风险在站主头上）。非订阅模型走的是各家 API，
 * 各家自己有内容策略、出事也是那家的账 —— 我们再叠一层 GPT 外审只是在误伤创作。
 * ⚠️ 连带效果不止于"不审"：同一格值也管 prelude 的成人段（agent/system-prompts.js），
 * 'off' 那档写的是「成人内容明确允许，不用迂回」。改这一格 = 同时改口径和提示词。
 */
const CAPABILITIES = Object.freeze({
  admin: Object.freeze({ subscription: true, webSearch: true, imageGen: true, localGen: true, publishSite: true, moderationDefault: 'off', moderationDefaultApi: 'off', webSearchDailyCap: null }),
  // 08-21 晚用户拍板「所有审查都开到严格」：pro 默认档 loose → strict（admin 仍免审）
  // 08-30 起这条只管订阅通路；API 通路见 moderationDefaultApi
  pro: Object.freeze({ subscription: true, webSearch: true, imageGen: true, localGen: true, publishSite: true, moderationDefault: 'strict', moderationDefaultApi: 'off', webSearchDailyCap: null }),
  // 08-21 深夜用户拍板：basic 是今后唯一对外分发的档（pro 不再新发，只手动给）；basic 可用 Ox 免费行 + OpenCode Go 付费行 +
  // 生图（$0.20/张计入同一本账），每人每天 $5 总额度（注册时写 dailyCostLimitUsd，见 basicDefaultDailyUsd）；订阅 Claude / 本地产线 / 发布仍不开
  basic: Object.freeze({ subscription: false, webSearch: true, imageGen: true, localGen: false, publishSite: false, moderationDefault: 'strict', moderationDefaultApi: 'off', webSearchDailyCap: 'env' }),
});

/** basic 档注册时写入的每日总额度（美元）。env NODESIGN_BASIC_DEFAULT_DAILY_USD；0 或非法 = 不写（走全局默认日限） */
export function basicDefaultDailyUsd(env = process.env) {
  const raw = env.NODESIGN_BASIC_DEFAULT_DAILY_USD;
  if (raw === undefined || raw === '') return 5;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export const CAPABILITY_NAMES = Object.freeze(Object.keys(CAPABILITIES.admin));

/**
 * 账号档位。null 用户（没登录 / 项目无主）→ null，所有能力判 false（fail-closed）。
 * 不认识的 plan 值当 basic —— 拼错只能落到更紧的一边。
 */
export function tierOf(user) {
  if (!user) return null;
  if (user.role === 'admin') return 'admin';
  return user.plan === 'pro' ? 'pro' : 'basic';
}

/** 能力查询。未知能力名抛错（拼错不能静默当 false 或 true）。 */
export function can(user, capability) {
  if (!(capability in CAPABILITIES.admin)) throw new Error(`tier.can: unknown capability '${capability}'`);
  const tier = tierOf(user);
  if (!tier) return false;
  return CAPABILITIES[tier][capability] === true;
}

/**
 * 外审默认档（off | loose | strict）。null 用户 → 'off' 的老语义留给 moderation.js 自己判。
 *
 * @param {object|null} user
 * @param {'subscription'|'api'} [knob]  哪条通路的默认。**不给 = 订阅** —— 拼错 / 没传
 *   只能落到管站主账号的那一边，不能落到更松的一边（同 moderationKnobFor 的口径）。
 */
export function defaultModerationLevel(user, knob = 'subscription') {
  const tier = tierOf(user);
  const key = knob === 'api' ? 'moderationDefaultApi' : 'moderationDefault';
  return tier ? CAPABILITIES[tier][key] : 'strict';
}

/** basic 档 web_search 每日上限；其它档 null（不限）。 */
export function webSearchDailyCap(user) {
  const tier = tierOf(user);
  if (!tier) return 0;
  const v = CAPABILITIES[tier].webSearchDailyCap;
  if (v !== 'env') return v;
  const n = Number(process.env.NODESIGN_BASIC_WEB_SEARCH_PER_DAY);
  return Number.isFinite(n) && n >= 0 ? n : 60;
}

/**
 * 本地产线（roll_film / paint_still / 演出端点 / 本地模型行）是否真能用：
 * 档位有资格 **且**（admin 或站主逐人批过 allowLocalGen）。
 * 两段分别给不同的拒绝话术：basic 档是"这档不开放"，pro 未批是"尚未开通"。
 */
export function localGenApproved(user) {
  if (!can(user, 'localGen')) return false;
  return tierOf(user) === 'admin' || !!user.allowLocalGen;
}

/** 统一的拒绝话术（工具返回给 agent 原话转告用户）。 */
// 口径（08-21 深夜用户拍板）：pro 不再对外分发，拒绝语只说"当前档位不包含"，不给任何"去哪里要资格"的路径（tier.test 有 lint 钉着措辞）
export const DENIAL = Object.freeze({
  imageGen: '这个账号当前档位不包含生图。原话转告用户，不要重试、不要换别的生图工具。',
  imageQuota: '今天的额度用完了（生图按 $0.20/张计入每日额度），明天零点刷新。原话转告用户，这轮别再生图。',
  localGenTier: '这个账号当前档位不包含本地产线（生图/视频盒子）。原话转告用户，不要重试。',
  localGenApproval: '本地产线是批准制 —— 该账号尚未开通。原话转告用户，不要重试。',
  publishSite: '这个账号当前档位不包含发布站点到公网',
  subscription: '仅限 Pro 档（站主的 Claude 订阅），暂未对外开放',
});
