/**
 * bin/supervisor.js 的行为：命令行版和桌面版都骑在它上面，所以重启语义 / 失败路径要有判据。
 * 子进程用 node 跑一段内联脚本代替 server/index.js。
 */
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSupervisor, waitHealth, pickPort, PortBusyError, RESTART_EXIT_CODE } from './supervisor.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-'));
function script(name, body) { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; }

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('createSupervisor', () => {
  it('spawn 失败（可执行文件不存在）→ onExit(1, null, err)，不是未捕获异常', async () => {
    const got = await new Promise((resolve) => {
      const sup = createSupervisor({ serverEntry: 'x.js', runtime: path.join(dir, 'no-such-runtime'), onExit: (c, s, err) => resolve({ c, s, err }) });
      sup.start();
    });
    expect(got.c).toBe(1);
    expect(got.err?.code).toBe('ENOENT');
  });

  it('以 75 退出 → 重新拉起（onRestart 一次、onExit 零次），之后正常退出 → onExit 一次', async () => {
    // 第一次跑退 75，第二次退 0（靠一个标记文件区分）
    const flag = path.join(dir, 'ran-once');
    const entry = script('restart.js', `
      const fs = require('node:fs');
      if (!fs.existsSync(${JSON.stringify(flag)})) { fs.writeFileSync(${JSON.stringify(flag)}, '1'); process.exit(${RESTART_EXIT_CODE}); }
      process.exit(0);
    `);
    const events = [];
    await new Promise((resolve) => {
      const sup = createSupervisor({ serverEntry: entry, stdio: 'ignore', onRestart: () => events.push('restart'), onExit: (c) => { events.push(`exit:${c}`); resolve(); } });
      sup.start();
    });
    expect(events).toEqual(['restart', 'exit:0']);
  });

  it('stop：SIGTERM 不走的子进程超时后被 SIGKILL，stop 仍然收得回来', async () => {
    const entry = script('stubborn.js', `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`);
    const sup = createSupervisor({ serverEntry: entry, stdio: 'ignore', killTimeoutMs: 300 });
    sup.start();
    await wait(200);
    expect(sup.running).toBe(true);
    const t0 = Date.now();
    await sup.stop();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(sup.running).toBe(false);
  });
});

describe('waitHealth', () => {
  it('health 通了 → true；alive() 变 false → 提前 false，不等满超时', async () => {
    const srv = http.createServer((req, res) => { res.writeHead(req.url === '/api/health' ? 200 : 404); res.end(); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}`;
    expect(await waitHealth(url, { timeoutMs: 2000 })).toBe(true);
    let alive = true;
    setTimeout(() => { alive = false; }, 100);
    const t0 = Date.now();
    const dead = await waitHealth('http://127.0.0.1:1', { timeoutMs: 10_000, intervalMs: 50, alive: () => alive });
    expect(dead).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
    await new Promise((r) => srv.close(r));
  });
});

describe('pickPort', () => {
  it('指定端口被占 → PortBusyError；不指定 → 跳过被占的往上找', async () => {
    const srv = http.createServer();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const busy = srv.address().port;
    await expect(pickPort({ wanted: busy })).rejects.toBeInstanceOf(PortBusyError);
    const picked = await pickPort({ from: busy, span: 5 });
    expect(picked).toBeGreaterThan(busy);
    await new Promise((r) => srv.close(r));
  });
});
