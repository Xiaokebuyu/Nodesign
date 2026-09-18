/**
 * 话题让开的服务端这半（09-18）：前后端逐字一致；落盘封装真把整组挪了、用户蓝字跟着被标的那件走。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-topic-'));
process.env.PROJECTS_DATA_DIR = tmp;
process.env.DB_PATH = path.join(tmp, 'test.db');
const { settleBoard, describeSettle } = await import('./topic-settle.js');
const { readBoard } = await import('../projects/board-store.js');
const here = path.dirname(fileURLToPath(import.meta.url));

describe('镜像', () => {
  it('⭐ END-MIRROR 之间前后端逐字一致', () => {
    const cut = (s) => s.slice(s.indexOf('// ── 以下到 END-MIRROR'), s.indexOf('// ── END-MIRROR ──'));
    const web = fs.readFileSync(path.join(here, '../../web/src/lib/topic-settle.js'), 'utf8');
    const srv = fs.readFileSync(path.join(here, 'topic-settle.js'), 'utf8');
    expect(cut(web).length).toBeGreaterThan(1000);
    expect(cut(srv)).toBe(cut(web));
  });
});

describe('settleBoard', () => {
  it('⭐ 长高的话题把撞上的话题整组推开并落盘；用户蓝字跟着它标的那件走', async () => {
    const pid = 'proj_topic0001_x';
    const root = path.join(tmp, pid, 'shared');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'board.json'), JSON.stringify({
      zones: {},
      objects: {
        'text:a': { kind: 'text', data: { t: '长了' }, x: 0, y: 0, w: 300, h: 600, tag: 'A' },
        'text:b': { kind: 'text', data: { t: 'B' }, x: 0, y: 500, w: 200, h: 100, tag: 'B' },
        'text:b2': { kind: 'text', data: { t: 'B2' }, x: 240, y: 500, w: 200, h: 100, tag: 'B' },
        'text:u': { kind: 'text', data: { t: '用户说' }, x: 470, y: 500, w: 120, h: 40 },
      },
      bindings: { l: { type: 'annotates', from: 'text:u', to: 'text:b2', by: 'user' } },
    }));
    const out = await settleBoard(pid, ['text:a']);
    const b = await readBoard(pid);
    const dy = b.objects['text:b'].y - 500;
    expect(dy).toBeGreaterThan(0);
    expect(b.objects['text:b2'].y - 500).toBe(dy);
    expect(b.objects['text:u'].y - 500).toBe(dy);       // 蓝字归 b2 的话题，一起走
    expect(b.objects['text:a']).toMatchObject({ x: 0, y: 0 });
    expect(describeSettle(out)).toContain('#B 整组让开了');
  });
});
