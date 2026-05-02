import { useEffect, useState, useCallback } from 'react';
import { Pencil, Sparkles, Lock } from 'lucide-react';
import Modal, { ModalFooter } from '../ui/Modal.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { Memory } from '../../lib/api.js';
import { useGlobalStore } from '../../stores/globalStore.js';

const BRAND_AGENT_TYPE = 'brand';

const TEMPLATE = `# 品牌档案

## 来源
（在 chat 里上传 PDF / 截图后让 agent 整理；或手动编辑）

## 提取结果（机器消费 — agent 进 session 时优先读这段）

\`\`\`json
{
  "palette": {
    "background": ["#FFFAF0"],
    "foreground": ["#1A1A1A"],
    "accent": ["#C83E3E"]
  },
  "typography": {
    "display": { "family": "Inter", "weight": 800, "tracking": "-0.02em" },
    "body":    { "family": "PingFang SC", "weight": 400, "size": "16/24" }
  },
  "spacing": { "rhythm": [4, 8, 16, 32, 64] },
  "layout":  { "grid": "12-col", "alignment": "left" }
}
\`\`\`

## 备注 / Don'ts（人类消费）
- 强调红是主品牌色，不要替换
- 标题不超过 12 个汉字
`;

/**
 * BrandCard — Hub 右栏「品牌档案」卡片
 *
 * 存储载体：shared/.claude/agent-memory/brand/memory.md（Memory API agentType='brand'）
 * 内容形态：markdown + 内嵌 ```json``` code block。前者人读，后者机器读。
 *
 * MVP 版只读 + 编辑 + 整理引导（占位）。真正 mcp 抽取工具下个 PR。
 */
export default function BrandCard({ projectId }) {
  const showToast = useGlobalStore(s => s.showToast);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [editOpen, setEditOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const { content: c = '' } = await Memory.read(projectId, BRAND_AGENT_TYPE);
      setContent(c);
    } catch (err) {
      console.warn('[BrandCard] read failed:', err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  const isEmpty = !content.trim();
  const tokens = !isEmpty ? extractJsonTokens(content) : null;
  const dontList = !isEmpty ? extractDonts(content) : [];

  const handleExtract = () => {
    showToast(
      '在 chat 里说：「扫 ./assets/ 抽风格 token，按品牌档案模板写到 .claude/agent-memory/brand/memory.md」',
      'info',
    );
  };

  return (
    <>
      <div style={cardStyle}>
        <div style={cardHeader}>
          <span style={cardTitle}>品牌档案</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: GAP.xs }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 3,
              padding: '1px 6px',
              background: 'rgba(45,36,24,0.05)',
              borderRadius: 4,
              fontFamily: FONT_SANS, fontSize: 10, color: COLOR.sub,
            }}>
              <Lock size={10} /> 仅你可见
            </span>
            <button
              onClick={() => setEditOpen(true)}
              disabled={loading}
              title="编辑品牌档案"
              style={iconBtnStyle}
            >
              <Pencil size={13} />
            </button>
          </div>
        </div>

        {loading && <div style={emptyHint}>加载中…</div>}

        {!loading && isEmpty && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.sm }}>
            <div style={{
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
              lineHeight: 1.55,
            }}>
              上传品牌资料（PDF / 截图）后，让 agent 帮你整理一份风格档案。
              agent 进 session 时会优先读这份档案，保证视觉风格一致。
            </div>
            <button
              onClick={handleExtract}
              style={extractBtnStyle}
            >
              <Sparkles size={11} /> 让 agent 整理
            </button>
            <button
              onClick={() => setEditOpen(true)}
              style={{
                ...extractBtnStyle,
                background: 'transparent',
                color: COLOR.text2,
                border: `1px solid ${COLOR.borderLt}`,
              }}
            >
              手动写一份
            </button>
          </div>
        )}

        {!loading && !isEmpty && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.md }}>
            {tokens?.palette && <PaletteRow palette={tokens.palette} />}
            {tokens?.typography?.display && (
              <TypographyPreview display={tokens.typography.display} />
            )}
            {dontList.length > 0 && <DontList items={dontList} />}
            {!tokens && (
              // 没解析出 JSON 但有内容 — 渲染前 200 字
              <div style={{
                fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text2,
                lineHeight: 1.55,
                display: '-webkit-box',
                WebkitLineClamp: 4,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}>
                {content.replace(/^#+ .*\n+/g, '').slice(0, 240)}
              </div>
            )}
          </div>
        )}
      </div>

      <BrandEditModal
        show={editOpen}
        onClose={() => setEditOpen(false)}
        projectId={projectId}
        initialContent={content}
        onSaved={(next) => {
          setContent(next);
          showToast('品牌档案已保存', 'success');
        }}
      />
    </>
  );
}

// ── 子组件 ──

