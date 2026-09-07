# Quote Backdrop（layout-role: `image-led`）

引言页：图弱化作衬底，一句大字 quote 是唯一主角。情绪转折 / 关键判断 / 立意页用。

## 意图

quote 页是 deck 节奏里的"暂停"，价值全在减法。它跟 portrait 的分工：portrait
人在前景 quote 作装饰，这里 quote 是主角图退成氛围。

## 真正硬的几条

- **衬底图弱化要有度**：淡到读不出意境（如 opacity-10 的过度弱化）与喧宾夺主的全亮
  都不合适，图要能感觉到但不干扰读字。罩层带一点锚的底色比纯黑白罩透气。
- **这页只有 quote + 出处两个元素**。每多加一个装饰就背叛一次"暂停"的意图。
- 出处是辅料：小字、另一种字体质感，跟 quote 拉开重量。

## 写法

图 `absolute inset-0 object-cover` + 低透明度，quote 用锚的 display 字体放大，
居中或偏置构图从锚推导。section 标 `data-layout-role="image-led"` + 常规
data-page / data-anchor；img 建议带 `data-asset-role="quote-backdrop"`。
