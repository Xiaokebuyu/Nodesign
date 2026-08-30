/**
 * 窄地方的模型短名（2026-08-29 用户提「超长模型名很影响排版」）。
 *
 * 这条规则有个**一刀切就会说谎**的地方：模型表里有两行的第一段一模一样
 * （`GLM-5.3-Flash · 官方直连` 和 `GLM-5.3-Flash · Merge 网关`），
 * 它们是两条独立的线（价格、可用性、故障转移都不同）。砍成一段之后按钮会对
 * 两条线说同一句话 —— 那是把排版问题换成了一句谎。判据钉的就是这一条。
 *
 * ⚠️ 08-30 label 缩短后，撞名的那两条**不再带尾括号**了。"去括号"这条分支于是
 * 在真表里没有活样本 —— 但规则本身还在（下一个 label 随时会带括号回来），所以
 * 括号那两条测试保留，并额外留一条**合成的**撞名+括号样本盯着这条分支。
 */
import { describe, it, expect } from 'vitest';
import { __compactLabel as compactLabel } from './ModelPicker.jsx';

const OPTS = [
  { id: 'a', label: 'Sonnet 5' },
  { id: 'b', label: 'Opus 5' },
  { id: 'c', label: 'GLM-5.3-Flash · 官方直连' },
  { id: 'd', label: 'GLM-5.3-Flash · Merge 网关' },
  { id: 'e', label: 'MiniMax M3（免费）' },
  { id: 'f', label: 'DeepSeek V4 Flash · 视觉' },
  { id: 'g', label: 'Gemini 3.7 Flash（中转）' },
];
const c = (label) => compactLabel(label, OPTS);

describe('模型短名', () => {
  it('本来就短的原样不动', () => {
    expect(c('Sonnet 5')).toBe('Sonnet 5');
    expect(c('Opus 5')).toBe('Opus 5');
  });

  it('去掉尾部括号（那是卖点，不是名字）', () => {
    expect(c('MiniMax M3（免费）')).toBe('MiniMax M3');
    expect(c('Gemini 3.7 Flash（中转）')).toBe('Gemini 3.7 Flash');
  });

  it('第一段唯一就只留第一段', () => {
    expect(c('DeepSeek V4 Flash · 视觉')).toBe('DeepSeek V4 Flash');
  });

  it('⭐ 第一段撞名时留两段 —— 两条不同的线不许显示成同一句话', () => {
    expect(c('GLM-5.3-Flash · 官方直连')).toBe('GLM-5.3-Flash · 官方直连');
    expect(c('GLM-5.3-Flash · Merge 网关')).toBe('GLM-5.3-Flash · Merge 网关');
    expect(c('GLM-5.3-Flash · 官方直连')).not.toBe(c('GLM-5.3-Flash · Merge 网关'));
  });

  it('撞名的那两条**也要**去掉括号（合成样本：真表里 08-30 起没有这种 label 了）', () => {
    const opts = [{ id: 'x', label: 'X 模型 · 甲线（限时免费）' }, { id: 'y', label: 'X 模型 · 乙线' }];
    expect(compactLabel('X 模型 · 甲线（限时免费）', opts)).toBe('X 模型 · 甲线');
    expect(compactLabel('X 模型 · 甲线（限时免费）', opts)).not.toContain('（');
  });

  it('空的 / 认不出的不炸', () => {
    expect(c('')).toBe('');
    expect(compactLabel('随便什么', [])).toBe('随便什么');
    expect(compactLabel(undefined, OPTS)).toBe(undefined);
  });
});
