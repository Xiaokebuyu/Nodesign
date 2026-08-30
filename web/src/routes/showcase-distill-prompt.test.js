import { describe, it, expect } from 'vitest';
import { distillPrompt } from './showcase-distill-prompt.js';

/**
 * 这段话是**契约**，不是文案：用户在橱窗上点一个项目，收到它的是 agent，
 * 整条路能不能走通全看这几句写没写对。它坏起来也不出声 —— agent 会照样
 * 回一段热情的话，只是不调工具、或者按错的轴总结，而橱窗依旧是空的。
 *
 * 所以这里钉三件事：点名了那个工具、两种项目问的不是同一件事、要点没在
 * 重构中掉队。
 */
describe('回头提炼的第一句话', () => {
  it('点名 crystallize_skill —— 不点名 agent 大概率只是聊一段', () => {
    for (const mode of ['design', 'rp']) {
      expect(distillPrompt(mode)).toContain('crystallize_skill');
    }
  });

  it('设计项目问取值和排版，演出项目问调子和角色', () => {
    const design = distillPrompt('design');
    const rp = distillPrompt('rp');

    expect(design).toContain('字号阶梯');
    expect(design).toContain('产物文件');
    // ⭐ 反向也钉：演出项目收到「字号阶梯」就是把整场戏往错的轴上带
    expect(rp).not.toContain('字号阶梯');

    expect(rp).toContain('角色卡');
    expect(rp).toContain('调子怎么定的');
    expect(design).not.toContain('角色卡');
  });

  it('四个要点一个都不少，且都是列表项', () => {
    for (const mode of ['design', 'rp']) {
      const bullets = distillPrompt(mode).split('\n').filter(l => l.startsWith('- '));
      expect(bullets).toHaveLength(4);
      // 每条都得有实际内容，不能是空的短横线
      for (const b of bullets) expect(b.length).toBeGreaterThan(10);
    }
  });

  it('每一档都要求先讲要点再存，并交代边界', () => {
    for (const mode of ['design', 'rp']) {
      const p = distillPrompt(mode);
      expect(p).toContain('先讲要点给我听');
      expect(p).toContain('边界');
    }
  });

  it('mode 缺失或不认识时落设计档，不是空字符串', () => {
    const fallback = distillPrompt(undefined);
    expect(fallback).toBe(distillPrompt('design'));
    expect(distillPrompt('nonsense')).toBe(distillPrompt('design'));
  });
});
