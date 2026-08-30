import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  ChevronLeft, ChevronRight, Maximize2, Scan, FileJson, Eye, FileType2, Loader2,
  SquareDashedMousePointer,
} from 'lucide-react';
import { Assets } from '../../lib/api.js';
import { COLOR, CANVAS, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { versionOfFile } from '../../lib/file-versions.js';
import ArtifactWindow, { exportToolGroup, INK_READOUT } from './ArtifactWindow.jsx';
import ToolbarButton, { TOOL_BTN } from '../ui/ToolbarButton.jsx';
import DocxRegionSelect from './DocxRegionSelect.jsx';
import { INK_SURFACE, PAPER_SHADOW } from '../../lib/paper.js';

/**
 * DocxWindow —— word 文档的产物窗（2026-08-17，跟 DeckWindow / SiteWindow 并列的第三种）
 *
 * ## 它跟前两扇窗的根本区别
 *
 * deck 和站点都是 **iframe 里跑一个活页面** —— 所以它们能有 DOM 级的能力：
 * 点选元素评论、拖着改位置、读计算样式。docx 没有 DOM，它是**一张一张页图**
 * （服务端 LibreOffice 渲的）。
 *
 * 这条差别决定了复用的边界，不是懒得接：
 *   ✅ 能复用 —— 外壳（ArtifactWindow）、导出工具组、圈选说事（框一块 + 截那块
 *      图 + 一句话，三件里没有一件依赖 DOM）、看源码
 *   ❌ 复用不了 —— 点选元素评论、直接拖拽编辑、取计算样式（都要 findElementByAnchor）
 *
 * 对文档来说这个取舍其实是顺的：人批注纸质文档本来就是**圈一块**说事，
 * 不是点某个字。
 *
 * ## 翻页为什么不预取
 *
 * 服务端一次渲整份、按源 mtime 缓存，翻页命中缓存只要 1ms —— 贵的是第一次
 * 那两秒。所以这里老老实实一页一请求，不做预取窗口。
 */

/** 顶栏之外的内边距，页图四周留白 */
const PAD = 24;

export default function DocxWindow({
  projectId,
  /** 工作区相对路径，例如 '文档.docx'；word 文件夹时 = 主成员 */
  file,
  title,
  /** token 源文件名（有就说明是我们造的，可以看源码 / 改源重建） */
  sourceFile = null,
  /**
   * word 文件夹的成员表 `[{ file, title, sourceFile }]`（多版本并排放，这里的
   * 导航切换）。单份 .docx 时是 null —— 窗里就没有切换器，其余一切照旧
   */
  members = null,
  /** 服务端形态注册表给的可导出格式 */
  exports: artifactExports,
  /** (fmt, file) —— 第二参是当前看的成员，导出点名它而不是整卡 */
  onExport,
  onClose,
  onToolbarGroups,
  /** 圈选评论（页图版）：({ region, viewport, elements, container, text, path, docxPage }) => Promise */
  onRegionComment = null,
  /** 版本表（穿透浏览器缓存）。按**当前成员**取版本，切成员各取各的 */
  fileVersions = null,
}) {
  const [page, setPage] = useState(1);
  const [count, setCount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [fit, setFit] = useState('height');     // 'height' 铺满高度 | 'width' 铺满宽度
  const [tab, setTab] = useState('preview');    // 'preview' | 'pdf' | 'source'
  const [regionMode, setRegionMode] = useState(false);
  const [source, setSource] = useState(null);
  const [imgUrl, setImgUrl] = useState(null);
  const boxRef = useRef(null);
  const imgRef = useRef(null);

  // 当前看哪个成员。卡片双击进来时看主成员；prop 换了（开了另一张卡）跟着换
  const [cur, setCur] = useState(file);
  useEffect(() => { setCur(file); }, [file]);
  const curMember = members?.find(m => m.file === cur) || null;
  const curSource = curMember ? curMember.sourceFile : sourceFile;
  const version = versionOfFile(fileVersions, cur);

  const src = useMemo(
    () => Assets.docxPageUrl(projectId, cur, page, { v: version }),
    [projectId, cur, page, version],
  );

  // 换文档（不是换页）时回到第一页 —— 停在第 7 页看另一份文档是没道理的。
  // 源码缓存也清：那是上一份的源
  useEffect(() => { setPage(1); setCount(null); setSource(null); }, [cur]);

  // 用 fetch 而不是直接把 URL 交给 <img>：页数在**响应头**里（服务端顺带给的），
  // <img> 拿不到头。
  //
  // ⚠️ 拿到的 blob 要当图源用，不能 fetch 一遍再让 <img> 按同一个 URL 再取一遍
  // —— 那是整张全尺寸 PNG **下载两遍**（服务端的 in-flight 去重防的是重复渲染，
  // 不防重复传输）。顺带这样 loading 才熄得对：熄在图真的到手时，而不是响应头
  // 一到就熄、留用户对着一块空白。
  useEffect(() => {
    let dead = false;
    let url = null;
    setLoading(true);
    setError(null);
    fetch(src)
      .then(async (r) => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || `渲染失败（${r.status}）`);
        }
        const n = Number(r.headers.get('X-Docx-Pages'));
        const blob = await r.blob();
        if (dead) return;
        if (n > 0) setCount(n);
        url = URL.createObjectURL(blob);
        setImgUrl(url);
        setLoading(false);
      })
      .catch((e) => { if (!dead) { setError(e.message); setLoading(false); } });
    return () => {
      dead = true;
      if (url) URL.revokeObjectURL(url);   // 不收的话翻十页留十份全尺寸位图在内存里
    };
  }, [src]);

  // 看源码：token JSON 就是这份文档的真相源
  useEffect(() => {
    if (tab !== 'source' || !curSource || source != null) return;
    fetch(Assets.artifactFileUrl(projectId, curSource))
      .then(r => r.text())
      .then(setSource)
      .catch(() => setSource('（读不到源文件）'));
  }, [tab, curSource, projectId, source]);

  const go = useCallback((delta) => {
    setPage(p => Math.min(Math.max(1, p + delta), count || p + delta));
  }, [count]);

  // 键盘翻页。ESC 归外壳管（这扇窗没有"先清选中"那种优先级）
  useEffect(() => {
    const onKey = (e) => {
      if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go(1); }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  const groups = useMemo(() => [
    // ⭐word 文件夹的导航：成员（多版本）切换。site 的「页」是文件、docx 文件夹
    // 的「份」也是文件 —— 但版本不是页，翻页键留给页，切版本用选择器。
    // 单份文档（members 空）没有这一组，窗跟原来一模一样。
    //
    // ⚠️ `value` 必须给：工具栏的签名守卫（CanvasFrame.sigOf）对 `node` 组只看
    // id + value，切成员只变 node 内容的话签名不动、工具栏不重渲 —— 表现是
    // 「选了另一份，选择器上的名字要等按一下翻页才变」（2026-08-19 实踩）。
    (members && members.length > 1) ? {
      id: 'member',
      value: cur,
      node: (
        <select
          value={cur}
          onChange={(e) => setCur(e.target.value)}
          title="这个文件夹里的文档（多版本并排放，选一份看）"
          style={{
            maxWidth: 180, height: 24, padding: '0 4px',
            // 工具栏是墨面（INK_SURFACE），控件配色跟着它走 —— 白底 select 压在
            // 墨面药丸上就是「一条工具栏两种物料」（SitePublishControl 踩过的同一课）
            border: `1px solid ${INK_SURFACE.hair}`,
            borderRadius: TOOL_BTN.radius, background: 'transparent', color: INK_SURFACE.text,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, cursor: 'pointer',
          }}
        >
          {members.map(m => (
            // 下拉列表是系统渲染的，不吃 select 的透明底 —— 选项要自带可读配色
            <option key={m.file} value={m.file} style={{ background: COLOR.bgWhite, color: COLOR.text }}>
              {m.title || m.file}
            </option>
          ))}
        </select>
      ),
    } : null,
    // ⭐word 特制控件：翻页。deck 的"页"是 section、站点的"页"是文件，
    // 只有文档的页是**排版算出来的** —— 改一个字号页数就变，所以页码不能存，
    // 只能每次问渲染管线。
    // 按钮·读数·按钮挤在**一个** node 组里 = 一颗药丸（原来拆成三个组，渲成
    // 三颗各自为政的小药丸）；value 带上 page/count，翻页中段签名才会变。
    {
      id: 'pager',
      value: `${page}/${count ?? ''}`,
      node: (
        <>
          <ToolbarButton dataId="prev" icon={ChevronLeft} title="上一页（← / PageUp）" disabled={page <= 1} onClick={() => go(-1)} />
          <span style={{
            ...INK_READOUT, fontFamily: FONT_MONO, fontVariantNumeric: 'tabular-nums',
            padding: `0 ${GAP.xs}px`, minWidth: 40, textAlign: 'center',
            whiteSpace: 'nowrap', userSelect: 'none',
          }}>
            {count ? `${page} / ${count}` : page}
          </span>
          <ToolbarButton dataId="next" icon={ChevronRight} title="下一页（→ / PageDown）" disabled={!!count && page >= count} onClick={() => go(1)} />
        </>
      ),
    },
    // 圈选说事：页图上框一块 + 一句话，发进 pending-changes（deck / site 同款
    // 动作；docx 没有 DOM，元素清单那一维天然不存在）
    (onRegionComment && tab === 'preview') ? {
      id: 'regionmode',
      items: [{
        id: 'region', icon: SquareDashedMousePointer, label: '圈选',
        title: '在页面上框一块发给 agent',
        active: regionMode, onClick: () => setRegionMode(v => !v),
      }],
    } : null,
    {
      id: 'fit',
      items: [
        { id: 'fitH', icon: Maximize2, title: '整页（铺满高度）', active: fit === 'height', onClick: () => setFit('height') },
        { id: 'fitW', icon: Scan, title: '铺满宽度（看细节）', active: fit === 'width', onClick: () => setFit('width') },
      ],
    },
    {
      id: 'tab',
      items: [
        { id: 'preview', icon: Eye, title: '看页面', active: tab === 'preview', onClick: () => setTab('preview') },
        // PDF 视图按需现渲、跟着 .docx 的 mtime 走 —— 做成查看态而不是落盘文件，
        // 就是为了它永远不陈旧（落一份 PDF 在文件夹里，改完 docx 忘了重转，
        // 用户看到的就是旧的）。真要 PDF 文件走导出。
        { id: 'pdf', icon: FileType2, title: '连续阅读（浏览器 PDF 视图，可搜索选字）', active: tab === 'pdf', onClick: () => setTab('pdf') },
        ...(curSource ? [
          { id: 'source', icon: FileJson, title: `看源码（${curSource}）—— 改这份再 build，别改 .docx`, active: tab === 'source', onClick: () => setTab('source') },
        ] : []),
      ],
    },
    exportToolGroup({ kind: 'docx', exports: artifactExports, onExport: onExport ? (fmt) => onExport(fmt, cur) : null }),
  ].filter(Boolean), [page, count, fit, tab, curSource, artifactExports, onExport, go, members, cur,
    onRegionComment, regionMode]);

  // 圈选提交：坐标已被 DocxRegionSelect 换算成页图像素，这里补上"哪份文档、
  // 第几页"。elements/container 传空不传缺 —— 服务端合同里它们是数组/对象槽位
  const submitRegion = useCallback(async ({ region, viewport, text }) => {
    await onRegionComment?.({
      region, viewport, elements: [], container: null, text,
      path: cur, docxPage: page,
    });
  }, [onRegionComment, cur, page]);

  const imgStyle = fit === 'height'
    ? { height: '100%', width: 'auto', maxWidth: '100%' }
    : { width: '100%', height: 'auto' };

  return (
    <ArtifactWindow
      kind="docx"
      title={curMember?.title ? `${title || file} · ${curMember.title}` : (title || file)}
      subtitle={count ? `${count} 页` : null}
      onClose={onClose}
      groups={groups}
      onToolbarGroups={onToolbarGroups}
      banner={curSource ? null : (
        <span>
          这是一份<b>外来文档</b>（没有 token 源）。现在能看、能导出，<b>改它要等编辑道上线</b>
          —— 想现在就要一个改过的版本，让 agent 基于它的内容重做一份。
        </span>
      )}
      contentStyle={{ background: CANVAS.paper }}
    >
      {tab === 'pdf' ? (
        // 浏览器自带的 PDF 阅读器：连续滚动、可搜索、可选字 —— 页图给不了的
        // 都在这。key 带版本：agent 一 rebuild，iframe 换 src 自动重载
        <iframe
          key={`${cur}?v=${version}`}
          title={`${title || cur} PDF`}
          src={Assets.docxPdfUrl(projectId, cur, { v: version })}
          style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
        />
      ) : tab === 'source' ? (
        <pre style={{
          margin: 0, padding: GAP.lg, height: '100%', overflow: 'auto',
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, lineHeight: 1.6,
          color: COLOR.text, background: COLOR.bgWhite, whiteSpace: 'pre-wrap',
        }}>
          {source ?? '读取中…'}
        </pre>
      ) : (
        <div
          ref={boxRef}
          style={{
            height: '100%', width: '100%', overflow: 'auto',
            display: 'flex', alignItems: fit === 'height' ? 'center' : 'flex-start',
            justifyContent: 'center', padding: PAD, boxSizing: 'border-box',
          }}
        >
          {error ? (
            <div style={{
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2,
              textAlign: 'center', maxWidth: 420, lineHeight: 1.7,
            }}>
              {error}
              <div style={{ marginTop: GAP.sm, color: COLOR.sub, fontSize: FONT_SIZE.xs }}>
                渲染链路的问题跟文档本身无关。文档还在，导出照常能用。
              </div>
            </div>
          ) : (
            <div style={{ position: 'relative', height: fit === 'height' ? '100%' : 'auto', maxWidth: '100%' }}>
              <img
                ref={imgRef}
                alt={`${title || cur} 第 ${page} 页`}
                src={imgUrl || undefined}
                style={{ ...imgStyle, display: 'block', background: '#fff', boxShadow: PAPER_SHADOW.mid, borderRadius: 2 }}
              />
              {/* key 带文档+页：翻页/切成员后半成品的框不该还挂在新页上 */}
              <DocxRegionSelect
                key={`${cur}#${page}`}
                active={regionMode && !loading}
                imgRef={imgRef}
                onSubmit={submitRegion}
                onExit={() => setRegionMode(false)}
              />
              {loading && (
                <div style={{
                  position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(255,254,246,0.65)', gap: GAP.sm,
                  fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2, borderRadius: 2,
                }}>
                  {/* spin 不是全局 keyframes，得自带 —— 少了这条图标是冻住的（实踩） */}
                  <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
                  <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
                  加载中
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </ArtifactWindow>
  );
}
