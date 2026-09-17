/**
 * 回退前后各提交一次（09-17，问题库 iss_mtxwluiz_welc）。
 *
 * 病：回合进行中回退时，这一轮没提交的改动没有任何副本（SDK rewindFiles 不产生 git 提交，
 * 项目 git 每轮收尾才提交）。这里用临时目录里的真 git 仓库 + 假 SDK（rewindFiles 把文件改回去）
 * 钉住：回退前 / 回退后两笔提交、没变化不落空提交、响应带 preRewindCommit、仓库道不往用户仓库里提交、
 * 下一轮状态注入带一次「回退前的版本在哪」。
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nd-rewind-save-')));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'data');
process.env.NODESIGN_CONFIG_DIR = path.join(tmp, 'claude-config');

/** 假 SDK：临时 query 的 rewindFiles 调 fakeRewind（每个用例自己设），流在 close 后结束 */
let fakeRewind = async () => ({ canRewind: true, filesChanged: [] });
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    let closed = false;
    let wake = null;
    return {
      rewindFiles: (id) => fakeRewind(id),
      close: () => { closed = true; wake?.(); },
      async *[Symbol.asyncIterator]() {
        while (!closed) await new Promise((r) => { wake = r; });
      },
    };
  },
}));

const { createProject } = await import('../projects/store.js');
const { ensureProjectWorkspace, getWorkspaceRoot, getAgentCwd, commitWorkspace } = await import('../projects/workspace.js');
const { sessionJsonlPath } = await import('../projects/session-jsonl.js');
const { openFolder } = await import('../projects/folder.js');
const { mountRewindRoute } = await import('./sessions-rewind.js');
const { registerQuerySession, attachSessionQuery, unregisterQuerySession } = await import('../engine/runs/active-runs.js');
const { AsyncQueue } = await import('../lib/async-queue.js');
const { makeUserPromptSubmitHandler } = await import('../engine/agent/hooks/user-prompt-submit.js');

let handler = null;
mountRewindRoute({ post: (_p, h) => { handler = h; } });

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const logSubjects = (cwd) => git(cwd, 'log', '--format=%s').split('\n');
const MSG = 'aaaaaaaa-1111-4222-8333-444444444444';
let sidSeq = 0;
const newSid = () => `bbbbbbbb-0000-4000-8000-${String(++sidSeq).padStart(12, '0')}`;

