# generate_image cookbook（后端 = codex + gpt-image-2）

> 此文件由 PreToolUse(mcp__nodesign__generate_image) hook 在 agent 首次调用工具时
> 注入，每 session 只注一次。SKILL.md 已含精简版核心要点，本文是深度参考。
>
> ⚠️ Gemini gateway 时代的参数段（imageSize / thinkingLevel / model 路由 flash-pro /
> Image Search Grounding / PDF 文档输入 / NB2 model card 失败模式）**已整体移出本文**
> （那份存档 08-24 已删：全仓无引用的孤儿文件；要复活 gateway 从 git 历史里捞）。
> 那些旋钮在当前后端上传了不报错也没效果，留在这里只会让你花心思拨一个不存在的开关。

## 前置 · 后端事实 —— 先读这节，它决定下面所有写法

链路：`generate_image` → `codex exec` → codex 自带图像工具 → **gpt-image-2**

| 事实 | 对你的后果 |
|---|---|
| **prompt 逐字下传，零改写** | 桥接层写死了禁止改写/增删/翻译/润色。你写什么模型收到什么。这条已被日志逐字节实锤过两次，**不用再自行验证** |
| **一次调用 = 一张图** | 没有"一个 prompt 出 3 张"这回事。要 N 个候选就串行调 N 次（见 § F） |
| **无状态** | 模型不记得上一张图，也不记得这次会话。跨图一致性只有一条路：把上一张当 `referenceImages` 喂回去 |
| **生效参数** | `prompt` / `aspectRatio` / `referenceImages` / `assetRole` / `outputName` |
| **静默忽略的参数** | `imageSize` / `thinkingLevel` / `responseModalities` / `model` / `useGrounding` —— 传了不报错、也没有任何效果，别浪费心思 |
| **PDF 参考不支持** | 只吃图：png / jpg / jpeg / webp / gif |
| **~45-60s 一张** | 一张对齐好的 anchor 胜过一堆试探性变体 |
| **不支持透明背景** | 永远会填一个底色。要透明走 `remove_background`（§ M） |

落档 `assets/generated/<name>.png`，HTML 里引 `<img src="assets/generated/<name>.png">`（softlink 透明）。

### 比例的真实边界（这条容易踩）

`aspectRatio` 会作为指令转给 codex，由它去拨图像工具的尺寸参数。但 **gpt-image-2 自身
的硬约束是长短边比 ≤ 3:1**（另有单边 ≤ 3840px、边长为 16 的倍数）。所以：

- ✅ 原生做得到：`1:1` `3:2` `2:3` `4:3` `3:4` `4:5` `5:4` `16:9` `9:16` `21:9`（2.33:1）
- ❌ 超出 3:1 拿不到：`4:1` `1:4` `8:1` `1:8` —— 枚举里有、传了也不报错，但出不来原生长条

要顶部公告条 / 侧边装饰带这种极端长条：用 `16:9` 出图，再在 HTML 里 `object-fit: cover`
裁到需要的形状；或者干脆用 CSS 画，别为一条色带烧 60 秒。

**别在 prompt 正文里写尺寸**（`"in 4K resolution"` / `"16:9 widescreen format"`）——比例
走 `aspectRatio` 参数就够了；写进正文只会让 codex 生成后再 resize 一次，白拉伸一道。

## 0. Reference 来源策略（生图前先决定从哪儿拿 reference）

| 主体 | 来源 | 触发动作 |
|---|---|---|
| 用户上传素材（`用户内容/*.png\|jpg`，老项目在 `assets/`）| 直接用 | 把路径喂 `referenceImages[]` |
| 模型脑里有的著名实体（Apple Park / Wong Kar-wai 风 / 艺术流派）| 不必 reference | prompt 直接点名 |
| **真实存在但模型不熟**（最新发布产品 / 小众品牌 / 用户自有 IP / 特定型号设备）| **`web_search { include_images:true }`** | 工具自动翻英文 + 下载到 `assets/references/`；选 1-2 张最切题的 `local_path` 喂 `referenceImages[]` |
| 抽象概念 / 装饰 / 隐喻 | 不需要 reference | 直接 prompt |

