# Portrait（layout-role: `image-led`）

人物页：主角介绍 / 团队页 / 专家背书。人像 + 身份信息 + 一句 quote 或 tagline。

## 意图

这页在建立"人的可信度或存在感"。竖幅（4:5 / 2:3）人像暗示"这是个人"，
横幅环境照暗示"这是个场景"，按你要的语义选。跟 quote-backdrop 的区别：
portrait 人在前景，quote-backdrop 图弱化、大字是主角。

## 真正硬的几条

- **多人物必须锁风格**：generate_image 用同一批 referenceImages 保持光线和质感一致，
  否则团队页像从三个图库拼出来的。
- **信息分三层**：身份小字、姓名大字、quote 另一种质感（斜体或衬线），三层不同
  重量，别做成同字号列表。
- 人像圆角克制：全圆（头像化）让人物失去分量，除非锚本身就是社交产品气质。

## 写法

左图右文或上图下文皆可，比例和间距从锚推导。img 建议带
`data-asset-role="portrait"`；section 常规三件套标记（data-page /
data-layout-role / 唯一 data-anchor，重名加 `-pN` 后缀）。
