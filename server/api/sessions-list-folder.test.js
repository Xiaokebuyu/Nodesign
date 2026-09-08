/**
 * 会话列表 × 仓库项目（09-08 站主在 Windows 上报「项目里查不到会话历史」）。
 * 病根：listSessionsForProject 拿**桌面**（<folder>/.nodesign）去编码找转录，而转录按 **cwd**（用户文件夹）编码落盘。
 * 这条钉住：转录落在 cwd 编码目录下时，列表要能列到。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-sess-folder-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'data');
process.env.NODESIGN_CONFIG_DIR = path.join(tmp, 'claude-config');
const { openFolder } = await import('../projects/folder.js');
const { encodeCwdForSDK, getWorkspaceRoot, getAgentCwd } = await import('../projects/workspace.js');
const { listSessionsForProject } = await import('./sessions.js');

describe('仓库项目的会话列表', () => {
  it('转录按 cwd（用户文件夹）编码，列表按同一个根去找', async () => {
    const dir = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), '1\n');
    const { project } = await openFolder({ path: dir });
    expect(getWorkspaceRoot(project.id)).toBe(path.join(dir, '.nodesign'));   // 桌面缩进去了
    expect(getAgentCwd(project.id)).toBe(dir);
    const sid = '11111111-2222-4333-8444-555555555555';
    // 会话私档在桌面的 .nd/ 下（服务端 ensureSessionWorkspace 建的形状）
    fs.mkdirSync(path.join(getWorkspaceRoot(project.id), '.nd', sid), { recursive: true });
    // 转录在 <config>/projects/<encode(cwd)>/<sid>.jsonl —— SDK 按 cwd 编码，不认桌面
    const jsonlDir = path.join(process.env.NODESIGN_CONFIG_DIR, 'projects', encodeCwdForSDK(dir));
    fs.mkdirSync(jsonlDir, { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(jsonlDir, `${sid}.jsonl`), [
      JSON.stringify({ type: 'user', uuid: 'u1', sessionId: sid, timestamp: now, cwd: dir, message: { role: 'user', content: '你好' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: sid, timestamp: now, cwd: dir, message: { role: 'assistant', content: [{ type: 'text', text: '在' }] } }),
    ].join('\n') + '\n');
    const list = await listSessionsForProject(project.id);
    expect(list.map(s => s.sessionId)).toContain(sid);
  });
});
