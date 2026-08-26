/**
 * 服务端消息词表的对账 lint（2026-08-26）。
 *
 * key 是中文原文，打错一个字就**静默落回中文** —— 不报错、不崩、英文用户永远看不到
 * 那句翻译，而代码看起来是对的。注释拦不住这个，所以配这条 lint：
 *
 *   ① 源码里每个 msg(req, '…') 的 key 都必须在词表里
 *   ② 词表里每个词条都必须真的被某处用到（删了调用点忘了删词条 = 假覆盖）
 *   ③ 中英两侧的 {占位符} 集合必须一致（漏一个就把 {used} 原样印给用户）
 *
 * ⚠️ 这条 lint 认的是「key 是**字面量**，且是 msg() 的第二个参数」这一种写法。
 * `msg(req, cond ? 'A' : 'B')` 它看不见 —— 08-26 建这条 lint 时当场撞过一次。
 * 所以调用点要写成 `cond ? msg(req, 'A') : msg(req, 'B')`。把正则做成能解析任意
 * 表达式不划算，让调用点统一形状更便宜，而且读起来也更直白。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import en from './messages-en.js';
import { withLocale, localeOf, msg } from './messages.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'projects-data' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (e.name.endsWith('.js') && !e.name.includes('.test.')) out.push(p);
  }
  return out;
}

/** 抓 msg(req, '…') / withLocale(x, '…') 的第一个字符串参数 */
const CALL = /\b(?:msg|withLocale)\(\s*[^,]+,\s*(['"])((?:\\.|(?!\1).)*)\1/g;

const usedKeys = (() => {
  const keys = new Set();
  for (const f of sourceFiles(SERVER_ROOT)) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(CALL)) keys.add(m[2]);
  }
  return keys;
})();

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('服务端消息词表对账', () => {
  it('至少抓到了一批调用点（正则失效时这条先红，别让下面几条空转过关）', () => {
    expect(usedKeys.size).toBeGreaterThan(20);
  });

  it('源码里用到的每个 key 都在英文词表里', () => {
    const missing = [...usedKeys].filter((k) => en[k] === undefined);
    expect(missing, `这些 key 没翻译，英文用户会看到中文：\n${missing.join('\n')}`).toEqual([]);
  });

  it('词表里没有用不到的死词条', () => {
    const dead = Object.keys(en).filter((k) => !usedKeys.has(k));
    expect(dead, `这些词条源码里没人用（调用点删了？key 改了？）：\n${dead.join('\n')}`).toEqual([]);
  });

  it('中英两侧占位符集合一致', () => {
    const bad = Object.entries(en)
      .filter(([k, v]) => JSON.stringify(placeholders(k)) !== JSON.stringify(placeholders(v)))
      .map(([k, v]) => `${k}\n    zh: ${placeholders(k)}\n    en: ${placeholders(v)}`);
    expect(bad, `占位符对不上，会把 {xxx} 原样印给用户：\n${bad.join('\n')}`).toEqual([]);
  });

  it('英文词条里不许残留中文（漏翻了半句）', () => {
    const leftover = Object.entries(en).filter(([, v]) => /[一-鿿]/.test(v)).map(([k]) => k);
    expect(leftover, `这些词条的英文里还有中文：\n${leftover.join('\n')}`).toEqual([]);
  });
});

describe('中文用户的不损坏保证', () => {
  it('zh-CN 下 withLocale 恒等返回原文', () => {
    for (const k of Object.keys(en)) expect(withLocale('zh-CN', k)).toBe(k);
  });
  it('认不出的 locale 落中文，不落英文', () => {
    for (const bad of ['ja', '', null, undefined, 'EN']) {
      expect(withLocale(bad, '用户名或密码错误')).toBe('用户名或密码错误');
    }
  });
});

/**
 * localeOf 的判定逻辑（2026-08-26）。
 *
 * 这是服务端唯一决定"这个请求说哪种语言"的地方，req 的形状照 express 真实的来：
 * `req.user` 由 auth/middleware 的 authGuard 挂，`req.headers` 全小写键。
 *
 * ⭐ 最要紧的一条是**登录失败时没有 req.user** —— 那正是最需要说对语言的时刻，
 * 只能靠 Accept-Language。这条要是错了，英文用户在第一道门就撞中文。
 */
describe('localeOf 判定', () => {
  const req = (user, acceptLanguage) => ({
    user,
    headers: acceptLanguage ? { 'accept-language': acceptLanguage } : {},
  });

  it('账号上记了语言就用它，压过 Accept-Language', () => {
    expect(localeOf(req({ locale: 'en' }, 'zh-CN,zh;q=0.9'))).toBe('en');
    expect(localeOf(req({ locale: 'zh-CN' }, 'en-US,en;q=0.9'))).toBe('zh-CN');
  });

  it('没登录（登录失败那一刻）落 Accept-Language', () => {
    expect(localeOf(req(undefined, 'en-US,en;q=0.9,zh;q=0.8'))).toBe('en');
    expect(localeOf(req(null, 'zh-CN,zh;q=0.9,en;q=0.8'))).toBe('zh-CN');
  });

  it('账号上没表过态（locale=null）也落 Accept-Language', () => {
    expect(localeOf(req({ id: 1, locale: null }, 'en-GB'))).toBe('en');
  });

  it('Accept-Language 认不出、缺失、畸形，一律落中文', () => {
    for (const h of [undefined, '', 'ja,ko;q=0.9', '???', ';;;', 'q=0.9']) {
      expect(localeOf(req(undefined, h)), `header=${JSON.stringify(h)}`).toBe('zh-CN');
    }
  });

  it('req 整个缺失也不炸（后台任务误传）', () => {
    for (const r of [undefined, null, {}, { headers: null }]) {
      expect(localeOf(r)).toBe('zh-CN');
    }
  });

  it('端到端：同一句话，两个语言的请求拿到两种结果', () => {
    const zhReq = req(undefined, 'zh-CN,zh;q=0.9');
    const enReq = req(undefined, 'en-US,en;q=0.9');
    expect(msg(zhReq, '用户名或密码错误')).toBe('用户名或密码错误');
    expect(msg(enReq, '用户名或密码错误')).toBe('Incorrect username or password');
    // 带参数的那条
    expect(msg(enReq, '尝试次数过多，{waitMin} 分钟后再试', { waitMin: 3 }))
      .toBe('Too many attempts. Try again in 3 minutes.');
    expect(msg(zhReq, '尝试次数过多，{waitMin} 分钟后再试', { waitMin: 3 }))
      .toBe('尝试次数过多，3 分钟后再试');
  });
});