function PaletteRow({ palette }) {
  // 把 background / foreground / accent 拍平成一排展示
  const groups = [
    { label: 'BG', colors: palette.background || [] },
    { label: 'FG', colors: palette.foreground || [] },
    { label: 'AC', colors: palette.accent || [] },
  ].filter(g => g.colors.length > 0);
  if (groups.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.xs }}>
      {groups.map((g, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: GAP.sm }}>
          <span style={{
            width: 18, fontFamily: FONT_MONO, fontSize: 9, color: COLOR.sub,
            textTransform: 'uppercase', letterSpacing: '0.05em',
          }}>{g.label}</span>
          <div style={{ display: 'flex', gap: 4, flex: 1 }}>
            {g.colors.slice(0, 6).map((c, j) => (
              <div
                key={j}
                title={c}
                style={{
                  width: 22, height: 22, borderRadius: 4,
                  background: c,
                  border: '1px solid rgba(0,0,0,0.06)',
                  flexShrink: 0,
                }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function TypographyPreview({ display }) {
  const family = display.family || 'serif';
  const weight = display.weight || 600;
  return (
    <div style={{
      padding: `${GAP.sm}px ${GAP.md}px`,
      background: COLOR.bgCard,
      borderRadius: 6,
      display: 'flex', alignItems: 'center', gap: GAP.md,
    }}>
      <span style={{
        fontFamily: family, fontWeight: weight, fontSize: 32,
        color: COLOR.text, lineHeight: 1,
        letterSpacing: display.tracking || 'normal',
      }}>Aa</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{
          fontFamily: FONT_MONO, fontSize: 11, color: COLOR.text2,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{family}</div>
        <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: COLOR.sub }}>
          weight {weight}{display.tracking ? ` · ${display.tracking}` : ''}
        </div>
      </div>
    </div>
  );
}

function DontList({ items }) {
  return (
    <ul style={{
      listStyle: 'none',
      margin: 0, padding: 0,
      display: 'flex', flexDirection: 'column', gap: 3,
    }}>
      {items.slice(0, 3).map((it, i) => (
        <li key={i} style={{
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text2,
          lineHeight: 1.45,
          paddingLeft: 12,
          position: 'relative',
        }}>
          <span style={{ position: 'absolute', left: 0, color: COLOR.sub }}>·</span>
          {it}
        </li>
      ))}
    </ul>
  );
}

// ── 编辑 Modal ──

function BrandEditModal({ show, onClose, projectId, initialContent, onSaved }) {
  const showToast = useGlobalStore(s => s.showToast);
  // initialContent 可能是空（首次写）—— 这时 draft 用 TEMPLATE 预填，方便用户起步
  const [draft, setDraft] = useState(initialContent || TEMPLATE);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (show) setDraft(initialContent || TEMPLATE);
  }, [show, initialContent]);

  // dirty：内容跟当前后端不同时可保存。首次写场景（initialContent 空 + draft 是 TEMPLATE）
  // 也算 dirty，否则用户点保存按钮无反应。
  const dirty = draft !== initialContent && draft.trim().length > 0;

  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      await Memory.write(projectId, BRAND_AGENT_TYPE, draft);
      onSaved?.(draft);
      onClose?.();
    } catch (err) {
      showToast(`保存失败：${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal show={show} onClose={onClose} title="品牌档案" width={680}>
      <div style={{ padding: `${GAP.md}px ${GAP.xl}px`, display: 'flex', flexDirection: 'column', gap: GAP.md }}>
        <div style={{
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
          lineHeight: 1.55,
        }}>
          markdown 格式。中间的 <code style={{ fontFamily: FONT_MONO, color: COLOR.text2 }}>```json</code> code block 是给
          agent 读的结构化 token；周围的备注 / Don'ts 是给团队看的。
          <span style={{ color: COLOR.dim, marginLeft: GAP.sm, fontFamily: FONT_MONO, fontSize: 10 }}>
            shared/.claude/agent-memory/brand/memory.md
          </span>
        </div>
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder=""
          style={{
            width: '100%',
            minHeight: 380,
            padding: GAP.md,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm,
            color: COLOR.text, lineHeight: 1.55,
            background: '#fff',
            border: `1px solid ${COLOR.borderMd}`,
            borderRadius: 8,
            outline: 'none',
            resize: 'vertical',
            boxSizing: 'border-box',
          }}
        />
      </div>
      <ModalFooter
        onCancel={onClose}
        onConfirm={save}
        confirmDisabled={!dirty || saving}
        confirmLabel={saving ? '保存中…' : '保存'}
      />
    </Modal>
  );
}

// ── markdown 解析 helpers ──

/**
 * 提取首个 ```json … ``` block 并 parse。失败返 null。
 */
function extractJsonTokens(md) {
  const m = md.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * 找 ## 备注 / ## Don'ts / ## Donts section 下的列表项。
 */
function extractDonts(md) {
  const re = /^##\s+(?:备注|Don'?ts?)[^\n]*\n([\s\S]*?)(?=\n##\s|$)/im;
  const m = md.match(re);
  if (!m) return [];
  return m[1]
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('-') || line.startsWith('*'))
    .map(line => line.replace(/^[-*]\s*/, ''))
    .filter(Boolean);
}

// ── styles ──

const cardStyle = {
  background: '#fff',
  border: `1px solid ${COLOR.borderLt}`,
  borderRadius: 12,
  padding: GAP.lg,
};
const cardHeader = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  gap: GAP.sm,
  marginBottom: GAP.sm,
};
const cardTitle = {
  fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500,
  color: COLOR.text,
};
const iconBtnStyle = {
  width: 24, height: 24, borderRadius: 4,
  background: 'transparent', border: 'none',
  color: COLOR.text2,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer',
};
const emptyHint = {
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
};
const extractBtnStyle = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  gap: GAP.xs,
  padding: `${GAP.sm}px ${GAP.md}px`,
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, fontWeight: 500,
  color: COLOR.btnText,
  background: COLOR.btn,
  border: `1px solid ${COLOR.btn}`,
  borderRadius: 6,
  cursor: 'pointer',
};
