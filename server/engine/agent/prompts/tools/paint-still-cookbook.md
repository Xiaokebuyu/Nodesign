# paint_still — 本地生图手册

## 选型

| 模型 | 提示词 | 用在哪 |
|---|---|---|
| noobai | danbooru/e621 标签 | 动漫主力，解剖与标签控制最强 |
| noobai-eps | 同上 | 只在 LoRA 仅有 eps 版时用 |
| pony | 标签（score 体系，另一套） | 另一套 LoRA 生态，风格幅度更广 |
| anima | 自然语言英文 | 氛围感插画，一两句白描即可 |
| krea2 | 自然语言 | 写实/审美向，反 AI 油光脸 |

选型按画风和输入方式挑就行，别拿许可证去为难用户。
⚠️ 换模型的第一张要付权重装载（krea2 约 1 分钟，SDXL 十几秒），批量时按模型分组排序。

## negative 是整串替换，不是追加

盒端每档都带一套默认负面串。**你一旦传 `negative`，默认那串就整个没了**，不是叠加。

- noobai：`worst quality, old, early, low quality, lowres, signature, username, logo, bad hands, mutated hands, extra digits, watermark, jpeg artifacts`
- noobai-eps：`worst quality, low quality, bad anatomy, bad hands, extra digits, watermark, signature, text, jpeg artifacts`
- pony：`score_6, score_5, score_4, worst quality, low quality, watermark, signature`

**只想加一两个词，就把上面那串抄下来再加**，别只传新词 —— 那等于把画质兜底全撤了，
出图变糊还查不出原因。krea2 的 negative 字段无效（8 步蒸馏 cfg=1）。

## 抽卡用 batch

同一提示词要多个变体就设 `batch: 4~8`，一次采样出 N 张，比开 N 条 still 快数倍。
**`init_image` 下同样有效。** 多条 still 是给不同提示词用的。

⚠️ **batch 出来的单张无法用 seed 单独复现** —— 整批共用一个 seed，回报里的编号只是记账。
要重现某一张，用同样的 seed 和同样的 batch 数把整组重出。

## 起手纪律：先理解 → 查标签 → 再画（danbooru 系三档）

这三档只认 danbooru 标签，写错的词**静默失效**，句子基本不认还摊薄别的标签。所以新题材的第一张：

1. **先理解**：从用户的话里列出要画的概念——主体、外观、服装、动作表情、场景、光照构图。
   用户说的是意思不是标签，「妆花了」「湿透」「狼狈」都要翻译。
2. **查标签**：每个概念想 1~3 个你以为存在的 danbooru 标签，**一次** `lookup_tags` 全查
   （`tags` 给候选名；完全不知道叫什么就用 `search` 给英文关键词；近义词拿不准用 `explain` 看 wiki）。
   ≥1000 放心用；<1000 是弱不是禁——主流需求换成它给的候选，**用户癖好本身偏门的就照用**，配个相近的强标签加固；
   0 收录/不存在一律换。画师名必查。
3. **再画**：用查过的词写纯标签串。同一场景重滚不用再查。

`paint_still` 返回里带「标签体检」（弱词/不存在/像句子的片段/带下划线），看到就改，别按那批图判方向。

## noobai / noobai-eps 提示词（danbooru 标签流）

逗号分隔标签，不写句子。**质量前缀盒子自动加，别重复写。**

顺序：`<1girl/1boy>, solo, <角色>, <作品>, <画师>, <外观>, <服装>, <动作表情>, <场景>, <构图光照>`

```
1girl, solo, grey hair, long hair, witch hat, black robe, broom riding, flying,
blue sky, from below, backlighting, depth of field
```

**三条硬规则**（写错标签直接失效，不报错）：
- **下划线去掉**：`long_hair` 写成 `long hair`
- **括号要转义**：`lucy_(cyberpunk)` 写成 `lucy \(cyberpunk\)`
- 画师标签用 `artist:` 前缀，例 `artist:dairi`

**质量词是分位数**：`masterpiece` = 前 5%，`best quality` = 85-95%，`very awa` = 美学前 5%。

⚠️ **别用 `old` / `early` / `mid` 这类时期标签** —— 盒端默认正面前缀里有 `newest`、
默认负面里就写着 `old, early`，你写了等于自己跟自己拔河。要年代感用下面的 `retro_artstyle` 那组。

