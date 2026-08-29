/**
 * web/src/lib/api.js — REST 客户端薄包装
 *
 * 走 vite proxy（dev）/ 同源（prod），所有路径以 /api 开头。
 * 失败统一抛 Error（含 status / code）。
 *
 * 模块：Projects / Skills / Canvas / Assets / Exports / Turn / Health
 */

export async function jsonRequest(method, path, body, opts = {}) {
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
    // 全局 401（2026-07-30 多用户）：cookie 过期/被登出后接口会散落报错，
    // 这里统一广播，AuthGate 监听后切回登录页 —— 调用方照常拿到 throw
    if (res.status === 401) {
      try { window.dispatchEvent(new Event('nd:unauthorized')); } catch { /* SSR/test 环境无 window */ }
    }
    const err = new Error(data?.error || res.statusText || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data?.code;
    throw err;
  }
  return data;
}

// ── Projects ──
export const Projects = {
  /** 列项目；kind 选填 'project' / 'quick' 过滤 */
  list: ({ kind } = {}) => {
    const tail = kind ? `?kind=${encodeURIComponent(kind)}` : '';
    return jsonRequest('GET', `/api/projects${tail}`);
  },
  get: (pid) => jsonRequest('GET', `/api/projects/${pid}`),
  /** 每个项目出了几件东西、都是什么形态（首页卡片元信息；读磁盘，跟列表分开拉） */
  stats: () => jsonRequest('GET', '/api/projects/stats'),
  /** create：name 必填；description / kind / mode 可选（kind 默认 'project'，mode 默认 'design'） */
  create: ({ name, skillId, description, kind, mode, autoNamed }) =>
    jsonRequest('POST', '/api/projects', { name, skillId, description, kind, mode, autoNamed }),
  update: (pid, patch) => jsonRequest('PATCH', `/api/projects/${pid}`, patch),
  remove: (pid) => jsonRequest('DELETE', `/api/projects/${pid}`),
};

