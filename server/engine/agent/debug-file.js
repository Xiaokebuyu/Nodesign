/**
 * engine/agent/debug-file.js —— 本地版给每个会话开 Claude Code 的调试日志（SDK `debugFile`，等于 `--debug-file`）。
 * 2026-09-08：站主报「桌面端 GLM 首发几乎必出 API 重试中（1/10）— unknown」，api_retry 事件只带 error 种类，
 * 底层原因（连接错误 / 状态码 / 响应体）只在调试日志里；而 SDK 默认不写它，`~/.claude/debug/<sid>.txt` 根本不存在。
 * 只在本地版开：托管版几十个会话同时写会把 1 vCPU 的盘写满。文件落 <dataRoot>/logs/claude-debug/<sid>.txt，
 * 诊断端点的 session_debug_log 先看这里再看 ~/.claude/debug。开会话时顺手清 7 天前的旧文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { platform } from '../../runtime/platform.js';

const KEEP_MS = 7 * 24 * 3600 * 1000;

export function claudeDebugDir(dataRoot = platform.dataRoot) {
  return dataRoot ? path.join(dataRoot, 'logs', 'claude-debug') : null;
}

/** query options 里要合进去的那一小块；托管版或没有数据目录时是空对象 */
export function claudeDebugOptions(sessionId, { isLocal = platform.isLocal, dataRoot = platform.dataRoot, now = Date.now() } = {}) {
  const dir = isLocal ? claudeDebugDir(dataRoot) : null;
  if (!dir || !/^[0-9a-f-]{36}$/i.test(String(sessionId))) return {};
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try { if (now - fs.statSync(p).mtimeMs > KEEP_MS) fs.unlinkSync(p); } catch { /* 别人的文件，算了 */ }
    }
  } catch { return {}; }
  return { debugFile: path.join(dir, `${sessionId}.txt`) };
}