### `include_images=true` 用法

**使用时机**：用户主题确定后、`generate_image` 之前，当生图主体是**真实存在的物体/品牌/场景**（产品照、地标、设备、车型、食物、自然风光等）。模型脑里有的东西不必搜；**最近发布的产品 / 小众品牌 / 用户自有 IP** 必搜。

**Provider 路由（auto）**：
- CJK query → **baidu**（母语图搜，不翻英；image 条目 + web 条目附图都收）
- 英文 query → **tavily**（描述质量最高，几乎条条有详细 caption）
- exa fallback（页面代表图 + 页面内 imageLinks）
- ⚠️ zhipu **不支持**图搜，include_images 模式下被拒

**输入 / 输出契约**：
```
mcp__nodesign__web_search { query: "新能源汽车 充电桩 产品", include_images: true, count: 5 }
↓ 下载 top-N 到 <workspace>/assets/references/ref-<hash>.<ext>
↓ 返回值：
   • 1 个 text block：markdown，含 hits + "## Reference images (downloaded, N)"
     每条带 description / local_path / size / source / url
   • N 个 image content block：每张下载到的 reference 图内嵌，
     **当 turn 你直接 vision-check 即可，不必再调 Read**
```

**`count` 不用抠**（默认 5，上限 10）。挑参考图本来就得看得够多才挑得准 —— 主体关键时
开到 8-10 完全可以，宁可多看几张选对，也别为省几张图选错了锚。真正要控的是**查询次数**：
每张图作为 inline image block 回传且不释放，所以同一回合别跑超过 2-3 次查询，那才是上下文
膨胀的主因。

**搜图是为了锚定具体对象，不是为了理解风格**：风格名（Bauhaus / 拼贴 / risograph）模型
自己就懂，搜它纯属白烧。要搜的是**模型不认识的具体东西** —— 用户点名的 IP、角色、真人、
某个产品型号、小众品牌。

**vision-check → 选图 → 喂 generate_image**：拿到结果后扫一眼内嵌的图，按视觉切题度选 1-2 张最好的（光线/构图/主体清晰度），把对应条目里的 `local_path` 塞进 `referenceImages[]`。靠 description 文字盲选会踩坑（描述准确度参差）。

**关键页例外 —— 让用户挑而不是 agent 默选**：cover / 跨页 anchor / portrait 这种**会被当 referenceImages 跨页种子**复用的页型，agent 默选错一张全篇漂。这些页主动调 AskUserQuestion + image preview 让用户视觉对比。装饰 / 普通页 agent 自选即可。

**何时不该用 `include_images`**：抽象/装饰类（icon、pattern、texture）、概念图（流程、隐喻）、模型本来就熟的著名实体。

## B. 怎么写 prompt

### B0. 先在脑内把画面立起来（铁律，优先于下面所有技巧）

写 prompt 之前，像描述一张**已经存在的画**那样，从机位开始把画面从左到右、从前到后走
一遍：每件东西在哪、朝哪、被什么光照着。写出来的应该是"我看见了什么"。

**不要靠堆叠否定句**。禁令只能封住已知的错法，模型会换一种没被禁的错法；正面成像把
自由度直接占满，错法没有落脚点。出错时先怀疑"画面没想清楚"，而不是"禁令写得不够多"。
`Avoid:` 段只留真正的底线（零文字、无他人这类全局军规），单张图的造型要求一律转成正面描述。

空间关系用成像语言（"A 在 B 前面 / 被 C 挡住"），不要写"A 不许穿过 B"。

### B1. 结构 —— 5 元素叙述公式

固定顺序：**场景/背景 → 主体 → 关键细节 → 约束 → 用途**。展开成句就是：

```
[Subject] + [Action] + [Location/context] + [Composition] + [Style]
```