// ── Skills ──
export const Skills = {
  list: (projectId) =>
    jsonRequest('GET', `/api/skills${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
};

// ── Me（当前用户自视图：用量 + 个人橱窗）──
export const Me = {
  usage: () => jsonRequest('GET', '/api/me/usage'),
  /** 没有会话时的可选模型清单（有会话走 Sessions.model）。带闸门的模型只对获批账号露出 */
  models: () => jsonRequest('GET', '/api/me/models'),
  /** 橱窗条目：作品 + 它沉淀出来的 skill（由 agent 的 crystallize_skill 产生） */
  showcase: () => jsonRequest('GET', '/api/me/showcase'),
  showcaseCoverUrl: (id) => `/api/me/showcase/${id}/cover`,
  removeShowcase: (id) => jsonRequest('DELETE', `/api/me/showcase/${id}`),
};


// ── Local（本地分发版专用：配置 / 钥匙 / 能力 / 体检 / 重启；hosted 下这组路由不存在）──
export const Local = {
  status: () => jsonRequest('GET', '/api/local/status'),
  config: () => jsonRequest('GET', '/api/local/config'),
  saveConfig: (raw) => jsonRequest('PUT', '/api/local/config', raw),
  env: () => jsonRequest('GET', '/api/local/env'),
  saveEnv: (values) => jsonRequest('PUT', '/api/local/env', { values }),
  probe: (id, { vision = true } = {}) => jsonRequest('POST', `/api/local/models/${encodeURIComponent(id)}/probe?vision=${vision ? 1 : 0}`),
  restart: () => jsonRequest('POST', '/api/local/restart'),
};

// ── Publish（站点一键上线 Cloudflare Pages，task 级）──
// 根站的 task 是空串（扁平化后站点住工作区根）。它的 store key 是 '.'，但 '.'
// 进不了 URL 路径段（WHATWG 把单点段归一掉，发出去就成 /publish/），所以
// 根站走**无段**路径 `/publish`，服务端按无段=根站解释（publish.js 双注册）。
const pubPath = (pid, task) => (task && task !== '.'
  ? `/api/projects/${pid}/publish/${encodeURIComponent(task)}`
  : `/api/projects/${pid}/publish`);
export const Publish = {
  get: (pid, task) => jsonRequest('GET', pubPath(pid, task)),
  // root：多站点任务点名要发哪个（'.' = 任务根）；单站点省略
  publish: (pid, task, root) => jsonRequest('POST', pubPath(pid, task),
    root != null ? { root } : undefined),
  unpublish: (pid, task) => jsonRequest('DELETE', pubPath(pid, task)),
};

// ── Canvas（2026-08-13 起项目级：会话收敛后画布/deck 归项目所有）──
export const Canvas = {
  read: async (pid) => {
    const res = await fetch(`/api/projects/${pid}/canvas`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
    }
    return res.text();
  },
  // path：任务 deck 是 tasks/<任务>/canvas.html；不传写会话自己的 canvas.html
  write: (pid, html, source = 'user', deckPath = null) =>
    jsonRequest('PUT', `/api/projects/${pid}/canvas`, { html, source, ...(deckPath ? { path: deckPath } : {}) }),
  history: (pid) => jsonRequest('GET', `/api/projects/${pid}/canvas/history`),
  revert: (pid, commit) =>
    jsonRequest('POST', `/api/projects/${pid}/canvas/revert`, { commit }),
  // Canvas.undo (git checkout 上一个 commit) 已砍 (2026-05-07) — SDK rewindFiles
  // 通过对话里"回到此处"覆盖所有场景（含历史 session resume 链路）。后端 endpoint
  // 留着不删但无前端调用。
  /** iframe src 用 */
  artifactUrl: (pid, version) =>
    `/api/projects/${pid}/canvas${version ? `?v=${encodeURIComponent(version)}` : ''}`,
  /** deck 比例信息（前端缩略图按比例设容器尺寸 + iframe size 用） */
  deckMeta: (pid, deckPath = null) =>
    jsonRequest('GET', `/api/projects/${pid}/canvas/deck-meta${deckPath ? `?path=${encodeURIComponent(deckPath)}` : ''}`),
};

// ── Spec（设计意图档案，项目级）──
export const Spec = {
  read: (pid) => jsonRequest('GET', `/api/projects/${pid}/spec`),
};

// ── SessionConfig（项目级 UI 偏好，区别于 agent 私域 spec.json；服务端落
// ui-config.json —— 名字是历史遗留，真·会话配置是 .nd/<sid>/ 里模型那份）──
// 字段：tweaks_mode_enabled
export const SessionConfig = {
  read: (pid) => jsonRequest('GET', `/api/projects/${pid}/config`),
  patch: (pid, patch) => jsonRequest('PATCH', `/api/projects/${pid}/config`, patch),
};

// 注：Image.approve / regenerate / dismiss 已删除（2026-05-06）。原配 ImageApprovalBanner
// 走 /image-approval endpoint，但 emit 即返不阻塞 agent 形同装饰。改为 generate_image
// 已返 image content block 由前端 chat 自动渲染，agent caption 邀请反馈，下一轮 chat 即 gate。

// Phase B 批次 4：MCP Elicitation —— 工具调 server.elicitInput() 时前端弹 modal 收答案
export const Elicit = {
  /** body: { action: 'accept'|'decline'|'cancel', content?: object } */
  answer: ({ pid, runId, reqId, action, content }) =>
    jsonRequest('POST', `/api/projects/${pid}/runs/${runId}/elicit/${reqId}/answer`,
      { action, content }),
};

// ── Browse（浏览器窗：刷新后拿回状态。窗是瞬态的，服务端答案也是瞬态的）──
export const Browse = {
  state: (pid) => jsonRequest('GET', `/api/projects/${pid}/browse`),
  /**
   * 用户主动进浏览器：空闲回收之后卡片还在，双击走这条把它起回上次那一页。
   * 满了会 503（这台机器常驻上限是硬的），原样往上抛，别静默转圈。
   */
  open: (pid, url) => jsonRequest('POST', `/api/projects/${pid}/browse/open`, url ? { url } : {}),
  /** 「这张卡我不看了」：关实例 + 删痕迹，卡片消失。登录态（profile）留着。 */
  end: (pid) => jsonRequest('DELETE', `/api/projects/${pid}/browse`),
};

// ── PendingChanges（C4：用户直接编辑 + 评论 buffer，项目级）──
// 前端 push edit / comment item，下次发 chat 时 turn.js 在 user message 前
// prepend system 提示 → agent 主动调 mcp__nodesign__get_pending_changes 拉详情。
export const PendingChanges = {
  list: (pid) => jsonRequest('GET', `/api/projects/${pid}/pending-changes`),
  push: (pid, item) =>
    jsonRequest('POST', `/api/projects/${pid}/pending-changes`, item),
  /**
   * 圈选评论：{ path, region, viewport, elements, text }。
   * 服务端顺手跑一次 chromium 把那块截下来，所以比别的 push 慢（一两秒）。
   */
  regionComment: (pid, payload) =>
    jsonRequest('POST', `/api/projects/${pid}/region-comment`, payload),
  clear: (pid, ids) => {
    const qs = Array.isArray(ids) && ids.length > 0 ? `?ids=${encodeURIComponent(ids.join(','))}` : '';
    return jsonRequest('DELETE', `/api/projects/${pid}/pending-changes${qs}`);
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

  // ── 工作台产物墙（2026-07-27 v1）──
  /** 产物清单（project 级：上传素材 + generated 生成图 + 便签） */
  artifacts: (pid) => jsonRequest('GET', `/api/projects/${pid}/artifacts`),
  /** 新建灵感便签 → shared/assets/notes/<ts>-<slug>.md */
  createNote: (pid, { text, title, sessionId } = {}) =>
    jsonRequest('POST', `/api/projects/${pid}/notes`, { text, title, sessionId }),
  /** 删便签 */
  removeNote: (pid, filename) =>
    jsonRequest('DELETE', `/api/projects/${pid}/notes/${encodeURIComponent(filename)}`),
  /** 板书（notes/板书/*.md，2026-08-23）：用户侧改 / 删 */
  putChalk: (pid, name, text) => jsonRequest('PUT', `/api/projects/${pid}/chalk/${encodeURIComponent(name)}`, { text }),
  // 记忆（记忆/<name>.md，08-24 记忆体系改版）：服务端保 frontmatter，MEMORY.md 索引不收
  putMemoryNote: (pid, name, text) => jsonRequest('PUT', `/api/projects/${pid}/memory-notes/${encodeURIComponent(name)}`, { text }),
  removeMemoryNote: (pid, name) => jsonRequest('DELETE', `/api/projects/${pid}/memory-notes/${encodeURIComponent(name)}`),
  removeChalk: (pid, name) => jsonRequest('DELETE', `/api/projects/${pid}/chalk/${encodeURIComponent(name)}`),
  /** 便利贴（notes/*.md，agent 和用户的共享头脑风暴层）*/
  putTaskNote: (pid, filename, text) =>
    jsonRequest('PUT', `/api/projects/${pid}/task-notes/${encodeURIComponent(filename)}`, { text }),
  removeTaskNote: (pid, filename) =>
    jsonRequest('DELETE', `/api/projects/${pid}/task-notes/${encodeURIComponent(filename)}`),
  /**
   * 删文件夹（连同里面的一切）。rel = 工作区相对路径，可以是嵌套的 `稿件/初稿`。
   * 每一段单独编码 —— 整串 encodeURIComponent 会把分隔的 '/' 也编掉，
   * 服务端的通配路由就只能收到一段。
   */
  /**
   * 把一个东西搬进另一个文件夹（**真的动磁盘**）。
   * to='' = 搬到工作区根。返回 { from, to, moved, board }，board 是改完名的新画布。
   */
  /** 新建文件夹；parent 为空 = 建在工作区根。重名自动加序号，返回真实落名 */
  createFolder: (pid, { parent = '', name } = {}) =>
    jsonRequest('POST', `/api/projects/${pid}/folders`, { parent, ...(name ? { name } : {}) }),
  /**
   * 搬家（真 `fs.rename`）。
   *
   * ⚠️ `toDir` 是**目标目录**不是新路径：`moveEntry(pid, '稿件/主稿.html', '定稿')`
   * → 落到 `定稿/主稿.html`；`''` = 工作区根。传新路径的话服务端 stat 不到目录，
   * 回 404 `target folder not found`（2026-08-13 真栽过：拖进任何文件夹都失败）。
   */
  moveEntry: (pid, from, toDir) =>
    jsonRequest('POST', `/api/projects/${pid}/move`, { from, to: toDir }),
  /**
   * 改名（真 `fs.rename`，位置不变只换最后一段）。跟 moveEntry 是一对：
   * move 换爹、rename 换名字。**扩展名不用传** —— 服务端按原文件补回去。
   */
  renameEntry: (pid, from, name) =>
    jsonRequest('POST', `/api/projects/${pid}/rename`, { from, name }),
  removeFolder: (pid, rel) =>
    jsonRequest('DELETE', `/api/projects/${pid}/folders/${String(rel).split('/').map(encodeURIComponent).join('/')}`),
  /** 画布布局（空间画布，含 zones 分区）*/
  getBoard: (pid) => jsonRequest('GET', `/api/projects/${pid}/board`),
  putBoard: (pid, board) => jsonRequest('PUT', `/api/projects/${pid}/board`, { board }),
  /** diff 合并写：{ size?, objects?: {id: obj|null}, zones?: {id: zone|null} }，null=删 */
  patchBoard: (pid, patch) => jsonRequest('PATCH', `/api/projects/${pid}/board`, { patch }),
  /**
   * 常驻角色（2026-08-26）：名册 + 直接对角色说话。
   * `say` 的返回带 `delivered`：'waiting' = 角色正挂着等，话当场交到它手里；
   * 'queued' = 它没在等，话先攒着（服务端叫不醒子代理，得等它下次自己来取）。
   * **两者必须区分着提示用户** —— 把积压说成送达，用户会对着没人听的板子说话。
   */
  // 用户从画布对角色说的话：先落在画布上（去向仍是主持人，见 lib/role-target.js）
  stageEcho: (pid, body) => jsonRequest('POST', `/api/projects/${pid}/stage/echo`, body),
  /** 黑板（2026-08-23）：用户视点上报 / 草稿落定 / 按标签整组擦 */
  reportViewpoint: (pid, viewpoint) => jsonRequest('POST', `/api/projects/${pid}/viewpoint`, { viewpoint }),
  commitBoard: (pid, tag = null) => jsonRequest('POST', `/api/projects/${pid}/board/commit`, { tag }),
  eraseBoardTag: (pid, tag) => jsonRequest('POST', `/api/projects/${pid}/board/erase`, { tag }),
  /**
   * 产物文件 URL（project 级，不依赖 session）。
   * relPath 是 artifacts 返回的 agent 视角路径，相对项目工作区根原样传递。
   */
  artifactFileUrl: (pid, relPath) => {
    const sub = String(relPath || '');
    return `/api/projects/${pid}/artifact-file/${sub.split('/').map(encodeURIComponent).join('/')}`;
  },
  /**
   * 项目封面图 URL（首页卡片缩略图）——服务端截最新产物，按源 mtime 缓存。
   * 没产物时返 204，<img> 走 onError 兜底成占位框。
   */
  coverUrl: (pid) => `/api/projects/${pid}/cover`,
  /**
   * .docx 的页图（画布缩略图 + 产物窗翻页共用）。`w` 给了就出缩宽 webp（缩略图）。
   * 服务端一次渲整份、按源 mtime 缓存 —— 翻页零成本，**别在前端预取一堆页**。
   * `v` 只用来穿透浏览器缓存，服务端不读它（ETag 已经带 mtime）。
   */
  docxPageUrl: (pid, relPath, page = 1, { w, v } = {}) => {
    const q = new URLSearchParams({ path: String(relPath || ''), page: String(page) });
    if (w) q.set('w', String(w));
    if (v) q.set('v', String(v));
    return `/api/projects/${pid}/docx-page?${q}`;
  },

  /** .docx 的整份 PDF（产物窗「PDF 视图」的 iframe）。跟页图同一份渲染缓存 */
  docxPdfUrl: (pid, relPath, { v } = {}) =>
    `/api/projects/${pid}/docx-pdf?${new URLSearchParams({ path: String(relPath || ''), ...(v ? { v: String(v) } : {}) })}`,

  /**
   * 浏览器卡上那块预览（`image/webp`，服务端存的最近一帧）。
   *
   * `at` 只用来换 src —— 响应是 `no-store`，但同一个 URL React 不会重新拉，
   * agent 翻了页之后 `at` 变了这里才换图。服务端不读这个参数。
   */
  browsePreviewUrl: (pid, at) =>
    `/api/projects/${pid}/browse/preview${at ? `?at=${encodeURIComponent(at)}` : ''}`,
};

// ── Exports ── 2026-08-19 迁去 ./api-exports.js（收 blob 不收 JSON，自成一族）
export { Exports } from './api-exports.js';

// ── Turn（唯一 LLM 入口）──
export const Turn = {
  /**
   * body: { chat, attachments[], skillId?, sessionId?, permissionMode? } → { runId }
   * sessionId:
   *   - 不传 → 后端 fallback project.activeSessionId（向后兼容）
   *   - 显式 string → 续约该 session（前端切换 session 走这条）
   *   - 显式 null → 新建 session（用户点"+ 新会话"后第一次发）
   * permissionMode：保留字段兼容，后端已忽略（plan mode 2026-08-21 整体移除，一律 platform 默认）
   */
  send: async ({ pid, chat, attachments = [], skillId, sessionId, permissionMode, requestId, raw, model }) => {
    // Phase A.6（2026-05-07）：requestId 幂等防重发。
    // 弱网下用户可能点两次发送或 fetch 超时自动重试。后端 LRU 同 requestId 直接返
    // 已存在的 { runId, sessionId } 不重复创建 session/run。
    // 调用方不传 requestId 时本地生成；显式重试时 caller 必须复用 requestId。
    const body = { chat, attachments, skillId };
    if (sessionId !== undefined) body.sessionId = sessionId;
    if (permissionMode) body.permissionMode = permissionMode;
    // 模型选择（2026-07-29）：随消息下发，服务端写 session-config 并在空闲时
    // 重启 query 生效。不传 = 跟随该会话已有配置 / 服务端默认
    if (model) body.model = model;
    if (raw === true) body.raw = true;   // 斜杠命令直达（/compact 等），跳过消息装饰
    body.requestId = requestId || (crypto?.randomUUID
      ? crypto.randomUUID()
      : `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    // 自带 1 次重试：网络抖 / 5xx 时同 requestId 重发，命中 LRU 拿到一致 runId
    try {
      return await jsonRequest('POST', `/api/projects/${pid}/turn`, body);
    } catch (err) {
      const code = err?.status;
      const retryable = !code || code >= 500 || code === 0;
      if (!retryable) throw err;
      await new Promise(r => setTimeout(r, 500));
      return jsonRequest('POST', `/api/projects/${pid}/turn`, body);
    }
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

  /**
   * SDK Query control: rewindFiles —— 把 cwd 文件回滚到指定 user message 时点。
   * 配合 enableFileCheckpointing。前端 user message 旁的 undo 按钮调这个。
   * 200 { ok:true } / 404 code='RUN_NOT_ACTIVE' / 501 code='METHOD_NOT_AVAILABLE'
   */
  rewind: ({ pid, runId, messageId }) =>
    jsonRequest('POST', `/api/projects/${pid}/runs/${runId}/rewind`, { messageId }),

};

// ── Instruction（项目级 .claude/CLAUDE.md 读写）──
export const Instruction = {
  read: (pid) => jsonRequest('GET', `/api/projects/${pid}/instruction`),
  write: (pid, content) => jsonRequest('PUT', `/api/projects/${pid}/instruction`, { content }),
};

// ── Memory（项目级 shared/.claude/agent-memory/<agentType>/） ──
// （Memory API 2026-08-24 退役：记忆住画布可见的 记忆/，服务端 /api/projects/*/memory 已拆）

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
  /** 这个会话实际跑在哪个模型上 → { model, override, default, options }。
   *  model = 生效值；override = 会话自己选过的（null 表示跟随全局默认）。 */
  model: (pid, sid) => jsonRequest('GET', `/api/projects/${pid}/sessions/${sid}/model`),
  /** 设这个会话的模型；传 null 清掉覆盖回到全局默认。服务端顺带让空闲 query 重启。 */
  setModel: (pid, sid, model) =>
    jsonRequest('PUT', `/api/projects/${pid}/sessions/${sid}/model`, { model: model ?? null }),
  /** 按需查这个 session 现在装了多少上下文（composer [+] 菜单展开时打）。
   *  query 活着就是 SDK 现问的权威值（live:true）；已经结束则是最后记住的一次；
   *  两者都没有 → null（从没跑过 turn / 服务端重启过）。 */
  contextUsage: (pid, sid) =>
    jsonRequest('GET', `/api/projects/${pid}/sessions/${sid}/context-usage`),
  /** Fork 出一个新 session，可指定截断点和标题 */
  fork: (pid, sid, { upToMessageId, title } = {}) =>
    jsonRequest('POST', `/api/projects/${pid}/sessions/${sid}/fork`, { upToMessageId, title }),
  /** 改标题 / 标签（patch 任一字段） */
  update: (pid, sid, patch) =>
    jsonRequest('PATCH', `/api/projects/${pid}/sessions/${sid}`, patch),
  /** 删 session JSONL（顺带清 active_session_id 如果指向它） */
  remove: (pid, sid) =>
    jsonRequest('DELETE', `/api/projects/${pid}/sessions/${sid}`),
  /** 关闭活跃 query session（streamInput 模式，inputQueue.close + abortController.abort）。
   *  query 进程退出，下次 turn 该 sid 起新 runSession。session JSONL 不删，jsonl 仍可 resume */
  close: (pid, sid) =>
    jsonRequest('POST', `/api/projects/${pid}/sessions/${sid}/close`),
  /**
   * 调 SDK Query.rewindFiles(userMessageId) 把所有文件回滚到 userMessageId 之前。
   * 仅 streamInput query 活着时可用 —— session 已 close 时返 410。
   * 200 → { canRewind, filesChanged?, insertions?, deletions? }
   */
  rewind: (pid, sid, userMessageId) =>
    jsonRequest('POST', `/api/projects/${pid}/sessions/${sid}/rewind`, { userMessageId }),
  /**
   * 跨项目最近 session 聚合（GET /api/sessions/recent）
   * @param {object} opts
   * @param {number} [opts.limit=20]
   * @param {'project'|'quick'} [opts.kind]
   * @returns Promise<{ sessions: Array<{ projectId, projectName, projectKind,
   *   sessionId, customTitle?, summary?, firstPrompt?, lastModified, tag? }> }>
   */
  recent: ({ limit, kind } = {}) => {
    const qs = new URLSearchParams();
    if (limit != null) qs.set('limit', String(limit));
    if (kind) qs.set('kind', kind);
    const tail = qs.toString() ? `?${qs.toString()}` : '';
    return jsonRequest('GET', `/api/sessions/recent${tail}`);
  },
};

