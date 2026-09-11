/**
 * z-layers.lint.test.js —— 层级表的守卫。
 *
 * 光有表没有闸，下一个人照样手写一个 9999 —— 这个仓库已经栽过一次同型的：
 * `BoardOverlays` 的阅读器写死 110，别人把窗层从 120 抬到 500 的时候它没跟着动，
 * 于是「双击 .md 没反应」。**层级的问题从来不是数字难看，是它不会跟着别人一起改。**
 *
 * ## 判据：100 这条线
 *
 * - **< 100 放行**：组件内部自己那几层（`DragOverlay` 的 18~37、批注点的 9/11、
 *   `EditOverlay` 的 10）。它们只跟同一个组件里的兄弟比，写在本地是对的。
 * - **≥ 100 必须来自 z-layers**：这个量级的数只可能是想压过**别的文件**里的东西，
 *   那就得进表，否则没人知道它跟谁在比。
 *
 * 这条线是量出来的不是拍的：迁移那天全仓局部序最大是 60，跨文件最小是 120。
 *
 * ⚠️ 这条 lint 只认**字面量**。写 `zIndex: z` 它拦不住 —— 拦得住的是「随手敲一个大数」
 * 那个动作，那才是这一族 bug 的实际来源。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOARD_Z, SHELL_Z, PORTAL_Z } from './z-layers.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THRESHOLD = 100;

/**
 * 存量棘轮（2026-09-08 建表当天封的账）。
 *
 * ⛔ **只许变短不许变长。** 加一行进来之前先问自己为什么这个层级不该进表 ——
 * 这张单子的意义是「新写的挡住，旧的慢慢还」，不是「例外区」。
 *
 * 建表那天这里有 24 处。它们不是随手漏的，是真需要先想清楚语义再迁的，
 * 其中三类问题已经看出来了（详见文件末尾的 TODO）。
 */
const ALLOWLIST = new Map([
  ['components/canvas/AnnotatePopover.jsx', 1],       // → PORTAL_Z.POPOVER，直接可迁
  ['components/canvas/LinkPopover.jsx', 1],           // → PORTAL_Z.POPOVER，直接可迁
  ['components/canvas/BoardCanvas.jsx', 4],           // 290/300/320 三档 + 8000 那个吐司。
  //   ⛔ 这个文件卡在行数棘轮的冻结上限（2123）上，加一行 import 就超标 ——
  //   等谁把它拆了再迁，别为了迁层级去抬那个上限。
  ['components/canvas/OrchestrateSettings.jsx', 1],   // 600 = READER 档
  ['components/canvas/TextDraft.jsx', 2],             // 420：TRANSFORM(400) 与 WINDOW(500) 之间，缺一档
  ['components/canvas/board-filter.jsx', 1],          // 600 = READER 档
  ['components/layout/AppShell.jsx', 2],              // 900/899 —— 顶栏 + 唤出带，跟 PANEL(900) 撞号
  ['components/layout/ChatDock.jsx', 1],              // 121 = DOCK+1，⛔ 正是本表禁止的焊死写法
  ['components/layout/FloatingPanel.jsx', 2],         // 100 默认值 + 9998
  ['components/layout/MobileShell.jsx', 3],           // 118/119/120 —— 移动端另起了一套平行档
  ['components/layout/PanelMenu.jsx', 1],             // 500，在外壳里，跟 BOARD_Z.WINDOW(500) 同号不同义
  ['components/ui/ToastContainer.jsx', 1],            // 1000，外壳缺一档 TOAST
  ['harness.jsx', 1],                                 // 测试外壳，跟 CanvasFrame 抄的同一个 510
  ['lib/theme.js', 1],                                // MODAL.zIndex 600 = READER 档
  ['routes/ProjectWorkspace.jsx', 1],                 // 130，压在 DOCK(120) 之上
  ['routes/home-light.jsx', 1],                       // 9990
  ['routes/home-sun.js', 1],                          // 950（CSS 字符串里）
  ['routes/workspace-chrome.js', 1],                  // 100，是布局默认值不是层级
]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jsx?|css)$/.test(e.name) && !/\.test\.jsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 抠出所有「z-index 被赋成一个字面数字」的地方 */
function bareZIndexes(text) {
  const hits = [];
  const re = /(?:zIndex\s*[:=]\s*\{?|z-index\s*:\s*)(-?\d+)/g;
  for (const line of text.split('\n')) {
    // 整行注释跳过（注释里讲历史账会提到裸数字，那是文档不是代码）
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(line))) hits.push({ value: Number(m[1]), line: line.trim() });
  }
  return hits;
}

describe('z-index 层级表', () => {
  it('三组档位内部严格递增（表自己得先是对的）', () => {
    for (const [name, group] of [['BOARD_Z', BOARD_Z], ['SHELL_Z', SHELL_Z], ['PORTAL_Z', PORTAL_Z]]) {
      const vals = Object.values(group);
      const sorted = [...vals].sort((a, b) => a - b);
      expect(vals, `${name} 的档位得按大小写，不然读的人会以为顺序就是声明顺序`).toEqual(sorted);
      expect(new Set(vals).size, `${name} 里有重复的数`).toBe(vals.length);
    }
  });

  it('档位之间留了空当（不许出现 X 和 X+1 焊死）', () => {
    // 唯一允许贴身的一对：SPRITE_FRAME(304) / SPRITE(305) —— 它俩本来就该紧贴
    const ok = new Set(['SPRITE_FRAME|SPRITE']);
    for (const [name, group] of [['BOARD_Z', BOARD_Z], ['SHELL_Z', SHELL_Z], ['PORTAL_Z', PORTAL_Z]]) {
      const es = Object.entries(group);
      for (let i = 1; i < es.length; i++) {
        const gap = es[i][1] - es[i - 1][1];
        if (ok.has(`${es[i - 1][0]}|${es[i][0]}`)) continue;
        expect(gap, `${name}.${es[i - 1][0]} → ${name}.${es[i][0]} 之间只差 ${gap}，插不进新层`).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it(`web/src 里 ≥ ${THRESHOLD} 的 z-index 必须来自 z-layers`, () => {
    const bad = [];
    const shrunk = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');   // ALLOWLIST 的键是正斜杠；Windows 上 relative 给反斜杠（09-11 CI）
      if (rel.startsWith('lib/z-layers')) continue;
      const hits = bareZIndexes(fs.readFileSync(file, 'utf8')).filter((h) => h.value >= THRESHOLD);
      const budget = ALLOWLIST.get(rel) || 0;
      if (hits.length > budget) {
        for (const h of hits.slice(budget)) bad.push(`${rel}  z-index: ${h.value}   ${h.line.slice(0, 78)}`);
      }
      if (hits.length < budget) shrunk.push(`${rel}：存量 ${budget} → 现在 ${hits.length}，把棘轮调下来`);
    }
    expect(bad, `这些地方把跨文件的层级写成了裸数字，请改成 BOARD_Z / SHELL_Z / PORTAL_Z 里的档位：\n${bad.join('\n')}\n`).toEqual([]);
    // 棘轮只许往下走：还完了债就得把数字调小，否则它会慢慢变成一张永久许可证
    expect(shrunk, `这些文件比棘轮记的少了，说明债还了 —— 请把 ALLOWLIST 里的数字改小：\n${shrunk.join('\n')}\n`).toEqual([]);
  });
});
