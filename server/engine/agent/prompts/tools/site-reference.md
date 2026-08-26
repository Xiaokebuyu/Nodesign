# 站点技术参考

首次写站点 html 时注入一次。方法论在 `site-craft` skill，这里只讲平台事实和会踩的坑。

## 目录

**站点住自己的文件夹**（按站名起，如 `观察日志/`）—— 不要把 index.html 直接
放在工作区根上。工作区根是整个项目的桌面，notes/ 素材/ 别的产物都住那儿；
站占了根，路径语义全变成空串特例，别的产物也没了并列的位置。

```
观察日志/           站点文件夹（**里面有 index.html 就被认作一个站点**）
  index.html        入口
  about.html        子页，同目录直接加
  style.css         样式怎么组织你定 —— 手写道常见全站一份，构建道是 dist/ 里的分片，都行
  posts/            子目录可以有（页面扫描深度 4 层）
  assets/           站点自己的素材，站内写相对路径 assets/x.png 引用
  _drafts/          独立单页。各自渲成卡并排挑，和其他产物平等；不算站点页面、不进整站导出
  .ndignore         不想被系统扫到的东西写这（gitignore 语法，无 ! 反选）
```

（旧项目里工作区根上直接放 index.html 的「根站」仍被识别和支持，但**新站一律入夹**。）

