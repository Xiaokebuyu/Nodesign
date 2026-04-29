/** P2 mock 设计系统数据 */
export const MOCK_DESIGN_SYSTEMS = [
  {
    id: 'ds-acme-v3',
    name: 'ACME 品牌系统',
    version: 'v3.0',
    status: 'published',
    summary: '12 components · 8 color tokens · 4 type scale',
    tokenSwatch: ['#2D2418', '#8A6A3A', '#F9F8F6', '#B85C1A', '#4A8A4A'],
    updatedAt: '2026-04-25T10:00:00+08:00',
    source: 'codebase + brand-guidelines.pdf',
  },
  {
    id: 'ds-internal',
    name: '内部工具风格',
    version: 'v0.2',
    status: 'draft',
    summary: '6 components · 6 color tokens',
    tokenSwatch: ['#1F2937', '#6B7280', '#FFFFFF', '#3B82F6'],
    updatedAt: '2026-04-21T15:30:00+08:00',
    source: 'admin-dashboard 截图 ×8',
  },
  {
    id: 'ds-campaign-spring',
    name: '春季 campaign 风格',
    version: 'v1.0',
    status: 'published',
    summary: '4 components · 5 color tokens · 暖色调',
    tokenSwatch: ['#F4A261', '#E76F51', '#FAEDCD', '#264653', '#2A9D8F'],
    updatedAt: '2026-04-10T09:00:00+08:00',
    source: 'old-deck.pptx (2025 spring)',
  },
];

export function findMockDS(id) {
  return MOCK_DESIGN_SYSTEMS.find(d => d.id === id) || null;
}

/** P2 mock skill 数据 */
export const MOCK_SKILLS = [
  {
    id: 'deskskill-engine',
    name: 'deskskill-engine',
    version: 'v0.7.5',
    status: 'active',
    description: '4-Round 编译范式：PEER → Design → All Pages → Integrate。当前主力 skill。',
    runs: 124,
    successRate: 0.87,
    updatedAt: '2026-04-22T18:00:00+08:00',
  },
  {
    id: 'template-skill',
    name: 'template-skill',
    version: 'v0.3',
    status: 'paused',
    description: '基于现有模版填内容。风格参考路径效果不达标，反向优化中。',
    runs: 38,
    successRate: 0.42,
    updatedAt: '2026-04-12T12:00:00+08:00',
  },
  {
    id: 'ad-hoc-deck',
    name: 'ad-hoc-deck',
    version: 'v0.1',
    status: 'experimental',
    description: '实验：单 round 直出 HTML，跳过 metaphor。看会不会更快但失神韵。',
    runs: 7,
    successRate: 0.71,
    updatedAt: '2026-04-26T20:00:00+08:00',
  },
];

export function findMockSkill(id) {
  return MOCK_SKILLS.find(s => s.id === id) || null;
}
