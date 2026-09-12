import { useState, useMemo } from 'react';
import { FolderOpen, ChevronDown, X, ExternalLink, FileText } from 'lucide-react';
import { COLOR, CANVAS, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { Assets } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';

/**
 * BrowserShelf.jsx — 浏览器窗底下那条「采到的东西」的架子 + 窗内看图层（2026-09-12 从 BrowserWindow 拆出）
 *
 * 数据是 `GET /browse` 里的 sites[]（server/engine/browse/card.js collectedSites）：一站一文件夹，
 * 每站带封面和文件清单。点开一站：图按缩略图列出来，点一张在窗内放大（CapturePreview）；
 * 文本档（调色板 / 字体 / 结构 / CSS）另开标签页看原件。路径仍然给出来，agent 下个会话直接引用。
 * 采集件刻意不上画布（FilesCard.jsx 头注：每逛一站甩十几张卡到画布上是噪音）。
 */

/** 窗内看图：铺满窗内容区（ArtifactWindow 的内容容器是 position:relative）。层级只跟本窗内部比。 */
export function CapturePreview({ projectId, file, onClose }) {
  return     (
      <div
        onClick={() => onClose()}
        style={{
          position: 'absolute', inset: 0, zIndex: 2, background: 'rgba(43,33,23,0.55)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          padding: GAP.md, boxSizing: 'border-box',
        }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            display: 'flex', flexDirection: 'column', gap: GAP.sm, maxWidth: '100%', maxHeight: '100%', minHeight: 0,
            background: CANVAS.paper, padding: GAP.sm, borderRadius: 2, boxShadow: '0 6px 22px rgba(43,39,35,.28)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm, fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text }}>
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{file.name}</span>
            <a
              href={Assets.artifactFileUrl(projectId, file.rel)} target="_blank" rel="noreferrer" title={t('另开标签页看原图')}
              style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, color: COLOR.text2, textDecoration: 'none' }}
            ><ExternalLink size={12} /> {t('原图')}</a>
            <button type="button" onClick={() => onClose()} title={t('关闭（Esc）')}
              style={{ background: 'transparent', border: 0, cursor: 'pointer', color: COLOR.text2, padding: 2, display: 'inline-flex' }}
            ><X size={14} /></button>
          </div>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <img
              src={Assets.artifactFileUrl(projectId, file.rel)} alt={file.name}
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block', border: `1px solid ${COLOR.border}` }}
            />
          </div>
        </div>
      </div>
    );
}

export function CaptureShelf({ projectId, sites, onPreview }) {
  const [shelfOpen, setShelfOpen] = useState(true);
  const [openSite, setOpenSite] = useState(null);
  const openSiteData = useMemo(
    () => (openSite ? sites.find(s => s.site === openSite && Array.isArray(s.files)) || null : null),
    [sites, openSite],
  );
  if (!sites.length) return null;
  return         (
      <div style={{
        flexShrink: 0, borderTop: `1px solid ${COLOR.border}`,
        background: COLOR.bgCard, maxHeight: shelfOpen ? 320 : 30, overflow: shelfOpen ? 'auto' : 'hidden',
        transition: 'max-height .18s ease',
      }}>
        <button
          type="button"
          onClick={() => setShelfOpen(v => !v)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, width: '100%',
            padding: `4px ${GAP.md}px`, cursor: 'pointer', background: 'transparent',
            border: 0, color: COLOR.text2, fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
          }}
        >
          <FolderOpen size={12} />
          {t('采到的东西 · {sites} 个站 · {files} 件', { sites: sites.length, files: sites.reduce((n, x) => n + x.count, 0) })}
          <ChevronDown size={12} style={{
            marginLeft: 'auto', opacity: 0.6,
            transform: shelfOpen ? 'none' : 'rotate(-90deg)', transition: 'transform .18s ease',
          }} />
        </button>
        {shelfOpen && (
          <div style={{ display: 'flex', gap: GAP.sm, padding: `0 ${GAP.md}px ${GAP.sm}px`, overflowX: 'auto' }}>
            {sites.map(st => (
              <div key={st.site} style={{ flexShrink: 0, width: 150 }}>
                <button
                  type="button"
                  title={t('{dir}（{n} 件）', { dir: st.dir, n: st.count })}
                  onClick={() => setOpenSite(openSite === st.site ? null : st.site)}
                  style={{
                    display: 'block', width: '100%', padding: 0, cursor: 'pointer',
                    background: CANVAS.paper, border: `1px solid ${openSite === st.site ? COLOR.text : COLOR.border}`,
                    borderRadius: 2, overflow: 'hidden',
                  }}
                >
                  {st.cover ? (
                    <img
                      alt=""
                      loading="lazy"
                      // ⚠️ 这里**不能**加 `?w=`：响应式档只认 png/jpg 源
                      // （`image-variant.js` 的 TRANSCODABLE），而采集的截图是
                      // webp（走感知层那条归一化）。加了是个静默无效的参数，
                      // 看起来像做了优化其实没有。封面 ~60KB，靠 lazy + 折叠够了。
                      src={Assets.artifactFileUrl(projectId, st.cover)}
                      style={{ width: '100%', height: 84, objectFit: 'cover', objectPosition: 'top center', display: 'block' }}
                    />
                  ) : (
                    <div style={{
                      height: 84, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: COLOR.sub, fontFamily: FONT_SANS, fontSize: FONT_SIZE.xxs,
                    }}>{t('没有截图')}</div>
                  )}
                  <div style={{
                    padding: '3px 5px', textAlign: 'left',
                    fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, color: COLOR.text2,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{st.site}</div>
                </button>
              </div>
            ))}
          </div>
        )}
        {/* 点开一站：图按缩略图列出来，点一张在窗内放大；文本档（调色板 / 字体 / 结构 / CSS）
            点了另开标签页看原件。路径仍然给出来，agent 下个会话直接引用它。 */}
        {shelfOpen && openSiteData && (
          <div style={{ padding: `0 ${GAP.md}px ${GAP.sm}px`, fontFamily: FONT_SANS, fontSize: FONT_SIZE.xxs, color: COLOR.sub }}>
            <div style={{ fontFamily: FONT_MONO, marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {t('{dir}/ · {n} 件', { dir: openSiteData.dir, n: openSiteData.count })}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {openSiteData.files.filter(f => f.category !== 'text').map(f => (
                <button
                  key={f.rel}
                  type="button"
                  title={f.name}
                  onClick={() => onPreview({ rel: f.rel, name: f.name })}
                  style={{ padding: 0, border: `1px solid ${COLOR.border}`, borderRadius: 2, background: CANVAS.paper, cursor: 'zoom-in', overflow: 'hidden' }}
                >
                  <img
                    alt={f.name}
                    loading="lazy"
                    src={Assets.artifactFileUrl(projectId, f.rel)}
                    style={{ width: 96, height: 60, objectFit: 'cover', objectPosition: 'top center', display: 'block' }}
                  />
                </button>
              ))}
              {openSiteData.files.filter(f => f.category === 'text').map(f => (
                <a
                  key={f.rel}
                  href={Assets.artifactFileUrl(projectId, f.rel)}
                  target="_blank"
                  rel="noreferrer"
                  title={f.name}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: 180,
                    padding: '3px 6px', border: `1px solid ${COLOR.border}`, borderRadius: 2,
                    background: CANVAS.paper, color: COLOR.text2, textDecoration: 'none',
                    fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs,
                  }}
                >
                  <FileText size={11} style={{ flexShrink: 0 }} />
                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</span>
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    );
}
