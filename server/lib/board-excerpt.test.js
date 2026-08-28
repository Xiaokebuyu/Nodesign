/**
 * 板书预览（首页卡片那几行字）。
 *
 * 这块最容易悄悄坏的两处：frontmatter 没剥干净（卡上出现 "nd: chalk"）、
 * 按字节截把多字节字符劈成两半（卡上出现乱码方块）。两处都不会报错。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chalkPreview, excerptOf, CHALK_DIR } from './board-excerpt.js';

const FM = `---
nd: chalk
by: rp-ichinose_kanade
at: 2026-08-28T20:11:39.119Z
---

「……」

我把桌上的口水渍用袖口蹭了蹭。
`;

describe('excerptOf', () => {
  it('剥掉 frontmatter，只留正文', () => {
    const out = excerptOf(FM, 150);
    expect(out).not.toMatch(/nd: chalk|rp-ichinose/);
    expect(out.startsWith('「……」')).toBe(true);
  });

  it('行首的 # / > / - 记号去掉 —— 卡上那几行是笔迹不是排版', () => {
    expect(excerptOf('## 第一章\n> 引用\n- 一条', 150)).toBe('第一章\n引用\n一条');
  });

  /** 下面三条全是 08-28 上线后在**真卡片上**看见的噪音，不是想出来的 */
  it('围栏块整段扔掉 —— nd:controls 会把一坨源码倒到卡上', () => {
    const out = excerptOf('塔楼就在前面了，怎么接？\n```nd:controls\n[靠近] 走到塔楼门前 ->\n```\n他停下脚步。', 150);
    expect(out).not.toMatch(/nd:controls|\[靠近\]/);
    expect(out).toBe('塔楼就在前面了，怎么接？\n他停下脚步。');
  });

  it('没闭合的围栏也得扔（宁可少几行，不能把源码倒上去）', () => {
    expect(excerptOf('前面一句\n```nd:controls\n[甲] 没写完', 150)).toBe('前面一句');
  });

  it('行内的强调/行内码只留字', () => {
    expect(excerptOf('**塔楼**就在*前面*了 `x`', 150)).toBe('塔楼就在前面了 x');
  });

  it('任务框记号去掉', () => {
    expect(excerptOf('[x] 拆预设\n[ ] 写第二拍', 150)).toBe('拆预设\n写第二拍');
  });

  it('空行不占行数（卡上只有六行的位置）', () => {
    expect(excerptOf('a\n\n\n\nb', 150)).toBe('a\nb');
  });

  it('超长的截断并带省略号', () => {
    const out = excerptOf('啊'.repeat(400), 20);
    expect(out.length).toBeLessThanOrEqual(21);
    expect(out.endsWith('…')).toBe(true);
  });

  it('只有 frontmatter 没正文 → 空串（调用方据此当作没有板书）', () => {
    expect(excerptOf('---\nnd: chalk\n---\n\n\n', 150)).toBe('');
  });
});

describe('chalkPreview', () => {
  let dir;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-chalk-'));
    await fs.mkdir(path.join(dir, CHALK_DIR), { recursive: true });
    await fs.writeFile(path.join(dir, CHALK_DIR, '20260828-200012-旧.md'), '---\nnd: chalk\n---\n\n最早那条\n');
    await fs.writeFile(path.join(dir, CHALK_DIR, '20260828-201139-新.md'), FM);
    await fs.writeFile(path.join(dir, CHALK_DIR, '不是markdown.txt'), '不算');
  });
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('挑最新那条（按文件名倒序，文件名带时间戳前缀）', async () => {
    const r = await chalkPreview(dir);
    expect(r.text.startsWith('「……」')).toBe(true);
    expect(r.count, '只数 .md').toBe(2);
  });

  it('没有板书目录就是 null，不是抛错', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-nochalk-'));
    expect(await chalkPreview(empty)).toBe(null);
    await fs.rm(empty, { recursive: true, force: true });
  });

  it('⚠️ 只读文件头几 KB，但不许把多字节字符劈出乱码', async () => {
    const big = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-bigchalk-'));
    await fs.mkdir(path.join(big, CHALK_DIR), { recursive: true });
    // 4096 不是 3 的倍数 → 按字节截必然落在某个汉字中间
    await fs.writeFile(path.join(big, CHALK_DIR, '20260828-1-x.md'), `---\nnd: chalk\n---\n\n${'字'.repeat(4000)}`);
    const r = await chalkPreview(big, { max: 4000 });
    expect(r.text).not.toMatch(/�/);
    await fs.rm(big, { recursive: true, force: true });
  });
});
