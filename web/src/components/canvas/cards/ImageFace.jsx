import { Image as ImageIcon } from 'lucide-react';
import { COLOR, GAP, FONT_MONO, FONT_SIZE } from '../../../lib/theme.js';
import { Assets } from '../../../lib/api.js';

/**
 * 图片卡的卡面（2026-09-12 从 BoardObject 拆出，行数棘轮）。
 * 缩略图：4:3 裁一角。展开模式（expanded，见 lib/image-expand.js）：整张按原比例装进去（contain），
 * 高由父层按 sizeOf 定；这里 flex 撑满。
 */
export function ImageFace({ o, projectId, expanded }) {
  const expandedImage = expanded;
  return (
  <div style={expandedImage ? { display: 'flex', flexDirection: 'column', height: '100%' } : undefined}>
    {/* 缩略图：4:3 裁一角。展开模式：整张按原比例装进去（contain），高由 sizeOf 定 */}
    <div style={expandedImage
      ? { flex: 1, minHeight: 0, overflow: 'hidden', borderRadius: '10px 10px 0 0', background: '#f4f2ee' }
      : { aspectRatio: '4 / 3', overflow: 'hidden', borderRadius: '10px 10px 0 0', background: '#f4f2ee' }}>
      <img
        src={expandedImage ? `${Assets.artifactFileUrl(projectId, o.path)}?w=1280` : thumbSrcOf(projectId, o)}
        alt={o.name} loading="lazy" draggable={false}
        data-image-face
        style={{ width: '100%', height: '100%', objectFit: expandedImage ? 'contain' : 'cover', display: 'block' }}
      />
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: GAP.xs, padding: `${GAP.xs}px ${GAP.sm}px` }}>
      <ImageIcon size={10} color={COLOR.sub} />
      <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {o.meta?.assetRole ? `[${o.meta.assetRole}] ` : ''}{o.name}
      </span>
    </div>
  </div>
  );
}

/** 缩略图地址：生成图有 .thumbnails 档，其余走 ?w=480 响应式档（缘由见 BoardObject 里那段注释） */
export function thumbSrcOf(projectId, item) {
  if (item.hasThumb) {
    const base = item.name.replace(/\.[^.]+$/, '');
    return Assets.artifactFileUrl(projectId, `assets/generated/.thumbnails/${base}.thumb.webp`);
  }
  return `${Assets.artifactFileUrl(projectId, item.path)}?w=480`;
}
