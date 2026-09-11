/**
 * server/engine/process/registry.js — 进程卡的登记表（2026-09-07 桌面端原生范式·缝三）
 *
 * 「agent 起一个长驻进程」在这之前全仓一处都没有（调查报告专题 C）。这里是那份基础设施：
 *
 *   - 一个项目一张登记表：起（spawn）、看（日志尾随）、停（先 TERM 后 KILL，杀整棵树）、重开
 *   - 端口不分配，认：dev server 自己挑端口，我们从它的输出里认出 `http://localhost:5173`
 *   - 日志落 `<画布根>/.nd/processes/<id>.log`，记录落同目录 `<id>.json`。放 `.nd/` 是因为
 *     它们是基础设施不是产物，扫描器不进点目录，画布上不会多出一堆 json 卡
 *   - 状态变化经项目 EventBus 广播 `process.changed` / `process.log`，前端的进程面板靠它活
 *   - 进程随服务端活：shutdown 全杀（server/index.js），不做跨会话存活 —— 那撞 auto 模式的硬拦
 *
 * 借了三块半成品的纪律：rembg-launcher 的两段式停、supervisor 的 TERM→KILL 阶梯、
 * browse/registry 的「满了报错不静默排队」。四样从零：日志、认端口、重开、面板。
 */

import { spawn } from 'node:child_process';
import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getWorkspaceRoot, getAgentCwd } from '../../projects/workspace.js';
import { getProjectBus } from '../../ws/broker.js';
import { agentInheritedEnv } from '../../runtime/agent-env.js';

export const MAX_PER_PROJECT = 6;
const RING_LINES = 400;
const LOG_BATCH_MS = 120;
const PROC_DIR = path.join('.nd', 'processes');

/** @type {Map<string, Map<string, Entry>>} projectId → id → entry */
const registry = new Map();

/** 输出里认端口的三种写法：完整 URL、`port 5173`、`:5173` 独占尾巴。localhost 一族优先。 */
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\])(?::(\d{2,5}))?(\/[^\s'"`)]*)?/i;
const PORT_RE = /\b(?:port|端口)\s*[:=]?\s*(\d{2,5})\b/i;
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function procError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function bucket(projectId) {
  let m = registry.get(projectId);
  if (!m) { m = new Map(); registry.set(projectId, m); }
  return m;
}

function dirFor(projectId) {
  return path.join(getWorkspaceRoot(projectId), PROC_DIR);
}

/** 对外形状（不带子进程句柄和环形缓冲） */
function view(e) {
  return {
    id: e.id, projectId: e.projectId, name: e.name, command: e.command, cwd: e.cwd, by: e.by,
    pid: e.pid, status: e.status, startedAt: e.startedAt, exitedAt: e.exitedAt,
    exitCode: e.exitCode, signal: e.signal, port: e.port, url: e.url,
    logFile: e.logFile, lastLine: e.ring.length ? e.ring[e.ring.length - 1] : '',
  };
}

async function writeRecord(e) {
  try {
    await fs.mkdir(path.dirname(e.recordFile), { recursive: true });
    await fs.writeFile(e.recordFile, JSON.stringify(view(e), null, 2) + '\n', 'utf8');
  } catch (err) {
    console.warn(`[process] record write failed ${e.id}: ${err.message}`);
  }
}

function publish(e, type, extra = {}) {
  try {
    getProjectBus(e.projectId).publish({ type, process: view(e), ...extra, ts: new Date().toISOString() });
  } catch (err) {
    console.warn(`[process] publish ${type} failed: ${err.message}`);
  }
}

function detectPort(e, line) {
  if (e.port) return;
  const m = URL_RE.exec(line);
  if (m && m[1]) {
    e.port = Number(m[1]);
    e.url = `http://localhost:${e.port}${m[2] && m[2] !== '/' ? m[2] : ''}`;
  } else {
    const p = PORT_RE.exec(line);
    if (p) { e.port = Number(p[1]); e.url = `http://localhost:${e.port}`; }
  }
  if (e.port) { publish(e, 'process.changed'); writeRecord(e); }
}

function pushLine(e, line) {
  const clean = line.replace(ANSI_RE, '').replace(/\r$/, '');
  if (!clean.trim()) return;
  e.ring.push(clean);
  if (e.ring.length > RING_LINES) e.ring.splice(0, e.ring.length - RING_LINES);
  e.logStream?.write(clean + '\n');
  e.pendingLines.push(clean);
  if (!e.flushTimer) {
    e.flushTimer = setTimeout(() => {
      e.flushTimer = null;
      const lines = e.pendingLines.splice(0);
      if (lines.length) publish(e, 'process.log', { lines });
    }, LOG_BATCH_MS);
    e.flushTimer.unref?.();
  }
  detectPort(e, clean);
}

function attachStream(e, stream) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      pushLine(e, buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
    // 没换行的进度条（npm install 那种 \r 刷新）：攒到 2k 也当一行吐出来，别把日志憋死
    if (buf.length > 2048) { pushLine(e, buf); buf = ''; }
  });
  stream.on('end', () => { if (buf.trim()) pushLine(e, buf); buf = ''; });
}

