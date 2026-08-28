/**
 * RoleTalkPanel —— 跟一个常驻角色的对话小窗（2026-08-27，编排·路由拍板）
 *
 * 路由规矩：**侧栏永远是主 agent 的绝对通道**；跟角色说话走这里 —— 点它的桌面精灵
 * 打开。话经 POST /roles/:slug/say 直达角色的收件箱，主 agent 全程不知情。
 *
 * ## 为什么只显示"我说的" + 投递结果，不显示角色的回话
 *
 * 角色的输出面是**板**（它写板书，精灵跟着站过去）——回话本来就演在画布上，
 * 这里再镜像一份就是第二真相源。小窗只负责：说话、如实回报送没送到
 * （'waiting' 直达 / 'queued' 排队，这条不许伪装，见 api/roles.js）、显示它此刻状态。
 *
 * ## 为什么 portal 到 body
 *
 * 精灵住在画布的世界层（有 transform），fixed 定位在 transform 祖先下会失效。
 * 小窗是屏幕空间的东西（跟聊天栏同一层语义），portal 出去最干净。
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Assets } from '../../lib/api.js';
import { nudgeGmRecall } from '../../lib/role-direct.js';
import { isImeEnter } from '../../lib/helpers.js';
import { PAPER } from '../../lib/paper.js';
import { TEXT_FONT_CSS } from '../../lib/text-fonts.js';
import { t } from '../../lib/i18n.js';

const POLL_MS = 12000;

/** 角色此刻的状态一句话（waiting/queued 来自 GET /roles，turn 来自场声明） */
function statusLine(st, turn) {
  if (turn) return t('轮到它了');
  if (!st) return '';
  if (st.waiting) return t('在等你回话');
  if (st.queued > 0) return t('不在等，{n} 条话排着队', { n: st.queued });
  return t('在写（话会进它的队列）');
}

export default function RoleTalkPanel({ projectId, slug, name, live = null, onClose }) {
  const [text, setText] = useState('');
  const [log, setLog] = useState([]);            // [{ text, delivered }]
  const [st, setSt] = useState(null);            // { waiting, queued }
  const [turn, setTurn] = useState(false);
  const [sending, setSending] = useState(false);
  const taRef = useRef(null);
  const logRef = useRef(null);

  // 状态：开窗拉一次，之后轻轮询（角色挂上/离开 await_user 不会推到这扇小窗）
  useEffect(() => {
    let alive = true;
    const pull = () => Assets.listRoles(projectId).then((r) => {
      if (!alive) return;
      const me = (r?.roles || []).find((x) => x.slug === slug);
      if (me) setSt({ waiting: !!me.waiting, queued: me.queued || 0 });
      setTurn(r?.scene?.turnSlug === slug);
    }).catch(() => { /* 状态拉不到不挡说话 */ });
    pull();
    const timer = setInterval(pull, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [projectId, slug]);

  useEffect(() => { taRef.current?.focus(); }, [slug]);
  useEffect(() => { logRef.current?.scrollTo?.(0, 1e6); }, [log]);

  const send = async () => {
    const v = text.trim();
    if (!v || sending) return;
    setSending(true);
    try {
      const r = await Assets.sayToRole(projectId, slug, { text: v });
      // 自动召回（08-28）：它真散场了（不是忙着写）——话留在收件箱，托主持人 SendMessage 去叫
      // （nudge 自带 5 分钟去抖，冷却期内不重复叫，但状态照实显示）
      if (r?.asleep) nudgeGmRecall(slug, name || slug);
      setLog((l) => [...l, { text: v, delivered: r?.asleep ? 'asleep' : (r?.delivered || 'queued') }]);
      setText('');
      setSt((s) => (r?.delivered === 'waiting' ? { waiting: false, queued: 0 } : { waiting: false, queued: r?.queueDepth ?? (s?.queued || 0) }));
    } catch (err) {
      setLog((l) => [...l, { text: v, delivered: 'error', err: err.message }]);
    } finally {
      setSending(false);
      taRef.current?.focus();
    }
  };

  const deliveredNote = (m) => {
    if (m.delivered === 'waiting') return t('已直达');
    if (m.delivered === 'asleep') return t('它已散场——话留在收件箱，已托主持人去召回');
    if (m.delivered === 'error') return t('没送出去：{err}', { err: m.err || '' });
    return t('进了队列（它现在不在等）');
  };

  return createPortal(
    <div
      style={{
        position: 'fixed', left: 16, bottom: 16, width: 300, zIndex: 60,
        background: PAPER.paper, border: `1px solid ${PAPER.hair}`,
        boxShadow: '2px 4px 14px rgba(43,33,23,0.22)',
        transform: 'rotate(-0.4deg)',
        fontFamily: TEXT_FONT_CSS.pen, color: PAPER.ink,
        display: 'flex', flexDirection: 'column',
      }}
      data-role-talk={slug}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '8px 10px 4px' }}>
        <span style={{ fontFamily: TEXT_FONT_CSS.kai, fontWeight: 700, fontSize: 15 }}>{name || slug}</span>
        {/* 在场态优先吃事件流（live 来自画布 presence，run.role.wait 驱动、近实时）；
            12s 轮询只兜 queued 数 —— 同一份状态两种新鲜度的病 08-28 收口 */}
        <span style={{ fontSize: 12, color: PAPER.ink2, flex: 1 }}>
          {statusLine(live ? { ...(st || { queued: 0 }), waiting: !live.active } : st, turn)}
        </span>
        <button
          onClick={onClose}
          title={t('收起')}
          style={{ background: 'transparent', border: 0, cursor: 'pointer', color: PAPER.ink2, padding: 2 }}
        ><X size={13} /></button>
      </div>
      {log.length > 0 && (
        <div ref={logRef} style={{ maxHeight: 180, overflowY: 'auto', padding: '0 10px', fontSize: 13 }}>
          {log.map((m, i) => (
            <div key={i} style={{ margin: '6px 0' }}>
              <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
              <div style={{ fontSize: 11, color: m.delivered === 'error' ? PAPER.red : PAPER.ink2 }}>
                {deliveredNote(m)}
              </div>
            </div>
          ))}
        </div>
      )}
      <div style={{ padding: '6px 10px 10px' }}>
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !isImeEnter(e)) { e.preventDefault(); send(); }
          }}
          placeholder={t('说给{name}（它的回话写在板上）', { name: name || slug })}
          rows={2}
          disabled={sending}
          style={{
            width: '100%', resize: 'none', fontFamily: 'inherit', fontSize: 13,
            background: 'transparent', border: 0, borderBottom: `1px solid ${PAPER.hair}`,
            outline: 'none', color: 'inherit', padding: '2px 0',
          }}
        />
      </div>
    </div>,
    document.body,
  );
}
