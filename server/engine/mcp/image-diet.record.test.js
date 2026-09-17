/**
 * 减重层的记账是信息性的（09-17，问题库 iss_mtyjejeh_oqdr / iss_mtulw2gk_xim8）：
 * 不传 kind 时 auto 来源默认记成 bug，进了未关清单。这里走测试库真记两次：
 * kind 是 friction，且两次大小不同的摘要聚到同一条（聚合靠显式 signature，不看摘要里的数字）。
 */
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import db from '../runs/store.js';
import { withImageDiet } from './image-diet.js';

/** 不压缩的纯色 PNG：体积大、减重后极小，稳定越过 1MB 的记账门槛 */
const bigPng = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 90, g: 120, b: 150 } } })
  .png({ compressionLevel: 0 }).toBuffer();

describe('image-diet 记账', () => {
  it('kind=friction；不同大小聚到一条（count 累加）', async () => {
    const name = 'diet_probe_0917';
    let img = await bigPng(1500, 1000);
    const tool = withImageDiet({ name, handler: async () => ({ content: [{ type: 'image', data: img.toString('base64'), mimeType: 'image/png' }] }) }, { projectId: 'p', sessionId: 's' });
    await tool.handler({}, {});
    img = await bigPng(1700, 1100);
    await tool.handler({}, {});
    const rows = db.prepare('SELECT kind, count, summary FROM issues WHERE source = ? AND tool_name = ?').all('auto', name);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('friction');
    expect(rows[0].count).toBe(2);
    expect(rows[0].summary).toMatch(/一次回了 \d+\.\dMB 图/);
  });
});
