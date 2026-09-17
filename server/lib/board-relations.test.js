/**
 * board-relations 规则钉子（2026-08-14 可维护性行动 D 刀）。
 *
 * endpointMatchesRel 是一跳邻域注入的命中判据 —— 它曾只做精确匹配，站点页
 * 文件的邻域从来没命中过根卡上的边（十一批查实）。这里把目录型收敛的口径
 * 钉死，**必须与前端 resolveObjectId 同规则**（stage-resolve.test.js 是它的
 * 镜像，两边一起改）。
 */
import { describe, it, expect } from 'vitest';
import { endpointMatchesRel, describeEndpoint } from './board-relations.js';

describe('endpointMatchesRel —— 端点命中', () => {
  it('裸路径与 kind 前缀的精确匹配', () => {
    expect(endpointMatchesRel('assets/a.png', 'assets/a.png')).toBe(true);
    expect(endpointMatchesRel('deck:主稿.html', '主稿.html')).toBe(true);
    expect(endpointMatchesRel('deck:主稿.html', '别稿.html')).toBe(false);
  });

  it('目录型收敛：站点里的文件命中根卡（十一批修的）', () => {
    expect(endpointMatchesRel('site:鉴赏页', '鉴赏页/index.html')).toBe(true);
    expect(endpointMatchesRel('site:鉴赏页', '鉴赏页/posts/a.html')).toBe(true);
    expect(endpointMatchesRel('site:观察日志', '观察日志/posts/一月.html')).toBe(true);
    expect(endpointMatchesRel('site:鉴赏页', '别处/index.html')).toBe(false);
  });

  it('根站（root=空串）收根层散文件，.md 除外，带 / 的不收', () => {
    expect(endpointMatchesRel('site:', 'index.html')).toBe(true);
    expect(endpointMatchesRel('site:', 'style.css')).toBe(true);
    expect(endpointMatchesRel('site:', '随笔.md')).toBe(false);
    expect(endpointMatchesRel('site:', 'notes/决策.md')).toBe(false);
  });

  it('deck 不做目录收敛（单文件产物只认精确匹配）', () => {
    expect(endpointMatchesRel('deck:稿件/主稿.html', '稿件/主稿.html')).toBe(true);
    expect(endpointMatchesRel('deck:稿件/主稿.html', '稿件/主稿.css')).toBe(false);
  });

  it('word 文件夹也做目录收敛（08-18 补修：收敛前缀原来写死 site，成员的边注不进邻域）', () => {
    expect(endpointMatchesRel('docx:报告', '报告/终稿v2.docx')).toBe(true);
    expect(endpointMatchesRel('docx:报告', '报告/终稿v2.json')).toBe(true);
    expect(endpointMatchesRel('docx:报告', '别处/文档.docx')).toBe(false);
  });
});

describe('describeEndpoint —— 给 agent 看的端点描述', () => {
  it('⭐ 09-17：印出来的每个端点都能原样抄回去当 id（iss_mtgcjmnf_tye4：`X（site）` 抄回 add_edge 认不出）', () => {
    expect(describeEndpoint('site:鉴赏页', {})).toBe('site:鉴赏页');
    expect(describeEndpoint('site:', {})).toBe('site:（工作区根上的site）');
    expect(describeEndpoint('docx:报告', {})).toBe('docx:报告');
  });

  it('手写字带内容摘录和 id，涂鸦带 id，裸路径原样', () => {
    const board = { objects: { 'text:t1': { kind: 'text', data: { t: '这版更暗' } }, 'scribble:s1': { kind: 'scribble' } } };
    expect(describeEndpoint('text:t1', board)).toBe('手写字「这版更暗」（text:t1）');
    expect(describeEndpoint('scribble:s1', board)).toBe('一笔涂鸦 scribble:s1（笔画内容要看得截图画布）');
    expect(describeEndpoint('assets/a.png', board)).toBe('assets/a.png');
  });

  it('给人看的出口（withId:false）保留旧措辞：根站的空 rel 有专门说法', () => {
    expect(describeEndpoint('site:', {}, { withId: false })).toBe('工作区根上的site');
    expect(describeEndpoint('site:鉴赏页', {}, { withId: false })).toBe('鉴赏页（site）');
  });

  it('⭐ 印出来的写法经锚点解析都认得回来（摘要是 agent 的输入）', async () => {
    const { makeAnchorResolver } = await import('./board-anchor.js');
    const board = { zones: {}, objects: {
      'site:鉴赏页': { x: 0, y: 0 }, 'site:': { x: 300, y: 0 },
      'text:t1': { x: 600, y: 0, kind: 'text', data: { t: '这版更暗' } },
      'scribble:s1': { x: 900, y: 0, kind: 'scribble' },
    } };
    const r = makeAnchorResolver({ projectId: 'p', known: new Set(), readBoard: async () => board, seatArtifacts: async () => ({ seated: 0, ids: {}, missing: [], skipped: [] }) });
    for (const id of Object.keys(board.objects)) {
      expect((await r(describeEndpoint(id, board), board))?.anchorId, describeEndpoint(id, board)).toBe(id);
    }
  });
});