3-5 句自然段比关键词列表准一个量级，每段给 1-2 个具体属性。带上用途（广告 / UI 稿 /
信息图）来定完成度；复杂请求用 § B3 的短标签行，别写成一大坨。

**反例 vs 正例**：
- ❌ `"a woman on a street, blue dress, day"`
- ✅ `"[Subject] A young woman in a light blue linen shirt and tailored beige slacks, [Action] standing at a zebra crosswalk waiting for the light to change, [Location] in central Lisbon's Chiado district, midday overcast light filtered by tall pastel buildings, [Composition] medium shot at street level, slightly low angle, [Style] documentary photography style, 85mm shallow depth of field f/2.0, natural skin tones, Fujifilm color science"`

### B2. 具体度政策（最容易做反的一条）

- 用户的描述**已经具体**了 → **规范化**成干净的 spec，**不要加创意要求**
- 用户的描述**很泛** → 可以适度补，但只补那些真正提升成片的

| 允许补 | 不许补 |
|---|---|
| 构图与取景提示 | 没被暗示的额外人物、道具、物体 |
| 用途与完成度提示 | 没被暗示的品牌色、标语、故事线 |
| 版面留白（给标题让位） | 没有版面依据的左右位置指定 |
| 支撑该请求的场景具体化 | —— |

要写实照片就直接写 `photorealistic`，并给具体真实质感（毛孔、织物磨损、材料颗粒、
日常的不完美），别靠"高级感"这类抽象词。

### B3. 标签化 spec（复杂请求用它）

```text
Use case: <下面 B4 的 slug>
Asset type: <这张图用在哪>
Primary request: <主诉求>
Input images: <Image 1: 角色; Image 2: 角色>   （有参考图时才写）
Scene/backdrop: <环境>
Subject: <主体>
Style/medium: <照片 / 插画 / 3D / …>
Composition/framing: <远近、视角、位置>
Lighting/mood: <光线 + 情绪>
Color palette: <配色>
Materials/textures: <表面质感>
Text (verbatim): "<精确文字>"
Constraints: <必须保持 / 必须避免>
Avoid: <底线级禁令>
```

只用帮得上忙的那几行，别把模板填满。这是脚手架不是表单。

### B4. 用例分类 slug（分类决定了上面该重点写哪几行）

**生成**：`photorealistic-natural` · `product-mockup` · `ui-mockup` · `infographic-diagram` ·
`scientific-educational` · `ads-marketing` · `productivity-visual` · `logo-brand` ·
`illustration-story` · `stylized-concept` · `historical-scene`

**编辑**：`text-localization` · `identity-preserve` · `precise-object-edit` ·
`lighting-weather` · `background-extraction` · `style-transfer` · `compositing` ·
`sketch-to-render`

### B5. 分类要点（挑你这次用得上的看）

| slug | 重点 |
|---|---|
| photorealistic-natural | 当成"此刻真的拍下来的一张照片"来写；摄影语言（镜头/光线/取景）；要真实质感；别加过度精修感 |
| product-mockup | 描述产品与材质；轮廓干净、标签清晰；有文字就要求逐字还原并指定字体 |
| ui-mockup | **先说清完成度**（可交付的高保真稿 还是 低保真线框），再谈布局、层级、实际 UI 元素；别用概念艺术的措辞 |
| infographic-diagram | 定读者与信息流向；显式标注各部分；要求文字逐字还原 |
| logo-brand | 简单可缩放；强剪影、留白平衡；不要装饰性花活 |
| ads-marketing | 当创意 brief 写：定位、受众、调性、场景、精确标语 |
| productivity-visual | 点名具体产物（幻灯片/图表/流程图），定画布与层级，给真实标签与数据 |
| illustration-story | 定分格或场景节拍，每个动作写具体 |
| stylized-concept | 指定风格线索、材质完成度、渲染方式（3D / 厚涂 / 黏土），别顺手编故事 |
| historical-scene | 写明地点年代与考据要求，服装道具环境都要卡住 |
| identity-preserve | 锁死身份（脸、身形、姿态、发型、表情），只改指定项，光影要接上 |
| precise-object-edit | 精确说明删/换什么，周围材质与光照保持不变 |
| lighting-weather | 只改环境（光、影、大气、降水），几何与取景与主体身份不动 |
| style-transfer | 说清要保留什么（构图/剪影/位置）、要改什么，加一句 `no extra elements` 防漂 |
| compositing | 按 index 引用输入图，说明谁挪到哪，匹配光照/透视/比例 |
| sketch-to-render | 保住布局、比例、透视，只补材质与光照，不加新元素 |

