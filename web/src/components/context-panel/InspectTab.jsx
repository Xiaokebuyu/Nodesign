import { useState, useMemo } from 'react';
import { ChevronRight, Crosshair, MessageCircle, Edit3, RefreshCw } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import {
  getElementRole,
  describePage,
  describePosition,
  describeStyles,
  describeAdjustables,
  serializeForAI,
} from '../../lib/element-semantics.js';
import { findElementByAnchor } from '../../lib/html-utils.js';

/**
 * Inspect Tab — Design Principle §8 的人话视图
 *
 * Props:
 *   - selectedAnchor   当前选中元素的 anchor（{ dataId, path, textHint, bbox }）
 *   - iframeDoc        iframe 内文档（contentDocument），用 anchor 找回真实元素
 *   - onAddComment     行动 1：写评论让 AI 改（compact 模式跳过 — 由外层 textarea 替代）
 *   - onDirectEdit     行动 2：直接改（弹小 form）
 *   - onTriggerRun     行动 3：触发新 run（chat 模式）
 *   - compact          C3：嵌入 InspectFloatingCard 时去掉重复 header / 写评论按钮 + 缩 padding
 *
 * 内容分两层：
 *   - 人话视图（默认展开）：元素角色 + 当前样式人话 + 可调维度 + 改动范围 + 三动作
 *   - AI 上下文视图（默认折叠）：path / outerHTML / computed / siblings
 */
