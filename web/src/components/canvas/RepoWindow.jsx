/**
 * web/src/components/canvas/RepoWindow.jsx — 仓库卡那扇窗（2026-09-08 存量仓库道·第二段）
 *
 * 左边文件树（一层一层展开，每条带 git 状态），右边代码阅读器（Monaco 只读）。
 * 顶上一行：分支 · 上次提交 · 改动计数。**全部只读** —— 改是 agent 在 cwd 里改的，
 * 这里是用户看它改了什么的窗。
 *
 * 为什么不复用 FolderWindow：文件夹窗的条目是画布物件（能拖、能改名、能删、能进
 * 上下文），那套动作在用户仓库上一个都不该有。仓库窗只有「看」这一个动词。
 *
 * 状态刷新：窗开着每 8 秒拉一次 summary + 已展开目录（agent 在改的时候树上的标记会跟着变）。
 */
import { useState, useEffect, useCallback, useMemo, useRef, Suspense, lazy } from 'react';
import { ChevronRight, ChevronDown, File, Folder, FolderOpen, GitBranch, RefreshCw, FileWarning, Undo2 } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS, CANVAS } from '../../lib/theme.js';
import { Repo } from '../../lib/api.js';
import { useRepoStore } from '../../stores/repoStore.js';
import { formatClock } from '../../lib/helpers.js';
import ArtifactWindow from './ArtifactWindow.jsx';
import '../../lib/monaco-local.js';   // monaco 本地打包（09-08），别去 CDN

const Editor = lazy(() => import('@monaco-editor/react'));

const REFRESH_MS = 8000;
const TREE_W = 272;

/** git 状态字母 → 颜色 + 说明 */
const STATUS_STYLE = {
  M: { color: COLOR.warn, title: '改过' },
  A: { color: COLOR.success, title: '新增（已暂存）' },
  '?': { color: COLOR.success, title: '新文件（未跟踪）' },
  D: { color: COLOR.error, title: '删了' },
  R: { color: COLOR.warn, title: '改了名' },
};

/** 扩展名 → Monaco 语言 id（认不出的按纯文本） */
const LANG_BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', json: 'json', md: 'markdown', html: 'html', htm: 'html',
  css: 'css', scss: 'scss', less: 'less', py: 'python', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php', sh: 'shell', bash: 'shell',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', xml: 'xml', svg: 'xml', sql: 'sql', vue: 'html',
  swift: 'swift', kt: 'kotlin', dart: 'dart', lua: 'lua', r: 'r', dockerfile: 'dockerfile',
};
function languageOf(rel) {
  const name = rel.split('/').pop().toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  const ext = name.includes('.') ? name.split('.').pop() : '';
  return LANG_BY_EXT[ext] || 'plaintext';
}

function fmtSize(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function StatusDot({ status, changes }) {
  if (status && STATUS_STYLE[status]) {
    const st = STATUS_STYLE[status];
    return <span title={st.title} style={{ color: st.color, fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, marginLeft: 'auto', paddingLeft: GAP.sm }}>{status}</span>;
  }
  if (changes) {
    return <span title={`里面有 ${changes} 处改动`} style={{ color: COLOR.warn, fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, marginLeft: 'auto', paddingLeft: GAP.sm }}>{changes}</span>;
  }
  return null;
}

/**
 * 树的一层。`nodes[rel]` 是已经拉回来的目录内容；没拉的目录点开时才拉。
 * 递归渲染，缩进按深度。
 */
function TreeLevel({ rel, nodes, open, onToggle, onOpenFile, selected, depth }) {
  const entries = nodes[rel];
  if (!entries) return <div style={{ padding: `${GAP.xs}px ${GAP.md}px`, paddingLeft: GAP.md + depth * 14, color: COLOR.sub, fontSize: FONT_SIZE.xs }}>…</div>;
  if (!entries.length) return <div style={{ padding: `${GAP.xs}px ${GAP.md}px`, paddingLeft: GAP.md + depth * 14, color: COLOR.dim, fontSize: FONT_SIZE.xs }}>空</div>;
  return entries.map(e => {
    const isOpen = e.dir && open.has(e.rel);
    const Icon = e.dir ? (isOpen ? FolderOpen : Folder) : File;
    const isSel = !e.dir && selected === e.rel;
    return (
      <div key={e.rel}>
        <div
          role="treeitem"
          aria-expanded={e.dir ? isOpen : undefined}
          title={e.ignored ? `${e.name}（依赖 / 构建缓存，不逛）` : e.rel}
          onClick={() => (e.dir ? (!e.ignored && onToggle(e.rel)) : onOpenFile(e.rel))}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: `3px ${GAP.md}px`, paddingLeft: GAP.md + depth * 14,
            cursor: e.ignored ? 'default' : 'pointer',
            color: e.ignored ? COLOR.dim : COLOR.text2,
            background: isSel ? 'rgba(43,33,23,0.07)' : 'transparent',
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, lineHeight: 1.5,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            userSelect: 'none',
          }}
        >
          {e.dir
            ? (isOpen ? <ChevronDown size={11} style={{ flexShrink: 0, opacity: 0.6 }} /> : <ChevronRight size={11} style={{ flexShrink: 0, opacity: e.ignored ? 0.25 : 0.6 }} />)
            : <span style={{ width: 11, flexShrink: 0 }} />}
          <Icon size={12} style={{ flexShrink: 0, opacity: 0.7 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.name}</span>
          <StatusDot status={e.status} changes={e.changes} />
        </div>
        {isOpen && (
          <TreeLevel rel={e.rel} nodes={nodes} open={open} onToggle={onToggle} onOpenFile={onOpenFile} selected={selected} depth={depth + 1} />
        )}
      </div>
    );
  });
}

