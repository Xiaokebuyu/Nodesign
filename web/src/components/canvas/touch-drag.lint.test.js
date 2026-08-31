/**
 * 触屏拖卡的三条闸（2026-08-29 用户拍板恢复拖卡）。
 *
 * 08-21 的病是「双指捏合把卡带跑并落盘」，当时的修法是把触屏拖卡整条撤掉。
 * 这次换了个形状：**不阻止它起手，而是让它可撤销、撤销就不落盘**。
 *
 * ⚠️ 这个文件守的是**形状**，不是行为。真正的行为判据是
 * `web/scripts/touch-drag-probe.mjs` —— 那条路上有两处只认 isTrusted 事件，
 * 页面里 dispatchEvent 一路绿灯却什么都没测到，只能用 CDP 发真触摸去攻。
 * 这里拦的是「有人把撤销路径改成会写盘」这类静态退化，跑得快、进得了 vitest。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const DRAG = strip(read('useBoardObjectDrag.js'));
const CAM = strip(read('useBoardCamera.js'));
const BOARD = strip(read('BoardCanvas.jsx'));

/** 取一个函数体（这几个都是 `const 名 = (…) => {` 起头、到同缩进的 `};` 结束） */
function body(src, name) {
  const i = src.indexOf(`const ${name} = `);
  if (i < 0) throw new Error(`找不到 ${name} —— 它改名了？这条 lint 要跟着改`);
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) return src.slice(open, j + 1); }
  }
  throw new Error(`${name} 的函数体没闭合`);
}

describe('闸一：撤销路径一个字都不写盘', () => {
  const abort = body(DRAG, 'abortDrag');

  it('⛔ abortDrag 不许碰 dirtyRef / scheduleSave / patchLayout', () => {
    // 落盘只发生在 onPointerUp 那一条路上，所以"不写盘"是免费的 —— 前提是
    // 谁也别在这儿顺手补一句"保险起见存一下"
    expect(abort, 'abortDrag 里出现了 dirtyRef —— 撤销就不该留下痕迹').not.toMatch(/dirtyRef/);
    expect(abort, 'abortDrag 里出现了 scheduleSave').not.toMatch(/scheduleSave/);
    expect(abort, 'abortDrag 里出现了 patchLayout（它会排写入）').not.toMatch(/patchLayout/);
  });

  it('撤销要把卡弹回原位（光清 dragRef 会把卡留在半路上）', () => {
    expect(abort).toMatch(/setLayout/);
    expect(abort, '弹回用的是起手时记下的 origX/origY').toMatch(/origX/);
    expect(abort).toMatch(/origY/);
  });

  it('落盘那一条路仍然在 onPointerUp 上（判据的前提别被搬走）', () => {
    const up = body(DRAG, 'onPointerUp');
    expect(up).toMatch(/dirtyRef\.current\.objects\.add/);
    expect(up).toMatch(/scheduleSave/);
  });
});

describe('闸二：第二根手指落下就撤销', () => {
  it('合成的 pointercancel 走 abortDrag，真事件才走提交', () => {
    // useTouchGestures 在第二根手指落下时补一条 pointercancel（isTrusted=false）
    expect(BOARD).toMatch(/e\.isTrusted\s*\?\s*onPointerUp\(e\)\s*:\s*abortDrag\(\)|if\s*\(e\.isTrusted\)\s*onPointerUp\(e\);\s*else\s*abortDrag\(\)/);
  });

  it('还没武装的长按，第二根手指一落下也取消（pointerdown 监听在捕获阶段）', () => {
    const arm = body(DRAG, 'armLongPress');
    expect(arm).toMatch(/addEventListener\('pointerdown'[^)]*true\)/);
  });
});

describe('闸三：仲裁只有一个主人', () => {
  it('拿着卡的时候不是抓手态 —— 否则相机和拖卡各拽各的', () => {
    expect(CAM).toMatch(/isHandMode:\s*\(\)\s*=>\s*!cardGrabRef\.current\s*&&/);
  });

  it('要走这一串时相机当场停掉在飞的平移（不然卡和背景双份位移）', () => {
    expect(CAM).toMatch(/beginCardGrab:[^\n]*panRef\.current\s*=\s*null/);
  });

  it('长按到点了才跟相机要，并且把撤销回调交出去', () => {
    expect(body(DRAG, 'armLongPress')).toMatch(/beginCardGrab\?\.\(abortDrag\)/);
  });

  it('松手和撤销都要把 grab 还回去（不还的话相机从此不平移）', () => {
    expect(body(DRAG, 'onPointerUp')).toMatch(/endCardGrab/);
    expect(body(DRAG, 'abortDrag')).toMatch(/endCardGrab/);
  });
});

/**
 * 板书的防误触（2026-08-31 从「一律不给拖」改成「跟桌面同一条规矩」）。
 *
 * 08-29 这里钉的是 `if (o.chalk) return`，理由原文是「它在桌面上有专门的防误触闸
 * （改板书开关），而那颗按钮手机上撤掉了」。08-31 站主把那颗按钮放回了手机（占掉
 * 下架的「黑板」那一格），理由不成立了，闸跟着换。
 *
 * ⭐ 现在钉的是**两条路同一个判据**这个形状。armLongPress（触屏长按那条）和
 * onObjectPointerDown（鼠标/平板那条）必须写一模一样的条件，只改一条的下场是：
 * 手机上开关按了没反应，或者反过来关着也拖得动，两种都让那颗开关变成谎话。
 */
describe('板书防误触：两条路一个判据', () => {
  const GUARD = /o\.chalk\s*&&\s*!chalkEditModeRef\.current\s*&&\s*!selectedIdsRef\.current\.includes\(o\.id\)/;

  it('长按那条路认「改板书」开关，不再一刀切挡掉', () => {
    expect(body(DRAG, 'armLongPress')).toMatch(GUARD);
    expect(body(DRAG, 'armLongPress'), '又回到一刀切了 —— 那颗开关会变成假的')
      .not.toMatch(/if\s*\(o\.chalk\)\s*return/);
  });

  it('鼠标那条路的判据一字不差', () => {
    expect(body(DRAG, 'onObjectPointerDown')).toMatch(GUARD);
  });
});
