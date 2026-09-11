/**
 * server/engine/agent/model-table.js — 内置模型表（**只放数据，不放逻辑**；上游注册表在 model-upstreams.js）。
 *
 * 08-22 从 model-context.js 拆出来：那边顶在 600 行棘轮上，而本地分发版要在内置行之外合并用户
 * 自己的插槽（runtime/local-config.js）。派生索引、断言、路由查表、picker 闸门全留在 model-context.js，
 * 它 import 这两张表再与外部行合并成 UPSTREAMS / MODELS。改行仍然只改这里；加一家 brand 也在这里。
 *
 * 字段说明见 model-context.js 文件头（两条通路 / spoofing / 记账）。
 */

// 上游注册表 09-10 搬去 model-upstreams.js（本文件顶到 600 行棘轮）。原样再导出：别处照旧从这里 import。
export { UPSTREAMS_BUILTIN } from './model-upstreams.js';


/**
 * 模型总表。字段：
 *   id       appModel —— 全站唯一标识（session-config / NODESIGN_MODEL / 计量落表都用它）
 *   window   真实 context window（ContextUsageBar 分母 + hooks 警告分档）
 *   select   出现在前端 picker 的 {label, desc}；没有 = 不对用户暴露
 *   unavailable  这行**每天有几个钟头不可用**（09-10 加）：{why, tz:'UTC', windows:['01:00-04:00', …]}。
 *                判据在 lib/model-availability.js（这里只放数据）。落在窗口里 = 选择器灰着显示并写明何时
 *                恢复、请求拦下让用户自己换一行 —— ⛔ **不自动换线**（站主 09-10：先别加 fallback）。
 *                跟 standby 是两件事：standby 是上游出错时的降级，这个是"按钟点关门"。
 *   api      API 通路配置（没有 = 订阅通路）：
 *     upstream   UPSTREAMS 的 key
 *     wireModel  发给上游的真模型名（入口出口替换）
 *     sdkAlias   喂 SDK 的 spoof 名。**可选，加新行默认不用写**：不写 = 自动用共用别名
 *                （SHARED_SDK_ALIAS，model-context.js 派生时补上）走会话级路由，全表反查
 *                认不出这行的 alias（没会话前缀的请求 502，探针带 /__nd/<sid> 前缀）。
 *                显式写 = 独占一个 1M 坑位（必须是 SDK 认识的订阅 Claude 名，⚠️独占名
 *                全表唯一、加载断言），换来的是没会话也能按 alias 反查（裸探针能直呼）。
 *                七个独占坑位已全部占满（见下面 SHARED_SDK_ALIAS 注释），新行别惦记
 *     fastModel  该路的 helper/subagent 模型（必须也是本表可路由的 id；
 *                订阅的 haiku 在 API 模式不可用 —— binary 见 API key 即弃 OAuth，
 *                helper 请求同样走唯一的 BASE_URL）
 *     thinking   'strip'（出口删 thinking 字段，上游自决）| 'enabled8k'
 *                （出口把 adaptive 改写成 enabled+budget 8192，Kimi 实测需要）
 *     liftImages tool_result 里的图提升到 user message 顶层（Kimi 与 Gemini 桥
 *                都丢 tool_result 图，08-19 探针实锤 + 修法验证）
 *     prices     每 1M token 的 USD {input, output, cacheRead, cacheWrite}；
 *                没填 = 沿用 SDK 按 alias 算的虚价（接真流量前先填）
 */

/**
 * 模型出自谁家 —— 前端据此画身份标（picker 图标 / 画布精灵 / 舞台徽记）。
 *
 * **声明，不推断**：不许前端按 id 前缀猜（`/^claude-/` 那种），下一个模型名一变就全错。
 * 每行必须写 brand，加载时断言（下面的派生循环），拼错当场炸。
 * 新增一家 = 这里加一个名字 + 前端 ui/ModelMark.jsx 加一枚标；两边由
 * web/src/components/ui/ModelMark.lint.test.js 对账（它直接读本文件的 BRANDS）。
 *
 * 口径（08-21 用户拍板）：有自己标的用自己的（deepseek 蓝鲸、gemini 星），
 * **隐身/神秘的免费行一律用供应商 OpenCode 的方块标**（Ox 这类不公开身份的模型）。
 *
 * 08-26 补一家 'glm'：Ox 下架后接替它的 glm-5.3-flash 是**公开身份**的 Z.ai 模型，
 * 按上面那条口径就该有自己的标，不再走供应商方块。'opencode' 那枚留着 —— 它是给
 * 下一个隐身行准备的，Zen 目录里那类行一直有（big-pickle 之类）。
 */
// 'custom'：本地分发版用户自己配的插槽（runtime/local-config.js）没填 brand 时的默认牌子，前端用通用标
export const BRANDS = Object.freeze(['claude', 'deepseek', 'opencode', 'glm', 'gemini', 'qwen', 'minimax', 'kimi', 'custom']);

/**
 * Merge 网关上那两条 GLM 行**共用**的 api 配置：它们是同一个模型、同一个网关，
 * 09-08 晚起**两行连厂商都不再区分**（不点名 vendors，网关自己路由；为什么见表里那两行上方一整段）。
 * ⛔ 写成共用不是为了省行数：思考档 / maxOutput / 价 / helper 行这些**必须对两条同时生效**，
 *    分开写迟早漂。改厂商以外的任何东西改这里，model-context.test.js 有断言盯着两行别分家。
 */
