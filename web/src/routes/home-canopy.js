/**
 * 树影与灯 —— 首页那层真的光源（2026-08-30，接替 home-sun.js 的 CSS 版）。
 *
 * ## ⭐ 为什么从 CSS 渐变换成一个着色器
 *
 * 上一版是十几个 radial-gradient 叠成一张图，整层缓慢平移。用户的评价是
 * 「看起来只是一个贴图」—— 说得对，而且那不是调参能解决的：**一张图整体平移，
 * 图案之间的关系永远不变**，所以看久了必然读成一张滑动的贴纸。
 *
 * 真的叶隙光不是这样动的。树冠是好几层叶子前后错开，风一吹各层各走各的，
 * 缝隙于是会**张开、合上、并到一起、灭掉**。变的是图案本身，不是图案的位置。
 * 这件事用固定形状的渐变做不出来，得有个能每帧重算的噪声场 —— 也就是这个文件。
 *
 * 顺带解决了性能：CSS 那版逼着主线程每帧把七到十个大渐变重栅格一遍（实测
 * 5933ms，只能靠 steps() 让它每两秒才动一格，代价是看得出跳格）。着色器整份
 * 工作在 GPU，主线程每帧只有「设一个 uniform + 画一个三角形」。
 *
 * ## 分成两块画布
 *
 *   底层（under）= 影 + 光，压在板面之上、内容之下 —— 板子上的斑驳
 *   顶层（over）  = 只有光 + 夜里的暗，压在所有内容之上 —— 落在纸上的那半片
 *
 * 影子不上顶层：影压在正文上是把纸弄脏，不是打光。夜里的暗反过来只在顶层，
 * 因为那不是影子，是整个屋子的光少了，得盖住所有东西。
 *
 * ## 白天黑夜
 *
 * 见 lib/daylight.js 的文件头：这套语言里「夜晚模式」= 把光收走，不是换色板。
 * 所以夜也住在这一层：太阳沉下去，树影褪成极淡的月光，顶层压一层夜色，
 * 只在台灯那一汪留亮。切换是把 night 从 0 推到 1，中间每一帧都是成立的画面。
 *
 * ## 便宜在哪
 *
 *   内部分辨率 0.42 倍且封顶 780px —— 柔光看不出，双线性放大反而白送一层柔化
 *   帧率封顶 30 —— 风的周期以秒计，60 帧是白给
 *   页面不可见 / 组件卸载就停
 *   拿不到 WebGL 就整层不挂，退回 home-sun.js 那版 CSS 渐变
 */
import { PAPER } from '../lib/paper.js';
import { NIGHT_INK, LAMP, LAMP_AT, SUN_FROM } from '../lib/daylight.js';

/** '#RRGGBB' → [0..1, 0..1, 0..1] */
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  // y 翻过来：着色器里 vUv.y = 0 就是屏幕顶上，跟"光从右上来"这句话对得上
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUv;

uniform vec2  uRes;      // 画布像素，只用来取长宽比
uniform float uFlow;     // 风走过的路。⚠️ 不是时间：阵风的时候它走得快
uniform float uAlt;      // 太阳高度 −1…1
uniform float uWarm;     // 光的暖度 0…1
uniform float uNight;    // 夜的程度 0…1
uniform float uGust;     // 这一阵风的强度 0…1
uniform float uOver;     // 0 = 底层，1 = 压在内容上那层
uniform vec3  uLit;      // 当季的光（season.js）
uniform vec3  uGold;     // 当季的斜阳
uniform vec3  uDusk;     // 当季的暗斑
uniform vec3  uNightC;   // 夜色
uniform vec3  uLampC;    // 台灯
uniform vec2  uFrom;     // 光从哪儿来（uv，y 向下）
uniform vec3  uTint;     // 时段的整片色偏
uniform float uTintA;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  // smootherstep 不是 smoothstep：叶隙的边要是有折线，一放大就露馅
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(hash(i),                hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + vec2(19.3, 7.7);
    a *= 0.5;
  }
  return v;
}

/** src 盖在 dst 上（直通 alpha，不是预乘） */
vec4 lay(vec4 dst, vec3 c, float a) {
  float na = a + dst.a * (1.0 - a);
  return vec4((c * a + dst.rgb * dst.a * (1.0 - a)) / max(na, 1e-5), na);
}

