/**
 * 锚点宽认（09-11）：意图层落位之后写板硬失败的大头是「锚点不在板上」，全是 agent 的自然叫法。
 * 这些真案原样当夹具：只收唯一命中、命中要带 fuzzy（调用方如实报）、认不出给候选。
 */
import { describe, it, expect } from 'vitest';
import { makeAnchorResolver, suggestAnchors, anchorMissHint, anchorMissWhy, cleanAnchorName } from './board-anchor.js';

const card = (x, y, extra = {}) => ({ x, y, w: 200, h: 120, ...extra });
const board = () => ({
  zones: { 参考图: { x: 0, y: -400 } },
  objects: {
    'site:角色档案站': card(0, 0),
    'site:etsuko-site': card(300, 0),
    'browse': card(600, 0),
    '品牌手册/封面.png': card(0, 300),
    '品牌手册/配色.png': card(260, 300),
    'docs/刘万钢-简历-AI方向-v8.docx': card(0, 600),
    'docs/刘万钢-简历-产品方向-v8.docx': card(260, 600),
    'text:a1': card(900, 0, { kind: 'text', tag: 'story', data: { t: '第一拍', lid: 'n1' } }),
  },
});
const resolver = (seated = null) => makeAnchorResolver({
  projectId: 'p', known: new Set(['参考图']),
  readBoard: async () => { const b = board(); if (seated) b.objects[seated] = card(1200, 0); return b; },
  seatArtifacts: async (_pid, [rel]) => ({ seated: rel === seated ? 1 : 0 }),
});

describe('makeAnchorResolver：精确在前，宽认只收唯一命中', () => {
  it('精确的照旧：id / 文件夹 / tag，不带 fuzzy', async () => {
    const r = resolver();
    expect((await r('browse', board())).fuzzy).toBeUndefined();
    expect((await r('参考图', board())).folder).toBe(true);
    expect((await r('#story', board())).anchorId).toBe('text:a1');
  });

  it('真案：「角色档案站（site）」剥括注补前缀、「browse@48,10」剥坐标尾巴', async () => {
    const r = resolver();
    const a = await r('角色档案站（site）', board());
    expect(a.anchorId).toBe('site:角色档案站');
    expect(a.fuzzy.from).toBe('角色档案站（site）');
    expect((await r('browse@48,10', board())).anchorId).toBe('browse');
  });

  it('真案：「etsuko-site/index.html」认成站点卡', async () => {
    expect((await resolver()('etsuko-site/index.html', board())).anchorId).toBe('site:etsuko-site');
  });

  it('真案：「品牌手册」是目录名 → 那片已上板的东西整片当锚', async () => {
    const a = await resolver()('品牌手册', board());
    expect(a.rect).toMatchObject({ x: 0, y: 300, w: 460, h: 120 });
    expect(a.fuzzy.how).toMatch(/目录「品牌手册」下已上板的 2 件/);
  });

  it('唯一包含才认；两个都像就不猜（交给候选）', async () => {
    expect((await resolver()('简历-AI方向', board())).anchorId).toBe('docs/刘万钢-简历-AI方向-v8.docx');
    expect(await resolver()('刘万钢-简历', board())).toBeNull();
  });

  it('救援入座照旧：文件在盘上还没座位，当场排座再锚', async () => {
    const a = await resolver('assets/新图.png')('assets/新图.png', board());
    expect(a.rescued).toBe(true);
  });
});

describe('认不出时给候选', () => {
  it('真案：v8.1 不存在 → 点名最像的 v8', () => {
    expect(suggestAnchors('刘万钢-简历-AI方向-v8.1.docx', board())[0]).toBe('docs/刘万钢-简历-AI方向-v8.docx');
    expect(anchorMissHint('刘万钢-简历-AI方向-v8.1.docx', board())).toMatch(/^最像的：docs\/刘万钢-简历-AI方向-v8\.docx/);
  });

  it('一点都不像：指 read_board', () => {
    expect(anchorMissHint('量子纠缠', board())).toBe('read_board 看一眼现在都有谁');
  });

  it('cleanAnchorName 只剥外壳', () => {
    expect(cleanAnchorName('「品牌手册」')).toBe('品牌手册');
    expect(cleanAnchorName('#story')).toBe('story');
    expect(cleanAnchorName('a/b.png')).toBe('a/b.png');
  });
});

