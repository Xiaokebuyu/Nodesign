/**
 * server/lib/sketch-array.js —— 阵列 / 环列 / 镜像 / 散布（2026-08-30 画图能力线刀④）
 *
 * 复杂图案大多是简单元素的规律重复，而**等距和对称恰是模型最不擅长的算术**
 * （画一圈椅子 = 12 次三角函数）。这四个算子把规律归机器、元素归 agent：
 *
 *   repeat  {n, dx, dy}     沿直线摆 n 份（栅栏、窗、台阶）
 *   ring    {n, cx, cy}     绕圆心转 n 份（圆桌椅子、钟面、花瓣）
 *   mirror  {axis, at}      对称补一份（画半只蝴蝶得整只）
 *   scatter {n, in:{…}}     区域内播撒 n 份、带大小抖动（星空、草地、碎石）
 *
 * 每一份都用**自己的种子**重生成笔迹 —— 抖动各不相同，看起来是手画了 n 遍，
 * 不是图章盖了 n 下。scatter 的随机也是种子确定的：同一次调用重放结果一致。
 */

import { UNIT, transformD } from './sketch-layout.js';

/** 与 sketch-layout 同款确定性随机（那边的没导出，够小就地一份） */
function rng(seedStr) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seedStr.length; i += 1) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把 {rect,d}（d 局部于 rect）过一个**绝对坐标**变换，返回重建包围盒后的 {rect,d} */
function applyAbs(base, fn) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  const dAbs = transformD(base.d, (p) => {
    const q = fn({ x: base.rect.x + p.x, y: base.rect.y + p.y });
    if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
    if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
    return q;
  });
  if (!Number.isFinite(minX)) return base;
  const P = 6;   // 与全族同款 pad（抖动和线宽的呼吸位；不补的话镜像副本比本尊瘦一圈）
  const d = transformD(dAbs, (p) => ({ x: p.x - minX + P, y: p.y - minY + P }));
  return { rect: { x: Math.round(minX - P), y: Math.round(minY - P), w: Math.max(4, Math.round(maxX - minX + P * 2)), h: Math.max(4, Math.round(maxY - minY + P * 2)) }, d };
}

/**
 * 展开一个形状的算子。
 * @param s        入参形状（可能带 repeat/ring/mirror/scatter；坐标全是格）
 * @param makeOne  (seedSuffix) => {rect, d}  重新生成一份本尊（各份各自的抖）
 * @param key      形状名（副本叫 key-2, key-3…）
 * @returns {Array<{key,rect,d}>} 或 { error }
 */
export function expandModifiers(s, makeOne, key) {
  const mods = ['repeat', 'ring', 'mirror', 'scatter'].filter((k) => s[k]);
  if (!mods.length) return [{ key, ...makeOne('') }];
  if (mods.length > 1) return { error: `形状 ${key}：repeat/ring/mirror/scatter 一次只能挂一个` };
  const out = [];
  const push = (i, piece) => out.push({ key: i === 0 ? key : `${key}-${i + 1}`, ...piece });

  if (s.repeat) {
    const { n, dx = 0, dy = 0 } = s.repeat;
    if (!dx && !dy) return { error: `形状 ${key}：repeat 要给步长 dx/dy（格）——步长 0 是 n 份叠在原地` };
    for (let i = 0; i < n; i += 1) {
      const b = makeOne(`:${i}`);
      push(i, { rect: { ...b.rect, x: Math.round(b.rect.x + dx * UNIT * i), y: Math.round(b.rect.y + dy * UNIT * i) }, d: b.d });
    }
    return out;
  }
  if (s.ring) {
    const { n, cx, cy, upright = false } = s.ring;
    const C = { x: cx * UNIT, y: cy * UNIT };
    for (let i = 0; i < n; i += 1) {
      const th = (Math.PI * 2 * i) / n;
      const cos = Math.cos(th); const sin = Math.sin(th);
      const b = makeOne(`:${i}`);
      if (i === 0) { push(i, b); continue; }
      if (upright) {
        // 不转身，只沿圆周换座（侧视图里有重力的东西：帐篷、篝火边的人）
        const bc = { x: b.rect.x + b.rect.w / 2, y: b.rect.y + b.rect.h / 2 };
        const nc = {
          x: C.x + (bc.x - C.x) * cos - (bc.y - C.y) * sin,
          y: C.y + (bc.x - C.x) * sin + (bc.y - C.y) * cos,
        };
        push(i, { rect: { ...b.rect, x: Math.round(nc.x - b.rect.w / 2), y: Math.round(nc.y - b.rect.h / 2) }, d: b.d });
        continue;
      }
      push(i, applyAbs(b, (p) => ({
        x: C.x + (p.x - C.x) * cos - (p.y - C.y) * sin,
        y: C.y + (p.x - C.x) * sin + (p.y - C.y) * cos,
      })));
    }
    return out;
  }
  if (s.mirror) {
    const { axis, at } = s.mirror;
    const ax = at * UNIT;
    push(0, makeOne(''));
    push(1, applyAbs(makeOne(':m'), (p) => (axis === 'x' ? { x: 2 * ax - p.x, y: p.y } : { x: p.x, y: 2 * ax - p.y })));
    return out;
  }
  if (s.scatter) {
    const { n } = s.scatter;
    const zone = s.scatter.in;
    const R = { x: zone.x * UNIT, y: zone.y * UNIT, w: zone.w * UNIT, h: zone.h * UNIT };
    const rand = rng(`scatter:${key}:${n}`);
    for (let i = 0; i < n; i += 1) {
      const b = makeOne(`:${i}`);
      const k = 0.7 + rand() * 0.45;                       // 大小抖动 0.7~1.15
      const scaled = applyAbs(b, (p) => ({ x: b.rect.x + (p.x - b.rect.x) * k, y: b.rect.y + (p.y - b.rect.y) * k }));
      const x = R.x + rand() * Math.max(1, R.w - scaled.rect.w);
      const y = R.y + rand() * Math.max(1, R.h - scaled.rect.h);
      push(i, { rect: { ...scaled.rect, x: Math.round(x), y: Math.round(y) }, d: scaled.d });
    }
    return out;
  }
  return [{ key, ...makeOne('') }];
}
