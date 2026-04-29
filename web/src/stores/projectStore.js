import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { MOCK_PROJECTS } from '../mock/projects.js';
import { newId } from '../lib/helpers.js';

/**
 * 项目 store —— localStorage 持久化（zustand persist middleware）
 *
 * 数据范围：projects 列表（含 snapshots[] / candidates[] 元数据）
 * 不存：deckSpec / 真 HTML 工件（这些是 P3 后端的事）
 *
 * 初次加载时 seed mock 5 个项目，之后用户操作后所有改动落 localStorage
 * key: 'nodesign:projects'
 */
export const useProjectStore = create(
  persist(
    (set, get) => ({
      projects: MOCK_PROJECTS,

      getProject: (id) => get().projects.find(p => p.id === id) || null,

      createProject: ({ name, skillId = 'deskskill-engine', designSystemId = null, brief = '', briefDetails = null, mode = 'free' }) => {
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
          briefDetails,        // { goal, audience, keyMessages, stylePref } | null
          snapshots: [],
          candidates: [
            { id: 'c-default', label: '候选 A', createdAt: new Date().toISOString(), summary: brief ? brief.slice(0, 40) : '初始候选' },
          ],
          activeCandidateId: 'c-default',
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

      // ── Snapshot（轻量版本，每个 snapshot 只存 metadata，HTML 真实内容等 P3 后端落库）
      saveSnapshot: (projectId, label = '') => {
        const proj = get().projects.find(p => p.id === projectId);
        if (!proj) return null;
        const snap = {
          id: newId('snap'),
          label: label || `快照 ${(proj.snapshots?.length || 0) + 1}`,
          createdAt: new Date().toISOString(),
          candidateId: proj.activeCandidateId || null,
          summary: '当前 HTML + spec 状态（mock：实际内容 P3 后端存）',
        };
        set((s) => ({
          projects: s.projects.map(p =>
            p.id === projectId
              ? { ...p, snapshots: [snap, ...(p.snapshots || [])], updatedAt: new Date().toISOString() }
              : p
          ),
        }));
        return snap;
      },

      deleteSnapshot: (projectId, snapshotId) => {
        set((s) => ({
          projects: s.projects.map(p =>
            p.id === projectId
              ? { ...p, snapshots: (p.snapshots || []).filter(sn => sn.id !== snapshotId) }
              : p
          ),
        }));
      },

      renameSnapshot: (projectId, snapshotId, label) => {
        set((s) => ({
          projects: s.projects.map(p =>
            p.id === projectId
              ? { ...p, snapshots: (p.snapshots || []).map(sn => sn.id === snapshotId ? { ...sn, label } : sn) }
              : p
          ),
        }));
      },

      // ── Candidates（多方向探索）
      addCandidate: (projectId, label = '') => {
        const proj = get().projects.find(p => p.id === projectId);
        if (!proj) return null;
        const existing = proj.candidates || [];
        const cand = {
          id: newId('cand'),
          label: label || `候选 ${String.fromCharCode(65 + existing.length)}`,  // A/B/C/...
          createdAt: new Date().toISOString(),
          summary: '复制自当前（mock：P5 后 agent 真生成另一方向）',
        };
        set((s) => ({
          projects: s.projects.map(p =>
            p.id === projectId
              ? { ...p, candidates: [...existing, cand], activeCandidateId: cand.id, updatedAt: new Date().toISOString() }
              : p
          ),
        }));
        return cand;
      },

      removeCandidate: (projectId, candidateId) => {
        set((s) => ({
          projects: s.projects.map(p => {
            if (p.id !== projectId) return p;
            const remaining = (p.candidates || []).filter(c => c.id !== candidateId);
            const fallbackId = p.activeCandidateId === candidateId
              ? (remaining[0]?.id || null)
              : p.activeCandidateId;
            return { ...p, candidates: remaining, activeCandidateId: fallbackId };
          }),
        }));
      },

      renameCandidate: (projectId, candidateId, label) => {
        set((s) => ({
          projects: s.projects.map(p =>
            p.id === projectId
              ? { ...p, candidates: (p.candidates || []).map(c => c.id === candidateId ? { ...c, label } : c) }
              : p
          ),
        }));
      },

      selectCandidate: (projectId, candidateId) => {
        set((s) => ({
          projects: s.projects.map(p =>
            p.id === projectId ? { ...p, activeCandidateId: candidateId } : p
          ),
        }));
      },
    }),
    {
      name: 'nodesign:projects',
      version: 2,
      // version 1 → 2 迁移：旧 project 没有 snapshots / candidates 字段，加上空默认
      migrate: (persistedState, fromVersion) => {
        if (!persistedState || !persistedState.projects) return persistedState;
        if (fromVersion < 2) {
          persistedState.projects = persistedState.projects.map(p => ({
            ...p,
            snapshots: p.snapshots || [],
            candidates: p.candidates || [
              { id: 'c-default', label: '候选 A', createdAt: p.updatedAt || new Date().toISOString(), summary: '初始候选' },
            ],
            activeCandidateId: p.activeCandidateId || 'c-default',
          }));
        }
        return persistedState;
      },
    }
  )
);
