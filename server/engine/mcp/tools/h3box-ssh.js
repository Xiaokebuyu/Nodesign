/**
 * mcp/tools/h3box-ssh.js — GPU 盒子 SSH 公用件（roll_film / paint_still 共用）
 *
 * 盒子 = featurize 按时租的 5090（.env NODESIGN_H3BOX_SSH/PORT/PASS，每次租机
 * 都换）。密码走 sshpass -e（SSHPASS 环境变量），没配密码就当 key 认证。
 */

import { spawn } from 'node:child_process';
import os from 'node:os';

/**
 * 盒子总开关（2026-08-17）。
 *
 * 盒子是站主手动开关的物理机，但 SSH 地址常年配在 .env 里 —— 所以「机器关着」
 * 跟「没配过」在代码里长得完全不一样：后者 boxConfig() 返回 null 能立刻兜底，
 * 前者会一路 SSH 到超时才失败（paint_still 单张 240s、krea2 400s，整批还要乘
 * 系数；roll_film 每镜 900s），agent 和用户一起干等几分钟，还看不出为什么。
 *
 * 这个开关让工具在**调用的第一行**就诚实说不可用。开机后把 .env 里那行改回 on
 * （或整行删掉，默认就是 on）。它管的是整台机器：paint_still 的五个模型和
 * roll_film 的 box 后端都住在上面。
 */
export const localBoxEnabled = () => (process.env.NODESIGN_LOCAL_BOX || 'on').toLowerCase() !== 'off';

/** 关机时给 agent 的统一说辞：说清原因、给替代路径、明确别重试 */
export const BOX_OFF_MSG = '本地 GPU 服务器当前离线（由平台手动启停）。以下能力'
  + '当前不可用：paint_still 的 noobai / noobai-eps / pony / anima / krea2 五个模型，'
  + '以及 roll_film 的本地后端。转告用户，生图改用 generate_image；使用本地产线需先启动服务器。'
  + '重试不会改变结果。';

export function boxConfig() {
  const target = process.env.NODESIGN_H3BOX_SSH || '';
  if (!target) return null;
  return {
    target,
    port: process.env.NODESIGN_H3BOX_PORT || '22',
    pass: process.env.NODESIGN_H3BOX_PASS || '',
  };
}

/** POSIX 单引号转义（远端 zsh/bash 规则相同） */
export const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * 跑一条 ssh/scp。永不 throw，resolve {code, out, err}；code=-1 表示本地 spawn 失败。
 * @param {{target:string,port:string,pass:string}} box
 * @param {'ssh'|'scp'} bin
 */
export function runBox(box, bin, args, { timeoutMs = 240_000, signal } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    let cmd = bin; let argv = args;
    if (box.pass) {
      env.SSHPASS = box.pass;
      cmd = 'sshpass'; argv = ['-e', bin, ...args];
    }
    const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out = (out + d).slice(-8000); });
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, timeoutMs);
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* */ } };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve({ code, out, err });
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e.message) }); });
  });
}

// 连接复用：首连付一次完整握手（跨境实测 ~4s），之后 10 分钟内的 ssh/scp 走同一条
// 隧道，每次 ~0.1s。socket 名带主机+端口，换租新盒（端口必变）不会撞旧 socket；
// master 空闲 10 分钟自灭，盒子重启后 auto 会自动弃掉死 socket 重连。
const CTRL = [
  '-o', 'ControlMaster=auto',
  '-o', `ControlPath=${os.tmpdir()}/h3box-cm-%r@%h-%p`,
  '-o', 'ControlPersist=600',
];

/** ssh 公共参数（-p 端口）；scp 用 scpArgs（-P 端口） */
export const sshArgs = (box) => [...CTRL, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10', '-p', box.port, box.target];
export const scpArgs = (box) => [...CTRL, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10', '-P', box.port];
