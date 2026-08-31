/**
 * 手机版版面的硬约束（2026-08-31 移动端第三轮）。
 *
 * 这一轮修的三件事有一个共同点：**它们都不会在开发者自己的屏幕上出现**，
 * 所以注释拦不住任何人，只能钉成判据。
 *
 * ## ① grid 轨道的自动下限（首页项目卡「比视口还宽」）
 *
 * 用户报「新账号的纯文字卡宽度正好，我这个 admin 账号的卡片比手机视口宽一点」。
 * 真因跟账号、跟卡里装的是站点还是文字**都没有关系**：
 *
 *     .ndd-grid 窄屏写的是 grid-template-columns: 1fr
 *     而 `1fr` === `minmax(auto, 1fr)`，那个 auto 下限 = 格子里内容的 min-content
 *     .ndd-card .t（项目名）是 white-space: nowrap 的 → 它的 min-content = 整行标题宽
 *     → 一个长项目名把**整条轨道**撑到 434.75px，同一列 43 张卡张张跟着变宽
 *
 * 实测（iPhone 13 / 视口 390 / 板面留给内容 366）：轨道 434.75，每张卡溢出 57px。
 * 新账号看不见这个病，只因为它还没有长到 24 个字的项目名 —— 换句话说，
 * **这个 bug 会随着用户用得越久越明显**。
 *
 * 同一个形状的第二种写法是把下限写死成 px：容器比那个数还窄时照样顶出去
 * （橱窗页 minmax(300px, 1fr) 在 360 的屏上溢出 20px）。
 *
 * ## ② 共用的东西要连断点一起共用
 *
 * 08-30 台面（.ndd）搬进 desk.jsx 给橱窗 / Skill 页共用，但**窄屏那份留白
 * 留在了 home-styles.js 的 @media 里**。于是首页手机上是 12px 边距，另外两页
 * 仍吃桌面那份 40px，再叠上它们自己的 GAP.page(40)，360 的屏上正文只剩 200px。
 *
 * ## ③ 顶栏动作带字 = 面包屑被压成一个残字
 *
 * 顶栏上字标和动作区都写着 flexShrink: 0，中间那根撑杆是 flex:1（basis 0，
 * 没有可缩的量）—— 所以**面包屑是唯一能缩的东西**，动作区宽出来多少，
 * 全部由它一个人承担。实测 360 屏上 /skills 和 /gallery 的面包屑被压到 **16px**，
 * 而整条还溢出 76px。判据钉在动作那一侧：窄屏一律只留图标。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSS } from './home-styles.js';
import { DESK_CSS } from './desk.jsx';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, rel), 'utf8');
/** 判据读的必须是真生效的声明，不是解释它的文字（同 home-surface.lint 的那一课） */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

const CODE = strip(CSS);

/**
 * 这份 CSS 里 .ndd-grid 恰好出现两次：铺开那条（多列，带 repeat(auto-fill)）
 * 和窄屏那条（单列）。⚠️ 不能靠「@media 之前 / 之后」切 —— DESK_CSS 自己
 * 也带了一个 640 断点，且它拼在最前面，按 indexOf 切会把两条都切到同一侧。
 */
const GRID_RULES = [...CODE.matchAll(/\.ndd-grid\s*\{([^}]*)\}/g)].map(m => m[1]);
const WIDE_GRID = GRID_RULES.find(r => /repeat\(auto-fill/.test(r));
const NARROW_GRID = GRID_RULES.find(r => !/repeat\(auto-fill/.test(r));

describe('grid 轨道不许让内容自己决定下限', () => {
  it('这份 CSS 里就该有铺开和窄屏两条 .ndd-grid（判据自己先站稳）', () => {
    expect(GRID_RULES.length).toBe(2);
    expect(WIDE_GRID).toBeTruthy();
    expect(NARROW_GRID).toBeTruthy();
  });

  it('⛔ 窄屏那条必须写 minmax(0, 1fr) —— 裸 1fr 就是 minmax(auto, 1fr)', () => {
    expect(NARROW_GRID).toMatch(/grid-template-columns:\s*minmax\(\s*0\s*,\s*1fr\s*\)/);
    expect(NARROW_GRID, '裸 1fr 会让最长的项目名把整列撑爆（实测 366 → 434.75）')
      .not.toMatch(/grid-template-columns:\s*1fr\s*;/);
  });

  it('⛔ 宽屏那条的下限要包在 min(…, 100%) 里 —— 容器比它窄时才不会顶出去', () => {
    expect(WIDE_GRID).toMatch(/minmax\(\s*min\(\s*300px\s*,\s*100%\s*\)/);
  });

  it('卡自己也不许保留 min-width: auto（轨道封住了，格子里的东西还能顶出去）', () => {
    const rule = /\.ndd-card\s*\{([^}]*)\}/.exec(CODE)?.[1];
    expect(rule).toBeTruthy();
    expect(rule).toMatch(/min-width:\s*0/);
  });

  it('橱窗页的作品网格同病同治（写死 300px 在 360 屏上溢出 20px）', () => {
    const src = strip(read('Showcase.jsx'));
    expect(src).toMatch(/minmax\(min\(300px, 100%\), 1fr\)/);
    expect(src, '写死的下限一个都不许剩').not.toMatch(/minmax\(300px,/);
  });
});

describe('台面的窄屏留白只有一份，且住在共用的那一份里', () => {
  it('desk.jsx 自己带着 640 断点（橱窗 / Skill 页什么都不传也要拿到）', () => {
    const desk = strip(DESK_CSS);
    const media = desk.slice(desk.indexOf('@media (max-width: 640px)'));
    expect(media, 'DESK_CSS 里没有窄屏断点').toContain('@media');
    expect(/\.ndd\s*\{([^}]*)\}/.exec(media)?.[1]).toMatch(/padding:/);
  });

  it('⛔ 首页那份 CSS 里 .ndd 的窄屏留白不许再写第二遍', () => {
    const hits = CODE.match(/@media[^{]*\{\s*\.ndd\s*\{[^}]*padding/g) || [];
    expect(hits.length, `两处同名规则迟早只改一处（现在有 ${hits.length} 处）`).toBe(1);
  });
});

describe('顶栏动作在窄屏上一律只留图标', () => {
  /** 顶栏上挂过 DayToggle 的三页 */
  const PAGES = ['Home.jsx', 'Showcase.jsx', 'SkillList.jsx'];

  it('每处 <DayToggle> 都传了 compact —— 不传就是常驻四个汉字', () => {
    for (const f of PAGES) {
      const src = strip(read(f));
      const tags = src.match(/<DayToggle[^>]*\/>/g) || [];
      expect(tags.length, `${f} 里没有 DayToggle 了？`).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(tag, `${f}: ${tag} —— 「跟着时间」四个字在顶栏上占 98px`).toMatch(/compact=/);
      }
    }
  });

  it('三页都真的问过窄不窄（顶栏是内联样式，media query 够不着它）', () => {
    for (const f of PAGES) {
      const src = strip(read(f));
      expect(src, `${f} 没有引 NARROW 判据`).toMatch(/useMedia\(NARROW\)/);
    }
  });

  it('橱窗和 Skill 页那两颗带字动作都挂着 narrow 判据', () => {
    expect(strip(read('Showcase.jsx')), '「Skill 管理」的字要按 narrow 收')
      .toMatch(/narrow \? null :[^\n]*Skill 管理/);
    expect(strip(read('SkillList.jsx')), '「上传 skill \\/ plugin」的字要按 narrow 收')
      .toMatch(/narrow \? null :[^\n]*上传 skill/);
  });
});
