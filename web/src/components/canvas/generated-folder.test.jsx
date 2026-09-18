// @vitest-environment happy-dom
// 生成图文件夹（09-18）前端这半：旧板桌面件留桌面、新图进「生成图」、这张卡不能删改搬、窗里回不到 assets/。
import { describe, it, expect, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { useDirIndex } from './useDirIndex.js';
import { buildBoardMenu } from './canvas-menus.js';
import { parentDir } from './FolderWindow.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root; let out;
function Probe(props) { out = useDirIndex(props); return null; }
const run = (props) => {
  root = createRoot(document.createElement('div'));
  act(() => { root.render(<Probe {...props} />); });
  return out;
};
afterEach(() => { act(() => root?.unmount()); });

const objects = [
  { id: 'assets/generated/old.png', type: 'image' },
  { id: 'assets/generated/new.png', type: 'image' },
  { id: '稿/a.md', type: 'file' },
];
const zonesEff = { 'assets/generated': { x: 0, y: 0 }, 稿: { x: 400, y: 0 } };

describe('useDirIndex', () => {
  it('⭐ 旧板桌面件（desk）归桌面，同目录的新图归生成图文件夹', () => {
    const { dirIndex } = run({ objects, zonesEff, layout: { 'assets/generated/old.png': { x: 1, y: 1, desk: true } }, taskTitles: new Map() });
    expect(dirIndex.dirOf(objects[0])).toBe('');
    expect(dirIndex.dirOf(objects[1])).toBe('assets/generated');
    expect(dirIndex.dirOf(objects[2])).toBe('稿');
  });

  it('文件夹卡的名字叫「生成图」，不叫 generated', () => {
    const { folderCardOf } = run({ objects, zonesEff, layout: {}, taskTitles: new Map() });
    expect(folderCardOf('assets/generated', null).title).toBe('生成图');
    expect(folderCardOf('稿', null).title).toBe('稿');
  });
});

describe('生成图文件夹卡的右键菜单', () => {
  const act0 = new Proxy({}, { get: () => () => {} });
  const ids = (zoneId) => buildBoardMenu({ mx: 0, my: 0, at: { x: 0, y: 0 }, obj: null, zoneId, winIn: null, batch: null, sel: [], objs: [], zones: [] }, act0)
    .filter((i) => i.id).map((i) => i.id);

  it('⛔ 没有删除、改名、搬走、建子夹；普通文件夹照旧都有', () => {
    const gen = ids('assets/generated');
    for (const x of ['del', 'rename', 'move', 'new']) expect(gen).not.toContain(x);
    expect(gen).toContain('enter');
    const plain = ids('稿');
    for (const x of ['del', 'rename', 'move', 'new', 'enter']) expect(plain).toContain(x);
  });

  it('生成图文件夹窗里的空白不弹菜单', () => {
    expect(buildBoardMenu({ mx: 0, my: 0, at: null, obj: null, zoneId: null, winIn: 'assets/generated', batch: null, sel: [], objs: [], zones: [] }, act0)).toEqual([]);
  });
});

describe('parentDir', () => {
  it('生成图文件夹的上一层是桌面（assets/ 不是用户的文件夹）', () => {
    expect(parentDir('assets/generated')).toBeNull();
    expect(parentDir('稿/初稿')).toBe('稿');
  });
});