## C. 词汇库（按场景分类）

| 类型 | 推荐词 |
|---|---|
| 镜头 | f/1.8 / f/2.8 / f/8 portrait, 35mm wide, 85mm portrait, 200mm telephoto, macro lens, fisheye, low-angle drone, top-down isometric, dutch angle |
| 相机 / film stock | GoPro (immersive distortion), Fujifilm (color science), Kodak Portra 400 (warm skin), Cinestill 800T (tungsten green halation), Ilford HP5 (B&W documentary), Hasselblad medium format, disposable camera (raw flash nostalgic), 1980s VHS |
| 灯光 | three-point softbox, Chiaroscuro high contrast, golden hour backlighting, blue hour, neon city night, candlelit interior, overcast diffuse, harsh midday sun, studio rim light |
| 色调 / 氛围 | cinematic muted teal and orange, bleach bypass, sepia toned, pastel washed, high saturation editorial, monochrome noir |
| 材质 | navy blue tweed, etched silver leaf, matte ceramic, brushed steel, raw linen, hand-blown glass, weathered concrete, lacquered wood, brushed velvet |
| 艺术流派 / 海报 | Bauhaus, Wabi-sabi, Memphis design, brutalist concrete, art nouveau lithograph, ukiyo-e, Mucha poster, Mondrian primary, Saul Bass minimalist, Swiss International typographic |

直接点名不要犹豫：`Wong Kar-wai cinematography` / `Van Gogh-style oil painting` /
`Fujifilm color science` / `Bauhaus poster aesthetic` / `ukiyo-e woodblock print style`。

## D. 图里的文字

1. **精确文字加引号或全大写**：`render the words 'Annual Report 2026' on the cover`
2. **指定字体风格或字号颜色位置**：`in flowing Brush Script font` / `in heavy blocky Impact font`
3. **生僻词逐字母拼**，并要求逐字还原、不许多字
4. **多语言**：用一种语言写 prompt + 指定输出语言

**什么该交给 HTML 而不是模型**：小字（等效 12px 以下容易糊）、超过 3 行的正文段落、
需要精确数量的重复元素（"正好 5 张卡"不一定真出 5 张）、以及任何数据与事实性内容
（模型会编数字）。让模型只渲大标题和标语，正文用 HTML 叠上去。

**多字段并存的封面**（每行单独指定字体）：

> "A high-end glossy magazine cover, deep cherry red background. Render three lines of
>  text with the following exact styling: top line 'GLOW' in flowing elegant Brush Script
>  font; middle line '10% OFF' in heavy blocky Impact font; bottom line 'Your First Order'
>  in thin minimalist Century Gothic font."

**进阶：字体当取景窗（typographic poster）** —— cover 和 section-divider 必看的一招：

> "A typographic poster with a solid black background, bold letters spell 'NEW YORK',
>  filling the center of the frame. The text acts as a cut-out window. A photograph of
>  the New York skyline is visible ONLY inside the letterforms."

### In-image localization（已有图本地化，不只是翻文字）

模型能本地化**整个视觉文化语境**——文字翻译只是其中一项，还能换道具、货币、着装、
食物、场景。规则是：保留品牌身份与主体构图，其余按目标市场调。

> "Localize this ad for the Japanese market.
>  Translate the headline exactly to Japanese: '〜こだわりの一杯〜'.
>  Adapt background props, packaging context, and lifestyle cues for Tokyo consumers.
>  Keep the product, logo, composition, and brand colors unchanged."