const GLM_MERGE_API = Object.freeze({
    upstream: 'merge', wireModel: 'zai/glm-5.3-flash',
    // 不写 sdkAlias = 共用别名（SHARED_SDK_ALIAS）走会话级路由，08-25 起的默认写法
    fastModel: 'deepseek-v4-flash-helper',   // helper 挑最耐久的线不是最便宜的线：这家的厂商轮盘不该让标题/压缩也跟着掷骰子
    thinking: 'strip',              // 出口删 thinking 字段；转换层按 reasoningEffort 发 reasoning_effort
    // 08-27 实测这家 low|medium|high|max **四档都收**（thinking 字数 922/981/1753/1843），
    // 比 zen 系宽（那边没有 medium）。取 high 跟另外两条 glm 行一致。
    reasoningEffort: 'high',
    maxOutput: 131_072,             // 131072 实测直接吃下
    // ⚠️ 这家的思考文本字段叫 **thinking / thinking_signature**，不是 zen 系的 reasoning_content
    // （08-27 第一趟真 SDK 循环"看到 thinking 块：false"就是这么来的）。转换层两处已改成
    // 「reasoning_content 优先、回退 thinking」，所以这行不用配任何东西 —— 记在这儿是给下一家看的：
    // **接新行时先看一眼它的思考字段叫什么**，掉了不报错、只是用户看不见思考。
    // 不设 liftImages：openai-chat 转换层本身就把 tool_result 里的图搬进随后的 user 消息（同 zenGo 那行）
    // 网关目录价（$0.015/$0.05，缓存读 $0.003）。⚠️ 它的响应把真金额放在 **usage.cost** 里而不是
    // 顶层 cost（Zen 是顶层），lib/ingress/upstream-billing.js 的 upstreamCostOf 两处都认，
    // 所以额度口径以上游自报为准，这里的表价是兜底
    prices: { input: 0.015, output: 0.05, cacheRead: 0.003, cacheWrite: 0 },
    // ⛔ 09-08 两行同时加的图片闸：**particle 一次最多 8 张内联图**，第 9 张起整发 400，而 zai 没了（见下面
    // 那段），所以多图会话每一发都死。裁图比死掉好：多出来的**最早的**换成占位文字（lib/ingress/image-cap.js，
    // 跟 DeepSeek 视觉行同一套）。09-08 晚站主拍板：**不点名厂商也保留这道闸**，落到哪家都不会 400。
    maxImages: 8,
});

/**
 * **共用 spoof 别名**：`sdkAlias` 不写时的默认值（model-context.js 派生时补上）。
 *
 * SDK binary 认识的 1M 名只有七个（strings 扫出来：opus-4-6/4-7/4-8/5、sonnet-4-5-20250929/4-6/5），
 * 六个已被内置行独占、sonnet-5[1m] 是订阅默认行不许被路由 —— 也就是说「一行一个独占别名」这条路
 * 已经走到头。共用别名的行（= 不写 sdkAlias 的行 + 本地分发版的全部外部插槽）**不进 WIRE_LOOKUP
 * 的 alias 键、只按 id 可查**，靠会话级路由分辨（lib/ingress/session-routes.js：一个会话只认
 * 自己那行和自己的 fast 行，主行优先）。外部插槽（runtime/local-config.js）一直是这么跑的，
 * 08-25 起内置行也走这条默认路 —— **加新模型行不用再考虑别名这件事**。
 *
 * ⚠️ 代价：**没注册会话的请求用这个名发过来一律 502**（全表反查里没有它）—— 探针要带会话前缀
 * （`/__nd/<sid>/v1/messages`），直呼 appModel id 也行。
 * ⚠️ 它必须始终是表内一条订阅 Claude 行（SDK 才认识、窗口才查得到）——model-context.js 加载断言。
 */
export const SHARED_SDK_ALIAS = 'claude-sonnet-4-6[1m]';

