# 抠图叠层（贴纸感拼贴）

透明抠图当**版面元素**用，不是当配图。配图待在自己的框里；版面元素参与排版 ——
压线、越界、垫在文字后面。个人站 / 产品页 / 有吉祥物的品牌最吃这套。

## 管线

1. `generate_image` 出主体（prompt 里要求简洁背景、主体完整、边缘清晰 ——
   纯色底的图抠得最干净）
2. `mcp__nodesign__remove_background({ inputPath })` → RGBA PNG
3. `cp` 进站点文件夹自己的 `assets/`，站内写相对路径 `assets/x.png` 引用

薄透元素（玻璃 / 烟雾 / 飘发 / 半透明纱）抠不干净是 ML 抠图的物理极限，
这类主体生图时就避开，或者接受边缘软。

## 三种叠法

**① 骑线**：主体跨在两个区块的分界上，把"分割"变成"衔接"。

```css
.divider-figure {
  position: relative;
  margin-top: -60px;        /* 探进上一节 */
  margin-bottom: -20px;     /* 压住下一节开头 */
  z-index: 2;
}
```

**② 探出边缘**：吉祥物 / 人物从正文容器边上探出来，打破盒子感。

```css
.peek {
  position: absolute;
  right: -48px;             /* 一部分出界 */
  bottom: 0;
  width: 180px;
  transform: rotate(3deg);
}
.text-block { position: relative; overflow: visible; }
```

**③ 散落**：小物件（星星 / 邮票 / 道具）随机感地撒在标题周围或节间空白。
每个带一点不同的旋转和尺寸，两三个就够，撒多了变星空背景。

## 让它像贴纸而不是浮着的 PNG

- **微旋转**：-3° ~ 3°，每张不同。0° 的抠图看着像素材库，歪一点才像人手贴的
- **阴影贴地**：`filter: drop-shadow(0 6px 12px rgba(0,0,0,.18))` ——
  用 drop-shadow 不用 box-shadow（后者会给透明区画一个矩形影子）
- **白边贴纸风**（可选，适合手帐 / 复古气质）：
  `filter: drop-shadow(0 0 0 #fff) drop-shadow(0 0 1px #fff)` 叠几层出白描边，
  或生图时直接要求 sticker style with white border
- **尺寸克制**：版面元素不是主图，探出的部分占正文宽 15~25% 就有效果

## 责任边界

- 叠层元素一律 `position: absolute` / 负 margin + `z-index`，**别让它参与文档流**，
  不然改一段文字整页元素跟着跳
- 窄屏必须处理：探出屏幕外、盖住正文都是常见事故。`max-width: 860px` 断点里
  要么缩小收回，要么 `display: none` —— 装饰元素在手机上消失是完全正当的
- `screenshot_canvas { device: 'mobile' }` 看一眼再算完成
