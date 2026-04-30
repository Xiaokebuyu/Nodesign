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

  // 拉项目列表（Home mount 时调）
  hydrate: async () => {
    if (get().hydrating) return get().projects;
    set({ hydrating: true });
    try {
      const { projects } = await Projects.list();
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

  createProject: async ({ name, skillId }) => {
    const { project } = await Projects.create({ name, skillId });
    const e = enrich(project);
    set((s) => ({ projects: [e, ...s.projects] }));
    return e;
  },

  updateProject: async (id, patch) => {
    // 本地先乐观更新（status 类瞬时字段不走 PATCH）
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));
    // 后端只接受 name / skillId
    const apiPatch = {};
    if (typeof patch.name === 'string') apiPatch.name = patch.name;
    if (typeof patch.skillId === 'string') apiPatch.skillId = patch.skillId;
    if (Object.keys(apiPatch).length === 0) return get().getProject(id);
    const { project } = await Projects.update(id, apiPatch);
    const e = enrich(project);
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, ...e } : p)),
    }));
    return e;
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
    skill: p.skillId,                  // 兼容老前端字段名（个别组件还用 .skill）
    status: 'idle',                    // WS 事件来时再 patch
    summary: p.name || '',             // Home 卡片副标占位
    snapshots: [],                     // P0 占位
    candidates: [],                    // P0 占位
    activeCandidateId: null,
  };
}
