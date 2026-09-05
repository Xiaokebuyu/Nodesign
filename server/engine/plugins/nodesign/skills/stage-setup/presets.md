# 写法预设的模块表（给主循环预选用）

`open_stage` 的 `style: { preset, on: [...], off: [...] }`：`on` 在默认勾选之上加开，`off` 关掉。
互斥组（标 ★）里开一个，机器自动关掉同组默认的；总是开的组（标 ●）关不掉。玩家开场页会看到「agent 预选了这些，你可以改」。

## 用户的话 → 该动哪个开关（对照表，只在他**说了**才动，没说就不传）

| 用户大概会说 | 动作 |
|---|---|
| 慢一点 / 多写日常 / 别急着推 | `on: ["pace-slow"]` |
| 快点 / 无聊的跳过 | 默认就是 `pace-skip`，不用动 |
| 别乱转折 / 按我说的走 | `on: ["twist-steady"]` |
| 可以不听我的 / 来点意外 | `on: ["twist-allow"]`；要更疯 `twist-wild` |
| 多点对白 / 少点描写 | `on: ["dlg-high"]`（少一点 `dlg-low`，纯对白 `dlg-only`） |
| 第一人称 / 用"我" | `on: ["person-1-you"]`（第二人称 `person-2`；对方视角 `person-1-char`） |
| 短一点 / 长一点 | `on: ["len-short"]` / `on: ["len-long"]` |
| 像轻小说 / 像武侠 / 像网文 / 像金庸… | `on: ["voice-<见下表>"]`，只开一个 |
| 别替我说话 / 我的角色我自己来 | 这是代笔档，写进台面，不动预设 |
| 难度 | 写进台面，不动预设 |
| 不要斜体心理描写 | `off: ["char-psych-italic"]` |
| 别切镜头 / 只写我这边 | `off: ["plot-cutaway"]` |
| 他给了自己的酒馆预设 JSON | 文件放 `<戏>/预设/<名>.json`，`preset: "user:<名>"`，别传 on/off |
| 想要更文学的质地 | `preset: "literary"` |

## `izumi` · Izumi（泉此方预设）

### 通用规矩 ●
- `core-persona` 有限视角与常识（默认开）
- `core-writing` 行文通用规矩与禁词（默认开）

### 叙事
- `plot-surprise` 反直觉 — 无聊时多写合理又好玩的展开（默认开）
- `plot-cutaway` 镜头可切走 — 你这边没事时去写别人那边（默认开）
- `plot-objective` 客观叙事 — 纯冰山写作，不插主观评论
- `plot-no-godlike` 你不是世界中心 — 其他角色不一定给你面子
- `plot-bright` 角色不阴暗 — 和谐有爱的基调
- `plot-expand-input` 扩写你的输入 — 改动最少地把你的话写通顺（默认开）

### 转折 ★
- `twist-steady` 稳推 — 不突然转折，不加新角色
- `twist-allow` 允许转折 — 合乎逻辑时可以不完全听话
- `twist-wild` 放飞 — 逻辑成立就多离谱都行

### 节奏 ★
- `pace-slow` 慢推 — 节奏贴近现实，重互动
- `pace-skip` 跳过无聊 — 无聊处直接跳时间（默认开）

### 怎么接你的话 ★
- `input-retell` 转述 — 把你的话当作将要发生的事写出过程（默认开）
- `input-continue` 直接续写 — 把你的话当已发生，从末尾往下写

### 人称 ★
- `person-3` 第三人称（默认开）
- `person-2` 第二人称
- `person-1-you` 你的第一人称
- `person-1-char` 对方的第一人称

### 对白占比 ★
- `dlg-low` 少 — 两成以上
- `dlg-mid` 中 — 四成以上
- `dlg-high` 多 — 七成以上
- `dlg-only` 纯对白

### 人物
- `char-no-tone` 不写语气 — 对白前后不跟声音描写（默认开）
- `char-lean-action` 防过度描写 — 动作只写白描
- `char-strict` 只按设定塑造 — 不揣测、不夸张人设
- `char-psych-italic` 心理描写用斜体（默认开）

### 每段篇幅 ★
- `len-short` 短 — 400 字上下
- `len-mid` 中 — 700 字上下（默认开）
- `len-long` 长 — 1200 字上下

### 文风（只选一种） ★
- `voice-smooth` 顺眼舒服 — 通用、切换丝滑：生活化直白，剧情实质推进（默认开）
- `voice-adaptive` 自适应叙事 — 把正文当电影拍：平淡处纯白描，有趣处加主观情感
- `voice-kamishibai` 纸芝居口述 — 全知叙事者绘声绘色讲故事，口语为底
- `voice-lightnovel` 日轻小说 — 恋爱拉扯，自由间接文体，对白单独成段用「」
- `voice-zero` 零度写作与自由间接引语 — 客观呈现事实，强烈情绪时切入角色第一人称
- `voice-wuxia` 武侠 — 古风含蓄，战斗凌厉
- `voice-deadpan` 英式冷面幽默 — 克制的文字写骨感的现实，明褒暗贬
- `voice-minguo` 民国物哀 — 张爱玲式颓废物哀，半文半白，租界摩登
- `voice-webnovel` 中文网文 — 简单口语长段落，只写重点，每段结尾吊胃口
- `voice-stream` 意识流（冷意识） — 思维的实时记录，独白承载一切
- `voice-tempo` 节奏大师（四阶段） — 平推处零度写作，爆点才火力全开
- `voice-theatre` 舞台剧 — 对白驱动一切，只记录动作与现象
- `voice-luxun` 鲁迅式冷峻白描 — 白描是尖刀，讽刺是显影液
- `voice-wangxiaobo` 王小波式黑色幽默 — 逻辑是骨架，幽默是血肉
- `voice-jiangnan` 江南 — 多人称，抒情与克制并存
- `voice-iruma` 入间人间 — 第一人称，日常里的错位与冷感
- `voice-fushimi` 伏见司 — 第一人称轻小说节奏
- `voice-jinyong` 金庸 — 古典白话，招式写动线
- `voice-gulong` 古龙 — 短句、留白，气氛先于招式
- `voice-kawabata` 川端康成（物哀） — 感觉先于情节，留白与暗示
- `voice-maeda` 麻枝准（Key 社） — 日常与非日常的情感反差
- `voice-kamachi` 镰池和马（战斗） — 高密度战斗与设定
- `voice-radio` 广播剧 — 以声音和对白为核心
- `voice-akira` 日日日 — 轻小说，跳脱与冷感

### 动笔前先想什么 ★
- `think-fluent` 注重流畅 — 先理清楚谁知道什么（默认开）
- `think-persona` 注重人设
- `think-plot` 注重剧情
- `think-brief` 简洁

### 附加
- `extra-parallel` 平行事件 — 每段末尾附一两件你视角外正在发生的事
- `extra-jp` 日语双语对白
- `extra-female` 女性向适配

## `literary` · 文学派（专家预设）

### 文学逻辑与句法 ●
- `logic` 文学逻辑（默认开）
- `sentence` 句法（默认开）

### 写法（只选一种） ★
- `emergent` 涌现式叙事 — 具体、不吝笔墨，多感官，发声必写台词（默认开）
- `exhaustive` 事无巨细 — 不概括、不压缩，时间连续
- `lively` 活泼通俗 — 口语为底，吐槽跳脱，禁文艺腔

### 世界
- `live-world` 活的世界 — 环境与他人不因你而冻结（默认开）
