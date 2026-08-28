/**
 * 主精灵 ↔ 角色精灵的能力对账（2026-08-28 用户拍板）。
 *
 * 用户原话：「主代理的图标支持什么，子代理就相应的支持一下，除非发现明确无法做到」。
 * 这是一条**会漂的契约** —— 以后给主精灵加个能力，没人会记得同步给角色，
 * 漂了也不报错，只是角色少一样，要用户再报一次。所以钉在这儿（同仓规矩：契约要配 lint）。
 *
 * 判据读两处 <SpriteSketch> 的入参名：主精灵传了的角色也得传；
 * 不做的必须写进 NOT_APPLICABLE 并给理由 —— 让「没做」是显式决定，不是遗忘。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');

/**
 * 抽出文件里 <SpriteSketch …> 那一段传了哪些 prop。
 *
 * ⚠️ 必须按**嵌套深度**找结尾，不能切到第一个 `/>`：角色那处的 nameTag 里嵌着
 * <RoleNameTag …/>，切第一个 `/>` 会在它那儿就截断，后面的 onMarkClick /
 * onMarkDragMove 根本进不了视野 —— 判据第一版就是这么"发现"角色少了三个 prop 的。
 * （今天第三次栽在量具上：判据读错了范围，比读错了值更难看出来。）
 */
function spriteProps(src) {
  const i = src.indexOf('<SpriteSketch');
  if (i < 0) return new Set();
  let depth = 0;
  let end = -1;
  for (let k = i; k < src.length - 1; k += 1) {
    if (src[k] === '<' && /[A-Za-z]/.test(src[k + 1])) depth += 1;
    else if (src[k] === '/' && src[k + 1] === '>') {
      depth -= 1;
      if (depth === 0) { end = k; break; }
    }
  }
  const seg = src.slice(i, end < 0 ? src.length : end);
  return new Set([...seg.matchAll(/(?:^|\s)([a-zA-Z][a-zA-Z0-9]*)=/g)].map((m) => m[1]));
}

/**
 * 主精灵有、角色**明确不做**的。每条要有理由。
 * 目前一条都没有 —— 唯一没跟的是主精灵的输出框（frameCards/代码直播），
 * 那不是 SpriteSketch 的入参，是 AmbientSpriteLayer 另外摆的一层：
 * 角色没有工具流可直播，不是漏了。
 */
const NOT_APPLICABLE = {};

describe('角色精灵跟主精灵的能力对账', () => {
  it('主精灵传给 SpriteSketch 的每个 prop，角色也要传（不做的写进 NOT_APPLICABLE）', () => {
    const main = spriteProps(read('SpriteSketchLayer.jsx'));
    const role = spriteProps(read('RoleSprites.jsx'));
    expect(main.size, '主精灵那段没解析到，判据本身坏了').toBeGreaterThan(3);
    const missing = [...main].filter((k) => !role.has(k) && !(k in NOT_APPLICABLE));
    expect(missing, `角色精灵少了：${missing.join(', ')}`).toEqual([]);
  });

  it('⭐ 两边在同一层 —— 差一层就"看起来不在一个平面上"（用户实报）', () => {
    expect(/const SPRITE_Z = (\d+)/.exec(read('RoleSprites.jsx'))?.[1]).toBe('305');
    expect(read('SpriteSketchLayer.jsx')).toContain('zIndex: 305');
  });

  it('角色也能点开对话、闲时能拖走（主精灵这两样早就有）', () => {
    const src = read('RoleSprites.jsx');
    for (const k of ['onMarkClick=', 'onMarkDragMove=', 'onMarkDragEnd=']) expect(src).toContain(k);
  });
});
