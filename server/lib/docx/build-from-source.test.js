import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { resolveSource, buildFromSource, DocxSourceError } from './build-from-source.js';
import { readZip, entryData } from './rawzip.js';

/**
 * 这套盯两件事：
 *   1. **schema 闭合真的拦得住** —— 没登记过的 token 键必须报错，否则
 *      agent 写错一个字段名，那条排版指令就静默失效（写了没生效比没写更坏）
 *   2. **报错要能让 agent 自己修** —— 说清楚哪一条、给出可选项，
 *      而不是丢一个 `unknown block: undefined` 出去
 */

describe('resolveSource —— 词典条目当起点', () => {
  it('preset 提供起点，tokens 在上面覆写', () => {
    const { tokens } = resolveSource({
      preset: '公文',
      tokens: { page: { size: 'A4', landscape: true } },
      content: [{ t: 'p', text: 'x' }],
    });
    expect(tokens.page.landscape).toBe(true);
    expect(Object.keys(tokens.styles).length).toBeGreaterThan(0);   // preset 的样式还在
  });

  it('不认识的词典条目要把现有的列出来', () => {
    expect(() => resolveSource({ preset: '赛博朋克', content: [{ t: 'p' }] }))
      .toThrow(/没有叫「赛博朋克」的词典条目/);
    try { resolveSource({ preset: '赛博朋克', content: [{ t: 'p' }] }); } catch (e) {
      expect(e.detail).toContain('公文');
      expect(e.detail).toContain('不写 preset');   // 告诉它风格名不是封闭菜单
    }
  });

  it('不给 preset 但给完整 tokens 也成立（风格名开放，不强制走词典）', () => {
    const { tokens } = resolveSource({
      tokens: { v: 1, fonts: {}, styles: {} },
      content: [{ t: 'p', text: 'x' }],
    });
    expect(tokens.v).toBe(1);
  });
});

describe('resolveSource —— 版本号 v（09-11：文档教写在顶层，以前只查 tokens.v）', () => {
  it('⭐不给 preset、v 只写在顶层（照 token-schema.md 写）也能过', () => {
    const { tokens } = resolveSource({
      v: 1,
      tokens: { fonts: {}, styles: {} },
      content: [{ t: 'p', text: 'x' }],
    });
    expect(tokens.v).toBe(1);
  });

  it('顶层和 tokens 都不写 v 也能过（v 只有一版）', () => {
    expect(() => resolveSource({ tokens: { fonts: {}, styles: {} }, content: [{ t: 'p', text: 'x' }] })).not.toThrow();
  });

  it('顶层 v 写错要指名是顶层', () => {
    expect(() => resolveSource({ v: 2, preset: '办公标准', content: [{ t: 'p', text: 'x' }] })).toThrow(/顶层 v 只能是 1/);
  });

  it('tokens.v 写错要指名是 tokens.v，并说明可以不写', () => {
    try {
      resolveSource({ v: 1, tokens: { v: 2, fonts: {}, styles: {} }, content: [{ t: 'p', text: 'x' }] });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DocxSourceError);
      expect(e.detail).toContain('tokens.v 只能是 1');
      expect(e.detail).toContain('可以不写');
    }
  });
});

describe('resolveSource —— `_` 注释键', () => {
  it('下划线开头的键被剥掉，不会被闭合 schema 当成未登记字段拒掉', () => {
    const { tokens, content } = resolveSource({
      _说明: 'JSON 没有注释语法，用 _ 前缀当约定',
      preset: '办公标准',
      tokens: { styles: { Normal: { _为什么: '解释这条样式', para: { _注: '两字符', indent: { firstLineChars: 200 } } } } },
      content: [{ t: 'p', _注: '开场白', text: 'x' }],
    });
    expect(tokens.styles.Normal.para.indent.firstLineChars).toBe(200);
    expect(tokens.styles.Normal._为什么).toBeUndefined();
    expect(content[0]._注).toBeUndefined();
  });
});

