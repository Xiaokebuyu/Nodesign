#!/usr/bin/env node
/**
 * bin/nodesign.js — 本地分发版入口（`npx nodesign` / `nodesign`）。
 *
 * 它是一个很薄的壳：把 profile 钉成 local、把命令行参数翻译成 env、交给 bin/supervisor.js
 * 拉起 server/index.js，health 通了开一次浏览器。进程生命周期（重启码 75、挑端口、等 health、
 * 跑 SDK 自带的 claude）全在 supervisor 里，桌面版（desktop/main.js）用的是同一份，
 * 所有真正的配置决策则在 server/runtime/profile.js —— 这里两份都不复制。
 *
 *   nodesign                      # 数据在 ~/.nodesign，http://127.0.0.1:4001
 *   nodesign --port 5000          # 换端口
 *   nodesign --data-dir ./mydata  # 换数据目录（.env / config.json / 数据库 / 项目都在里面）
 *   nodesign --no-open            # 不自动开浏览器
 *   nodesign login                # 用 Claude 订阅：登录一次（转发给 SDK 自带的 claude auth login）
 *
 * 钥匙放 <数据目录>/.env：ANTHROPIC_API_KEY=...（或者本机 `claude login` 过，什么都不用填）；
 * 自己的模型插槽放 <数据目录>/config.json（形状见 server/runtime/local-config.js）。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PortBusyError,
  createSupervisor,
  pickPort,
  runBundledClaude,
  waitHealth,
} from './supervisor.js';

const serverEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), '../server/index.js');
const args = process.argv.slice(2);

// 子命令：`nodesign login` / `logout` / `auth status` —— 转发给 SDK 自带的 Claude CLI（用户不用再全局装一份 claude）。
if (['login', 'logout', 'auth'].includes(args[0])) {
  const sub = args[0] === 'auth' ? args.slice(1) : [args[0], ...args.slice(1)];
  const code = await runBundledClaude(['auth', ...sub], { onError: (m) => console.error(`[nodesign] ${m}`) });
  process.exit(code);
}

const flags = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--help' || a === '-h') { flags.help = true; continue; }
  if (a === '--no-open') { flags.noOpen = true; continue; }
  if (a === '--open') { flags.noOpen = false; continue; }
  const m = /^--(port|data-dir|host)(?:=(.*))?$/.exec(a);
  if (m) {
    const v = m[2] !== undefined ? m[2] : args[++i];
    if (v === undefined) { console.error(`--${m[1]} 需要一个值`); process.exit(2); }
    flags[m[1]] = v;
    continue;
  }
  console.error(`不认识的参数：${a}（--help 看用法）`);
  process.exit(2);
}

if (flags.help) {
  console.log(`用法：nodesign [--port N] [--data-dir DIR] [--host H] [--no-open]
  --port N        监听端口（默认 4001；env PORT）
  --data-dir DIR  数据目录：.env / config.json / 数据库 / 项目 / 缓存（默认 ~/.nodesign；env NODESIGN_DATA_DIR）
  --host H        监听地址（默认 127.0.0.1；没有登录墙，别改成 0.0.0.0）
  --no-open       启动后不自动打开浏览器
  login / logout / auth status   Claude 订阅登录态（不用另装 claude CLI）
钥匙：<数据目录>/.env 里写 ANTHROPIC_API_KEY=...；或本机已 \`claude login\` 则不用填。`);
  process.exit(0);
}

const env = { ...process.env };
env.NODESIGN_PROFILE = env.NODESIGN_PROFILE || 'local';
if (flags.port) env.PORT = String(flags.port);
if (flags['data-dir']) env.NODESIGN_DATA_DIR = flags['data-dir'];
if (flags.host) env.NODESIGN_HOST = flags.host;

const host = env.NODESIGN_HOST || '127.0.0.1';
let port;
try {
  port = await pickPort({ host, wanted: env.PORT ? Number(env.PORT) : null });
} catch (e) {
  if (!(e instanceof PortBusyError)) throw e;
  console.error(`[nodesign] ${e.message}${e.wanted ? '' : '，用 --port 指定一个'}`);
  process.exit(1);
}
if (!env.PORT && port !== 4001) console.log(`[nodesign] 4001 被占用，改用端口 ${port}`);
env.PORT = String(port);
const url = `http://${host}:${port}/`;

let opened = false;
const sup = createSupervisor({
  serverEntry,
  env,
  onRestart: () => console.log('[nodesign] 服务端请求重启，重新拉起…'),
  onExit: (code) => process.exit(code),
  onSpawn: () => {
    // 只开一次浏览器：重启后页面自己会刷新
    if (opened || flags.noOpen || env.NODESIGN_OPEN === '0') return;
    waitHealth(url, { alive: () => sup.running }).then((ok) => {
      if (!ok || opened) return;
      opened = true;
      openBrowser(url);
    });
  },
});

function openBrowser(target) {
  const cmd = process.platform === 'darwin' ? ['open', [target]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', target]]
      : ['xdg-open', [target]];
  try {
    const p = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true });
    p.on('error', () => { console.log(`[nodesign] 打不开浏览器，请手动访问 ${target}`); });
    p.unref();
  } catch {
    console.log(`[nodesign] 打不开浏览器，请手动访问 ${target}`);
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { sup.stop({ signal: sig }).then(() => process.exit(0)); });
}

sup.start();
