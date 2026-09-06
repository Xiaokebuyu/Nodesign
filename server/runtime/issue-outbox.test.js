/**
 * 发件箱：本机排队、按结果分流（成功清掉 / 4xx 丢 / 网络错与 429 留到下次）、没令牌不动。
 * NODESIGN_PROFILE=local + 临时数据目录在 import 之前设好（profile.js 是加载期读的）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-outbox-'));
process.env.NODESIGN_PROFILE = 'local';
process.env.NODESIGN_DATA_DIR = dataRoot;
process.env.NODESIGN_RELAY_TOKEN = 'tok-for-test';
process.env.NODESIGN_RELAY_URL = 'http://127.0.0.1:9';

const { enqueueIssueUpload, flushIssueOutbox, outboxPath } = await import('./issue-outbox.js');

const lines = () => { try { return fs.readFileSync(outboxPath(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const item = (n) => ({ kind: 'friction', source: 'agent', summary: `第 ${n} 条抱怨 xxxxxxxx`, detail: 'd', signature: `s${n}` });

beforeEach(() => { fs.rmSync(outboxPath(), { force: true }); });

describe('issue-outbox', () => {
  it('排队落文件，带时间戳；桌面壳写的行同一格式也能读', async () => {
    enqueueIssueUpload(item(1));
    fs.appendFileSync(outboxPath(), JSON.stringify({ kind: 'bug', source: 'desktop', summary: '桌面版启动失败：x', detail: 'stack' }) + '\n');
    await new Promise((r) => setTimeout(r, 120));   // enqueue 会自己试发一次（对着 :9 失败），等它落回文件
    const ls = lines();
    expect(ls.map((x) => x.source)).toEqual(['agent', 'desktop']);
    expect(ls[0].at).toMatch(/^\d{4}-/);
  });

  it('全部成功 → 文件清空；网络错 → 这条和后面的都留；4xx → 只丢那一条', async () => {
    enqueueIssueUpload(item(1)); enqueueIssueUpload(item(2)); enqueueIssueUpload(item(3));
    await new Promise((r) => setTimeout(r, 120));
    expect(lines()).toHaveLength(3);

    const sent = [];
    // 第 2 条被站点 400 拒 → 丢；其余成功
    let r = await flushIssueOutbox({ send: async (it) => { if (it.signature === 's2') throw Object.assign(new Error('bad'), { status: 400 }); sent.push(it.signature); } });
    expect(r).toEqual({ sent: 2, left: 0 });
    expect(sent).toEqual(['s1', 's3']);
    expect(fs.existsSync(outboxPath())).toBe(false);

    enqueueIssueUpload(item(4)); enqueueIssueUpload(item(5));
    await new Promise((r2) => setTimeout(r2, 120));
    r = await flushIssueOutbox({ send: async () => { throw Object.assign(new Error('rate'), { status: 429 }); } });
    expect(r).toEqual({ sent: 0, left: 2 });
    expect(lines().map((x) => x.signature)).toEqual(['s4', 's5']);
    r = await flushIssueOutbox({ send: async () => { throw new Error('ECONNREFUSED'); } });
    expect(r.left).toBe(2);
  });
});
