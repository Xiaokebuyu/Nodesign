import { useEffect, useState, useCallback } from 'react';
import { Download, RefreshCw, FileArchive } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { Exports } from '../../lib/api.js';

/**
 * ExportsListModal —— 列 workspace/exports/ 下所有已生成的文件
 *
 * 数据来源：
 *   - 用户从顶栏 ExportMenu 主动导出（HTML / PDF / Handoff）→ 浏览器
 *     直接下载，不写到 workspace/exports/
 *   - agent 调用 mcp__nodesign__export_handoff（C10）→ 写到
 *     workspace/exports/handoff-<ts>.zip → 这里能列出
 *
 * 用户从这里点 → 浏览器下载（GET /exports/file/:filename）
 */
export default function ExportsListModal({ show, onClose, projectId, sessionId }) {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!projectId || !sessionId) {
      setFiles([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await Exports.list(projectId, sessionId);
      setFiles(result?.files || []);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [projectId, sessionId]);

  useEffect(() => {
    if (show) refresh();
  }, [show, refresh]);

  const handleDownload = async (file) => {
    try {
      const { blob, filename } = await Exports.downloadFile(projectId, sessionId, file.name);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Modal show={show} onClose={onClose} title="已生成的交付文件" width={620}>
      <div style={{ padding: GAP.xl, paddingBottom: GAP.lg }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: GAP.md,
        }}>
          <div style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
            lineHeight: 1.5,
          }}>
            agent 调用 export_handoff 工具生成的文件会出现这里。
            用户主动导出（顶栏 Export 菜单）走浏览器直接下载，不进这个列表。
          </div>
          <button
            onClick={refresh}
            disabled={loading}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: `${GAP.xs}px ${GAP.sm}px`,
              background: 'rgba(0,0,0,0.04)',
              border: 'none',
              borderRadius: 4,
              cursor: loading ? 'wait' : 'pointer',
              fontFamily: FONT_SANS, fontSize: 11,
              color: COLOR.sub,
              flexShrink: 0,
              marginLeft: GAP.md,
            }}
          >
            <RefreshCw size={11} style={{
              animation: loading ? 'rcw-spin-modal 1s linear infinite' : 'none',
            }} />
            {loading ? '...' : '刷新'}
          </button>
        </div>

        {error && (
          <div style={{
            padding: GAP.md,
            background: 'rgba(220, 53, 69, 0.06)',
            border: `1px solid ${COLOR.error}33`,
            borderRadius: 6,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
            color: COLOR.error,
            marginBottom: GAP.md,
          }}>
            {error.message}
          </div>
        )}

        {files.length === 0 && !loading && (
          <div style={{
            padding: `${GAP.xl}px ${GAP.md}px`,
            textAlign: 'center',
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
            color: COLOR.sub,
          }}>
            （还没有 agent 生成的交付文件）
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.xs }}>
          {files.map((file) => (
            <div
              key={file.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: GAP.md,
                padding: `${GAP.sm + 2}px ${GAP.md}px`,
                border: `1px solid ${COLOR.borderLt}`,
                borderRadius: 8,
                background: '#fff',
              }}
            >
              <FileArchive size={16} color={COLOR.text4} style={{ flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500,
                  color: COLOR.text,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {file.name}
                </div>
                <div style={{
                  fontFamily: FONT_SANS, fontSize: 10, color: COLOR.sub,
                  marginTop: 2,
                }}>
                  {formatSize(file.size)} · {formatTs(file.mtime)}
                </div>
              </div>
              <button
                onClick={() => handleDownload(file)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: `${GAP.xs}px ${GAP.md}px`,
                  fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, fontWeight: 500,
                  color: COLOR.btnText,
                  background: COLOR.btn,
                  border: 'none',
                  borderRadius: 6,
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                <Download size={12} /> 下载
              </button>
            </div>
          ))}
        </div>

        <style>{`
          @keyframes rcw-spin-modal {
            from { transform: rotate(0deg); }
            to   { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    </Modal>
  );
}

function formatSize(bytes) {
  if (bytes == null) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTs(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    return d.toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return ts; }
}
