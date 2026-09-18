import { useRef } from 'react';
import {
  Folder, FileText, StickyNote, Image as ImageIcon,
  Presentation, Globe, Map as MapIcon,
} from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO } from '../../../lib/theme.js';
import { PAPER } from '../../../lib/paper.js';
import { FOLDER_CARD, SITE_VIEWPORTS } from '../../../lib/board-geometry.js';
import { versionOfFile, versionOfSitePage } from '../../../lib/file-versions.js';
import { Assets } from '../../../lib/api.js';
import { joinRel } from '../../../lib/paths.js';
import LiveFrame from '../LiveFrame.jsx';
import { useInViewport } from './ArtifactCard.jsx';
import { thumbSrcOf } from './BoardObject.jsx';

/**
 * FolderFace —— 文件夹卡面：里面前几件的真缩略（2026-08-13）
 *
 * 在这之前卡面是名字清单（图标 + 一行字 × 4）。当时不做缩略的理由是
 * "200 宽的格子里什么都看不清 + iframe 的账翻倍"。这次卡加大到 288 宽，
 * 第一条理由消失；第二条靠三道闸算清：
 *
 *   1. **视口门**：进视口才挂（useInViewport，跟产物卡同一套）
 *   2. **缩放门**：`scale < 0.5` 不挂 iframe —— 比产物卡的 0.35 更严，
 *      文件夹缩略是二级画面，远看时图标瓦片信息量已经够了
 *   3. **每卡上限**：iframe 瓦片（deck/站点）每张卡最多 MAX_LIVE_TILES 个，
 *      其余落成图标瓦片。图片走 `?w=` 响应式档（12KB 一张），不占 iframe 账
 *
 * 瓦片是 2×2 的**固定格位**（不满四件就空着）——格位飘忽的卡在拖拽时会
 * 让落点提示看起来在抖。
 */

const TILE_ICON = {
  folder: Folder,
  image: ImageIcon,
  note: StickyNote,
  deck: Presentation,
  site: Globe,
};

/** 每张文件夹卡最多挂几个 iframe 缩略（deck / 站点） */
const MAX_LIVE_TILES = 2;
/** 镜头比这更远时 iframe 缩略糊成色块，只画图标瓦片 */
const LIVE_MIN_SCALE = 0.5;

/** 卡面净区（卡高减 40px 标题栏）里的 2×2 格位尺寸 */
const FACE_PAD = 6;
const TILE_GAP = 4;
const TILE_W = Math.floor((FOLDER_CARD.w - FACE_PAD * 2 - TILE_GAP) / 2);
const TILE_H = Math.floor((FOLDER_CARD.h - 40 - FACE_PAD * 2 - TILE_GAP) / 2);

/** deck / 站点的 iframe 微缩：按 cover 语义缩放（宁裁不留边，缩略要满格） */
function LiveTile({ o, projectId, fileVersions }) {
  if (o.type === 'deck') {
    const k = Math.max(TILE_W / 1920, TILE_H / 1080);
    return (
      <LiveFrame
        title={`peek-${o.id}`}
        src={`${Assets.artifactFileUrl(projectId, o.deckFile)}?v=${versionOfFile(fileVersions, o.deckFile)}`}
        style={{
          width: 1920, height: 1080, border: 0,
          transform: `scale(${k})`, transformOrigin: '0 0',
          pointerEvents: 'none',
        }}
      />
    );
  }
  const deviceW = SITE_VIEWPORTS[0].w;
  const k = TILE_W / deviceW;
  // 根站 base 是空串，filter(Boolean) 防拼出前导斜杠（同 ArtifactCard）
  const base = o.base || o.task;
  const entry = o.entry || 'index.html';
  return (
    <LiveFrame
      title={`peek-${o.id}`}
      src={`${Assets.artifactFileUrl(projectId, joinRel(base, entry))}?v=${versionOfSitePage(fileVersions, base, entry)}`}
      style={{
        width: deviceW, height: Math.ceil(TILE_H / k), border: 0,
        transform: `scale(${k})`, transformOrigin: '0 0',
        pointerEvents: 'none',
      }}
    />
  );
}

