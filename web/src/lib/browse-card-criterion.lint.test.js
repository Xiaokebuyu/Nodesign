/**
 * 浏览器卡的存在判据只有一份（2026-09-10 的 lint）。
 *
 * 病史：判据是「有访问记录 **或** 采到过东西」—— 服务端 `engine/browse/card.js` 这么判，
 * 派生层 `board-objects.js` 也这么判（注释里还专门写了为什么是两者之一）。可数据层
 * `useBoardData` 在中间**又自己写了半句** `r?.url ? r : null`，比另外两处严一档。
 * 于是"采过站但没有访问记录"的项目：服务端给了卡，数据层扔掉 → 桌面上没有这张卡
 * → 没有座位 → **没有坐标**，agent 的 read_board 看不见它、`place:{by:'browse'}` 锚不上。
 * 线上真有两个这样的项目（proj_msxdfzak_9fhb、proj_mtulv6t1_mo5h）。
 *
 * 判据不写在注释里（注释拦不住下一个人，见 feedback-contract-needs-a-lint）：
 * 谁要判"这个项目有没有浏览器卡"，就得问 hasBrowseCard。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasBrowseCard, deriveBoardObjects } from './board-objects.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('hasBrowseCard', () => {
  it('有访问记录**或**采到过东西都算有卡', () => {
    expect(hasBrowseCard({ url: 'https://example.com', sites: [] })).toBe(true);
    expect(hasBrowseCard({ url: null, sites: [{ site: 'a', count: 1 }] })).toBe(true);   // 采过但没访问记录
    expect(hasBrowseCard({ url: null, sites: [] })).toBe(false);
    expect(hasBrowseCard(null)).toBe(false);
  });

  it('采过但没访问记录：桌面上要有这张卡（有卡才有座位，有座位才有坐标）', () => {
    const objs = deriveBoardObjects({ browse: { url: null, sites: [{ site: '早期采集', count: 1 }], host: '早期采集' } });
    expect(objs.find(o => o.id === 'browse')).toBeTruthy();
  });
});

describe('判据只有一份', () => {
  it('数据层不自己写判据，走 hasBrowseCard', () => {
    const src = fs.readFileSync(path.join(SRC, 'components/canvas/useBoardData.js'), 'utf8');
    expect(src, 'useBoardData 要 import hasBrowseCard').toMatch(/hasBrowseCard/);
    expect(src, 'setBrowse 不许再按自己那半句判据过滤').not.toMatch(/setBrowse\(r\?\.url/);
  });

  it('服务端那半也还是「url 或 sites」—— 否则上一条测的是一个已经不存在的约定', () => {
    const card = fs.readFileSync(path.resolve(SRC, '../../server/engine/browse/card.js'), 'utf8');
    expect(card).toMatch(/if \(!url && !sites\.length\) return null;/);
  });
});
