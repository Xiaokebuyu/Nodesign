/**
 * 测试环境把界面语言钉在 zh-CN（2026-08-29）。
 *
 * jsdom 报的 navigator.language 是 en-US，于是 i18n 的 detect() 在测试里落到 en。
 * 只要某句话被包进 t() 且词表里有译文，断言中文文案的老测试就会当场变红 ——
 * 而它们要验的是**行为**（点了「主持人」载荷跟着改），不是语言。
 *
 * 所以统一钉中文：源语言下 t() 是恒等函数，测试看到的就是源码里那句话。
 * 要验英文的测试自己在用例里 setLocale('en')（i18n.test.js 就是这么干的）。
 */
import { setLocale } from './lib/i18n.js';

setLocale('zh-CN', { explicit: false });
