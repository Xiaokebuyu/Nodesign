/**
 * 点选操作条（2026-08-27 桌面交互重制；同日按用户拍板重画皮）
 *
 * ⚠️ 皮的规矩：**这是一条板书样的控件，不是图标工具条的复制品**（用户原话）。
 * 视觉语言抄 nd:controls 的按钮（MdInk 里那种）：楷体文字标签、暖墨细边、
 * 纸面上的一排手作小钮，微微一点旋转 —— 看上去像 agent 落在板上的控件，
 * 而不是浮出来的一块 UI。图标条仍在（hover 工具条），两条共用 object-actions
 * 一份动作表，这里消费 label，那里消费 icon。
 *
 * 落位走 action-bar-place.js 的降级链：四周三圈找空位（远了画引线示归属）
 * → 全满贴视口下缘变 HUD（对象名 + 动作，永不消失）。障碍 = 其他物件 +
 * 文件夹卡 + 角色精灵。坐标换算走 board-camera 的 worldToScreen（唯一真身）。
 */
import { COLOR, GAP, RADIUS, FONT_SIZE, CANVAS, alpha } from '../../lib/theme.js';
import { PAPER, PAPER_SHADOW } from '../../lib/paper.js';
import { TEXT_FONT_CSS } from '../../lib/text-fonts.js';
import { sizeOf } from '../../lib/board-kinds.js';
import { worldToScreen } from '../../lib/board-camera.js';
import { placeBar } from '../../lib/action-bar-place.js';
import { buildObjectActions } from './cards/object-actions.js';

const INK = '#2b2117';

/** 一枚钮的估宽：CJK 14px/字 + 左右 padding 20 + 边 2 */
const btnW = (label) => [...label].reduce((n, c) => n + (/[　-鿿＀-￯]/.test(c) ? 14 : 8), 0) + 22;

export default function ObjectActionBar({
  o, positioned = [], folderView = [], spriteRects = [], cam, viewport,
  title = '', handlers = {}, onClose = null,
}) {
  const actions = buildObjectActions(o, handlers);
  if (!actions.length || !cam || !viewport?.w) return null;

  const z = cam.z || 1;
  const toScreen = (r) => ({ ...worldToScreen(r, cam), w: r.w * z, h: r.h * z });
  const szo = sizeOf(o);
  const target = toScreen({ x: o.pos.x, y: o.pos.y, w: szo.w, h: szo.h });
  const obstacles = [];
  const pushIfVisible = (r) => {
    if (r.x < viewport.w && r.y < viewport.h && r.x + r.w > 0 && r.y + r.h > 0) obstacles.push(r);
  };
  for (const it of positioned) {
    if (it.id === o.id) continue;
    const s = sizeOf(it);
    pushIfVisible(toScreen({ x: it.pos.x, y: it.pos.y, w: s.w, h: s.h }));
  }
  for (const zn of folderView) pushIfVisible(toScreen(zn));
  for (const r of spriteRects) pushIfVisible(toScreen(r));

  const bar = { w: 12 + actions.reduce((n, a) => n + btnW(a.label) + 6, -6), h: 34 };
  const p = placeBar({ target, bar, viewport, obstacles });
  const hud = p.mode === 'hud';

  const buttons = actions.map((a, i) => (
    <button
      key={i} type="button" title={a.title} data-board-action
      onClick={(e) => {
        e.stopPropagation();
        if (a.anchored) {
          const r = e.currentTarget.getBoundingClientRect();
          a.fn?.({ x: r.left, y: r.bottom + 6 });
        } else a.fn?.();
      }}
      style={{
        fontFamily: TEXT_FONT_CSS.kai, fontSize: 13.5, lineHeight: 1.4, cursor: 'pointer',
        padding: '3px 10px', borderRadius: RADIUS.md,
        border: `1px solid ${alpha(a.danger ? '#a8362b' : INK, 0.28)}`,
        background: 'transparent',
        color: a.danger ? PAPER.red : PAPER.ink,
        whiteSpace: 'nowrap',
      }}
    >
      {a.label}
    </button>
  ));

  // 一小片纸，微微一点旋转 —— 手作感来自这一度，别加成海报
  const paperStrip = {
    display: 'flex', alignItems: 'center', gap: 6,
    background: PAPER.paper, borderRadius: RADIUS.md,
    padding: '4px 6px', boxShadow: PAPER_SHADOW.far,
    transform: 'rotate(-0.4deg)',
  };

  if (hud) {
    // 降级末档：四周全满 → 贴视口下缘的屏幕锚定条（对象名示归属，永不消失）
    return (
      <div data-board-action style={{
        position: 'absolute', left: '50%', bottom: 12, transform: 'translateX(-50%) rotate(-0.4deg)',
        zIndex: 60, ...paperStrip, paddingLeft: GAP.sm,
      }}>
        <span style={{
          fontFamily: TEXT_FONT_CSS.kai, fontSize: FONT_SIZE.sm, color: COLOR.text2,
          maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{title}</span>
        {buttons}
        {onClose && (
          <button type="button" data-board-action title="收起" onClick={(e) => { e.stopPropagation(); onClose(); }}
            style={{
              fontFamily: TEXT_FONT_CSS.kai, fontSize: 13.5, cursor: 'pointer', padding: '3px 8px',
              border: 0, background: 'transparent', color: COLOR.sub,
            }}>收</button>
        )}
      </div>
    );
  }

  const barCx = p.x + bar.w / 2; const barCy = p.y + bar.h / 2;
  const tgtCx = target.x + target.w / 2; const tgtCy = target.y + target.h / 2;
  return (
    <>
      {p.detached && (
        // 引线：条被挤远了，一条虚线牵回对象，归属看得清
        <svg aria-hidden style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 59, width: '100%', height: '100%' }}>
          <line x1={barCx} y1={barCy} x2={tgtCx} y2={tgtCy}
            stroke={alpha(CANVAS.brass, 0.55)} strokeWidth={1.5} strokeDasharray="4 4" />
        </svg>
      )}
      <div data-board-action style={{ position: 'absolute', left: p.x, top: p.y, zIndex: 60, ...paperStrip }}>
        {buttons}
      </div>
    </>
  );
}
