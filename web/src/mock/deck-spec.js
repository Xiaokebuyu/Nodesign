/** P1 mock DeckSpec — 对应 mock/deck.html 的设计意图记录 */

export const MOCK_DECK_SPEC = {
  version: '0.1',
  meta: {
    title: 'Nodesign 内部介绍',
    skill: 'deskskill-engine',
    designSystemId: null,
    metaphor: '从画板到工厂的演化 —— Nodesign 是把"做 deck"从手工艺变成可复用基础设施的工作台',
    audience: '团队内部',
    intent: 'Nodesign 不是"AI 帮你做 PPT"，而是"AI + 工程师 + 设计师共同维护 deck 生成基础设施"。这份 deck 传达的核心是：从 brief 到 HTML 这条路，每一步都该被产品化、被记忆、被探索；skill 不是天花板，是被 Nodesign 反向优化的对象。',
  },
  designTokens: {
    colors: { primary: '#2d2418', accent: '#8a6a3a', bg: '#F9F8F6', text: '#3a2a18' },
    typography: {
      display: { family: "'SF Mono', 'Menlo', monospace", weight: 600 },
      body:    { family: "'PingFang SC', sans-serif", weight: 400 },
    },
    spacing: [4, 8, 12, 16, 24, 32, 48, 64],
    radius: { sm: 4, md: 8, lg: 16 },
    shadow: { card: '0 1px 4px rgba(0,0,0,0.1)' },
  },
  outline: [
    { id: 'cover',     index: 0, layout: 'cover',         intent: '建立"工作台"心智，弱化 AI 元素强调"基础设施"', keyPoints: ['Nodesign', '设计代理工作台', '云端 SaaS skill engine'], motionHint: 'fade slow', notes: '不要 emoji 不要插画' },
    { id: 'page-01',   index: 1, layout: 'title-content', intent: '陈述当前问题：deck 生成是手工艺',           keyPoints: ['每次都从零开始', '设计意图无法保留', 'skill 不能反向被优化'], motionHint: 'slide-from-left' },
    { id: 'page-02',   index: 2, layout: 'two-column',    intent: '对比传统 vs Nodesign 范式',                  keyPoints: ['左：单次手工艺 / 右：基础设施 + 复用', '左：意图丢失 / 右：spec 持久化', '左：skill 黑盒 / 右：skill 可探索'], motionHint: 'slide-up' },
    { id: 'page-03',   index: 3, layout: 'chart',         intent: '用数据说工作台带来的迭代速度变化（mock）',    keyPoints: ['首跑 ~30 min', '局部修改 ~30 s', '重设计 ~5 min'], motionHint: 'fade' },
    { id: 'thank-you', index: 4, layout: 'cover',         intent: '收尾，呼应封面，留 CTA',                     keyPoints: ['一起把 skill 反向优化起来'], motionHint: 'fade slow' },
  ],
};
