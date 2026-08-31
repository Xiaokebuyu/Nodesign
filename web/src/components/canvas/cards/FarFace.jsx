import { COLOR, GAP, FONT_SANS, FONT_SIZE, alpha } from '../../../lib/theme.js';
import { labelOf, titleOf, chromeOf } from '../../../lib/board-kinds.js';
import { BLANK_W, renderedW } from '../../../lib/board-lod.js';

/**
 * 拉远之后卡片的那张脸：只画名字，不画内容（2026-08-31，判据在 lib/board-lod.js）
 *
 * ## ⭐⭐ 为什么要反着缩
 *
 * 这张脸活在**世界层**里，所以它的一切尺寸都会跟着相机缩：0.25 倍下写 12px 的字，
 * 落到屏幕上只有 3 个物理像素，等于什么都没画。所以字号必须反着缩回来。
 *
 *     子元素物理宽 = css宽 × 相机缩放 × 自身transform
 *     想让它正好铺满卡片、且字是物理 12px：
 *       css宽 = 卡片世界宽 × 缩放，  transform = 1/缩放
 *     两者一乘，物理宽 = 卡片世界宽 × 缩放（正好是卡片的渲染宽），字号 = 12 物理像素
 *
 * 这跟 BoardObject 里 hover 工具条、TransformControls 的手柄是同一条规矩：
 * **住在世界层、但要保持物理尺寸的东西，一律反缩**。
 *
 * ## 名字从哪来
 *
 * 走 board-kinds 的 titleOf —— 跟连线浮层念的是同一个名字。⛔ 别在这儿另写一套
 * "怎么称呼一张卡"，画布上写一个名字、弹窗里念另一个是最容易让人怀疑自己看错的
 * 那种 bug。形态名走 labelOf，也是形态表里现成的那一份，不新开表。
 *
 * ## 三档里的两档
 *
 * label 档画名字；blank 档（窄到连词都认不出）只留一个色块。
 *
 * ⚠️ blank 档**不能一律返回 null**：有卡片外观的形态（产物/文件/图）底色和边框
 * 在 BoardObject 的 base 上已经画好了，返回 null 正好；但**墨类没有卡片外观**
 * （板书、手写字的 chrome 是 bare），null 意味着它在全貌上整个消失。
 * 而板书恰恰是板上字最多的那一类 —— 缩出去看全局，写得最多的地方一片空白，
 * 这个方向是反的。所以墨类在 blank 档自己补一块淡色。
 * ⭐ 这条是截图看出来的，纯函数判据和 DOM 断言都不会红（元素确实"正确地"没渲染）。
 */
export default function FarFace({ o, scale, worldW, worldH }) {
  const px = renderedW(worldW, scale);
  const bare = chromeOf(o) === 'bare';
  if (px < BLANK_W) {
    // 有卡的自己有底色和边框，不用补；墨类补一块，否则它在全貌上不存在
    return bare ? (
      <div aria-hidden data-far-blank style={{
        position: 'absolute', inset: 0, borderRadius: 3,
        background: alpha(COLOR.text, 0.14), pointerEvents: 'none',
      }} />
    ) : null;
  }

  const inv = 1 / (scale || 1);
  // 两行放得下才画形态名：一行字 + 行距约 30 物理像素，给不到就只留名字
  const twoLines = renderedW(worldH, scale) >= 44;

  return (
    <div
      aria-hidden
      style={{
        position: 'absolute', inset: 0,
        // css 尺寸按"渲染像素"给，再用 1/缩放 顶回去（见文件头那两行推导）
        width: worldW * scale, height: worldH * scale,
        transform: inv !== 1 ? `scale(${inv})` : undefined,
        transformOrigin: '0 0',
        display: 'flex', flexDirection: 'column', justifyContent: 'center',
        gap: 2, padding: `0 ${GAP.xs}px`,
        pointerEvents: 'none', userSelect: 'none', overflow: 'hidden',
      }}
    >
      <div style={{
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, lineHeight: 1.25, color: COLOR.text,
        // 两行封顶而不是一行：卡片名字常常是一句话，一行省略号之后剩不下几个字
        display: '-webkit-box', WebkitLineClamp: twoLines ? 2 : 1, WebkitBoxOrient: 'vertical',
        overflow: 'hidden', wordBreak: 'break-word',
      }}>
        {titleOf(o)}
      </div>
      {twoLines && (
        <div style={{
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.xxs, color: COLOR.sub,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {labelOf(o)}
        </div>
      )}
    </div>
  );
}
