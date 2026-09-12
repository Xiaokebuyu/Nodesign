/**
 * 会话标题读数（2026-09-12）：转录按 cwd 编码定位，标题要能读到；
 * 退避重读时标题一变就回调，同一标题不重复回调。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nd-sess-title-')));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'data');
process.env.NODESIGN_CONFIG_DIR = path.join(tmp, 'claude-config');
const { openFolder } = await import('./folder.js');
const { encodeCwdForSDK, getAgentCwd } = await import('./workspace.js');
const { readSessionTitle, watchSessionTitle } = await import('./session-title.js');
const { autoNameProjectFromSession } = await import('./auto-name.js');
const { getProject, updateProject } = await import('./store.js');

const sid = '22222222-3333-4444-8555-666666666666';

function writeTranscript(dir, lines) {
  const jsonlDir = path.join(process.env.NODESIGN_CONFIG_DIR, 'projects', encodeCwdForSDK(dir));
  fs.mkdirSync(jsonlDir, { recursive: true });
  fs.writeFileSync(path.join(jsonlDir, `${sid}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

describe('会话标题', () => {
  it('转录按 cwd 编码：summary 行落盘后读得到；没落盘前是 null', async () => {
    const dir = path.join(tmp, 'repo');
    fs.mkdirSync(dir, { recursive: true });
    const { project } = await openFolder({ path: dir });
    const cwd = getAgentCwd(project.id);
    const now = new Date().toISOString();
    const base = [
      { type: 'user', uuid: 'u1', sessionId: sid, timestamp: now, cwd, message: { role: 'user', content: '帮我做个书店站' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: sid, timestamp: now, cwd, message: { role: 'assistant', content: [{ type: 'text', text: '好' }] } },
    ];
    writeTranscript(cwd, base);
    // helper 没写之前 SDK 拿第一句话兜底 —— 读得到，但标成不是 helper 写的
    expect(await readSessionTitle(project.id, sid)).toEqual({ title: '帮我做个书店站', fromHelper: false });

    // 退避盯读：第一次读到兜底，第二次读到 helper 标题，第三次同一标题不再回调
    const seen = [];
    const p = watchSessionTitle(project.id, sid, { onTitle: (t, m) => seen.push([t, m.fromHelper]), delays: [10, 60, 40] });
    await new Promise(r => setTimeout(r, 30));
    writeTranscript(cwd, [...base, { type: 'summary', summary: '蘑菇书店站点', leafUuid: 'a1' }]);
    const last = await p;
    expect(last).toBe('蘑菇书店站点');
    expect(seen).toEqual([['帮我做个书店站', false], ['蘑菇书店站点', true]]);

    // 项目正名：自己读时不吃兜底值（那会把 auto_named 清掉，真标题永远轮不到）
    updateProject(project.id, { autoNamed: true });
    writeTranscript(cwd, base);
    expect(await autoNameProjectFromSession(project.id, sid)).toBeNull();
    expect(getProject(project.id).autoNamed).toBe(true);
    // 同一份 helper 读数喂进来就正名
    expect(await autoNameProjectFromSession(project.id, sid, '蘑菇书店站点')).toBe('蘑菇书店站点');
    expect(getProject(project.id).name).toBe('蘑菇书店站点');
    expect(getProject(project.id).autoNamed).toBe(false);
  });
});
