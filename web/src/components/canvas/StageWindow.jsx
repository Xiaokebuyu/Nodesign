import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Play, Square, RotateCw, ScrollText } from 'lucide-react';
import ArtifactWindow from './ArtifactWindow.jsx';
import { MarkdownViewerOverlay } from './BoardOverlays.jsx';
import { Stage, Assets } from '../../lib/api.js';

const TABLE_PATH = 'stage/台面.md';

/**
 * StageWindow —— 演出（RP 显示器）的最大化窗（2026-09-05）
 *
 * 跟 SiteWindow 走同一副外壳（ArtifactWindow），内容层就是一个 iframe 装服务端那条
 * `/stage/view`。**卡上和这里装的是同一个页面**：显示器自己订着 SSE、自己画每一拍、
 * 自己 POST 用户说的话进演出进程 —— 这扇窗不再另开一条数据流，只做三件事：
 *
 *   1. 把工具栏换成 RP 专用那条（开演 / 散场 / 皮肤 / 重载），交给外层常驻工具栏
 *   2. 从 iframe 的 postMessage 里拿状态（在等你 / 正在写 / 散场了）画在顶栏小字上
 *   3. 换皮肤时先 postMessage 让显示器当场变脸，再 PATCH 服务端那份，两边随后对齐
 *
 * 为什么状态走 postMessage 不再开一条 SSE：浏览器对同源 HTTP/1.1 连接数有上限（6），
 * 画布上每张演出卡的预览 iframe 已经各占一条流；窗再开一条纯为了读状态是浪费。
 * 显示器每次 status 变化都会往父窗报一次（display.html 的 tellParent）。
 */

const SKINS = [
  { id: 'paper', label: '纸' },
  { id: 'jiangnan', label: '江南' },
  { id: 'night', label: '夜' },
  { id: 'terminal', label: '终端' },
];

export default function StageWindow({ projectId, root, title, onClose, onToolbarGroups }) {
  const [status, setStatus] = useState({ running: false, busy: false, queued: 0 });
  const [skin, setSkin] = useState('paper');
  const [liveTitle, setLiveTitle] = useState(title || '');
  const [reloadKey, setReloadKey] = useState(0);
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState(null);
  const iframeRef = useRef(null);
  void root;   // 卡 id 里的那段路径；一个项目一场戏，窗里暂时用不上

  useEffect(() => {
    const onMsg = (e) => {
      if (e.origin !== window.location.origin || !e.data || e.data.nd !== 'stage') return;
      setStatus({ running: !!e.data.running, busy: !!e.data.busy, queued: e.data.queued || 0 });
      if (e.data.skin) setSkin(e.data.skin);
      if (e.data.title) setLiveTitle(e.data.title);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const toggleRun = useCallback(async () => {
    setPending(true); setNote(null);
    try {
      if (status.running) await Stage.stop(projectId);
      else await Stage.start(projectId);
    } catch (err) {
      // 名额满 / 没资格 / 还没开过戏：如实写在顶栏，别静默
      setNote(err?.message || '没起来');
    } finally { setPending(false); }
  }, [projectId, status.running]);

  const changeSkin = useCallback(async (id) => {
    setSkin(id);
    try { iframeRef.current?.contentWindow?.postMessage({ nd: 'stage-skin', skin: id }, window.location.origin); } catch { /* 跨源就等服务端那份 */ }
    try { await Stage.patchConfig(projectId, { skin: id }); } catch { /* 显示器已经变脸了，落盘失败下次开窗会退回 */ }
  }, [projectId]);

  const reload = useCallback(() => setReloadKey(k => k + 1), []);

  // 台面（世界 / 规矩）住 stage/台面.md，stage/ 整段被演出卡认领、画布上没有它的文件卡，
  // 所以从这里开阅读器（编辑态走 PUT /stage/file）。角色卡在 角色/ 文件夹里，双击卡就能改。
  const [viewer, setViewer] = useState(null);
  const openTable = useCallback(async () => {
    try {
      const res = await fetch(Assets.artifactFileUrl(projectId, TABLE_PATH));
      const raw = res.ok ? await res.text() : '';
      setViewer({ title: '台面', content: raw || '（这场戏还没有台面文件 —— 让 agent 用 open_stage 开戏时会写一份）', editKind: res.ok ? 'stagefile' : null, editPath: TABLE_PATH });
    } catch (err) { setNote(err?.message || '读不到台面'); }
  }, [projectId]);

  const groups = useMemo(() => [
    {
      id: 'run',
      items: [
        {
          id: 'toggle',
          icon: status.running ? Square : Play,
          label: status.running ? '散场' : '开演',
          disabled: pending,
          title: status.running
            ? '停掉演出进程（设定和记忆都留着，再开就接上）'
            : '把演出进程起回来（散场后 / 服务端重启后）。直接在台上说一句话也会自动开',
          onClick: toggleRun,
        },
        { id: 'reload', icon: RotateCw, title: '重载显示器', onClick: reload },
        { id: 'table', icon: ScrollText, label: '台面', title: '看 / 改这场戏的世界与规矩（stage/台面.md）。改完下一句话到时进程自动重开', onClick: openTable },
      ],
    },
    {
      id: 'skin',
      type: 'mode',
      value: skin,
      onChange: changeSkin,
      items: SKINS.map(s => ({ id: s.id, label: s.label, title: `皮肤 · ${s.label}` })),
    },
  ], [status.running, pending, toggleRun, reload, openTable, skin, changeSkin]);

  const subtitle = note
    || (status.running
      ? (status.busy ? '台上正在写' : (status.queued ? `排着 ${status.queued} 句` : '台上在等你'))
      : '散场了 · 说一句就再开');

  return (
    <ArtifactWindow
      kind="stage"
      title={liveTitle || title || '演出'}
      subtitle={subtitle}
      onClose={onClose}
      groups={groups}
      onToolbarGroups={onToolbarGroups}
    >
      <iframe
        key={reloadKey}
        ref={iframeRef}
        title="stage"
        src={Stage.viewUrl(projectId)}
        sandbox="allow-scripts allow-same-origin allow-forms"
        style={{ flex: 1, minHeight: 0, width: '100%', border: 0, background: 'transparent' }}
      />
      {viewer && (
        <MarkdownViewerOverlay
          projectId={projectId}
          viewer={viewer}
          onClose={() => setViewer(null)}
          onSaved={(draft) => setViewer(v => (v ? { ...v, content: draft } : v))}
        />
      )}
    </ArtifactWindow>
  );
}
