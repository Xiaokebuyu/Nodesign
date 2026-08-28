/**
 * projects/workspace-slots.js —— 演员位铺装（2026-08-28 演员位重构；棘轮拆件）
 *
 * 预注册的 RP 子代理定义（rp-actor / rp-narrator）**必须在会话启动前就在盘上**：
 * 会话中途写入的 agent 定义只有当时活着的 CLI 进程认得，resume 后永久 not found
 * （08-28 三场真会话勘定，机制见 engine/agent/cast.js）。所以铺装挂在
 * ensureProjectWorkspace 里，跟着每次 ensure 走。
 *
 * 内容以代码为准：教义升级后重启即生效，也顺手把模型对定义体的手改抹平
 * （判据不建在模型可写的东西上 —— 派发闸照读文件核 tools，这里保证文件是正版）。
 */
import { promises as fs } from 'fs';
import path from 'path';
import { SLOT_TYPES, slotAgentFile } from '../engine/agent/cast.js';
import { MCP_SERVER_NAME } from '../engine/mcp/server-name.js';

export async function ensureActorSlots(root) {
  for (const slot of Object.keys(SLOT_TYPES)) {
    const file = path.join(root, '.claude', 'agents', `${slot}.md`);
    const want = slotAgentFile(slot, MCP_SERVER_NAME);
    let have = null;
    try { have = await fs.readFile(file, 'utf8'); } catch { /* 还没有 */ }
    if (have !== want) await fs.writeFile(file, want, 'utf8');
  }
}
