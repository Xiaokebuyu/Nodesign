/**
 * 语言表的跨前后端 parity 钉子（2026-08-26）。
 *
 * 语言表有两份：
 *   server/shared/locales.js  —— 服务端真相源（校验写入 / 挑报错语言 / 给 agent 注指令）
 *   web/src/lib/i18n.js       —— 前端这份多带「中文 / English」显示名
 *
 * 显示名塞进服务端没意义，所以没合成一份。双份表的宿命是漂移，这里逐项对账
 * （跟 board-kind-sizes.parity.test.js 同款纪律）。加语言忘了改另一边就红。
 *
 * 归一函数也一起钉：前后端对「zh-TW 算不算中文」要是各执一词，
 * 用户会遇到界面和 agent 说两种语言。
 */
import { describe, it, expect } from 'vitest';
import {
  LOCALES as SRV_LOCALES, DEFAULT_LOCALE as SRV_DEFAULT,
  normalizeLocale as srvNormalize, isLocale as srvIsLocale,
} from '../../../server/shared/locales.js';
import { LOCALES, DEFAULT_LOCALE, normalizeLocale, isLocale } from './i18n.js';

describe('语言表 parity', () => {
  it('语言 id 列表逐项一致且顺序相同', () => {
    expect(LOCALES.map((l) => l.id)).toEqual([...SRV_LOCALES]);
  });

  it('默认语言一致', () => {
    expect(DEFAULT_LOCALE).toBe(SRV_DEFAULT);
  });

  it('前端每个 id 都带非空显示名（切换器要拿它渲染）', () => {
    for (const l of LOCALES) {
      expect(l.label, `LOCALES.${l.id}.label`).toBeTruthy();
      expect(l.english, `LOCALES.${l.id}.english`).toBeTruthy();
    }
  });
});

describe('归一函数 parity', () => {
  const TAGS = [
    'zh', 'zh-CN', 'zh-Hans', 'zh-TW', 'ZH-hant', 'zh-SG',
    'en', 'en-US', 'en-GB', 'EN',
    'ja', 'ko', 'fr', 'de', '', null, undefined, 'xx-YY',
  ];
  it('每个 tag 前后端归一到同一个结果', () => {
    for (const tag of TAGS) {
      expect(normalizeLocale(tag), `normalizeLocale(${JSON.stringify(tag)})`)
        .toBe(srvNormalize(tag));
    }
  });
  it('isLocale 前后端一致', () => {
    for (const id of ['zh-CN', 'en', 'ja', '', null, 'zh']) {
      expect(isLocale(id), `isLocale(${JSON.stringify(id)})`).toBe(srvIsLocale(id));
    }
  });
});
