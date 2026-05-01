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

// ── Canvas ──
export const Canvas = {
  read: async (pid) => {
    const res = await fetch(`/api/projects/${pid}/canvas`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
    }
    return res.text();
  },
  write: (pid, html, source = 'user') =>
    jsonRequest('PUT', `/api/projects/${pid}/canvas`, { html, source }),
  history: (pid) => jsonRequest('GET', `/api/projects/${pid}/canvas/history`),
  revert: (pid, commit) => jsonRequest('POST', `/api/projects/${pid}/canvas/revert`, { commit }),
  /** 简版 undo：自动回退到上一个 commit（git checkout HEAD~1 等价） */
  undo: (pid) => jsonRequest('POST', `/api/projects/${pid}/canvas/undo`, {}),
  /** iframe src 用 */
  artifactUrl: (pid, version) =>
    `/api/projects/${pid}/canvas${version ? `?v=${encodeURIComponent(version)}` : ''}`,
};

// ── Spec（设计意图档案）──
export const Spec = {
  /** 读 spec.json（含 decisions / history）。不存在时返回 { spec: {} } */
  read: (pid) => jsonRequest('GET', `/api/projects/${pid}/spec`),
};

// ── Assets ──
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
    return res.json(); // { asset: { path, name, originalName, size, mime } }
  },
  list: (pid) => jsonRequest('GET', `/api/projects/${pid}/assets`),
};

// ── Exports ──
export const Exports = {
  /** 下载文件，返回 { blob, filename }，调用方自行触发 a.click() */
  download: async (pid, format) => {
    const res = await fetch(`/api/projects/${pid}/exports/${format}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
    }
    const blob = await res.blob();
    const filename = parseFilenameFromDisposition(res.headers.get('content-disposition'));
    return { blob, filename };
  },

  /** C31：列已生成的交付文件（agent export_handoff 等写到 workspace/exports/）*/
  list: (pid) => jsonRequest('GET', `/api/projects/${pid}/exports`),

  /** C31：下载 workspace/exports/<filename> */
  downloadFile: async (pid, filename) => {
    const res = await fetch(`/api/projects/${pid}/exports/file/${encodeURIComponent(filename)}`);
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
  /** body: { chat, attachments[], skillId? } → { runId } */
  send: ({ pid, chat, attachments = [], skillId }) =>
    jsonRequest('POST', `/api/projects/${pid}/turn`, { chat, attachments, skillId }),

  /**
   * 终止生成。后端 cancelRun → ctrl.abort('user_cancel') → SDK 中断 →
   * 触发 ctx.signal.aborted → emit run.cancelled。
   * 200 ok / 404 code='RUN_NOT_ACTIVE' (run 已结束 / 不存在)
   */
  cancel: ({ pid, runId }) =>
    jsonRequest('POST', `/api/projects/${pid}/runs/${runId}/cancel`, {}),
};

// ── Sessions（薄壳走 SDK listSessions / getSessionMessages）──
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
};

// ── Health ──
export const Health = {
  check: () => jsonRequest('GET', '/api/health'),
};
