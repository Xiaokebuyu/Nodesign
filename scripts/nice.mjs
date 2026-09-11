#!/usr/bin/env node
/**
 * scripts/nice.mjs — 跨平台的 `nice -n 15 <命令>`（09-11）
 *
 * 为什么要降优先级：开发机就是生产机，全量测试会把 CPU 吃满，生产的回合跟着卡。
 * 原来 package.json 里直接写 `nice -n 15 vitest run`，Windows 上没有 nice，`npm test` 当场失败 ——
 * 而桌面版只在 Windows 上发，这条命令在 Windows 上跑不起来，就等于没有任何 Windows 上的测试信号。
 *
 * 做法：先把自己的优先级降下来（os.setPriority，Windows 上映射成"低于正常"），再起子进程，
 * 子进程继承。降不下来不算错，照跑。退出码原样透传。
 *
 * 用法：node scripts/nice.mjs vitest run -c vitest.server.config.js
 */
import os from 'node:os';
import { spawn } from 'node:child_process';

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('用法：node scripts/nice.mjs <命令> [参数...]');
  process.exit(2);
}
try { os.setPriority(0, 15); } catch { /* 没权限或平台不支持：照跑 */ }

// Windows 上 npm 装的命令是 .cmd 垫片，不经 shell 起不来；POSIX 上不走 shell，参数原样传
const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
child.on('error', (err) => { console.error(`[nice] 起不来 ${cmd}：${err.message}`); process.exit(127); });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
