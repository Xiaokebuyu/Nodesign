/**
 * server/engine/agent/model-table.js — 内置模型表与上游注册表（**只放数据，不放逻辑**）。
 *
 * 08-22 从 model-context.js 拆出来：那边顶在 600 行棘轮上，而本地分发版要在内置行之外合并用户
 * 自己的插槽（runtime/local-config.js）。派生索引、断言、路由查表、picker 闸门全留在 model-context.js，
 * 它 import 这两张表再与外部行合并成 UPSTREAMS / MODELS。改行仍然只改这里；加一家 brand 也在这里。
 *
 * 字段说明见 model-context.js 文件头（两条通路 / spoofing / 记账）。
 */

/**
 * API 上游注册表。keyEnv 是 env 变量名（真钥匙在 .env，不进代码不进 git）。
 * authStyle：'x-api-key'（Anthropic 原生头）| 'bearer'（Authorization: Bearer）。
 * countTokens：上游有没有 /v1/messages/count_tokens。false = 入口直接本地估算；
 * true = 先转发，404 再回退本地（capability 探针缓存见 model-ingress.js）。
 */
export const UPSTREAMS_BUILTIN = Object.freeze({
  lament: Object.freeze({
    label: '中转站 api.lament0.link',
    baseUrl: 'https://api.lament0.link',
    keyEnv: 'NODESIGN_UPSTREAM_LAMENT_KEY',
    authStyle: 'x-api-key',
    countTokens: false,   // 08-19 探针：404
  }),
  // 本地盒子（featurize 租的 5090 跑 llama-server，SSH 隧道 -L 到本机）。
  // llama.cpp 2025-11-28 起原生带 /v1/messages（含 count_tokens、SSE、tool_use、
  // vision；工具调用要 --jinja）—— 不需要任何协议转换层。authStyle 'none'：
  // llama-server 无鉴权，隧道只绑环回。箱子不开机时请求 ECONNREFUSED → 502，
  // fail-loud 语义正确。
  qwenLocal: Object.freeze({
    label: '本地 llama-server（SSH 隧道）',
    baseUrl: process.env.NODESIGN_UPSTREAM_QWEN_LOCAL_URL || 'http://127.0.0.1:8080',
    keyEnv: null,
    authStyle: 'none',
    countTokens: true,
    // ⚠️ llama.cpp 的图片解码走 stb_image，**它不认 webp**。而本站 turn-compose 的
    // 白名单是放 webp 进来的（封面和截图链路正是产 webp）。解不开时 mtmd 会顺序
    // 兜底 image → audio → video，最后那条要 ffprobe，盒上没装，于是上游返回的是
    // 一句看不出真因的 400「Failed to load image or audio file」——
    // 08-19 生产真撞过两次，日志里翻到 mtmd_helper 才定位到。
    //
    // 声明成"这个上游真解得开什么"，入口负责把不在表里的转码过去（见
    // model-ingress.normalizeImages）。不填 = 什么都能吃，中转站那两个上游维持原样。
    imageFormats: Object.freeze(['image/png', 'image/jpeg']),
  }),
  // OpenCode Zen（08-21）：主入口 /zen/v1。这家**只有 OpenAI chat 格式能用工具**
  // （它的 /v1/messages 桥一带 tools 就 [1210]，四种写法探死）。protocol 'openai-chat'
  // 让 ingress 走 lib/ingress/openai-chat.js 的协议转换而不是透传；其余上游没有这个
  // 字段 = 透传 Anthropic。钥匙在 .env（NODESIGN_UPSTREAM_ZEN_KEY），两个入口同一把。
  // 今天没有行挂在它上面（内置行全在下面的 zenGo）；留着的理由是这家的**免费 stealth 行只在这个
  // 入口有**（Ox Alpha 曾经在这儿，08-26 下架；目录里换成了 big-pickle 那一批），下次要接免费行走这条。
  zen: Object.freeze({
    label: 'OpenCode Zen',
    // 覆盖旋钮跟 qwenLocal 同款，**只给探针用**（假上游跑真 ingress+转换层，见 _probe-truncation-e2e.mjs）；
    // 生产 .env 里不设 → 真地址。
    baseUrl: process.env.NODESIGN_UPSTREAM_ZEN_URL || 'https://opencode.ai/zen/v1',
    keyEnv: 'NODESIGN_UPSTREAM_ZEN_KEY',
    authStyle: 'bearer',
    protocol: 'openai-chat',
    countTokens: false,   // 08-21 探针：404
  }),
  // GMI Cloud（08-25）：算力平台，转卖各家开源权重的部署。**它自己就说 Anthropic 协议**
  // （`/v1/messages` 原生，不是桥）—— 08-25 用 server/_probe-upstream.mjs 体检 M3 拿 8/9：
  // 顶层图 ✓ / tool_result 图原样直通 ✓ / prompt cache 真命中 ✓ / 流式 tool_use 分片 ✓ /
  // max_tokens 128k 不炸 ✓，只差 count_tokens（404，入口本地估算兜底）。所以**不走
  // openai-chat 转换层**：同一条链路上少一层翻译就少一类 quirk。
  // ⚠️ 这个账户没有余额：付费模型（gemini/claude/gpt 那些它也转卖）一律 402 CreditsError，
  // 只有 is_free 的 MiniMax 两行能用 —— 也就是说踩错行不会静默花钱，会当场 402 fail-loud。
  // 钥匙是一枚 JWT（`~/apikey/gmicloud-API.md`），x-api-key 和 bearer 两种头实测都通，
  // 按平台文档取 bearer。
  gmi: Object.freeze({
    label: 'GMI Cloud api.gmi-serving.com',
    baseUrl: process.env.NODESIGN_UPSTREAM_GMI_URL || 'https://api.gmi-serving.com',   // ⚠️ 不带 /v1：透传路是 baseUrl + 原始路径
    keyEnv: 'NODESIGN_UPSTREAM_GMI_KEY',
    authStyle: 'bearer',
    countTokens: false,   // 08-25 体检：404
  }),
  // NVIDIA build（08-25）：NVIDIA 自己托管的一堆开源权重（102 个模型），开发者档拿 nvapi- 钥匙直接用。
  // ⛔ **只有 OpenAI 格式**：`/v1/messages` 和 `/v1/messages/count_tokens` 都是 404 → 走 openai-chat 转换层。
  // ⚠️ 免费档**限流很紧**：08-25 实测串行、间隔 5 秒的小请求里 6 发撞了 1 发 429（141ms 就回），
  // 大 body 的请求更容易撞。入口对 4xx 是原样透传状态码（forward-openai-chat.js），CLI 见 429 会退避重试、
  // 用户那边会收到「上游繁忙，正在自动重试」——能用，但别指望它当高频主力。
  // 延迟画像（同一趟实测 max_tokens=20 的小请求）：中位 772ms，但尾巴很长（单发见过 24.8s / 69s）。
  nvidia: Object.freeze({
    label: 'NVIDIA build integrate.api.nvidia.com',
    baseUrl: process.env.NODESIGN_UPSTREAM_NVIDIA_URL || 'https://integrate.api.nvidia.com/v1',
    keyEnv: 'NODESIGN_UPSTREAM_NVIDIA_KEY',
    authStyle: 'bearer',
    protocol: 'openai-chat',
    countTokens: false,   // 08-25 体检：404
  }),
  // 08-21 晚：Zen 第二入口 /zen/go（= OpenCode Go 订阅，$10/月换 $12/5h·$30/周·$60/月）。跟 'zen' 同一把钥匙、
  // **目录不同**（免费 stealth 行只在 /zen/v1，Go 目录里是常驻付费款）。响应带 `cost`（流式在 [DONE] 之后
  // 补 {"choices":[],"cost":"…"}）与 cached_tokens → lib/ingress/upstream-billing.js。今天内置的 API 行大半挂这儿。
  zenGo: Object.freeze({
    label: 'OpenCode Zen Go',
    baseUrl: process.env.NODESIGN_UPSTREAM_ZEN_GO_URL || 'https://opencode.ai/zen/go/v1',   // 探针覆盖，同上
    keyEnv: 'NODESIGN_UPSTREAM_ZEN_KEY',
    authStyle: 'bearer',
    protocol: 'openai-chat',
    countTokens: false,
  }),
  // Z.ai / 智谱官方（08-26）：站主自己的 **Coding Plan 订阅**钥匙。
  // ⚠️ 这把钥匙只认订阅入口：按量的 `/api/paas/v4` 一律 1113「余额不足」，
  // 能用的是 `/api/anthropic`（Anthropic 原生）和 `/api/coding/paas/v4`（OpenAI 格式）。
  // **它自己就说 Anthropic 协议**，所以不写 protocol = 透传，不过 openai-chat 转换层
  // （同 gmi 的理由：链路上少一层翻译就少一类 quirk）。
  //
  // 08-26 用 server/_probe-upstream.mjs 体检 glm-5.3-flash 拿 8/9：顶层图 ✓ /
  // **tool_result 图原样直通** ✓（不需要 liftImages）/ 流式 tool_use 分片拼得回 ✓ /
  // max_tokens 128k 不炸 ✓ / png+webp+jpeg 三种图都认 ✓；只差 prompt cache（没有）。
  //
  // ⛔⛔ **countTokens 必须是 false，而且理由跟别家不一样**：这家的 count_tokens
  // **不是 404，是恒回 `{"input_tokens":0}` 的桩**（同一段文本真实请求计 462）。
  // 入口对 `countTokens: true` 的语义是「先转发、404 才回退本地」—— 一个 200 的 0
  // 会被当真话传给 CLI，**auto-compact 就永远不触发**，会话一路涨到撞上游硬上限才 400。
  // 荒谬的数反而安全，这个"看起来是正常响应"的 0 才是最危险的那种。
  //
  // ⚠️ 并发上限 **3**（08-26 实测：并发 2/3 全过，并发 4 当场两发 429，0.5s 就回）。
  // 串行完美（10 次间隔 1s 全 200）—— 跟 GMI 那种"串行都掉一半"是两种病。
  // ⛔ 上游 `zai`（Z.ai / 智谱官方直连，Anthropic 原生透传）**2026-08-30 随它唯一那条行一起删**：
  // 站主那条包月订阅的额度耗尽了。删之前查过的两处（撤上游照这个查）：① 全表只有 glm-5.3-flash-zai
  // 一行挂在它上面；② 没有别的行的 fastModel 指着那一行（Ox 那次就是栽在这里，失效还不出声）。
  // 复牌配方：baseUrl `https://api.z.ai/api/anthropic`（⚠️ 不带 /v1，透传路是 baseUrl + 原始路径）、
  // keyEnv `NODESIGN_UPSTREAM_ZAI_KEY`、authStyle `x-api-key`（bearer 也通）、
  // ⛔ `countTokens: false` 必须留着 —— 这家的 count_tokens 不是 404 而是**恒回 0 的 200**，
  // 入口会把这个 0 当真话传给 CLI，auto-compact 就永远不触发，会话一路涨到撞上游硬上限才 400。
  // 并发上限 3（08-26 实测：2/3 全过，第 4 发当场 429）。
  // Merge Gateway（08-27）：**多厂商聚合网关**（api-gateway.merge.dev）。一个模型名后面挂着好几家部署
  // （GLM-5.3-Flash = particle + zai），网关自己挑，响应头 `x-merge-vendor` 说这一发是谁服务的。
  // ⭐⭐ 08-28 更正前一句「挑哪家决定不了」：**body 里写 `vendor: '<家名>'` 就能点名**，是硬闸而不是
  // 建议（写不存在的家回 400「Vendor 'nope' does not serve model」）。头 x-merge-vendor / x-vendor、
  // routing.vendor、模型名后缀 @zai/:zai 确实都不管用，上一趟试到这里就收工了 —— ⛔ 真正的失误是
  // **没读 `x-merge-vendor` 响应头**：判「点名成没成」的唯一判据就是它，而当时拿"答得对不对"当判据，
  // 那个量在轮盘下本来就时对时错。谁在服务这个模型：GET /v1/models?provider=zai 的 `vendors` 映射
  // （particle / zai / baseten），三家的能力位和单价分开声明（baseten 同模型贵 10 倍）。
  // 钥匙 `~/apikey/merge.md`（`mg_` 46 字符），bearer 与 x-api-key 都通，取 bearer。账只在响应头上：
  // `x-credit-balance-usd: 20.00` / `x-budget-limit-usd: 10.00`，**没有余额端点**（/v1/usage 等全 404）。
  //
  // ⛔ **08-30 更正上一段**：写的是**偏好序** `vendors:['zai','particle']` 而不是点死一家（见行内
  // bodyExtra 那段）。08-28 记的「particle 一次只收一张图」这条**部分作废**：上限从 1 张放宽到 **8 张**，
  // 8 张以内两家表现一致，第 9 张起 particle 一律 400 —— 所以 zai 打头的理由没变，只是换了个数。
  // → 08-27 记的「约 7~10% 瞎图」和「Anthropic 腿的图路死」，多半也是同一家当时的账，不是协议的账。
  // ⭐ 留给下一个人的判据：**厂商的能力位是会变的，别把一次实测当常量**；判"这家还瞎不瞎图"要
  // 重跑 `_merge-vendor-check.mjs`，别读注释。
  // 仍走 openai-chat：08-27 那趟它 27 发 25 对（Anthropic 腿当时 tool_result 里的图被当**文本**塞进去，
  // 10KB base64 → prompt 8300 token；那次没点名，归因存疑）。08-28 两条腿点名后复测表现相同 ——
  // 换腿不再被图挡着，但也没有换的理由，不动。
  //
  // count_tokens 这家**有**（回真数不是桩），仍写 false：走 openai-chat 的行不该从 Anthropic 端口取数，
  // 且实测对中文超收 1.67 倍（同段中文 count 1487 / 真实 892），跟本站本地估算一样偏高，取来不会更准。
  merge: Object.freeze({
    label: 'Merge Gateway api-gateway.merge.dev',
    baseUrl: process.env.NODESIGN_UPSTREAM_MERGE_URL || 'https://api-gateway.merge.dev/v1',
    keyEnv: 'NODESIGN_UPSTREAM_MERGE_KEY',
    authStyle: 'bearer',
    protocol: 'openai-chat',
    countTokens: false,   // 见上：不是没有，是不该从这条腿取
  }),
});

