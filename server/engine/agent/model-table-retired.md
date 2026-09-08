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
