---
name: mistridge-site
description: 雾岭官网 mistridge-site 的结构与风格锚（杂志编辑风，承接品牌手册）
metadata: 
  node_type: memory
  type: project
  modified: 2026-09-11T14:48:31.867Z
---

2026-09-11 建成 mistridge-site/（index.html + style.css + main.js，单页长滚动）。
风格锚 = 杂志编辑风（精品咖啡刊物），色字全部取自 [[mistridge-visual]]：
- 底色 paper #F1EFEA，豆单节 mist #E6E3DC，冲煮节 pine #2F3B34，联系节 #252F29
- 字体：Noto Serif SC（=思源宋体）正文与标题、Cormorant Garamond 西文、IBM Plex Mono 数字、Noto Sans SC 小标签
- 结构：首屏 → 故事（海拔剖面 SVG + 四条原则）→ 豆单（三袋当 tab，选中面板用各自标签色）→ 冲煮（方法 tab + 粉水换算）→ 订阅（横线列表三档 ¥68/128/178）→ 联系
- 包装图用 assets/pack-*.webp（已按透明边界裁齐，三袋等大）

**Why:** 订阅价格、微信号、邮箱 hello@mistridge.coffee 都是占位，等用户给真实信息。
**How to apply:** 后续加页沿用同一 style.css 变量；改价格/联系方式先问用户。

2026-09-11 发布演示稿 mistridge-launch/index.html：7 页 1920×1080 画幅，scroll-snap 翻页。结构以用户在板上改后的版本为准（删了「怎么喝」，订阅页加「首批限量 300 袋」）。首发日期 10.13 为占位待确认。
