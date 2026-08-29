import { useRef } from 'react';
import { Plus, X, FileText, Image as ImageIcon, Link2, Github, Globe } from 'lucide-react';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { formatSize, newId } from '../../lib/helpers.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { PAPER_SHADOW } from '../../lib/paper.js';

/**
 * Inputs tab — 上传资料 / 链接 repo / 网页 capture
 *
 * P2：
 *   - 图片走 FileReader.readAsDataURL → list 里显示缩略图
 *   - 其他文件显示 icon + 文件名 + 大小
 *   - URL 粘贴：检测 github/网页类型显示对应 icon
 *
 * P3：上传走 POST /api/projects/:id/assets 真后端。
 */
export default function InputsTab({ inputs = [], onAdd, onRemove }) {
  const fileRef = useRef(null);
  const showToast = useGlobalStore(s => s.showToast);
  const prompt = useGlobalStore(s => s.prompt);

  // 直接把 File 上抛给父级（由父级走 multipart Assets.upload + 进托盘）；
  // 不再 FileReader 本地预览（缩略图依赖 Assets.upload 后的 thumbnail —— P0+ 加）
  const handleFile = (files) => {
    if (!files || files.length === 0) return;
    const arr = Array.from(files);
    arr.forEach((file) => onAdd?.(file));
    showToast(arr.length === 1 ? `已添加 ${arr[0].name}` : `已添加 ${arr.length} 个文件`, 'success');
  };

  const handlePasteUrl = async () => {
    const url = await prompt({
      title: '粘贴 URL',
      message: '网页 / 在线 PDF / 任意公开链接',
      placeholder: 'https://...',
    });
    if (!url || !url.trim()) return;
    const trimmed = url.trim();
    onAdd?.({
      id: newId('asset'),
      type: detectUrlType(trimmed),
      filename: trimmed,
      addedAt: new Date().toISOString(),
    });
    showToast('已添加 URL', 'success');
  };

  const handleConnectRepo = async () => {
    const url = await prompt({
      title: '连接代码库',
      message: '建议挂指定子目录而不是整个 monorepo（参考 Claude_design §13.3）\n例如：https://github.com/your-org/repo/tree/main/src/components',
      placeholder: 'https://github.com/...',
    });
    if (!url || !url.trim()) return;
    const trimmed = url.trim();
    onAdd?.({
      id: newId('asset'),
      type: 'repo',
      filename: trimmed,
      addedAt: new Date().toISOString(),
      meta: { connector: 'github' },
    });
    showToast('已连接代码库', 'success');
  };

  return (
    <div style={{ padding: GAP.lg }}>
      {/* Drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = COLOR.btn; e.currentTarget.style.background = 'rgba(43,33,23,0.04)'; }}
        onDragLeave={e => { e.currentTarget.style.borderColor = COLOR.border; e.currentTarget.style.background = COLOR.bgCard; }}
        onDrop={e => {
          e.preventDefault();
          e.currentTarget.style.borderColor = COLOR.border;
          e.currentTarget.style.background = COLOR.bgCard;
          handleFile(e.dataTransfer.files);
        }}
        onClick={() => fileRef.current?.click()}
        style={{
          padding: `${GAP.lg + 2}px ${GAP.lg}px`,
          border: `1.5px dashed ${COLOR.border}`,
          borderRadius: RADIUS.xl,
          background: COLOR.bgCard,
          cursor: 'pointer',
          textAlign: 'center',
          marginBottom: GAP.lg,
          transition: 'all 0.15s',
        }}
      >
        <Plus size={20} color={COLOR.text4} style={{ marginBottom: GAP.sm }} />
        <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2, marginBottom: GAP.xxs }}>
          拖入文件或点击选择
        </div>
        <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>
          截图 / PDF / PPTX / DOCX / HTML
        </div>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".pdf,.pptx,.docx,.html,.htm,.png,.jpg,.jpeg,.svg,.webp,.json"
          onChange={e => handleFile(e.target.files)}
          style={{ display: 'none' }}
        />
      </div>

      {/* 链接类入口（GitHub / 网页 URL）*/}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: GAP.sm, marginBottom: GAP.lg }}>
        <button
          onClick={handleConnectRepo}
          style={{
            padding: `${GAP.md}px ${GAP.sm}px`,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text2,
            background: 'rgba(43,33,23,0.03)',
            border: `1px solid ${COLOR.borderLt}`,
            borderRadius: RADIUS.lg,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: GAP.xs,
            cursor: 'pointer',
          }}
          title="挂代码库子目录让 agent 看实际组件结构"
        >
          <Github size={12} /> 连接代码库
        </button>
        <button
          onClick={handlePasteUrl}
          style={{
            padding: `${GAP.md}px ${GAP.sm}px`,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text2,
            background: 'rgba(43,33,23,0.03)',
            border: `1px solid ${COLOR.borderLt}`,
            borderRadius: RADIUS.lg,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: GAP.xs,
            cursor: 'pointer',
          }}
        >
          <Link2 size={12} /> 网页 URL
        </button>
      </div>

      {/* List */}
      {inputs.length > 0 && (
        <>
          <div style={{
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
            textTransform: 'uppercase', letterSpacing: '0.05em',
            marginBottom: GAP.md, paddingLeft: GAP.xs,
          }}>已添加 ({inputs.length})</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.sm }}>
            {inputs.map(item => <InputRow key={item.id} item={item} onRemove={onRemove} />)}
          </div>
        </>
      )}
    </div>
  );
}

function InputRow({ item, onRemove }) {
  const Icon = ICON_BY_TYPE[item.type] || FileText;
  const showThumb = item.thumbnail && item.type === 'image';

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: GAP.md,
      padding: showThumb ? GAP.sm : `${GAP.sm + 1}px ${GAP.md}px`,
      background: COLOR.bgWhite,
      boxShadow: PAPER_SHADOW.far,
      borderRadius: RADIUS.md,
    }}>
      {showThumb ? (
        <img
          src={item.thumbnail}
          alt={item.filename}
          style={{
            width: 36, height: 36, objectFit: 'cover',
            borderRadius: RADIUS.sm, flexShrink: 0,
            border: `1px solid ${COLOR.borderLt}`,
          }}
        />
      ) : (
        <div style={{
          width: 28, height: 28, borderRadius: RADIUS.sm,
          background: COLOR.bgCard, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon size={13} color={COLOR.text4} />
        </div>
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{item.filename}</div>
        {(item.size != null || item.type) && (
          <div style={{
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
            marginTop: 1,
          }}>
            {item.type && item.type.toUpperCase()}{item.size != null ? ` · ${formatSize(item.size)}` : ''}
          </div>
        )}
      </div>

      <button
        onClick={() => onRemove?.(item.id)}
        style={{
          color: COLOR.sub, padding: GAP.xs, borderRadius: RADIUS.xs, flexShrink: 0,
          background: 'transparent',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(43,33,23,0.05)'; e.currentTarget.style.color = COLOR.error; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = COLOR.sub; }}
        title="移除"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function detectType(name) {
  const ext = name.toLowerCase().split('.').pop();
  if (['png', 'jpg', 'jpeg', 'webp', 'svg'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'pptx') return 'pptx';
  if (ext === 'docx') return 'docx';
  if (['html', 'htm'].includes(ext)) return 'html';
  return 'file';
}

function detectUrlType(url) {
  if (url.includes('github.com')) return 'repo';
  return 'web';
}

const ICON_BY_TYPE = {
  image: ImageIcon,
  pdf: FileText,
  pptx: FileText,
  docx: FileText,
  html: Globe,
  repo: Github,
  web: Globe,
  file: FileText,
};