适合：跨地区营销素材 / 多语言版本 / 品牌 global → local 适配。

## E. Reference image

**契约**：
- ⚠️ 只接 **workspace 相对路径**，喂 http url 会被拒
- ⚠️ **选 1-2 张最切题的**。全喂反而稀释锚点，模型不知道该锚哪张
- 每张图在 prompt 里标明 index 和角色（`Image 1: 编辑目标`、`Image 2: 风格参考`）
- ⚠️ **参考图只影响画风与主体特征，不提供逐格/逐像素对齐能力**（见 § H）

| 模式 | 怎么用 |
|---|---|
| **风格一致（跨页锚）** | 第 1 张 cover 当种子，后续 hero / section-divider 都引它 → 整篇像同一部片子 |
| **角色一致（多页叙事）** | portrait 跨页引 + 给角色起名（"Maya, the woman in Reference 1"）|
| **logo / brand 嵌入** | 用户上传 logo 进 `用户内容/`，prompt 写 "Place the logo from Reference 1 etched into the bottle in Reference 2" |
| **精修而非重画** | `screenshot_canvas` 截当前页当 reference，配 § G 的模板 |
| **真实主体锚定** | `web_search { include_images: true }` 拿真图 → 喂进来 + "Use the product in Reference 1 as the subject; render it in [场景]" |

**multi-modal 公式**：

```
[参考图] + [关系说明] + [新场景]

例："Using the napkin sketch (Reference 1) as the structure
    and the fabric sample (Reference 2) as the texture,
    transform this into a high-fidelity 3D armchair render.
    Place it in a sun-drenched, minimalist living room."
```

### 进阶 edit modes

#### 多图合成（product-on-model / element-transfer）

```text
Image 1 = [物体 / 产品 / 服装 / logo]
Image 2 = [人 / 环境 / 表面]
Instruction: "Take [Image 1 里的元素] and place it on/with [Image 2 里的元素].
              Preserve [要保护的细节] exactly.
              Adjust lighting, shadows, perspective, and material interaction naturally."
```

> "Take the blue floral dress from Image 1 and put it on the woman in Image 2.
>  Preserve her face, hair, pose, and the cafe background exactly.
>  Match lighting and shadow direction to the cafe scene; render fabric drape naturally."

适合：服装上身 mockup / 产品进场景 / logo 烙印物体 / 标牌嵌建筑。

#### Style transfer（保构图，只换风格）

不是单纯说一句"梵高风"，关键在**显式保住构图、位置、剪影**，只换渲染方式：

> "Transform this product photo into a Bauhaus poster illustration.
>  Preserve the product shape, orientation, and composition.
>  Change only the rendering style: flat geometric forms, primary color blocks,
>  clean vector edges, 1920s Bauhaus poster design."

加一句 `no extra elements` 防止它顺手加东西。

#### Sketch-to-final（草图 / 线框 → 成品）

用户给草图或 wireframe，你输出成品视觉，**几何结构必须保住**：

> "Turn this rough wireframe into a polished 16:9 SaaS product hero visual.
>  Keep the layout, card hierarchy, and main dashboard geometry from Reference 1.
>  Add premium glassmorphism UI, soft blue studio lighting, and realistic depth.
>  Leave top-right negative space for HTML title overlay."

#### 角色圣经（跨页一致）

角色 / 吉祥物 / 关键产品要跨多页出现时，先建 identity sheet：

```
Step 1: 生成 identity sheet（正面 + 关键服装/装备特写）
Step 2: 后续每个角度（3/4 / 侧面 / 背面 / 动作）都把 identity sheet 当 reference
Step 3: 给角色起名锚定（"Maya, character from Reference 1"）
        服装 / 发型 / 剪影 / 关键材质不允许跨页变
```

**给角色起名是有效的锚**：一旦在 prompt 里把参考图里的人命名为 Maya，后面用
"Maya" 指代比每次重描一遍五官稳。

## F. 要多个候选怎么办