/**
 * 起一个进程。command 交给 shell（用户写的就是 shell 命令）；cwd 默认 agent 站的地方。
 * 起来后等到认出端口或 waitMs 到期再返回，返回值带首屏日志 —— agent 一眼知道起没起来。
 */
export async function startProcess({ projectId, command, name = null, cwd = null, by = 'agent', env = {}, waitMs = 8000 }) {
  if (!projectId) throw procError('NO_PROJECT', 'No project bound.');
  if (typeof command !== 'string' || !command.trim()) throw procError('COMMAND_REQUIRED', 'command 不能为空');
  const b = bucket(projectId);
  const running = [...b.values()].filter((x) => x.status === 'running').length;
  if (running >= MAX_PER_PROJECT) {
    throw procError('TOO_MANY_PROCESSES', `这个项目已经有 ${running} 个进程在跑（上限 ${MAX_PER_PROJECT}），先停一个`, 409);
  }
  const root = getAgentCwd(projectId);
  const wd = cwd ? path.resolve(root, cwd) : root;
  const id = `p_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`;
  const dir = dirFor(projectId);
  await fs.mkdir(dir, { recursive: true });
  const e = {
    id, projectId, name: (name || command).slice(0, 80), command: command.trim(), cwd: wd, by,
    pid: null, status: 'running', startedAt: new Date().toISOString(), exitedAt: null,
    exitCode: null, signal: null, port: null, url: null,
    logFile: path.join(dir, `${id}.log`), recordFile: path.join(dir, `${id}.json`),
    ring: [], pendingLines: [], flushTimer: null, logStream: null, child: null, stopping: false,
  };
  e.logStream = createWriteStream(e.logFile, { flags: 'a' });
  e.logStream.on('error', (err) => console.warn(`[process] log stream ${id}: ${err.message}`));
  e.logStream.write(`# ${e.startedAt} $ ${e.command}\n# cwd ${wd}\n`);

  // 进程里跑的是 agent / 用户写的代码：底子跟 agent 的 Bash 一样用 agentInheritedEnv（不带宿主会话的 token、NODE_ENV=production）
  const child = spawn(e.command, {
    cwd: wd,
    env: { ...agentInheritedEnv(), ...env, FORCE_COLOR: '0', NO_COLOR: '1', PWD: wd },
    shell: true,
    windowsHide: true,
    // posix 上自成进程组，停的时候 kill(-pid) 连子孙一起；win32 用 taskkill /T
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  e.child = child;
  e.pid = child.pid ?? null;
  b.set(id, e);
  attachStream(e, child.stdout);
  attachStream(e, child.stderr);

  const settle = (status, code, signal) => {
    if (e.status !== 'running') return;
    e.status = status; e.exitCode = code ?? null; e.signal = signal ?? null;
    e.exitedAt = new Date().toISOString();
    e.child = null;
    e.logStream?.end(`# ${e.exitedAt} exit ${status} code=${code} signal=${signal}\n`);
    e.logStream = null;
    publish(e, 'process.changed');
    writeRecord(e);
  };
  child.on('error', (err) => { pushLine(e, `[spawn error] ${err.message}`); settle('failed', null, null); });
  child.on('exit', (code, signal) => settle(e.stopping ? 'stopped' : (code === 0 ? 'exited' : 'failed'), code, signal));

  publish(e, 'process.changed');
  await writeRecord(e);

  // 等首屏：认出端口、进程退出、或超时，三者先到
  const deadline = Date.now() + Math.max(0, waitMs);
  while (Date.now() < deadline && e.status === 'running' && !e.port) {
    await new Promise((r) => setTimeout(r, 150));
  }
  return { process: view(e), lines: e.ring.slice(-40) };
}

function killTree(e, signal) {
  if (!e.pid) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/PID', String(e.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* 已经没了 */ }
    return;
  }
  try { process.kill(-e.pid, signal); } catch {
    try { process.kill(e.pid, signal); } catch { /* 已经没了 */ }
  }
}

/** 停：先 SIGTERM，timeoutMs 内没走就 SIGKILL（跟 supervisor 同一个阶梯） */
export async function stopProcess(projectId, id, { timeoutMs = 5000 } = {}) {
  const e = bucket(projectId).get(id);
  if (!e) throw procError('PROCESS_NOT_FOUND', `没有这个进程：${id}`, 404);
  if (e.status !== 'running') return view(e);
  e.stopping = true;
  killTree(e, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (e.status === 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (e.status === 'running') {
    killTree(e, 'SIGKILL');
    const hard = Date.now() + 2000;
    while (e.status === 'running' && Date.now() < hard) await new Promise((r) => setTimeout(r, 100));
  }
  return view(e);
}

/** 重开：同命令同 cwd 起一个新记录（旧记录留着，日志不混） */
export async function restartProcess(projectId, id, opts = {}) {
  const e = bucket(projectId).get(id);
  if (!e) throw procError('PROCESS_NOT_FOUND', `没有这个进程：${id}`, 404);
  if (e.status === 'running') await stopProcess(projectId, id);
  return startProcess({ projectId, command: e.command, name: e.name, cwd: e.cwd, by: opts.by || e.by, waitMs: opts.waitMs });
}

export function readProcessLog(projectId, id, { tail = 200 } = {}) {
  const e = bucket(projectId).get(id);
  if (!e) throw procError('PROCESS_NOT_FOUND', `没有这个进程：${id}`, 404);
  const n = Math.max(1, Math.min(RING_LINES, tail));
  return { process: view(e), lines: e.ring.slice(-n) };
}

/** 登记表 + 盘上残留：服务端重启前起的进程记录还在 .nd/processes/，但人已经不在了，标 lost */
export async function listProcesses(projectId) {
  const b = bucket(projectId);
  const out = [...b.values()].map(view);
  const seen = new Set(out.map((p) => p.id));
  try {
    const dir = dirFor(projectId);
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -5);
      if (seen.has(id)) continue;
      try {
        const rec = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
        if (rec.status === 'running') rec.status = 'lost';
        out.push(rec);
      } catch { /* 坏记录跳过 */ }
    }
  } catch { /* 目录还没有 */ }
  out.sort((a, c) => String(c.startedAt).localeCompare(String(a.startedAt)));
  return out;
}

/** 只删已经不在跑的记录（日志文件一起删） */
export async function removeProcess(projectId, id) {
  const b = bucket(projectId);
  const e = b.get(id);
  if (e && e.status === 'running') throw procError('PROCESS_RUNNING', '还在跑，先停再删', 409);
  b.delete(id);
  const dir = dirFor(projectId);
  await Promise.all([`${id}.json`, `${id}.log`].map((f) => fs.rm(path.join(dir, f), { force: true })));
  return true;
}

/** 服务端退出时全杀（不做跨会话存活） */
export async function stopAllProcesses(reason = 'shutdown') {
  const jobs = [];
  for (const [pid, b] of registry) {
    for (const e of b.values()) {
      if (e.status === 'running') {
        pushLine(e, `[nodesign] ${reason}: stopping`);
        jobs.push(stopProcess(pid, e.id, { timeoutMs: 2500 }).catch(() => {}));
      }
    }
  }
  await Promise.all(jobs);
}

/**
 * 三道出网闸（ssrf-guard.checkUrl / browse-proxy.resolveAllowed / screenshot-url 词法预筛）共用的
 * 唯一口子：只有 localhost / 127.0.0.1 / ::1 三个写法 + 登记表里**在跑**的端口才放。
 * 别的本机地址（内网 IP、公网 IP 打自己）照旧拒 —— 这口子只开给 agent 自己起的进程。
 */
export function isRegisteredLoopback(host, port) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h !== 'localhost' && h !== '127.0.0.1' && h !== '::1') return false;
  return isRegisteredPort(Number(port));
}

/** 给单测和 SSRF 闸用：这个端口是不是登记表里某个活进程的 */
export function isRegisteredPort(port) {
  for (const b of registry.values()) {
    for (const e of b.values()) if (e.status === 'running' && e.port === port) return true;
  }
  return false;
}
