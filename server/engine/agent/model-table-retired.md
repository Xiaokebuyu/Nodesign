# model-table 退役行档案（从 model-table.js 搬出来，2026-09-08）

行数棘轮 600 行只留现役；下面是撤掉的行的原注释，复牌配方在里面。

```
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

  // ⛔⛔ `minimax-m3`（GMI Cloud 上的免费部署，08-25 接进来、08-26 当过一天全员默认）**09-08 撤行**：
  // 站主拍板。GMI 那个账户没余额，而这家的「限时免费」在 09-08 之前就结束了 —— 生产日志里 01:34 /
  // 01:45 / 01:46 / 04:19 / 05:35 一路 402「Insufficient balance / model_access_denied」，
  // 也就是说它已经是个**点了必失败**的选项。撤之前查的三处（撤行照这个查）：
  //   ① 没有别的行的 fastModel 指着它（它自己的 fast 是 deepseek-v4-flash-helper）；
  //   ② 只有它挂在上游 gmi 上 → 那条上游今天没有行了（留着，接法见上游注释）；
  //   ③ 生产上 12 个会话钉着它 → `node server/scripts/migrate-canvas-model.mjs --from minimax-m3
  //      --to glm-5.3-flash-merge --apply` 改钉到默认行（⛔ 不能清空钉子：清了落到 NODESIGN_MODEL
  //      的订阅行，basic 用户照样 403 —— 08-30 zai 下架时的同一课）。
  // ⚠️ 连带后果（站主 09-08 知情拍板）：**公开注册号从此没有免费行**（kimi-k3 是 gate 住的），全部走
  //   美元闸。默认行 glm 一轮 ≈$0.0023，basic 的 $5/天 ≈ 2000 轮，比原来的免费轮次闸还宽。
  // 复牌配方：upstream 'gmi'、wireModel 'MiniMaxAI/MiniMax-M3'、window 272_000（真窗口 1048576，收在
  //   GMI「512k 以上翻倍」那道价格坎下面）、brand 'minimax'、fastModel 'deepseek-v4-flash-helper'、
  //   thinking 'adaptive'（这家的思考是开关不是档位，发 enabled+budget 等于每轮强制想）、liftImages
  //   false（tool_result 里的图原生直通）、四价全 0。⚠️ 复牌前先确认 GMI 账户有没有余额。
  // ── NVIDIA build · Kimi K3（08-25）── 免费开发者档，08-25 体检（裸 OpenAI 协议）：
  // 文本 ✓ / 工具（含回程 tool 消息）✓ / **视觉真的有** ✓（判据是 token 账：同一张图 prompt_tokens 98 → 322
  // 且答出图里的 ND-7342 与黄色三角）/ 流式含 reasoning_content 与 tool_calls 增量、末块带 usage ✓ /
  // prompt cache 命中（8101 里缓存 3072）✓ / 上下文实测 **40 万 token 照收**（260k/400k 两档都 200）。
  // ⛔ 没有 /v1/messages 也没有 count_tokens（都 404）→ 走 openai-chat 转换层 + 入口本地估算。
  // ⛔ 思考档是 **low | high | max** 三个值（上游 400 的原话：`Unsupported Kimi K3 thinking_effort="medium"`），
  // 跟 Ox 一样，所以 medium 别写。
```

## 2026-10-11 撤 zenGo 上的两条可选行（OpenCode Go 订阅停了）

上游原话：`403 Upstream request failed: An active OpenCode Go subscription is required to use Go models.`（两个模型都是）。
撤之前查的两处照旧：① 别的行的 fastModel 没有指着这两行（都指着 helper 行，helper 行同日挪到 Merge 网关的 GLM）；
② 指着 `deepseek-v4-flash-vision` 当 standby 的三行同日改掉（官方直连 DeepSeek → glm-5.3-flash-merge；两条 Merge GLM 行不再有 standby）。
钉着这两行的会话用 `server/scripts/migrate-canvas-model.mjs --from <id> --to glm-5.3-flash-merge --apply` 改钉。
`deepseek-v4-flash-vision` 占过的独占别名 `claude-opus-4-7[1m]` 一并腾出。复牌：把下面两行原样贴回 model-table.js，
并把 helper 行与 standby 的去向按当时哪条线最耐久重新定。

```
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
      efforts: ['low', 'high', 'max'],   // 用户可选的思考等级（09-13）：zen 系 low|high|max 三档
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
      efforts: ['low', 'high', 'max'],   // 用户可选的思考等级（09-13）：zen 系三档；low 在同上游 helper 行上实测照收
      maxOutput: 128_000,
      prices: { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 },
    },
  },
```

### 同日：helper 行（`deepseek-v4-flash-helper`）挪走之前的样子

```
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
```
