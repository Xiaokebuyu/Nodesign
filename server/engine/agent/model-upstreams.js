/**
 * server/engine/agent/model-upstreams.js — API 上游注册表（2026-09-10 从 model-table.js 拆出）。
 *
 * 拆的理由跟当初 model-table.js 从 model-context.js 拆出来是同一条：那边顶到 600 行棘轮上了，
 * 而站点还要往模型表里加行。**上游**（一家 API 的地址/协议/钥匙/怪癖）和**模型行**（一个可选项
 * 的窗口/价/档）本来就是两件事，只是以前挤在一个文件里 —— 加行改这里的邻居，加家改这里。
 *
 * ⚠️ 导入路径没变：model-table.js 原样再导出一次，别处的 import 一个字都不用改。
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
    authStyle: 'bearer', sessionHeader: 'x-opencode-session',   // 09-06 OpenCode 来信：每发要带「一个会话一个稳定 ID」，缺了会报错；读者在 ingress/forward-openai-chat.js
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
  // ⛔ 09-08 起**没有行挂在它上面**（minimax-m3 撤了，见表里那段）。留着的理由跟 zen 一样：接法都探过了，
  //    下次要接这家照上面这段写一行就行。⚠️ 复牌前先看账户余额，09-08 之前它已经一路 402 了。
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
  // DeepSeek 官方（09-08 晚站主接的，钥匙 ~/apikey/deepseek-官方.md，按量 CNY 账户）：OpenAI 格式 base 是根路径不带 /v1，
  // 思考文本字段 reasoning_content、缓存命中在 usage.prompt_cache_hit_tokens（转换层两处都认）。09-10 上游换了目录：`GET /models` 现在只有
  // `deepseek-flash` 和 `deepseek-v4-pro`（预览名 v4.1-flash-expires-on-0910 今天到期、已不在目录里）。`deepseek-flash` 就是 V4.1 Flash。
  // 价目（api-docs 模型&价格页，CNY/百万，高峰=空闲两倍）：flash 输入 3.0 / 缓存命中 0.10 / 输出 9.0 → 按高峰 7.1 折 USD 记账。
  // 余额只有 /user/balance 能看（接入时 19.90 CNY），没有响应头。
  deepseek: Object.freeze({
    label: 'DeepSeek 官方 api.deepseek.com',
    baseUrl: process.env.NODESIGN_UPSTREAM_DEEPSEEK_URL || 'https://api.deepseek.com',
    keyEnv: 'NODESIGN_UPSTREAM_DEEPSEEK_KEY',
    authStyle: 'bearer',
    protocol: 'openai-chat',
    countTokens: false,
  }),
  // 基元律动 tokenrhythm.studio（09-08 晚，钥匙 ~/apikey/基元律动.md，CNY）：OpenAI 格式，/v1/models 自带价目（glm-5.3-flash 标价
  // 0.80/2.80/缓存 0.23 CNY/百万，接入时打折一半）；reasoning_content / cached_tokens 转换层都认；顶层 cost_cny 不认，按表价记。
  tokenrhythm: Object.freeze({
    label: '基元律动 tokenrhythm.studio',
    baseUrl: process.env.NODESIGN_UPSTREAM_TOKENRHYTHM_URL || 'https://tokenrhythm.studio/v1',
    keyEnv: 'NODESIGN_UPSTREAM_TOKENRHYTHM_KEY',
    authStyle: 'bearer',
    protocol: 'openai-chat',
    countTokens: false,
  }),
  zenGo: Object.freeze({
    label: 'OpenCode Zen Go',
    baseUrl: process.env.NODESIGN_UPSTREAM_ZEN_GO_URL || 'https://opencode.ai/zen/go/v1',   // 探针覆盖，同上
    keyEnv: 'NODESIGN_UPSTREAM_ZEN_KEY',
    authStyle: 'bearer', sessionHeader: 'x-opencode-session',   // 同 zen（同一家，同一封信）
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
