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
