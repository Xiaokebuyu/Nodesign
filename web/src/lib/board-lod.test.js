import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lodOf, renderedW, LABEL_ONLY_W, BLANK_W } from './board-lod.js';
import { SIZES, KINDS, farFaceOf } from './board-kinds.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 分级渲染的判据本身，以及**闸只有一处**这个形状。
 *
 * 后半条比前半条值钱：一种门面漏了闸，症状是"拉远之后只有这一种卡还在渲染内容"，
 * 而开发者自己的屏幕上永远看不见（他不会为了看清楚而把画布缩到 0.2 倍）。
 * 这正是本仓「加形态最漏的写死表家族」那一族的形状，只能钉成判据。
 */
describe('该画内容还是画名字', () => {
  it('判的是渲染宽度，不是缩放百分比', () => {
    // 同一个缩放下，大卡还读得动、小卡已经糊了 —— 这正是不能拿 scale 当判据的理由
    expect(lodOf(640, 0.3)).toBe('full');    // 192px
    expect(lodOf(200, 0.3)).toBe('label');   // 60px
  });

  it('三档的边界', () => {
    expect(lodOf(LABEL_ONLY_W, 1)).toBe('full');
    expect(lodOf(LABEL_ONLY_W - 1, 1)).toBe('label');
    expect(lodOf(BLANK_W, 1)).toBe('label');
    expect(lodOf(BLANK_W - 1, 1)).toBe('blank');
  });

  /**
   * ⭐ 这一条拿的是**形态表里的真尺寸**，不是我随手编的宽度。
   *
   * 它同时钉住两头：阈值被人调高、或者哪个形态的卡被改窄，只要真实卡片在
   * 70%~130%（真正适合阅读的那一带）里掉进 label 档，这里就红。
   * 编一个 120 去断言是没有意义的，那个数正好等于阈值本身。
   */
  it('真实卡片在 70%~130% 上一律照旧 —— 这一刀不许碰正常阅读区间', () => {
    for (const [kind, size] of Object.entries(SIZES)) {
      if (KINDS[kind].farFace === false) continue;   // 豁免的那几种见下一条
      for (const z of [0.7, 1, 1.3]) {
        expect(lodOf(size.w, z), `${kind}（${size.w} 宽）在 ${z} 倍上被降级了`).toBe('full');
      }
    }
  });

  it('会换脸的形态里最窄的那种，离阈值还有多少余量（掉到 0 就是下一次误伤）', () => {
    const ws = Object.entries(SIZES).filter(([k]) => KINDS[k].farFace !== false).map(([, s]) => s.w);
    const narrowest = Math.min(...ws);
    expect(narrowest * 0.7, `最窄的卡 ${narrowest} 宽，0.7 倍下只剩 ${narrowest * 0.7}px`)
      .toBeGreaterThan(LABEL_ONLY_W);
  });

  /**
   * ⭐ 这条判据是被上面那条逼出来的：涂鸦只有 160 宽，0.7 倍就掉到 112px。
   * 但换脸的前提是「内容缩小之后变成噪点、而名字比它有信息量」，一笔画两条都不成立
   * （缩小了还是那笔画，名字就是「一笔涂鸦」）。所以它写在形态表里豁免，
   * ⛔ 不是把阈值调低 —— 调低会让所有文字类的卡在读不了的尺寸上继续画字。
   */
  it('涂鸦豁免，而且豁免名单要短', () => {
    expect(farFaceOf({ type: 'scribble' })).toBe(false);
    expect(farFaceOf({ type: 'note' })).toBe(true);
    expect(farFaceOf({ type: 'deck' })).toBe(true);
    const exempt = Object.entries(KINDS).filter(([, v]) => v.farFace === false).map(([k]) => k);
    expect(exempt, '豁免名单变长了 —— 每多一个，拉远看全局就多一张糊掉的卡').toEqual(['scribble']);
  });

  it('脏输入不炸也不误判成远处', () => {
    expect(renderedW(undefined, 1)).toBe(0);
    expect(renderedW(200, undefined)).toBe(0);
    expect(lodOf(NaN, NaN)).toBe('blank');
  });
});

describe('⛔ 闸只有一处：九个门面分支都得熄灭', () => {
  const SRC = fs.readFileSync(path.join(HERE, '../components/canvas/cards/BoardObject.jsx'), 'utf8');

  it('没有任何门面分支绕开 faceType / faceCard', () => {
    // 门面分支的形状是 `{o.type === 'x' && (`；绕开闸的那一种会在拉远时单独还在渲染
    expect(SRC.match(/\{o\.type\s*===/g), '有门面分支写回了裸 o.type，它拉远时不会熄灭')
      .toBe(null);
    expect(SRC.match(/\{cardOf\(o\)\s*===/g), '产物卡那条写回了裸 cardOf(o)')
      .toBe(null);
  });

  it('闸本身还在，而且是从 lodOf 来的', () => {
    expect(SRC).toMatch(/const far = farFaceOf\(o\) && lodOf\(sz\.w, scale\) !== 'full'/);
    expect(SRC).toMatch(/const faceType = far \? null : o\.type/);
    expect(SRC).toMatch(/const faceCard = far \? null : cardOf\(o\)/);
  });

  it('九个门面一个不少地接在闸上（少了说明有人删门面时漏了这里）', () => {
    const n = (SRC.match(/\{faceType\s*===/g) || []).length + (SRC.match(/\{faceCard\s*===/g) || []).length;
    expect(n, `接在闸上的门面只剩 ${n} 个`).toBe(9);
  });
});