/**
 * 09-17 救援入座回查（iss_mt9cmke6_pset）：入座器按注册表落的是 `site:_drafts/x.html` / `docx:x.docx` / `site:X`，
 * 回查要按它返回的 ids 查；按 `deck:<路径>` / 裸路径猜的老路径第一次调用必失败、第二次才成功。
 */
describe('救援入座按实际落座的 id 回查（09-17）', () => {
  /** 模拟入座器：点名的路径按 table 落座，返回 ids；盘上没有的回 missing */
  const seatingResolver = (table, { onDisk = Object.keys(table), skipped = [] } = {}) => {
    const b = board();
    return makeAnchorResolver({
      projectId: 'p', known: new Set(['参考图']),
      readBoard: async () => b,
      seatArtifacts: async (_pid, [rel]) => {
        if (skipped.includes(rel)) return { seated: 0, ids: {}, missing: [], skipped: [rel] };
        if (!onDisk.includes(rel)) return { seated: 0, ids: {}, missing: [rel], skipped: [] };
        const id = table[rel]; const had = !!b.objects[id];
        b.objects[id] = b.objects[id] || card(1500, 0);
        return { seated: had ? 0 : 1, ids: { [rel]: id }, missing: [], skipped: [] };
      },
    });
  };

  it('⭐ 单页站 / 散放 docx：第一次调用就锚上入座器落的那张卡', async () => {
    const r = seatingResolver({ '_drafts/首发.html': 'site:_drafts/首发.html', '报告v2.docx': 'docx:报告v2.docx' });
    const a = await r('_drafts/首发.html', board());
    expect(a?.anchorId).toBe('site:_drafts/首发.html');
    expect(a.rescued).toBe(true);
    expect((await r('报告v2.docx', board()))?.anchorId).toBe('docx:报告v2.docx');
  });

  it('⭐ 站点目录里的文件：卡本来就有座位（seated=0）也认得回来，并说明认成了谁', async () => {
    const r = seatingResolver({ 'etsuko-site/css/a.css': 'site:etsuko-site' });
    const a = await r('etsuko-site/css/a.css', board());
    expect(a?.anchorId).toBe('site:etsuko-site');
    expect(a.fuzzy.how).toContain('归这张卡');
  });

  it('⭐ 认不出时的说法按入座器的真实结局：真查过不在才说「磁盘上也没有」', async () => {
    const r = seatingResolver({}, { onDisk: [], skipped: ['exports/交付.zip'] });
    expect(await r('量子纠缠', board())).toBeNull();
    expect(anchorMissWhy(r, '量子纠缠')).toContain('磁盘上也没有');
    expect(await r('exports/交付.zip', board())).toBeNull();
    expect(anchorMissWhy(r, 'exports/交付.zip')).not.toContain('磁盘上也没有');
    expect(anchorMissWhy(r, 'exports/交付.zip')).toContain('不作为一张卡上画布');
    // 没去入座（没有路径可入座）：不对磁盘下断言
    expect(anchorMissWhy(r, '从没问过的')).toBe('既没有座位，也不是任何 tag');
  });
});

describe('同名目录是站点卡时认卡，不认文件夹坐标（09-17 iss_mtp465ds_ctko）', () => {
  it('⭐ 「十三机兵（site）」「十三机兵」都认成 site:十三机兵，不是那层前端不画的文件夹', async () => {
    const b = board();
    b.zones['十三机兵'] = { x: 5000, y: 5000 };
    b.objects['site:十三机兵'] = card(0, 900);
    const r = resolver();
    for (const raw of ['十三机兵（site）', '十三机兵']) {
      const a = await r(raw, b);
      expect(a.anchorId, raw).toBe('site:十三机兵');
      expect(a.folder, raw).toBeUndefined();
    }
    expect((await r('参考图', b)).folder).toBe(true);   // 真文件夹照旧
  });

  it('括注里写着 id 的整段抄回（摘要印的手写字）：认那个 id', async () => {
    expect((await resolver()('手写字「第一拍」（text:a1）', board()))?.anchorId).toBe('text:a1');
  });
});
