/**
 * 卡 id 正字法：一份规则、两端一致（2026-08-31，proj_mtgeaeps_7kly 真案）。
 *
 * 病根：这条规则全仓有三份实现，第三份（pin_to_board 的内联猜测）**只认
 * `.html → deck:`**。agent pin 一份 .docx，id 停在裸路径，而裸 id 在前端根本
 * 不渲染任何卡（assets.js 的 docxClaimedFiles 把被产物认领的 .docx 从散文件
 * 清单里滤掉了）—— 工具照样报「Placed ... at (688,120)」，屏幕上什么也没发生，
 * 连它身上的三条关系线也一条画不出（BindingLayer 的 rectOf 拿不到矩形就 continue）。
 *
 * 这一族的前三例见 lib/board-relations.js 头上那段。这里钉两件事：
 *   ① 服务端 cardIdOf 跟前端 cardIdOf **逐例相等**（两端岔开就是同一件东西两份实现）
 *   ② 路径到卡 id 的解析走注册表，不猜扩展名
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { cardIdOf, cardIdForPath, KIND_PREFIX_RE } from './index.js';
import { cardIdOf as feCardIdOf } from '../../../web/src/lib/board-kinds.js';

/** 覆盖每种形态的单文件/目录型两态；形状照 taskManifest().artifacts 的真字段 */
const CASES = [
  ['单份 docx（根层散放，无 members）', '', { kind: 'docx', file: 'a.docx' }],
  ['word 文件夹（带 members）', '', { kind: 'docx', root: '报告', members: ['报告/终稿.docx'] }],
  ['deck', '', { kind: 'deck', file: 'canvas.html' }],
  ['deck（子任务里）', '子任务', { kind: 'deck', file: '子任务/canvas.html' }],
  ['单页站（_drafts 试作）', '', { kind: 'site', single: true, entryRel: '_drafts/showa.html' }],
  ['目录站（有 root）', 't1', { kind: 'site', root: 'dist' }],
  ['根站（root 为空，落回 taskId）', 't2', { kind: 'site', root: '' }],
];

describe('cardIdOf：服务端与前端同一条规则', () => {
  for (const [label, taskId, a] of CASES) {
    it(`⭐ ${label}`, () => {
      const mine = cardIdOf(taskId, a);
      expect(mine, '不该是 null').toBeTruthy();
      expect(mine, '服务端与前端岔开了').toBe(feCardIdOf(taskId, a));
      expect(KIND_PREFIX_RE.test(mine), `${mine} 不带合法形态前缀`).toBe(true);
    });
  }

  it('⭐⭐ 单份 .docx 必须带 docx: 前缀，不能停在裸路径', () => {
    // 裸路径 = 前端不渲染的幽灵条目，而工具照样会报 Placed
    expect(cardIdOf('', { kind: 'docx', file: '简历.docx' })).toBe('docx:简历.docx');
  });

  it('⭐ 前缀集从注册表派生，加形态自动进表', () => {
    expect(KIND_PREFIX_RE.test('docx:a')).toBe(true);
    expect(KIND_PREFIX_RE.test('site:a')).toBe(true);
    expect(KIND_PREFIX_RE.test('deck:a')).toBe(true);
    expect(KIND_PREFIX_RE.test('a.docx')).toBe(false);
  });
});

describe('cardIdForPath：路径到卡 id 走产物扫描，不猜扩展名', () => {
  it('⭐⭐ 根层散放的 .docx 解析成 docx: 前缀', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-cardid-'));
    await fs.writeFile(path.join(dir, '简历v8.docx'), 'PKfake');
    expect(await cardIdForPath(dir, '简历v8.docx')).toBe('docx:简历v8.docx');
  });

  it('.md 和数据文件不是产物，返回 null（调用方保持裸路径，那本来就是普通文件卡）', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-cardid2-'));
    await fs.writeFile(path.join(dir, '笔记.md'), '# hi');
    await fs.writeFile(path.join(dir, '数据.json'), '{}');
    expect(await cardIdForPath(dir, '笔记.md')).toBe(null);
    expect(await cardIdForPath(dir, '数据.json')).toBe(null);
  });

  it('越界路径不解析', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-cardid3-'));
    expect(await cardIdForPath(dir, '../外面.docx')).toBe(null);
    expect(await cardIdForPath(dir, '')).toBe(null);
  });
});