**构建型站点**（Vite / React / Vue / Astro / 11ty / 自写 build 脚本）：源随便组织，
构建产物落 `dist/`（或 `out/` `build/` `_site/` `public/`，有 index.html 的那个自动
被认作**产物根**）。现代工程源码里的 `index.html`（引 `/src/main.tsx` 那种 dev 入口）
**不会**被误当产物 —— 构建完系统自动优先 dist。`.nd-project.json` 的 `"root": "<目录>"`
可显式指定产物根：**放站点文件夹里，路径相对该文件夹**（如 `观察日志/.nd-project.json`
写 `{"root":"dist"}`）；根站的放工作区根。预览、截图、`list_pages`、
导出、发布看的**全是产物根** —— 改完源必须重新构建，否则用户看到的还是旧的。
构建必须用绝对路径或 `(cd <站点文件夹> && npm run build)` 子 shell 跑，**build 完
`ls` 确认产物真的落在了站点文件夹里的 dist/**（cwd 漂了会把 dist 建到别处）。
`node_modules` / 构建缓存系统永远不扫，不用进 .ndignore。

WebGL/Three.js（含 R3F）的一个静默坑：渲染器属性（如剖切要的
`localClippingEnabled`）传给 `<Canvas gl={{…}}>` 构造参数会被**静默忽略**（无报错
无效果），要在 `onCreated={({gl}) => { gl.localClippingEnabled = true }}` 里设；
`clippingPlanes` 裁掉的是法线**负**侧，"看起来没剖"先怀疑法线方向。

手写起手：`mkdir 观察日志`，然后 Write `观察日志/index.html`（文件夹名换成真站名；
没有起手模板，骨架从需求推、样式从风格名推）。**唯一硬要求是产物根上有 `index.html`**；
样式文件怎么拆怎么叫你定，按站的体量来。
写页面的两条硬规则 —— 违反预览就出错，系统在你每次写站点页后会 lint：
- `<head>` 里必须有 `<meta name="viewport" content="width=device-width, initial-scale=1">`
  （缺了手机端按 980px 虚拟视口渲染，媒体查询看着"没生效"）
- 站内链接一律**相对路径**（下面「路径铁律」）

## 路径铁律

预览和导出都走 `…/artifact-file/<路径>` 这个前缀，URL 结构跟磁盘结构 1:1。
所以：

- 站内链接**只用相对路径**：`about.html` / `posts/x.html` ✓
- **绝不用根路径**：`/about.html` ✗ —— 会跳出前缀直接 404
- 素材优先拷进**站点自己的** `<站名>/assets/`：工作区的生成图 / 上传件先
  `cp assets/generated/x.png <站名>/assets/`，站内写 `assets/x.png`。
  这样导出 zip / 发布时零改写。直接引 `../assets/…` 也能用（站点在工作区的一个文件夹里，只爬一层；导出时系统会归一），
  但拷进来更稳
- 外链正常写 `https://…`

## 系统怎么认产物（多产物平权）

**不用声明**，写出来就认。一个工作区可以装多个平等产物：

- 文件夹里有 `index.html`（或它的产物根里有）= 一个站点，同目录 `.html` 是它的子页
- 带 `index.html` 的**一级子目录**各是一个站
  （两个平行版本就放 `v1/` `v2/`）
- 顶层每个 `.html` = 各一份 deck（旧项目的根站存在时只有 `canvas.html` 保留 deck
  身份，其余算站点子页）
- 桌面上一个站点 = **一张**卡（不是每个 html 一张），双击开响应式预览窗；
  `_drafts/` 里的单页各自一张卡
- 导出菜单换成整站 zip / 单页自包含 HTML / 工程交付包（PDF/PPTX 不出现，站点没有分页）
- 不会被注入分页 fit script（那是 deck 的整屏翻页脚本，注进站点会把长页变成翻页器）
- `canvas-validate` 的 anchor / layout-role 校验不跑（那是 deck 规约）

同一个工作区里 deck / 站点 / docx 可以并存，各自一张卡；不用也不要让用户去"开新任务"。

## 运行时库与构建

- CDN 随便用（跟 deck 同生态）：`<script>` 标签或 importmap 拉 gsap / lenis /
  three / alpine / htmx / echarts / katex（esm.sh / unpkg / jsdelivr）
- npm install 跑得通，但依赖不进导出包 —— 只有构建型站点才值得装
- **打包器一律配相对 base**（vite: `base: './'`）—— 预览挂在 artifact-file
  深前缀下，根路径产物全部 404。这条加上"页=html 入口、别上 SPA router"，
  踩了才发现就是返工整站；上构建道前先 Read site-craft skill 的
  `patterns/build-lane.md`
- 硬约束：**产物必须是纯静态文件**。SSR / 需要常驻 Node 进程的方案不行
- CDN 依赖意味着导出的 zip 离线打开时缺那些库（联网打开正常，发布后正常）

## 感知层怎么用

| 想知道 | 用 |
|---|---|
| 这站有哪些页、彼此怎么连、有没有断链 | `list_pages`（站点下返回站点结构 + 断链清单，扫的是产物根） |
| 某一页长什么样 | `screenshot_canvas { path, device }` |
| 移动端断点有没有生效 | `screenshot_canvas { device: 'mobile' }`（真的按 390px 渲染） |
| 某个元素的实际盒子 / 计算样式 | `query_elements` / `get_computed_styles`（站点按 1440 宽量） |
| 交互态（点开的菜单 / 填到一半的表单 / 玩到一半的游戏） | `artifact_open` 开进会话 → `artifact_computer` / `artifact_find` 操作到那一步 → 上面的量具带 `live:true` 对着现在这一页量 |
| 自己的页靠什么在动、reveal 有没有真接上 | `artifact_motion`（跟参考站的 `browser_capture motion` 同一把尺） |
| 页面正文 | 直接 `Read`（站点页面通常不大）；`read_page` 的页码语义不适用 |

`screenshot_canvas` 站点下默认整页（fullPage），因为网页本来就是长的，只截首屏
等于没看过下面那些。

## 常坑

- **构建型站点改了源忘构建**：预览指向产物根，源改完不 build 用户什么都看不到。
  每轮改动收尾时跑一次构建再自检
- **构建型站点上的 DirectEdit**：用户在预览里直接改的字落在**产物**上，下次构建
  会被冲掉。收到构建型站点的 DirectEdit 变更时，把改动**同步回源文件**再重新构建
- **忘了 `<meta name="viewport">`**：移动端会按 980px 虚拟视口渲染，你的媒体查询
  看着"没生效"，其实是视口不对。没有模板兜底了，每写一页自己加；漏了系统会 lint 出来
- **字体链少了 CJK 那段**：`'Inter', sans-serif` 换台机器中文就掉到系统默认字体。
  每段 latin family 后面必须跟 `'PingFang SC', 'Noto Sans SC'`
- **改了 style.css 预览没变**：不会。html/css/js 走 `no-cache`，写完即时刷新
- **标点跟正文主体语言走**：中文正文里的 `,` `:` 很扎眼，用全角 `，` `：`；
  英文正文反过来，全角标点混进去一样扎眼，用半角加空格
