/**
 * mcp-server/session-transcript.js —— 诊断端点的两个读取器（2026-09-08 站主定）：
 *   session_transcript：Claude Code 的会话记录（<claudeConfigDir>/projects/<cwd 编码目录>/<sid>.jsonl），
 *                       每行压成一句（时间 / 角色 / 工具名 + 参数前 100 字 / 工具结果类型），图片与长文本不落。
 *   session_debug_log： Claude Code 的调试日志（<claudeConfigDir>/debug/<sid>.txt），API 重试的底层原因在这里。
 * 09-08 那次「GLM 连搜七次 ToolSearch 后 400」靠站主手动找 jsonl 才定案，这两个工具就是为了下次不用手找。
 */
import fs from 'node:fs';
import path from 'node:path';

const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 会话记录文件：projects/ 下所有目录里找 <sid>.jsonl（cwd 编码目录不可预测，直接扫一层） */
export function findTranscript(configDir, sid) {
  if (!configDir || !SID.test(sid)) return null;
  const root = path.join(configDir, 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(root, d, `${sid}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

export function findDebugLog(configDir, sid) {
  if (!configDir || !SID.test(sid)) return null;
  const f = path.join(configDir, 'debug', `${sid}.txt`);
  return fs.existsSync(f) ? f : null;
}

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' '); return t.length > n ? `${t.slice(0, n)}…` : t; };

/** 一行 jsonl → 一句话；不认识的类型回 null（file-history-snapshot / ai-title 这些跳过） */
export function summarizeLine(raw) {
  let r; try { r = JSON.parse(raw); } catch { return null; }
  const ts = String(r.timestamp || '').slice(11, 19);
  const m = r.message || {};
  const blocks = Array.isArray(m.content) ? m.content : (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : []);
  if (r.type === 'assistant') {
    const parts = blocks.map((b) => {
      if (b.type === 'text') return `text: ${clip(b.text, 120)}`;
      if (b.type === 'tool_use') return `tool_use ${b.name} ${clip(JSON.stringify(b.input ?? {}), 100)}`;
      if (b.type === 'thinking') return `thinking: ${clip(b.thinking, 60)}`;
      return b.type;
    });
    const usage = m.usage || {};
    return `${ts} A  ${parts.join(' | ')}  [stop=${m.stop_reason ?? '?'} out=${usage.output_tokens ?? '?'}]`;
  }
  if (r.type === 'user') {
    const parts = blocks.map((b) => {
      if (b.type === 'tool_result') {
        const c = b.content;
        const desc = Array.isArray(c)
          ? c.map((x) => (x.type === 'text' ? `text: ${clip(x.text, 80)}` : x.type === 'tool_reference' ? `tool_reference ${x.tool_name}` : x.type)).join(', ')
          : clip(c, 80);
        return `${b.is_error ? 'tool_result(ERR)' : 'tool_result'} ${desc}`;
      }
      if (b.type === 'text') return `text: ${clip(b.text, 120)}`;
      return b.type;
    });
    return `${ts} U  ${parts.join(' | ')}`;
  }
  if (r.type === 'attachment') return `${ts} attachment ${r.attachment?.type || ''}`;
  return null;
}

/** 读整份记录，压成最后 tail 句（summary=false 时回原始行） */
export function readTranscript(file, { tail = 80, summary = true } = {}) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const picked = summary ? lines.map(summarizeLine).filter(Boolean) : lines;
  return { file, totalLines: lines.length, shown: Math.min(tail, picked.length), text: picked.slice(-tail).join('\n') };
}
