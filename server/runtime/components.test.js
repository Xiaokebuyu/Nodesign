/** 组件管理器：对着本地起的假 release（manifest.json + 一个小 zip）跑完整管线；校验失败那条也要红得对。 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'components-data-'));
process.env.NODESIGN_PROFILE = 'local';
process.env.NODESIGN_DATA_DIR = dataDir;

// 假 zip：tool-1.2/bin/hello.exe + tool-1.2/README（上游常见的一层目录）
const zipBuf = Buffer.from(zipSync({ 'tool-1.2/bin/hello.exe': strToU8('MZ hello'), 'tool-1.2/README': strToU8('readme'), 'tool-1.2/py/python.exe': strToU8('MZ py') }));
const sha = crypto.createHash('sha256').update(zipBuf).digest('hex');
const platformKey = `${process.platform}-${process.arch}`;
let base;
let officialMode = 'ok';   // 'ok' | 'dead' | 'slow'
const srv = http.createServer((req, res) => {
  // /mirror/* = 镜像目录（同一批文件）；/official/* 按 officialMode 表现
  const m = /^\/(official|mirror)\/(.+)$/.exec(req.url);
  if (m) {
    const [, side, file] = m;
    if (side === 'official' && officialMode === 'dead') { req.socket.destroy(); return; }
    if (file === 'manifest.json') { req.url = '/manifest.json'; }
    else if (file === 'tool.zip') {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': zipBuf.length });
      if (side === 'official' && officialMode === 'slow') { let i = 0; const tick = () => { if (i >= zipBuf.length) { res.end(); return; } res.write(zipBuf.subarray(i, i + 64)); i += 64; setTimeout(tick, 40); }; tick(); }
      else res.end(zipBuf);
      return;
    } else { res.writeHead(404); res.end(); return; }
  }
  if (req.url === '/manifest.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: 1, components: {
      tool: { label: 'Tool', uses: 'test', sizeMb: 0.1, url: `${base}/tool.zip`, sha256: sha, bin: ['tool-*/bin'], python: 'tool-1.2/py/python.exe', platform: platformKey, version: '1.2' },
      mirrored: { label: 'Mirrored', url: `${base}/official/tool.zip`, sha256: sha, bin: ['tool-*/bin'], platform: platformKey, version: '1.2' },
      bad: { label: 'Bad', url: `${base}/tool.zip`, sha256: 'deadbeef', bin: [], platform: platformKey },
      other: { label: 'Other', url: `${base}/tool.zip`, platform: 'plan9-mips' },
      browser: { label: 'Browser', kind: 'playwright', platform: platformKey, version: 'pw-test', parts: [
        { name: 'chromium', revision: 9, dir: 'chromium-9', exe: 'tool-1.2/bin/hello.exe', sources: [{ kind: 'official', url: `${base}/official/tool.zip` }, { kind: 'mirror', url: `${base}/mirror/tool.zip` }] },
        { name: 'ffmpeg', revision: 9, dir: 'ffmpeg-9', exe: 'tool-1.2/py/python.exe', sources: [{ kind: 'official', url: `${base}/tool.zip` }] },
      ] },
      'browser-bad': { label: 'Browser', kind: 'playwright', platform: platformKey, parts: [
        { name: 'chromium', revision: 9, dir: 'chromium-9', exe: 'tool-1.2/bin/hello.exe', sources: [{ kind: 'official', url: `${base}/tool.zip` }] },
        { name: 'ffmpeg', revision: 9, dir: 'ffmpeg-9', exe: 'ffmpeg.exe', sources: [{ kind: 'official', url: `${base}/tool.zip` }] },
      ] },
    }, mirrors: [`${base}/mirror`] }));
    return;
  }
  if (req.url === '/tool.zip') { res.writeHead(200, { 'content-type': 'application/zip', 'content-length': zipBuf.length }); res.end(zipBuf); return; }
  res.writeHead(404); res.end();
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
base = `http://127.0.0.1:${srv.address().port}`;
process.env.NODESIGN_COMPONENTS_MANIFEST = `${base}/manifest.json`;
const c = await import('./components.js');

