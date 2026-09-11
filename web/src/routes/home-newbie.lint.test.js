/**
 * 没有项目的新人那一屏（2026-09-12 站主报：空状态大卡和市场精选卡挤在一起）。
 *
 * 病：精选卡的网格紧跟在空状态大卡后面，网格没有上边距，钉子和「别人的」签又往上探 11px，
 * 于是整排卡压在大卡的下半截上；而且它们挂在「我的项目 · 0 个项目」底下，会被读成「这些是我的」。
 * 修法：0 个项目时精选卡上方另起一个「找找灵感」分区（跟大卡拉开 56px）。有项目之后照旧混进网格。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.readFileSync(path.join(HERE, 'Home.jsx'), 'utf8');
const CSS = fs.readFileSync(path.join(HERE, 'home-styles.js'), 'utf8');
const GATE = fs.readFileSync(path.join(HERE, '../components/AuthGate.jsx'), 'utf8');

describe('新人首页：精选卡另起一个分区', () => {
  it('「找找灵感」只在 0 个项目且有精选时出现，且排在精选网格前面', () => {
    const i = HOME.indexOf("t('找找灵感')");
    expect(i, 'Home.jsx 里找不到「找找灵感」分区').toBeGreaterThan(0);
    const before = HOME.slice(Math.max(0, i - 400), i);
    expect(before, '分区标题得挂在 projects.length === 0 && featured.length > 0 的条件下')
      .toMatch(/projects\.length === 0 && featured\.length > 0/);
    expect(HOME.indexOf('className="ndd-grid"', i), '分区标题得排在精选网格前面').toBeGreaterThan(i);
  });

  it('分区跟上面的空状态大卡拉开距离（不然又挤回去）', () => {
    const m = CSS.match(/\.ndd-head\.peer\s*\{[^}]*margin-top:\s*(\d+)px/);
    expect(m, 'home-styles.js 里 .ndd-head.peer 没有 margin-top').toBeTruthy();
    expect(Number(m[1])).toBeGreaterThanOrEqual(40);
  });
});

describe('登录页顶栏的字标', () => {
  it('桌面版里不是链接（裸 <a> 在桌面窗口里是顶层导航，会把整个应用换走）', () => {
    expect(GATE, '字标得按 desktop 分两种写法').toMatch(/desktop\s*\?\s*<span className="brand">/);
  });
});
