# Image-led Cover（layout-role: `image-led`）

封面 / 全幅 hero。图占满，文字是浮层。它是整个站点的视觉锚种子：用户认可这张
cover 后，它的风格（光线 / 色调 / 质感）通过 referenceImages 传染给后续所有生成图。

## 意图

入口页要在一秒内传达出锚的气质。判断一张 cover 成不成，遮住文字只看图，
还能不能感受到这个站点是什么气质。

## 真正硬的几条

- **图传达的别再用文字重述**。"古书堆图"旁边不写"古典氛围"，重复等于不自信。
- **文字克制**（标题 + 可选副标 + 可选编号，就这些）。想写更多说明这页不该是 cover。
- **overlay 别用纯黑半透明蒙层压全图亮度**。要压就只压文字落脚的局部（渐变到底部
  或角落），大字加 drop-shadow，图的亮部留给图。
- **cover 是种子**：生成后主动请用户确认方向，approve 之前别往后铺。方向选错，后续整体都会偏移。

## 写法

图 `absolute inset-0 object-cover` 铺底，`object-position` 按视觉重心调（人物通常
center-top）。布局、渐变方向、文字位置全部从锚推导，没有默认值。

标记：section 必带 `data-page` / `data-layout-role="image-led"` / 唯一 `data-anchor`；
img 建议带 `data-asset-role="cover"` + `data-asset-source`（审计与重生成用的约定）。