describe('resolveSource —— 值域校验（不只是键名）', () => {
  it("⭐lineRule 写成 'auto' 必须报错 —— 它不会静默失效，会静默生效成每行五英寸", () => {
    try {
      resolveSource({
        preset: '办公标准',
        tokens: { styles: { Normal: { para: { spacing: { line: 360, lineRule: 'auto' } } } } },
        content: [{ t: 'p', text: 'x' }],
      });
      throw new Error('本该抛');
    } catch (e) {
      expect(e.detail).toContain('lineRule');
      expect(e.detail).toContain('multiple');
    }
  });

  it('lineRule=multiple 时给了磅值量级的 line，也要拦', () => {
    expect(() => resolveSource({
      preset: '办公标准',
      tokens: { styles: { Normal: { para: { spacing: { line: 28, lineRule: 'multiple' } } } } },
      content: [{ t: 'p', text: 'x' }],
    })).toThrow(/token 没过校验/);
  });

  it('样式里的字号名写错要报错（原来只校验 base 那一处）', () => {
    try {
      resolveSource({
        preset: '办公标准',
        tokens: { styles: { Normal: { run: { sizePt: '中四' } } } },
        content: [{ t: 'p', text: 'x' }],
      });
      throw new Error('本该抛');
    } catch (e) {
      expect(e.detail).toMatch(/unknown 字号/);
    }
  });
});

describe('resolveSource —— schema 闭合', () => {
  it('⭐没登记过的 token 键必须报错，不能静默吞掉', () => {
    expect(() => resolveSource({
      preset: '办公标准',
      tokens: { styles: { Normal: { para: { 首行缩进: 2 } } } },
      content: [{ t: 'p', text: 'x' }],
    })).toThrow(/token 没过校验/);
  });

  it('指向不存在的字体槽要报错', () => {
    try {
      resolveSource({
        preset: '办公标准',
        tokens: { styles: { Normal: { run: { font: '不存在的槽' } } } },
        content: [{ t: 'p', text: 'x' }],
      });
      throw new Error('本该抛');
    } catch (e) {
      expect(e).toBeInstanceOf(DocxSourceError);
      expect(e.detail).toContain('no such font slot');
    }
  });
});

describe('resolveSource —— 报错要能自修', () => {
  it('块类型认不出时，指出是第几块并列出合法值', () => {
    try {
      resolveSource({ preset: '办公标准', content: [{ t: 'p', text: 'a' }, { t: '段落', text: 'b' }] });
      throw new Error('本该抛');
    } catch (e) {
      expect(e.message).toContain('content[1]');
      expect(e.detail).toContain("{t:'p'}");
    }
  });

  it('content 空了要说会是白纸，不能构建出一份空文档', () => {
    expect(() => resolveSource({ preset: '公文', content: [] })).toThrow(/白纸/);
  });

  it('既没 preset 也没 tokens', () => {
    expect(() => resolveSource({ content: [{ t: 'p' }] })).toThrow(/不知道按什么排版/);
  });
});

describe('缩进互斥 —— firstLine* 与 hanging* 同给必须拦（写了会静默覆盖悬挂）', () => {
  it('块级：firstLineChars: 0 + hangingChars 是最典型的踩法', () => {
    try {
      resolveSource({
        preset: '办公标准',
        content: [{ t: 'p', indent: { firstLineChars: 0, hangingChars: 450 }, text: 'x' }],
      });
      throw new Error('本该抛');
    } catch (e) {
      expect(e.detail).toContain('互斥');
      expect(e.detail).toContain('hanging');   // 告诉它留哪一半
    }
  });

  it('样式级：twip 系写法同样拦', () => {
    expect(() => resolveSource({
      preset: '办公标准',
      tokens: { styles: { Tag: { type: 'paragraph', name: 'Tag', para: { indent: { firstLineTwip: 0, hangingTwip: 1320 } } } } },
      content: [{ t: 'p', text: 'x' }],
    })).toThrow(/token 没过校验/);
  });

  it('只写 hanging* 是正路，不拦', () => {
    const { content } = resolveSource({
      preset: '办公标准',
      content: [{ t: 'p', indent: { leftChars: 450, hangingChars: 450 }, text: 'x' }],
    });
    expect(content[0].indent.hangingChars).toBe(450);
  });
});