void main() {
  float ar   = uRes.x / max(uRes.y, 1.0);
  float day  = 1.0 - uNight;
  float alt  = clamp(uAlt, 0.0, 1.0);

  // 太阳低的时候光是掠射的，叶隙的像被拉长；正午又圆又小。
  vec2 p = vec2(vUv.x * ar, vUv.y);
  p.x *= mix(0.45, 1.0, alt);

  // ⭐ **透光率场**，不是"两层光斑图"。大尺度决定树冠哪儿厚哪儿薄，小尺度是叶隙；
  // 两个尺度差得远，亮斑才会成簇地出现在冠疏的地方 —— 均匀撒一片会读成迷彩。
  // 而且两层各走各的：交错走过的时候缝会开合、并拢、灭掉，这就是"不像贴图"的那一半。
  float big  = fbm(p * 3.4 + vec2(uFlow,       uFlow * 0.55));
  float fine = fbm(p * 9.5 - vec2(uFlow * 1.6, uFlow * 0.85) + 23.0);
  float trans = big * 0.52 + fine * 0.48;

  // 亮斑只给最透的那一小撮（真站在树下，日斑大概只占地面的一两成）。
  // 太阳越高斑越小越硬；阵风把阈值推低 = 缝被吹开，这一下才是"风过去了"。
  float edge = mix(0.13, 0.05, alt);
  float thr  = mix(0.625, 0.600, alt) - uGust * 0.030;
  float light = smoothstep(thr, thr + edge, trans);
  // ⭐ 影只看**大尺度**那一层，光看合成的。分开是有道理的：真树影是一大团软的暗
  // 里面点着几粒硬的亮。两者都用同一个场的话，暗块和亮块一样大、边一样硬，
  // 并排看就是迷彩（第一版正是这样）。
  float shade = smoothstep(0.58, 0.26, big);

  // 靠光源那一侧亮，远处淡下去
  vec2 d = (vUv - uFrom) * vec2(ar, 1.0);
  float near = exp(-dot(d, d) * 0.55);
  light *= mix(0.52, 1.18, near);

  vec3 sunC = mix(uLit, uGold, uWarm * 0.75);

  vec4 acc = vec4(0.0);
  // 影只画在底层
  acc = lay(acc, uDusk, shade * day * (1.0 - uOver) * 0.15);
  // 光两层都有，压在字上那层弱一半
  acc = lay(acc, sunC,  light * day * mix(0.62, 0.22, uOver));
  // 夜里从叶隙漏下来的是月光：冷、极淡
  acc = lay(acc, vec3(0.76, 0.83, 1.0), light * uNight * 0.07);
  // 时段色偏（只在顶层，很淡，只是让"几点了"读得出来）
  acc = lay(acc, uTint, uTintA * uOver * day);

  // 夜：屋子暗下来，台灯下留一汪。
  //
  // ⭐⭐ **分两层压，而且底层压得狠得多。** 第一版整片暗只挂在顶层（它盖住所有
  // 东西），于是桌面和纸被同一个数压，纸上的字跟着一起沉：实测最暗那张卡的标题
  // 对比度从白天的 10.2:1 掉到 **2.1:1** —— 用户报的「暗处太暗影响可用性」就是它。
  //
  // 分层之后各归各位：
  //   底层（在纸**下面**）—— 桌面、板子该黑就黑，夜的气氛全在这儿
  //   顶层（在纸**上面**）—— 只压一薄层统一色调，它盖着你正在读的那张纸
  //
  // 这也正是台灯底下的真实样子：周围一片黑，手边那张纸是亮的。
  // ⚠️ 判据不是「看着够不够黑」，是 lens.mjs 的 contrast 模式跟白天并排比。
  //    （这行原来带反引号 —— 而这段 CSS/GLSL 住在 JS 模板字符串里，一个反引号
  //     就把整个文件炸了。同一个坑这个月第四次，写注释先看看有没有反引号。）
  float pd   = length((vUv - uFrom) * vec2(ar, 1.0));
  // 光晕放宽（1.9 → 1.1）：太陡的话左边那一列卡直接掉进最暗档，一屏之内纸的
  // 亮度差三倍（7.9% vs 24%），读起来是"这半边坏了"不是"那半边有灯"。
  float pool = exp(-pd * pd * 1.1);
  acc = lay(acc, uLampC, uNight * pool * mix(0.16, 0.30, uOver));
  acc = lay(acc, uNightC, uNight * (uOver > 0.5
    ? mix(0.30, 0.03, pool)      // 压在纸上：薄
    : mix(0.72, 0.10, pool)));   // 压在桌面上：狠

  // ⚠️ 预乘输出。合成器那条路只有预乘是各家都靠谱的：非预乘（premultipliedAlpha:
  // false）在实测里画得出正确的缓冲区（readPixels 值全对），合成到页面上却几乎看不见。
  // 里头按直通 alpha 叠完（lay()），最后一步乘回去。
  gl_FragColor = vec4(acc.rgb * acc.a, acc.a);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    // 拿不到就退回 CSS 版，不吵用户；但开发时要看得见原因
    console.warn('[canopy] 着色器没编过，退回 CSS 版：', gl.getShaderInfoLog(s));   // eslint-disable-line no-console
    return null;
  }
  return s;
}

