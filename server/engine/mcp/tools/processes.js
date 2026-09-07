/**
 * 进程卡的四件工具（2026-09-07 桌面端·缝三）：start_process / read_process_log / stop_process / list_processes
 *
 * 只在本地版注册（capability `processes`：isLocal 且沙盒关）。托管版没有这四件，
 * 「绝不起 dev server」那套纪律在那边照旧。
 *
 * 为什么不直接用 SDK 的 Bash run_in_background：那条路的输出和句柄只在 SDK 会话里，
 * 用户在画布上看不见、会话结束进程也没人管。走登记表的进程有日志文件、有面板、
 * 随服务端生死。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { startProcess, stopProcess, readProcessLog, listProcesses, MAX_PER_PROJECT } from '../../process/registry.js';

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

function fmtProc(p) {
  const where = p.url ? ` · ${p.url}` : (p.port ? ` · port ${p.port}` : '');
  return `${p.id}  [${p.status}]  ${p.name}${where}  (pid ${p.pid ?? '-'}, started ${p.startedAt})`;
}

export function makeStartProcessTool({ projectId }) {
  return tool(
    'start_process',
    `Start a long-running process (dev server, watcher, backend) in the project folder and keep it
running after this tool returns. Use this instead of running \`npm run dev\` in Bash — Bash waits
for the command to finish and a dev server never finishes. Returns the process id, the first lines
of output, and the URL if the process printed one (e.g. http://localhost:5173). Then open the URL
with the browsing tools or tell the user. Read more output with read_process_log, stop with
stop_process. Processes die when NoDesign quits. Up to ${MAX_PER_PROJECT} per project.`,
    {
      command: z.string().min(1).max(500).describe('Shell command, e.g. "npm run dev" or "node server.js"'),
      name: z.string().max(80).optional().describe('Short label shown to the user (default: the command)'),
      cwd: z.string().max(400).optional().describe('Working directory relative to the project folder (default: the project folder)'),
      wait_ms: z.number().int().min(0).max(60000).optional().describe('How long to wait for a URL/port before returning (default 8000)'),
    },
    async (args) => {
      if (!projectId) return text('No project bound.', true);
      try {
        const { process: p, lines } = await startProcess({
          projectId, command: args.command, name: args.name, cwd: args.cwd, by: 'agent', waitMs: args.wait_ms ?? 8000,
        });
        const head = lines.length ? `\n--- first output ---\n${lines.join('\n')}` : '\n(no output yet)';
        const hint = p.status !== 'running'
          ? `\n\n⚠️ The process already ended (${p.status}, exit code ${p.exitCode}). Read the output above before retrying.`
          : (p.url ? `\n\nListening at ${p.url}` : `\n\nNo URL detected yet — call read_process_log later or pass a longer wait_ms.`);
        return text(`${fmtProc(p)}${head}${hint}`);
      } catch (err) {
        return text(`start_process failed: ${err.message}`, true);
      }
    },
  );
}

export function makeReadProcessLogTool({ projectId }) {
  return tool(
    'read_process_log',
    'Read the latest output of a process started with start_process (last N lines, default 100).',
    {
      id: z.string().min(1).max(40).describe('Process id from start_process / list_processes'),
      tail: z.number().int().min(1).max(400).optional().describe('How many trailing lines (default 100)'),
    },
    async (args) => {
      if (!projectId) return text('No project bound.', true);
      try {
        const { process: p, lines } = readProcessLog(projectId, args.id, { tail: args.tail ?? 100 });
        return text(`${fmtProc(p)}\n--- last ${lines.length} lines ---\n${lines.join('\n') || '(empty)'}`);
      } catch (err) {
        return text(err.message, true);
      }
    },
  );
}

export function makeStopProcessTool({ projectId }) {
  return tool(
    'stop_process',
    'Stop a process started with start_process (SIGTERM, then SIGKILL after 5s). The log stays readable.',
    { id: z.string().min(1).max(40).describe('Process id') },
    async (args) => {
      if (!projectId) return text('No project bound.', true);
      try {
        const p = await stopProcess(projectId, args.id);
        return text(`${fmtProc(p)}`);
      } catch (err) {
        return text(err.message, true);
      }
    },
  );
}

export function makeListProcessesTool({ projectId }) {
  return tool(
    'list_processes',
    'List processes of this project (running, exited, and records left from before NoDesign restarted).',
    {},
    async () => {
      if (!projectId) return text('No project bound.', true);
      const list = await listProcesses(projectId);
      return text(list.length ? list.map(fmtProc).join('\n') : '(no processes)');
    },
  );
}
