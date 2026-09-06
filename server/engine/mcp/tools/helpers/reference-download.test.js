// 搜图落点（2026-09-07）：必须是工作区根上的 `参考图/`，不是 assets/references/。
// 判据的来历：assets/references/ 是画布扫描的盲区 —— 入座器排了座、状态块催 agent 去 pin、
// pin_to_board 又拒收。改成根上的真文件夹之后三处判据同一形状。这条测试钉的是落点本身。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadReferenceImages, REFERENCE_IMAGE_DIR } from './reference-download.js';

// 1x1 PNG，再垫到 5KB 以上（下载器有最小体积门槛）
const PNG = Buffer.concat([
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
  Buffer.alloc(6000, 0),
]);

let server; let base;
beforeAll(async () => {
  server = http.createServer((req, res) => { res.setHeader('content-type', 'image/png'); res.end(PNG); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server.close());

describe('搜图落点', () => {
  it('落在工作区根的 参考图/ 下，relPath 也这么报（agent 拿它喂 referenceImages，用户在桌面上看得见同一张）', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-ref-'));
    try {
      const out = await downloadReferenceImages([{ url: `${base}/a.png`, description: 'a' }], { workspaceRoot: ws });
      expect(out).toHaveLength(1);
      expect(REFERENCE_IMAGE_DIR).toBe('参考图');
      expect(out[0].relPath.startsWith('参考图/ref-')).toBe(true);
      expect(fs.existsSync(path.join(ws, out[0].relPath))).toBe(true);
      expect(fs.existsSync(path.join(ws, 'assets', 'references'))).toBe(false);
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });
});
