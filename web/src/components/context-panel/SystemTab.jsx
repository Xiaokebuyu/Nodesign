import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';

/**
 * System tab — 当前 skill / DS / model 显示 + spec 摘要
 *
 * spec 不可编辑（用户改 spec 必须通过 chat 触发新 run）；
 * 这里只是只读展示，让用户知道"这个 deck 在按什么思路设计"。
 */
export default function SystemTab({ project, deckSpec }) {
  return (
    <div style={{ padding: GAP.lg, display: 'flex', flexDirection: 'column', gap: GAP.xl }}>

      <Section label="Skill">
        <KV k="使用" v={project?.skill || '—'} />
        <KV k="状态" v={project?.status || 'idle'} />
      </Section>

      <Section label="设计系统">
        {project?.designSystemId ? (
          <KV k="绑定" v={project.designSystemId} />
        ) : (
          <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub }}>
            未绑定 —— 从默认主题生成
          </span>
        )}
      </Section>

      <Section label="模型">
        <KV k="LLM" v="kimi-k2.6" />
        <KV k="endpoint" v="api.moonshot.ai/anthropic" />
      </Section>

      {/* Spec 摘要 */}
      {deckSpec && (
        <Section label="设计意图（spec）">
          <KV k="metaphor" v={deckSpec.meta?.metaphor || '—'} />
          <KV k="audience" v={deckSpec.meta?.audience || '—'} />
          {deckSpec.meta?.intent && (
            <div style={{
              marginTop: GAP.sm,
              padding: GAP.md,
              background: COLOR.bgCard,
              border: `1px solid ${COLOR.borderLt}`,
              borderRadius: 6,
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
              color: COLOR.text2, lineHeight: 1.6,
            }}>
              {deckSpec.meta.intent}
            </div>
          )}

          {/* outline */}
          {deckSpec.outline && deckSpec.outline.length > 0 && (
            <>
              <div style={{
                marginTop: GAP.lg,
                fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
                textTransform: 'uppercase', letterSpacing: '0.05em',
                marginBottom: GAP.sm,
              }}>页面 outline ({deckSpec.outline.length})</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.xs }}>
                {deckSpec.outline.map(p => (
                  <div key={p.id} style={{
                    padding: `${GAP.xs + 1}px ${GAP.md}px`,
                    fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
                    background: 'rgba(0,0,0,0.025)',
                    borderRadius: 4,
                    display: 'flex', gap: GAP.sm, alignItems: 'baseline',
                  }}>
                    <span style={{ fontFamily: FONT_MONO, color: COLOR.sub, minWidth: 24 }}>{String(p.index).padStart(2, '0')}</span>
                    <span style={{ color: COLOR.text3, minWidth: 64, fontFamily: FONT_MONO, fontSize: 10, textTransform: 'uppercase' }}>{p.layout}</span>
                    <span style={{ color: COLOR.text2, flex: 1, lineHeight: 1.4 }}>{p.intent}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Section>
      )}
    </div>
  );
}

function Section({ label, children }) {
  return (
    <div>
      <div style={{
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
        textTransform: 'uppercase', letterSpacing: '0.05em',
        marginBottom: GAP.sm,
      }}>{label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.xs }}>
        {children}
      </div>
    </div>
  );
}

function KV({ k, v }) {
  return (
    <div style={{
      display: 'flex',
      gap: GAP.md,
      fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
    }}>
      <span style={{ color: COLOR.sub, minWidth: 70 }}>{k}</span>
      <span style={{ color: COLOR.text2, flex: 1, wordBreak: 'break-word' }}>{v}</span>
    </div>
  );
}
