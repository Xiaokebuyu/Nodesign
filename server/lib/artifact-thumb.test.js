/**
 * 画布远景缩略图的生成 / 缓存 / 失效 / 限流（09-17，问题库 iss_mu0v5pa5_3ojg）。
 *
 * 截图函数一律用假的（不起 chromium）。另有一组把 cover.js 与槽位闸换成探针，钉住默认截图
 * 那一路真的过 gatedBrowser —— 这台机器 1 vCPU，缩略图不许绕开 agent 感知工具的槽位。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-thumb-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

// 默认截图那一路的探针：cover.js 的截图函数与槽位闸都换成记账的假件
const probe = vi.hoisted(() => ({ gated: [], launched: 0, coverCalls: [] }));
vi.mock('./cover.js', () => ({
  renderCoverShot: async (target, pctx, opts) => {
    probe.coverCalls.push({ target, pctx });
    const b = await opts.launch();
    await b.close();
    return Buffer.from(`cover:${target.relPath}`);
  },
}));
vi.mock('../engine/mcp/tools/helpers/perception-page.js', () => ({
  launchPerceptionBrowser: async () => { probe.launched += 1; return { close: async () => {} }; },
}));
vi.mock('../engine/mcp/tools/helpers/browser-slots.js', () => ({
  gatedBrowser: async (launch, opts) => { probe.gated.push(opts); return launch(); },
}));

const { makeThumbService, siteSignature, FAIL_TTL_MS } = await import('./artifact-thumb.js');

const root = path.join(tmp, 'ws');
const cacheRoot = path.join(tmp, 'cache');
const pid = 'p_thumb';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function write(rel, body) {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body);
  return abs;
}
/** 改文件并把 mtime 往后拨（同一毫秒内连写两次 mtime 可能不变） */
async function touch(rel, body, bump = 5) {
  const abs = await write(rel, body);
  const t = new Date(Date.now() + bump * 1000);
  await fs.utimes(abs, t, t);
}

/** 假截图：记账 + 可选阻塞 + 可选失败；记录同时在跑的个数 */
function fakeRender({ fail = false } = {}) {
  const calls = [];
  let running = 0; let peak = 0;
  const gates = [];
  const render = async (target) => {
    calls.push(target.relPath);
    running += 1; peak = Math.max(peak, running);
    try {
      if (gates.length) await gates.shift();
      else await sleep(5);
      if (fail) throw new Error('chromium 起不来');
      return Buffer.from(`png:${target.relPath}:${calls.length}`);
    } finally { running -= 1; }
  };
  return { render, calls, peak: () => peak, hold: () => { let open; gates.push(new Promise(r => { open = r; })); return () => open(); } };
}

const thumbsDir = () => path.join(cacheRoot, pid, 'thumbs');
const listThumbs = async () => (await fs.readdir(thumbsDir()).catch(() => [])).filter(n => n.endsWith('.webp'));

beforeAll(async () => {
  await write('站/index.html', '<h1>站</h1>');
  await write('站/style.css', 'h1{color:red}');
  await write('站/about.html', '<p>about</p>');
  await write('稿.html', '<section>deck</section>');
  await write('_drafts/海报.html', '<div class="artboard"></div>');
  await write('index.html', '<h1>根站</h1>');
  await write('notes/板书/a.md', '板书');
  await write('assets/generated/x.png', 'png');
});
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

const q = (over) => ({ pid, sharedDir: root, relPath: '站/index.html', kind: 'site', ...over });

describe('缓存：命中读盘，ETag 稳定', () => {
  it('⭐ 第一次截、第二次读盘；If-None-Match 对上回 304', async () => {
    const f = fakeRender();
    const svc = makeThumbService({ cacheRoot, render: f.render });
    const a = await svc.get(q());
    expect(a.status).toBe(200);
    expect(String(a.buffer)).toContain('png:站/index.html');
    const b = await svc.get(q());
    expect(b.status).toBe(200);
    expect(b.etag).toBe(a.etag);
    expect(f.calls).toHaveLength(1);
    // 换一个服务实例（= 进程重启）也读得到盘上那张
    const f2 = fakeRender();
    const c = await makeThumbService({ cacheRoot, render: f2.render }).get(q());
    expect(c.status).toBe(200);
    expect(f2.calls).toHaveLength(0);
    expect(await svc.get(q({ ifNoneMatch: `"${a.etag}"` }))).toEqual({ status: 304, etag: a.etag });
  });
});

