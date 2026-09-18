import { useRef } from 'react';
import { Globe, Presentation, FileText } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO, CANVAS, RADIUS } from '../../../lib/theme.js';
import { PAPER } from '../../../lib/paper.js';
import { FOLDER_CARD, SITE_VIEWPORTS } from '../../../lib/board-geometry.js';
import { versionOfFile, versionOfSitePage } from '../../../lib/file-versions.js';
import { Assets } from '../../../lib/api.js';
import { joinRel } from '../../../lib/paths.js';
import LiveFrame from '../LiveFrame.jsx';
import { useInViewport } from './ArtifactCard.jsx';

/**
 * SameKindFace —— 同类产物收成一张卡（2026-09-18）
 *
 * 站主 09-17 定：同主题不同方向的产物（三版落地页、两份海报）散成好几张卡是乱的源头，
 * 收进一张卡，**用下拉切换**。word 文件夹早就是这个形态（一张卡装多份），这里推到站点与演示：
 * 一个文件夹里只装着同一类产物（两件以上、没有子文件夹、没有别的东西）时，文件夹卡的卡面就是
 * 当前选中那一件的真缩略，标题栏多一个下拉。
 *
 * 卡还是那张文件夹卡（身份、位置、拖进拖出、右键「进入」都不变），变的只是卡面和双击：
 * 双击打开的是选中的那一件。选哪件记在本机（useFolderPicks），不写 board.json。
 *
 * iframe 的闸同 FolderFace：进视口、镜头不太远才挂；否则画一张写着名字的纸。
 */

const FACE_PAD = 6;
const FACE_W = FOLDER_CARD.w - FACE_PAD * 2;
const FACE_H = FOLDER_CARD.h - 40 - FACE_PAD * 2;
const LIVE_MIN_SCALE = 0.5;
const ICON = { site: Globe, deck: Presentation, docx: FileText };
export const SAME_KIND_LABEL = { site: '站点', deck: '演示', docx: '文档' };

function Preview({ o, projectId, fileVersions }) {
  if (o.type === 'docx' && o.deckFile) {
    return (
      <img
        src={Assets.docxPageUrl(projectId, o.deckFile, 1, { w: FACE_W * 2, v: versionOfFile(fileVersions, o.deckFile) })}
        alt={o.title} loading="lazy" draggable={false}
        style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top center', display: 'block', background: '#fff' }}
      />
    );
  }
  if (o.type === 'deck') {
    const k = Math.max(FACE_W / 1920, FACE_H / 1080);
    return (
      <LiveFrame
        title={`same-${o.id}`}
        src={`${Assets.artifactFileUrl(projectId, o.deckFile)}?v=${versionOfFile(fileVersions, o.deckFile)}`}
        style={{ width: 1920, height: 1080, border: 0, transform: `scale(${k})`, transformOrigin: '0 0', pointerEvents: 'none' }}
      />
    );
  }
  const deviceW = SITE_VIEWPORTS[0].w;
  const k = FACE_W / deviceW;
  const base = o.base || o.task;
  const entry = o.entry || 'index.html';
  return (
    <LiveFrame
      title={`same-${o.id}`}
      src={`${Assets.artifactFileUrl(projectId, joinRel(base, entry))}?v=${versionOfSitePage(fileVersions, base, entry)}`}
      style={{ width: deviceW, height: Math.ceil(FACE_H / k), border: 0, transform: `scale(${k})`, transformOrigin: '0 0', pointerEvents: 'none' }}
    />
  );
}

/** 卡面：选中那一件的缩略（站点 / 演示是 iframe，文档是第一页页图） */
export default function SameKindFace({ z, member, projectId, fileVersions, scale = 1 }) {
  const ref = useRef(null);
  const inView = useInViewport(ref);
  const live = inView && scale >= LIVE_MIN_SCALE && member;
  const Icon = ICON[z.same.kind] || FileText;
  return (
    <div ref={ref} data-same-kind={z.same.kind} style={{ flex: 1, minHeight: 0, position: 'relative', padding: FACE_PAD, overflow: 'hidden' }}>
      {/* 身后两张错开的纸：一眼看出「这里面不止一件」 */}
      <div style={{ position: 'absolute', inset: `${FACE_PAD + 6}px ${FACE_PAD - 4}px ${FACE_PAD - 4}px ${FACE_PAD + 6}px`, background: PAPER.paper, boxShadow: 'inset 0 0 0 1px rgba(43,33,23,0.08)' }} />
      <div style={{ position: 'relative', width: FACE_W, height: FACE_H, overflow: 'hidden', background: COLOR.bgWhite, boxShadow: 'inset 0 0 0 1px rgba(43,33,23,0.08)' }}>
        {live ? <Preview o={member} projectId={projectId} fileVersions={fileVersions} /> : (
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: GAP.xs, backgroundColor: PAPER.paper }}>
            <Icon size={22} color={PAPER.pencil} strokeWidth={1.5} />
            <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text2, maxWidth: '90%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{member?.title || ''}</span>
          </div>
        )}
      </div>
      <span style={{
        position: 'absolute', right: FACE_PAD + 2, bottom: FACE_PAD + 2, padding: '1px 5px',
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, color: COLOR.sub,
        background: PAPER.paper, boxShadow: 'inset 0 0 0 1px rgba(43,33,23,0.10)',
      }}>{SAME_KIND_LABEL[z.same.kind]} · {z.same.members.length} 份</span>
    </div>
  );
}

/** 标题栏里的下拉：切换卡面上显示、双击打开的是哪一件 */
export function SameKindPicker({ z, value, onPick }) {
  const stop = (e) => e.stopPropagation();
  return (
    <select
      data-zone-action
      data-same-kind-pick={z.id}
      value={value}
      onChange={(e) => onPick?.(e.target.value)}
      onPointerDown={stop} onClick={stop} onDoubleClick={stop}
      title={`这个文件夹里的 ${z.same.members.length} 份${SAME_KIND_LABEL[z.same.kind] || ''}，选一份看`}
      style={{
        maxWidth: 112, height: 22, padding: '0 2px', flexShrink: 1, minWidth: 0,
        border: `1px solid ${COLOR.borderLt}`, borderRadius: RADIUS.sm, background: COLOR.bgWhite,
        color: COLOR.text, fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, cursor: 'pointer',
        outlineColor: CANVAS.brass,
      }}
    >
      {z.same.members.map((m) => <option key={m.id} value={m.id}>{m.title || String(m.id).split('/').pop()}</option>)}
    </select>
  );
}
