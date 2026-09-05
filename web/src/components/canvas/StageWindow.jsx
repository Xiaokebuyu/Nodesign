import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Play, Square, RotateCw } from 'lucide-react';
import ArtifactWindow from './ArtifactWindow.jsx';
import { Stage } from '../../lib/api.js';

/**
 * StageWindow —— 演出（RP 显示器）的最大化窗（2026-09-05；当晚随"一场戏一个文件夹"重写）
 *
 * 跟 SiteWindow 走同一副外壳（ArtifactWindow），内容层就是一个 iframe 装服务端那条
 * `/stage/<戏>/view`。**卡上和这里装的是同一个页面**：显示器自己订着 SSE、自己画每一拍、
 * 自己 POST 用户说的话、自己改台面和角色卡 —— 这扇窗不再另开一条数据流，只做三件事：
 *
 *   1. 把工具栏换成 RP 专用那条：开演 / 散场、五个页面（舞台 / 人物 / 记忆 / 上下文 / 状态）、皮肤、重载
 *   2. 从 iframe 的 postMessage 里拿状态（在等你 / 正在写 / 散场了）画在顶栏小字上
 *   3. 切页、换皮肤都 postMessage 给显示器，它自己去改（皮肤再 PATCH 服务端那份）
 *
 * 为什么状态走 postMessage 不再开一条 SSE：浏览器对同源 HTTP/1.1 连接数有上限（6），
 * 画布上每张演出卡的预览 iframe 已经各占一条流。
 */

const SKINS = [
  { id: 'paper', label: '纸' },
  { id: 'jiangnan', label: '江南' },
  { id: 'night', label: '夜' },
  { id: 'terminal', label: '终端' },
];
const PAGES = [
  { id: 'stage', label: '舞台' },
  { id: 'cast', label: '人物' },
  { id: 'memory', label: '记忆' },
  { id: 'context', label: '上下文' },
  { id: 'status', label: '状态' },
];

export default function StageWindow({ projectId, root, title, onClose, onToolbarGroups }) {
  const [status, setStatus] = useState({ running: false, busy: false, queued: 0 });
  const [skin, setSkin] = useState('paper');
  const [page, setPage] = useState('stage');
  const [liveTitle, setLiveTitle] = useState(title || '');
  const [reloadKey, setReloadKey] = useState(0);
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState(null);
  const iframeRef = useRef(null);

  useEffect(() => {
    const onMsg = (e) => {
      if (e.origin !== window.location.origin || !e.data || e.data.nd !== 'stage') return;
      if (e.data.root && e.data.root !== root) return;   // 画布上别的演出卡的预览也在报，只认自己这场
      setStatus({ running: !!e.data.running, busy: !!e.data.busy, queued: e.data.queued || 0 });
      if (e.data.skin) setSkin(e.data.skin);
      if (e.data.title) setLiveTitle(e.data.title);
      if (e.data.page) setPage(e.data.page);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [root]);

  const post = useCallback((msg) => {
    try { iframeRef.current?.contentWindow?.postMessage(msg, window.location.origin); } catch { /* */ }
  }, []);

  const toggleRun = useCallback(async () => {
    setPending(true); setNote(null);
    try {
      if (status.running) await Stage.stop(projectId, root);
      else await Stage.start(projectId, root);
    } catch (err) {
      setNote(err?.message || '没起来');   // 名额满 / 没资格 / 还没开过戏：如实写在顶栏
    } finally { setPending(false); }
  }, [projectId, root, status.running]);

  const changeSkin = useCallback(async (id) => {
    setSkin(id);
    post({ nd: 'stage-skin', skin: id });
    try { await Stage.patchConfig(projectId, root, { skin: id }); } catch { /* 显示器已经变脸了 */ }
  }, [projectId, root, post]);

  const changePage = useCallback((id) => { setPage(id); post({ nd: 'stage-page', page: id }); }, [post]);
  const reload = useCallback(() => setReloadKey(k => k + 1), []);

  const groups = useMemo(() => [
    {
      id: 'run',
      items: [
        {
          id: 'toggle', icon: status.running ? Square : Play, label: status.running ? '散场' : '开演', disabled: pending,
          title: status.running ? '停掉演出进程（设定和记忆都留着，再开就接上）' : '把演出进程起回来。直接在台上说一句话也会自动开',
          onClick: toggleRun,
        },
        { id: 'reload', icon: RotateCw, title: '重载显示器', onClick: reload },
      ],
    },
    { id: 'page', type: 'mode', value: page, onChange: changePage, items: PAGES.map(p => ({ id: p.id, label: p.label, title: p.label })) },
    { id: 'skin', type: 'mode', value: skin, onChange: changeSkin, items: SKINS.map(s => ({ id: s.id, label: s.label, title: `皮肤 · ${s.label}` })) },
  ], [status.running, pending, toggleRun, reload, page, changePage, skin, changeSkin]);

  const subtitle = note
    || (status.running
      ? (status.busy ? '台上正在写' : (status.queued ? `排着 ${status.queued} 句` : '台上在等你'))
      : '散场了 · 说一句就再开');

  return (
    <ArtifactWindow kind="stage" title={liveTitle || title || '演出'} subtitle={subtitle} onClose={onClose} groups={groups} onToolbarGroups={onToolbarGroups}>
      <iframe
        key={reloadKey}
        ref={iframeRef}
        title="stage"
        src={Stage.viewUrl(projectId, root)}
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
        style={{ flex: 1, minHeight: 0, width: '100%', border: 0, background: 'transparent' }}
      />
    </ArtifactWindow>
  );
}
