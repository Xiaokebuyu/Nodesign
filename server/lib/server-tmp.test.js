// 服务端临时文件根（09-17）：固定名字、可重建、沙盒遮读；服务端别处不再把临时目录建在 /tmp 根上
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SERVER_TMP_ROOT, ensureServerTmpRoot, makeServerTmpDir, serverTmpPath } from './server-tmp.js';

describe('server-tmp', () => {
  it('根在系统临时目录下、名字带 uid；删掉后调用会重建', async () => {
    expect(path.dirname(SERVER_TMP_ROOT)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(SERVER_TMP_ROOT)).toMatch(/^nd-srv-/);
    const d = await makeServerTmpDir('t-');
    expect(d.startsWith(SERVER_TMP_ROOT + path.sep)).toBe(true);
    fs.rmSync(d, { recursive: true, force: true });
    expect(serverTmpPath('x.json')).toBe(path.join(SERVER_TMP_ROOT, 'x.json'));
    expect(ensureServerTmpRoot()).toBe(SERVER_TMP_ROOT);
    expect(fs.statSync(SERVER_TMP_ROOT).isDirectory()).toBe(true);
  });
});

describe('⛔ 服务端代码不把临时目录直接建在 /tmp 根上', () => {
  // 允许的：私有根本身、沙盒 / 钩子里对 tmp 的判断、测试专用路径、兜底读数、ssh 控制 socket（沙盒里 AF_UNIX 被 seccomp 掐掉）
  const ALLOW = new Set([
    'lib/server-tmp.js',
    'engine/agent/isolation.js',
    'engine/agent/hooks/pre-workspace-scope-guard.js',
    'hosted/market-store.js',
    'mcp-server/diagnostics.js',
    'engine/mcp/tools/h3box-ssh.js',
    'engine/runs/store.js',   // 只在 VITEST 且没给 DB_PATH 时落临时库
  ]);
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'projects-data', 'market-data', '.cache', 'db', 'server', '.venv-rembg'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js') && !e.name.startsWith('_probe')) out.push(p);
    }
    return out;
  };
  it('mkdtemp / 路径拼接不直接用 os.tmpdir()', () => {
    const bad = [];
    for (const f of walk(root)) {
      const rel = path.relative(root, f).split(path.sep).join('/');
      if (ALLOW.has(rel) || rel.startsWith('scripts/')) continue;
      const src = fs.readFileSync(f, 'utf8');
      if (/\b(os\.)?tmpdir\(\)/.test(src)) bad.push(rel);
    }
    expect(bad, '改用 lib/server-tmp.js 的 makeServerTmpDir / serverTmpPath').toEqual([]);
  });
});
