import { X, FileText, Image as ImageIcon, AlertCircle, Paperclip } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO } from '../../lib/theme.js';
import { formatSize } from '../../lib/helpers.js';

/**
 * ComposerTray — Chat 输入框上方的"待发送附件托盘"
 *
 * 多 modality 信号在这里聚集，用户 send 时一起送给 agent：
 *   - type='asset'    上传文件（uploading: !path && !error / done: path / failed: error）
 *   - type='anchor'   选中元素（P0+ 接通）
 *   - type='comment'  写好的评论（P0+ 接通）
 *
 * 每条带删除按钮；空时返回 null（不占位）。
 */
export default function ComposerTray({ items = [], onRemove }) {
  if (!items || items.length === 0) return null;

  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: GAP.xs + 1,
      paddingBottom: GAP.sm,
      borderBottom: `1px dashed ${COLOR.borderLt}`,
      marginBottom: GAP.sm,
    }}>
      {items.map((item) => <TrayChip key={item.id} item={item} onRemove={onRemove} />)}
    </div>
  );
}

function TrayChip({ item, onRemove }) {
  const failed = !!item.error;
  const uploading = item.type === 'asset' && !item.path && !item.error;
  const Icon = pickIcon(item);

  const label = item.name || item.filename || item.path || item.text || '附件';

  return (
    <div
      title={failed ? `失败: ${item.error}` : (uploading ? '上传中…' : label)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
        padding: `${GAP.xs - 1}px ${GAP.xs + 2}px`,
        background: failed ? 'rgba(184,58,42,0.06)' : '#fff',
        border: `1px solid ${failed ? COLOR.error : COLOR.borderLt}`,
        borderRadius: 6,
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
        color: failed ? COLOR.error : COLOR.text2,
        opacity: uploading ? 0.6 : 1,
        maxWidth: '100%', minWidth: 0,
      }}
    >
      {failed ? (
        <AlertCircle size={11} />
      ) : uploading ? (
        <Paperclip size={11} style={{ opacity: 0.5 }} />
      ) : (
        <Icon size={11} />
      )}
      <span style={{
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200,
      }}>{label}</span>
      {item.size != null && !failed && (
        <span style={{ fontFamily: FONT_MONO, color: COLOR.sub, fontSize: 10 }}>
          {formatSize(item.size)}
        </span>
      )}
      <button
        onClick={() => onRemove?.(item.id)}
        title="移除"
        style={{
          width: 14, height: 14, borderRadius: 3,
          background: 'transparent', color: COLOR.sub,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
          cursor: 'pointer', border: 'none',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.06)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        <X size={9} />
      </button>
    </div>
  );
}

function pickIcon(item) {
  if (item.type === 'asset') {
    return (item.mime || '').startsWith('image/') ? ImageIcon : FileText;
  }
  return FileText;
}
