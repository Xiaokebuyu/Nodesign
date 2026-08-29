/**
 * projects/workspace-slots.js —— 角色位铺装（2026-08-28 建；08-29 收成一个位）
 *
 * 预注册的角色子代理定义（rp-role）**必须在会话启动前就在盘上**：会话中途写入的
 * agent 定义只有当时活着的那个 CLI 进程认得，换进程后永久 not found（08-28 三场
 * 真会话勘定，机制见 engine/agent/cast.js）。所以铺装挂在 ensureProjectWorkspace 里，
 * 跟着每次 ensure 走。
 *
 * 内容以代码为准：教义升级后重启即生效，也顺手把模型对定义体的手改抹平
 * （判据不建在模型可写的东西上 —— 派发闸照读文件核 tools，这里保证文件是正版）。
 *
 * 退役的旧位（rp-actor / rp-narrator）在这里**删文件**：留着的话老名字仍然派得出去，
 * 派出来的还是旧分工（写场面的那支笔已经收回主持人手里了）。
 */
import { promises as fs } from 'fs';
import path from 'path';
import { ROLE_SLOT, RETIRED_SLOTS, slotAgentFile } from '../engine/agent/cast.js';
import { MCP_SERVER_NAME } from '../engine/mcp/server-name.js';

export async function ensureActorSlots(root) {
  const dir = path.join(root, '.claude', 'agents');
  const file = path.join(dir, `${ROLE_SLOT}.md`);
  const want = slotAgentFile(MCP_SERVER_NAME);
  let have = null;
  try { have = await fs.readFile(file, 'utf8'); } catch { /* 还没有 */ }
  if (have !== want) await fs.writeFile(file, want, 'utf8');
  for (const old of RETIRED_SLOTS) {
    try { await fs.unlink(path.join(dir, `${old}.md`)); } catch { /* 本来就没有 */ }
  }
}