describe('失效：源一改就换键，一个产物只留一张图', () => {
  it('⭐ 站点：改 css → 重截，旧图删掉', async () => {
    const f = fakeRender();
    const svc = makeThumbService({ cacheRoot, render: f.render });
    const a = await svc.get(q());
    await touch('站/style.css', 'h1{color:blue}', 10);
    const b = await svc.get(q());
    expect(b.etag).not.toBe(a.etag);
    expect(f.calls.length).toBeGreaterThanOrEqual(1);
    const mine = (await listThumbs()).filter(n => n.endsWith(`${b.etag}.webp`));
    expect(mine).toHaveLength(1);
    expect((await listThumbs()).filter(n => n.endsWith(`${a.etag}.webp`))).toHaveLength(0);
  });

  it('⭐ 站点：改入口 html → 重截', async () => {
    const svc = makeThumbService({ cacheRoot, render: fakeRender().render });
    const a = await svc.get(q());
    await touch('站/index.html', '<h1>站 v2</h1>', 20);
    expect((await svc.get(q())).etag).not.toBe(a.etag);
  });

  it('站点：别的页面的 html 改了不重截（口径同前端 versionOfSitePage）', async () => {
    const svc = makeThumbService({ cacheRoot, render: fakeRender().render });
    const a = await svc.get(q());
    await touch('站/about.html', '<p>about v2</p>', 30);
    expect((await svc.get(q())).etag).toBe(a.etag);
  });

  it('⭐ 站点：删掉一个资源文件 → 重截（文件数 / 目录 mtime 接住）', async () => {
    await write('站/img/logo.svg', '<svg/>');
    const svc = makeThumbService({ cacheRoot, render: fakeRender().render });
    const a = await svc.get(q());
    await fs.rm(path.join(root, '站/img/logo.svg'));
    expect((await svc.get(q())).etag).not.toBe(a.etag);
  });

  it('根站：notes/ 里写板书不重截，assets/ 里的图变了要重截', async () => {
    const sig0 = await siteSignature(path.join(root, 'index.html'), root);
    await touch('notes/板书/a.md', '板书 v2', 40);
    await write('notes/板书/b.md', '新板书');
    expect(await siteSignature(path.join(root, 'index.html'), root)).toBe(sig0);
    await touch('assets/generated/x.png', 'png v2', 50);
    expect(await siteSignature(path.join(root, 'index.html'), root)).not.toBe(sig0);
  });

  it('⭐ deck：入口改了 → 重截', async () => {
    const svc = makeThumbService({ cacheRoot, render: fakeRender().render });
    const a = await svc.get(q({ relPath: '稿.html', kind: 'deck' }));
    expect(a.status).toBe(200);
    await touch('稿.html', '<section>deck v2</section>', 60);
    const b = await svc.get(q({ relPath: '稿.html', kind: 'deck' }));
    expect(b.status).toBe(200);
    expect(b.etag).not.toBe(a.etag);
  });
});