/** 直接调路由 handler（不起 express）：admin 身份过 guardProject */
async function callRewind(pid, sid, body) {
  const res = {
    code: 200, body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
  let error = null;
  await handler({ params: { pid, sid }, body, user: { id: 'u_admin', role: 'admin' } }, res, (e) => { error = e; });
  if (error) throw error;
  return res;
}

/** 历史会话要有 jsonl（路径 2 的 404 闸），里面有那条用户消息（对话截断找得到） */
function writeJsonl(pid, sid) {
  const p = sessionJsonlPath(getAgentCwd(pid), sid);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify({ type: 'user', uuid: MSG, sessionId: sid, message: { role: 'user', content: '改一下' } })}\n`);
}

async function managedProject() {
  const project = createProject({ name: '回退测试', ownerId: 'u_admin' });
  await ensureProjectWorkspace(project.id);
  const root = getWorkspaceRoot(project.id);
  fs.writeFileSync(path.join(root, '时间线.md'), '第一版\n');
  await commitWorkspace(project.id, null, 'turn succeeded: 第一轮', { author: 'agent' });
  return { pid: project.id, root };
}

beforeAll(() => {
  // 本机 git 没配身份时，测试自己建的用户仓库也要能提交
  process.env.GIT_AUTHOR_NAME = 't'; process.env.GIT_AUTHOR_EMAIL = 't@t';
  process.env.GIT_COMMITTER_NAME = 't'; process.env.GIT_COMMITTER_EMAIL = 't@t';
});

// 这份测试要做多次 git 提交 / 文件读写，Windows CI 上默认 5 秒不够（09-17 超时过），与 runtime/profile 测试同一做法
describe('commitWorkspace orHead', { timeout: 30_000 }, () => {
  it('⭐ 没改动：不落空提交，回当时的 HEAD；不带 orHead 仍回 null', async () => {
    const { pid, root } = await managedProject();
    const head = git(root, 'rev-parse', 'HEAD');
    const before = logSubjects(root).length;
    expect(await commitWorkspace(pid, null, 'x', { orHead: true })).toBe(head);
    expect(await commitWorkspace(pid, null, 'x')).toBeNull();
    expect(logSubjects(root)).toHaveLength(before);
  });
});

describe('回退路由：前后各提交一次', { timeout: 30_000 }, () => {
  it('⭐ 历史会话（临时 query）：回合里没提交的改动进了「回退前」，回退结果进了「回退后」，响应带 preRewindCommit', async () => {
    const { pid, root } = await managedProject();
    const sid = newSid();
    writeJsonl(pid, sid);
    // 回合进行中写的 36 行，还没到收尾提交
    const inflight = `第一版\n${Array.from({ length: 36 }, (_, i) => `新增第 ${i + 1} 行`).join('\n')}\n`;
    fs.writeFileSync(path.join(root, '时间线.md'), inflight);
    fakeRewind = async (id) => {
      expect(id).toBe(MSG);
      fs.writeFileSync(path.join(root, '时间线.md'), '第一版\n');   // SDK 按 checkpoint 恢复
      return { canRewind: true, filesChanged: [path.join(root, '时间线.md')] };
    };
    const res = await callRewind(pid, sid, { userMessageId: MSG, files: true, truncateConversation: true });
    expect(res.code).toBe(200);
    const [after, pre] = logSubjects(root);
    expect(pre).toBe(`回退前 · 会话 ${sid} · 消息 ${MSG}`);
    expect(after).toBe(`回退后 · 会话 ${sid} · 消息 ${MSG}`);
    expect(res.body.preRewindCommit).toBe(git(root, 'rev-parse', 'HEAD~1'));
    // 被回退掉的 36 行能从那笔提交里原样取回
    expect(git(root, 'show', `${res.body.preRewindCommit}:时间线.md`)).toBe(inflight.trim());
    expect(git(root, 'show', 'HEAD:时间线.md')).toBe('第一版');
    expect(res.body.preRewindNote).toBeUndefined();
    expect(res.body.conversationTruncated).toBe(true);
    expect(git(root, 'status', '--porcelain')).toBe('');   // 回退记录写在 .nd/，没把工作树弄脏
  });

  it('⭐ 工作树没有变化：一笔提交都不落，preRewindCommit = 当时的 HEAD', async () => {
    const { pid, root } = await managedProject();
    const sid = newSid();
    writeJsonl(pid, sid);
    const head = git(root, 'rev-parse', 'HEAD');
    const count = logSubjects(root).length;
    fakeRewind = async () => ({ canRewind: true, filesChanged: [] });
    const res = await callRewind(pid, sid, { userMessageId: MSG });
    expect(res.body.preRewindCommit).toBe(head);
    expect(logSubjects(root)).toHaveLength(count);
  });

  it('活口 query（分叉带产物回退）：同样两笔；回退记录记给 noteSessionId 那条会话，只说一次', async () => {
    const { pid, root } = await managedProject();
    const sid = newSid();
    const forkSid = newSid();
    fs.writeFileSync(path.join(root, '时间线.md'), '第二版\n');
    const token = registerQuerySession(sid, { abortController: new AbortController(), inputQueue: new AsyncQueue(), projectId: pid });
    attachSessionQuery(sid, {
      rewindFiles: async () => {
        fs.writeFileSync(path.join(root, '时间线.md'), '第一版\n');
        return { canRewind: true, filesChanged: [path.join(root, '时间线.md')] };
      },
    });
    try {
      const res = await callRewind(pid, sid, { userMessageId: MSG, files: true, truncateConversation: false, noteSessionId: forkSid });
      expect(logSubjects(root).slice(0, 2)).toEqual([`回退后 · 会话 ${sid} · 消息 ${MSG}`, `回退前 · 会话 ${sid} · 消息 ${MSG}`]);
      const pre = res.body.preRewindCommit;
      expect(git(root, 'show', `${pre}:时间线.md`)).toBe('第二版');

      // 源会话收不到（它的对话没接着走）；新分支那条收到一次，下一轮就没有了
      const onSource = makeUserPromptSubmitHandler({ workspaceRoot: root, sessionId: sid, projectId: pid });
      expect((await onSource({ prompt: 'x' }))?.hookSpecificOutput?.additionalContext || '').not.toContain(pre);
      const onFork = makeUserPromptSubmitHandler({ workspaceRoot: root, sessionId: forkSid, projectId: pid });
      const first = (await onFork({ prompt: 'x' })).hookSpecificOutput.additionalContext;
      expect(first).toContain('[回退记录]');
      expect(first).toContain(`git show ${pre}:<路径>`);
      const second = (await onFork({ prompt: 'y' })).hookSpecificOutput.additionalContext;
      expect(second).not.toContain('[回退记录]');
    } finally {
      unregisterQuerySession(sid, token);
    }
  });

  it('下一轮之前连着回退两次：两份「回退前」都交代（第一次那份最满，不能被第二次盖掉）', async () => {
    const { pid, root } = await managedProject();
    const sid = newSid();
    writeJsonl(pid, sid);
    fakeRewind = async () => { fs.writeFileSync(path.join(root, '时间线.md'), '第一版\n'); return { canRewind: true, filesChanged: [] }; };
    fs.writeFileSync(path.join(root, '时间线.md'), '第三版\n');
    const r1 = await callRewind(pid, sid, { userMessageId: MSG, truncateConversation: false });
    fs.writeFileSync(path.join(root, '时间线.md'), '第四版\n');
    const r2 = await callRewind(pid, sid, { userMessageId: MSG, truncateConversation: false });
    expect(r1.body.preRewindCommit).not.toBe(r2.body.preRewindCommit);
    const text = (await makeUserPromptSubmitHandler({ workspaceRoot: root, sessionId: sid, projectId: pid })({ prompt: 'x' }))
      .hookSpecificOutput.additionalContext;
    expect(text).toContain(r1.body.preRewindCommit);
    expect(text).toContain(r2.body.preRewindCommit);
  });

  it('只回对话（路径 0）：不碰文件，也不提交', async () => {
    const { pid, root } = await managedProject();
    const sid = newSid();
    writeJsonl(pid, sid);
    fs.writeFileSync(path.join(root, '时间线.md'), '没提交的\n');
    const count = logSubjects(root).length;
    const res = await callRewind(pid, sid, { userMessageId: MSG, files: false });
    expect(res.body.preRewindCommit).toBeUndefined();
    expect(logSubjects(root)).toHaveLength(count);
  });

  it('SDK 说此处回不了（canRewind:false）：不给 agent 记回退记录', async () => {
    const { pid, root } = await managedProject();
    const sid = newSid();
    writeJsonl(pid, sid);
    fakeRewind = async () => ({ canRewind: false, error: 'no checkpoint' });
    await callRewind(pid, sid, { userMessageId: MSG, truncateConversation: false });
    expect(fs.existsSync(path.join(root, '.nd', sid, 'rewind-note.json'))).toBe(false);
  });
});

describe('仓库道：不往用户仓库里提交', { timeout: 30_000 }, () => {
  it('⭐ 用户仓库的 HEAD 与提交数不变，回退前的工作树拍成快照树；桌面照常两笔', async () => {
    const dir = path.join(tmp, 'repo-git');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'v1\n');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', '用户自己的提交');
    const { project } = await openFolder({ path: dir, ownerId: 'u_admin' });
    const pid = project.id;
    const desk = getWorkspaceRoot(pid);
    expect(desk).toBe(path.join(dir, '.nodesign'));
    const sid = newSid();
    writeJsonl(pid, sid);
    const userHead = git(dir, 'rev-parse', 'HEAD');
    const userCount = logSubjects(dir).length;
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'v2 回合里改的\n');
    fs.writeFileSync(path.join(desk, 'notes.md'), '桌面上的\n');
    fakeRewind = async () => {
      fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'v1\n');
      fs.writeFileSync(path.join(desk, 'notes.md'), '');
      return { canRewind: true, filesChanged: [path.join(dir, 'src', 'a.js')] };
    };
    const res = await callRewind(pid, sid, { userMessageId: MSG });
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(userHead);
    expect(logSubjects(dir)).toHaveLength(userCount);
    expect(res.body.preRewindTree).toMatch(/^[0-9a-f]{40}$/);
    expect(git(dir, 'show', `${res.body.preRewindTree}:src/a.js`)).toBe('v2 回合里改的');
    expect(git(desk, 'show', `${res.body.preRewindCommit}:notes.md`)).toBe('桌面上的');
    expect(logSubjects(desk)[0]).toBe(`回退后 · 会话 ${sid} · 消息 ${MSG}`);
    const note = (await makeUserPromptSubmitHandler({ workspaceRoot: desk, sessionId: sid, projectId: pid })({ prompt: 'x' }))
      .hookSpecificOutput.additionalContext;
    expect(note).toContain(`tree ${res.body.preRewindTree}`);
    expect(note).toContain(`git -C ${desk} show ${res.body.preRewindCommit}`);
  });

  it('文件夹不是 git 仓库：快照拍不了，响应写明没保存', async () => {
    const dir = path.join(tmp, 'repo-plain');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
    const { project } = await openFolder({ path: dir, ownerId: 'u_admin' });
    const sid = newSid();
    writeJsonl(project.id, sid);
    fakeRewind = async () => ({ canRewind: true, filesChanged: [] });
    const res = await callRewind(project.id, sid, { userMessageId: MSG });
    expect(res.body.preRewindTree).toBeUndefined();
    expect(res.body.preRewindNote).toMatch(/不是 git 仓库.*没有保存/);
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(false);   // 也没替他 init
  });
});
