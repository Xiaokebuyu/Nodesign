/**
 * web/src/lib/api.js — REST 客户端薄包装
 *
 * 走 vite proxy（dev）/ 同源（prod），所有路径以 /api 开头。
 * 失败统一抛 Error（含 status / code）。
 *
 * 模块：Projects / Skills / Canvas / Assets / Exports / Turn / Health
 */

async function jsonRequest(method, path, body, opts = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // 204 No Content
  if (res.status === 204) return null;

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(data?.error || res.statusText || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data?.code;
    throw err;
  }
  return data;
}

// ── Projects ──
export const Projects = {
  list: () => jsonRequest('GET', '/api/projects'),
  get: (pid) => jsonRequest('GET', `/api/projects/${pid}`),
  create: ({ name, skillId }) => jsonRequest('POST', '/api/projects', { name, skillId }),
  update: (pid, patch) => jsonRequest('PATCH', `/api/projects/${pid}`, patch),
  remove: (pid) => jsonRequest('DELETE', `/api/projects/${pid}`),
};

// ── Skills ──
export const Skills = {
  list: (projectId) =>
    jsonRequest('GET', `/api/skills${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
};

// ── Canvas（H3：session-scoped）──
export const Canvas = {
  read: async (pid, sid) => {
    const res = await fetch(`/api/projects/${pid}/sessions/${sid}/canvas`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
    }
    return res.text();
  },
  write: (pid, sid, html, source = 'user') =>
    jsonRequest('PUT', `/api/projects/${pid}/sessions/${sid}/canvas`, { html, source }),
  history: (pid, sid) => jsonRequest('GET', `/api/projects/${pid}/sessions/${sid}/canvas/history`),
  revert: (pid, sid, commit) =>
    jsonRequest('POST', `/api/projects/${pid}/sessions/${sid}/canvas/revert`, { commit }),
  undo: (pid, sid) => jsonRequest('POST', `/api/projects/${pid}/sessions/${sid}/canvas/undo`, {}),
  /** iframe src 用 — sid 必传 */
  artifactUrl: (pid, sid, version) =>
    `/api/projects/${pid}/sessions/${sid}/canvas${version ? `?v=${encodeURIComponent(version)}` : ''}`,
};

// ── Spec（设计意图档案，session-scoped）──
export const Spec = {
  read: (pid, sid) => jsonRequest('GET', `/api/projects/${pid}/sessions/${sid}/spec`),
};

// ── PendingChanges（C4：用户直接编辑 + 评论 buffer，session-scoped）──
// 前端 push edit / comment item，下次发 chat 时 turn.js 在 user message 前
// prepend system 提示 → agent 主动调 mcp__nodesign__get_pending_changes 拉详情。
export const PendingChanges = {
  list: (pid, sid) => jsonRequest('GET', `/api/projects/${pid}/sessions/${sid}/pending-changes`),
  push: (pid, sid, item) =>
    jsonRequest('POST', `/api/projects/${pid}/sessions/${sid}/pending-changes`, item),
  clear: (pid, sid, ids) => {
    const qs = Array.isArray(ids) && ids.length > 0 ? `?ids=${encodeURIComponent(ids.join(','))}` : '';
    return jsonRequest('DELETE', `/api/projects/${pid}/sessions/${sid}/pending-changes${qs}`);
  },
};

// ── Assets（project 共享，写到 shared/assets/）──
export const Assets = {
  upload: async (pid, file) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`/api/projects/${pid}/assets`, {
      method: 'POST',
      body: fd,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
    }
    return res.json();
  },
  list: (pid) => jsonRequest('GET', `/api/projects/${pid}/assets`),
  remove: (pid, filename) =>
    jsonRequest('DELETE', `/api/projects/${pid}/assets/${encodeURIComponent(filename)}`),
};

// ── Exports（H3：session-scoped）──
export const Exports = {
  /** 下载文件，返回 { blob, filename }，调用方自行触发 a.click() */
  download: async (pid, sid, format) => {
    const res = await fetch(`/api/projects/${pid}/sessions/${sid}/exports/${format}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
    }
    const blob = await res.blob();
    const filename = parseFilenameFromDisposition(res.headers.get('content-disposition'));
    return { blob, filename };
  },

  list: (pid, sid) => jsonRequest('GET', `/api/projects/${pid}/sessions/${sid}/exports`),

  downloadFile: async (pid, sid, filename) => {
    const res = await fetch(`/api/projects/${pid}/sessions/${sid}/exports/file/${encodeURIComponent(filename)}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
    }
    const blob = await res.blob();
    return { blob, filename };
  },
};

function parseFilenameFromDisposition(disposition) {
  if (!disposition) return null;
  const m = /filename\*=UTF-8''([^;]+)/.exec(disposition);
  if (m) return decodeURIComponent(m[1].replace(/^"|"$/g, ''));
  const m2 = /filename="([^"]+)"/.exec(disposition);
  return m2 ? m2[1] : null;
}

// ── Turn（唯一 LLM 入口）──
export const Turn = {
  /**
   * body: { chat, attachments[], skillId?, sessionId? } → { runId }
   * sessionId:
   *   - 不传 → 后端 fallback project.activeSessionId（向后兼容）
   *   - 显式 string → 续约该 session（前端切换 session 走这条）
   *   - 显式 null → 新建 session（用户点"+ 新会话"后第一次发）
   */
  send: ({ pid, chat, attachments = [], skillId, sessionId }) => {
    const body = { chat, attachments, skillId };
    if (sessionId !== undefined) body.sessionId = sessionId;
    return jsonRequest('POST', `/api/projects/${pid}/turn`, body);
  },

  /**
   * 终止生成。后端 cancelRun → ctrl.abort('user_cancel') → SDK 中断 →
   * 触发 ctx.signal.aborted → emit run.cancelled。
   * 200 ok / 404 code='RUN_NOT_ACTIVE' (run 已结束 / 不存在)
   */
  cancel: ({ pid, runId }) =>
    jsonRequest('POST', `/api/projects/${pid}/runs/${runId}/cancel`, {}),

  /**
   * A4.2：把用户在 AskUserQuestionView 卡片里点的答案回传后端。
   * 后端 provideAnswer resolve loop.js canUseTool 等待的 Promise →
   * binary 拿到 updatedInput 调 tool.call → 模型看到 "User has answered..."。
   * answers: { [questionText]: optionLabel }
   * 200 ok / 400 缺字段 / 404 code='NO_PENDING_QUESTION'
   */
  answer: ({ pid, runId, toolUseId, answers }) =>
    jsonRequest('POST', `/api/projects/${pid}/runs/${runId}/answer`, { toolUseId, answers }),
};

// ── Instruction（项目级 .claude/CLAUDE.md 读写）──
export const Instruction = {
  read: (pid) => jsonRequest('GET', `/api/projects/${pid}/instruction`),
  write: (pid, content) => jsonRequest('PUT', `/api/projects/${pid}/instruction`, { content }),
};

// ── Memory（项目级 shared/.claude/agent-memory/<agentType>/） ──
export const Memory = {
  /** 列所有 agent 的 memory 概要 */
  list: (pid) => jsonRequest('GET', `/api/projects/${pid}/memory`),
  /** 读单个 agent 全文（agentType='_root' 表示顶层 main agent memory.md） */
  read: (pid, agentType) =>
    jsonRequest('GET', `/api/projects/${pid}/memory/${encodeURIComponent(agentType)}`),
  /** 覆盖写 memory.md */
  write: (pid, agentType, content) =>
    jsonRequest('PUT', `/api/projects/${pid}/memory/${encodeURIComponent(agentType)}`, { content }),
  /** 删整个 agent memory 子目录 / 顶层 memory.md */
  remove: (pid, agentType) =>
    jsonRequest('DELETE', `/api/projects/${pid}/memory/${encodeURIComponent(agentType)}`),
};

// ── Sessions（薄壳走 SDK listSessions / getSessionMessages / forkSession / ...）──
export const Sessions = {
  /** 列项目下所有 session（按 lastModified 倒序，SDK 默认） */
  list: (pid, { limit, offset } = {}) => {
    const qs = new URLSearchParams();
    if (limit != null) qs.set('limit', String(limit));
    if (offset != null) qs.set('offset', String(offset));
    const tail = qs.toString() ? `?${qs.toString()}` : '';
    return jsonRequest('GET', `/api/projects/${pid}/sessions${tail}`);
  },
  /** 拉单个 session 的完整 messages（SDK SessionMessage[]） */
  read: (pid, sid, { includeSystem } = {}) => {
    const tail = includeSystem ? '?includeSystem=1' : '';
    return jsonRequest('GET', `/api/projects/${pid}/sessions/${sid}${tail}`);
  },
  /** Fork 出一个新 session，可指定截断点和标题 */
  fork: (pid, sid, { upToMessageId, title } = {}) =>
    jsonRequest('POST', `/api/projects/${pid}/sessions/${sid}/fork`, { upToMessageId, title }),
  /** 改标题 / 标签（patch 任一字段） */
  update: (pid, sid, patch) =>
    jsonRequest('PATCH', `/api/projects/${pid}/sessions/${sid}`, patch),
  /** 删 session JSONL（顺带清 active_session_id 如果指向它） */
  remove: (pid, sid) =>
    jsonRequest('DELETE', `/api/projects/${pid}/sessions/${sid}`),
};

// ── Health ──
export const Health = {
  check: () => jsonRequest('GET', '/api/health'),
};
