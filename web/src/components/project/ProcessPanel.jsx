import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Square, RotateCcw, ExternalLink, Trash2, X, Play, Eye } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO, alpha } from '../../lib/theme.js';
import { PAPER } from '../../lib/paper.js';
import { useProcessStore } from '../../stores/processStore.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { t } from '../../lib/i18n.js';
import { SHELL_Z } from '../../lib/z-layers.js';

/**
 * 进程卡（2026-09-07 桌面端·缝三）：顶栏一枚徽章 + 一张面板。
 *
 * 徽章只在两种情况出现：文件夹项目（agent 站在用户仓库里，随时会起 dev server），
 * 或者登记表里已经有记录。托管版两者都不成立，一个像素都不占。
 * 面板是观测台的第一块：谁在跑、在哪个端口、最后一行说了什么；点开看日志尾随，
 * 能停、能重开、能在系统浏览器里打开；底下一行能自己起一个命令。
 * BrowserView 共视是下一步，那时「在浏览器打开」就变成「贴到画布上」。
 */

const STATUS_COLOR = {
  running: COLOR.success || '#4F7F4A',
  exited: PAPER.pencil,
  stopped: PAPER.pencil,
  failed: COLOR.error || PAPER.red,
  lost: PAPER.pencil,
};
const STATUS_LABEL = { running: '在跑', exited: '已退出', stopped: '已停', failed: '失败', lost: '失联' };

function openUrl(url) {
  const d = typeof window !== 'undefined' ? window.nodesignDesktop : null;
  if (d?.openExternal) d.openExternal(url).catch(() => window.open(url, '_blank'));
  else window.open(url, '_blank', 'noopener');
}

/**
 * @param {object} props
 * @param {(url: string) => void} [props.onWatch] 「在画布上看」：把 dev server 的地址开进 agent 浏览器那张卡（09-08）。
 *   没给就不显示那颗按钮（网页版没有本地进程，也到不了这里）。
 */
export function ProcessesButton({ project, onWatch }) {
  const pid = project?.id;
  const bucket = useProcessStore((s) => s.byProject[pid]);
  const load = useProcessStore((s) => s.load);
  const [open, setOpen] = useState(false);
  const isFolder = !!project?.folderPath;
  useEffect(() => {
    if (!pid || !isFolder) return;
    load(pid).catch(() => {});   // 托管版没有这组接口，静默
  }, [pid, isFolder, load]);
  const list = bucket?.list || [];
  const running = list.filter((p) => p.status === 'running');
  if (!isFolder && list.length === 0) return null;
  const first = running[0];
  const label = running.length === 0
    ? t('进程')
    : running.length === 1 ? (first.port ? `:${first.port}` : t('1 个在跑')) : t('{n} 个在跑', { n: running.length });
  return (
    <div style={{ position: 'relative', alignSelf: 'center' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={t('进程：agent 或你起的 dev server / 后端')}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          font: `700 11px var(--kai, inherit)`, letterSpacing: '0.12em',
          color: running.length ? STATUS_COLOR.running : PAPER.pencil,
          border: `1px solid ${running.length ? alpha(STATUS_COLOR.running, 0.55) : PAPER.hair}`,
          background: open ? alpha(PAPER.ink, 0.06) : 'transparent',
          borderRadius: 999, padding: '2px 9px 3px', cursor: 'pointer', userSelect: 'none',
        }}
      >
        <Activity size={12} />{label}
      </button>
      {open && <ProcessPanel pid={pid} onClose={() => setOpen(false)} onWatch={onWatch} />}
    </div>
  );
}

