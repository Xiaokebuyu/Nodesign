# Hybrid Grid（layout-role: `hybrid`）

图文并列的阵列页：feature 阵列 / 多 variant 展示 / 案例集 / 步骤对照。

## 意图

阵列页最容易掉进"等高卡片网格"的默认套路（反默认清单第一条）。做之前先问：
这些并列项里有没有主角？有主角就打破均质（一大多小、Z 型错位），真没有主角
（型号对照表这类）等高才是诚实的选择。

## 真正硬的几条

- **格数有天花板**：超过 6 格视觉碎片化，切 `<Tabs>`（≤4 个 variant 逐个看）或
  embla 轮播（更多）。模板自带 `<Card>` `<Tabs>`，feature 阵列优先使用这两个组件。
- **每格图共用 referenceImages** 保持风格一致，跟 portrait 的多人物同理。
- **锁图片比例**（aspect-ratio），未锁定比例时 grid 高度参差，是最常见的失误。
- caption 是辅料，字号和颜色明确低于格标题。

## 写法

列数、间距、是否等高全部从内容角色推导。section 标 `data-layout-role="hybrid"` +
常规 data-page / data-anchor；格内 img 建议带 `data-asset-role="illustration"`。