⚠️ **旧版这里教的"一个 prompt 出 3 张"在当前后端不成立** —— 一次调用只落一个文件。
照着那么做会拿到一张图却按三张的剧本走（往 AskUserQuestion 里塞两个不存在的路径）。

两条正确路子：

1. **串行调 N 次**，每次只改关键差异词（golden hour / blue hour / overcast），其余原样。
   然后 AskUserQuestion 每个 option 贴对应那张真图。
2. **一次出一张"三格对照条"**：prompt 里明说 `one image containing three labeled panels`，
   让用户先挑方向；方向定了再对选中的那个单独出一张干净的。省时间，但单格分辨率低，
   只适合定方向不适合当成品。

## G. 精修优于重画

用自然语言定义编辑区域，不需要画 mask。万能模板：

```text
"Change only [要改的语义目标].
 Keep [其余：主体 / 构图 / 光线 / 配色] unchanged."
```

⚠️ **我们的桥是无状态的**，所以"接着上一张改"必须显式做两件事：把上一张图放进
`referenceImages`，并且**每一轮都重述不变量**（不重述就会漂）。别指望模型记得上一轮说过什么。

| 想做的 | ❌ 重生整张 | ✅ 精修 |
|---|---|---|
| 改光线 | 重画 | "Keep composition, change only lighting to golden hour" |
| 换背景 | 重画 | "Replace only the background with a neon-lit city street; keep subject and pose" |
| 删元素 | 重画 | "Remove only the person on the left, extend the sidewalk; keep everything else" |
| 换字体 | 重画 | "Keep layout, change only headline font to a bold serif; body text unchanged" |
| 换材质 | 重画 | "Change only the table material from wood to brushed steel; keep shape, position, scene" |

每次只改一处，改完再看，别一轮里改五件事。

### G1. variationOf 模式 —— 系列图一致性用参数，别手写咒语

上面那套 "Change only… Keep… unchanged" 的骨架，工具已经内置成结构化参数：

```json
{ "variationOf": "assets/generated/A1.png",
  "change": "裙子换成薄荷绿短裙，长度到膝盖以上",
  "preserve": ["pose","framing","face","hair","top","shoes"] }
```

- `variationOf` 就是编辑基底（自动成为第 1 张 reference），`change` 是唯一要动的那处，
  `preserve` 是必须一致的方面（**省略 = 全保，最安全**）。工具会展开成完整骨架并
  自动追加通用禁止项（不凭空加背带/发饰、缺席也要保持 —— 都是真实翻过车的）。
- 何时用它而不是手写 § G 模板：**做系列**（换装矩阵、多页同角色、多帧同场景）。
  组织成一棵树：先出一张锚图，之后每次调用只沿一个轴变一处。
- 手写 prompt 仍然适合单次精修（改光线、删元素这类一次性编辑）。
- 此模式下 `prompt` 可省略；传了就当补充说明附在骨架后。

## H. 连续帧的能力边界（实测，别重新踩）

| 用法 | 结果 |
|---|---|
| 一张图里出**多个不同动作**（同一角色，九宫格） | ✅ 很好，同次生成内角色一致性最佳，比分九次调用稳 |
| 九宫格 / 2×2 出**连续动画帧** | ❌ 每格独立采样，缩放、位置、发型逐格都在变 |
| **横向长条三帧** | ✅ 成立。静区逐帧重合度极高，只有指定部位在动 |
| 完整场景含人物（一次成图） | ✅ 接地感、透视、光照天然统一 |
| 抠好的角色叠到另一张背景上 | ⚠️ 没有接地信息，必然是贴纸感 |

**根因**：模型没有"上一帧"的概念，每格是独立采样的一张相似的画。参考图救不了这件事。

**结论：动画交给 CSS，绘画交给模型。** 一朵云 + `translateX` 就是完全连贯的飘动；
多出几朵不同的云，价值在"不重样"，不在"能动"。

**头身比指令基本无效**：要 4.5 头身给你 7 头身。拿 Q 版图当参考图的结果是大头配长腿的
恐怖谷，比不控制更糟。要 Q 版就整套重画，别指望中间态。

