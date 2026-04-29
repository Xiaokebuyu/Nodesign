import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { MOCK_PROJECTS } from '../mock/projects.js';
import { newId } from '../lib/helpers.js';

/**
 * 项目 store —— localStorage 持久化（zustand persist middleware）
 *
 * 数据范围：仅 projects 列表（id / name / skill / DS / status / updatedAt / summary）
 * 不存：deckSpec / artifacts / runs / messages（这些是 P3 后端的事）
 *
 * 初次加载时 seed mock 5 个项目，之后用户操作后所有改动落 localStorage
 * key: 'nodesign:projects'
 */
export const useProjectStore = create(
  persist(
    (set, get) => ({
      projects: MOCK_PROJECTS,

      getProject: (id) => get().projects.find(p => p.id === id) || null,

      createProject: ({ name, skillId = 'deskskill-engine', designSystemId = null, brief = '', mode = 'free' }) => {
        const proj = {
          id: newId('proj'),
          name: name || '未命名项目',
          skill: skillId,
          designSystemId,
          status: 'idle',
          updatedAt: new Date().toISOString(),
          thumbnail: null,
          summary: brief ? brief.slice(0, 40) : '新项目',
          createdMode: mode,  // 'free' | 'reference'
          initialBrief: brief,
        };
        set((s) => ({ projects: [proj, ...s.projects] }));
        return proj;
      },

      updateProject: (id, patch) => {
        set((s) => ({
          projects: s.projects.map(p =>
            p.id === id ? { ...p, ...patch, updatedAt: new Date().toISOString() } : p
          ),
        }));
      },

      deleteProject: (id) => {
        set((s) => ({ projects: s.projects.filter(p => p.id !== id) }));
      },

      duplicateProject: (id) => {
        const src = get().projects.find(p => p.id === id);
        if (!src) return null;
        const copy = {
          ...src,
          id: newId('proj'),
          name: `${src.name}（副本）`,
          status: 'idle',
          updatedAt: new Date().toISOString(),
        };
        set((s) => ({ projects: [copy, ...s.projects] }));
        return copy;
      },
    }),
    {
      name: 'nodesign:projects',
      version: 1,
    }
  )
);
