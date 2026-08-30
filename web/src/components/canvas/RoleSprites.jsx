/**
 * RoleSprites —— 常驻角色在画布上的精灵（2026-08-26，RP 线块 5）
 *
 * 主 agent 的精灵是「铅笔在纸上画出来的东西」（SpriteSketchLayer 的定格三拍），
 * 角色沿用同一套视觉，但**比主的小一圈**，并且**旁边贴一枚名牌**（贴纸形，写着它的
 * 展示名）—— 一块板上可能同时有叙事者、NPC、主控三方在写字，光看笔迹分不出谁是谁。
 *
 * ⛔ 2026-08-28 修一个从没画出来过的东西：这里原来传 `brand={{ color: p.color }}`，
 * 而 SpriteFigure 拿 `brand` 当**字符串**去查 MARKS 表（`MARKS[{…}]` → undefined），
 * 撞上「认不出的牌子宁可空着也不画错一家」那条早退 —— 于是角色的矢量身体一个像素
 * 都没渲染过，画布上只剩一枚孤零零的名牌。用户报「一直没有被实现」说的就是它。
 * 现在跟主精灵拿同一个 brand（useCurrentModelBrand），只是小一圈。
 *
 * ## 跟主精灵同一套待遇（2026-08-28 用户拍板「主代理支持什么，子代理就相应支持」）
 *
 * 逐条对齐 AmbientSpriteLayer：
 *   z-index 305（原来 44 —— 用户报「看起来和主代理的图标不在一层」，就是这个）
 *   落点 300ms 缓动「走过去」，不再瞬移；拖动时关过渡（不然像橡皮筋追手）
 *   点标说话（onMarkClick，跟主精灵同一个入口）；名牌也可点 —— 它就是这个角色的身份
 *   闲时可拖走；贴着目标干活时不给拖（跟着 targetId，拖了也会被拽回去）
 *   quiet：用户在输入行打字时，角色的手写行一起让位
 *
 * ⛔ 没做的一条：主精灵的输出框（frameCards / 代码直播）。那是主 agent 的工具流
 *   在画布上的落地，角色没有对应的东西可显示 —— 不是漏了。
 *
 * ## 活跃状态就画在这枚标上（2026-08-28）
 *
 * 角色在写 = 标自己动（active 走 SpriteFigure 的呼吸/描线）；挂 await_user 候场 =
 * 整体淡下去 + 名牌收成空心点。输入框上方那行「XX 在写／在等」的文字提示同日撤掉：
 * 同一件事两处说，而画布这处才是它真正发生的地方。
 *
 * ## 为什么是浮层，不是板上物件
 *
 * 用户 2026-08-26 拍板放弃「把精灵连线到产物」，所以它不需要有 id、不进 board.json、
 * 不参与寻址。代价是**导出留不下**（导出的是板，浮层不在板上）—— 这是已知的、
 * 被接受的取舍，不是漏做。要连线的话得把它升成一等物件，那是另一档工程。
 *
 * ## 摆位
 *
 * 贴着它正在写的那个东西（presence.targetId），跟主 agent 工作时的落位同一套算法
 * （findWorkSpot 避让）。没写过东西（没 targetId）就不出现 —— 角色不像主 agent 那样
 * 有"闲时漫游"，它得先站到自己写的那段字旁边才有位置。
 *
 * ⚠️ 2026-08-26 改：**等用户的时候也留在画布上**（只是切 idle 态）。原来的判断是
 * "等的时候不该占着画面"，实测反了 —— 角色一挂 await_user 精灵就消失，用户既
 * 不知道它还在，也不知道该冲谁说话。动静由子代理起飞/落地驱动，见 board-presence.js。
 */

import { useMemo, useEffect, useState, useRef } from 'react';
import { SpriteSketch, findWorkSpot, findAmbientSlot } from './SpriteSketchLayer.jsx';
import { PAPER } from '../../lib/paper.js';
import { TEXT_FONT_CSS } from '../../lib/text-fonts.js';
import { isRolePresence, slugOfPresence } from '../../lib/board-presence.js';
import { useCurrentModelBrand } from '../../lib/model-brand.js';

