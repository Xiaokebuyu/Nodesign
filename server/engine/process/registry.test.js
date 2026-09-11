/**
 * 进程登记表：起 / 认端口 / 读日志 / 停 / 残留记录。用 node 自己当子进程，不依赖任何外部命令。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-proc-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'data');
const { openFolder } = await import('../../projects/folder.js');
const reg = await import('./registry.js');
const { getWorkspaceRoot } = await import('../../projects/workspace.js');

let pid;
beforeAll(async () => {
  const dir = path.join(tmp, 'repo');
  fs.mkdirSync(dir, { recursive: true });
  // 一个会打印地址然后一直活着的「dev server」
  fs.writeFileSync(path.join(dir, 'serve.js'), `
    const http = require('node:http');
    const s = http.createServer((_, r) => r.end('hi'));
    s.listen(0, '127.0.0.1', () => { console.log('  ➜  Local:   http://localhost:' + s.address().port + '/'); });
    process.on('SIGTERM', () => { console.log('bye'); process.exit(0); });
  `);
  ({ project: { id: pid } } = await openFolder({ path: dir }));
});
afterAll(async () => { await reg.stopAllProcesses('test'); });

describe('registry', () => {
  it('起来、认出端口、日志能读、能停、记录落盘', async () => {
    const { process: p, lines } = await reg.startProcess({ projectId: pid, command: 'node serve.js', name: 'dev', waitMs: 8000 });
    expect(p.status).toBe('running');
    expect(p.port).toBeGreaterThan(0);
    expect(p.url).toBe(`http://localhost:${p.port}`);
    expect(lines.some((l) => l.includes('Local:'))).toBe(true);
    expect(reg.isRegisteredPort(p.port)).toBe(true);

    const log = reg.readProcessLog(pid, p.id, { tail: 5 });
    expect(log.lines.length).toBeGreaterThan(0);
    const rec = JSON.parse(fs.readFileSync(path.join(getWorkspaceRoot(pid), '.nd', 'processes', `${p.id}.json`), 'utf8'));
    expect(rec.id).toBe(p.id);

    const stopped = await reg.stopProcess(pid, p.id);
    expect(stopped.status).toBe('stopped');
    expect(reg.isRegisteredPort(p.port)).toBe(false);
    const after = reg.readProcessLog(pid, p.id, { tail: 3 });
    // Windows 上停进程是 taskkill /T /F（连子孙一起强杀），没有 SIGTERM 可接，serve.js 那句 bye 不会打
    if (process.platform !== 'win32') expect(after.lines.join('\n')).toContain('bye');
    const list = await reg.listProcesses(pid);
    expect(list.find((x) => x.id === p.id)?.status).toBe('stopped');
  });

  it('服务端带着宿主 Claude Code 会话的变量时，进程里看不到（09-11 案：pm2 被灌过 --update-env）', async () => {
    process.env.CLAUDE_CODE_MESSAGING_TOKEN = 'leaked';
    process.env.VSCODE_GIT_IPC_AUTH_TOKEN = 'leaked';
    try {
      const { process: p } = await reg.startProcess({ projectId: pid, command: 'node -e "console.log(\'seen=\' + [process.env.CLAUDE_CODE_MESSAGING_TOKEN, process.env.VSCODE_GIT_IPC_AUTH_TOKEN].filter(Boolean).length)"', waitMs: 3000 });
      await new Promise((r) => setTimeout(r, 300));
      expect(reg.readProcessLog(pid, p.id).lines.join('\n')).toContain('seen=0');
    } finally {
      delete process.env.CLAUDE_CODE_MESSAGING_TOKEN;
      delete process.env.VSCODE_GIT_IPC_AUTH_TOKEN;
    }
  });

  it('立刻退出的命令：status 按退出码分 exited / failed，首屏带输出', async () => {
    const ok = await reg.startProcess({ projectId: pid, command: 'node -e "console.log(\'done\')"', waitMs: 3000 });
    expect(['exited', 'running']).toContain(ok.process.status);
    await new Promise((r) => setTimeout(r, 300));
    expect(reg.readProcessLog(pid, ok.process.id).process.status).toBe('exited');
    const bad = await reg.startProcess({ projectId: pid, command: 'node -e "console.error(\'boom\'); process.exit(3)"', waitMs: 3000 });
    await new Promise((r) => setTimeout(r, 300));
    const b = reg.readProcessLog(pid, bad.process.id);
    expect(b.process.status).toBe('failed');
    expect(b.process.exitCode).toBe(3);
    expect(b.lines.join('\n')).toContain('boom');
  });

  it('删记录：在跑的不许删，停了的连日志一起删', async () => {
    const { process: p } = await reg.startProcess({ projectId: pid, command: 'node -e "setInterval(()=>{},1000)"', waitMs: 200 });
    await expect(reg.removeProcess(pid, p.id)).rejects.toMatchObject({ code: 'PROCESS_RUNNING' });
    await reg.stopProcess(pid, p.id);
    await reg.removeProcess(pid, p.id);
    expect(fs.existsSync(path.join(getWorkspaceRoot(pid), '.nd', 'processes', `${p.id}.log`))).toBe(false);
  });

  it('盘上残留的 running 记录列出来是 lost', async () => {
    const dir = path.join(getWorkspaceRoot(pid), '.nd', 'processes');
    fs.writeFileSync(path.join(dir, 'p_old.json'), JSON.stringify({ id: 'p_old', status: 'running', startedAt: '2026-01-01T00:00:00Z', name: 'ghost' }));
    const list = await reg.listProcesses(pid);
    expect(list.find((x) => x.id === 'p_old')?.status).toBe('lost');
  });
});

describe('出网闸的口子', () => {
  it('登记表里在跑的 localhost 端口放行，停了就关；别的本机地址照旧拒', async () => {
    const { checkUrl } = await import('../../lib/ssrf-guard.js');
    const { process: p } = await reg.startProcess({ projectId: pid, command: 'node serve.js', waitMs: 8000 });
    expect((await checkUrl(`http://localhost:${p.port}/`)).ok).toBe(true);
    expect((await checkUrl(`http://127.0.0.1:${p.port}/x`)).ok).toBe(true);
    expect((await checkUrl(`http://localhost:${p.port + 1}/`)).ok).toBe(false);
    expect((await checkUrl(`http://0.0.0.0:${p.port}/`)).ok).toBe(false);
    expect(reg.isRegisteredLoopback('10.0.0.5', p.port)).toBe(false);
    await reg.stopProcess(pid, p.id);
    expect((await checkUrl(`http://localhost:${p.port}/`)).ok).toBe(false);
  });
});
