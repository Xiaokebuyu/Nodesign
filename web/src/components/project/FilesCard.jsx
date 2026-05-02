import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, FileText, Image as ImageIcon, X, Upload } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { Assets } from '../../lib/api.js';
import { formatSize } from '../../lib/helpers.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { useDropzone } from '../../lib/useDropzone.js';

/**
 * FilesCard —— Hub 右栏卡片：项目共享 files（shared/assets/）
 *
 * mount 列文件，点 + 上传，hover 显示删除。agent 通过 additionalDirectories
 * 跨目录 Read 访问 shared/assets/。
 */
export default function FilesCard({ projectId }) {
  const showToast = useGlobalStore(s => s.showToast);
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const result = await Assets.list(projectId);
      setFiles(result?.assets || []);
    } catch (err) {
      console.warn('[FilesCard] list failed:', err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  /** 复用：input picker 和 drag-drop 都走这条 — 同条 Assets.upload 路径 → shared/assets/ */
  const uploadFiles = useCallback(async (fileList) => {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    try {
      for (const f of fileList) {
        await Assets.upload(projectId, f);
      }
      showToast(`已上传 ${fileList.length} 个文件`, 'success');
      await refresh();
    } catch (err) {
      showToast(`上传失败：${err.message}`, 'error');
    } finally {
      setUploading(false);
    }
  }, [projectId, refresh, showToast]);

  const handleUpload = async (e) => {
    const fileList = Array.from(e.target.files || []);
    await uploadFiles(fileList);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // V2：拖文件入卡片整体（包括空状态 + 列表 + header）—— 路径同 picker
  const { dragging, dropProps } = useDropzone({
    onFiles: uploadFiles,
    disabled: uploading,
  });

  const handleDelete = async (filename) => {
    if (!window.confirm(`删除「${filename}」？`)) return;
    try {
      await Assets.remove(projectId, filename);
      showToast('已删除', 'info');
      await refresh();
    } catch (err) {
      showToast(`删除失败：${err.message}`, 'error');
    }
  };

  return (
    <div
      {...dropProps}
      style={{
        ...cardStyle,
        position: 'relative',
        border: dragging ? `1.5px dashed ${COLOR.btn}` : cardStyle.border,
        background: dragging ? 'rgba(45,36,24,0.04)' : cardStyle.background,
        transition: 'border-color 0.15s, background 0.15s',
      }}
    >
      {dragging && (
        <div style={{
          position: 'absolute', inset: 0,
          background: 'rgba(45,36,24,0.06)',
          borderRadius: 12,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: GAP.sm,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
          color: COLOR.text,
          pointerEvents: 'none',
          zIndex: 2,
        }}>
          <Upload size={14} /> 松开上传到 shared/assets/
        </div>
      )}
      <div style={cardHeader}>
        <span style={cardTitle}>项目文件</span>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          title="上传文件"
          style={iconBtnStyle}
        >
          <Plus size={14} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleUpload}
          style={{ display: 'none' }}
        />
      </div>

      {loading && <div style={emptyHint}>加载中…</div>}

      {!loading && files.length === 0 && (
        <div style={{
          padding: `${GAP.md}px 0`,
          background: 'rgba(45,36,24,0.025)',
          borderRadius: 8,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: GAP.sm,
        }}>
          <FilesIllustration />
          <span style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
            color: COLOR.sub, textAlign: 'center',
            padding: `0 ${GAP.lg}px`, lineHeight: 1.55,
          }}>
            上传 PDF、文档或图片，agent 在 session 里能直接 Read 到这些素材。
          </span>
        </div>
      )}

      {!loading && files.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.xs }}>
          {files.map(f => <FileRow key={f.name} file={f} onDelete={() => handleDelete(f.name)} />)}
        </div>
      )}
    </div>
  );
}

function FileRow({ file, onDelete }) {
  const [hover, setHover] = useState(false);
  const Icon = isImageFile(file.name) ? ImageIcon : FileText;
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: GAP.sm,
        padding: `${GAP.xs + 1}px ${GAP.sm}px`,
        borderRadius: 6,
        background: hover ? 'rgba(0,0,0,0.025)' : 'transparent',
        transition: 'background 0.15s',
      }}
    >
      <Icon size={13} color={COLOR.text4} style={{ flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }} title={file.name}>{file.name}</div>
        <div style={{
          fontFamily: FONT_MONO, fontSize: 10, color: COLOR.sub,
        }}>{formatSize(file.size)}</div>
      </div>
      {hover && (
        <button
          onClick={onDelete}
          title="删除"
          style={{
            width: 20, height: 20, borderRadius: 3,
            background: 'transparent', border: 'none',
            color: COLOR.sub,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer',
            flexShrink: 0,
          }}
          onMouseEnter={e => { e.currentTarget.style.color = COLOR.error; }}
          onMouseLeave={e => { e.currentTarget.style.color = COLOR.sub; }}
        >
          <X size={11} />
        </button>
      )}
    </div>
  );
}

function isImageFile(name) {
  return /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name);
}

function FilesIllustration() {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', padding: `${GAP.xs}px 0` }}>
      <div style={tile(-6, '#fff', COLOR.borderMd)}><FileText size={20} color={COLOR.dim} /></div>
      <div style={tile(0, '#fff', COLOR.borderMd)}><FileText size={22} color={COLOR.dim} /></div>
      <div style={tile(6, '#faf8f4', COLOR.borderLt, true)}><Plus size={18} color={COLOR.dim} /></div>
    </div>
  );
}

function tile(rotate, bg, border, dashed) {
  return {
    width: 44, height: 56,
    borderRadius: 6,
    background: bg,
    border: `${dashed ? '1px dashed' : '1px solid'} ${border}`,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transform: `rotate(${rotate}deg)`,
    margin: '0 -3px',
  };
}

const cardStyle = {
  background: '#fff',
  border: `1px solid ${COLOR.borderLt}`,
  borderRadius: 12,
  padding: GAP.lg,
};
const cardHeader = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  gap: GAP.sm,
  marginBottom: GAP.sm,
};
const cardTitle = {
  fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500,
  color: COLOR.text,
};
const iconBtnStyle = {
  width: 26, height: 26, borderRadius: 4,
  background: 'transparent', border: 'none', color: COLOR.text2,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer',
};
const emptyHint = {
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
};