/** 兜底瓦片：横线纸 + 形态图标 + 一行名字（跟产物卡"还没显影"同一张纸） */
function IconTile({ kind, title }) {
  const Icon = TILE_ICON[kind] || FileText;
  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 3, padding: `0 ${GAP.xs}px`,
      backgroundColor: PAPER.paper,
      backgroundImage: 'repeating-linear-gradient(180deg, transparent 0 13px, rgba(43,33,23,0.05) 13px 14px)',
    }}>
      <Icon size={16} color={PAPER.pencil} strokeWidth={1.6} />
      <span style={{
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.xxs, color: COLOR.text2,
        maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{title}</span>
    </div>
  );
}

export default function FolderFace({ z, projectId, fileVersions, scale = 1 }) {
  const faceRef = useRef(null);
  const inView = useInViewport(faceRef);
  const live = inView && scale >= LIVE_MIN_SCALE;

  // iframe 预算按"前几件里谁是 deck/站点"顺序消耗，不满预算的落图标瓦片
  let liveBudget = MAX_LIVE_TILES;

  return (
    <div
      ref={faceRef}
      style={{
        flex: 1, minHeight: 0, position: 'relative',
        padding: FACE_PAD, overflow: 'hidden',
      }}
    >
      {z.count === 0 ? (
        <div style={{
          height: '100%',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: GAP.xs,
        }}>
          <Folder size={34} color={PAPER.pencil} strokeWidth={1.4} />
          <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, color: COLOR.sub }}>空的</span>
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: `${TILE_W}px ${TILE_W}px`,
          gridAutoRows: `${TILE_H}px`,
          gap: TILE_GAP,
        }}>
          {z.peek.map((it, i) => {
            const o = it.o;
            let inner = null;
            if (o && it.kind === 'image') {
              inner = (
                <img
                  src={thumbSrcOf(projectId, o)} alt={it.title} loading="lazy" draggable={false}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
              );
            } else if (o && (it.kind === 'deck' || it.kind === 'site') && live && liveBudget > 0) {
              liveBudget -= 1;
              inner = <LiveTile o={o} projectId={projectId} fileVersions={fileVersions} />;
            } else if (o && it.kind === 'docx' && o.deckFile && live) {
              // word 卡的内窥 = 第一页页图。是 <img> 不是 iframe，不占 live 预算
              inner = (
                <img
                  src={Assets.docxPageUrl(projectId, o.deckFile, 1, {
                    w: TILE_W * 2, v: versionOfFile(fileVersions, o.deckFile),
                  })}
                  alt={it.title} loading="lazy" draggable={false}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top center', display: 'block', background: '#fff' }}
                />
              );
            } else {
              inner = <IconTile kind={it.kind} title={it.title} />;
            }
            return (
              <div key={i} style={{
                width: TILE_W, height: TILE_H,
                position: 'relative', overflow: 'hidden',
                background: COLOR.bgWhite,
                boxShadow: 'inset 0 0 0 1px rgba(43,33,23,0.06)',
              }}>{inner}</div>
            );
          })}
        </div>
      )}

      {/* 件数一律显示（09-18，借 macOS 叠放：一眼知道里面有多少）；原来只在超过四件时给 +N */}
      {z.count > 0 && (
        <span data-folder-count style={{
          position: 'absolute', right: FACE_PAD + 2, bottom: FACE_PAD + 2,
          padding: '1px 5px',
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, color: COLOR.sub,
          background: PAPER.paper, boxShadow: 'inset 0 0 0 1px rgba(43,33,23,0.10)',
        }}>{z.count} 件</span>
      )}
    </div>
  );
}
