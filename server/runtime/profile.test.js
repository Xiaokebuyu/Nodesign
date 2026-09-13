/**
 * runtime/profile.js 的行为钉子。profile 在 import 时读 env 并改 env，所以每个用例起一个子进程，
 * 别在同一个 vitest 进程里反复 import（ESM 模块缓存会让第二个用例看到第一个的决策）。
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function probe(env, code) {
  // 从 vitest 进程 env 里**删掉**（不是置空）profile 会读的键：--env-file 语义下空串也算"已设"，会挡住 .env 文件的值
  const base = { ...process.env };
  for (const k of ['NODESIGN_PROFILE', 'NODESIGN_DATA_DIR', 'DB_PATH', 'PROJECTS_DATA_DIR', 'WORKSPACE_DIR', 'ARTIFACT_DIR', 'NODESIGN_CACHE_DIR', 'NODESIGN_HOST', 'NODESIGN_SERVE_WEB', 'NODESIGN_AUTH_PASSWORD', 'VITEST']) delete base[k];
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: here,
    env: { ...base, ...env },
    encoding: 'utf8',
  });
  // store.js 在 import 时会打一行 "[engine/runs] SQLite ready"，JSON 取最后一行
  r.json = () => JSON.parse(r.stdout.trim().split('\n').pop());
  return r;
}
const DUMP = `import { profile } from './profile.js'; console.log(JSON.stringify({ ...profile, env: { DB_PATH: process.env.DB_PATH, PROJECTS_DATA_DIR: process.env.PROJECTS_DATA_DIR, WORKSPACE_DIR: process.env.WORKSPACE_DIR, FOO: process.env.FOO } }));`;

// 每条都 spawnSync 一个子进程 import 整个 users-store / store.js：Windows CI 上冷启动能过 5 秒默认超时（09-14 假红）
describe('runtime/profile', { timeout: 30_000 }, () => {
  it('不设 NODESIGN_PROFILE = hosted：不动任何 env、不绑环回、不托管前端', () => {
    const r = probe({}, DUMP);
    expect(r.status, r.stderr).toBe(0);
    const p = r.json();
    expect(p.name).toBe('hosted');
    expect(p.isLocal).toBe(false);
    expect(p.dataRoot).toBeNull();
    expect(p.listenHost).toBeUndefined();
    expect(p.serveWeb).toBe(false);
    expect(p.env.DB_PATH).toBeUndefined();   // 没被填默认值
    expect(p.cacheRoot.endsWith(path.join('server', '.cache'))).toBe(true);
  });

  it('local：数据目录下的 .env 被读进来（不覆盖已有 env），数据路径 env 填成数据目录下的默认值', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nd-profile-'));
    writeFileSync(path.join(dir, '.env'), 'FOO=from-file\nDB_PATH=/explicit/from/file.db\n');
    const r = probe({ NODESIGN_PROFILE: 'local', NODESIGN_DATA_DIR: dir, FOO: 'from-process' }, DUMP);
    expect(r.status, r.stderr).toBe(0);
    const p = r.json();
    expect(p.isLocal).toBe(true);
    expect(p.dataRoot).toBe(dir);
    expect(p.listenHost).toBe('127.0.0.1');
    expect(p.serveWeb).toBe(true);
    expect(p.env.FOO).toBe('from-process');                  // 进程 env 优先于文件
    expect(p.env.DB_PATH).toBe('/explicit/from/file.db');     // 文件里写了就用文件的
    expect(p.env.PROJECTS_DATA_DIR).toBe(path.join(dir, 'projects'));
    expect(p.env.WORKSPACE_DIR).toBe(path.join(dir, 'runs'));
    expect(p.cacheRoot).toBe(path.join(dir, 'cache'));
  });

  it('拼错的 profile 名当场炸，不静默落成 hosted', () => {
    const r = probe({ NODESIGN_PROFILE: 'locl' }, DUMP);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/NODESIGN_PROFILE=locl 不认识/);
  });

  it('local 下登录墙钉死关闭，匿名 owner 反查得到 LOCAL_OWNER 且有订阅资格（session-loop 的断言靠这个）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nd-profile-'));
    const code = `import { authEnabled, getUserById, LOCAL_OWNER } from '../auth/users-store.js'; import { can } from '../auth/tier.js';
      console.log(JSON.stringify({ enabled: authEnabled(), owner: getUserById(LOCAL_OWNER.id), sub: can(getUserById(LOCAL_OWNER.id), 'subscription') }));`;
    const r = probe({ NODESIGN_PROFILE: 'local', NODESIGN_DATA_DIR: dir, NODESIGN_AUTH_PASSWORD: 'would-enable-in-hosted' }, code);
    expect(r.status, r.stderr).toBe(0);
    const p = r.json();
    expect(p.enabled).toBe(false);
    expect(p.owner.id).toBe('_anon');
    expect(p.owner.role).toBe('admin');
    expect(p.sub).toBe(true);
  });

  it('hosted 下登录墙开着时 _anon 不是合法身份', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nd-profile-'));
    const code = `import { authEnabled, getUserById, LOCAL_OWNER } from '../auth/users-store.js';
      console.log(JSON.stringify({ enabled: authEnabled(), owner: getUserById(LOCAL_OWNER.id) }));`;
    const r = probe({ DB_PATH: path.join(dir, 'x.db'), NODESIGN_AUTH_PASSWORD: 'pw' }, code);
    expect(r.status, r.stderr).toBe(0);
    const p = r.json();
    expect(p.enabled).toBe(true);
    expect(p.owner).toBeNull();
  });
});
