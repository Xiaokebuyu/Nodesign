import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditWorkspace, attachWorkspaceAudit } from './workspace-audit.js';
import { EventBus } from '../engine/agent/events.js';

describe('工作区对账', () => {
  it('板上有磁盘没有 → dangling；磁盘有板上没有 → unseated；目录卡整段认领；原生物件与保留目录跳过', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-audit-'));
    fs.writeFileSync(path.join(root, '封面.png'), 'x');
    fs.mkdirSync(path.join(root, '官网'), { recursive: true }); fs.writeFileSync(path.join(root, '官网', 'index.html'), 'x'); fs.writeFileSync(path.join(root, '官网', 'a.css'), 'x');
    fs.writeFileSync(path.join(root, '孤儿.md'), 'x');
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true }); fs.writeFileSync(path.join(root, 'assets', 'ref.jpg'), 'x');
    const board = { objects: { '封面.png': { x: 1 }, 'site:官网': { x: 2 }, 'deck:没了.html': { x: 3 }, 'C:': { x: 4 }, 'scribble:abc': { x: 5 } } };
    const r = await auditWorkspace('p', { sharedRoot: root, board });
    expect(r.dangling.sort()).toEqual(['C:', 'deck:没了.html']);
    expect(r.unseated).toEqual(['孤儿.md']);
    expect(r.checked).toBe(4);
  });
  it('挂在 bus 上：run.done 后对账，有 dangling 才记问题', async () => {
    const bus = new EventBus(); const issues = [];
    let result = { dangling: [] };
    attachWorkspaceAudit(bus, 'p', { audit: async () => result, record: (i) => issues.push(i), delayMs: 5 });
    bus.publish({ type: 'run.done', sessionId: 's' });
    await new Promise((r) => setTimeout(r, 30));
    expect(issues).toHaveLength(0);
    result = { dangling: ['deck:没了.html'] };
    bus.publish({ type: 'run.done', sessionId: 's' });
    await new Promise((r) => setTimeout(r, 30));
    expect(issues).toHaveLength(1);
    expect(issues[0].signature).toBe('workspace-audit|p');
  });
});
