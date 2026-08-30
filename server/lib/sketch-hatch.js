/**
 * server/lib/sketch-hatch.js —— 排线填充（2026-08-30 画图能力线）
 *
 * 线稿世界里唯一体面的"上色"：45° 手排线。闭合轮廓 → 一组扫描线段（偶奇规则），
 * 端点带一点抖 —— 像人一笔一笔排出来的，不是激光刻的。
 *
 * 只对**闭合轮廓**生效（Z 收尾的子路径）：往开放折线里灌填充没有定义良好的
 * 内部，硬灌就是把问题藏起来 —— 调用方大声拒。
 */

const f1 = (n) => Math.round(n * 10) / 10;

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

/** 大写绝对 M/L/Q/C/Z → 多边形组（曲线采样 8 段；只收 Z 闭合的子路径） */
export function flattenClosed(d) {
  const tokens = String(d).match(/[MLQCZ]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || [];
  const polys = [];
  let pts = []; let i = 0; let closedAny = false;
  const num = () => Number(tokens[i++]);
  const flush = (closed) => { if (closed && pts.length >= 3) { polys.push(pts); closedAny = true; } pts = []; };
  while (i < tokens.length) {
    const t = tokens[i++];
    if (t === 'M') { flush(false); pts = [{ x: num(), y: num() }]; continue; }
    if (t === 'L') { pts.push({ x: num(), y: num() }); continue; }
    if (t === 'Q' || t === 'C') {
      const cps = t === 'Q' ? [{ x: num(), y: num() }] : [{ x: num(), y: num() }, { x: num(), y: num() }];
      const end = { x: num(), y: num() };
      const a = pts[pts.length - 1] || end;
      for (let k = 1; k <= 8; k += 1) {
        const u = k / 8;
        let p;
        if (t === 'Q') {
          const v = 1 - u;
          p = { x: v * v * a.x + 2 * v * u * cps[0].x + u * u * end.x, y: v * v * a.y + 2 * v * u * cps[0].y + u * u * end.y };
        } else {
          const v = 1 - u;
          p = {
            x: v ** 3 * a.x + 3 * v * v * u * cps[0].x + 3 * v * u * u * cps[1].x + u ** 3 * end.x,
            y: v ** 3 * a.y + 3 * v * v * u * cps[0].y + 3 * v * u * u * cps[1].y + u ** 3 * end.y,
          };
        }
        pts.push(p);
      }
      continue;
    }
    if (t === 'Z') { flush(true); continue; }
  }
  flush(false);
  return { polys, closedAny };
}

/**
 * 多边形组 → 45° 排线 d。偶奇规则（洞是真洞：月牙的内弧不会被排穿）。
 * @returns {string} 空串 = 没有可填的面积
 */
export function hatchD(polys, seed = 'hatch', { spacing = 11, angle = Math.PI / 4 } = {}) {
  if (!polys?.length) return '';
  const cos = Math.cos(-angle); const sin = Math.sin(-angle);
  const rot = polys.map((p) => p.map(({ x, y }) => ({ x: x * cos - y * sin, y: x * sin + y * cos })));
  let minY = Infinity; let maxY = -Infinity;
  for (const p of rot) for (const q of p) { if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y; }
  if (!Number.isFinite(minY)) return '';
  const rand = rng(seed);
  const back = (x, y) => ({ x: x * Math.cos(angle) - y * Math.sin(angle), y: x * Math.sin(angle) + y * Math.cos(angle) });
  const segs = [];
  for (let y = minY + spacing * 0.6; y < maxY; y += spacing) {
    const xs = [];
    for (const p of rot) {
      for (let k = 0; k < p.length; k += 1) {
        const a = p[k]; const b = p[(k + 1) % p.length];
        if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
          xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
        }
      }
    }
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      if (xs[k + 1] - xs[k] < 3) continue;                     // 太窄的缝不排
      const inset = 1.5;                                       // 别顶到轮廓线
      const j = () => (rand() * 2 - 1) * 0.9;
      const a = back(xs[k] + inset + j(), y + j());
      const b = back(xs[k + 1] - inset + j(), y + j());
      segs.push(`M ${f1(a.x)} ${f1(a.y)} L ${f1(b.x)} ${f1(b.y)}`);
    }
  }
  return segs.join(' ');
}
