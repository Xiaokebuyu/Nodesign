/**
 * RoleSprites —— 常驻角色在画布上的精灵（2026-08-26，RP 线块 5）
 *
 * 主 agent 的精灵是「铅笔在纸上画出来的东西」（SpriteSketchLayer 的定格三拍），
 * 角色沿用同一套视觉，但**比主的小一圈**，并且**带身份标**（一枚书签，写着它的名字）
 * —— 一块板上可能同时有叙事者、NPC、主控三方在写字，光看笔迹分不出谁是谁。
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
 * 不知道它还在，也不知道该冲谁说话。动静由 run.role.wait 驱动，见 board-presence.js。
 */

import { useMemo, useEffect } from 'react';
import { SpriteSketch, findWorkSpot, findAmbientSlot } from './SpriteSketchLayer.jsx';
import { PAPER } from '../../lib/paper.js';
import { TEXT_FONT_CSS } from '../../lib/text-fonts.js';
import { isRolePresence, slugOfPresence } from '../../lib/board-presence.js';

/** 角色精灵比主精灵小一圈（主的是 44） */
const ROLE_SPRITE_SIZE = 32;

/**
 * 身份标：一枚贴在精灵下缘的小书签。
 * 名字取展示名（roleNames），查不到就退回 slug —— 宁可难看也不能张冠李戴，
 * 展示名住在角色文件里而那份文件模型能改（保留字闸在服务端 listRoleNames 出口）。
 */
function RoleBookmark({ name, color }) {
  return (
    <div style={{
      marginTop: 2,
      display: 'inline-block',
      padding: '1px 7px 2px',
      fontFamily: TEXT_FONT_CSS.pen,
      fontSize: 13,
      lineHeight: 1.3,
      color: PAPER.ink2,
      background: PAPER.bg,
      border: `1px solid ${color}`,
      // 书签形：下缘咬一个小口
      clipPath: 'polygon(0 0, 100% 0, 100% 100%, 50% 82%, 0 100%)',
      paddingBottom: 6,
      whiteSpace: 'nowrap',
    }}>{name}</div>
  );
}

export default function RoleSprites({ presence, rectOf, obstacles = [], roleNames = {}, cam = null, viewport = null, onPick = null, reportLayout = null }) {
  // ⚠️ 不再要求 active（2026-08-26）：角色挂在 await_user 上等你回话时是 idle 的，
  // 但它**还在台上**，精灵消失会让用户以为它没了、也就不知道该冲谁说话。
  // 2026-08-27（编排）：也不再要求 targetId —— 还没写过板书的角色排**候场位**
  // （findAmbientSlot，主精灵闲逛用的同一套槽位），上台就看得见、点得到。
  const roles = useMemo(() => Object.values(presence || {})
    .filter((p) => p && isRolePresence(p.id)), [presence]);

  // 摆位先算成表：渲染和布局上报共用同一份坐标（别让两边各算一次各不一样）
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
    if (!spot) continue;
    placedObs.push({ x: spot.x - 20, y: spot.y - 20, w: 160, h: 110 });
    entries.push({ p, spot });
  }
  // 布局上报（08-27 操作条避让）：精灵占了哪几块世界矩形，包络口径同 placedObs。
  // ref 直写路径 —— 上报本身不许引发渲染。
  useEffect(() => { reportLayout?.(placedObs); });

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
              // 可点（2026-08-27）：点精灵 = 打开跟这个角色的对话（路由拍板：
              // 侧栏永远是主 agent 的，跟角色说话走这里）
              pointerEvents: onPick ? 'auto' : 'none', cursor: onPick ? 'pointer' : undefined,
              textAlign: 'center', zIndex: 44,
            }}
            data-role-sprite={slug}
            // ⛔ 08-27 审计修：没有这两条，按下被相机当空地 setPointerCapture，
            // click 被重定向到 pane —— onPick 一次都到不了（board-hit 表连栽三次的
            // 同族坑；主精灵 sprite-figures 的 press 早有同款防护，这里当时没抄）
            data-no-pan
            onPointerDown={onPick ? (e) => { e.stopPropagation(); } : undefined}
            title={onPick ? `跟${roleNames[slug] || slug}说话` : undefined}
            onClick={onPick ? (e) => { e.stopPropagation(); onPick(slug); } : undefined}
          >
            <SpriteSketch
              brand={{ color: p.color }}
              drawKey={p.targetId || `ambient:${slug}`}
              text={p.message || ''}
              size={ROLE_SPRITE_SIZE}
              maxWidth={260}
              active={p.active}
            />
            <RoleBookmark name={roleNames[slug] || slug} color={p.color} />
          </div>
        );
      })}
    </>
  );
}