/**
 * 模型总表。字段：
 *   id       appModel —— 全站唯一标识（session-config / NODESIGN_MODEL / 计量落表都用它）
 *   window   真实 context window（ContextUsageBar 分母 + hooks 警告分档）
 *   select   出现在前端 picker 的 {label, desc}；没有 = 不对用户暴露
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
 * **差别只有厂商**（各自行里的 `bodyExtra.vendors`；为什么要分两行见表里那两行上方一整段）。
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

export const MODELS_BUILTIN = Object.freeze([
  // ── 订阅通路（Claude 真名，零注入）──
  {
    id: 'claude-sonnet-5[1m]', window: 1_000_000, brand: 'claude',
    select: { label: 'Sonnet 5', desc: '快 · 日常改稿和铺页够用', gate: 'subscription' },
  },
  {
    id: 'claude-opus-5[1m]', window: 1_000_000, brand: 'claude',
    select: { label: 'Opus 5', desc: '前端与审美更强 · 烧订阅额度快得多，重活再开', gate: 'subscription' },
  },
  { id: 'claude-sonnet-5',       window: 200_000, brand: 'claude' },
  { id: 'claude-opus-5',         window: 200_000, brand: 'claude' },
  { id: 'claude-opus-4-7[1m]',   window: 1_000_000, brand: 'claude' },
  { id: 'claude-sonnet-4-6[1m]', window: 1_000_000, brand: 'claude' },   // = SHARED_SDK_ALIAS（共用别名的本体行，删了它加载断言会炸）
  { id: 'claude-opus-4-7',       window: 200_000, brand: 'claude' },
  { id: 'claude-sonnet-4-6',     window: 200_000, brand: 'claude' },
  { id: 'claude-haiku-4-5',      window: 200_000, brand: 'claude' },
  // 只当 alias 用的订阅名（08-20）：SDK 二进制认识的 1M 名里还空着的一个（strings 扫过：
  // opus-4-6/4-7/4-8/5、sonnet-4-5-20250929/4-6/5 七个 [1m]），给 gemini-3.7-flash 行做 spoof。
  { id: 'claude-opus-4-6[1m]',   window: 1_000_000, brand: 'claude' },
  // 08-21 给 ox-alpha 做 spoof，08-26 随 Ox 整族下架**空出来**（行留着：它是 SDK 认识的 1M 名，是坑位不是垃圾）
  { id: 'claude-opus-4-8[1m]',   window: 1_000_000, brand: 'claude' },
  // 同上，08-21 晚给 ox-alpha-max，08-26 也空出来了
  { id: 'claude-sonnet-4-5-20250929[1m]', window: 1_000_000, brand: 'claude' },
  // 独占 alias 池现状（08-26 更新）：opus-4-6[1m]→gemini-3.7-flash、opus-4-7[1m]→deepseek-v4-flash-vision、opus-5[1m]→qwen；
  // **空着三个**：opus-4-8[1m]、sonnet-4-5-20250929[1m]、haiku-4-5（Ox 三行 08-26 下架腾出来的）；
  // sonnet-5[1m] 是订阅默认行不许被路由；**sonnet-4-6[1m] = SHARED_SDK_ALIAS**（共用别名，永远不许被独占）。
  // ⚠️ 空出来不等于新行该去占：08-25 起加新行的默认写法就是**不写 sdkAlias**（走共用别名 + 会话级路由），
  // 这三个坑位留给真正需要"没会话也能按 alias 反查"的场合（探针、跨进程重放那类）。

  // ── API 通路 ──
  // kimi-k2.6 行与 moonshot 上游 08-21 深夜清掉（用户：「把 kimi 3.1pro 的槽都清理一下」）：NoDesk 退役后没走过流量，
  // 它的 alias claude-opus-4-7[1m] 转给 deepseek-v4-flash-vision。'enabled8k' 的 thinking 档逻辑留在 transformForUpstream 里备用。
  // 本地 Qwen（HauhauCS/Qwen3.8-27B-Uncensored-…-Aggressive-MTP-GGUF，底座官方
  // Qwen3.8-27B，有视觉）。⚠️ window 必须跟箱子 llama-server 的 -c 一致：低了
  // 会在 SDK 触发 auto-compact 之前先撞上游 400。262144 = 该模型原生上限
  // （YaRN 可外推到 1M，但那要额外开 rope 参数且短上下文质量有代价，不默认走）。
  // alias 用 1M 档：SDK 按 alias 查 rawMaxTokens，用 200k 名会让 auto-compact 在
  // ~180k 就触发，白扔 80k。⚠️ 这个 alias 同时是线上可选的订阅模型名，安全性靠两点
  // （改动前先确认它们还成立）：①订阅会话根本不进 ingress，WIRE_LOOKUP 只服务
  // API 会话；②repriceUsageDeltas 先看会话通路，订阅会话原样早退不 remap。
  {
    // window 必须等于盒上 llama-server 启动日志里的 `n_ctx_slot`（每槽上下文），低了 SDK
    // 在 auto-compact 之前先撞上游 400。08-20 起盒子是 RTX 5090 32G：OrcaRouter Q5_K_M +
    // 视觉 + MTP 投机 + 1 槽 × 131072，再留 ~5G 给同卡的 ComfyUI（noobai）。换回 96G 盒子
    // 就是 262_144 × 3 槽。盒上配置住 ops/qwen-box/（serve-prod.sh），两边要一起改。
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
    // 08-20 用户拍板：要 3.7 Flash，先用中转站 + lift shim 顶着。它只在中转站的「反重力-」
    // 通道上有（转卖 Antigravity OAuth 额度），今天体检 6/9：文本/视觉/非流式 tool_use/
    // prompt cache 真命中（cache_read 8162）都好；流式 stop_reason 恒=end_turn（假上游实验证明
    // CLI 认块不认 stop_reason，无功能后果）；tool_result 图丢靠 liftImages 修。⛔硬伤是
    // 「当前无可用凭证」500 说来就来、不分请求大小、一来就是整段时间 —— 所以同 qwen 走
    // localGen 闸，label 写明不稳定，只给自己人。思考档在模型名里（-high/-medium/-low），
    // 选 high 即"默认高"；thinking 参数照旧 strip。
    select: { label: 'Gemini 3.7 Flash（中转）', desc: '反重力通道 · 随时可能 500 · 思考档 high', gate: 'localGen' },
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
    // 真窗口 1M；用户 08-21 深夜拍板压缩窗口 272k（省钱：携带成本 ≈ 1M 的 1/4、缓存失手最坏 $0.12/轮；近 14 天 649 回合只压缩过 11 次）
    id: 'deepseek-v4-flash-vision', window: 272_000, brand: 'deepseek',
    // 08-21 深夜开闸给所有档（含 basic）：basic 的 $5/天日限 + 表价记账管着它；pro/admin 不限
    select: { label: 'DeepSeek V4 Flash · 视觉', desc: '快 · 有视觉 · 272k 上下文 · 按用量计入每日额度（高峰 $0.44/$1.32 缓存 $0.014）' },
    api: {
      upstream: 'zenGo', wireModel: 'deepseek-v4-flash-vision-exp',
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
  // ⛔ `glm-5.3-flash`（/zen/go 上那条，08-26 接替下架的 Ox Alpha）**08-27 撤掉**：用户拍板。
  // 同一个模型现在还有两条线（下面的 zai 官方直连、再下面的 merge 网关），而这条是三条里最贵的
  // （$0.15/$0.50 缓存 $0.03，是 merge 那条的十倍），留着只会让人在 picker 里挑错。
  // 撤之前查过的两处（下次删行照这个查）：① 全表没有别的行的 fastModel 指着它（Ox 那次就是栽在这里，
  // 失效还不出声）；② 生产累计只跑过 9 个 run（$0.26），session-config 里钉着它的会话只有 2 个 ——
  // 那两个会拿到 403 MODEL_NOT_ALLOWED（「这个会话指向的模型现在不可用，请换一个」），fail-loud，
  // 表里没有"退役 → 继任"的映射，也**不会**静默落到订阅通路。
  // ⚠️ 上游 `zenGo` 本身留着：deepseek 视觉行和全站唯一的 helper 行都挂在它上面。
  // 复牌就是照下面两条 glm 行的形状写一份：upstream 'zenGo'、wireModel 'glm-5.3-flash'、
  // 窗口跟那两行取同一个数（08-30 起是 1M）、thinking strip、reasoningEffort high、
  // maxOutput 131072、prices 0.15/0.50/0.03/0。
  // ⛔⛔ `glm-5.3-flash-zai`（Z.ai 官方直连，08-26 接替下架的 Ox、08-27 起当全员默认行）
  // **2026-08-30 撤掉：站主那条包月订阅的额度耗尽了**。
  // ⭐ 撤的时候上游原话是：`[1310][Weekly/Monthly Limit Exhausted. Your limit will reset at
  // 2026-09-03 02:23:20]` —— **不是订阅到期，是周/月配额用尽，09-03 会自己重置**。
  // 所以这不见得是永别：09-03 之后想复牌，照下面的配方把行和上游加回来、.env 里那行钥匙
  // 去掉 # 即可。⚠️ 但复牌**不等于自动拿回默认**：`default: true` 现在在 merge 那行上，
  // 而且"默认行是谁"有三条断言钉着（见 model-context.test.js），要挪得先在那儿绊一下。
  // ⚠️ 也别忘了它每周都会再耗尽一次 —— 真要长期当默认，得先想清楚"配额用尽那天怎么办"，
  // 这次的答案是人工撤行，那不是个能每周做一遍的答案。这一行从 08-26 起就写着「用完就撤」，
  // 撤法也提前写好了，这次是照着执行的：删行 + 删上游 zai + 删 .env 的 NODESIGN_UPSTREAM_ZAI_KEY
  // + **同一个动作把 `default: true` 挪走**（那条代价当时就点名了：不挪的话新会话第一轮就落在
  // 一个不存在的行上，而"默认行必须免费"那条断言拦不住这一种 —— 它只看价，不看这行还在不在）。
  // 撤之前查的两处照旧：① 没有别的行的 fastModel 指着它；② 只有它挂在上游 zai 上。
  // 钉着它的 15 个会话（13 个项目、大多是真的 basic 用户）**改钉到下面那条 merge 行** ——
  // 同一个模型，对话中途不换性格；不清空钉子是因为清了会落到 NODESIGN_MODEL 的订阅行，
  // basic 用户照样 403。表里仍然没有"退役 → 继任"的自动映射，那是数据迁移不是代码。
  // 复牌配方（上游注释里那份没删）：upstream 'zai'、wireModel 'glm-5.3-flash'、窗口跟 merge 行取同一个数、
  // thinking 'strip'（⚠️ budget_tokens 在这家不管用，要"不想"走 disabled）、liftImages false、
  // maxOutput 131072、四价全 0、fastModel 'deepseek-v4-flash-helper'（helper 特意不留在这家：并发桶只有 3）。
  // ── Merge 网关 · GLM-5.3-Flash（08-27）── 同一个模型的**第三条线**。照 08-26 那次的判断做成独立行、
  // 不做动态路由：三家各有各的 prompt cache，一个会话在几条线之间跳，跳一次几边都是冷的。
  // 三条线的实测差别（都是真跑出来的，不是抄文档；接第四条时照这个格式对账）：
  //                zai 官方直连（默认行）      merge 网关（本行）
  //   协议         Anthropic 原生透传          **只能** OpenAI chat（见上游注释）
  //   prompt cache **没有**                    真命中（9038 → 第二发 cache_read 9024）
  //   花钱         包月订阅，记 0（限时）       **$0.015/$0.05**，真金白银但全表最便宜的一档
  //   并发         **上限 3**                  6 并发全 200（15.8s，没撞到上限）
  //   视觉         稳                          **约 7~10% 的请求会瞎**（厂商轮盘，见上游注释）
  //   count_tokens 恒 0 的桩 → 关掉             有且回真数，但仍关掉（理由见上游注释）
  // 08-27 撤掉的 zenGo 那条（$0.15/$0.50）是三条里最贵的，本行的输入价是它的 1/10：
  // 满窗一轮的缓存读从 $0.03 掉到 $0.003。**zai 那条订阅用完之后，这条是接得住量的那一条**
  // （有缓存、并发不紧），只是接默认之前得先解决瞎图那 7~10%（或者接受它）。
  // ── Merge 网关上的**两条** GLM 行（08-30 深夜拆开）：同模型、同网关、同价，**差别只有厂商** ──
  //   particle：内联图 **8 张是硬上限** —— n=8 ✅，n=9 起一律 400
  //     「GLM requests accept at most 8 inline PNG…」（9/10/12/16/20 全挂）。
  //   zai：n=4→20 全 ✅，且抽问第 1/10/16 张里印的词都念得出来 —— 是真读了，不是收下再悄悄丢。
  //   速度（28 万上下文、逐轮追加、缓存 4/4 命中）：particle 每步 1.8-2.8s / 冷启 14.4s，
  //     zai 每步 3.9-7.0s / 冷启 20.6s，5 轮同价 $0.00787。⛔ 早前「只快 20%」是 6.5 万上量的，
  //     差距随上下文放大 —— **这类账必须在真实体量上量**。
  //   → 默认行（设计）走 zai：真会话一个就有 51 张图，图多是这个产品的主路径不是边角。
  //     演出行走 particle：rp 模式的会话实测最多 6 张图（见那行的注释）。
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
  {
    // 08-30 起 **1M**（跟上面那行一起开，用户拍板）。网关目录里这个模型本来就写的 1000000
    // （max_output 131072），此前的 272k 是我们自己收的口。两条 glm 行同时改，换线时
    // auto-compact 的分母仍然一致，上下文条不会"换条线突然缩水"。
    // ⭐ 跟 zai 那行不同的是**这条有 prompt cache**（9038 → 第二发 cache_read 9024），
    // 所以窗口开大对它的边际成本温和得多：重传的部分大都按 $0.003/M 的缓存读走。
    id: 'glm-5.3-flash-merge', window: 1_000_000, brand: 'glm',
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
    select: { label: 'GLM-5.3-Flash · 设计', desc: '有视觉 · 图不限张数 · 1M 上下文 · 极便宜', default: true },
    api: { ...GLM_MERGE_API, bodyExtra: { vendors: ['zai', 'particle'] } },
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
    select: { label: 'GLM-5.3-Flash · 演出', desc: '每步更快 · 但整场最多 8 张图 · 1M 上下文 · 极便宜', only: 'stage', stageDefault: true },
    api: { ...GLM_MERGE_API, bodyExtra: { vendors: ['particle'] } },
  },
  // ── GMI Cloud · MiniMax（08-25）── 两行都是 GMI 标 `is_free` 的免费部署；账户无余额，付费行 402，
  // 所以这条上游不存在"选错模型静默烧钱"。目录价（免费期结束后才会真收）：M3 $0.60/$2.40 缓存 $0.12，
  // **prompt 超过 512k 单价翻倍**（$1.20/$4.80）；M2.7 $0.30/$1.20 缓存 $0.06。今天一律记 0。
  {
    // 真窗口 1048576。272k 是用户 08-25 拍板的档（跟 deepseek 行同一个理由：每轮都要重传全量上下文，
    // 这台机器的出网流量超 200GiB/月要真付钱；且正好落在 GMI「512k 以上翻倍」那道价格坎下面）。
    id: 'minimax-m3', window: 272_000, brand: 'minimax',
    // 08-26 到 08-27 当过全员默认，08-27 把 `default: true` 交给 zai 那条官方直连（用户拍板）：
    // 这条上游 08-26 实测串行 4/8 大面积限流（当天生产日志 106 次 429），当默认不够好。
    // ⭐ 它仍是**候补默认**：四价全 0 = modelIsFree，公开注册号的经营态靠的是免费行走 turn.js 的
    // 按轮次闸而不是金额闸 —— zai 那条订阅用完撤掉的那天，`default: true` 要么回到这里，
    // 要么去别的四价全 0 的行（⛔ 不许落在付费行：那等于公开注册就直接烧钱）。
    // ⚠️ 这行的免费是 GMI「限时免费部署」，免费期一结束这条候补也不成立了
    select: { label: 'MiniMax M3（免费）', desc: '免费 · 有视觉 · 272k 上下文 · 自己决定想多久' },
    api: {
      upstream: 'gmi', wireModel: 'MiniMaxAI/MiniMax-M3',
      // 不写 sdkAlias = 共用别名（SHARED_SDK_ALIAS）走会话级路由：会话认得出，
      // 全表反查认不出（探针要带会话前缀）。独占 1M 坑位 08-25 起已满员，新行都走这条默认路。
      fastModel: 'deepseek-v4-flash-helper',
      // ⭐ M3 的思考是**开关不是档位**：GMI 部署实测 adaptive（模型自己决定想不想、想多久）/
      // disabled（不想）/ enabled+budget（每轮强制想）三种都收，但没有 low|medium|high 这套档。
      // 本站给 API 行一律发 enabled+8192（pickThinkingConfig），对 M3 等于每一轮都强制想 ——
      // agent 的活大半是"读文件、调工具"这种不值得想的，所以出口改写成 adaptive。
      thinking: 'adaptive',
      liftImages: false,   // 08-25 体检 3b：tool_result 里的图**原生直通**（跟 llama.cpp 一样），不需要提升
      prices: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  },
  // ── NVIDIA build · Kimi K3（08-25）── 免费开发者档，08-25 体检（裸 OpenAI 协议）：
  // 文本 ✓ / 工具（含回程 tool 消息）✓ / **视觉真的有** ✓（判据是 token 账：同一张图 prompt_tokens 98 → 322
  // 且答出图里的 ND-7342 与黄色三角）/ 流式含 reasoning_content 与 tool_calls 增量、末块带 usage ✓ /
  // prompt cache 命中（8101 里缓存 3072）✓ / 上下文实测 **40 万 token 照收**（260k/400k 两档都 200）。
  // ⛔ 没有 /v1/messages 也没有 count_tokens（都 404）→ 走 openai-chat 转换层 + 入口本地估算。
  // ⛔ 思考档是 **low | high | max** 三个值（上游 400 的原话：`Unsupported Kimi K3 thinking_effort="medium"`），
  // 跟 Ox 一样，所以 medium 别写。
  {
    // 上游至少收 400k，这里按 272k 收口：跟 deepseek 行同一个理由（每轮重传全量上下文，出网流量要钱），
    // 而且实测延迟随上下文明显变长（260k 那发 24.9s、400k 那发 39.8s）。要放大改这一个数就行。
    id: 'kimi-k3', window: 272_000, brand: 'kimi',
    // ⚠️ 先 gate localGen（admin + 获批），理由是**限流**：全站共用一把 nvapi 钥匙 = 一个限流桶，
    // 而 agent 一轮会连着发好几发。08-25 实测串行 5 秒间隔的小请求 6 发里就撞了 1 发 429。
    // 开闸只要删掉 gate 这一处（清单、PUT /model、turn.js 三个消费方都走 selectableModelsFor）。
    select: { label: 'Kimi K3（免费）', desc: '免费 · 有视觉 · 272k 上下文 · 思考档 max，首字可能等 · 上游限流，偶尔要等自动重试', gate: 'localGen' },
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
      // ⛔ **必须是 -vision-exp 那个变体**：08-25 实测同池的纯文本版 `deepseek-v4-flash` 一带图就 400
      // （上游原话 invalid_request / "does not support image"），而 helper 行接的**不只是标题** ——
      // auto-compact 要把整段对话（含工具回的截图）交给它，会话级路由还会把一切认不出的名字兜底改道过来。
      // 更坏的是这类失败**不出声**：ingress 对 helper 角色特意不推 onNotice / 不报 onTruncated
      // （model-ingress.js），用户只会觉得"标题没生成、压缩没做成"，日志里也难翻。
      // 对照实测：纯文本版 无图 200 / 有图 400；vision-exp 无图 200 / 有图 200。
      upstream: 'zenGo', wireModel: 'deepseek-v4-flash-vision-exp',
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