function ProcessPanel({ pid, onClose, onWatch }) {
  const bucket = useProcessStore((s) => s.byProject[pid]);
  const { stop, restart, remove, start, fetchLog } = useProcessStore.getState();
  const showToast = useGlobalStore((s) => s.showToast);
  const [openId, setOpenId] = useState(null);
  const [cmd, setCmd] = useState('');
  const [busy, setBusy] = useState(false);
  const list = bucket?.list || [];
  const logs = bucket?.logs || {};
  const act = async (fn, okMsg) => {
    setBusy(true);
    try { await fn(); if (okMsg) showToast(okMsg, 'info'); } catch (err) { showToast(err.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div
      style={{
        position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 460, maxHeight: '70vh', zIndex: SHELL_Z.PANEL,
        display: 'flex', flexDirection: 'column',
        background: PAPER.paper, border: `1px solid ${PAPER.hair}`, borderRadius: 3,
        boxShadow: '0 12px 32px rgba(43,33,23,0.22)', fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: PAPER.ink2,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', padding: `${GAP.sm}px ${GAP.md}px`, borderBottom: `1px solid ${PAPER.hair}` }}>
        <span style={{ fontWeight: 700, letterSpacing: '0.1em' }}>{t('进程')}</span>
        <span style={{ flex: 1 }} />
        <button onClick={onClose} style={{ background: 'none', border: 0, cursor: 'pointer', color: PAPER.pencil }}><X size={14} /></button>
      </div>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {list.length === 0 && <div style={{ padding: GAP.lg, color: PAPER.pencil }}>{t('还没有进程。agent 起了 dev server 会出现在这里，你也可以在下面自己起一个。')}</div>}
        {list.map((p) => (
          <ProcessRow
            key={p.id} p={p} open={openId === p.id} lines={logs[p.id]}
            onToggle={() => { const next = openId === p.id ? null : p.id; setOpenId(next); if (next && !logs[p.id]) fetchLog(pid, p.id).catch(() => {}); }}
            busy={busy}
            onStop={() => act(() => stop(pid, p.id))}
            onRestart={() => act(() => restart(pid, p.id))}
            onRemove={() => act(() => remove(pid, p.id))}
            onWatch={onWatch}
          />
        ))}
      </div>
      <form
        onSubmit={(e) => { e.preventDefault(); if (!cmd.trim()) return; act(() => start(pid, cmd.trim()).then(() => setCmd(''))); }}
        style={{ display: 'flex', gap: GAP.sm, padding: GAP.sm, borderTop: `1px solid ${PAPER.hair}` }}
      >
        <input
          value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder={t('起一个命令，比如 npm run dev')}
          style={{ flex: 1, fontFamily: FONT_MONO || 'monospace', fontSize: FONT_SIZE.sm, padding: '5px 8px', border: `1px solid ${PAPER.hair}`, borderRadius: 2, background: 'transparent', color: PAPER.ink2 }}
        />
        <button type="submit" disabled={busy || !cmd.trim()} title={t('起')} style={{ border: `1px solid ${PAPER.hair}`, background: 'transparent', borderRadius: 2, cursor: 'pointer', padding: '0 10px', color: PAPER.ink2 }}><Play size={13} /></button>
      </form>
    </div>
  );
}

function ProcessRow({ p, open, lines, onToggle, busy, onStop, onRestart, onRemove, onWatch }) {
  const tailRef = useRef(null);
  useEffect(() => { if (open && tailRef.current) tailRef.current.scrollTop = tailRef.current.scrollHeight; }, [open, lines]);
  const color = STATUS_COLOR[p.status] || PAPER.pencil;
  const shown = useMemo(() => (lines && lines.length ? lines : (p.lastLine ? [p.lastLine] : [])), [lines, p.lastLine]);
  return (
    <div style={{ borderBottom: `1px solid ${PAPER.hair}` }}>
      <div onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: GAP.sm, padding: `${GAP.sm}px ${GAP.md}px`, cursor: 'pointer' }}>
        <span style={{ width: 8, height: 8, borderRadius: 99, background: color, flexShrink: 0 }} />
        <span style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 170 }} title={p.command}>{p.name}</span>
        <span style={{ color: PAPER.pencil, fontSize: FONT_SIZE.xs }}>{t(STATUS_LABEL[p.status] || p.status)}{p.by === 'user' ? ` · ${t('你起的')}` : ''}</span>
        <span style={{ flex: 1 }} />
        {p.url && p.status === 'running' && onWatch && (
          <button onClick={(e) => { e.stopPropagation(); onWatch(p.url); }} title={t('在画布上看：开进浏览器卡，agent 和你看同一个画面')} style={btn}><Eye size={13} /></button>
        )}
        {p.url && p.status === 'running' && (
          <button onClick={(e) => { e.stopPropagation(); openUrl(p.url); }} title={p.url} style={btn}><ExternalLink size={13} />{p.port ? `:${p.port}` : ''}</button>
        )}
        {p.status === 'running'
          ? <button disabled={busy} onClick={(e) => { e.stopPropagation(); onStop(); }} title={t('停')} style={btn}><Square size={12} /></button>
          : <>
            {p.status !== 'lost' && <button disabled={busy} onClick={(e) => { e.stopPropagation(); onRestart(); }} title={t('重开')} style={btn}><RotateCcw size={12} /></button>}
            <button disabled={busy} onClick={(e) => { e.stopPropagation(); onRemove(); }} title={t('删记录')} style={btn}><Trash2 size={12} /></button>
          </>}
      </div>
      {open && (
        <pre ref={tailRef} style={{
          margin: 0, padding: `${GAP.sm}px ${GAP.md}px`, maxHeight: 220, overflow: 'auto',
          fontFamily: FONT_MONO || 'monospace', fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          background: alpha(PAPER.ink, 0.04), color: PAPER.ink2,
        }}>
          {`$ ${p.command}\n`}{shown.join('\n') || t('（还没有输出）')}
        </pre>
      )}
    </div>
  );
}

const btn = {
  display: 'inline-flex', alignItems: 'center', gap: 3, border: 0, background: 'transparent',
  cursor: 'pointer', color: PAPER.ink2, padding: '2px 4px', fontSize: FONT_SIZE.xs, fontFamily: 'inherit',
};