describe('超链接 —— run 上的 link 键', () => {
  const src = (content, extra = {}) => ({ preset: '办公标准', content, ...extra });

  it('没协议的 link 被拒，报错里给出可用协议', () => {
    try {
      resolveSource(src([{ t: 'p', runs: [{ text: 'x', link: 'github.com/a' }] }]));
      throw new Error('本该抛');
    } catch (e) {
      expect(e.detail).toContain('https://');
    }
  });

  it('link 必须配着 text（没有可点的字的链接没有意义）', () => {
    expect(() => resolveSource(src([{ t: 'p', runs: [{ br: true, link: 'https://a.com' }] }])))
      .toThrow(/认不出的字段|content/);
  });

  it('页眉页脚里的 link 被拒（要单独关系表，还没做 —— 拒了才不产悬空 r:id）', () => {
    expect(() => resolveSource(src([{ t: 'p', text: 'x' }],
      { footer: [{ t: 'p', runs: [{ text: 'a', link: 'https://a.com' }] }] })))
      .toThrow(/页脚/);
  });

  it('构建出的 docx：w:hyperlink 包住 run，关系表带 TargetMode="External"，& 转义，同 URL 复用 rId', async () => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-link-'));
    const srcPath = path.join(d, '文档.json');
    const out = path.join(d, '文档.docx');
    const url = 'https://example.com/q?a=1&b=2';
    await fs.writeFile(srcPath, JSON.stringify({
      preset: '办公标准',
      content: [
        { t: 'p', runs: [{ text: '主页', link: url }, ' 和 ', { text: '再来一次', link: url }] },
        { t: 'p', runs: [{ text: '邮箱', link: 'mailto:a@b.com' }] },
        { t: 'table', widthsTwip: [4000, 4000], rows: [[{ text: '格里的链接', runs: [{ text: '格里', link: 'https://cell.example' }] }, 'x']] },
      ],
      footer: '— 1 —',   // 占掉一个 rId，验证超链接的号段避让
    }));
    await buildFromSource(srcPath, out);
    const zip = readZip(await fs.readFile(out));
    const doc = entryData(zip, 'word/document.xml').toString('utf8');
    const rels = entryData(zip, 'word/_rels/document.xml.rels').toString('utf8');

    const hlinks = doc.match(/<w:hyperlink r:id="(rId\d+)"/g) ?? [];
    expect(hlinks.length).toBe(4);
    expect(new Set(hlinks).size).toBe(3);                       // 同 URL 两处 = 同一个 rId
    expect(rels).toContain('TargetMode="External"');
    expect(rels).toContain('a=1&amp;b=2');                      // & 必须转义成合法 XML
    expect(rels).toContain('mailto:a@b.com');
    // 超链接的 rId 不许撞 footer 已占的号
    const footerId = rels.match(/Id="(rId\d+)"[^>]*footer/)[1];
    for (const h of new Set(hlinks)) expect(h).not.toContain(`"${footerId}"`);
    await fs.rm(d, { recursive: true, force: true });
  });

  it('块级 / 单元格 color 是各 run 的缺省色，run 自己写了听 run 的（09-11 雾岭手册：unknown key color）', async () => {
    const src = {
      preset: '办公标准',
      content: [
        { t: 'p', color: 'CC0000', runs: ['红一', { text: '蓝', color: '0000FF' }] },
        { t: 'table', widthsTwip: [4000, 4000], rows: [[{ text: '红格', color: 'CC0000' }, '无色']] },
      ],
    };
    expect(() => resolveSource(src)).not.toThrow();
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-color-'));
    const srcPath = path.join(d, '染色.json');
    const out = path.join(d, '染色.docx');
    await fs.writeFile(srcPath, JSON.stringify(src));
    await buildFromSource(srcPath, out);
    const doc = entryData(readZip(await fs.readFile(out)), 'word/document.xml').toString('utf8');
    expect(doc.match(/<w:color w:val="CC0000"\/>/g)?.length).toBe(2);   // 红一 + 红格
    expect(doc.match(/<w:color w:val="0000FF"\/>/g)?.length).toBe(1);   // 蓝没被块色盖掉
    await fs.rm(d, { recursive: true, force: true });
  });

  it('表格 borders：不写 = 满格细黑线（跟以前一样）；horizontal 只留横线；按边写的对象里没写的边没有线', async () => {
    const tbl = (borders) => ({ t: 'table', widthsTwip: [4000, 4000], rows: [['a', 'b'], ['c', 'd']], ...(borders ? { borders } : {}) });
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-tblbd-'));
    const srcPath = path.join(d, '边框.json');
    const out = path.join(d, '边框.docx');
    await fs.writeFile(srcPath, JSON.stringify({
      preset: '办公标准',
      content: [tbl(), tbl('horizontal'), tbl({ top: { sizePt8: 8 }, insideH: { sizePt8: 2, color: 'BFBFBF' } })],
    }));
    await buildFromSource(srcPath, out);
    const doc = entryData(readZip(await fs.readFile(out)), 'word/document.xml').toString('utf8');
    const bd = [...doc.matchAll(/<w:tblBorders>(.*?)<\/w:tblBorders>/g)].map((m) => m[1]);
    expect(bd).toHaveLength(3);
    expect(bd[0]).toBe(['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`).join(''));   // 存量文档逐字节不变
    expect(bd[1]).toContain('<w:insideH w:val="single" w:sz="4"');
    expect(bd[1]).toContain('<w:insideV w:val="nil"/>');
    expect(bd[1]).toContain('<w:left w:val="nil"/>');
    expect(bd[2]).toContain('<w:insideH w:val="single" w:sz="2" w:space="0" w:color="BFBFBF"/>');
    expect(bd[2]).toContain('<w:bottom w:val="nil"/>');
    await fs.rm(d, { recursive: true, force: true });
  });

  it('表格 borders 写错要报清楚：认不出的预设 / 认不出的边 / 颜色带 # / 线型不存在 / 粗细越界', () => {
    const errOf = (borders) => {
      try { resolveSource({ preset: '办公标准', content: [{ t: 'table', widthsTwip: [8000], rows: [['x']], borders }] }); } catch (e) { return `${e.message}\n${e.detail ?? ''}`; }
      return '';
    };
    expect(errOf('三线')).toMatch(/没有「三线」这种写法，可选 grid \/ horizontal \/ none/);
    expect(errOf({ middle: {} })).toMatch(/unknown key middle/);
    expect(errOf({ top: { color: '#000000' } })).toMatch(/不带 #/);
    expect(errOf({ top: { style: 'wavy' } })).toMatch(/style: 可选 single/);
    expect(errOf({ top: { sizePt8: 200 } })).toMatch(/2 到 96/);
    expect(errOf({ top: { sizePt8: 8 }, left: null })).toBe('');   // null = 这条边不要线，合法
  });
});

describe('buildFromSource —— 落盘', () => {
  it('真写出一个能解开的 docx，styles.xml 里有 preset 的样式', async () => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-bfs-'));
    const src = path.join(d, '文档.json');
    const out = path.join(d, '文档.docx');
    await fs.writeFile(src, JSON.stringify({
      preset: '公文',
      content: [{ t: 'p', style: 'Normal', text: '正文一段。' }],
      footer: '— 1 —',
    }));
    const r = await buildFromSource(src, out);
    expect(r.blocks).toBe(1);
    expect(r.preset).toBe('公文');
    expect(r.bytes).toBeGreaterThan(1000);

    const zip = readZip(await fs.readFile(out));
    expect([...zip.entries.keys()]).toContain('word/styles.xml');
    expect([...zip.entries.keys()]).toContain('word/footer1.xml');
    // ⭐中文用户的地基：eastAsia 槽必须真的写进去了
    expect(entryData(zip, 'word/styles.xml').toString('utf8')).toContain('w:eastAsia');
    await fs.rm(d, { recursive: true, force: true });
  });

  it('页眉页脚：字符串当一行文字，块数组原样传（页码域要靠后者）', () => {
    const a = resolveSource({ preset: '公文', content: [{ t: 'p', text: 'x' }], footer: '第一页' });
    expect(a.opts.footer).toEqual([{ t: 'p', style: 'Normal', text: '第一页' }]);
    const blocks = [{ t: 'p', style: 'Footer', runs: [{ text: '— ' }, { fld: 'PAGE' }, { text: ' —' }] }];
    const b = resolveSource({ preset: '公文', content: [{ t: 'p', text: 'x' }], footer: blocks });
    // 内容相等而非同一对象：stripNotes（剥 `_` 注释键）会深拷贝整份源
    expect(b.opts.footer).toEqual(blocks);
    expect(resolveSource({ preset: '公文', content: [{ t: 'p', text: 'x' }] }).opts.header).toBeUndefined();
  });

  it('源文件不是合法 JSON 时报得明白', async () => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-bfs2-'));
    await fs.writeFile(path.join(d, 'x.json'), '{ 这不是 json');
    await expect(buildFromSource(path.join(d, 'x.json'), path.join(d, 'x.docx')))
      .rejects.toThrow(/不是合法 JSON/);
    await fs.rm(d, { recursive: true, force: true });
  });

  it('源文件不存在', async () => {
    await expect(buildFromSource('/nope/文档.json', '/nope/文档.docx')).rejects.toThrow(/读不到源文件/);
  });
});
