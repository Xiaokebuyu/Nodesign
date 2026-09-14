/**
 * codex 生图桥的子进程纪律（09-14）：对着一个假 codex（node 外壳 + 真干活的孙进程，跟 npm 版 codex 同形）跑。
 * 钉三件事：孤儿写不到交付物、超时杀整棵树、缺图时把 codex 最后一句带出来且像拒绝就不重试。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-'));
const stub = path.join(dir, 'fake-codex.mjs');
const counter = path.join(dir, 'calls');
const marker = path.join(dir, 'orphan-alive');
process.env.NODESIGN_CODEX_BIN = stub;
process.env.NODESIGN_CODEX_IMAGE_MODEL = '';
process.env.NODESIGN_CODEX_IMAGE_EFFORT = '';

// 外壳：记一次调用，按 FAKE_MODE 决定行为；真正写文件的是它 spawn 的孙进程（npm codex 就是这样）
fs.writeFileSync(stub, `#!/usr/bin/env node
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const n = (fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) : 0) + 1;
fs.writeFileSync(${JSON.stringify(counter)}, String(n));
const prompt = args.find((a) => a.includes('复制到精确路径'));
const out = /复制到精确路径 (.+?)（/.exec(prompt)[1];
const lastMsg = args[args.indexOf('-o') + 1];
const mode = process.env.FAKE_MODE;
const grandchild = (code) => spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
if (mode === 'ok') { fs.writeFileSync(out, 'PNG'); process.exit(0); }
if (mode === 'refuse') { fs.writeFileSync(lastMsg, "I can't generate that image because of the content policy."); process.exit(0); }
if (mode === 'hang-then-ok') {
  if (n === 1) {
    // 第一趟：孙进程 1.2 秒后截断自己那趟的目标并留下「我还活着」的记号，外壳一直挂着等超时
    const g = grandchild(\`setTimeout(() => { require('fs').writeFileSync(\${JSON.stringify(out)}, ''); require('fs').writeFileSync(\${JSON.stringify(${JSON.stringify(marker)})}, 'x'); }, 1200)\`);
    g.on('exit', () => {});
    setInterval(() => {}, 1000);
  } else { fs.writeFileSync(out, 'PNG2'); process.exit(0); }
}
`);
fs.chmodSync(stub, 0o755);

const { runCodexImageGen, buildCodexBridgePrompt } = await import('./codex-imagegen.js');
const makePrompt = (absOut) => buildCodexBridgePrompt({ prompt: 'a cat', aspectRatio: '1:1', absOut, refCount: 0 });
const reset = () => { for (const f of [counter, marker]) fs.rmSync(f, { force: true }); };
const leftovers = (d) => fs.readdirSync(d).filter((f) => f.startsWith('.codex-'));

describe.skipIf(process.platform === 'win32')('codex 生图桥（假 codex）', () => {
  beforeAll(() => { fs.mkdirSync(path.join(dir, 'out'), { recursive: true }); });

  it('成功：落在临时点文件、rename 成交付物，不留残件', async () => {
    reset(); process.env.FAKE_MODE = 'ok';
    const expectFile = path.join(dir, 'out', 'a.png');
    await runCodexImageGen({ makePrompt, refPaths: [], cwd: path.dirname(expectFile), expectFile });
    expect(fs.readFileSync(expectFile, 'utf8')).toBe('PNG');
    expect(leftovers(path.dirname(expectFile))).toEqual([]);
  });

  it('⛔ 09-14 实证：第一趟超时，孙进程被连根杀掉，写不坏第二趟交付的图', async () => {
    reset(); process.env.FAKE_MODE = 'hang-then-ok';
    const expectFile = path.join(dir, 'out', 'b.png');
    await runCodexImageGen({ makePrompt, refPaths: [], cwd: path.dirname(expectFile), expectFile, timeoutMs: 500 });
    await new Promise((r) => setTimeout(r, 1800));   // 等过孙进程原本动手的时刻
    expect(fs.existsSync(marker)).toBe(false);          // 孙进程没活到那一刻
    expect(fs.readFileSync(expectFile, 'utf8')).toBe('PNG2');
    expect(leftovers(path.dirname(expectFile))).toEqual([]);
  }, 10_000);

  it('缺图：报错带 codex 最后一句；像拒绝就不重试', async () => {
    reset(); process.env.FAKE_MODE = 'refuse';
    const expectFile = path.join(dir, 'out', 'c.png');
    await expect(runCodexImageGen({ makePrompt, refPaths: [], cwd: path.dirname(expectFile), expectFile }))
      .rejects.toThrow(/content policy/);
    expect(fs.readFileSync(counter, 'utf8')).toBe('1');
    expect(fs.existsSync(expectFile)).toBe(false);
  });
});
