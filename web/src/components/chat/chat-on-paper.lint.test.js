/**
 * 聊天这一栏整个站在纸上 —— 别再往纸上铺"栏"的色。
 *
 * 历史：聊天曾经是 ThreeColumnLayout 的左栏（底色 WORKBENCH.panel = CHROME.bg
 * = #FBF7EC）。后来整个搬到 ChatDock 那张纸上（桌面）和 MobileShell 的抽屉
 * （手机），两边都是 PAPER.paper + GRAIN。那个三栏布局**现在一个调用方都没有了**，
 * 可栏的底色留在了两个地方，各自变成纸上一块平的、颜色差一档的东西：
 *
 *   - TimelineNode 图标底下那块 14x14 的方片（用来"打断"竖线）
 *   - ChatComposer 输入纸外面那圈 420px 宽的托盘
 *
 * 两处都是 08-30 纸的颗粒加重之后才被看出来的（颗粒淡的时候混得过去）。
 *
 * ⭐ 这条钉的是**别再铺**，不是"铺成某个颜色" —— 纸的颜色跟着季节皮肤走
 * （PAPER = {...BASE, ...currentSkin()}），追是追不过来的，这块已经追丢过两次。
 * 真要在纸上做一块不同的面，用 PAPER 里的纸变体并带上 GRAIN。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FILES = readdirSync(DIR).filter((f) => /\.jsx?$/.test(f) && !/\.test\./.test(f));

// 图标那一格不许有底色、线是断的 —— 那两条在 timeline-node-paper.test.jsx 里
// 真渲染着量（静态扫不出来：竖线自己的 background 是正当的）。

/** 去掉注释再看 —— 这两个 token 的名字正大光明写在墓碑注释里 */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
}

describe('聊天栏站在纸上', () => {
  it('⛔ 不许拿"栏"的色（CHROME.bg / WORKBENCH.*）当底铺在纸上', () => {
    const bad = [];
    for (const f of FILES) {
      const src = code(readFileSync(path.join(DIR, f), 'utf8'));
      const re = /background[A-Za-z]*\s*:\s*(CHROME\.bg|WORKBENCH\.\w+)/g;
      for (const m of src.matchAll(re)) bad.push(`${f}: ${m[0]}`);
    }
    expect(bad, `栏的色铺到纸上了（纸的颜色跟季节走，追不过来；要做面就用 PAPER 的纸变体 + GRAIN）:\n${bad.join('\n')}`).toEqual([]);
  });

});
