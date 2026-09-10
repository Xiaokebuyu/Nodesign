// @vitest-environment happy-dom
/**
 * 盖在画布上的显示面都要给钉住的聊天卡让位（2026-09-10）。
 *
 * 病史：09-08 给桌面版原生浏览器视图做了让位，09-09 扩到六扇产物窗，然后就停在那儿了 ——
 * 图片详情、markdown 阅读器、项目区四张卡、编排设置页**一个都没让**，站主 09-10 点名
 * 「图片阅读」时才发现是一族。判据收进 lib/dock-yield.js 一份，这组测试钉两件事：
 * 让位真的发生了（行为），以及没人再把这条规矩抄第二遍（lint）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImageDetailOverlay, MarkdownViewerOverlay } from './BoardOverlays.jsx';
import { useGlobalStore } from '../../stores/globalStore.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let host; let root;
beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); useGlobalStore.getState().setChatDockPinned(null); });

/** 罩子（happy-dom 不认 inset 简写，所以按标记找，不按样式找 —— 这条坑记忆里有） */
const scrim = () => host.querySelector('[data-board-overlay]');

describe('图片阅读（站主 09-10 点名的那个）', () => {
  const render = () => act(() => root.render(
    <ImageDetailOverlay projectId="p1" detail={{ name: 'a.png', path: '参考图/a.png' }} onClose={() => {}} onAdd={() => {}} />,
  ));

  it('卡没钉住：四边就是原来的 page 边距', () => {
    render();
    expect(scrim().style.paddingRight).toBe(scrim().style.paddingLeft);
  });

  it('⭐ 卡钉在右边 388 宽 → 右边距让开 388+，左边不动（图整体挪开，不是被压小）', () => {
    act(() => useGlobalStore.getState().setChatDockPinned({ side: 'right', width: 388 }));
    render();
    const base = parseInt(scrim().style.paddingLeft, 10);
    expect(parseInt(scrim().style.paddingRight, 10)).toBe(388 + base);
    act(() => useGlobalStore.getState().setChatDockPinned(null));
    expect(parseInt(scrim().style.paddingRight, 10)).toBe(base);
  });

  it('卡钉在左边 → 让左边', () => {
    act(() => useGlobalStore.getState().setChatDockPinned({ side: 'left', width: 300 }));
    render();
    const base = parseInt(scrim().style.paddingRight, 10);
    expect(parseInt(scrim().style.paddingLeft, 10)).toBe(300 + base);
  });
});

describe('阅读器走同一张罩子，所以一起有了', () => {
  it('markdown 阅读器也让位', () => {
    act(() => useGlobalStore.getState().setChatDockPinned({ side: 'right', width: 388 }));
    act(() => root.render(
      <MarkdownViewerOverlay projectId="p1" viewer={{ title: '记', text: '正文', path: 'notes/a.md' }} onClose={() => {}} />,
    ));
    const base = parseInt(scrim().style.paddingLeft, 10);
    expect(parseInt(scrim().style.paddingRight, 10)).toBe(388 + base);
  });
});

describe('判据只有一份', () => {
  const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
  /** 盖在画布上的显示面：产物窗壳、三张浮层的罩子、编排设置页 */
  const SURFACES = [
    'components/canvas/ArtifactWindow.jsx',
    'components/canvas/BoardOverlays.jsx',
    'components/canvas/OrchestrateSettings.jsx',
  ];

  it('每个显示面都问 useDockYield，没人自己写一遍', () => {
    for (const f of SURFACES) {
      expect(read(f), `${f}: 让位要走 lib/dock-yield.js`).toMatch(/useDockYield/);
      expect(read(f), `${f}: 别自己读 chatDockPinned —— 两条边界（只让钉住的、只在桌面档）会抄漏`).not.toMatch(/chatDockPinned/);
    }
  });

  it('chatDockPinned 只有两个读者：写的那头（ChatDock）和判据本身', () => {
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.jsx?$/.test(e.name) || /\.test\./.test(e.name)) continue;
        if (fs.readFileSync(p, 'utf8').includes('chatDockPinned')) hits.push(path.relative(SRC, p).replace(/\\/g, '/'));
      }
    };
    walk(SRC);
    expect(hits.sort()).toEqual(['components/layout/ChatDock.jsx', 'lib/dock-yield.js', 'stores/globalStore.js']);
  });

  it('⚠️ 桌面版原生浏览器视图是刻意的例外（它逐帧量 DOM，还要躲悬浮态的卡）', () => {
    const src = read('components/canvas/BrowserWindow.jsx');
    expect(src).toMatch(/overlayRects/);
    expect(src).toMatch(/data-chat-card/);
  });
});
