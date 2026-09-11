/**
 * helpers/alpha-holes.js —— 抠图结果里「被主体围住的透明区」（2026-09-11）
 *
 * rembg 按显著性分割，主体上的浅色大块（牛皮纸袋上的白标签、白衣上的高光）会被
 * 判成背景，于是主体中间挖出一个洞。以前的预览是原样 RGBA，模型看透明像素跟看白底
 * 差不多 —— 09-11 那轮 agent 是自己去取 alpha 才发现标签整块没了（10.7 万像素）。
 *
 * 判据：从图像边框出发，沿透明像素做 4 邻域泛洪；够不着边框的透明像素 = 被主体围住的洞。
 * 主体上真该透的洞（戒指、杯柄、手臂和身体之间）也会被数进来，所以**默认只报不补**，
 * 补要 agent 显式说 fillHoles。补回来用的是原图的像素（rembg 的 fast 档把透明处的 RGB
 * 清成了 0，只改 alpha 会补出一块黑）。
 */

const OPAQUE = 128;
/** 小于这个的洞不报也不补：发丝之间、alpha matting 的散点 */
const MIN_HOLE_PX = 64;
const MIN_HOLE_OF_FG = 0.002;

/**
 * @param {Uint8Array} data  raw RGBA（sharp `.ensureAlpha().raw()`）
 * @returns {{ holes: Array<{size:number, start:number}>, holePx: number, foregroundPx: number, label: Int32Array }}
 *   holes 按大小降序，只含够格的（≥ 64px 且 ≥ 前景的 0.2%）；label[i] = 洞编号+1（0 = 不在洞里）
 */
export function findEnclosedHoles(data, width, height) {
  const n = width * height;
  const clear = (i) => data[i * 4 + 3] < OPAQUE;
  const outside = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  const reach = (i) => { if (!outside[i] && clear(i)) { outside[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < width; x += 1) { reach(x); reach((height - 1) * width + x); }
  for (let y = 0; y < height; y += 1) { reach(y * width); reach(y * width + width - 1); }
  while (sp) {
    const i = stack[--sp]; const x = i % width;
    if (x > 0) reach(i - 1);
    if (x < width - 1) reach(i + 1);
    if (i >= width) reach(i - width);
    if (i < n - width) reach(i + width);
  }

  const label = new Int32Array(n);
  const found = [];
  let foregroundPx = 0;
  for (let s = 0; s < n; s += 1) {
    if (!clear(s)) { foregroundPx += 1; continue; }
    if (outside[s] || label[s]) continue;
    const id = found.length + 1;
    let size = 0;
    const take = (i) => { if (!label[i] && !outside[i] && clear(i)) { label[i] = id; stack[sp++] = i; } };
    take(s);
    while (sp) {
      const i = stack[--sp]; const x = i % width; size += 1;
      if (x > 0) take(i - 1);
      if (x < width - 1) take(i + 1);
      if (i >= width) take(i - width);
      if (i < n - width) take(i + width);
    }
    found.push({ id, size, start: s });
  }
  const floor = Math.max(MIN_HOLE_PX, foregroundPx * MIN_HOLE_OF_FG);
  const keep = new Set(found.filter((h) => h.size >= floor).map((h) => h.id));
  for (let i = 0; i < n; i += 1) if (label[i] && !keep.has(label[i])) label[i] = 0;
  const holes = found.filter((h) => keep.has(h.id)).sort((a, b) => b.size - a.size).map(({ size, start }) => ({ size, start }));
  return { holes, holePx: holes.reduce((a, h) => a + h.size, 0), foregroundPx, label };
}

/**
 * 把洞补回不透明（外沿一圈半透明像素一起补，不然洞口留一道虚边）。
 * @param {Uint8Array} data  raw RGBA，不改它，返回新的
 * @param {Uint8Array|null} source  同尺寸原图 raw RGBA；null = 只改 alpha
 */
export function fillEnclosedHoles(data, width, height, label, source = null) {
  const out = Uint8Array.from(data);
  const n = width * height;
  const fill = (i) => {
    out[i * 4 + 3] = 255;
    if (source) { out[i * 4] = source[i * 4]; out[i * 4 + 1] = source[i * 4 + 1]; out[i * 4 + 2] = source[i * 4 + 2]; }
  };
  for (let i = 0; i < n; i += 1) {
    if (!label[i]) continue;
    fill(i);
    const x = i % width;
    for (const k of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width]) {
      if (k >= 0 && k < n && !label[k] && out[k * 4 + 3] < 255) fill(k);
    }
  }
  return out;
}

/** 棋盘格垫底的预览像素（raw RGB）：透明处露出格子，洞一眼看得见 */
export function checkerComposite(data, width, height, cell = 16) {
  const out = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const bg = ((Math.floor(x / cell) + Math.floor(y / cell)) % 2) ? 0x99 : 0xDD;
      const a = data[i * 4 + 3] / 255;
      for (let c = 0; c < 3; c += 1) out[i * 3 + c] = Math.round(data[i * 4 + c] * a + bg * (1 - a));
    }
  }
  return out;
}

/** 原图解成跟抠图结果同尺寸的 raw RGBA；尺寸对不上（EXIF 旋转等）先试自动转正，再不行按尺寸拉 */
async function sourceRaw(sharp, sourceBuf, width, height) {
  for (const rotate of [false, true]) {
    let img = sharp(sourceBuf);
    if (rotate) img = img.rotate();
    const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.width === width && info.height === height) return data;
  }
  return (await sharp(sourceBuf).rotate().resize(width, height, { fit: 'fill' }).ensureAlpha().raw().toBuffer());
}

/**
 * 抠图结果体检：前景占比 + 围住的洞；fill=true 时补洞；顺带出一张棋盘格预览。
 * @returns {Promise<{ png: Buffer, preview: Buffer, foregroundPct: number, holes: Array<{size:number}>, holePx: number, filled: boolean }>}
 */
export async function inspectCutout(rgbaPng, { fill = false, source = null } = {}) {
  const { default: sharp } = await import('sharp');
  const { data, info } = await sharp(rgbaPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const found = findEnclosedHoles(data, width, height);
  let pixels = data; let png = rgbaPng; let filled = false;
  if (fill && found.holes.length) {
    const src = source ? await sourceRaw(sharp, source, width, height) : null;
    pixels = fillEnclosedHoles(data, width, height, found.label, src);
    png = await sharp(Buffer.from(pixels), { raw: { width, height, channels: 4 } }).png().toBuffer();
    filled = true;
  }
  const preview = await sharp(Buffer.from(checkerComposite(pixels, width, height)), { raw: { width, height, channels: 3 } }).png().toBuffer();
  return {
    png, preview, filled,
    foregroundPct: (found.foregroundPx + (filled ? found.holePx : 0)) / (width * height) * 100,
    holes: found.holes, holePx: found.holePx, foregroundPx: found.foregroundPx,
  };
}
