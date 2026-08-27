/**
 * 点选操作条（2026-08-27 桌面交互重制 —— 用户报「板书上的评论按钮特别不好按」）
 *
 * 选中一件东西 → 贴着它出一条纸片操作条。hover 工具条仍在（选中态下让位），
 * 动作表共用 cards/object-actions.js 一份 —— 这条是**点选**的家：触屏没有
 * hover，闲置板书对手势是空地，都够不着 hover 条；点一下永远够得着这条。
 *
 * 落位走 action-bar-place.js 的降级链：四周三圈找空位（远了画引线示归属）
 * → 全满贴视口下缘变 HUD（对象名 + 动作，永不消失）。障碍 = 其他物件 +
 * 文件夹卡 + 角色精灵（世界坐标进来，这里换算成屏幕）。
 *
 * 坐标约定：屏幕 = (世界 + cam) * z，跟 board-camera.js 逐字对应。
 * 渲染在世界层**外面**（pane 坐标）—— 世界层的 transform 自成堆叠上下文，
 * 后置兄弟天然盖在所有物件之上，不用跟 zMax 赛跑。
 */
import { X } from 'lucide-react';
import { COLOR, GAP, RADIUS, FONT_SIZE, CANVAS, alpha } from '../../lib/theme.js';
import { PAPER, PAPER_SHADOW } from '../../lib/paper.js';
import { TEXT_FONT_CSS } from '../../lib/text-fonts.js';
import { sizeOf } from '../../lib/board-kinds.js';
import { placeBar } from '../../lib/action-bar-place.js';
import { buildObjectActions } from './cards/object-actions.js';

/** 按钮 23px（5 padding + 13 图标）+ 4 间距；条身 padding 4 */
const BTN = 23;

export default function ObjectActionBar({
  o, positioned = [], folderView = [], spriteRects = [], cam, viewport,
  title = '', handlers = {}, onClose = null,
}) {
  const actions = buildObjectActions(o, handlers);
  if (!actions.length || !cam || !viewport?.w) return null;

  const z = cam.z || 1;
  const toScreen = (r) => ({ x: (r.x + cam.x) * z, y: (r.y + cam.y) * z, w: r.w * z, h: r.h * z });
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

  const bar = { w: 8 + actions.length * BTN + (actions.length - 1) * 4, h: 31 };
  const p = placeBar({ target, bar, viewport, obstacles });
  const hud = p.mode === 'hud';

  const buttons = actions.map((a, i) => {
    const Icon = a.icon;
    return (
      <button
        key={i} title={a.title} data-board-action
        onClick={(e) => {
          e.stopPropagation();
          if (a.anchored) {
            const r = e.currentTarget.getBoundingClientRect();
            a.fn?.({ x: r.left, y: r.bottom + 6 });
          } else a.fn?.();
        }}
        style={{ border: 0, background: 'transparent', cursor: 'pointer', color: COLOR.text, display: 'flex', padding: 5 }}
      >
        <Icon size={13} />
      </button>
    );
  });

  const paperChip = {
    display: 'flex', alignItems: 'center', gap: 4,
    background: PAPER.paper, borderRadius: RADIUS.md, padding: GAP.xxs,
    boxShadow: PAPER_SHADOW.far,
  };

  if (hud) {
    // 降级末档：四周全满 → 贴视口下缘的屏幕锚定条（对象名示归属，永不消失）
    return (
      <div data-board-action style={{
        position: 'absolute', left: '50%', bottom: 12, transform: 'translateX(-50%)',
        zIndex: 60, ...paperChip, paddingLeft: GAP.sm,
      }}>
        <span style={{
          fontFamily: TEXT_FONT_CSS.kai, fontSize: FONT_SIZE.sm, color: COLOR.text2,
          maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{title}</span>
        {buttons}
        {onClose && (
          <button data-board-action title="收起" onClick={(e) => { e.stopPropagation(); onClose(); }}
            style={{ border: 0, background: 'transparent', cursor: 'pointer', color: COLOR.sub, display: 'flex', padding: 5 }}>
            <X size={13} />
          </button>
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
      <div data-board-action style={{ position: 'absolute', left: p.x, top: p.y, zIndex: 60, ...paperChip }}>
        {buttons}
      </div>
    </>
  );
}
