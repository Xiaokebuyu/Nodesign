import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, FileText, Image as ImageIcon, X, Upload } from 'lucide-react';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { Assets } from '../../lib/api.js';
import { formatSize } from '../../lib/helpers.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { useDropzone } from '../../lib/useDropzone.js';
import { PAPER_SHADOW } from '../../lib/paper.js';
import { useHoverReveal } from '../../lib/use-hover-reveal.js';

/**
 * FilesCard —— Hub 右栏卡片：项目共享 files（shared/assets/）
 *
 * mount 列文件，点 + 上传，hover 显示删除。agent 通过 additionalDirectories
 * 跨目录 Read 访问 shared/assets/。
 */
export default function FilesCard({ projectId }) {
  const showToast = useGlobalStore(s => s.showToast);
  const confirm = useGlobalStore(s => s.confirm);
  const [files, setFiles] = useState([]);
  // 参考素材（2026-08-18）：`assets/references/**` —— web-search 下载的参考图 +
  // browser_capture 从参照站带回来的截图/调色板/字体/结构。**刻意走这个抽屉不上
  // 画布**（用户拍板）：每逛一站甩十几张卡到画布上是噪音。
  const [refs, setRefs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const result = await Assets.list(projectId);
      setFiles(result?.assets || []);
      setRefs(result?.references || []);
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
    if (!(await confirm({
      title: '删除文件',
      message: `删除「${filename}」？`,
      confirmLabel: '删除',
      danger: true,
    }))) return;
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
        background: dragging ? 'rgba(43,33,23,0.04)' : cardStyle.background,
        transition: 'border-color 0.15s, background 0.15s',
      }}
    >
      {dragging && (
        <div style={{
          position: 'absolute', inset: 0,
          background: 'rgba(43,33,23,0.06)',
          borderRadius: RADIUS.xxl,
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
          background: 'rgba(43,33,23,0.025)',
          borderRadius: RADIUS.lg,
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

      {!loading && refs.length > 0 && (
        <div style={{ marginTop: GAP.md, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{
            display: 'flex', alignItems: 'baseline', gap: GAP.xs, paddingBottom: 2,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
          }}>
            <span style={{ color: COLOR.text2 }}>参考素材</span>
            <span>{refs.length} 件 · agent 逛站带回来的</span>
          </div>
          {refs.slice(0, 40).map(r => (
            <a
              key={r.rel}
              href={Assets.artifactFileUrl(projectId, r.rel)}
              target="_blank" rel="noreferrer"
              title={r.source ? `来自 ${r.source}` : r.rel}
              style={{
                display: 'flex', alignItems: 'baseline', gap: GAP.xs,
                padding: '2px 0', textDecoration: 'none', color: 'inherit',
              }}
            >
              <span style={{
                flex: 1, minWidth: 0, fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
                color: COLOR.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{r.name}</span>
              {/* ⭐ 出处比文件名值钱：三天后一堆没来处的截图就是垃圾 */}
              {r.lookingFor && (
                <span style={{
                  flexShrink: 0, maxWidth: 140, fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
                  color: COLOR.sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{r.lookingFor}</span>
              )}
              <span style={{
                flexShrink: 0, fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
              }}>{formatSize(r.size)}</span>
            </a>
          ))}
          {refs.length > 40 && (
            <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>
              还有 {refs.length - 40} 件（都在 assets/references/ 下）
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function FileRow({ file, onDelete }) {
  // hover 管底色（触屏恒 false，不然每行都亮着），revealed 管那颗删除钮（触屏恒 true）
  const { revealed, hover, hoverProps } = useHoverReveal();
  const Icon = isImageFile(file.name) ? ImageIcon : FileText;
  return (
    <div
      {...hoverProps}
      style={{
        display: 'flex', alignItems: 'center', gap: GAP.sm,
        padding: `${GAP.xs + 1}px ${GAP.sm}px`,
        borderRadius: RADIUS.md,
        background: hover ? 'rgba(43,33,23,0.025)' : 'transparent',
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
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
        }}>{formatSize(file.size)}</div>
      </div>
      {revealed && (
        <button
          onClick={onDelete}
          title="删除"
          style={{
            width: 20, height: 20, borderRadius: RADIUS.xs,
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
      <div style={tile(-6, COLOR.bgWhite, COLOR.borderMd)}><FileText size={20} color={COLOR.dim} /></div>
      <div style={tile(0, COLOR.bgWhite, COLOR.borderMd)}><FileText size={22} color={COLOR.dim} /></div>
      <div style={tile(6, '#faf8f4', COLOR.borderLt, true)}><Plus size={18} color={COLOR.dim} /></div>
    </div>
  );
}

function tile(rotate, bg, border, dashed) {
  return {
    width: 44, height: 56,
    borderRadius: RADIUS.md,
    background: bg,
    border: `${dashed ? '1px dashed' : '1px solid'} ${border}`,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transform: `rotate(${rotate}deg)`,
    margin: '0 -3px',
  };
}

const cardStyle = {
  background: COLOR.bgWhite,
  boxShadow: PAPER_SHADOW.far,
  borderRadius: 2,
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
  width: 26, height: 26, borderRadius: RADIUS.sm,
  background: 'transparent', border: 'none', color: COLOR.text2,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer',
};
const emptyHint = {
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
};
