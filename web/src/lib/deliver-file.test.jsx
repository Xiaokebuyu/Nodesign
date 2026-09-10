// @vitest-environment happy-dom
// 一个文件怎么交到用户手上（2026-09-10）：桌面版交给壳自己写盘，网页版才走浏览器下载。
// 病历在 lib/deliver-file.js 开头（09-09 下载目录里文件被拿走那案）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { deliverFile } from './deliver-file.js';

function fakeBlob(text) {
  return { arrayBuffer: async () => new TextEncoder().encode(text).buffer };
}

let clicked;
beforeEach(() => {
  clicked = [];
  delete window.nodesignDesktop;
  // <a download> 那条退路：拦 click，别真让 happy-dom 去导航
  vi.spyOn(window.HTMLAnchorElement.prototype, 'click').mockImplementation(function stub() { clicked.push(this.download); });
  window.URL.createObjectURL = vi.fn(() => 'blob:x');
  window.URL.revokeObjectURL = vi.fn();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('deliverFile', () => {
  it('桌面版：字节交给壳写盘，不碰浏览器下载', async () => {
    const saveExport = vi.fn(async () => ({ path: 'C:\\Users\\me\\Downloads\\a.zip', size: 3 }));
    window.nodesignDesktop = { saveExport };
    const r = await deliverFile(fakeBlob('abc'), 'a.zip');
    expect(saveExport).toHaveBeenCalledTimes(1);
    expect(saveExport.mock.calls[0][0]).toBe('a.zip');
    expect(r.path).toContain('a.zip');
    expect(clicked).toEqual([]);
  });

  it('网页版：还是 <a download>', async () => {
    const r = await deliverFile(fakeBlob('abc'), 'a.zip');
    expect(clicked).toEqual(['a.zip']);
    expect(r.path).toBe(null);
  });

  it('壳那边出错 → 退回浏览器下载（导出不能因为壳的毛病卡死）', async () => {
    window.nodesignDesktop = { saveExport: vi.fn(async () => { throw new Error('EACCES'); }) };
    const r = await deliverFile(fakeBlob('abc'), 'a.zip');
    expect(clicked).toEqual(['a.zip']);
    expect(r.path).toBe(null);
  });
});
