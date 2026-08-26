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
 * （findWorkSpot 避让）。没有目标就不出现 —— 角色不像主 agent 那样有"闲时漫游"，
 * 它要么在写东西，要么在等用户，等的时候不该占着画面。
 */

import { useMemo } from 'react';
import { SpriteSketch, findWorkSpot } from './SpriteSketchLayer.jsx';
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

export default function RoleSprites({ presence, rectOf, obstacles = [], roleNames = {} }) {
  const roles = useMemo(() => Object.values(presence || {})
    .filter((p) => p && isRolePresence(p.id) && p.active && p.targetId), [presence]);

  if (!roles.length) return null;

  return (
    <>
      {roles.map((p) => {
        const anchor = rectOf?.(p.targetId);
        if (!anchor) return null;
        const spot = findWorkSpot(anchor, obstacles);
        if (!spot) return null;
        const slug = slugOfPresence(p.id);
        return (
          <div
            key={p.id}
            style={{
              position: 'absolute', left: spot.x, top: spot.y,
              pointerEvents: 'none', textAlign: 'center', zIndex: 44,
            }}
            data-role-sprite={slug}
          >
            <SpriteSketch
              brand={{ color: p.color }}
              drawKey={p.targetId}
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