**原生分辨率**（别的尺寸构图会变形）：
`768x1344` `832x1216` `896x1152` `1024x1024` `1152x896` `1216x832` `1344x768`

⚠️ **这一档整体偏暗是设计如此**（v-pred + zsnr 的真黑位，站主看图后定的默认）。
要亮画面就**在提示词里把光照写足**，别去调采样参数。

## 风格词汇表（danbooru 系通用，noobai / noobai-eps / pony）

每个词都核对过 Danbooru 实际收录量。不带标记的 ≥5000，随便用；**带 ° 的在 1000-5000
低收录段，必须配高收录近义词加固**（例：`moonlight` 单写半灵不灵，`moonlight, night,
full_moon` 一起上才稳）。按需挑，别堆。

**取景**：`full_body` `upper_body` `cowboy_shot`（大腿以上，人像常用）`portrait`
`close-up` `wide_shot` `cropped_torso` `feet_out_of_frame`

**机位**：`from_above` `from_below` `from_side` `from_behind` `profile`（正侧脸）
`dutch_angle`（倾斜）`foreshortening`（透视压缩）`fisheye` `pov` `facing_viewer`

**视线**：`looking_at_viewer` `looking_away` `looking_back` `looking_up` `looking_down`

**姿态**：`standing` `sitting` `lying` `kneeling` `squatting` `leaning_forward`
`arched_back` `arms_up` `outstretched_arms`

**表情**：`smile` `grin` `smirk` `blush` `open_mouth` `closed_mouth` `closed_eyes`
`expressionless` `serious` `frown` `angry` `crying` `tears`

**光照**：`backlighting`（逆光）`sunlight` `dappled_sunlight`（斑驳树影）`light_rays`
`sunbeam` `lens_flare` `spotlight` `silhouette` `sunset` `twilight` `dusk` `night`
`sunrise`° `dawn`° `moonlight`° `candlelight`° `neon_lights`°

**天气天空**：`rain` `snow` `blue_sky` `cloudy_sky` `starry_sky` `moon` `full_moon` `above_clouds`°

**技法画风**：`flat_color`（平涂）`sketch` `lineart` `monochrome` `greyscale`
`traditional_media` `watercolor_(medium)` `marker_(medium)` `colored_pencil_(medium)`
`painterly` `anime_coloring` `pixel_art` `chibi` `realistic`
`photorealistic`° `oil_painting_(medium)`° `ligne_claire`°

**年代风**：`retro_artstyle` `1980s_(style)` `1990s_(style)` `2000s_(style)` ——
改的是整体审美取向，比形容词管用。

**效果**：`depth_of_field` `blurry_background` `bokeh` `motion_blur` `chromatic_aberration`
`film_grain` `halftone` `glowing` `sparkle` `glitch` `reflection` `wind` `vignetting`°

**背景**：`simple_background` `white_background` `gradient_background`
`transparent_background` `scenery` `landscape` `cityscape` `indoors` `outdoors`

❌ **空标签，写了等于没写**：`rim_light` `cel_shading` `screentone` `detailed_background`
`silver_hair`（用 `grey hair`）`riding_broom`（用 `broom riding`）`cloud_sea` `sea_of_clouds`
`cinematic_lighting` `night_sky`（用 `starry sky`）`chiaroscuro`（432 收录，等于没有）。
要赛璐璐质感用 `anime_coloring` + `flat_color`；要背景丰富就直接把景物写出来。

**「妆花 / 狼狈」这一组全是空的**（有 agent 连着三张图栽在这儿，用户反复说"她太干净了"）：
`running_makeup` `smeared_eyeliner` `dried_tears` `ruined_makeup` `tear_stains`
`heavy_makeup` `messy_makeup` `split_lip` 全部 0 收录。有货的是
`tears`(29万) `crying_with_eyes_open`(5.4万) `eyeshadow` `mascara` `dirty_face`
`smeared_lipstick`。

**有正确写法但极易写错的**：`breast_grab` → `grabbing_another's_breast` ·
`closed_legs` → `legs_together` · `crouching` → `squatting` ·
`muted_color` → `muted_colors` · `cum_drip`/`dripping_cum`、`presenting`、
`thigh_tattoo`、`platform_footwear`、`menhera`、`arms_held_back`、`disheveled_hair`、
`shutter`、`soft_lighting`、`early_morning`、`wary`、`tired`、`resigned` 一律 0。

