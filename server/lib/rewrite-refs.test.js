/**
 * rewrite-refs 单测（08-24，iss_mt38uih6；09-14 重写后补反例）。自动改写用户内容的东西，
 * 正反两面都要钉：该改的改到、不该碰的一个字不动。
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rewriteRefsInText, makeMoveResolver, rewriteWorkspaceRefs } from './rewrite-refs.js';

const run = (text, { ext = 'html', oldDir = '', newDir = oldDir, moves = [], exists = () => false } = {}) =>
  rewriteRefsInText(text, { ext, oldDir, newDir, resolveMove: makeMoveResolver(moves).forward, exists });

describe('引用文件没搬，目标搬了', () => {
  const moves = [{ from: 'assets/generated/a.png', to: '素材/a.png' }];

  it('根层 html 的引号引用', () => {
    const r = run('<img src="assets/generated/a.png">', { moves });
    expect(r.text).toBe('<img src="素材/a.png">');
    expect(r.hits).toBe(1);
  });

  it('子目录页面的 ../ 写法按自己目录换算（css url 不带引号）', () => {
    const r = run('.a{background:url(../assets/generated/a.png)}', { ext: 'css', oldDir: '站点', moves });
    expect(r.text).toBe('.a{background:url(../素材/a.png)}');
  });

  it('URL 编码变体：改完仍按编码写', () => {
    const r = run('<img src="%E7%B4%A0%20%E6%9D%90/%E5%9B%BE%201.png">', { moves: [{ from: '素 材/图 1.png', to: '归档/图 1.png' }] });
    expect(r.text).toBe(`<img src="${encodeURI('归档/图 1.png')}">`);
  });

  it('查询串与锚点保留', () => {
    const r = run('<img src="assets/generated/a.png?v=3#x">', { moves });
    expect(r.text).toBe('<img src="素材/a.png?v=3#x">');
  });

  it('搬文件夹：夹里的文件按前缀改', () => {
    const r = run('<a href="旧夹/深处/x.png">', { moves: [{ from: '旧夹', to: '新夹' }] });
    expect(r.text).toBe('<a href="新夹/深处/x.png">');
  });

  it('md 链接改，正文里的同名单词不改', () => {
    const md = 'these images are old, (images) too\n![图](images/a.png)';
    const r = run(md, { ext: 'md', moves: [{ from: 'images', to: '_drafts/images' }] });
    expect(r.text).toBe('these images are old, (images) too\n![图](_drafts/images/a.png)');
  });

  it('JS 里的路径字符串改，普通字符串不改', () => {
    const js = "const kind = 'images'; fetch('images/a.png'); const n = '1.6';";
    const r = run(js, { ext: 'js', moves: [{ from: 'images', to: '素材' }] });
    expect(r.text).toBe("const kind = 'images'; fetch('素材/a.png'); const n = '1.6';");
  });

  it('srcset 每个候选都改', () => {
    const r = run('<img srcset="assets/generated/a.png 1x, assets/generated/a.png 2x">', { moves });
    expect(r.text).toBe('<img srcset="素材/a.png 1x, 素材/a.png 2x">');
    expect(r.hits).toBe(2);
  });
});

describe('⛔ 09-14 实报：引用文件自己搬了，数字和非引用位置一个字不动', () => {
  const page = [
    '<?xml version="1.0"?>',
    '<meta name="viewport" content="width=device-width,initial-scale=1.0">',
    '<style>.a{background:rgba(255,255,255,.045);transform:scale(4.2) translate(10px,2.5px)}</style>',
    '<svg><stop offset="0" stop-opacity=".10"/><path stroke-width="1.6"/></svg>',
    '<script>const r=(Math.PI);f(el.value)</script>',
  ].join('\n');

  it('从 _drafts 搬到别的夹：报告里那四处原样', () => {
    const r = run(page, { oldDir: '_drafts', newDir: '归档', exists: () => true });
    expect(r.text).toBe(page);
    expect(r.hits).toBe(0);
  });

  it('真引用照样换基准（目标在磁盘上才换）', () => {
    const html = `${page}\n<img src="assets/x.png"><img src="assets/gone.png">`;
    const r = run(html, { oldDir: '', newDir: '_drafts', exists: (rel) => rel === 'assets/x.png' });
    expect(r.text).toBe(`${page}\n<img src="../assets/x.png"><img src="assets/gone.png">`);
    expect(r.hits).toBe(1);
  });

  it('目标也搬了：查 moves 表', () => {
    const r = run('<img src="assets/x.png">', { newDir: '夹', moves: [{ from: 'assets/x.png', to: '夹/x.png' }] });
    expect(r.text).toBe('<img src="x.png">');
  });

  it('http / data / 锚点 / 绝对路径 / mailto 不碰', () => {
    const t = '<a href="https://a.b/c.png"><img src="data:image/png;base64,xx"><a href="#top"><a href="/abs.png"><a href="mailto:a@b.c">';
    expect(run(t, { newDir: '夹', exists: () => true }).text).toBe(t);
  });

  it('坏编码（裸 %）不抛异常', () => {
    expect(() => run('<i style="w:(100%.5)"><img src="a%zz.png">', { newDir: '夹', exists: () => true })).not.toThrow();
  });
});

describe('rewriteWorkspaceRefs（真文件端到端）', () => {
  it('归纳图片进新夹：根 deck 与子页引用都改，改动数如实上报', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'rwref-'));
    await mkdir(path.join(ws, 'assets/generated'), { recursive: true });
    await mkdir(path.join(ws, '站点'), { recursive: true });
    await mkdir(path.join(ws, '素材'), { recursive: true });
    await writeFile(path.join(ws, 'assets/generated/a.png'), 'x');
    await writeFile(path.join(ws, 'canvas.html'), '<img src="assets/generated/a.png">');
    await writeFile(path.join(ws, '站点/index.html'), '<img src="../assets/generated/a.png">');
    await rename(path.join(ws, 'assets/generated/a.png'), path.join(ws, '素材/a.png'));
    const out = await rewriteWorkspaceRefs(ws, [{ from: 'assets/generated/a.png', to: '素材/a.png' }]);
    expect(out.files).toBe(2);
    expect(out.hits).toBe(2);
    expect(await readFile(path.join(ws, 'canvas.html'), 'utf8')).toBe('<img src="素材/a.png">');
    expect(await readFile(path.join(ws, '站点/index.html'), 'utf8')).toBe('<img src="../素材/a.png">');
    expect(out.lines.join('\n')).toContain('assets/generated/a.png → 素材/a.png');
  });

  it('⛔ 09-14 实报端到端：页面自己被搬，内联 CSS / SVG 一个字节不变', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'rwref-'));
    await mkdir(path.join(ws, '_drafts'), { recursive: true });
    await mkdir(path.join(ws, '归档'), { recursive: true });
    const html = '<style>.a{background:rgba(255,255,255,.045);transform:scale(4.2)}</style><svg><stop stop-opacity=".10"/><path stroke-width="1.6"/></svg>';
    await writeFile(path.join(ws, '_drafts/a.html'), html);
    await rename(path.join(ws, '_drafts/a.html'), path.join(ws, '归档/a.html'));
    const out = await rewriteWorkspaceRefs(ws, [{ from: '_drafts/a.html', to: '归档/a.html' }]);
    expect(out.hits).toBe(0);
    expect(await readFile(path.join(ws, '归档/a.html'), 'utf8')).toBe(html);
  });

  it('搬整个站点文件夹：夹里页面引用夹外的共享样式要换基准，夹内互相引用不动', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'rwref-'));
    await mkdir(path.join(ws, 'site'), { recursive: true });
    await mkdir(path.join(ws, '_drafts'), { recursive: true });
    await writeFile(path.join(ws, 'shared.css'), 'x');
    await writeFile(path.join(ws, 'site/style.css'), 'x');
    await writeFile(path.join(ws, 'site/index.html'), '<link href="../shared.css"><link href="style.css">');
    await rename(path.join(ws, 'site'), path.join(ws, '_drafts/site'));
    const out = await rewriteWorkspaceRefs(ws, [{ from: 'site', to: '_drafts/site' }]);
    expect(await readFile(path.join(ws, '_drafts/site/index.html'), 'utf8')).toBe('<link href="../../shared.css"><link href="style.css">');
    expect(out.hits).toBe(1);
  });
});