// ── Plugins（plugin zip 上传/列表/卸载，2026-05-18）──
// 用户级与 project 级走两套 endpoint；都是 multipart `file` upload。
// 后端校验在 server/lib/plugin-validator.js，返 4xx 时 body.errors[] 含详细原因。
export const Plugins = {
  // 用户级（跨 project 全局）
  listUser: () => jsonRequest('GET', '/api/plugins'),
  installUser: async (file, { force } = {}) => {
    const fd = new FormData();
    fd.append('file', file);
    const qs = force ? '?force=true' : '';
    const res = await fetch(`/api/plugins/install${qs}`, { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw Object.assign(new Error(data.error || res.statusText), {
        status: res.status, body: data,
      });
    }
    return data;
  },
  removeUser: (name) => jsonRequest('DELETE', `/api/plugins/${encodeURIComponent(name)}`),

  // Project 级（仅当前 project）
  listProject: (pid) => jsonRequest('GET', `/api/projects/${pid}/plugins`),
  installProject: async (pid, file, { force } = {}) => {
    const fd = new FormData();
    fd.append('file', file);
    const qs = force ? '?force=true' : '';
    const res = await fetch(`/api/projects/${pid}/plugins/install${qs}`, { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw Object.assign(new Error(data.error || res.statusText), {
        status: res.status, body: data,
      });
    }
    return data;
  },
  removeProject: (pid, name) =>
    jsonRequest('DELETE', `/api/projects/${pid}/plugins/${encodeURIComponent(name)}`),
};

// ── Chatai（演出）：编排设置页的读写。演出页本身自带 fetch，不走这里 ──
export const Chatai = {
  config: (pid, dir) =>
    jsonRequest('GET', `/api/projects/${pid}/chatai/config?dir=${encodeURIComponent(dir)}`),
  saveConfig: (pid, dir, 配置, 文件) =>
    jsonRequest('PUT', `/api/projects/${pid}/chatai/config`, { dir, 配置, 文件 }),
};

// ── Health ──
export const Health = {
  check: () => jsonRequest('GET', '/api/health'),
};
