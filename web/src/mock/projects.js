/** P1 mock 项目数据。P3 后端起来后由 GET /api/projects 替换 */

const DEFAULT_CANDIDATES = [
  { id: 'c-default', label: '候选 A', createdAt: '2026-04-22T10:00:00+08:00', summary: '初始候选' },
];

export const MOCK_PROJECTS = [
  {
    id: 'proj-001',
    name: 'Q3 产品发布会 deck',
    skill: 'deskskill-engine',
    designSystemId: 'ds-acme-v3',
    status: 'idle',
    updatedAt: '2026-04-28T15:30:00+08:00',
    thumbnail: null,
    summary: '12 页，metaphor: 从画板到工厂',
    snapshots: [],
    candidates: DEFAULT_CANDIDATES,
    activeCandidateId: 'c-default',
  },
  {
    id: 'proj-002',
    name: 'Nodesign 内部介绍',
    skill: 'deskskill-engine',
    designSystemId: null,
    status: 'idle',
    updatedAt: '2026-04-28T11:20:00+08:00',
    thumbnail: null,
    summary: '5 页 demo',
    snapshots: [],
    candidates: DEFAULT_CANDIDATES,
    activeCandidateId: 'c-default',
  },
  {
    id: 'proj-003',
    name: '团队 Q2 复盘',
    skill: 'deskskill-engine',
    designSystemId: 'ds-acme-v3',
    status: 'running',
    updatedAt: '2026-04-29T09:00:00+08:00',
    thumbnail: null,
    summary: '运行中…Round 2 / 8 页',
    snapshots: [],
    candidates: DEFAULT_CANDIDATES,
    activeCandidateId: 'c-default',
  },
  {
    id: 'proj-004',
    name: '招聘宣讲（草稿）',
    skill: 'deskskill-engine',
    designSystemId: null,
    status: 'idle',
    updatedAt: '2026-04-25T18:45:00+08:00',
    thumbnail: null,
    summary: '草稿',
    snapshots: [],
    candidates: DEFAULT_CANDIDATES,
    activeCandidateId: 'c-default',
  },
  {
    id: 'proj-005',
    name: '客户提案 — 风格参考',
    skill: 'deskskill-engine',
    designSystemId: 'ds-acme-v3',
    status: 'failed',
    updatedAt: '2026-04-22T22:10:00+08:00',
    thumbnail: null,
    summary: 'R3 装配失败',
    snapshots: [],
    candidates: DEFAULT_CANDIDATES,
    activeCandidateId: 'c-default',
  },
];

export function findMockProject(id) {
  return MOCK_PROJECTS.find(p => p.id === id) || null;
}
