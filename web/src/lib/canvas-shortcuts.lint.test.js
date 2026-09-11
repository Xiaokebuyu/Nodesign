/**
 * 快捷键表跟真监听对得上（2026-09-12）。
 *
 * 左下角那条是给人看的说明，真正的监听在 useBoardCamera.js / BoardCanvas.jsx。
 * 两边各改各的就会出现「写着 Shift+1、按了没反应」或者「加了新键、没人知道」，
 * 前一种比不写更坏（BoardCanvas 换工具那段的前科：提示写着「（V）」，全仓没人监听）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHORTCUTS, SHORTCUT_GROUPS } from './canvas-shortcuts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = {
  camera: fs.readFileSync(path.join(HERE, '../components/canvas/useBoardCamera.js'), 'utf8'),
  board: fs.readFileSync(path.join(HERE, '../components/canvas/BoardCanvas.jsx'), 'utf8'),
};

describe('画布快捷键表跟真监听对得上', () => {
  it('表里每一条都在监听源码里原样找得到（写了一个不存在的键比不写更坏）', () => {
    for (const s of SHORTCUTS) {
      for (const h of s.probe.has) {
        expect(SRC[s.probe.src], `${s.id}：${s.probe.src} 的监听里找不到「${h}」`).toContain(h);
      }
    }
  });

  it('镜头监听里的每个键码都在表里（加了新键得来这儿登记，不然没人知道）', () => {
    const codes = new Set([...SRC.camera.matchAll(/e\.code\s*[!=]==\s*'(\w+)'/g)].map((m) => m[1]));
    expect(codes.size, '一个键码都没抠到，说明监听的写法变了，这条判据得跟着改').toBeGreaterThan(4);
    const listed = SHORTCUTS.filter((s) => s.probe.src === 'camera').flatMap((s) => s.probe.has).join('\n');
    for (const c of codes) expect(listed, `useBoardCamera 监听了 ${c}，快捷键表里没有`).toContain(`'${c}'`);
  });

  it('换工具的单键都在表里', () => {
    const m = SRC.board.match(/const KEYS = \{([^}]*)\}/);
    expect(m, 'BoardCanvas 里找不到换工具的 KEYS 表').toBeTruthy();
    const letters = [...m[1].matchAll(/(\w+):/g)].map((x) => x[1].toUpperCase());
    expect(letters.length).toBeGreaterThan(0);
    for (const k of letters) {
      expect(SHORTCUTS.some((s) => s.keys.some((c) => c.length === 1 && c[0] === k)), `工具键 ${k} 不在表里`).toBe(true);
    }
  });

  it('常驻那条只放最常用的四个；每条都归在认得的分组里', () => {
    expect(SHORTCUTS.filter((s) => s.pin).map((s) => s.id)).toEqual(['pan', 'zoom', 'fit', 'ask']);
    for (const s of SHORTCUTS) expect(SHORTCUT_GROUPS.some((g) => g.id === s.group), `${s.id} 的分组不认得`).toBe(true);
  });
});
