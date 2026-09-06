/**
 * bin/supervisor.js — 本地分发版的进程生命周期，命令行版（bin/nodesign.js）与桌面版
 * （desktop/main.js）共用这一份。
 *
 * 为什么抽出来：两个入口要做的事完全一样（挑端口 → 拉起 server/index.js → 以 75 退出就
 * 重新拉起 → 等 /api/health 通），差别只在"起来之后拿这个 URL 干什么"：命令行版开系统
 * 浏览器，桌面版把它加载进 BrowserWindow。把相同的那段复制成两份，下次改重启语义就会
 * 只改一边。
 *
 * 这里只管进程，不做任何配置决策 —— 数据目录 / 端口默认值 / .env 加载全在
 * server/runtime/profile.js，调用方把 env 备好传进来即可。
 *
 * ⚠️ 与命令行版的一个区别：Electron 里 process.execPath 是 Electron 可执行文件而不是 node，
 * 所以桌面版要传 runtime.env.ELECTRON_RUN_AS_NODE='1'，让同一个可执行文件以 node 模式跑
 * server/index.js。随之而来的是原生模块（better-sqlite3 不是 N-API，ABI 锁运行时版本）必须
 * 按 Electron 的 ABI 编译，那件事在打包配置里办（electron-builder 的 npmRebuild）。
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

/** 服务端用这个退出码表示"配置改了，请重新拉起我"（见 server/api/local.js） */
export const RESTART_EXIT_CODE = 75;

/** pickPort 找不到空位时抛它，调用方自己决定怎么告诉用户（命令行打印 / 桌面弹窗） */
export class PortBusyError extends Error {
  constructor(message, { wanted = null, from = null, span = null } = {}) {
    super(message);
    this.name = 'PortBusyError';
    this.wanted = wanted;
    this.from = from;
    this.span = span;
  }
}

/**
 * 挑一个能监听的端口。
 * 指定了 wanted 就只试它，占用则抛错（用户明确要这个端口，替他换等于把他的书签弄坏）；
 * 没指定则从 from 往上找第一个空的 —— 4001 在别人机器上常有主（Cursor、QQ 都见过），
 * 让用户自己换端口不如自己让一步。
 */
export async function pickPort({ host = '127.0.0.1', wanted = null, from = 4001, span = 50 } = {}) {
  const free = (p) => new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(p, host, () => srv.close(() => resolve(true)));
  });
  if (wanted) {
    if (await free(wanted)) return wanted;
    const how = process.platform === 'win32' ? `netstat -ano | findstr :${wanted}` : `lsof -i :${wanted}`;
    throw new PortBusyError(`端口 ${wanted} 已被占用（查占用：${how}）`, { wanted });
  }
  for (let p = from; p < from + span; p++) if (await free(p)) return p;
  throw new PortBusyError(`${from}～${from + span - 1} 全被占用`, { from, span });
}

/** SDK 平台包里的 claude 可执行：@anthropic-ai/claude-agent-sdk-<platform>-<arch>[-musl]/claude[.exe] */
export function bundledClaudePath() {
  const require = createRequire(import.meta.url);
  const musl = process.platform === 'linux' && (() => {
    try { return fs.readFileSync('/usr/bin/ldd', 'utf8').includes('musl'); } catch { return false; }
  })();
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${musl ? '-musl' : ''}`;
  const dir = path.dirname(require.resolve(`${pkg}/package.json`));
  return path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
}

/**
 * 跑一发 SDK 自带的 claude CLI（登录 / 登出 / 查登录态），用户不用再全局装一份。
 * 配置目录跟服务端同一个（platform.js 的 claudeConfigDir），否则登录态落在别处、
 * 服务端的 claudeAuthPresent() 看不见。
 */
export function runBundledClaude(cliArgs, { stdio = 'inherit', onError = null } = {}) {
  return new Promise((resolve) => {
    let bin;
    try {
      bin = bundledClaudePath();
    } catch (e) {
      onError?.(`找不到 SDK 自带的 claude 可执行：${e.message}`);
      resolve(1);
      return;
    }
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const cfgDir = process.env.NODESIGN_CONFIG_DIR || path.join(home, '.claude');
    const p = spawn(bin, cliArgs, { stdio, env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir } });
    p.on('error', (e) => { onError?.(`起不来 claude：${e.message}`); resolve(1); });
    p.on('exit', (c) => resolve(c ?? 1));
  });
}

/**
 * 服务端子进程的看护者。
 *
 *   const sup = createSupervisor({ serverEntry, env, onRestart, onExit });
 *   sup.start();            // 拉起；以 RESTART_EXIT_CODE 退出会自动再拉起
 *   await sup.stop();       // 停（先 SIGTERM，超时 SIGKILL）
 *
 * onExit(code, signal, err?) 只在**真的结束**时调一次（重启不算结束）。spawn 失败也算结束，err 带原因。
 */
export function createSupervisor({
  serverEntry,
  env = process.env,
  runtime = process.execPath,
  runtimeArgs = [],
  stdio = 'inherit',
  killTimeoutMs = 5000,
  onRestart = null,
  onSpawn = null,
  onExit = null,
} = {}) {
  let child = null;
  let stopping = false;

  function start() {
    child = spawn(runtime, [...runtimeArgs, serverEntry], { env, stdio });
    onSpawn?.(child);
    // spawn 本身失败（可执行文件不在 / 没权限）只发 'error' 不发 'exit'；不接住就是未捕获异常，
    // 命令行版直接崩栈、桌面版一个通用崩溃框什么都不说。当成"真的结束"报给调用方。
    child.on('error', (err) => {
      if (!child) return;   // exit 已经处理过（比如 kill 失败那种 error）
      child = null;
      onExit?.(1, null, err);
    });
    child.on('exit', (code, signal) => {
      child = null;
      if (stopping) { onExit?.(code ?? 0, signal); return; }
      if (code === RESTART_EXIT_CODE) { onRestart?.(); start(); return; }
      onExit?.(code ?? (signal ? 1 : 0), signal);
    });
    return child;
  }

  /** 停子进程。已经停了就直接返回；SIGTERM 超时没走就 SIGKILL（别让退出流程挂住） */
  function stop({ signal = 'SIGTERM' } = {}) {
    stopping = true;
    if (!child) return Promise.resolve();
    const dying = child;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { try { dying.kill('SIGKILL'); } catch { /* 已经没了 */ } }, killTimeoutMs);
      timer.unref?.();
      dying.once('exit', () => { clearTimeout(timer); resolve(); });
      try { dying.kill(signal); } catch { clearTimeout(timer); resolve(); }
    });
  }

  return {
    start,
    stop,
    get pid() { return child?.pid ?? null; },
    get running() { return !!child; },
    get stopping() { return stopping; },
  };
}

/**
 * 等 /api/health 通。开早了用户看到的是一页"无法连接"。
 * alive() 让调用方在子进程已经死掉时提前放弃（别干等满 20 秒）。
 */
export function waitHealth(url, { timeoutMs = 20_000, intervalMs = 300, alive = () => true } = {}) {
  const base = url.endsWith('/') ? url : `${url}/`;
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const retry = () => {
      if (Date.now() >= deadline) { resolve(false); return; }
      setTimeout(tick, intervalMs).unref?.();
    };
    const tick = () => {
      if (!alive()) { resolve(false); return; }
      const req = http.get(`${base}api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve(true); else retry();
      });
      req.on('error', retry);
      req.setTimeout(1000, () => { req.destroy(); });
    };
    tick();
  });
}
