# Section Divider（layout-role: `image-led`）

章节扉页：多章节 deck 的中段切片。全屏图 + 章节号 + 一句概括。

## 意图

转场页管的是节奏，给观众一次呼吸和一次预告。它的存在让正文页不必每页顶部
贴 chip 复述"现在是第几部分"（那是反默认清单第四条）。跟 cover 的区别：
cover 是入口，需要立住气质；divider 是分隔，需要收敛，文案密度更低。

## 真正硬的几条

- **只有章节号 + 标题（+ 可选一句概括）**。bullet 和段落出现在这页就是结构错了。
- **跟 cover 共用 referenceImages 系列**保风格一致，但场景换（cover 是主体 hero，
  divider 换 environment / mood），不然像同一张图裁了两次。
- 章节号和标题拉开质感反差（比如编号用 mono 大字距，标题用锚的 display 字体），
  同质感排两行就平了。

## 写法

全屏图铺底 + 局部 overlay，居中或角落构图从锚推导。section 标
`data-layout-role="image-led"` + 常规 data-page / data-anchor；img 建议带
`data-asset-role="section-divider"`。
