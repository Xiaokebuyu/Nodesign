import { describe, it, expect } from 'vitest';
import { lintSiteHtml, isSitePagePath } from './site-validate.js';

const ok = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="style.css"></head>
<body><a href="about.html">关于</a><img src="assets/x.png"><a href="//cdn.example.com/x.js">cdn</a>
<!-- <a href="/commented-out">x</a> --><script>const s = '/not-markup';</script></body></html>`;

describe('site-validate lint', () => {
  it('干净页面零问题；注释/脚本里的根路径不算', () => {
    expect(lintSiteHtml(ok)).toEqual([]);
  });
  it('缺 viewport 报一条', () => {
    const r = lintSiteHtml(ok.replace(/<meta name="viewport"[^>]*>/, ''));
    expect(r).toHaveLength(1);
    expect(r[0].title).toMatch(/viewport/);
  });
  it('根路径 href/src 报一条并列出样本；协议相对不算', () => {
    const r = lintSiteHtml(ok.replace('href="about.html"', 'href="/about.html"').replace('src="assets/x.png"', 'src="/assets/x.png"'));
    expect(r).toHaveLength(1);
    expect(r[0].title).toMatch(/根路径链接 2 处.*\/about\.html.*\/assets\/x\.png/);
  });
  it('isSitePagePath：子目录里的 html 算站点页；根上的 deck、exports、非 html 不算', () => {
    const W = '/ws';
    expect(isSitePagePath(W, '/ws/观察日志/index.html')).toBe(true);
    expect(isSitePagePath(W, '观察日志/about.html')).toBe(true);
    expect(isSitePagePath(W, '/ws/deck.html')).toBe(false);
    expect(isSitePagePath(W, '/ws/exports/site/index.html')).toBe(false);
    expect(isSitePagePath(W, '/ws/_drafts/单页.html')).toBe(true);   // 09-07：试作也吃两条硬规则（方法论第一步就写它，嗅探器也当站点注入技术参考）
    expect(isSitePagePath(W, '/ws/观察日志/style.css')).toBe(false);
    expect(isSitePagePath(W, '/elsewhere/x/index.html')).toBe(false);
  });
});
