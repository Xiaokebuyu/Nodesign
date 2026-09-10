/**
 * 「能不能用」要真去 import 一次（2026-09-10）。
 *
 * 09-10 站主机器上的病：组件包文件全在，能力表按 `fs.access(python.exe)` 报"可用"，
 * 而每次真跑都死在 `ImportError: DLL load failed ... 初始化例程失败`。
 * 这几条钉的是那次的教训：探针问的问题要跟用户要做的事是同一个问题。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const HELPER = new URL('./rembg.js', import.meta.url).pathname;

/** 造一个假 python：按参数决定 import 成不成 */
function fakePython(dir, { ok }) {
  const p = path.join(dir, 'python');
  fs.writeFileSync(p, ok
    ? '#!/bin/sh\nexit 0\n'
    : '#!/bin/sh\n>&2 echo "Traceback (most recent call last):"\n'
      + '>&2 echo "  File \\"<string>\\", line 1, in <module>"\n'
      + '>&2 echo "ImportError: DLL load failed while importing onnxruntime_pybind11_state: 动态链接库(DLL)初始化例程失败。"\n'
      + 'exit 1\n');
  fs.chmodSync(p, 0o755);
  return p;
}

let dir; let mod;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-rembg-'));
  // ⛔ 这台机器上跑着真的 Nodesign（生产），默认 socket 路径会被它的 rembg service 应答 ——
  // 判据于是量到了别人家的服务。指到一个不存在的 socket 上，才是在量被测的这一份
  process.env.NODESIGN_REMBG_SOCKET = path.join(dir, 'none.sock');
  // 每条用例要一份干净的模块状态（失败记在内存里）
  mod = await import(`${HELPER}?t=${Date.now()}${Math.random()}`);
});
afterEach(() => { delete process.env.NODESIGN_REMBG_PYTHON; delete process.env.NODESIGN_REMBG_SOCKET; fs.rmSync(dir, { recursive: true, force: true }); });

describe('checkImport', () => {
  it('import 不动：报的是 traceback 最后一行，不是调用栈', async () => {
    process.env.NODESIGN_REMBG_PYTHON = fakePython(dir, { ok: false });
    const r = await mod.checkImport();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('DLL load failed');
    expect(r.reason).not.toContain('Traceback');
    // 失败**不许**写进盘：用户装完运行库重探一下就该翻身
    expect(fs.existsSync(path.join(dir, '.nd-import-ok.json'))).toBe(false);
  });

  it('import 得动：记一张成功记号，第二次走记号（不再起子进程）', async () => {
    process.env.NODESIGN_REMBG_PYTHON = fakePython(dir, { ok: true });
    const first = await mod.checkImport();
    expect(first.ok).toBe(true);
    expect(first.cached).toBeUndefined();          // 第一次是真跑的
    expect(fs.existsSync(path.join(dir, '.nd-import-ok.json'))).toBe(true);
    expect(await mod.checkImport()).toEqual({ ok: true, cached: true });
  });

  it('换了 python（大小/时间变了）记号就作废，重新真跑', async () => {
    const py = fakePython(dir, { ok: true });
    process.env.NODESIGN_REMBG_PYTHON = py;
    await mod.checkImport();
    fakePython(dir, { ok: false });          // 同名换内容 = 换了组件
    const r = await mod.checkImport();
    expect(r.ok).toBe(false);
    expect(r.cached).toBeUndefined();
  });

  it('forgetImportCheck 撕掉成功记号（service 崩了之后叫它）', async () => {
    process.env.NODESIGN_REMBG_PYTHON = fakePython(dir, { ok: true });
    await mod.checkImport();
    expect(fs.existsSync(path.join(dir, '.nd-import-ok.json'))).toBe(true);
    await mod.forgetImportCheck();
    expect(fs.existsSync(path.join(dir, '.nd-import-ok.json'))).toBe(false);
  });
});

describe('isAvailable', () => {
  it('文件全在但 import 不动 → 不可用，理由里带真正的病因', async () => {
    process.env.NODESIGN_REMBG_PYTHON = fakePython(dir, { ok: false });
    const r = await mod.isAvailable();
    expect(r.available).toBe(false);
    expect(r.reason).toContain('DLL load failed');
  });
});

describe('rembgSetupHint', () => {
  it('组件包装的：说去组件页重装 / 装 VC++ 运行库，不说 venv', async () => {
    process.env.NODESIGN_REMBG_PYTHON = path.join(dir, 'components', 'rembg', 'python.exe');
    const hint = mod.rembgSetupHint();
    expect(hint).toContain('组件');
    expect(hint).toContain('vc_redist');
    expect(hint).not.toContain('venv');
  });

  it('自己 venv 装的：还是那句 venv 装法', async () => {
    const hint = mod.rembgSetupHint();
    expect(hint).toContain('.venv-rembg');
  });
});
