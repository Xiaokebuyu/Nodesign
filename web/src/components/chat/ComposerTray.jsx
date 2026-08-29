import { X, FileText, Image as ImageIcon, AlertCircle, Check, Loader2 } from 'lucide-react';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_SANS, FONT_MONO, alpha } from '../../lib/theme.js';
import { formatSize } from '../../lib/helpers.js';

/**
 * ComposerTray — Chat 输入框上方的"待发送附件托盘"
 *
 * 多 modality 信号在这里聚集，用户 send 时一起送给 agent：
 *   - type='asset'    上传文件（uploading: !path && !error / done: path / failed: error）
 *   - type='anchor'   选中元素（P0+ 接通）
 *   - type='comment'  写好的评论（P0+ 接通）
 *
 * 2026-08-05 重做：上传状态要一眼可辨——图片出缩略图（previewUrl 由
 * handleAddInput 在上传前就用 objectURL 生成，所以"上传中"也有图看），
 * 上传中转圈、完成绿勾、失败红字，不再只靠透明度那点差别。
 * 每条带删除按钮；空时返回 null（不占位）。
 */
export default function ComposerTray({ items = [], onRemove }) {
  if (!items || items.length === 0) return null;

  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: GAP.xs + 2,
      paddingBottom: GAP.sm,
      borderBottom: `1px dashed ${COLOR.borderLt}`,
      marginBottom: GAP.sm,
    }}>
      <style>{'@keyframes ct-spin{to{transform:rotate(360deg)}}'}</style>
      {items.map((item) => <TrayChip key={item.id} item={item} onRemove={onRemove} />)}
    </div>
  );
}

function TrayChip({ item, onRemove }) {
  const failed = !!item.error;
  // _file = 首页那条路的"暂存待发"（submit 时才统一上传）—— 不是上传中，
  // 按已就绪显示，别让它顶着个永远转的圈
  const uploading = item.type === 'asset' && !item.path && !item.error && !item._file;
  const isImage = (item.mime || '').startsWith('image/');
  const label = item.name || item.filename || item.path || item.text || '附件';

  return (
    <div
      title={failed ? `失败: ${item.error}` : label}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: GAP.sm,
        padding: GAP.xs,
        paddingRight: GAP.xs + 2,
        background: failed ? 'rgba(184,58,42,0.06)' : COLOR.bgWhite,
        border: `1px solid ${failed ? COLOR.error : COLOR.borderLt}`,
        borderRadius: RADIUS.md,
        maxWidth: 240, minWidth: 0,
      }}
    >
      {/* 左：缩略图 / 文件图标格 */}
      <div style={{
        position: 'relative', width: 40, height: 40, flexShrink: 0,
        borderRadius: RADIUS.sm, overflow: 'hidden',
        background: 'rgba(43,33,23,0.05)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {isImage && item.previewUrl ? (
          <img
            src={item.previewUrl}
            alt={label}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          isImage
            ? <ImageIcon size={16} style={{ color: COLOR.sub }} />
            : <FileText size={16} style={{ color: COLOR.sub }} />
        )}
        {/* 上传中：盖半透明 + 转圈，缩略图照常可见 */}
        {uploading && (
          <div style={{
            position: 'absolute', inset: 0,
            background: alpha(COLOR.btnText, 0.55),
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Loader2 size={16} style={{ color: COLOR.text2, animation: 'ct-spin 0.9s linear infinite' }} />
          </div>
        )}
      </div>

      {/* 中：文件名 + 状态行 */}
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
          color: failed ? COLOR.error : COLOR.text2,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150,
        }}>{label}</span>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 3,
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
          color: failed ? COLOR.error : (uploading ? COLOR.sub : COLOR.success),
        }}>
          {failed ? (
            <><AlertCircle size={10} /> 上传失败</>
          ) : uploading ? (
            '上传中…'
          ) : (
            <>
              <Check size={10} strokeWidth={2.5} /> 已就绪
              {item.size != null && (
                <span style={{ color: COLOR.sub }}>· {formatSize(item.size)}</span>
              )}
            </>
          )}
        </span>
      </div>

      <button
        onClick={() => onRemove?.(item.id)}
        title="移除"
        style={{
          width: 16, height: 16, borderRadius: RADIUS.xs,
          background: 'transparent', color: COLOR.sub,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
          cursor: 'pointer', border: 'none',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(43,33,23,0.06)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        <X size={10} />
      </button>
    </div>
  );
}