describe('限流', () => {
  it('⭐ 同一个键同时来十个请求只截一次；不同产物串行截（同时最多一张）', async () => {
    await touch('站/style.css', 'h1{color:green}', 70);
    await touch('_drafts/海报.html', '<div class="artboard">v2</div>', 70);
    const f = fakeRender();
    const svc = makeThumbService({ cacheRoot, render: f.render });
    const outs = await Promise.all([
      ...Array.from({ length: 10 }, () => svc.get(q())),
      svc.get(q({ relPath: '_drafts/海报.html' })),
      svc.get(q({ relPath: '稿.html', kind: 'deck' })),
    ]);
    expect(outs.every(o => o.status === 200)).toBe(true);
    expect(f.calls.filter(r => r === '站/index.html')).toHaveLength(1);
    expect(f.peak()).toBe(1);
  });

  it('⭐ 排到时请求方都走了 → 不截，回 204', async () => {
    await touch('站/style.css', 'h1{color:gray}', 80);
    const f = fakeRender();
    const svc = makeThumbService({ cacheRoot, render: f.render });
    // 先塞一张别的挡住队列，期间请求方断开
    await touch('_drafts/海报.html', '<div>v3</div>', 80);
    const release = f.hold();
    const blocker = svc.get(q({ relPath: '_drafts/海报.html' }));
    let gone = false;
    const p = svc.get(q({ isGone: () => gone }));
    await sleep(10);
    gone = true;
    release();
    await blocker;
    expect(await p).toEqual({ status: 204, reason: 'gone' });
    expect(f.calls).not.toContain('站/index.html');
  });

  it('同一个键还有没走的请求方 → 照截', async () => {
    await touch('站/style.css', 'h1{color:olive}', 90);
    const f = fakeRender();
    const svc = makeThumbService({ cacheRoot, render: f.render });
    const release = f.hold();
    await touch('_drafts/海报.html', '<div>v4</div>', 90);
    const blocker = svc.get(q({ relPath: '_drafts/海报.html' }));
    const a = svc.get(q({ isGone: () => true }));
    const b = svc.get(q());
    await sleep(10);
    release();
    await blocker;
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
    expect(f.calls.filter(r => r === '站/index.html')).toHaveLength(1);
  });

  it('⭐ 排队期间源又变了：旧版不截，旧请求拿到新版的图和新版的 ETag', async () => {
    await touch('站/style.css', 'h1{color:navy}', 100);
    const f = fakeRender();
    const svc = makeThumbService({ cacheRoot, render: f.render });
    const release = f.hold();
    await touch('_drafts/海报.html', '<div>v5</div>', 100);
    const blocker = svc.get(q({ relPath: '_drafts/海报.html' }));
    const old = svc.get(q());
    await sleep(10);
    await touch('站/style.css', 'h1{color:teal}', 110);
    const fresh = svc.get(q());
    await sleep(10);
    release();
    await blocker;
    const [o, n] = await Promise.all([old, fresh]);
    expect(n.status).toBe(200);
    expect(o).toEqual(n);
    expect(f.calls.filter(r => r === '站/index.html')).toHaveLength(1);
  });

  it('⭐ 截失败 → 204，十分钟内同一个键不再起浏览器；过了时限或文件改了再试', async () => {
    await touch('站/style.css', 'h1{color:maroon}', 120);
    let clock = 1_000_000;
    const f = fakeRender({ fail: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const svc = makeThumbService({ cacheRoot, render: f.render, now: () => clock });
    expect(await svc.get(q())).toEqual({ status: 204, reason: 'failed' });
    expect(await svc.get(q())).toEqual({ status: 204, reason: 'failed' });
    expect(f.calls).toHaveLength(1);
    clock += FAIL_TTL_MS + 1;
    await svc.get(q());
    expect(f.calls).toHaveLength(2);
    await touch('站/style.css', 'h1{color:purple}', 130);
    await svc.get(q());
    expect(f.calls).toHaveLength(3);
    warn.mockRestore();
  });
});

describe('入参判据', () => {
  const svc = makeThumbService({ cacheRoot, render: async () => { throw new Error('不该截'); } });
  it('形态只收 deck / site；入口必须是 html', async () => {
    expect((await svc.get(q({ kind: 'docx' }))).status).toBe(400);
    expect((await svc.get(q({ kind: '' }))).status).toBe(400);
    expect((await svc.get(q({ relPath: '站/style.css' }))).status).toBe(400);
  });
  it('越界 403；不存在 404；点目录 403', async () => {
    expect((await svc.get(q({ relPath: '../外面.html' }))).status).toBe(403);
    expect((await svc.get(q({ relPath: '没有这页.html' }))).status).toBe(404);
    await write('.claude/x.html', 'secret');
    expect((await svc.get(q({ relPath: '.claude/x.html' }))).status).toBe(403);
  });
  it('⭐ 软链指到工作区外 → 403（realpath 复核，同 artifact-file 路由）', async () => {
    const outside = path.join(tmp, 'secret.html');
    await fs.writeFile(outside, 'TOKEN=1');
    await fs.symlink(outside, path.join(root, '软链.html'));
    expect((await svc.get(q({ relPath: '软链.html' }))).status).toBe(403);
  });
});

describe('默认截图那一路', () => {
  it('⭐ 开浏览器过 gatedBrowser（按项目排队），截图走封面管线且带项目上下文', async () => {
    await touch('站/style.css', 'h1{color:lime}', 140);
    probe.gated.length = 0; probe.launched = 0; probe.coverCalls.length = 0;
    const svc = makeThumbService({ cacheRoot });
    const out = await svc.get(q());
    expect(out.status).toBe(200);
    expect(String(out.buffer)).toBe('cover:站/index.html');
    expect(probe.gated).toEqual([{ key: pid }]);
    expect(probe.launched).toBe(1);
    expect(probe.coverCalls[0].target).toMatchObject({ kind: 'site', relPath: '站/index.html', absPath: path.join(root, '站/index.html') });
    expect(probe.coverCalls[0].pctx).toEqual({ projectId: pid, workspaceRoot: root });
  });
});
