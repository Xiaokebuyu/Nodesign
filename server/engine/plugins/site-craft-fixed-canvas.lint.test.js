/**
 * 固定画幅配方的契约（2026-09-11）。
 *
 * 起因：09-08 deck 并入站点后，SKILL.md 只写了一句「用 transform: scale() 按视口缩放」，没给骨架。
 * agent 自己写成 grid + place-items:center，画面在站点预览窗和全屏里偏到一角并被裁切
 * （实测 1100×700 窗口偏右 410px、偏下 190px；只有窗口恰好等于画幅才正常）。
 * 修法是给一份照抄的骨架（patterns/fixed-canvas.md），外层必须 flex 居中。
 * 这道 lint 钉住两件事：骨架里外层是 flex 不是 grid；SKILL.md 指路到这份骨架。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'nodesign/skills/site-craft');   // 测试文件放在技能目录外，免得跟着技能被加载
const PATTERN = fs.readFileSync(path.join(HERE, 'patterns/fixed-canvas.md'), 'utf8');
const SKILL = fs.readFileSync(path.join(HERE, 'SKILL.md'), 'utf8');
const css = (PATTERN.match(/```css\n([\s\S]*?)```/) || [])[1] || '';
const rule = (sel) => (css.match(new RegExp(`\\${sel}\\s*\\{([\\s\\S]*?)\\}`)) || [])[1] || '';

describe('固定画幅骨架', () => {
  it('⛔ .slot 外层是 flex 居中，不是 grid', () => {
    const slot = rule('.slot');
    expect(slot, 'patterns/fixed-canvas.md 里找不到 .slot 规则').not.toBe('');
    expect(slot).toMatch(/display:\s*flex/);
    expect(slot).toMatch(/justify-content:\s*center/);
    expect(slot).toMatch(/align-items:\s*center/);
    expect(slot).not.toMatch(/display:\s*grid/);
  });

  it('.artboard 不收缩、以中心缩放', () => {
    const art = rule('.artboard');
    expect(art).toMatch(/flex:\s*none/);
    expect(art).toMatch(/transform-origin:\s*center center/);
  });

  it('SKILL.md 的固定画幅一节指路到这份骨架', () => {
    expect(SKILL).toContain('patterns/fixed-canvas.md');
  });
});