// Claude 表价（美元 / 百万 token），订阅行用；来历见下面订阅段注释
const CLAUDE_LIST = Object.freeze({ sonnet5: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 6 }, opus5: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 }, haiku45: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } });
export const MODELS_BUILTIN = Object.freeze([
  // ── 订阅通路（Claude 真名，零注入）──
  // `prices` = Claude 表价，跟站内订阅会话 SDK 自报的 total_cost_usd 同口径（relay 订阅腿 09-07 前因行上没价记 0，网页端与桌面版
  // 两本账对不上）。数值由生产 run_model_usage 反推 SDK 价目（Opus 5 206 行残差 4e-15、≥20 万上下文 676 行同价即不分档；Sonnet 5 117 行中 116 行相符），改价先重跑拟合。
  {
    id: 'claude-sonnet-5[1m]', window: 1_000_000, brand: 'claude', prices: CLAUDE_LIST.sonnet5,
    select: { label: 'Sonnet 5', desc: '响应快 · 适合日常改稿与排版', gate: 'subscription' },
  },
  {
    id: 'claude-opus-5[1m]', window: 1_000_000, brand: 'claude', prices: CLAUDE_LIST.opus5,
    select: { label: 'Opus 5', desc: '前端与审美能力更强 · 订阅额度消耗较快，建议用于重要任务', gate: 'subscription' },
  },
  { id: 'claude-sonnet-5',       window: 200_000, brand: 'claude', prices: CLAUDE_LIST.sonnet5 },
  { id: 'claude-opus-5',         window: 200_000, brand: 'claude', prices: CLAUDE_LIST.opus5 },
  { id: 'claude-opus-4-7[1m]',   window: 1_000_000, brand: 'claude' },
  { id: 'claude-sonnet-4-6[1m]', window: 1_000_000, brand: 'claude' },   // = SHARED_SDK_ALIAS（共用别名的本体行，删了它加载断言会炸）
  { id: 'claude-opus-4-7',       window: 200_000, brand: 'claude' },
  { id: 'claude-sonnet-4-6',     window: 200_000, brand: 'claude' },
  { id: 'claude-haiku-4-5',      window: 200_000, brand: 'claude', prices: CLAUDE_LIST.haiku45 },
  // 只当 alias 用的订阅名（08-20）：SDK 二进制认识的 1M 名里还空着的一个（strings 扫过：
  // opus-4-6/4-7/4-8/5、sonnet-4-5-20250929/4-6/5 七个 [1m]），给 gemini-3.7-flash 行做 spoof。
  { id: 'claude-opus-4-6[1m]',   window: 1_000_000, brand: 'claude' },
  // 下面两行 08-21 给 Ox 两行做过 spoof，08-26 随 Ox 下架**空出来**（行留着：SDK 认识的 1M 名是坑位不是垃圾）
  { id: 'claude-opus-4-8[1m]',   window: 1_000_000, brand: 'claude' },
  { id: 'claude-sonnet-4-5-20250929[1m]', window: 1_000_000, brand: 'claude' },
  // 独占 alias 池现状（08-26 更新）：opus-4-6[1m]→gemini-3.7-flash、opus-4-7[1m]→deepseek-v4-flash-vision、opus-5[1m]→qwen；
  // **空着三个**：opus-4-8[1m]、sonnet-4-5-20250929[1m]、haiku-4-5（Ox 三行 08-26 下架腾出来的）；
  // sonnet-5[1m] 是订阅默认行不许被路由；**sonnet-4-6[1m] = SHARED_SDK_ALIAS**（共用别名，永远不许被独占）。
  // ⚠️ 空出来不等于新行该去占：08-25 起加新行的默认写法就是**不写 sdkAlias**（走共用别名 + 会话级路由），
  // 这三个坑位留给真正需要"没会话也能按 alias 反查"的场合（探针、跨进程重放那类）。

  // ── API 通路 ──
  // kimi-k2.6 行与 moonshot 上游 08-21 深夜清掉（NoDesk 退役后没走过流量），其 alias claude-opus-4-7[1m] 转给
  // deepseek-v4-flash-vision；'enabled8k' 的 thinking 档逻辑留在 transformForUpstream 里备用。
  // 本地 Qwen（HauhauCS/Qwen3.8-27B-Uncensored-…-Aggressive-MTP-GGUF，底座官方
  // Qwen3.8-27B，有视觉）。⚠️ window 必须跟箱子 llama-server 的 -c 一致：低了
  // 会在 SDK 触发 auto-compact 之前先撞上游 400。262144 = 该模型原生上限（YaRN 可外推到 1M，但要额外开 rope
  // 参数且短上下文质量有代价，不默认走）。alias 用 1M 档：SDK 按 alias 查 rawMaxTokens，用 200k 名会让 auto-compact
  // 在 ~180k 就触发，白扔 80k。⚠️ 这个 alias 同时是线上可选的订阅模型名，安全性靠两点（改动前先确认还成立）：
  // ①订阅会话根本不进 ingress，WIRE_LOOKUP 只服务 API 会话；②repriceUsageDeltas 先看会话通路，订阅会话原样早退不 remap。
  {
    // window 必须等于盒上 llama-server 启动日志里的 `n_ctx_slot`（每槽上下文），低了 SDK 在 auto-compact 之前先撞
    // 上游 400。08-20 起盒子是 RTX 5090 32G：OrcaRouter Q5_K_M + 视觉 + MTP 投机 + 1 槽 × 131072，再留 ~5G 给同卡的
    // ComfyUI（noobai）。换回 96G 盒子就是 262_144 × 3 槽。盒上配置住 ops/qwen-box/（serve-prod.sh），两边要一起改。
    id: 'qwen3.8-27b', window: 131_072, brand: 'qwen',
    // ⏸ **08-20 用户拍板从 picker 摘牌**（盒子按小时租，已关机）。删掉 `select` 一处，
    // 三个消费方一起拒：GET /api/me/models 的清单、PUT /model 的校验、turn.js 的
    // body.model 校验（都走 selectableModelsFor —— 所以摘牌不会留后门）。
    // **线路原样留着**：下面 api 字段一个字没动，WIRE_LOOKUP / resolveSessionWire /
    // 记账 reprice 全照旧；已经钉在 qwen 的老会话仍会路由过去，盒子没开就 502 fail-loud
    // （这是设计，不是 bug）。同理 gemini-3.1-pro 那行也是「留行不留牌」，先例在下面。
    // 复牌 = 把这一行放回来，别的都不用动：
    //   select: { label: 'Qwen3.8 27B（本地）', desc: '本地盒子 · 无审查 · 盒子没开时不可用', gate: 'localGen' },
    // ⚠️ 复牌时别丢 `gate: 'localGen'` —— 跟 roll_film / paint_still 同一套批准制
    // （admin 免批），它本来就跑在同一台本地盒子上，语义天然一致；没这个闸就是对
    // 所有账号露出一个「一按就 502」的按钮。
    // 无审查权重跑在自己租的盒子上（不出网、零成本、只对获批账号开）。这条路上
    // prelude 的整节「底线」不注入 —— 站主 08-19 拍板，理由是那节是**平台对外
    // 开放**才需要的产物政策（产物能一键挂到站主域名下），而这台盒子上跑的是
    // 个人写作/角色扮演，那节只会让模型对正常输入畏手畏脚。
    //
    // 标记位住在表里而不是写成 `if (model === 'qwen3.8-27b')`：它是**模型属性**，
    // 跟 gate / prices 同级。散在 session-loop 里就是给这张表开第二个真相源，
    // 这个仓库为「同一件东西有多个实例」付过最贵的学费。以后再接一个无审查模型
    // 只加这一个字段，一行逻辑都不用动。
    uncensored: true,
    // ⭐ **盒上 llama-server 的 `-np`（slot 数）应当等于 `NODESIGN_MAX_CONCURRENT_RUNS`。**
    //   slot 比闸多 → 白占显存（每路一份满窗 KV）
    //   slot 比闸少 → 请求在 llama-server 里排队，而 Nodesign 以为自己还有余量，
    //                 用户看到的是无解释的慢，不是「现在有点挤」那句诚实的 BUSY
    // 08-19 的 96G 盒子两边都是 3（巧合不是设计）；**08-20 起的 5090 32G 盒子是 `-np 1`
    // 而闸仍是 3 —— 已知走偏**，出路是按模型给 maxConcurrent（⏸ 未拍板），在那之前
    // 第 2 个 qwen 请求就是在盒上排队。盒上脚本在 ops/qwen-box/（serve.sh=96G，
    // serve-prod.sh=5090），改任何一边都要改另一边；这条契约没法用 lint 拦 ——
    // `server/lib/_ingress-check.mjs` 第 6 项会真查 /slots 比对，换机后跑一次。
    api: {
      upstream: 'qwenLocal', wireModel: 'qwen3.8-27b',
      sdkAlias: 'claude-opus-5[1m]',
      fastModel: 'qwen3.8-27b',
      thinking: 'enabled8k',
      // ⭐ 08-19 盒上体检 9/9：llama.cpp 的 /v1/messages **原生直通 tool_result 图片**
      // （中转站 Gemini 桥正是死在这一项）。原样直通比提升到顶层更忠实，故关掉 lift。
      liftImages: false,
      prices: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },   // 本地盒子按租金付费，token 记 0（不然按 opus-5 虚价记账）
    },
  },
  // gemini-3.1-pro 行（中转-gemini-3.1-pro-preview，alias claude-sonnet-4-6[1m]）08-21 深夜清掉：退了 picker 后只做体检对照，
  // 对照改用 3.7 Flash 行；sonnet-4-6[1m] 这个 alias 名腾出来备用。中转站 thinking 参数零效果的结论见 08-20 记录。
  {
    id: 'gemini-3.7-flash', window: 1_000_000, brand: 'gemini',
    standby: 'glm-5.3-flash-merge',   // 上游连续失败/402 时会话级换线（ingress/session-routes switchSessionToStandby）
    // 08-20 用户拍板：要 3.7 Flash，先用中转站 + lift shim 顶着。它只在中转站的「反重力-」
    // 通道上有（转卖 Antigravity OAuth 额度），今天体检 6/9：文本/视觉/非流式 tool_use/
    // prompt cache 真命中（cache_read 8162）都好；流式 stop_reason 恒=end_turn（假上游实验证明
    // CLI 认块不认 stop_reason，无功能后果）；tool_result 图丢靠 liftImages 修。⛔硬伤是
    // 「当前无可用凭证」500 说来就来、不分请求大小、一来就是整段时间 —— 所以同 qwen 走
    // localGen 闸，label 写明不稳定，只给自己人。思考档在模型名里（-high/-medium/-low），
    // 选 high 即"默认高"；thinking 参数照旧 strip。
    select: { label: 'Gemini 3.7 Flash（中转）', desc: '中转通道 · 稳定性一般，可能返回 5xx · 思考档 high', gate: 'localGen' },
    api: {
      upstream: 'lament', wireModel: '反重力-流式抗截断/gemini-3.7-flash-high',
      sdkAlias: 'claude-opus-4-6[1m]',     // 3.7 Flash 真 1M 窗口，alias 诚实；见上面那行订阅名的注释
      fastModel: 'gemini-3.7-flash',
      thinking: 'strip',
      liftImages: true,
      // 官方促销价（2027-01-01 起翻倍 $1.5/$7.5）；缓存命中按输入价一折。中转站计量单位不明，
      // 这里的 USD 仍是配额/展示用的近似。
      prices: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
    },
  },
  // ── OpenCode Go · DeepSeek V4 Flash Vision Exp（08-21 深夜，第一条付费行）── /zen/go = OpenCode Go 订阅（$10/月换 $12/5h·$30/周·$60/月）：
  // 额度内上游 cost 报 0、余额不扣 → 记账按**表价**（高峰价；北京 09-12/14-18 是高峰）让每用户日限跟 Go 池子一起受控，cost>0 以上游为准
  // （context.applyUpstreamBilling）。探针：文本/图(webp)/工具/流式全通，首字 ~450ms，reasoning_effort 收；DeepSeek ZDR。先 gate localGen 试跑，过关改 'subscription'
  {
    // 09-08 晚基元律动那条 GLM-5.3-Flash：同模型第二条渠道，按标价折 USD 记（打折价不写进表，折扣没了表不用改），掉线换 merge 那条
    id: 'glm-5.3-flash-tokenrhythm', window: 1_000_000, brand: 'glm',
    standby: 'glm-5.3-flash-merge',
    select: { label: 'GLM-5.3-Flash · 基元律动', desc: '第二条渠道 · 支持视觉 · 1M 上下文 · 按用量计入每日额度（标价 $0.11/$0.39，缓存 $0.03）' },
    api: {
      upstream: 'tokenrhythm', wireModel: 'glm-5.3-flash',
      fastModel: 'deepseek-v4-flash-helper',
      thinking: 'strip',
      reasoningEffort: 'high',
      maxOutput: 131_072,
      prices: { input: 0.113, output: 0.394, cacheRead: 0.032, cacheWrite: 0 },
    },
  },
  {
    // 09-10 站主要的第三条 GLM 5.3 Flash：走 **OpenCode Go 那条订阅**（Go 目录里这个模型刚拿到双倍限额）。
    // 跟另外两条同模型不同渠道，值钱的不是价而是那份限额。
    // ⚠️⚠️ 记账口径跟别的行不一样：Go 是站主 $10/月的订阅，上游自报 `cost` **恒 0**（09-10 实测），
    //   而 applyUpstreamBilling 只在自报 **> 0** 时才盖表价 —— 所以下面这份表价不是"兜底"而是**唯一**的
    //   记账依据。不填价 = 这行对用户免费，全站一起白嫖你那份订阅限额，每日额度闸对它形同虚设。
    //   价沿用 merge 那行（同一个模型的网关标价），让 basic 的 $5/天对它照常有意义。
    // ⛔ 这把钥匙**跟 deepseek 视觉行共用一个限流桶**（同 NODESIGN_UPSTREAM_ZEN_KEY / 同一份 Go 订阅）：
    //   这行被用爆，那行跟着一起挂。要先只给自己试就在 select 里加一处 `gate: 'localGen'`。
    // 09-10 实测（真发一次）：文本 / 工具位都通；思考字段是 **reasoning_content**（不是 merge 那边的
    //   thinking，转换层两种都认）；usage 带 prompt_tokens_details.cached_tokens = 有 prompt cache。
    // ⚠️ 没写 standby（站主 09-10「先别加 fallback」）—— 要接就是一行 `standby: 'glm-5.3-flash-merge'`。
    id: 'glm-5.3-flash-go', window: 1_000_000, brand: 'glm',
    select: { label: 'GLM-5.3-Flash · OpenCode Go', desc: '第三条渠道 · 走 OpenCode Go 订阅（限额双倍）· 1M 上下文 · 单次最多 4 张图片' },
    api: {
      upstream: 'zenGo', wireModel: 'glm-5.3-flash',
      fastModel: 'deepseek-v4-flash-helper',
      thinking: 'strip',
      reasoningEffort: 'high',    // zen 系没有 medium 档，跟另外两条 glm 行取一致
      maxOutput: 131_072,
      // ⛔ 同一个上游的 deepseek 视觉行 09-07 实撞过 Console Go 的 "At most 4 image(s)"。这条没实测，
      // 按同上游的已知上限先收着：裁图比整发 400 好（lib/ingress/image-cap.js）
      // ⚠️ 09-11 同上游的 DeepSeek v4.1 打 60 张都不 400 → 那个 4 看着是 vision-exp 自己的上限、不是 Go 的。
      //   GLM 这行没实测过，要放开先打一发 9 张以上的
      maxImages: 4,
      prices: { input: 0.015, output: 0.05, cacheRead: 0.003, cacheWrite: 0 },
    },
  },
  {
    // 09-08 晚站主接的 DeepSeek 官方直连行。09-10 站主拍板**出口名跟展示名分开**：上游目录把版本抹了（只剩 deepseek-flash），
    // 选择器里再抹一次用户就不知道在用哪一代 → id/label 写 v4.1、发出去的只认 wireModel。旧 id 在 model-renames.js。价沿用 09-08 没重核。
    id: 'deepseek-v4.1-flash', window: 1_000_000, brand: 'deepseek',
    standby: 'deepseek-v4-flash-vision',
    select: { label: 'DeepSeek V4.1 Flash · 官方直连', desc: '官方直连 · 支持视觉 · 1M 上下文 · 按用量计入每日额度（高峰 $0.42/$1.27，缓存 $0.014）' },
    api: {
      upstream: 'deepseek', wireModel: 'deepseek-flash',
      fastModel: 'deepseek-v4-flash-helper',
      thinking: 'strip',
      reasoningEffort: 'high',
      maxOutput: 131_072,
      prices: { input: 0.42, output: 1.27, cacheRead: 0.014, cacheWrite: 0 },
    },
  },
  {
    // 09-10 站主要的第二条 V4.1 Flash：同一个模型走 Merge 网关。非高峰价比官方直连便宜一多半（$0.15/$0.60 对
    // $0.42/$1.27），代价是**高峰时段整行关门**（上游那两段窗口里翻倍到 $0.30/$1.20）—— 站主拍板宁可关门也不
    // 付双倍，关门期间不自动换线，选择器里灰着写清楚什么时候回来。
    // 09-10 非高峰真发过一次：文本 / 工具位 / 思考都通；思考字段跟 GLM 那两条一样叫 **thinking**（不是
    // reasoning_content，转换层两种都认）；真金额在 **usage.cost**（287+64 tok 报 8.145e-5，正好是按
    // $0.15/$0.60 算的）→ 记账以上游自报为准，下面的表价是兜底。
    // ⚠️ 目录还写着 max_output 384k / 支持视觉 / 七档 reasoning_effort，这三条**没实测**：maxOutput 先跟兄弟行
    // 取 131072，desc 里也不吹视觉。⚠️ 没写 standby（站主 09-10「先别加 fallback」）：上游挂了就是挂了。
    id: 'deepseek-v4.1-flash-merge', window: 1_000_000, brand: 'deepseek',
    unavailable: { why: '上游高峰时段涨价', tz: 'UTC', windows: ['01:00-04:00', '06:00-10:00'] },
    select: { label: 'DeepSeek V4.1 Flash · Merge 网关', desc: '响应快 · 1M 上下文 · 成本低（$0.15/$0.60，缓存 $0.003）· 每天北京时间 09:00-12:00、14:00-18:00 关门（上游高峰涨价）' },
    api: {
      upstream: 'merge', wireModel: 'deepseek/deepseek-v4.1-flash',
      fastModel: 'deepseek-v4-flash-helper',
      thinking: 'strip',
      reasoningEffort: 'high',
      maxOutput: 131_072,
      prices: { input: 0.15, output: 0.60, cacheRead: 0.003, cacheWrite: 0 },
    },
  },
  {
    // 真窗口 1M；用户 08-21 深夜拍板压缩窗口 272k（省钱：携带成本 ≈ 1M 的 1/4、缓存失手最坏 $0.12/轮；近 14 天 649 回合只压缩过 11 次）
    // 09-11 站主要求出口换成 v4.1（Go 目录这天才有 `deepseek-v4.1-flash`，没有单独的 -vision 变体，普通版就收图）。
    //   实测：文本 / 图（纯色图答对）/ 工具位 / reasoning_effort high 都通，思考字段 reasoning_content，cost 照旧报 0；
    //   models.dev 上 Go 的标价跟 vision-exp 一样（$0.15/$0.60/$0.003）→ 下面的表价不动。
    // ⚠️ id 故意**不改**：桌面版按 id 精确匹配 relay 目录，改了 id 没自带钥匙的桌面用户这行会直接消失，
    //   要等下一版桌面才回来。代次写在 label 上（09-10「出口名跟展示名分开」要的是用户看得见在用哪一代）。
    id: 'deepseek-v4-flash-vision', window: 272_000, brand: 'deepseek',
    standby: 'glm-5.3-flash-merge',   // 上游连续失败/402 时会话级换线（ingress/session-routes switchSessionToStandby）
    // 08-21 深夜开闸给所有档（含 basic）：basic 的 $5/天日限 + 表价记账管着它；pro/admin 不限
    select: { label: 'DeepSeek V4.1 Flash · OpenCode Go', desc: '响应快 · 支持视觉 · 272k 上下文 · 按用量计入每日额度（高峰 $0.44/$1.32，缓存 $0.014）' },
    api: {
      upstream: 'zenGo', wireModel: 'deepseek-v4.1-flash',
      // 不设 maxImages（09-11 站主拍板）。当年那个 4 是 vision-exp 的：09-07 实撞 Console Go "At most 4 image(s)"，第 5 张起每发 400。
      // v4.1 实测：5 / 8 / 16 / 32 / 60 张全 200；灰图堆里藏两张彩色（中间 + 最后），32 张、60 张两组都找得出来 = 没有静默丢图。
      // ⚠️ 弱项是**按序号点名**：32 张时说成"第 30 张"、60 张问三个位置的颜色会在思考里打转到 8000 token 截断。
      //   本站的图是工具回图 + 上下文，不靠序号，撞不到；真撞了先看这里，别急着把上限加回来。
      sdkAlias: 'claude-opus-4-7[1m]',   // kimi 退役腾出来的 1M 名；窗口由 CLAUDE_CODE_AUTO_COMPACT_WINDOW=272k 钉住
      // 08-26 从 ox-alpha-helper 改过来：Ox 整族下架（上游 401 "Model ox-alpha-free is not supported"），
      // 那条 helper 一起没了。⚠️ 这处失效**完全不出声** —— helper 角色 ingress 不推 onNotice、不报
      // onTruncated，用户只会觉得"标题没生成、压缩没做成"。改挂 08-25 建的通用 helper 行
      fastModel: 'deepseek-v4-flash-helper',
      thinking: 'strip',
      reasoningEffort: 'high',
      maxOutput: 128_000,
      prices: { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 },
    },
  },
  // ⛔ 退役行（`glm-5.3-flash` zenGo 08-27 撤、`glm-5.3-flash-zai` 官方直连 08-30 撤）：原注释与复牌配方见 model-table-retired.md
  // ── Merge 网关 · GLM-5.3-Flash（08-27）── 不做动态路由：每家各有各的 prompt cache，一个会话在几条线之间
  // 跳，跳一次几边都是冷的。本行实测：**只能** OpenAI chat（见上游注释）、prompt cache 真命中（9038 →
  // 第二发 cache_read 9024）、$0.015/$0.05 是全表最便宜的一档（08-27 撤掉的 zenGo 那条贵 10 倍）、6 并发
  // 全 200、count_tokens 有真数但仍关掉。跟已删的「zai 官方直连」那条的逐项对照表留在 git 里（08-30 之前）。
  // ── Merge 网关上的**两条** GLM 行（08-30 深夜拆开）：同模型、同网关、同价，**差别只有厂商** ──
  //   particle：内联图 **8 张是硬上限** —— n=8 ✅，n=9 起一律 400
  //     「GLM requests accept at most 8 inline PNG…」（9/10/12/16/20 全挂）。
  //   zai：n=4→20 全 ✅，且抽问第 1/10/16 张里印的词都念得出来 —— 是真读了，不是收下再悄悄丢。
  //   速度（28 万上下文、缓存 4/4 命中）：particle 每步 1.8-2.8s / 冷启 14.4s，zai 每步 3.9-7.0s / 冷启 20.6s。
  //     ⛔ 早前「只快 20%」是 6.5 万上量的，差距随上下文放大 —— **这类账必须在真实体量上量**。
  //   ⛔ 当时的结论「默认行走 zai（真会话一个就有 51 张图）、演出行走 particle」**09-08 作废**，见下面那段。
  // ⛔⛔ 留给下一个人的判据：**复验 particle 的图必须发 9 张以上。**08-30 白天那趟用三张图复测，
  //   得出「多图 400 已经没了 36/36」于是把默认改成 particle，上线 40 分钟就被真会话打回 ——
  //   那条限制不是没了，是从 1 张放宽到 8 张，三张的题目它根本不需要拦。同族老账见
  //   feedback-verify-the-instrument：判一道闸在不在，要给它一个它必须拦的东西。
  // ⚠️ particle 次要弱项：图散在多轮历史 + **请求没声明 tools** 时只看得见最后一张（20 发挂 8 发）；
  //   声明了 tools 就 20/20。本站请求永远带 tools，撞不到。
  // ⭐⭐ 真正决定「一步要等多久」的是**这一轮缓存命不命中**，不是挑了哪家：命中时上下文从 4.5 万
  //   涨到 28 万、延迟只从 5s 到 6.7s；不命中一路涨到 29s（compact 后必冷一轮，28 万 14-20s）。
  // vendors 的语义是「按顺序取第一个**可用的**」（OpenAPI 原话 "First available wins."）。
  // ⚠️ 「后备」含金量有限：实测**不在错误后转移**（`['zai','baseten']` 拿一个 zai 必拒的请求试，
  //   回 400 而不是转给 baseten）。particle 兜的是「zai 被标成不可用」那一档，不是「zai 这一发报错」。
  // ⛔ **baseten 不许进这两串**：同一发请求 usage.cost $0.000626，是 particle 的 48 倍、zai 的 11 倍。
  // ⛔ 「不指定让网关自己挑」是假出路：不点名实测 20/20 全落 zai，而网关的默认自己会变（08-28 裸请求
  //   8/8 落 particle）。它自带的 round_robin / least_latency / 策略 API 也不能用 —— **全是按请求选的，
  //   而 prompt cache 每家一份跨不过去**（同一前缀换一家 cached 立刻归 0、贵 5 倍）＝每轮都冷。
  //   ⏸ 曾按 sessionId 哈希做过会话粘性分配（`4939279`），撤了；要回来去那个 commit 拿。
  // ⛔⛔ **09-08 实测：zai 这家在网关上没了** —— 点名 `vendors:['zai']` 一律 503「temporarily unavailable
  //   due to recent provider failures」，**无图的纯文本也 503**，所以不是图的问题。而 vendors 是「取第一个
  //   可用的」，默认行**早就在走 particle**（x-merge-vendor 实锤），症状却是生产日志里四次「accept at most
  //   8 inline」400。→ 站主拍板：两行都点死 particle + 8 张的裁图闸（GLM_MERGE_API.maxImages）。
  //   ⭐ 判据：偏好序的后备是**静默**的，换了家只会在别的症状里露头；要知道谁在服务，看 x-merge-vendor
  //     或者点名单家看它 503 不 503。
  // ⭐⭐ **09-08 深夜点死 zai**（站主拍板）：不点名时网关来回换家、缓存冷（一轮五发两发命中 0）；particle 标价与 zai 相同且缓存从不命中。
  // ⛔⛔ **09-08 晚撤销点死 particle**：生产库里 09-07 起 GLM 行缓存命中率从 80–100% 掉到 0、每轮 API 耗时
  //   从 11–31 秒涨到 44–106 秒。直打网关同一段 100k 提示词各发两发：**particle 没有 prompt cache**（两发都不
  //   命中、首字节 31 秒、还吃过一次 429），zai 第二发命中 101,312 token、首字节 5 秒、价钱五分之一。zai 当晚
  //   已恢复。当时拍板不点名让网关自己路由；代价当晚就兑现了（来回换家、缓存冷），见上面「深夜点死 zai」。
  {
    // 08-30 起 **1M**（跟上面那行一起开，用户拍板）。网关目录里这个模型本来就写的 1000000
    // （max_output 131072），此前的 272k 是我们自己收的口。两条 glm 行同时改，换线时
    // auto-compact 的分母仍然一致，上下文条不会"换条线突然缩水"。
    // ⭐ 跟 zai 那行不同的是**这条有 prompt cache**（9038 → 第二发 cache_read 9024），
    // 所以窗口开大对它的边际成本温和得多：重传的部分大都按 $0.003/M 的缓存读走。
    id: 'glm-5.3-flash-merge', window: 1_000_000, brand: 'glm',
    standby: 'deepseek-v4-flash-vision',   // 上游连续失败/402 时会话级换线（ingress/session-routes switchSessionToStandby）
    // 08-27 用户拍板**直接对全员开**（含 basic）：跟 deepseek 视觉行同一套管法 ——
    // 它**不是免费行**（四价非 0），走的是每日美元额度，basic 的 $5/天 + 表价记账管着它，
    // 而这行的单价是全表最低的一档，同样的钱能跑十倍的量。
    // 08-28 之前这里写着"偶发瞎图约 7~10%"—— 那是没点名 vendor 时的账，点名之后 desc 里的
    // "偶尔会漏看图"已撤。要收回这行就在 select 里加 `gate: 'localGen'` 一处（三个消费方都走 selectableModelsFor）。
    // 08-30 desc 砍短：价格表撤进注释，picker 里只留"极便宜"这个判断。
    // ⭐⭐ **08-30 起接过全员默认**（zai 那条订阅额度耗尽撤行，用户拍板「默认丢到 merge 那边」）。
    // 这一脚**故意踩破了「默认行必须是免费行」那条规矩**，所以把破了之后各处怎么变写在这儿：
    // ① 钱：不再走 turn.js 的按轮次免费闸（300 轮/天），改走美元闸。真实单价按 zai 那行的
    //    token 画像折算 ≈ **$0.0023/轮**（均输入 31.6k / 输出 3.0k / 缓存读 567k），basic 的
    //    $5/天 ≈ 2000 轮 —— 比免费行的 300 轮/天还宽。**钱不是这次的风险**。
    // ② ⛔⛔ 并发才是：`checkConcurrency` 原来按"免费/付费"分档，付费行走
    //    NODESIGN_MAX_CONCURRENT_RUNS（.env 里是 **3**），免费行走 FREE_MAX（12）+ 内存闸。
    //    照原样改完，站点默认路径的并发天花板会从 12 掉到 3，而实测峰值在飞 turn 是 4 ——
    //    第 4 个人当场吃「现在有点挤」。所以同一刀把那道闸的判据改成**订阅/非订阅**：
    //    那个 3 从来是护站主 Claude 订阅的，不是护一个 $0.015/M 的网关（见 lib/quota.js）。
    // ③ 单点：厂商偏好序第一顺位是 zai（`vendors:['zai','particle']`），而网关**不在错误后转移**，
    //    所以那一家挂 = 全站默认路径挂；掉到 particle 也只有不带图的会话还能用（8 张上限）。
    // ⚠️ label 第二段是这两行**唯一**的区分（第一段一模一样）：`compactLabel` 按"撞不撞名"
    // 自己决定按钮上印长名还是短名，表里不用替它做这个决定，但第二段不能砍。
    select: { label: 'GLM-5.3-Flash · 设计', desc: '支持视觉 · 单次最多 8 张图片（更早的自动省略）· 1M 上下文 · 成本极低', default: true },
    api: { ...GLM_MERGE_API, bodyExtra: { vendors: ['zai'] } },
  },
  {
    // ⭐⭐ 08-30 深夜加的第二条（用户拍板「让 RP 和设计玩家对号入座」）。跟上面那行同模型同价，
    // 只是把厂商换成 particle：**每步更快，代价是内联图上限 8 张**（见上面那整段）。
    // ⭐ 拍板前先量了真会话，用户的直觉是对的：rp 模式 12 个会话图数 0/0/0/0/0/0/0/1/1/2/5/6 —— 
    //   一个都没到过 8；design 模式 25 个里有 7 个超过 8（9/9/10/11/21/31/51）。
    // ⚠️ 但最高那个 6 离 8 只差两张，所以撞线是迟早的事：转换层把那条 400 翻译成了
    //   「换到设计那条线」的人话（lib/ingress/upstream-error-hints.js），别把它删了。
    // ⛔ 不设 default —— 画布的默认永远是上面那条（图不限张数的那条兜得住所有人）。
    // ⭐ 09-06 用户拍板：**这行只在演出显示器的选择器里出现**（`only: 'stage'`），首页 / 画布的选择器
    //   不再分设计 / 演出；并且它是**没有订阅资格的账号在演出面的默认行**（`stageDefault`），
    //   有订阅资格的账号在演出面照旧走全局默认。两个字段的读者都在 model-context.js（scope 过滤 / 演出默认）。
    //   下架画布面时生产有 8 个画布会话钉着它 → server/scripts/migrate-canvas-model.mjs 改钉到 merge。
    id: 'glm-5.3-flash-rp', window: 1_000_000, brand: 'glm',
    standby: 'deepseek-v4-flash-vision',   // 上游连续失败/402 时会话级换线（ingress/session-routes switchSessionToStandby）
    select: { label: 'GLM-5.3-Flash · 演出', desc: '响应快 · 单次最多 8 张图片（更早的自动省略）· 1M 上下文 · 成本极低', only: 'stage', stageDefault: true },
    api: { ...GLM_MERGE_API, bodyExtra: { vendors: ['zai'] } },
  },
  // ⛔⛔ `minimax-m3` 09-08 撤行（GMI 没余额、限免结束）：原注释与迁移脚本用法见 model-table-retired.md
  {
    // 上游至少收 400k，这里按 272k 收口：跟 deepseek 行同一个理由（每轮重传全量上下文，出网流量要钱），
    // 而且实测延迟随上下文明显变长（260k 那发 24.9s、400k 那发 39.8s）。要放大改这一个数就行。
    id: 'kimi-k3', window: 272_000, brand: 'kimi',
    standby: 'glm-5.3-flash-merge',   // 上游连续失败/402 时会话级换线（ingress/session-routes switchSessionToStandby）
    // ⚠️ 先 gate localGen（admin + 获批），理由是**限流**：全站共用一把 nvapi 钥匙 = 一个限流桶，
    // 而 agent 一轮会连着发好几发。08-25 实测串行 5 秒间隔的小请求 6 发里就撞了 1 发 429。
    // 开闸只要删掉 gate 这一处（清单、PUT /model、turn.js 三个消费方都走 selectableModelsFor）。
    select: { label: 'Kimi K3（免费）', desc: '免费 · 支持视觉 · 272k 上下文 · 思考档 max，首字延迟较高 · 上游限流时会自动重试', gate: 'localGen' },
    api: {
      upstream: 'nvidia', wireModel: 'moonshotai/kimi-k3',
      // sdkAlias 不写 = 共用别名走会话路由（08-25 起的默认写法，见 SHARED_SDK_ALIAS）
      // helper 特意**不留在 NVIDIA**：那把钥匙的限流桶是全站共用的，标题/分类器那几发会跟主回合抢配额，
      // 交给 /zen/go 那条常驻的 helper 行（跨上游做 helper 有先例：deepseek 视觉行用的是 Ox 的 helper）
      fastModel: 'deepseek-v4-flash-helper',
      thinking: 'strip',            // 转换层按 reasoningEffort 发 thinking_effort，Anthropic 的 thinking 字段出口删掉
      // 三档 low|high|max（没有 medium）。给满档的理由是**这家限的是并发不是 token**（用户 08-25 拍板）：
      // 想多久都不额外花钱，那就别省。⚠️ 代价是首字更慢 —— Ox 那行的 max 在真会话里想过 4 分 20 秒才出
      // 第一个字（用户看到的是"只有绿点没有回复"），所以 desc 里写明了；而且想得久就占着并发槽更久，
      // 全站共用一把 nvapi 钥匙，这也是它先 gate localGen 的原因之一。想改回快档就是这一个字段。
      // helper 那行走自己的档（deepseek-v4-flash-helper 的 low），不受这里影响。
      reasoningEffort: 'max',
      prices: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },   // 开发者档不计费，真限流的是速率不是钱
    },
  },
  // ⛔ `minimax-m2.7` 行 08-25 当天加上又撤掉（用户拍板「2.7 撤了吧」）：**GMI 这家部署把图整个丢掉**。
  // 判据是 token 账不是模型的说法 —— 七种形态（Anthropic base64 图在前/文本在前、source.type=url、
  // OpenAI data:URI、OpenAI http URL、两个协议的纯文本基线）打过去，input_tokens **一律 47**，
  // 跟不带图的基线一个字节不差；同一趟 M3 是 27 → 561/667/703/809 且描述对得上真值。上游 200、不报错，
  // 模型只会说"我没看到图片" —— 静默丢弃。加上它比它自己慢一档（同题 M3 3s / M2.7 34s），
  // 本站整条感知栈（截图、板面渲染、生图回看）都靠工具回图，一个瞎子行只会让人踩坑。
  // 复牌就是照着 minimax-m3 那行写一份：wireModel 'MiniMaxAI/MiniMax-M2.7'、window 180_000、
  // 不写 sdkAlias（默认共用别名）、fastModel 'deepseek-v4-flash-helper'、thinking 'adaptive'、零价 —— 但先重跑一遍
  // server/lib/_gmi-check.mjs 的图那一项，确认这家换后端了再说。
  {
    // ── 通用 helper 行（08-25 晚，用户拍板"用 opencode 的 deepseek-v4-flash，这个坚挺"）──
    // 标题 / auto 分类器 / 摘要这类一句话的活。不进 picker。
    //
    // 为什么单独一行：session-loop 给 CLI 的 ANTHROPIC_SMALL_FAST_MODEL 是 **app id**，helper 请求
    // 因此带着这一行的 id 进来 —— 跟主行的名字不同，入口才分得出 role（同名就分不出，主行想多久
    // helper 跟着想多久）。
    //
    // ⭐ 为什么挂在 zenGo 而不是跟着主行走：**helper 要挑最耐久的那条线，不是最便宜的那条**。
    // GMI 的 MiniMax 是限时免费（免费期结束就 402），NVIDIA 的开发者档限流紧（429 说来就来，
    // 而且全站共用一把钥匙 = 一个限流桶，helper 会跟主回合抢），Ox 是随时可能下架的 stealth 行。
    // /zen/go 是按月订阅的池子，deepseek-v4-flash 是它目录里的常驻款。08-25 实测：1.3~2.3s、
    // reasoning_effort 三档都收、额度内 cost 报 "0"。
    //
    // ⚠️ 这条一挂上，**minimax-m3 就成了第一条"主行说 Anthropic、fast 行说 OpenAI"的会话**。
    // 值得担心的是转换层合成的 thinking 块没有 signature（08-21 记过：这种块回传给真 Anthropic 会
    // 400 invalid signature，crossLaneSwitchReason 那条闸就是为它装的）。08-25 专门探了一遍 GMI：
    // 空 signature / 没有 signature 字段 / 瞎编 32 字节，**三种都照收 200**（答案还对）——
    // 也就是这家不校验签名，这个配对是安全的。⛔ 换别的 Anthropic 原生上游做主行时要重探这一项。
    id: 'deepseek-v4-flash-helper', window: 272_000, brand: 'deepseek',
    api: {
      // ⛔ **必须是收图的模型**：08-25 实测同池的纯文本版 `deepseek-v4-flash` 一带图就 400
      // （上游原话 invalid_request / "does not support image"），而 helper 行接的**不只是标题** ——
      // auto-compact 要把整段对话（含工具回的截图）交给它，会话级路由还会把一切认不出的名字兜底改道过来。
      // 更坏的是这类失败**不出声**：ingress 对 helper 角色特意不推 onNotice / 不报 onTruncated
      // （model-ingress.js），用户只会觉得"标题没生成、压缩没做成"，日志里也难翻。
      // 对照实测：纯文本版 无图 200 / 有图 400；vision-exp 无图 200 / 有图 200。
      // 09-11 站主要求跟视觉行一起换 v4.1：Go 上的 `deepseek-v4.1-flash` 普通版就收图（纯色图答对、60 张不 400），
      // reasoning_effort low 实测照收。⚠️ 换回纯文本款之前先拿带图的请求打一发。
      upstream: 'zenGo', wireModel: 'deepseek-v4.1-flash',
      fastModel: 'deepseek-v4-flash-helper',   // 不写 sdkAlias，走共用别名
      thinking: 'strip',                       // 出口删 thinking 字段，档位由 reasoningEffort 发
      reasoningEffort: 'low',                  // 一句话的活不该想；实测 low 仍会想一两句，够短
      // ⚠️ 不设 maxOutput（走转换层默认 131072）：auto-compact 的摘要也走这一行，钉个小上限会把摘要
      // 静默截断 —— 而 helper 的截断标记恰恰是被压掉的那一路，出了事没有任何信号
      // Go 额度内上游报 cost="0"，真金额以上游为准（context.applyUpstreamBilling）；这里的表价是
      // 额度外的兜底与配额口径，先跟视觉那行同价（保守高估，helper 一次也就几百 token）
      prices: { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 },
    },
  },
]);
