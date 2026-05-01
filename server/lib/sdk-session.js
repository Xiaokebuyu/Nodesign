/**
 * server/lib/sdk-session.js — SDK session API 调用 helper
 *
 * SDK 的 listSessions / getSessionMessages / forkSession 等同步 API 读
 * `process.env.CLAUDE_CONFIG_DIR` 决定从哪找 JSONL（probe 验证过：probe-listsessions.mjs）。
 * 我们 S1 把 CLAUDE_CONFIG_DIR per-project 设到 <workspace>/.claude/，
 * 但那是 query() spawn binary 时通过 env option 传的——server 进程自己的
 * process.env.CLAUDE_CONFIG_DIR 默认是空。
 *
 * 多 project 并发调 SDK session API 时 process.env mutation 会互相覆盖，
 * 所以串行化（按单一 key 'sdk-config' mutex）。读操作很快（<10ms 级别），
 * 串行不影响并发性能。
 *
 * 用法：
 *   const sessions = await withConfigDir(wsClaudeDir, () =>
 *     listSessions({ dir: wsRoot })
 *   );
 */

import { mutex } from 'async-mutex-lite';

export async function withConfigDir(configDir, fn) {
  return mutex('sdk-config', async () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = configDir;
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });
}