## I. 出图不理想时，对照这 6 条看

- **结构** —— 关键词堆砌 vs 自然段落描述。后者稳得多，见 § B1
- **逻辑** —— 否定描述（`no cars`）容易被理解反；改成肯定场景（`empty pedestrianized street`）
- **修饰词** —— `nice` / `cool` / `高级感` 太抽象；换成具体视觉词（光线 / 材质 / 色温）
- **风格锚** —— 没点流派或摄影风格，输出会游移；点名一两个参考就定向了
- **文字精度** —— 不带引号、不指定字体 → 跑样
- **跨页一致** —— 缺 referenceImages 锚，每页独立生成必漂

**另外两条**：
- icon / sticker 会带底色（不支持透明）—— 明确写 `white background` 或事后走 § M
- 同一个 prompt 连 reroll 3 次以上收益递减；改关键参数或回头问用户方向更有效

### 已知失败模式（final 接受前必扫）

| 维度 | 坑 | 检查 / 对策 |
|---|---|---|
| **小字** | 等效 12px 以下容易糊 | 关键文字单独放大，或用 HTML overlay 覆盖，别让模型渲 |
| **长段落** | 超过一段正文就跑样 | 3 行以上让 HTML 渲，模型只渲标题和标语 |
| **角色漂** | 跨图生成同一角色会微变（脸型 / 发色 / 服装细节） | 走上面的角色圣经工作流，identity sheet + reference 链 |
| **左右与空间** | `left of` / `right of` / `behind` 偶尔会反 | 关键定位改用绝对短语（`in the foreground` / `in the bottom-right corner`） |
| **数量** | `exactly 5 cards` 不一定真出 5 张 | 数字关键时让 HTML 复制 N 份，模型只出 1 张模板 |
| **残墨** | 参考图是带涂鸦 / 红框 / 箭头的截图时，模型偶尔把标注当主体画进去 | 截图前把标注清干净再当 reference |
| **贴片感** | 多图合成时偶尔把参考图的局部 1:1 粘进来 | 检查有没有突兀的拼接边缘；有就在 prompt 里强调 `naturally blend` / `reinterpret` |
| **编内容** | 参考图没给的信息模型会自己编（日期 / 来源 / 数字） | 数据与事实类内容一律 HTML 渲，别让模型写 |

## J. 调完必做

1. **记进记忆** —— 定案的 anchor（prompt 骨架 + role + 产物路径 + 用户评价）写一条
   `type: project` 记忆（`记忆/` 主题文件 + MEMORY.md 一行）。重生时能查回，
   用户在画布上也看得到。
2. **关键节点的反馈循环**：cover / 第一个 portrait / logo 嵌入这种会被当跨页种子的 anchor，
   生完在自然回话里邀请用户看一眼方向（生图的 image block 已自动渲染在 chat，他直接看得到）。
   种子早定早收益。
3. **落档后 read_page / list_pages 看到的是 thumbnail 快照**（`assets/generated/<n>.<ext>` 被
   透明重写到 `.thumbnails/<n>.thumb.jpg`），真实 HTML 里的 `<img src>` 不变。想确认 src
   写进去没有就直接看 Read 结果；重生原图后 thumbnail 数秒内自动更新。

## M. remove_background —— 独立工具抠透明背景

gpt-image-2 不支持透明背景（永远填一个底色），跟画布底色冲突时图会直接糊在上面。
`mcp__nodesign__remove_background({ inputPath })` 调 server 端 rembg 抠掉背景，输出 RGBA PNG。

**为什么是独立工具不是生图的 flag**：要抠的不止刚生的图——用户上传的产品照、之前生过的图、
截图都该能抠。生图后想抠就再调一次，0 重复 token。

### 两个正交的轴

**quality（边缘精细度）**：

