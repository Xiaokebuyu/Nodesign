/**
 * 能力位探测 + 工具闸。whichBinary 用临时目录当 PATH 验；闸用子进程真起一遍 MCP 工具表（probe 之后）验
 * ——描述前缀与调用期拦截是 agent 真看到的东西，不在同进程里 mock state。
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { whichBinary, CAPABILITY_DEFS, chromiumFix } from './capabilities.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('whichBinary', () => {
  it('按 PATH 与额外目录找文件；找不到 null；绝对路径直接判存在', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nd-which-'));
    // Windows 上 which 按 PATHEXT 找（.exe/.cmd…），没扩展名的文件在那边本来就不算可执行文件
    const f = path.join(dir, process.platform === 'win32' ? 'fakebin.cmd' : 'fakebin');
    writeFileSync(f, '#!/bin/sh\n'); chmodSync(f, 0o755);
    const saved = process.env.PATH;
    process.env.PATH = '/nonexistent-dir';
    try {
      expect(whichBinary('fakebin')).toBeNull();
      expect(whichBinary('fakebin', [dir])).toBe(f);
      expect(whichBinary(f)).toBe(f);
      expect(whichBinary(path.join(dir, 'nope'))).toBeNull();
    } finally { process.env.PATH = saved; }
  });
  it('每个能力位都有 fix 装法与 uses 说明（界面照它画表）', () => {
    for (const d of CAPABILITY_DEFS) {
      expect(d.fix, d.id).toBeTruthy(); expect(d.uses, d.id).toBeTruthy(); expect(['required', 'feature']).toContain(d.level);
    }
  });
});

/**
 * 缺 Chromium 的装法（09-17，iss_mtudxax7_86c5 / iss_mu0e6ur9_irvd）：本地版（npx / 桌面）没有 npx 可用、
 * playwright 官方源国内不通，要指向「设置 → 组件」；托管版保持原文。形态在模块加载时定，所以两种各起一个子进程。
 */
describe('Chromium 装法按形态给', () => {
  it('chromiumFix：本地 → 设置 → 组件；托管 → npx 原文', () => {
    expect(chromiumFix(true)).toBe('设置 → 组件 → Chromium 安装');
    expect(chromiumFix(false)).toBe('npx playwright install chromium');
  });
  it('能力表 chromium 行的 fix 跟着运行形态走（local / hosted 子进程）', { timeout: 30_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nd-cfix-'));
    const code = `
      import { CAPABILITY_DEFS } from './capabilities.js';
      const d = CAPABILITY_DEFS.find((x) => x.id === 'chromium');
      console.log(JSON.stringify({ fix: typeof d.fix === 'function' ? d.fix() : d.fix }));`;
    const base = { ...process.env }; delete base.VITEST;
    const run = (profile) => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: here, env: { ...base, NODESIGN_PROFILE: profile, NODESIGN_DATA_DIR: dir }, encoding: 'utf8', timeout: 30_000 });
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout.trim().split('\n').pop()).fix;
    };
    expect(run('local')).toBe('设置 → 组件 → Chromium 安装');
    expect(run('hosted')).toBe('npx playwright install chromium');
  });
  it('装法文案只有一份：服务端源码里别处不再写死 npx playwright install', () => {
    const root = path.resolve(here, '..');
    const offenders = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (['node_modules', 'projects-data', 'db', 'ops', 'scripts'].includes(e.name) || e.name.startsWith('.')) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.js') || e.name.includes('.test.') || p.endsWith(path.join('runtime', 'chromium-fix.js'))) continue;
        if (/npx playwright install/.test(readFileSync(p, 'utf8'))) offenders.push(path.relative(root, p));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe('capability-gate（子进程真起工具表）', () => {
  /**
   * ⏱ 30s（2026-08-30 从默认 5s 抬上来）：这一条要**起一个子进程**、在里面 import
   * 整张 MCP 工具表、再 probe 外部二进制（soffice 之类）。单跑 1.4s，跑全套时实测
   * 7.6s / 10.3s —— 5s 的闸量的是这台机器此刻的负载，不是这条断言本身。
   * 加一个新测试文件（几个 git init 的临时工作区）就能把它顶红，红了还查不出所以然。
   * 30s 留够余量，真卡死照样会失败。
   */
  it('缺钥匙的 web_search：描述前缀 ⛔ + 调用期 isError；有钥匙：原样；build_docx 缺 LibreOffice 只加说明不拦', { timeout: 30_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nd-gate-'));
    const code = `
      import { probeCapabilities, capabilityState } from './capabilities.js';
      import { createNodesignMcpServer } from '../engine/mcp/index.js';
      import { withCapabilityGate } from '../engine/mcp/capability-gate.js';
      await probeCapabilities();
      const s = createNodesignMcpServer({ workspaceRoot: '${dir}', sharedRoot: '${dir}', projectId: 'p', sessionId: 's' });
      // SDK 的 createSdkMcpServer 把工具收进 instance；拿 toolNames 证明没少注册，再直接对单件工具做闸
      const fake = { name: 'web_search', description: 'ORIG', inputSchema: {}, handler: async () => ({ content: [{ type: 'text', text: 'ran' }] }) };
      const gated = withCapabilityGate(fake);
      const called = await gated.handler({});
      const docx = withCapabilityGate({ name: 'build_docx', description: 'ORIG', inputSchema: {}, handler: async () => ({ ok: 1 }) });
      console.log(JSON.stringify({ n: s.toolNames.length, ws: capabilityState('webSearch')?.available, lo: capabilityState('libreoffice')?.available, desc: gated.description.slice(0, 40), isError: !!called.isError, text: called.content?.[0]?.text?.slice(0, 30), docxDesc: docx.description, docxRan: (await docx.handler({})).ok }));`;
    const base = { ...process.env }; delete base.VITEST;
    for (const k of Object.keys(base)) if (/^NODESIGN_(TAVILY|EXA|BAIDU_QIANFAN|ZHIPU)_KEY$/.test(k)) delete base[k];
    const run = (extra) => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: here, env: { ...base, NODESIGN_PROFILE: 'local', NODESIGN_DATA_DIR: dir, PATH: '/nonexistent', ...extra }, encoding: 'utf8', timeout: 60_000 });
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout.trim().split('\n').pop());
    };
    const noKey = run({});
    expect(noKey.n).toBeGreaterThan(40);
    expect(noKey.ws).toBe(false);
    expect(noKey.desc).toMatch(/^⛔ CURRENTLY UNAVAILABLE/);
    expect(noKey.isError).toBe(true);
    expect(noKey.text).toMatch(/web_search 不可用/);
    // LibreOffice 不看 PATH 也会去常见安装位置找（这台机器 /usr/lib/libreoffice/program 就有），所以按探测结果分支断言
    if (noKey.lo) expect(noKey.docxDesc).toBe('ORIG'); else expect(noKey.docxDesc).toMatch(/^ORIG\n\n⚠️/);
    expect(noKey.docxRan).toBe(1);   // note 模式无论如何不拦
    const withKey = run({ NODESIGN_TAVILY_KEY: 'x' });
    expect(withKey.ws).toBe(true);
    expect(withKey.desc).toBe('ORIG');
    expect(withKey.isError).toBe(false);
  });
});
