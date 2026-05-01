import { useEffect, useState, useCallback } from 'react';
import { Bookmark, History, RefreshCw } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { Spec } from '../../lib/api.js';

/**
 * DecisionsTab —— 显示 spec.json 的 decisions[] + history[]
 *
 * 数据来自 C29 GET /api/projects/:pid/spec endpoint。
 * 内容由 agent 维护：
 *   - decisions[] = MCP record_decision 工具写入（C11）
 *   - history[]   = PostCompact hook 写入摘要（C7）
 *
 * 触发刷新：mount + 手动 refresh button + run.decision_recorded /
 *           run.compact_persisted 事件（Project.jsx 通过 reloadKey 传入）
 */
export default function DecisionsTab({ projectId, sessionId, reloadKey = 0 }) {
  const [spec, setSpec] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!projectId || !sessionId) {
      setSpec({});
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await Spec.read(projectId, sessionId);
      setSpec(result?.spec || {});
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [projectId, sessionId]);

  // mount + sessionId 变 + reloadKey 变 → 重读
  useEffect(() => {
    refresh();
  }, [refresh, reloadKey]);

  const decisions = Array.isArray(spec?.decisions) ? spec.decisions : [];
  const history = Array.isArray(spec?.history) ? spec.history : [];

  return (
    <div style={{ padding: GAP.lg }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: GAP.md,
      }}>
        <div style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500,
          color: COLOR.text,
        }}>
          DECISIONS
          <span style={{ color: COLOR.sub, fontWeight: 400, marginLeft: 6 }}>
            ({decisions.length})
          </span>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          title="刷新（agent 调用 record_decision 后会自动刷新；手动按这个也行）"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: `${GAP.xs}px ${GAP.sm}px`,
            background: 'rgba(0,0,0,0.04)',
            border: 'none',
            borderRadius: 4,
            cursor: loading ? 'wait' : 'pointer',
            fontFamily: FONT_SANS, fontSize: 11,
            color: COLOR.sub,
          }}
        >
          <RefreshCw size={11} style={{
            animation: loading ? 'rcw-spin 1s linear infinite' : 'none',
          }} />
          {loading ? '...' : '刷新'}
        </button>
      </div>

      {error && (
        <div style={{
          padding: GAP.md,
          background: 'rgba(220, 53, 69, 0.06)',
          border: `1px solid ${COLOR.error}33`,
          borderRadius: 6,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
          color: COLOR.error,
          marginBottom: GAP.md,
        }}>
          读取失败：{error.message}
        </div>
      )}

      {/* Decisions list */}
      {decisions.length === 0 && !loading && (
        <div style={{
          padding: GAP.lg,
          textAlign: 'center',
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
          color: COLOR.sub,
          lineHeight: 1.6,
        }}>
          还没有决策。<br />
          agent 用 <code style={{ background: 'rgba(0,0,0,0.06)', padding: '1px 4px', borderRadius: 3 }}>
            mcp__nodesign__record_decision
          </code> 工具记录的关键设计选择会出现在这里。
        </div>
      )}

      {decisions.map((d, i) => (
        <DecisionCard key={i} decision={d} index={decisions.length - i} />
      )).reverse()}

      {/* History (compact summaries) */}
      {history.length > 0 && (
        <>
          <div style={{
            marginTop: GAP.xl,
            marginBottom: GAP.sm,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, fontWeight: 500,
            color: COLOR.sub,
            display: 'flex', alignItems: 'center', gap: 4,
            letterSpacing: '0.04em',
          }}>
            <History size={11} /> COMPACT HISTORY ({history.length})
          </div>
          {history.map((h, i) => (
            <HistoryCard key={i} entry={h} />
          )).reverse()}
        </>
      )}

      <style>{`
        @keyframes rcw-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

function DecisionCard({ decision }) {
  return (
    <div style={{
      padding: GAP.md,
      marginBottom: GAP.sm,
      border: `1px solid ${COLOR.borderLt}`,
      borderRadius: 8,
      background: '#fff',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: GAP.xs,
        marginBottom: 4,
      }}>
        <Bookmark size={11} color={COLOR.text4} />
        <div style={{
          flex: 1,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 500,
          color: COLOR.text,
          lineHeight: 1.4,
        }}>
          {decision.title || '(no title)'}
        </div>
      </div>
      <div style={{
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text4,
        lineHeight: 1.5, marginBottom: 4,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {decision.rationale}
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: GAP.sm,
        fontFamily: FONT_MONO, fontSize: 10, color: COLOR.sub,
      }}>
        {decision.scope && <span>scope: {decision.scope}</span>}
        <span>{formatTs(decision.ts)}</span>
      </div>
      {Array.isArray(decision.alternatives) && decision.alternatives.length > 0 && (
        <details style={{ marginTop: GAP.xs }}>
          <summary style={{
            fontFamily: FONT_MONO, fontSize: 10, color: COLOR.sub,
            cursor: 'pointer',
          }}>
            考虑过的替代 ({decision.alternatives.length})
          </summary>
          <ul style={{
            margin: '4px 0 0 0',
            paddingLeft: 16,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text4,
            lineHeight: 1.5,
          }}>
            {decision.alternatives.map((alt, i) => <li key={i}>{alt}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

function HistoryCard({ entry }) {
  return (
    <div style={{
      padding: GAP.md,
      marginBottom: GAP.sm,
      borderLeft: `2px solid ${COLOR.borderMd}`,
      paddingLeft: GAP.md,
    }}>
      <div style={{
        fontFamily: FONT_MONO, fontSize: 10, color: COLOR.sub,
        marginBottom: 4, letterSpacing: '0.04em',
      }}>
        {entry.source?.toUpperCase() || 'COMPACT'} · {formatTs(entry.ts)}
        {entry.trigger && entry.trigger !== 'auto' && ` · ${entry.trigger}`}
      </div>
      <div style={{
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text4,
        lineHeight: 1.5, whiteSpace: 'pre-wrap',
      }}>
        {entry.summary}
      </div>
    </div>
  );
}

function formatTs(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    return d.toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return ts;
  }
}
