# Hybrid deck 技术参考（首次写 HTML 时注入）

起手：Read `canvas.template.html`（加载本 skill 时自动拷进 cwd），改写落到目标路径。
模板预置 importmap（21 库）、Babel、Tailwind、4 个 inline shadcn 组件、键盘翻页、
mode-detect、image CSS vars。**boilerplate 必须 verbatim 搬**，凭印象重写会差字节
（importmap 版本号、shadcn 闭花括号），deck 静默坏。两条走法：Write-first（Read 模板把
verbatim 装进 context 再 Write 整文件）或 **Edit-first（更省）**：Read 后只 Edit 替换
`<style id="design-tokens">` 和 `<div class="__nd-deck-wrap">` 两块，boilerplate 不动。
fit script 由系统在导出时注入，模板不带。

## 1 文件 4 类内容

```html
<head>
  importmap：全部库（agent import 哪个，浏览器才下哪个）
  Tailwind Play CDN + tailwind.config（只配 fontFamily，颜色走 CSS var）
  Babel Standalone：浏览器内编译 TSX
  <style id="design-tokens">：CSS variables（风格锚写这里）
  <style id="base">：section[data-page] 由 wrap data-deck-aspect 锁 W/H，保持原样
</head>

<body>
  <div class="__nd-deck-wrap" data-deck-aspect="16:9">
    <!-- 简单 section：纯 HTML/CSS + Tailwind，DirectEdit 全 work -->
    <section data-page="1" data-layout-role="image-led" data-anchor="cover">...</section>

    <!-- 复杂 section：React mount，必须 data-react-mount 包裹 -->
    <section data-page="2" data-layout-role="data-led">
      <div data-react-mount="chart" id="chart-mount"></div>
    </section>
  </div>

  <script type="text/babel" data-type="module" data-presets="react,typescript">
    import React from 'react';   // Babel classic JSX runtime 必须 import default
    import { createRoot } from 'react-dom/client';
    import { LineChart, Line, ResponsiveContainer } from 'recharts';
    function Chart() { return <LineChart>...</LineChart>; }
    createRoot(document.getElementById('chart-mount')).render(<Chart />);
  </script>
</body>
```

## 标记规约

| 属性 | 装在哪 | 用途 |
|---|---|---|
| `data-page="N"` | section 必装 | 分页（SlideNavigator / list_pages 靠它） |
| `data-layout-role="text-led\|image-led\|data-led\|hybrid"` | section 必装 | 页型角色，对应 patterns/<role>.md |
| `data-anchor="kebab-name"` | 每页 2-4 个关键元素 | 跨 turn 引用 / 评论 pin / findElementByAnchor 的唯一锚源，**deck 内唯一** |
| `data-react-mount="<id>"` | React mount 容器必装 | DirectEdit 跳过它（React re-render 会吃掉用户改的字） |
| `data-layout="<自由词>"` | section 选填 | layout hint，list_pages 做总览用 |
| `data-skeleton="<slug>"` | 骨架阶段临时 | 空 section 占位，填完换成 `data-anchor`；自检 grep 残留 = 漏填的页 |

anchor 用 kebab-case，重名加页号或角色后缀（`portrait-name-p3` / `cover-sub-detail`）。
每个 div 都加 anchor 等于没加，只锚主标题 / CTA / 主视觉 / 关键文本。
`data-node-id` 已废弃，不要写。

## 库速查（importmap 已声明，import 即用）

| 库 | 用在 |
|---|---|
| `recharts` / `echarts` + `echarts-for-react` | 数据图表（recharts 西式简洁 / echarts 中文 a11y 全） |
| `framer-motion` / `motion` | React 声明式动画 |
| `gsap` | timeline / stagger / scrollTrigger 命令式动画 |
| `lucide-react` | icon（1500+ 线性） |
| `mermaid` | 流程图 / 架构图 / 时序图 |
| `shiki` | 代码高亮 |
| `embla-carousel-react` | 轮播 |
| `react-katex` | 数学公式 |
| `reactflow` | 节点图 / 思维导图 |
| `@radix-ui/react-{dialog,tabs,tooltip,accordion,popover,scroll-area}` | 要 a11y / 键盘导航时 |
| `three` + `@react-three/fiber` + `@react-three/drei` | 3D（体积大，用之前想清楚） |
| `lenis` | 平滑滚动（landing-style deck 才需要） |

模板自带 4 个 inline shadcn 组件直接用不必 import：`<Card>` `<Button>` `<Badge>` `<Tabs>`
（源码在 `<script id="__nd-shadcn-lite">`）。对照表 / 特性卡 / 用例这类场景直接 reach for。

## 常坑

- `import React from 'react'` 不能省（Babel classic runtime 要 React 在 scope）。
- JSX 里占位文字写纯文本，不要 `{改我}`。
- 锚元素用 `position: absolute` 不用 `fixed`：section 自身有 transform scale，fixed 锚不到 viewport。
- 用 `flex-1 min-h-0` 撑高度，不要 `h-[calc(100%-Npx)]`，hardcode 的数在别的视口会溢出。
- 信息多就拆页：8 页空一点好过 6 页塞爆（单屏硬规则见 prelude）。

## 外部资源

核心视觉资源（封面图 / 章节图 / BGM）`curl -L -o ./assets/<name>` 下载后引本地路径，
比 hotlink 稳。icon 库、Google Fonts、importmap 里的 esm.sh / unpkg 直接 hotlink。
`curl -L -o` 只能写到 cwd 底下，写别处静默失败。

## 6 个 layout-role 骨架

路径是 **skill 的 base directory 下的 `patterns/<role>.md`**——`Skill` 工具加载
`deskskill-engine-mini` 时会打印那个 base directory，直接拼上 `patterns/…` 即可，
不要猜 plugin 根目录（`<plugin>/patterns/` 是错的，那层没有这个目录）。

六个 role：image-led-cover / section-divider / portrait / quote-backdrop /
text-led / hybrid-grid。写对应 role 的页之前 Read 一下，里面是标记规约、铁律和
最小代码片段。不读直接照搬模板范例，视觉会被锚死在默认审美上。
