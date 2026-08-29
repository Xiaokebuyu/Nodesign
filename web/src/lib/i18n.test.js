/**
 * i18n 的**不损坏保证**（2026-08-26）
 *
 * 这个文件钉死的不是翻译对不对，而是「加了 i18n 层之后，中文用户看到的东西
 * 跟以前一个字节都不差」。这是整轮改造的安全底座：
 *
 *   zh-CN 没有词表（CATALOGS['zh-CN'] === null）→ t(x) 恒等于 x
 *
 * 所以把 `'新建项目'` 包成 `t('新建项目')` 对中文用户是**纯粹的空操作**。
 * 唯一能伤到中文用户的是包的时候手抖改错了原文，那属于代码问题，不是设计问题。
 *
 * 反向也钉：英文用户查不到词条时**落回中文**而不是露出裸键或 undefined。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { t, setLocale, getLocale, normalizeLocale, localeFromTags, isLocale, LOCALES, DEFAULT_LOCALE } from './i18n.js';

beforeEach(() => {
  try { localStorage.removeItem('nd:locale'); } catch { /* */ }
  setLocale(DEFAULT_LOCALE);
});

describe('中文用户的不损坏保证', () => {
  it('zh-CN 下 t() 是恒等函数', () => {
    setLocale('zh-CN');
    // 真从源码里抓来的样本，覆盖纯文本 / 带标点 / 长句 / 含英文混排
    const samples = [
      '我的项目', '橱窗', '还没出东西', '加入上下文', '移动到…',
      '这个模型仅限 Pro 档，暂未对外开放',
      '已保存——下一轮生效（正在跑的那轮不追）。',
      'deck（演示 / 长图 / 单页报告）',
    ];
    for (const s of samples) expect(t(s)).toBe(s);
  });

  it('zh-CN 下带参数也只做占位符替换，不动其余字符', () => {
    setLocale('zh-CN');
    expect(t('{n} 件开了头', { n: 3 })).toBe('3 件开了头');
    expect(t('今天的免费轮次用完了（{used} / {limit}）', { used: 5, limit: 5 }))
      .toBe('今天的免费轮次用完了（5 / 5）');
  });

  it('没有占位符的字符串传了参数也原样返回', () => {
    setLocale('zh-CN');
    expect(t('我的项目', { n: 1 })).toBe('我的项目');
  });
});

describe('英文侧的回退', () => {
  it('查不到词条落回中文原文，不露裸键也不出 undefined', () => {
    setLocale('en');
    const missing = '这条肯定没翻译__' + 'zzz';
    expect(t(missing)).toBe(missing);
    expect(t(missing)).not.toContain('undefined');
  });

  it('参数缺了就留着占位符，不把 undefined 印到界面上', () => {
    setLocale('zh-CN');
    expect(t('{n} 件开了头', {})).toBe('{n} 件开了头');
    expect(t('{n} 件开了头', { n: null })).toBe('{n} 件开了头');
  });
});

describe('语言归一', () => {
  it('中文各种 tag 都落 zh-CN', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-Hans', 'zh-TW', 'ZH-hant']) {
      expect(normalizeLocale(tag)).toBe('zh-CN');
    }
  });
  it('英文各种 tag 都落 en', () => {
    for (const tag of ['en', 'en-US', 'en-GB']) expect(normalizeLocale(tag)).toBe('en');
  });
  it('不支持的语言返回 null 交给调用方兜底', () => {
    expect(normalizeLocale('ja')).toBeNull();
    expect(normalizeLocale('')).toBeNull();
    expect(normalizeLocale(null)).toBeNull();
  });
  it('setLocale 拒绝不认识的值，保持原状', () => {
    setLocale('zh-CN');
    setLocale('ja');
    expect(getLocale()).toBe('zh-CN');
  });
  it('LOCALES 里每个 id 都过 isLocale', () => {
    for (const l of LOCALES) expect(isLocale(l.id)).toBe(true);
  });
});

describe('开机语言：报了语言但不是中英的访客（2026-08-29）', () => {
  it('中文浏览器 → zh-CN，英文浏览器 → en（老规矩不变）', () => {
    expect(localeFromTags(['zh-CN', 'en-US'])).toBe('zh-CN');
    expect(localeFromTags(['en-GB'])).toBe('en');
    expect(localeFromTags(['zh-TW'])).toBe('zh-CN');   // 繁体先给中文
  });

  it('⭐ 日/韩/德语浏览器 → en，不是 zh-CN', () => {
    // 递给一个日本访客一页中文，比递英文差得多 —— 他两种都不是母语，
    // 但英文是他能读的那个。
    for (const tag of ['ja-JP', 'ko-KR', 'de-DE', 'fr', 'ru-RU', 'es-ES']) {
      expect(localeFromTags([tag]), tag).toBe('en');
    }
  });

  it('列表里排在后面的中英仍然赢过"都不认识"', () => {
    expect(localeFromTags(['ja-JP', 'zh-CN'])).toBe('zh-CN');
    expect(localeFromTags(['ko-KR', 'en'])).toBe('en');
  });

  it('压根没有语言信息 → 回中文（中文优先只对这种情况成立）', () => {
    expect(localeFromTags([])).toBe(DEFAULT_LOCALE);
    expect(localeFromTags(null)).toBe(DEFAULT_LOCALE);
  });
});