const U = ['uRes', 'uFlow', 'uAlt', 'uWarm', 'uNight', 'uGust', 'uOver',
  'uLit', 'uGold', 'uDusk', 'uNightC', 'uLampC', 'uFrom', 'uTint', 'uTintA'];

/** 一块画布 = 一个 GL 上下文。拿不到就返回 null，调用方负责退回 CSS 版。 */
function makeLayer(canvas, over) {
  const gl = canvas.getContext('webgl', {
    alpha: true,
    antialias: false, depth: false, stencil: false,
    powerPreference: 'low-power',
    failIfMajorPerformanceCaveat: false,
  });
  if (!gl) return null;

  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);

  // 一个盖住整屏的三角形（比两个三角形的四边形少一条对角线上的重复计算）
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const u = {};
  for (const n of U) u[n] = gl.getUniformLocation(prog, n);

  // 一辈子不变的那几个：季节的色板 + 这一层是底层还是顶层
  gl.uniform1f(u.uOver, over ? 1 : 0);
  gl.uniform3fv(u.uLit, rgb(PAPER.lit));
  gl.uniform3fv(u.uGold, rgb(PAPER.litWarm));
  gl.uniform3fv(u.uDusk, rgb(PAPER.dusk));
  gl.uniform3fv(u.uNightC, rgb(NIGHT_INK));
  gl.uniform3fv(u.uLampC, rgb(LAMP));

  return {
    gl, u, canvas,
    resize(w, h) {
      // ⛔ **别在这儿早退。** 第一版写的是「尺寸没变就 return」，结果 uRes 一直是 0，
      // ar = 0 → 噪声只随 y 变 → 满屏横条纹。病根是 React 的 StrictMode 会
      // 「挂载 → 清理 → 再挂载」，而同一块 canvas 上 getContext 返回的是**同一个
      // 上下文**：第二次挂载新建了 program（uniform 全是初值 0），画布尺寸却还是
      // 上一次设好的 605×378 —— 尺寸相等，于是 uRes 那一行被跳过了。
      // 「尺寸没变」不等于「uniform 已经设过」，别拿前者当后者的判据。
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
      gl.uniform2f(u.uRes, w, h);
    },
    draw(s) {
      gl.uniform1f(u.uFlow, s.flow);
      gl.uniform1f(u.uAlt, s.alt);
      gl.uniform1f(u.uWarm, s.warm);
      gl.uniform1f(u.uNight, s.night);
      gl.uniform1f(u.uGust, s.gust);
      gl.uniform2f(u.uFrom, s.from[0], s.from[1]);
      gl.uniform3fv(u.uTint, s.tint);
      gl.uniform1f(u.uTintA, s.tintA);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    lost() { return gl.isContextLost(); },
  };
}

const TINT_COOL = rgb('#DCE6F0');
const TINT_WARM = rgb('#FFC98A');

/**
 * 时段的整片色偏。放在 JS 不放着色器 —— 这里是口味，改起来要一眼看得懂，
 * 而着色器该只管怎么把它画出来。
 */
function tintOf(light) {
  const am = light.hour < 12;
  if (light.night > 0.5) return { tint: TINT_COOL, tintA: 0 };
  if (am) return { tint: TINT_COOL, tintA: Math.min(0.055, Math.max(0, (0.6 - light.alt) * 0.09)) };
  return { tint: TINT_WARM, tintA: Math.min(0.10, Math.max(0, (light.warm - 0.42) * 0.20)) };
}