| quality | 组成 | 什么时候用 |
|---|---|---|
| `balanced`（默认） | isnet-general-use + alpha matting | **默认就用它**。人物 / 毛发 / 烟雾 / 织物 / 任何软边 |
| `fast` | isnet-general-use，不开 AM | **主动降档**：硬边主体，软边反而像糊——产品图 / 图标 / logo / UI 截图 / 平涂图形。大批量也用它 |
| `best` | birefnet-general-lite + AM | 峰值内存 2.4GB+，**当前被 `NODESIGN_REMBG_QUALITY_CAP` 禁着**，调了会被显式拒绝。别写进方案里 |

**style（底模画风）**：与 quality 正交，只换 `fast`/`balanced` 的底模。

| style | 底模 | 用在 |
|---|---|---|
| 缺省 | isnet-general-use | 照片、真实物体 |
| `'anime'` | isnet-anime（动漫线稿专训） | **二次元立绘 / 插画 / 贴纸 / 生成的动漫角色**。通用版会把浅色主体判成背景把人抠没，这条线路就是为治那个病加的 |

alpha matting 是消 halo 的关键：不开会剩大约三成半透明杂散像素，开了降到一成。
**别为提速预先缩图** —— alpha matting 限死 1024 长边算完再放大回原尺寸，耗时不随输入像素增长。
**超上限会被显式拒绝，不会静默降档**；拿到拒绝信息按它说的改档，别反复试同一档。

### 何时调

| 场景 | 调？ |
|---|---|
| 角色 / portrait 叠到自定背景上 | ✅ |
| 产品 / 物体做 hero 主图 | ✅ |
| 二次元立绘要叠进版面 | ✅ 且带 `style: 'anime'` |
| 用户上传的图带白底 / 杂背景，要叠进版面 | ✅ |
| 装饰性 pattern / texture / 渐变背景 | ❌ 这些就是要带背景 |
| 整页 cover / hero | ❌ 背景本身就是设计的一部分，抠掉等于自废武功 |
| 简单线性图标 | ❌ 直接用 SVG 图标库，免成本天然透明 |

### 调用

```js
// 给刚生的图抠
mcp__nodesign__remove_background({ inputPath: "assets/generated/coffee-mug.png" });
// → assets/generated/coffee-mug-nobg.png（RGBA）

// 二次元立绘：换动漫底模
mcp__nodesign__remove_background({
  inputPath: "assets/generated/character-a.png",
  style: "anime",
});

// 硬边主体降档拿更利落的切口
mcp__nodesign__remove_background({ inputPath: "assets/product.jpg", quality: "fast" });

// 自定输出名；同名已存在时默认加时间戳防误覆盖，想覆盖传 overwrite
mcp__nodesign__remove_background({
  inputPath: "assets/photo.png", outputName: "photo-clean", overwrite: true,
});
```

拿到的 caption 形如 `Removed background from … → … (RGBA PNG, 245.3 KB, 3120ms, quality=balanced)`
外加 image content block，直接 vision 看效果。

### 工作流约束

| 项 | 说明 |
|---|---|
| **串行不并行** | 这台机器 1 核，并行只会一起变慢还把内存峰值叠起来。要抠 N 张就串行调 N 次 |
| **Latency** | 常驻 service（warm）：fast ~5-10s / balanced ~10-20s。service 不可用时 fallback 到每次冷启，多付 20-40s 模型加载，结果一样只是慢 |
| **输出格式** | 强制 .png（RGBA 必须 PNG）。输入支持 png/jpg/jpeg/webp/gif/bmp/tiff |
| **边缘质量** | balanced + AM 已能消掉大部分 halo；玻璃 / 烟雾 / 半透明披纱这类薄透元素边缘仍可能软或抠不全 |
| **路径安全** | inputPath 必须 workspace 相对路径，不允许绝对路径或 `..`。解析顺序 cwd → sharedRoot |

### 反例

- ❌ 给每张生图都自动跟一次抠图 —— 累计很快，只对**真要叠合**的图调
- ❌ 期望 SVG 级精度 —— ML 抠图永远是 raster + 边缘软化，要硬边走 SVG
- ❌ 复杂遮挡（人在树后）—— 可能抠掉树或抠掉手，预期管理