/** 跟主精灵同一层（AmbientSpriteLayer 用的就是 305）—— 差一层就"看着不在一个平面上" */
const SPRITE_Z = 305;

/**
 * 候场时那句常驻提示（2026-08-28 用户拍板）。
 *
 * 主 agent 的精灵一直有台词，角色闲着时却只剩一枚标 + 名牌 —— 新用户不知道能点它。
 * 它写完这一段停下来，正是"可以跟它说话"的时刻，所以那一刻把话口写出来。
 * 在写的时候不显示：它马上就有自己的话了，提示会跟正文打架。
 */
const IDLE_HINT = '点我说话';

/** 角色精灵比主精灵小一圈（主的是 44） */
const ROLE_SPRITE_SIZE = 32;

/**
 * 身份标：贴在矢量标旁边的一枚**贴纸**（2026-08-28 用户拍板的形态）。
 *
 * 名字取展示名（roleNames），查不到就退回 slug —— 宁可难看也不能张冠李戴，
 * 展示名住在角色文件里而那份文件模型能改（保留字闸在服务端 listRoleNames 出口）。
 *
 * 贴纸感靠三件：微微歪一点（真贴纸贴不正）、纸色底压一道淡影、左端一枚状态点。
 * 状态点是**这个角色此刻在写还是在等**的唯一文字外表达：实心 = 在写，空心 = 候场。
 */
function RoleNameTag({ name, color, waiting, myTurn = false, onClick }) {
  return (
    <div
      onPointerDown={onClick ? (e) => { e.stopPropagation(); e.preventDefault(); onClick(); } : undefined}
      title={onClick ? `跟${name}说话` : undefined}
      style={{
      // 名牌就是这个角色的身份，点它说话跟点标一个意思
      pointerEvents: onClick ? 'auto' : 'none',
      cursor: onClick ? 'pointer' : undefined,
      display: 'inline-flex', alignItems: 'center', gap: 4,
      marginBottom: 3,
      padding: '1px 7px 2px',
      fontFamily: TEXT_FONT_CSS.pen,
      fontSize: 13,
      lineHeight: 1.3,
      color: PAPER.ink2,
      background: PAPER.bg,
      // 在写的那个名牌加重一档（此刻谁在动的唯一文字外表达）
      border: `${myTurn ? 2 : 1}px solid ${color}`,
      borderRadius: 3,
      transform: 'rotate(-1.2deg)',
      boxShadow: '0 1px 2px rgba(93,74,44,0.132)',
      whiteSpace: 'nowrap',
      opacity: waiting ? 0.72 : 1,
    }}>
      <span style={{
        width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
        background: waiting ? 'transparent' : color,
        border: `1px solid ${color}`,
      }} />
      {name}
    </div>
  );
}