/**
 * 挂上光源层。
 *
 * @param {object} o
 * @param {HTMLCanvasElement} o.under 板面上那层（影 + 光）
 * @param {HTMLCanvasElement} o.over  内容上那层（光 + 夜）
 * @param {() => object} o.getLight   现在的光（lib/daylight.js 的 lightAt()）
 * @param {boolean} [o.still]         静止模式（prefers-reduced-motion）：只画一帧
 * @returns {{stop:()=>void}|null}    返回 null = 这台机器没有 WebGL，请退回 CSS 版
 */
export function mountCanopy({ under, over, getLight, still = false }) {
  const layers = [makeLayer(under, false), makeLayer(over, true)];
  if (layers.some((l) => !l)) return null;

  // 内部分辨率：柔光不需要 1:1，放大时的双线性插值反而白送一层柔化。
  // 封顶 780 是为了超宽屏 —— 再宽也不该多花钱。
  const SCALE = 0.42, CAP = 780;
  function fit() {
    const w = Math.max(1, Math.round(Math.min(window.innerWidth * SCALE, CAP)));
    const h = Math.max(1, Math.round(w * (window.innerHeight / Math.max(window.innerWidth, 1))));
    for (const l of layers) l.resize(w, h);
  }
  fit();

  // ── 风 ───────────────────────────────────────────────────────
  // 一阵一阵的，不是匀速。匀速漂移就是上一版那张滑动的贴图；真正让人相信
  // "外面有风"的是**大部分时间几乎不动、忽然过去一阵**。
  let flow = 0, gust = 0, nextGust = 3 + Math.random() * 8, gustLeft = 0;
  // 夜的程度自己追目标值：手动切换的时候中间每一帧都是成立的画面，不是跳变
  let night = getLight().night;

  let raf = 0, last = 0, acc = 0;
  // 帧率封顶，而且**分两档**：没风的时候光斑一分钟才挪一个身位，12 帧完全够；
  // 一阵风过去的那三四秒才值 30 帧。装饰层常年占着一台笔记本的 GPU 不合适，
  // 而这个降档不用做取舍 —— 慢的时候本来就看不出帧率。
  const STEP_CALM = 1 / 12, STEP_GUST = 1 / 30;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (document.hidden) { last = now; return; }
    const dt = Math.min(0.25, (now - last) / 1000 || 0);
    last = now;

    // 阵风状态机
    nextGust -= dt;
    if (nextGust <= 0 && gustLeft <= 0) { gustLeft = 1.6 + Math.random() * 2.4; nextGust = 6 + Math.random() * 16; }
    if (gustLeft > 0) { gustLeft -= dt; gust = Math.min(1, gust + dt * 1.7); } else { gust = Math.max(0, gust - dt * 0.55); }
    flow += dt * (0.035 + gust * 0.28);

    acc += dt;
    if (acc < (gust > 0.02 ? STEP_GUST : STEP_CALM)) return;
    acc = 0;

    const light = getLight();
    night += (light.night - night) * Math.min(1, dt * 1.6);
    const from = [
      SUN_FROM[0] + (LAMP_AT[0] - SUN_FROM[0]) * night,
      SUN_FROM[1] + (LAMP_AT[1] - SUN_FROM[1]) * night,
    ];
    const s = { flow, gust, night, alt: light.alt, warm: light.warm, from, ...tintOf(light) };
    for (const l of layers) { if (!l.lost()) l.draw(s); }
  }

  const onResize = () => fit();
  window.addEventListener('resize', onResize);

  if (still) {
    const light = getLight();
    const from = light.night > 0.5 ? LAMP_AT : SUN_FROM;
    const s = { flow: 4.2, gust: 0, night: light.night, alt: light.alt, warm: light.warm, from, ...tintOf(light) };
    for (const l of layers) l.draw(s);
  } else {
    raf = requestAnimationFrame(frame);
  }

  return {
    stop() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      // ⛔ **这里不能 loseContext()。** 一块 canvas 上 getContext('webgl') 永远
      // 返回同一个上下文对象，主动丢掉之后它就永久是 lost 的 —— 而 React 的
      // StrictMode 在开发模式下会「挂载 → 清理 → 再挂载」，第二次拿回来的就是
      // 那个已经死掉的上下文，着色器当场编不过，整层静悄悄退回 CSS 版。
      // （第一版就是这么坏的：页面看着有光斑，其实是退路在演。）
      // 画布随组件一起下线，上下文自己会被回收，不用手动丢。
    },
  };
}