const waitJob = async (id, ms = 10_000) => {
  const t0 = Date.now();
  for (;;) {
    const { components } = await c.listComponents();
    const job = components.find((x) => x.id === id)?.job;
    if (job && (job.status === 'done' || job.status === 'error')) return job;
    if (Date.now() - t0 > ms) throw new Error('job timeout');
    await new Promise((r) => setTimeout(r, 30));
  }
};

afterAll(async () => { await new Promise((r) => srv.close(r)); fs.rmSync(dataDir, { recursive: true, force: true }); });
beforeEach(() => { c._resetComponents(); officialMode = 'ok'; });

describe('components', () => {
  it('清单读得到；不支持的平台标 supported:false', async () => {
    const { components, manifestError } = await c.listComponents();
    expect(manifestError).toBeNull();
    expect(components.map((x) => x.id).sort()).toEqual(['bad', 'browser', 'browser-bad', 'mirrored', 'other', 'tool']);
    expect(components.find((x) => x.id === 'other').supported).toBe(false);
    expect(components.find((x) => x.id === 'tool').installed).toBe(false);
  });
  it('装：下载 → 校验 → 解压 → bin 目录算成绝对路径 → 进 PATH；python 路径进 env', async () => {
    await c.installComponent('tool');
    const job = await waitJob('tool');
    expect(job.status, job.error).toBe('done');
    const rec = c.readInstalled('tool');
    expect(rec.version).toBe('1.2');
    expect(rec.sha256).toBe(sha);
    expect(rec.binDirs).toEqual([path.join(dataDir, 'components', 'tool', 'tool-1.2', 'bin')]);
    expect(fs.readFileSync(path.join(rec.binDirs[0], 'hello.exe'), 'utf8')).toBe('MZ hello');
    expect(rec.python).toBe(path.join(dataDir, 'components', 'tool', 'tool-1.2', 'py', 'python.exe'));
    const { binDirs, env } = c.applyComponentEnv();
    expect(binDirs).toEqual(rec.binDirs);
    expect(process.env.PATH.split(path.delimiter)[0]).toBe(rec.binDirs[0]);
    expect(env.NODESIGN_REMBG_PYTHON).toBe(rec.python);
    expect((await c.listComponents()).components.find((x) => x.id === 'tool').installed).toBe(true);
    // 幂等：再 apply 一次 PATH 里不重复
    c.applyComponentEnv();
    expect(process.env.PATH.split(path.delimiter).filter((d) => d === rec.binDirs[0])).toHaveLength(1);
  });
  it('sha256 对不上 → error，目录清掉，不留半截', async () => {
    await c.installComponent('bad');
    const job = await waitJob('bad');
    expect(job.status).toBe('error');
    expect(job.error).toContain('校验失败');
    expect(fs.existsSync(path.join(dataDir, 'components', 'bad'))).toBe(false);
    expect(c.readInstalled('bad')).toBeNull();
  });
  it('不支持的平台 / 不认识的 id 直接拒', async () => {
    await expect(c.installComponent('other')).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
    await expect(c.installComponent('nope')).rejects.toMatchObject({ code: 'UNKNOWN_COMPONENT' });
  });
  it('卸载：目录和记录都没了', async () => {
    await c.installComponent('tool'); await waitJob('tool');
    expect(c.uninstallComponent('tool')).toBe(true);
    expect(c.readInstalled('tool')).toBeNull();
    expect(fs.existsSync(path.join(dataDir, 'components', 'tool'))).toBe(false);
  });
  it('chromium：官方地址 → npmmirror 地址（cft 走 chrome-for-testing，其余走 playwright/builds）', () => {
    // 这两条就是 09-06 站主机器上要下的东西：官方跳 storage.googleapis.com，镜像那条实测 206
    expect(c.playwrightMirrorUrl('https://cdn.playwright.dev/builds/cft/147.0.7727.15/win64/chrome-win64.zip'))
      .toBe('https://registry.npmmirror.com/-/binary/chrome-for-testing/147.0.7727.15/win64/chrome-win64.zip');
    expect(c.playwrightMirrorUrl('https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/1011/ffmpeg-win64.zip'))
      .toBe('https://registry.npmmirror.com/-/binary/playwright/builds/ffmpeg/1011/ffmpeg-win64.zip');
    expect(c.playwrightMirrorUrl('https://cdn.playwright.dev/builds/winldd/1007/winldd-win64.zip', 'http://m/x'))
      .toBe('http://m/x/playwright/builds/winldd/1007/winldd-win64.zip');
    expect(c.playwrightMirrorUrl('https://example.com/other.zip')).toBeNull();
    expect(c.playwrightMirrorUrl('not a url')).toBeNull();
  });
  it('chromium：部件表从 playwright 的 registry 拿得到（目录名按它的规则、exe 相对路径、官方+镜像两种源）', () => {
    // 贵的分支至少要验入口能解析（09-06 playwright/cli.js 那课）—— 这条跑在真 playwright-core 上
    const parts = c.playwrightParts('/x/browsers');
    expect(parts.map((p) => p.name)).toEqual(c.playwrightPartNames());
    const chromium = parts.find((p) => p.name === 'chromium');
    expect(chromium.dir).toBe(path.join('/x/browsers', `chromium-${chromium.revision}`));
    expect(String(chromium.revision)).toMatch(/^\d+$/);
    expect(chromium.exe).toBeTruthy();
    expect(path.isAbsolute(chromium.exe)).toBe(false);
    expect(chromium.sources.filter((s) => s.kind === 'official').length).toBeGreaterThan(0);
    expect(chromium.sources.at(-1).kind).toBe('mirror');
    expect(chromium.sources.at(-1).url.startsWith(c.PLAYWRIGHT_MIRROR)).toBe(true);
    const shell = parts.find((p) => p.name === 'chromium-headless-shell');
    expect(path.basename(shell.dir)).toBe(`chromium_headless_shell-${shell.revision}`);   // 横线换下划线是它的规矩
    expect(c.playwrightPartNames('win32')).toContain('winldd');
    expect(c.playwrightPartNames('linux')).not.toContain('winldd');
  });
  it('chromium：按部件逐个下载解压，每个目录写 INSTALLATION_COMPLETE，exe 不在就报出是哪个部件', async () => {
    await c.installComponent('browser');
    const job = await waitJob('browser');
    expect(job.status, job.error).toBe('done');
    const rec = c.readInstalled('browser');
    const root = path.join(dataDir, 'components', 'browser');
    expect(rec.browsersPath).toBe(root);
    expect(fs.existsSync(path.join(root, 'chromium-9', 'INSTALLATION_COMPLETE'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'ffmpeg-9', 'INSTALLATION_COMPLETE'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'chromium-9', 'tool-1.2', 'bin', 'hello.exe'), 'utf8')).toBe('MZ hello');
    expect(rec.parts.chromium.exe).toBe(path.join(root, 'chromium-9', 'tool-1.2', 'bin', 'hello.exe'));
    expect(c.applyComponentEnv().env.PLAYWRIGHT_BROWSERS_PATH).toBe(root);
    // 半路一个部件的 exe 对不上 → 整个组件 error，目录清掉，临时下载文件也清掉
    await c.installComponent('browser-bad');
    const bad = await waitJob('browser-bad');
    expect(bad.status).toBe('error');
    expect(bad.error).toContain('ffmpeg');
    expect(fs.existsSync(path.join(dataDir, 'components', 'browser-bad'))).toBe(false);
    expect(fs.readdirSync(path.join(dataDir, 'components')).filter((f) => f.endsWith('.download'))).toEqual([]);
  });
  it('下载报错带地址和状态码（不是"退出码 1"）', async () => {
    await expect(c.downloadFile(`${base}/nope.zip`, path.join(dataDir, 'nope'))).rejects.toThrow(/nope\.zip 失败：HTTP 404/);
    await expect(c.downloadFile('http://127.0.0.1:1/x.zip', path.join(dataDir, 'nope'))).rejects.toThrow(/x\.zip 失败：/);
  });
  it('extractZip 带出 unix 权限位（chrome 旁边的辅助程序没 +x 浏览器起不来）', async () => {
    if (process.platform === 'win32') return;
    const z = Buffer.from(zipSync({ 'bin/run.sh': [strToU8('#!/bin/sh'), { os: 3, attrs: 0o755 << 16 }], 'data.txt': [strToU8('x'), { os: 3, attrs: 0o644 << 16 }], 'noattr.txt': strToU8('y') }));
    const zp = path.join(dataDir, 'modes.zip'); fs.writeFileSync(zp, z);
    const dest = path.join(dataDir, 'modes-out'); fs.mkdirSync(dest, { recursive: true });
    await c.extractZip(zp, dest);
    expect(fs.statSync(path.join(dest, 'bin', 'run.sh')).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(dest, 'data.txt')).mode & 0o777).toBe(0o644);
    expect(fs.existsSync(path.join(dest, 'noattr.txt'))).toBe(true);
  });
  it('extractZip 拒绝越界路径', async () => {
    const evil = Buffer.from(zipSync({ '../escape.txt': strToU8('x'), 'ok.txt': strToU8('y') }));
    const zp = path.join(dataDir, 'evil.zip'); fs.writeFileSync(zp, evil);
    const dest = path.join(dataDir, 'evil-out'); fs.mkdirSync(dest, { recursive: true });
    await c.extractZip(zp, dest);
    expect(fs.existsSync(path.join(dest, 'ok.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'escape.txt'))).toBe(false);
  });
});

describe('选源：官方 vs 镜像', () => {
  const def = () => ({ url: `${base}/official/tool.zip` });
  it('候选顺序：官方在前，清单里的镜像其次，内置默认镜像最后', async () => {
    const m = await c.loadManifest();
    const srcs = c.sourcesFor(def(), m);
    expect(srcs[0]).toEqual({ kind: 'official', url: `${base}/official/tool.zip` });
    expect(srcs[1]).toEqual({ kind: 'mirror', url: `${base}/mirror/tool.zip` });
    expect(srcs.at(-1).url.startsWith(c.DEFAULT_MIRRORS[0])).toBe(true);
  });
  it('官方能通 → 用官方（哪怕镜像也通）', async () => {
    const { chosen } = await c.pickSource(def(), await c.loadManifest());
    expect(chosen.kind).toBe('official');
  });
  it('官方连不上 → 最快的镜像', async () => {
    officialMode = 'dead';
    const { chosen, results } = await c.pickSource(def(), await c.loadManifest());
    expect(results[0].probe.ok).toBe(false);
    expect(chosen.kind).toBe('mirror');
    expect(chosen.url).toBe(`${base}/mirror/tool.zip`);
  });
  it('官方"通但很慢"（吞吐不到最快镜像的 1/3）→ 镜像', async () => {
    officialMode = 'slow';
    const { chosen, results } = await c.pickSource(def(), await c.loadManifest());
    expect(results[0].probe.ok).toBe(true);
    expect(chosen.kind).toBe('mirror');
  });
  it('整条安装链在官方挂掉时走镜像装完，任务里记着来源', async () => {
    officialMode = 'dead';
    await c.installComponent('mirrored');
    const job = await waitJob('mirrored', 20_000);
    expect(job.status, job.error).toBe('done');
    expect(job.source).toBe('mirror');
    expect(c.readInstalled('mirrored')?.sha256).toBe(sha);
  });
  it('清单本身：官方拉不到就从镜像拿', async () => {
    process.env.NODESIGN_COMPONENTS_MANIFEST = `${base}/official/manifest.json`;
    process.env.NODESIGN_COMPONENTS_MIRRORS = `${base}/mirror`;
    officialMode = 'dead';
    c._resetComponents();
    // 模块常量在加载时读的 env，这里直接验 loadManifest 的候选逻辑：用 env 镜像
    const m = await c.loadManifest({ force: true });
    expect(m?.components?.tool).toBeTruthy();
    delete process.env.NODESIGN_COMPONENTS_MIRRORS;
    process.env.NODESIGN_COMPONENTS_MANIFEST = `${base}/manifest.json`;
  });
});
