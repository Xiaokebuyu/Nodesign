import { useState } from 'react';
import { Link2, Check } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';

const PERMISSIONS = [
  { id: 'view',    label: '可查看',  desc: '只读，看效果' },
  { id: 'comment', label: '可评论',  desc: '可写评论但不能改设计' },
  { id: 'edit',    label: '可编辑',  desc: '完整工作台访问' },
];

export default function ShareModal({ show, onClose, project }) {
  const [perm, setPerm] = useState('view');
  const [copied, setCopied] = useState(false);
  const fakeUrl = project ? `https://nodesign.app/p/${project.id}?perm=${perm}` : '';

  const copy = () => {
    navigator.clipboard?.writeText(fakeUrl).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Modal show={show} onClose={onClose} title={`分享「${project?.name || ''}」`} width={520}>
      <div style={{ padding: GAP.xl, display: 'flex', flexDirection: 'column', gap: GAP.xl }}>

        <div>
          <Label>权限</Label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.xs }}>
            {PERMISSIONS.map(p => (
              <label key={p.id} style={{
                display: 'flex', alignItems: 'flex-start', gap: GAP.md,
                padding: `${GAP.md}px ${GAP.lg}px`,
                background: perm === p.id ? 'rgba(45,36,24,0.05)' : '#fff',
                border: `1px solid ${perm === p.id ? COLOR.btn : COLOR.borderLt}`,
                borderRadius: 8,
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}>
                <input
                  type="radio"
                  checked={perm === p.id}
                  onChange={() => setPerm(p.id)}
                  style={{ margin: 0, marginTop: 3, accentColor: COLOR.btn }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.base, color: COLOR.text, fontWeight: 500 }}>{p.label}</div>
                  <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginTop: 2 }}>{p.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div>
          <Label>分享链接</Label>
          <div style={{
            display: 'flex', gap: GAP.sm, alignItems: 'center',
            padding: `${GAP.sm + 1}px ${GAP.md}px`,
            background: COLOR.bgCard,
            border: `1px solid ${COLOR.borderLt}`,
            borderRadius: 8,
          }}>
            <Link2 size={13} color={COLOR.text4} style={{ flexShrink: 0 }} />
            <input
              readOnly
              value={fakeUrl}
              style={{
                flex: 1,
                fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text2,
                background: 'transparent', border: 'none', outline: 'none',
              }}
              onFocus={e => e.target.select()}
            />
            <button
              onClick={copy}
              style={{
                padding: `${GAP.xs + 1}px ${GAP.md + 2}px`,
                fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, fontWeight: 500,
                color: COLOR.btnText, background: COLOR.btn,
                border: `1px solid ${COLOR.btn}`,
                borderRadius: 6,
                display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
                whiteSpace: 'nowrap',
              }}
            >
              {copied ? <><Check size={11} /> 已复制</> : '复制'}
            </button>
          </div>
        </div>

        <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, lineHeight: 1.5 }}>
          ⓘ P2 阶段链接是 mock，P3 后端起来 + P6 鉴权接通后才真正可分享。
        </div>
      </div>
    </Modal>
  );
}

function Label({ children }) {
  return (
    <div style={{
      fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
      textTransform: 'uppercase', letterSpacing: '0.05em',
      marginBottom: GAP.sm,
    }}>{children}</div>
  );
}