export default function InspectTab({ selectedAnchor, iframeDoc, onAddComment, onDirectEdit, onTriggerRun, compact = false }) {
  const [scope, setScope] = useState('this');         // this | sameType-page | sameType-deck | spec
  const [aiOpen, setAiOpen] = useState(false);

  const el = useMemo(
    () => (selectedAnchor && iframeDoc ? findElementByAnchor(selectedAnchor, iframeDoc.body) : null),
    [selectedAnchor, iframeDoc]
  );

  if (!selectedAnchor || !el) {
    return <EmptyState />;
  }

  const role = getElementRole(el);
  const page = describePage(el);
  const pos = describePosition(el);
  const styles = describeStyles(el);
  const adjustables = describeAdjustables(el);
  const aiContext = serializeForAI(el);

  const textBrief = (el.textContent || '').trim().slice(0, 80);

  return (
    <div style={{
      padding: compact ? GAP.lg : GAP.lg,
      display: 'flex', flexDirection: 'column',
      gap: compact ? GAP.md : GAP.lg,
    }}>

      {/* 1. 元素语义 — compact 模式跳过（外层 floating card header 已显示）*/}
      {!compact && (
        <Section icon={<Crosshair size={11} />} label="选中">
          <div style={{
            padding: `${GAP.md}px ${GAP.lg}px`,
            background: COLOR.bgCard,
            border: `1px solid ${COLOR.borderLt}`,
            borderRadius: 8,
          }}>
            <div style={{
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.lg, fontWeight: 500,
              color: COLOR.text, marginBottom: GAP.xs,
            }}>
              {page && page.index !== null && `第 ${page.index + 1} 页 · `}{role}
              {pos && <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginLeft: GAP.sm, fontWeight: 400 }}>
                （同页第 {pos.index} / {pos.total}）
              </span>}
            </div>
            {textBrief && (
              <div style={{
                fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2, lineHeight: 1.5,
                maxHeight: 60, overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                "{textBrief}"
              </div>
            )}
            <div style={{
              marginTop: GAP.sm,
              fontFamily: FONT_MONO, fontSize: 10, color: COLOR.dim,
            }}>
              &lt;{aiContext.tag}&gt; {page?.layout && `· layout: ${page.layout}`}
            </div>
          </div>
        </Section>
      )}

      {/* 2. 当前样式（人话）*/}
      {styles.length > 0 && (
        <Section icon={<span style={{ fontSize: 9 }}>◐</span>} label="当前样式">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {styles.map(s => (
              <div key={s.key} style={{
                display: 'flex', alignItems: 'center',
                padding: `${GAP.xs}px ${GAP.sm}px`,
                fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
              }}>
                <span style={{ color: COLOR.sub, minWidth: 56 }}>{s.label}</span>
                <span style={{ color: COLOR.text2, flex: 1, fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs }}>{s.value}</span>
                {s.swatch && (
                  <span style={{
                    width: 14, height: 14, borderRadius: 3,
                    background: s.swatch,
                    border: `1px solid ${COLOR.borderMd}`,
                    flexShrink: 0,
                  }} />
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* 3. 可调维度 */}
      {adjustables.length > 0 && (
        <Section icon={<span style={{ fontSize: 9 }}>⚙</span>} label="可调">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: GAP.xs }}>
            {adjustables.map(a => (
              <button
                key={a.key}
                onClick={() => alert(`P5 实现：调整 ${a.label}`)}
                style={{
                  padding: `${GAP.xs}px ${GAP.md}px`,
                  fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
                  color: COLOR.text2,
                  background: 'rgba(0,0,0,0.04)',
                  border: `1px solid ${COLOR.borderLt}`,
                  borderRadius: 4,
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.08)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.04)'; }}
              >
                {a.label}
              </button>
            ))}
          </div>
        </Section>
      )}

      {/* 4. 改动范围 */}
      <Section icon={<span style={{ fontSize: 9 }}>◎</span>} label="改动范围">
        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.xs }}>
          {[
            { id: 'this',           label: '仅这一处',           desc: '快速 patch，不影响其他' },
            { id: 'sameType-page',  label: '所有同类（页内）',   desc: `这页所有 ${aiContext.tag} 同步改` },
            { id: 'sameType-deck',  label: '所有同类（整 deck）', desc: '全 deck 同 tag 同步改' },
            { id: 'spec',           label: '改 spec 触发新 run', desc: '重新 round 一遍，全局重生成' },
          ].map(opt => (
            <label key={opt.id} style={{
              display: 'flex', alignItems: 'flex-start', gap: GAP.sm,
              padding: `${GAP.xs}px ${GAP.sm}px`,
              borderRadius: 4,
              cursor: 'pointer',
              background: scope === opt.id ? 'rgba(45,36,24,0.05)' : 'transparent',
            }}>
              <input
                type="radio"
                name="scope"
                checked={scope === opt.id}
                onChange={() => setScope(opt.id)}
                style={{ margin: 0, marginTop: 2, accentColor: COLOR.btn, flexShrink: 0 }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2, lineHeight: 1.3 }}>
                  {opt.label}
                </div>
                <div style={{ fontFamily: FONT_SANS, fontSize: 10, color: COLOR.sub, marginTop: 1 }}>
                  {opt.desc}
                </div>
              </div>
            </label>
          ))}
        </div>
      </Section>

      {/* 5. 三动作 — compact 模式跳过"写评论"（外层 textarea 替代）*/}
      <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.sm }}>
        {!compact && (
          <ActionBtn
            icon={<MessageCircle size={13} />}
            label="写评论给 AI"
            onClick={() => onAddComment?.({ anchor: selectedAnchor, scope, aiContext })}
            primary
          />
        )}
        <ActionBtn
          icon={<Edit3 size={13} />}
          label="直接改属性"
          onClick={() => onDirectEdit?.({ anchor: selectedAnchor, scope, aiContext })}
          primary={compact}
        />
        <ActionBtn
          icon={<RefreshCw size={13} />}
          label="触发新 run（改设计意图）"
          onClick={() => onTriggerRun?.({ anchor: selectedAnchor, scope, aiContext })}
        />
      </div>

      {/* 6. AI 上下文视图（折叠）*/}
      <div>
        <button
          onClick={() => setAiOpen(o => !o)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
            padding: `${GAP.xs}px ${GAP.sm}px`,
            borderRadius: 4,
          }}
        >
          <ChevronRight
            size={11}
            style={{ transform: aiOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}
          />
          给 AI 的上下文（机器视图）
        </button>
        {aiOpen && (
          <pre style={{
            marginTop: GAP.sm,
            padding: GAP.lg,
            background: COLOR.bgCard,
            border: `1px solid ${COLOR.borderLt}`,
            borderRadius: 6,
            fontFamily: FONT_MONO, fontSize: 10, color: COLOR.text4,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            maxHeight: 240, overflow: 'auto',
            margin: 0,
          }}>
{JSON.stringify(aiContext, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div style={{ padding: GAP.lg, textAlign: 'center', color: COLOR.sub }}>
      <Crosshair size={28} style={{ marginBottom: GAP.md, opacity: 0.5 }} />
      <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, lineHeight: 1.6 }}>
        Edit 模式下点击 canvas 内任一元素<br />查看用途、当前样式、可调维度
      </div>
    </div>
  );
}

function Section({ icon, label, children }) {
  return (
    <div>
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
        textTransform: 'uppercase', letterSpacing: '0.05em',
        marginBottom: GAP.sm, paddingLeft: GAP.xs,
      }}>
        {icon} {label}
      </div>
      {children}
    </div>
  );
}

function ActionBtn({ icon, label, onClick, primary }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: GAP.sm,
        padding: `${GAP.md}px ${GAP.lg}px`,
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 500,
        color: primary ? COLOR.btnText : COLOR.text2,
        background: primary ? COLOR.btn : 'rgba(0,0,0,0.04)',
        border: `1px solid ${primary ? COLOR.btn : COLOR.borderLt}`,
        borderRadius: 8,
        cursor: 'pointer',
        transition: 'all 0.15s',
      }}
      onMouseEnter={e => {
        if (primary) e.currentTarget.style.background = COLOR.btnHover;
        else e.currentTarget.style.background = 'rgba(0,0,0,0.07)';
      }}
      onMouseLeave={e => {
        if (primary) e.currentTarget.style.background = COLOR.btn;
        else e.currentTarget.style.background = 'rgba(0,0,0,0.04)';
      }}
    >
      {icon} {label}
    </button>
  );
}