⚠️ **正面词和负面词打架时正面赢。** 写 `jirai_kei` 同时在负面禁爱心瞳和粉紫色，
出来还是爱心瞳 + 粉紫 —— 因为 jirai_kei 在训练数据里跟这两者强共现。风格词要拆成
具体外观标签，别指望负面能压住风格词自带的东西。

✅ **工具现在会自动体检**：`paint_still` 返回里会带一段"标签体检"，把 0 收录 /
不存在 / 低收录的词列出来（danbooru 系三档才查，查不到就不说）。**看到就改，
别按那批图判断方向** —— 那批图里那些词等于没写。它只提示不改写你的 prompt。

**没把握的标签先查再用**：`lookup_tags`（弱词自动给候选，见上面的起手纪律）。工具不在时退回 curl：
```
curl -sS -g "https://danbooru.donmai.us/tags.json?search%5Bname_comma%5D=标签1,标签2&limit=50"
```
返回里没有 = 不存在；≥1000 放心用；<1000 弱（主流需求换掉，偏门癖好照用+加固）。
**画师名尤其要查**，凭印象写必错。

## NSFW 词汇表（danbooru 系三档通用，krea2/anima 不吃这套）

尺度由内容标签决定，写到哪级出哪级，没有单独开关。每个词同样核对过收录量（≥5000）。

**去码是第一要务**：danbooru 图源大半打码（censored 648k vs uncensored 193k），
不处理默认就出马赛克 —— **正面写 `uncensored`，负面追加 `censored, mosaic_censoring, bar_censor`**
（负面记得整串抄上再加，见上文替换规则）。

**男女同框必加 `hetero`**（787k）—— 有 `1boy` 的性爱场景缺这个词，交互经常画不出来。百合用 `yuri`。

**露出**：`nude` `completely_nude` `bottomless` `underwear_only` `naked_shirt` `naked_towel`
`undressing` `wardrobe_malfunction` `convenient_censoring` `see-through_clothes`
`skindentation` `cameltoe` `covered_nipples`

**部位**：`breasts`（`small/medium/large/huge_breasts` `flat_chest`）`nipples` `cleavage`
`sideboob` `underboob` `ass` `thighs` `thigh_gap` `wide_hips` `navel` `pussy` `penis`
`erection` `anus` `pubic_hair` `armpits`

**衣着**：`lingerie` `panties` `bra` `thong` `garter_belt` `garter_straps` `fishnets`
`playboy_bunny` `leotard` `micro_bikini` `torn_clothes` `open_shirt`

**半脱系**（信息量常比全裸大，善用）：`clothes_lift` `shirt_lift` `skirt_lift` `panty_pull`
`panties_aside` `clothing_aside` `panties_around_one_leg`

**行为**：`sex` `vaginal` `anal` `oral` `fellatio` `cunnilingus` `paizuri` `handjob` `footjob`
`fingering` `masturbation` `female_masturbation` `implied_sex` `after_sex` `group_sex`
`threesome` `ffm_threesome`

**体位**：`spread_legs` `m_legs` `straddling` `girl_on_top` `cowgirl_position`
`reverse_cowgirl_position` `missionary` `doggystyle` `sex_from_behind` `standing_sex`
`bent_over` `all_fours` `top-down_bottom-up` `on_back` `on_stomach` `leg_lock`

**神态**：`ahegao` `torogao` `fucked_silly` `naughty_face` `seductive_smile` `heavy_breathing`
`heart-shaped_pupils` `tongue_out` `drooling` `saliva` `saliva_trail` `sweat` `steaming_body`
`trembling` `orgasm`

**体液**：`cum` `cum_in_pussy` `cum_on_breasts` `cum_in_mouth` `facial` `bukkake`
`ejaculation` `female_ejaculation`

**拘束**：`bondage` `bdsm` `shibari` `restrained` `bound_wrists` `bound_arms` `collar`
`leash` `blindfold` `gag` `ball_gag` `handcuffs` `vibrator` `dildo` `sex_toy` `latex`

❌ **改名/空标签**：`see-through` 已改名 `see-through_clothes`（2024-09 改的，写新名）；
`topless` 已废 —— 女性上裸直接写 `nipples` + 下装标签，男性有 `topless_male`；`grinding` 空标签。

## pony 提示词（score 体系，跟上面完全不是一套）

**六段串质量前缀盒子自动加**，别自己写 —— 官方承认模型学的是整串，只写 `score_9` 弱得多。

