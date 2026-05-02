/**
 * 项目 store — REST 真接版（弃 zustand persist localStorage）
 *
 * projects 数组从 GET /api/projects 拉，所有 mutation 走 REST。
 *
 * - hydrate()                   列项目（Home mount）
 * - hydrateOne(id)              单读单条（Project mount）
 * - getProject(id)              本地查（同步，前提：已 hydrate）
 * - createProject(...)          POST /api/projects
 * - updateProject(id, patch)    PATCH /api/projects/:id
 * - deleteProject(id)           DELETE /api/projects/:id
 * - duplicateProject(id)        简版：新建同名+副本（P0 不深拷贝 workspace）
 * - applyRunEvent(pid, evt)     WS run.* 事件 → 本地 status patch
 *
 * Snapshots / Candidates 字段保留（前端 UI 形态依赖），但 P0 不真接：
 *   - 用 git history 取代 snapshot（C9 加 history UI）
 *   - candidate 由 agent fork_variant 主动开（P0+）
 */

import { create } from 'zustand';
import { Projects } from '../lib/api.js';

export const useProjectStore = create((set, get) => ({
  projects: [],
  hydrated: false,
  hydrating: false,
  error: null,

  // V2 持久化 context 状态（用户反馈："不要搞的动不动就丢失信息"）：
  //   - 老方案：ProjectWorkspace 用 useState — mount/unmount 重置；session 切换 reset；
  //     partial event 来时整体覆盖 → 缺字段被清掉
  //   - 新方案：keyed by pid 落 store；setSystemInfo 替换（init 一次性数据），
  //     mergeContextUsage 浅 merge（partial event 不会覆盖已有非空字段）
  //   - 不进 localStorage —— 跨刷新还是依赖 WS replay buffer + 新一轮 system_init
  /** @type {{ [pid: string]: { systemInfo?: object, contextUsage?: object } }} */
  contextByProject: {},

  setProjectSystemInfo: (pid, info) => {
    if (!pid || !info) return;
    set((s) => ({
      contextByProject: {
        ...s.contextByProject,
        [pid]: { ...(s.contextByProject[pid] || {}), systemInfo: info },
      },
    }));
  },

  /**
   * Merge contextUsage —— partial 中 null/undefined 字段不覆盖已有值。
   * eg run.context_usage 偶尔少传 messageBreakdown，旧值保留。
   */
  mergeProjectContextUsage: (pid, partial) => {
    if (!pid || !partial) return;
    set((s) => {
      const prev = s.contextByProject[pid]?.contextUsage || {};
      const merged = { ...prev };
      for (const [k, v] of Object.entries(partial)) {
        if (v != null) merged[k] = v;
      }
      return {
        contextByProject: {
          ...s.contextByProject,
          [pid]: { ...(s.contextByProject[pid] || {}), contextUsage: merged },
        },
      };
    });
  },

  getProjectContext: (pid) => get().contextByProject[pid] || {},

  // 拉项目列表（Home mount 时调）。kind 选填：传 'project' 只拉标准项目（Home 网格用）；
  // 闪聊不在此 store —— 走 Sessions.recent({ kind: 'quick' }) 拉聚合 session。
  hydrate: async ({ kind = 'project' } = {}) => {
    if (get().hydrating) return get().projects;
    set({ hydrating: true });
    try {
      const { projects } = await Projects.list({ kind });
      const enriched = projects.map(enrich);
      set({ projects: enriched, hydrated: true, hydrating: false, error: null });
      return enriched;
    } catch (err) {
      set({ hydrating: false, error: err.message });
      throw err;
    }
  },

  // 单读一条（Project mount 时调）
  hydrateOne: async (id) => {
    const { project } = await Projects.get(id);
    const e = enrich(project);
    set((s) => ({
      projects: s.projects.some((p) => p.id === id)
        ? s.projects.map((p) => (p.id === id ? e : p))
        : [e, ...s.projects],
    }));
    return e;
  },

  getProject: (id) => get().projects.find((p) => p.id === id) || null,

  createProject: async ({ name, skillId, description, kind }) => {
    const { project } = await Projects.create({ name, skillId, description, kind });
    const e = enrich(project);
    // 闪聊（kind=quick）也写入 store，方便首跑后 Workspace 能从 store 读到 project；
    // Home 网格用 hydrate({ kind:'project' }) 过滤，不会显示 quick。
    set((s) => ({ projects: [e, ...s.projects] }));
    return e;
  },

  updateProject: async (id, patch) => {
    // 本地先乐观更新（status 类瞬时字段不走 PATCH）
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));
    // 后端接受 name / skillId / description / kind
    const apiPatch = {};
    if (typeof patch.name === 'string') apiPatch.name = patch.name;
    if (typeof patch.skillId === 'string') apiPatch.skillId = patch.skillId;
    if ('description' in patch) apiPatch.description = patch.description;
    if (typeof patch.kind === 'string') apiPatch.kind = patch.kind;
    if (Object.keys(apiPatch).length === 0) return get().getProject(id);
    const { project } = await Projects.update(id, apiPatch);
    const e = enrich(project);
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, ...e } : p)),
    }));
    return e;
  },

  /**
   * 升级闪聊为标准项目（PATCH name + description + kind='project'）。
   * Workspace 顶栏「升级为项目」入口调用。升级后该项目会出现在 Home 网格。
   */
  upgradeQuickProject: async (id, { name, description }) => {
    return get().updateProject(id, { name, description, kind: 'project' });
  },

  deleteProject: async (id) => {
    await Projects.remove(id);
    set((s) => ({ projects: s.projects.filter((p) => p.id !== id) }));
  },

  /**
   * 复制项目（P0 简版：新建同名 + 副本后缀）。不深拷贝 workspace —— 新项目是空的。
   * 完整深拷贝（agent fork_variant 那种）留 P0+。
   */
  duplicateProject: async (id) => {
    const src = get().projects.find((p) => p.id === id);
    if (!src) return null;
    const { project } = await Projects.create({
      name: `${src.name}（副本）`,
      skillId: src.skillId,
    });
    const e = enrich(project);
    set((s) => ({ projects: [e, ...s.projects] }));
    return e;
  },

  /**
   * WS run 事件 → 本地 status patch。
   * 前端 status 字段：'idle' | 'generating' | 'error'
   */
  applyRunEvent: (pid, evt) => {
    if (!evt || !evt.type) return;
    const next = (() => {
      switch (evt.type) {
        case 'run.start': return 'generating';
        case 'run.done': return 'idle';
        case 'run.error': return 'error';
        case 'run.cancelled': return 'idle';
        default: return null;
      }
    })();
    if (!next) return;
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === pid ? { ...p, status: next, updatedAt: new Date().toISOString() } : p,
      ),
    }));
  },

  // ── Snapshots / Candidates 字段保留（UI 占位），P0 全为 noop ──
  // 真实现：snapshot → git commit；candidate → agent fork_variant + cp -r（P0+）
  saveSnapshot: () => null,
  deleteSnapshot: () => {},
  renameSnapshot: () => {},
  addCandidate: () => null,
  removeCandidate: () => {},
  renameCandidate: () => {},
  selectCandidate: () => {},
}));

/** 把后端 project 行补齐前端 UI 期望的字段 */
function enrich(p) {
  return {
    ...p,
    kind: p.kind || 'project',         // 后端默认 'project'，老数据兜底
    skill: p.skillId,                  // 兼容老前端字段名（个别组件还用 .skill）
    status: 'idle',                    // WS 事件来时再 patch
    summary: p.name || '',             // Home 卡片副标占位
    snapshots: [],                     // P0 占位
    candidates: [],                    // P0 占位
    activeCandidateId: null,
  };
}
