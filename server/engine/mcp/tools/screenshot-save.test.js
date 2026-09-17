/**
 * screenshot_canvas 的 saveTo：docx 页图落盘（09-17，问题库 iss_mt9n6bm2_nthg）
 *
 * - 路径判据：绝对路径 / `..` / 点开头的目录 / 保留目录 / 硬忽略目录一律拒；工作区根也拒
 * - 落盘：逐级建目录、文件名按页码、同名覆盖要报、发 file_changed、不留临时文件
 * - 软链：目录链路上或目标文件是指向工作区外的软链 → 拒，外面的文件不被改
 * - 项目已删除 → 拒，工作区里什么都不建
 * - docx 接线：渲一次、看和存同一批 PNG；shot:false 只存不回图；路径不合法时不渲染
 * 渲染链路（LibreOffice）换成假的。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync, readdirSync } from 'node:fs';

vi.mock('../../../projects/project-gone.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isProjectGone: (pid) => pid === 'proj_gone_save0917',
}));

// pdfinfo 报的总页数（决定页码补零宽度）；别的命令照常走
let pdfPages = 2;
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal();
  const execFileSync = (cmd, args, opts) => (cmd === 'pdfinfo' ? `Pages:          ${pdfPages}\n` : orig.execFileSync(cmd, args, opts));
  return { ...orig, default: { ...orig, execFileSync }, execFileSync };
});

// 假渲染：每次在临时目录里放 N 张「PNG」，内容带页码，便于核对落盘的是哪一张
const renderCalls = [];
let renderPages = 2;
vi.mock('../../../lib/docx/render.js', () => ({
  renderDocx: async (docxPath, opts) => {
    renderCalls.push({ docxPath, opts });
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'nd-fake-render-'));
    const [from] = opts.pngPages;
    const pngs = [];
    for (let i = 0; i < renderPages; i += 1) {
      const p = path.join(scratch, `page-${from + i}.png`);
      writeFileSync(p, `PNG-page-${from + i}-dpi-${opts.dpi}`);
      pngs.push(p);
    }
    return { pdf: path.join(scratch, 'in.pdf'), pngs, scratch, ms: 5 };
  },
  cleanupRender: async (res) => fsp.rm(res.scratch, { recursive: true, force: true }),
}));
vi.mock('./helpers/shot-pipeline.js', async (importOriginal) => ({
  ...(await importOriginal()),
  normalizeShot: async (buf) => ({ data: buf.toString('base64'), mimeType: 'image/webp', note: null }),
}));

const { checkSaveDir, saveShotFiles, pageImageName } = await import('./helpers/save-shots.js');
const { screenshotDocx } = await import('./screenshot-docx.js');

const made = [];
function workspace() {
  const ws = mkdtempSync(path.join(os.tmpdir(), 'nd-save-ws-'));
  made.push(ws);
  return ws;
}
afterAll(async () => { for (const d of made) await fsp.rm(d, { recursive: true, force: true }); });

function srcFiles(n = 2) {
  const d = mkdtempSync(path.join(os.tmpdir(), 'nd-save-src-'));
  made.push(d);
  return Array.from({ length: n }, (_, i) => {
    const file = path.join(d, `p${i + 1}.png`);
    writeFileSync(file, `BYTES-${i + 1}`);
    return file;
  });
}

beforeEach(() => { renderCalls.length = 0; renderPages = 2; pdfPages = 2; });

describe('checkSaveDir：路径判据', () => {
  const ws = '/ws/proj_x';
  it.each([
    ['交付/简历页图', '交付/简历页图'],
    ['./交付/页图/', '交付/页图'],
    ['交付\\页图', '交付/页图'],
    ['页图', '页图'],
  ])('%s → 放行（%s）', (raw, rel) => {
    expect(checkSaveDir(ws, raw)).toEqual({ ok: true, rel });
  });
  it.each([
    ['/etc/x', /absolute/],
    ['/ws/proj_x/交付', /absolute/],
    ['C:\\Users\\x', /absolute/],
    ['C:交付', /absolute/],
    ['\\\\server\\share', /absolute/],
    ['../proj_y/x', /"\.\." is not allowed/],
    ['交付/../../x', /"\.\." is not allowed/],
    ['交付/../.git', /"\.\." is not allowed/],
    ['.claude/x', /"\.claude" starts with "\."/],
    ['.nd', /"\.nd" starts with "\."/],
    ['站点/.git/hooks', /"\.git" starts with "\."/],
    ['notes/板书', /"notes" is a reserved folder/],
    ['assets/generated', /"assets" is a reserved folder/],
    ['exports', /"exports" is a reserved folder/],
    ['站点/node_modules/x', /"node_modules" is a dependency\/cache folder/],
    ['', /empty path/],
    ['   ', /empty path/],
    ['./', /workspace root/],
  ])('%s → 拒绝', (raw, re) => {
    const r = checkSaveDir(ws, raw);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(re);
    expect(r.message).toContain('交付/简历页图');   // 给出可照抄的写法
  });
});

describe('saveShotFiles：落盘', () => {
  it('逐级建目录、按名写入、返回相对路径、发 file_changed；再写一次报覆盖', async () => {
    const ws = workspace();
    const emitted = [];
    const ctx = { emit: (e) => emitted.push(e) };
    const files = srcFiles(2);
    const items = files.map((file, i) => ({ name: pageImageName('简历', i + 1), file }));
    const r = await saveShotFiles({ workspaceRoot: ws, projectId: 'proj_live_save0917', dirRel: '交付/简历页图', items, ctx });
    expect(r).toEqual({ ok: true, saved: ['交付/简历页图/简历-第1页.png', '交付/简历页图/简历-第2页.png'], overwritten: [] });
    expect(readFileSync(path.join(ws, '交付/简历页图/简历-第2页.png'), 'utf8')).toBe('BYTES-2');
    expect(emitted.map((e) => [e.type, e.filePath, e.event])).toEqual([
      ['run.file_changed', '交付/简历页图/简历-第1页.png', 'add'],
      ['run.file_changed', '交付/简历页图/简历-第2页.png', 'add'],
    ]);
    const again = await saveShotFiles({ workspaceRoot: ws, dirRel: '交付/简历页图', items, ctx });
    expect(again.overwritten).toEqual(r.saved);
    expect(emitted.slice(2).map((e) => e.event)).toEqual(['change', 'change']);
    // 原子写不留临时文件
    expect(readdirSync(path.join(ws, '交付/简历页图')).sort()).toEqual(['简历-第1页.png', '简历-第2页.png']);
  });

  it('页码按总页数补零，字典序即页序', () => {
    expect(pageImageName('报告', 3, 2)).toBe('报告-第03页.png');
    expect(pageImageName('报告', 12, 2)).toBe('报告-第12页.png');
    expect(pageImageName('简历', 1)).toBe('简历-第1页.png');
  });

  it('目录链路上有指向工作区外的软链 → 拒，外面不落任何文件', async () => {
    const ws = workspace();
    const outside = workspace();
    symlinkSync(outside, path.join(ws, '跳板'));
    const r = await saveShotFiles({ workspaceRoot: ws, dirRel: '跳板/页图', items: [{ name: 'a.png', file: srcFiles(1)[0] }] });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('outside the workspace');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('目标文件本身是软链 → 拒，软链指向的文件不被改', async () => {
    const ws = workspace();
    const outside = workspace();
    writeFileSync(path.join(outside, 'victim.png'), 'ORIGINAL');
    mkdirSync(path.join(ws, '页图'));
    symlinkSync(path.join(outside, 'victim.png'), path.join(ws, '页图', '简历-第1页.png'));
    const r = await saveShotFiles({ workspaceRoot: ws, dirRel: '页图', items: [{ name: '简历-第1页.png', file: srcFiles(1)[0] }] });
    expect(r.ok).toBe(false);
    expect(readFileSync(path.join(outside, 'victim.png'), 'utf8')).toBe('ORIGINAL');
  });

  it('同名文件挡着目录名 → 拒', async () => {
    const ws = workspace();
    writeFileSync(path.join(ws, '交付'), 'x');
    const r = await saveShotFiles({ workspaceRoot: ws, dirRel: '交付/页图', items: [{ name: 'a.png', file: srcFiles(1)[0] }] });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('is not a folder');
  });

  it('项目已删除 → 拒（PROJECT_GONE），工作区里什么都不建', async () => {
    const ws = workspace();
    const r = await saveShotFiles({ workspaceRoot: ws, projectId: 'proj_gone_save0917', dirRel: '交付/页图', items: [{ name: 'a.png', file: srcFiles(1)[0] }] });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('PROJECT_GONE');
    expect(existsSync(path.join(ws, '交付'))).toBe(false);
  });
});

describe('screenshotDocx 接线', () => {
  function docxTarget(ws) {
    writeFileSync(path.join(ws, '简历.docx'), 'fake docx');
    return { absPath: path.join(ws, '简历.docx'), relPath: '简历.docx', kind: 'docx' };
  }

  it('saveTo：渲一次，回图的同时把同一批 PNG 写进目录，caption 列出路径并提示文件夹与交付', async () => {
    const ws = workspace();
    const r = await screenshotDocx(docxTarget(ws), { saveTo: '交付/简历页图', workspaceRoot: ws, projectId: 'proj_live_save0917' });
    expect(r.isError).toBeFalsy();
    expect(renderCalls).toHaveLength(1);
    expect(r.content.filter((b) => b.type === 'image')).toHaveLength(2);
    const text = r.content[0].text;
    expect(text).toContain('saved 2 page image(s) to 交付/简历页图/: 交付/简历页图/简历-第1页.png, 交付/简历页图/简历-第2页.png');
    expect(text).toContain('deliver_files with that folder');
    expect(readFileSync(path.join(ws, '交付/简历页图/简历-第2页.png'), 'utf8')).toBe('PNG-page-2-dpi-100');
  });

  it('pages 与 detail 照常生效：12 页文档的第 3-4 页、150dpi 落成第03页/第04页（按总页数补零）', async () => {
    const ws = workspace();
    pdfPages = 12;
    const r = await screenshotDocx(docxTarget(ws), { saveTo: '页图', pages: '3-4', detail: 'high', workspaceRoot: ws });
    expect(r.isError).toBeFalsy();
    expect(readdirSync(path.join(ws, '页图')).sort()).toEqual(['简历-第03页.png', '简历-第04页.png']);
    expect(readFileSync(path.join(ws, '页图/简历-第04页.png'), 'utf8')).toBe('PNG-page-4-dpi-150');
  });

  it('shot:false + saveTo：只落盘，不回图', async () => {
    const ws = workspace();
    const r = await screenshotDocx(docxTarget(ws), { saveTo: '页图', shot: false, workspaceRoot: ws });
    expect(r.isError).toBeFalsy();
    expect(r.content.every((b) => b.type === 'text')).toBe(true);
    expect(r.content[0].text).toContain('shot:false');
    expect(existsSync(path.join(ws, '页图/简历-第1页.png'))).toBe(true);
  });

  it('同名覆盖在返回里说明', async () => {
    const ws = workspace();
    const target = docxTarget(ws);
    await screenshotDocx(target, { saveTo: '页图', workspaceRoot: ws });
    const r = await screenshotDocx(target, { saveTo: '页图', workspaceRoot: ws });
    expect(r.content[0].text).toContain('overwrote existing file(s): 页图/简历-第1页.png, 页图/简历-第2页.png');
  });

  it('路径不合法 → 拒，且不渲染', async () => {
    const ws = workspace();
    const r = await screenshotDocx(docxTarget(ws), { saveTo: '.claude/页图', workspaceRoot: ws });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/saveTo rejected/);
    expect(renderCalls).toHaveLength(0);
    expect(existsSync(path.join(ws, '.claude'))).toBe(false);
  });

  it('项目已删除 → 报错，不回图、不落盘', async () => {
    const ws = workspace();
    const r = await screenshotDocx(docxTarget(ws), { saveTo: '页图', workspaceRoot: ws, projectId: 'proj_gone_save0917' });
    expect(r.isError).toBe(true);
    expect(r.content).toHaveLength(1);
    expect(r.content[0].text).toContain('PROJECT_GONE');
    expect(existsSync(path.join(ws, '页图'))).toBe(false);
  });

  it('不传 saveTo：行为不变，不写任何文件', async () => {
    const ws = workspace();
    const r = await screenshotDocx(docxTarget(ws), { workspaceRoot: ws });
    expect(r.content.filter((b) => b.type === 'image')).toHaveLength(2);
    expect(readdirSync(ws)).toEqual(['简历.docx']);
  });
});