/**
 * 最近几轮（改道安全网，09-08）：每轮开工前服务端拍了快照，这里列「这轮改了 N 个文件」，
 * 按钮是「回到这轮之前」—— 两步确认（先点变成"确定？"，再点才发），不弹系统对话框。
 * 回退会把这轮**和之后所有轮**改过的文件一起还原，按钮文案说清楚。
 */
function TurnsStrip({ projectId, turns, onReverted }) {
  const [arm, setArm] = useState(null);     // 待确认的 runId
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const shown = turns.filter(t => t.endedAt && t.changed.length);
  if (!shown.length) return null;
  const doRevert = async (runId) => {
    setBusy(true); setNote(null);
    try {
      const r = await Repo.revert(projectId, runId);
      setNote(`已还原 ${r.restored.length + r.removed.length} 个文件`);
      onReverted?.();
    } catch (err) {
      setNote(err?.message || '回退失败');
    } finally { setBusy(false); setArm(null); }
  };
  return (
    <div style={{ borderBottom: `1px solid ${COLOR.borderLt}`, padding: `${GAP.xs}px ${GAP.lg}px`, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: GAP.md, fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>
      {shown.slice(0, 4).map((t, i) => (
        <span key={t.runId} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span title={t.changed.map(c => `${c.status} ${c.rel}`).join('\n')}>
            {i === 0 ? '上一轮' : formatClock(t.startedAt)} 改了 {t.changed.length} 个文件
          </span>
          <button
            disabled={busy}
            onClick={() => (arm === t.runId ? doRevert(t.runId) : setArm(t.runId))}
            title={arm === t.runId ? '再点一次就还原：这轮和之后所有轮的改动都会回到这轮开工之前' : '回到这轮开工之前（只动仓库工作树，不碰 git 历史）'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 3, cursor: busy ? 'default' : 'pointer',
              border: `1px solid ${arm === t.runId ? COLOR.error : COLOR.borderMd}`, borderRadius: 2, padding: '0 6px',
              background: 'transparent', color: arm === t.runId ? COLOR.error : COLOR.text2, fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
            }}
          >
            <Undo2 size={10} />{arm === t.runId ? '确定？' : '回到这轮之前'}
          </button>
        </span>
      ))}
      {note && <span style={{ color: COLOR.text2 }}>{note}</span>}
    </div>
  );
}

export default function RepoWindow({ projectId, name, onClose, onToolbarGroups }) {
  const [summary, setSummary] = useState(null);
  const [nodes, setNodes] = useState({});        // rel → entries
  const [open, setOpen] = useState(() => new Set());
  const [selected, setSelected] = useState(null);
  const [file, setFile] = useState(null);         // { path, text, size, binary, truncated } | { path, error }
  const [turns, setTurns] = useState([]);
  const repoVersion = useRepoStore(s => s.version);   // agent 写了仓库文件 / 一轮结算 → 重拉
  const openRef = useRef(open); openRef.current = open;

  const loadDir = useCallback(async (rel) => {
    try {
      const r = await Repo.tree(projectId, rel);
      setNodes(prev => ({ ...prev, [rel]: r.entries || [] }));
    } catch (err) {
      setNodes(prev => ({ ...prev, [rel]: [] }));
      if (err?.status !== 404) console.warn('[repo] tree', rel, err?.message || err);
    }
  }, [projectId]);

  const refresh = useCallback(async () => {
    Repo.summary(projectId).then(setSummary).catch(() => {});
    Repo.turns(projectId).then(r => setTurns(r?.turns || [])).catch(() => {});
    await loadDir('');
    for (const rel of openRef.current) await loadDir(rel);
  }, [projectId, loadDir]);

  useEffect(() => { refresh(); }, [refresh, repoVersion]);
  useEffect(() => {
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const toggle = useCallback((rel) => {
    setOpen(prev => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else { next.add(rel); if (!nodes[rel]) loadDir(rel); }
      return next;
    });
  }, [nodes, loadDir]);

  const openFile = useCallback(async (rel) => {
    setSelected(rel);
    setFile({ path: rel, loading: true });
    try {
      const r = await Repo.file(projectId, rel);
      setFile(r);
    } catch (err) {
      setFile({ path: rel, error: err?.message || '读不了这个文件' });
    }
  }, [projectId]);

  const groups = useMemo(() => [
    { id: 'repo', items: [{ id: 'refresh', icon: RefreshCw, title: '重新读一遍', onClick: refresh }] },
  ], [refresh]);

  const git = summary?.git || null;
  const counts = git?.counts;
  const changed = counts ? counts.modified + counts.added + counts.deleted + counts.untracked : 0;
  const subtitle = git
    ? `${git.branch || '（游离）'}${changed ? ` · ${changed} 处改动` : ' · 干净'}`
    : '不是 git 仓库';

  return (
    <ArtifactWindow
      kind="repo"
      title={name || summary?.name || '仓库'}
      subtitle={subtitle}
      onClose={onClose}
      groups={groups}
      onToolbarGroups={onToolbarGroups}
      headerExtra={(
        <>
        {git?.head && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: GAP.sm, padding: `${GAP.xs}px ${GAP.lg}px`,
          borderBottom: `1px solid ${COLOR.borderLt}`, fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          <GitBranch size={11} style={{ flexShrink: 0 }} />
          <span style={{ color: COLOR.text2 }}>{git.branch}</span>
          <span>·</span>
          <span title={git.head.when}>{git.head.sha}</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{git.head.subject}</span>
          {counts && (
            <span style={{ marginLeft: 'auto', flexShrink: 0 }}>
              {counts.modified ? <span style={{ color: COLOR.warn }}>改 {counts.modified} </span> : null}
              {counts.added + counts.untracked ? <span style={{ color: COLOR.success }}>新 {counts.added + counts.untracked} </span> : null}
              {counts.deleted ? <span style={{ color: COLOR.error }}>删 {counts.deleted}</span> : null}
            </span>
          )}
        </div>
        )}
        <TurnsStrip projectId={projectId} turns={turns} onReverted={refresh} />
        </>
      )}
      contentStyle={{ background: CANVAS.paper }}
    >
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div role="tree" style={{
          width: TREE_W, flexShrink: 0, overflow: 'auto', borderRight: `1px solid ${COLOR.borderLt}`,
          padding: `${GAP.sm}px 0`, background: 'rgba(43,33,23,0.02)',
        }}>
          <TreeLevel rel="" nodes={nodes} open={open} onToggle={toggle} onOpenFile={openFile} selected={selected} depth={0} />
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {!file && (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: COLOR.sub, fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, textAlign: 'center', lineHeight: 1.8, padding: GAP.xl }}>
              左边点一个文件就在这里看。<br />这扇窗只看不改：改动是 agent 在仓库里做的，树上的字母是 git 说的。
            </div>
          )}
          {file && (
            <>
              <div style={{
                flexShrink: 0, display: 'flex', alignItems: 'center', gap: GAP.sm,
                padding: `${GAP.xs}px ${GAP.md}px`, borderBottom: `1px solid ${COLOR.borderLt}`,
                fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
              }}>
                <span style={{ color: COLOR.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.path}</span>
                {Number.isFinite(file.size) && <span style={{ marginLeft: 'auto', flexShrink: 0 }}>{fmtSize(file.size)}</span>}
                {file.truncated && <span title="超过 512KB，只读了前面这段" style={{ color: COLOR.warn, flexShrink: 0 }}>截断</span>}
              </div>
              {file.loading && <div style={{ padding: GAP.lg, color: COLOR.sub, fontSize: FONT_SIZE.xs }}>读取中…</div>}
              {file.error && <div style={{ padding: GAP.lg, color: COLOR.error, fontSize: FONT_SIZE.xs }}>{file.error}</div>}
              {file.binary && (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: GAP.sm, color: COLOR.sub, fontSize: FONT_SIZE.xs }}>
                  <FileWarning size={14} /> 二进制文件，这里不显示
                </div>
              )}
              {typeof file.text === 'string' && (
                <div style={{ flex: 1, minHeight: 0 }}>
                  <Suspense fallback={<pre style={{ margin: 0, padding: GAP.md, fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, overflow: 'auto', height: '100%', boxSizing: 'border-box' }}>{file.text}</pre>}>
                    <Editor
                      height="100%"
                      path={file.path}
                      language={languageOf(file.path)}
                      value={file.text}
                      theme="vs"
                      options={{
                        readOnly: true, minimap: { enabled: false }, fontSize: 12, wordWrap: 'on',
                        scrollBeyondLastLine: false, renderLineHighlight: 'none', lineNumbersMinChars: 3,
                        domReadOnly: true, automaticLayout: true,
                      }}
                    />
                  </Suspense>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </ArtifactWindow>
  );
}