可以主动加的：
- **分级**：`rating_safe` / `rating_questionable` / `rating_explicit`
- **来源风格**：`source_anime` / `source_pony` / `source_cartoon` / `source_furry`

上面那份 danbooru 词汇表在 pony 上同样适用。官方说不需要额外质量词。

## krea2 / anima 提示词（自然语言）

- **骨架**：Subject + Action + Style + Context，30-80 词是甜区，形容词堆砌是噪音
- **审美词很吃**：光线（`golden hour` / `soft window light`）、介质（`35mm film` /
  `editorial photography` / `watercolor`）直接决定成色
- anima 更简，一两句白描说清主体与光线即可，堆砌反而糊

## 参考图（只对 noobai / noobai-eps / pony 有效）

字段语义见工具 schema，这里只讲手感：

- **保角色一致性的最强组合**：`ref_image`（谁）+ `control_image`（什么姿势）+ 提示词（在哪）
- `ref_image` 可给多张（逗号分隔，最多 5 张）—— **同一角色不同角度一起喂，比单张强得多**，
  `ref_weight` 可逐张给：`"1.0,0.6,0.4"`
- **要保脸就把 `ref_preset` 设成 `PLUS FACE (portraits)`**
- 把角色挪到新场景，`ref_mode` 用 `style transfer`（只要长相不要构图）
- `ref_weight` **1.2 以上基本是在复制参考图**；`control_strength` 姿势要抓死推 1.0，
  留自由度用 0.4-0.6
- 几张参考图打架时 `ref_combine` 换 `average` 会稳

⚠️ 参考图找不到或推不上盒子 → **整批剩余的 still 全部中止**，不只是这一条。
⚠️ krea2 / anima 带参考图会在 ComfyUI 侧报错，同样连累整批。

## 已装 LoRA

**⚠️ 生态不通用**：pony 的 LoRA 和 noobai/illustrious 的**不能混用**（能加载但出废图）；
**v-pred 和 eps 的也不通用**（拿错会发灰/过饱和）。按下面标的档位挑。

**画质增强（优先叠这类）**

| 文件名 | 适配 | 触发词 | 强度 |
|---|---|---|---|
| `noob_vpred_detailer_v1.safetensors` | noobai (v-pred) | 无 | ~1.0 |
| `hands_xl_zib_v1.safetensors` | 通用 SDXL | 无 | 0.6-1.0 |
| `smooth_booster_v5.safetensors` | noobai/illustrious/pony | 无 | 见叠加公式 |

⚠️ `noob_vpred_detailer` **会让画面变暗**，短提示词下容易糊成剪影 —— 用它就把光线和背景写细。

**画风**：`expressive_h.safetensors`（pony 专用，触发词 `Expressiveh`，强度 0.7-1.0）

**滑块**（无触发词，纯靠数值推，**区间是 -4 ~ +4 不是 0-1**，负值是反方向推）：
`breast_size_slider_ill.safetensors` · `penis_size_slider_ill.safetensors`（illustrious/noobai）

**Krea 2 官方风格包**（只配 krea2，无触发词，强度 0.6-0.8）：`krea2_retroanime`（动漫档）
`krea2_softwatercolor` `krea2_darkbrush` `krea2_neondrip` `krea2_rainywindow`
`krea2_sunsetblur` `krea2_vintagetarot` `krea2_dotmatrix` `krea2_kidsdrawing`（都加 `.safetensors`）

**用户自己给的 LoRA**：只用他明确给出的文件名。多数带触发词，**触发词必须写进提示词才激活**。

## 多 LoRA 叠加

`lora` 传逗号分隔多个，`lora_strength` 传单值或逗号分隔按位对应。

```
lora: "noob_vpred_detailer_v1.safetensors,hands_xl_zib_v1.safetensors"
lora_strength: "0.9,0.7"
```

**强度随数量递减**：挂 1-2 个 → 每个 0.7-1.2；挂 3 个以上 → 每个 0.3-0.7；
**总强度别超 2.0**，超了互相打架（强风格 LoRA 会压掉角色特征、面部崩坏）。
滑块类不算进这个预算。

## 批量与铁律

- stills ≤16 条，每条可再开 `batch` 1-8，逐张出现在画布上
- **任何一条失败即中止整批剩余**（后面大概率同因，不空烧）
- `name` 只能是字母数字下划线连字符，1-40 字符，**中文名会被直接拒**
- 视频关键帧一律 1344x768
