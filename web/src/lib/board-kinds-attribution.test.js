// 标注消息里的作者判据（2026-08-26 RP 归属线）
//
// 这是 `by` 的第 6 个读者 —— 我第一遍数漏了它（数了 chalk 解析、board sanitizer、
// read_board、板书注入、前端标题与线标签），而它的错法最难看：角色写的板书会落进
// 「用户写的」那一支，**判正好相反**，主 agent 会以为那段字是用户说的。
import { describe, it, expect } from 'vitest';
import { annotTargetOf } from './board-kinds.js';

const chalkObj = (by) => ({ id: 'notes/板书/a.md', path: 'notes/板书/a.md', type: 'note', chalk: { by }, text: '夜色如墨' });

describe('annotTargetOf 带出作者', () => {
  it('角色写的板书：by 是 slug，展示名跟着带出来', () => {
    const t = annotTargetOf(chalkObj('rp-moli'), { 'rp-moli': '墨璃' });
    expect(t.by).toBe('rp-moli');
    expect(t.byName).toBe('墨璃');
  });

  it('主 agent / 用户写的照旧', () => {
    expect(annotTargetOf(chalkObj('agent')).by).toBe('agent');
    expect(annotTargetOf(chalkObj('user')).by).toBe('user');
  });

  it('⭐ 角色画的原生手写字也认得出作者（原来只认 agent）', () => {
    const t = annotTargetOf({ id: 'txt:1', type: 'text', native: true, by: 'rp-moli', data: { t: '一笔字' } }, { 'rp-moli': '墨璃' });
    expect(t.by).toBe('rp-moli');
  });

  it('展示名表没给时不炸，只是没有 byName', () => {
    const t = annotTargetOf(chalkObj('rp-moli'));
    expect(t.by).toBe('rp-moli');
    expect(t.byName).toBeUndefined();
  });

  it('摘录照旧带（用户在角色的字上回话，主 agent 要看得见那段字）', () => {
    expect(annotTargetOf(chalkObj('rp-moli')).excerpt).toBe('夜色如墨');
  });
});