export default function RoleSprites({ presence, rectOf, obstacles = [], roleNames = {}, cam = null, viewport = null, quiet = false, onPick = null }) {
  // ⚠️ 不再要求 active（2026-08-26）：角色写完这一段就不在写了，但它**还在台上**，
  // 小人消失会让用户以为它没了、也就不知道该冲谁说话。
  // 2026-08-27：也不再要求 targetId —— 还没写过东西的角色排一个空位
  // （findAmbientSlot，主精灵闲逛用的同一套槽位），上台就看得见、点得到。
  // 跟主精灵同一个牌子（会话模型决定），只是小一圈 —— 角色不自带厂商身份
  const brand = useCurrentModelBrand();
  /**
   * 用户拖过的角色钉在原地。**连着当时的 targetId 一起记** —— 角色换了在写的东西
   * 就该走过去，钉子自然失效；不这么记就得另写一套清理，而清理漏了就是"角色永远
   * 卡在旧位置"。同主精灵的 userPinnedRef，只是这里一个角色一个。
   */
  const [pinned, setPinned] = useState({});    // slug -> { x, y, forTarget }
  const [dragSlug, setDragSlug] = useState(null);
  const dragBase = useRef(null);
  const camRef = useRef(cam); camRef.current = cam;
  const roles = useMemo(() => Object.values(presence || {})
    .filter((p) => p && isRolePresence(p.id)), [presence]);

  // 摆位先算成表再渲染（reportLayout 布局上报随点选操作条 08-27 同日撤役）
  const entries = [];
  const placedObs = [];   // 候场位依次占坑：几个候场角色不叠在同一个槽上
  for (const p of roles) {
    let spot = null;
    const anchor = p.targetId ? rectOf?.(p.targetId) : null;
    if (anchor) {
      spot = findWorkSpot(anchor, obstacles);
    } else if (cam?.z && viewport?.w) {
      spot = findAmbientSlot(cam, viewport, [...obstacles, ...placedObs]);
      // 六槽全占也不许消失（跟 findWorkSpot 同一条规矩）：沿视口上沿排开
      if (!spot) {
        spot = {
          x: Math.round((viewport.w * (0.16 + placedObs.length * 0.12)) / cam.z - cam.x),
          y: Math.round((viewport.h * 0.1) / cam.z - cam.y),
        };
      }
    }
    const slug0 = slugOfPresence(p.id);
    const pin = pinned[slug0];
    // 钉子只在"还在写同一个东西"时算数（换目标=该走过去了）
    if (pin && pin.forTarget === (p.targetId || null)) spot = { x: pin.x, y: pin.y };
    if (!spot) continue;
    placedObs.push({ x: spot.x - 20, y: spot.y - 20, w: 160, h: 110 });
    entries.push({ p, spot });
  }
  if (!entries.length) return null;

  return (
    <>
      {entries.map(({ p, spot }) => {
        const slug = slugOfPresence(p.id);
        return (
          <div
            key={p.id}
            style={{
              position: 'absolute', left: spot.x, top: spot.y,
              // ⛔ 外壳不吃指针，由**标自己**开（跟主精灵一样）：手写行和名牌之间
              // 那片空白不该拦住画布的平移/框选
              pointerEvents: 'none',
              // zIndex 跟主精灵同一层（原来 44 —— 用户报「和主代理的图标不在一层」）
              textAlign: 'left', zIndex: SPRITE_Z,
              // 候场（挂 await_user）整体淡一档：在写的那个才该抢眼
              opacity: p.active ? 1 : 0.78,
              // 换目标时"走过去"而不是瞬移（同主精灵的缓动曲线）；自己被拖着时关掉
              transition: dragSlug === slug
                ? 'opacity 240ms ease'
                : 'opacity 240ms ease, left 300ms cubic-bezier(0.32,0.72,0,1), top 300ms cubic-bezier(0.32,0.72,0,1)',
            }}
            data-role-sprite={slug}
            // ⛔ 08-27 审计修：没有这条，按下被相机当空地 setPointerCapture，
            // click 被重定向到 pane（board-hit 表连栽三次的同族坑）
            data-no-pan
          >
            <SpriteSketch
              brand={brand}
              drawKey={p.targetId || `ambient:${slug}`}
              text={p.message || (p.active ? '' : IDLE_HINT)}
              size={ROLE_SPRITE_SIZE}
              maxWidth={260}
              active={p.active}
              quiet={quiet}
              nameTag={(
                <RoleNameTag
                  name={roleNames[slug] || slug} color={p.color}
                  waiting={!p.active} myTurn={!!p.active}
                  onClick={onPick ? () => onPick(slug) : null}
                />
              )}
              // 点标说话 —— 跟主精灵同一个入口
              onMarkClick={onPick ? () => onPick(slug) : undefined}
              // 闲时可拖走；贴着目标干活时不给拖（跟着 targetId，拖了会被拽回去）
              onMarkDragMove={p.targetId ? undefined : (dx, dy) => {
                const base = dragBase.current || (dragBase.current = { ...spot });
                setDragSlug(slug);
                const z = camRef.current?.z || 1;
                setPinned((m) => ({
                  ...m,
                  [slug]: { x: Math.round(base.x + dx / z), y: Math.round(base.y + dy / z), forTarget: p.targetId || null },
                }));
              }}
              onMarkDragEnd={p.targetId ? undefined : () => { dragBase.current = null; setDragSlug(null); }}
            />
          </div>
        );
      })}
    </>
  );
}
