/**
 * RoleTalkPanel —— 对一个角色说话的小窗（2026-08-27 建；08-29 改写）
 *
 * 点桌面上那个角色的小人打开。08-29 之前这里是**私聊**：话直投角色的收件箱，
 * 主持人全程不知情。收件箱随编排收敛退役后，去向只剩一个 —— 这句话经主持人转交
 * （原话照抄），同时落在画布上，角色回帖接得上这条线。
 *
 * 保留这扇窗而不是让用户去侧栏打字，是因为**入口的直觉**：想跟谁说话就点谁。
 * 窗里如实写着「经主持人转交」，不假装有一条私密通道。
 *
 * ## 为什么只显示"我说的"，不显示角色的回话
 *
 * 角色的输出面是画布（它写一段，小人跟着站过去）—— 回话本来就演在那儿，
 * 这里再镜像一份就是第二个真相源。
 *
 * ## 为什么 portal 到 body
 *
 * 小人住在画布的世界层（有 transform），fixed 定位在 transform 祖先下会失效。
 * 小窗是屏幕空间的东西（跟聊天栏同一层语义），portal 出去最干净。
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Assets } from '../../lib/api.js';
import { sayToRoleText, sendViaMainChat } from '../../lib/role-target.js';
import { isImeEnter } from '../../lib/helpers.js';
import { PAPER } from '../../lib/paper.js';
import { TEXT_FONT_CSS } from '../../lib/text-fonts.js';
import { t } from '../../lib/i18n.js';

/** 它此刻在干嘛（live 来自画布 presence，子代理起飞/落地驱动） */
function statusLine(live) {
  if (!live) return '';
  return live.active ? t('正在写') : t('这一段写完了');
}

export default function RoleTalkPanel({ projectId, slug, name, live = null, onClose }) {
  const [text, setText] = useState('');
  const [log, setLog] = useState([]);            // [{ text, echo }]
  const [sending, setSending] = useState(false);
  const taRef = useRef(null);
  const logRef = useRef(null);

  useEffect(() => { taRef.current?.focus(); }, [slug]);
  useEffect(() => { logRef.current?.scrollTo?.(0, 1e6); }, [log]);

  const send = async () => {
    const v = text.trim();
    if (!v || sending) return;
    setSending(true);
    let echo = null;
    try {
      // 落痕：从画布说的话留在画布上（锚在它刚写的那段旁边，主持人转交后它接得上）
      const r = await Assets.stageEcho(projectId, { text: v, ...(live?.targetId ? { anchor: live.targetId } : {}) });
      echo = r?.echo || null;
    } catch (err) {
      console.warn('[role-talk] 落痕失败（话照样递出去）:', err.message);
    }
    sendViaMainChat(sayToRoleText({ who: name || slug, slug, text: v, echo }));
    setLog((l) => [...l, { text: v, echo }]);
    setText('');
    setSending(false);
    taRef.current?.focus();
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
        <span style={{ fontSize: 12, color: PAPER.ink2, flex: 1 }}>{statusLine(live)}</span>
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
              <div style={{ fontSize: 11, color: PAPER.ink2 }}>
                {m.echo ? t('已交给主持人转告，也落在画布上了') : t('已交给主持人转告')}
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
          placeholder={t('说给{name}（经主持人转告，它的回话写在画布上）', { name: name || slug })}
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
