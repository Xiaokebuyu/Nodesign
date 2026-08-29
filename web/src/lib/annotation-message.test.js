// 画布标注消息的拆分（2026-08-28 用户报「侧边栏把整条机械原样显示出来」）
//
// 命门是分隔符：`<描述>：<用户的话>`，而全角冒号两边都可能有 ——
// 摘录里有（正文随便什么字），用户的话里也有。切错的代价不对称：
// 切多了会**把用户自己的话藏掉**，那比不折叠糟得多。所以认不出就返回 null 原样显示。
import { describe, it, expect } from 'vitest';
import { parseAnnotationMessage, annotationTargets } from './annotation-message.js';

const real = '【画布标注】板书「20260828-192124-第一章-放学后.md」（notes/板书/20260828-192124-第一章-放学后.md），agent 写的，原文「# 第一章 · 放学后 八月的尾巴还挂在下午五点半的天上。」；回应请 write_on_board reply_to=notes/板书/20260828-192124-第一章-放学后.md：按下怀表';

describe('拆分', () => {
  it('用户实报的那条：机械归描述，「按下怀表」归用户', () => {
    const r = parseAnnotationMessage(real);
    expect(r.text).toBe('按下怀表');
    expect(r.desc).toContain('reply_to=');
    expect(r.desc).not.toContain('按下怀表');
  });

  it('⭐ 摘录里带冒号也不许切在那儿', () => {
    const r = parseAnnotationMessage('【画布标注】板书「x.md」，原文「他说：走吧」：我的话');
    expect(r.text).toBe('我的话');
  });

  it('⭐ 用户自己的话里带冒号 → 只切第一处，后面原样留给用户', () => {
    const r = parseAnnotationMessage('【画布标注】板书「x.md」：他回答：好');
    expect(r.text).toBe('他回答：好');
  });

  it('⛔ 认不出格式就返回 null（原样显示，绝不猜着切）', () => {
    expect(parseAnnotationMessage('【画布标注】没有冒号')).toBeNull();
    expect(parseAnnotationMessage('普通消息：带冒号')).toBeNull();
    expect(parseAnnotationMessage(null)).toBeNull();
  });
});

describe('折起来那行小字', () => {
  it('板书文件名去掉时间戳和扩展名', () => {
    expect(annotationTargets(parseAnnotationMessage(real).desc)).toEqual(['板书「第一章-放学后」']);
  });

  it('多个目标各摘一个，摘录里的顿号不当分隔', () => {
    const desc = '板书「a.md」，原文「甲、乙、丙」、图片「b.png」';
    expect(annotationTargets(desc)).toEqual(['板书「a」', '图片「b.png」']);
  });

  it('认不出就空数组，调用方回落通用措辞', () => {
    expect(annotationTargets('什么都没有')).toEqual([]);
  });
});
