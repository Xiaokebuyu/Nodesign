# 构建道 —— 组件库与打包器站点的平台配方

手写道（一夹 html + css）解决八成站点。这份配方讲剩下两成：什么时候值得上
构建，采用之后如何与平台约束保持兼容。

## 什么时候上构建道

**真信号**（有一条就值得）：

- 同一块 UI 结构在三处以上重复、而且还会继续长 —— 组件复用是唯一还不掉的债
- 交互核心有状态：筛选器 / 计算器 / 播放器 / 小编辑器。手写 DOM 操作超过
  两百行，就该让框架管状态了
- 内容源是数据不是页面：几十篇 md、一份 JSON 目录 —— 页面应该被**生成**，
  不该被逐页维护
- 要用 npm 独占的库（CDN 上没有，或 CDN 版残缺）

**假信号**（听着像，其实不是）：

- 「显得正经 / 专业」—— 观感由排版和素材决定，不由构建工具决定
- 「以后可能要扩展」—— 到那天再迁。迁移的一次性成本低于工具链税的利息
- 「动效复杂」—— gsap / lenis 走 CDN 即可，动效从来不是上构建的理由

## 三条平台硬约束（违反 = 404 或感知失明）

1. **`base: './'`**。预览与导出都挂在 `…/artifact-file/<路径>` 深前缀下，打包器
   默认产出的 `/assets/xx.js` 根路径会跳出前缀直接 404。vite 一行 `base: './'`
   解决；选别的工具前先确认它能**全相对**输出（Astro / Next 在这一点上适配困难，
   不建议强行改造）。
2. **页 = html 入口，router 不进站点**。`list_pages`、按页截图、按页刷新、整站
   导出全按 html 文件寻址；SPA + 客户端路由让这些全部失明，深链接发布后照样
   404。多页 = vite `rollupOptions.input` 多入口。例外：纯应用站（整站就是一个
   工具）可单页、无路由，不受此限。
3. **产物纯静态**照旧（SSR / 常驻进程不行）。`vite build` 落 `dist/`，系统自动
   认作产物根。

## 起手：五个文件手写，不用脚手架

`npm create vite` 是交互式命令（会阻塞回合），且模板是单页 App —— 与
约束 2 冲突。手工创建即可，耗时很短：

```bash
mkdir 站名 && cd 站名
npm i --no-audit --no-fund react react-dom
npm i -D --no-audit --no-fund vite @vitejs/plugin-react tailwindcss @tailwindcss/vite
```

版本让 npm 解到当前大版本，**别手填猜的版本号**（猜错一个 peer 链全断）。
发布不满一年的新锐库默认不用 —— 你对它的知识大概率是错版本的。

```jsonc
// package.json 里 build 必须写进 scripts ——
// 工程交付包带源不带依赖，接手的人依靠 `npm i && npm run build` 恢复构建
{ "scripts": { "build": "vite build" } }
```

```js
// vite.config.js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  base: './',                                            // 硬约束 1
  plugins: [react(), tailwindcss()],
  build: { rollupOptions: { input: ['index.html', 'about.html'] } },  // 每页一入口
})
```

其余两件：`index.html`（真内容写在里面，见下节）和 `src/`（每页一个小入口 js）。

## html 是骨架，React 是器官

平台的感知层读的是 html：`list_pages` 从产物 html 里抓 `<a>` 拼站点结构和断链
清单，Read 产物页看到的是标签正文。整页 JSX 渲染 = 产物 html 只剩一个
`<div id="root">` —— 结构失明、断链失明，发布后搜索引擎同样无法解析。

所以：**内容仍写在真 html 里**（或由脚本生成真 html），React 只挂需要状态的
那一块：

```html
<section id="filter-app"></section>   <!-- 只有这一块是 React 的 -->
```

每页一个小入口 js 挂自己的器官。纯应用站例外：整页 React，感知靠截图，
结构靠你自己心里有数。

## 组件库：抄进来，不是装进来

装一个 kit（MUI / AntD / Chakra）= 把整站气质外包给别人的默认值 —— 反默认
清单里每一条它都替你答了，答的全是均值；而且它跟你的排版系统（三个数、间距
刻度、灰梯度）各论各的。需要现成组件时用**抄**的：

- 行为复杂、样式想自己定的（弹层 / 下拉 / tabs / 无障碍）：headless 一层
  （radix 系），外观样式全部自行实现
- shadcn 式 copy-in：组件**源码落进工作区**才改得动气质；装成依赖的组件
  你只能"配置"它
- 图表（echarts）、3D（three）这类**画布型**库不在此列 —— 它们不带 UI 气质，
  正常装正常 import

## Tailwind 的立场（跟手写道不同，不矛盾）

手写道不推 utility，理由是**用户自己要改得动**（改行高不能改一百处）。构建道
上改样式的人是你，这条理由消失，utility 的密度优势成立。但气质旋钮必须还是
集中的：三个数（字距 / 行高 / 正文宽）、间距刻度、灰梯度、主色，全部进
`@theme`（Tailwind 4 的 CSS-first 配置），页面上只允许出现刻度里的值。
`tracking-[0.06em]` 这类任意值逃逸写法出现在正文上，= 排版系统破产的信号。
字体链 CJK 规矩照旧。

## 回合节奏（构建耗时的现实约束）

- **凑一批改动跑一次 build**，不是每笔一 build。小工程一次 build 5~15 秒，
  回合里最贵的不是它，是你为它排队的次数
- build 验收后才准截图：`npm run build && echo BUILD_OK` —— 没看到 BUILD_OK
  就去修错，**别截图**。build 失败时 dist 里躺着上一版，截图会"看见"旧画面，
  让你以为改动无效、往错误方向排查 —— 这是构建道最贵的幻觉
- **绝不起 dev server**：`npm run dev` 是常驻进程，会挂死你的命令回合；平台
  预览也不看它 —— 预览只认产物根的静态文件。构建道的"热重载"就是
  build + 按页刷新
- 每加一个包先问一句：CDN 一行、或手写三十行，是否已经足够 —— node_modules
  不进导出、不进发布，纯粹是工作区里的重量

## 素材与内容站

- 素材放 `public/assets/`（build 原样拷进 dist），页面里按手写道同样的相对
  路径规矩引。生成图落地后要**再 build 一次**才出现在产物里 —— 跟改源同一
  节拍，凑批处理
- 几十篇 md 的内容站：**自写 build 脚本优先**（node + marked，六十行的事）——
  模板全权在你手里，相对路径天然合规。Astro / 11ty 也跑得通，但它们的链接
  与资源默认根路径，需要逆着它们的默认约定调整配置；不熟悉时不要选成本更高的方案

## DirectEdit 回写（构建道上会致命，多提一次）

用户在预览里直接改的字落在**产物**上，下一次 build 会冲掉。收到构建型站点的
DirectEdit 变更：先把改动同步回源（JSX / md / 模板里对应那处），再 build。
