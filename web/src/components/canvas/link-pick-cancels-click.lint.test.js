/**
 * 连线拾取必须掐掉待落的单击（2026-09-11）。
 *
 * 起因：08-27 起单击卡片 = 选中 + 开标注纸，挂在 pointerup 上延后 220ms 落（useObjectClick）。
 * 连线模式在 click 捕获阶段拾取目标、弹建线浮层，却没掐那个定时器 —— 220ms 后标注纸盖住
 * 建线浮层，用户点「取材」等 chip 实际点在标注纸上，浮层被「点外面即关」收掉，线建不上。
 * 两周里手动连线一条都没成功过，是录 README 演示时才发现的。
 *
 * 这道 lint 只证明那一行还在；真证据是对真服务端点一遍（gif-recorder-v2/g-user.mjs --dry=1 后查 board 多一条 by:user 的线）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'BoardCanvas.jsx'), 'utf8');
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('连线拾取', () => {
  it('⛔ onClickCapture 的连线分支里要调 cancelPendingClick()', () => {
    const at = code.indexOf('onClickCapture={linkFrom');
    expect(at, '找不到连线拾取的 onClickCapture').toBeGreaterThan(-1);
    const branch = code.slice(at, code.indexOf('setLinkPop(', at));
    expect(branch, '连线拾取没掐待落的单击，标注纸会盖住建线浮层').toContain('cancelPendingClick()');
  });
});
