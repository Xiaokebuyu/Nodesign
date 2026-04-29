import { Crosshair, Check, Trash2 } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { timeAgo } from '../../lib/helpers.js';

/**
 * Comments Tab — 项目内评论列表
 *
 * P2：本地 state（store 在 Project route），点击 jump 到画布定位。
 * P5：apply 走后端 simple-LLM，updates HTML。
 */
export default function CommentsTab({ comments = [], onJump, onResolve, onDelete }) {
  if (comments.length === 0) {
    return (
      <div style={{ padding: GAP.lg, textAlign: 'center' }}>
        <Crosshair size={28} color={COLOR.dim} style={{ marginBottom: GAP.md, opacity: 0.5 }} />
        <div style={{
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
          lineHeight: 1.6,
        }}>
          还没有评论。<br />
          Edit 模式点元素 → Inspect →「写评论给 AI」
        </div>
      </div>
    );
  }

  // 按 page 分组（如果 anchor 带 pageInfo）
  const grouped = {};
  comments.forEach(c => {
    const page = c.aiContext?.pageInfo?.index;
    const key = page != null ? `第 ${page + 1} 页` : '其他';
    (grouped[key] = grouped[key] || []).push(c);
  });

  return (
    <div style={{ padding: `${GAP.lg}px ${GAP.md}px` }}>
      {Object.entries(grouped).map(([group, items]) => (
        <div key={group} style={{ marginBottom: GAP.lg }}>
          <div style={{
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
            textTransform: 'uppercase', letterSpacing: '0.05em',
            padding: `0 ${GAP.sm}px ${GAP.sm}px`,
          }}>{group} · {items.length}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.sm }}>
            {items.map(c => (
              <CommentRow
                key={c.id}
                comment={c}
                onJump={() => onJump?.(c)}
                onResolve={() => onResolve?.(c.id)}
                onDelete={() => onDelete?.(c.id)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function CommentRow({ comment, onJump, onResolve, onDelete }) {
  const tag = comment.aiContext?.tag || '?';
  const role = comment.aiContext?.role || tag;
  const resolved = comment.status === 'resolved';

  return (
    <div
      style={{
        padding: `${GAP.sm + 1}px ${GAP.md}px`,
        background: resolved ? 'rgba(74,138,74,0.05)' : '#fff',
        border: `1px solid ${resolved ? 'rgba(74,138,74,0.2)' : COLOR.borderLt}`,
        borderRadius: 6,
        opacity: resolved ? 0.7 : 1,
        cursor: 'pointer',
        transition: 'all 0.15s',
      }}
      onClick={onJump}
      onMouseEnter={e => { if (!resolved) e.currentTarget.style.borderColor = COLOR.borderMd; }}
      onMouseLeave={e => { if (!resolved) e.currentTarget.style.borderColor = COLOR.borderLt; }}
    >
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        marginBottom: GAP.xs,
      }}>
        <span style={{
          fontFamily: FONT_MONO, fontSize: 10, color: COLOR.sub,
          textTransform: 'uppercase',
        }}>
          &lt;{tag}&gt; {role !== tag && `· ${role}`}
        </span>
        <span style={{ fontFamily: FONT_SANS, fontSize: 10, color: COLOR.sub }}>
          {timeAgo(comment.createdAt)}
        </span>
      </div>

      <div style={{
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2,
        lineHeight: 1.5,
        textDecoration: resolved ? 'line-through' : 'none',
      }}>
        {comment.text}
      </div>

      <div style={{
        display: 'flex', gap: GAP.xs,
        marginTop: GAP.sm,
      }}>
        <ActionBtn
          icon={<Check size={11} />}
          label={resolved ? '已解决' : '标记解决'}
          onClick={(e) => { e.stopPropagation(); onResolve(); }}
          active={resolved}
        />
        <ActionBtn
          icon={<Trash2 size={11} />}
          label="删除"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          danger
        />
      </div>
    </div>
  );
}

function ActionBtn({ icon, label, onClick, active, danger }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3,
        padding: `2px ${GAP.sm}px`,
        fontFamily: FONT_SANS, fontSize: 10,
        color: danger ? COLOR.error : (active ? COLOR.success : COLOR.text4),
        background: active ? 'rgba(74,138,74,0.1)' : 'transparent',
        border: `1px solid ${active ? 'rgba(74,138,74,0.3)' : COLOR.borderLt}`,
        borderRadius: 3,
        cursor: 'pointer',
      }}
      onMouseEnter={e => {
        if (!active) e.currentTarget.style.background = danger ? 'rgba(184,58,42,0.06)' : 'rgba(0,0,0,0.04)';
      }}
      onMouseLeave={e => {
        if (!active) e.currentTarget.style.background = 'transparent';
      }}
    >
      {icon} {label}
    </button>
  );
}
