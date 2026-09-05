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
import { NIGHT_INK, LAMP, LAMP_AT, GAIN_REF, sunFrom, castAt } from '../lib/daylight.js';
import { makeOccluders } from './home-occluders.js';
import { bakeCanopy } from './home-canopy-texture.js';
import { VERT, FRAG } from './home-canopy-glsl.js';

/** '#RRGGBB' → [0..1, 0..1, 0..1] */
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}


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

const U = ['uRes', 'uFlow', 'uT', 'uElev', 'uCast', 'uLen', 'uGain', 'uWarm',
  'uNight', 'uGust', 'uOver',
  'uLit', 'uGold', 'uDusk', 'uNightC', 'uLampC', 'uFrom', 'uTint', 'uTintA',
  'uOccl', 'uHasOccl', 'uThrow', 'uSoft', 'uPoint',
  'uCanopy', 'uCanScale', 'uLeafA', 'uBias', 'uWinC', 'uWinR', 'uWinSoft', 'uLeaves'];

/**
 * 树冠那张图，**全站一份**。两块画布是两个 GL 上下文，各自要有自己的纹理对象，
 * 但都从这一张 canvas 上传 —— 烤一次 40ms，烤两次就是白花一次。
 */
let canopyPic = null;
function canopyCanvas() {
  if (!canopyPic) canopyPic = bakeCanopy();
  return canopyPic;
}

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

  // 遮挡图的纹理。⭐ 只有顶层建：影子只画在顶层（它得落在桌面上也落在别的纸上），
  // 底层在纸底下，画了看不见，那份每帧的上传就是白花的。
  let tex = null;
  let lastOcclV = -1;
  if (over) {
    tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // ⚠️ CLAMP_TO_EDGE 不是 REPEAT：光线走出画面之后要是绕回另一边，
    //   屏幕左边会凭空出现右边那些卡的影子。
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(u.uOccl, 0);
  }

  // 树冠。⭐ 两层都要：底层拿它画台面上的暖光，顶层拿它画落在纸上的叶影。
  // ⚠️ WRAP 必须是 REPEAT（图是可平铺的，靠它铺满一屏），而且**要 mipmap** ——
  //   半影靠 mip 偏置做，MIN_FILTER 停在 LINEAR 的话 uBias 一点作用都没有，
  //   影子会一整天硬得像剪纸。图是 512（2 的幂），所以 WebGL1 肯给它生成。
  const canopy = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, canopy);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canopyCanvas());
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.uniform1i(u.uCanopy, 1);

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
      gl.uniform1f(u.uT, s.t);
      gl.uniform1f(u.uElev, s.elev);
      gl.uniform2f(u.uCast, s.cast[0], s.cast[1]);
      gl.uniform1f(u.uLen, s.len);
      gl.uniform1f(u.uGain, s.gain);
      gl.uniform1f(u.uWarm, s.warm);
      gl.uniform1f(u.uNight, s.night);
      gl.uniform1f(u.uGust, s.gust);
      gl.uniform2f(u.uFrom, s.from[0], s.from[1]);
      gl.uniform3fv(u.uTint, s.tint);
      gl.uniform1f(u.uTintA, s.tintA);
      gl.uniform1f(u.uThrow, s.throw);
      gl.uniform1f(u.uSoft, s.soft);
      gl.uniform1f(u.uPoint, s.night);
      gl.uniform1f(u.uCanScale, s.canScale);
      gl.uniform1f(u.uLeafA, s.leafA);
      gl.uniform1f(u.uBias, s.bias);
      gl.uniform2f(u.uWinC, s.win[0], s.win[1]);
      gl.uniform2f(u.uWinR, s.win[2], s.win[3]);
      gl.uniform1f(u.uWinSoft, s.winSoft);
      gl.uniform1f(u.uLeaves, s.leaves);
      if (tex && s.occl) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        // ⭐ 桌上没动过就不重传。每帧传一张 RGBA 要花掉主线程 25ms/秒，
        //   而绝大多数帧里什么都没动（没滚、没 hover、没新卡片）。
        if (s.occlV !== lastOcclV) {
          lastOcclV = s.occlV;
          // ⚠️ 不翻 y：画布 2D 的第 0 行是屏幕顶上，而顶点着色器已经把 vUv.y=0
          //   定成屏幕顶上了（见 VERT），两边本来就对得上，翻了反而错位。
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, s.occl);
        }
        gl.uniform1f(u.uHasOccl, s.occlN > 0 ? 1 : 0);
      } else {
        gl.uniform1f(u.uHasOccl, 0);
      }
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
/** 树冠图在一屏里铺几遍。⭐ 它定的是**叶子有多大** —— 数字越小叶子越大。 */
const CAN_SCALE = 1.75;
/**
 * 叶影压多重（顶层的 alpha 上限）。
 * ⚠️ 这个数是量出来的不是调出来的：顶层压的是内容，纸暗一分字也暗一分。
 *    判据是 lens.mjs contrast 跟改动前并排，见 daylight 那份记忆里的对比度表。
 */
const LEAF_A = 0.22;

/**
 * ⭐⭐⭐ 树冠开关。0 = 桌上只剩一片素净的光，没有一片叶子。
 *
 * 站主 09-02 判词：「就那一小块树影斑驳…还不如素色」「对于我们这种强调沉浸专注
 * 和具有文学气质的应用，加入这么个看起来非常吵闹的样式会不会非常差劲」。
 *
 * 这不是妥协，三处独立的依据指向同一件事：fable 判「回潮的是光学不是叙事」；
 * Apple HIG 逐字写着材质不属于内容层；而实测**纸对纸的真投影只有 8-10 个灰阶，
 * 纯装饰的叶影是 23** —— 最值钱的一层被最像贴图的一层盖着。
 *
 * ⚠️ 留成一个开关而不是直接删：树冠那一整套（烤图、风场、三层相乘、窗光遮罩）
 *    还在，翻回 1 就全回来。删要等站主看过素色版之后再说。
 */
const LEAVES = 0;

/**
 * ⭐⭐⭐ 窗光那块亮区的几何。
 *
 * 09-02 的判词：叶影铺满整个视口，没有边界。**没有边界的影子是纹理。**
 * 这几个数把光收成一块有形状的东西：亮区从光源沿着投影方向甩出去，
 * 太阳越低甩得越远、拉得越长、边越软。它一天里自己从这头走到那头。
 *
 * ⚠️ 全部由 sunFrom() 和 castAt() 导出，不另立一份太阳位置。
 *    改这几个数只改光斑的大小和位置，改不了太阳在哪儿。
 */
const WIN = {
  // ⭐⭐ 窗子钉在墙上**不动**，动的是它投下来的那块光。
  // ⛔ 第一版把锚点写成 sunFrom()（跟着太阳走），结果投影方向的位移正好把太阳
  //   的位移抵消掉，光斑一整天钉在屏幕中间。太阳从 x=0.26 走到 0.83，光斑却
  //   在 0.45 到 0.54 之间晃 —— 「光会走」这件事一天都没发生。
  at: [0.52, 0.02],    // 窗子在墙上的位置（uv，y 很小 = 高处）
  // ⚠️ throw 的**底**决定光斑落在屏幕多高的位置。第一版给 0.10，光斑整天贴在
  //   上沿，落不到摆卡片的那片桌面上。0.26 让它一天都在屏幕中段扫过。
  throw: [0.26, 0.085], // 光甩多远 = 底 + 系数 × cast.len
  // ⚠️ 半长给大了光斑会被视口切掉，切掉之后就没有"上边"，又读回纹理了。
  //   0.20 那档正午的光斑整个落在屏幕里，上下都有边。
  long: [0.20, 0.075],  // 顺光方向的半长
  wide: 0.32,           // 垂直光方向的半宽
  soft: [0.20, 0.055], // 边的软度（相对半径）
};

const clamp01 = (v) => Math.min(1, Math.max(0, v));

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
 * @param {boolean} [o.still]         减少动态：停风和渐变，仍响应滚动、尺寸与光源变化
 * @returns {{stop:()=>void}|null}    返回 null = 这台机器没有 WebGL，请退回 CSS 版
 */
export function mountCanopy({ under, over, getLight, still = false }) {
  const layers = [makeLayer(under, false), makeLayer(over, true)];
  if (layers.some((l) => !l)) return null;

  // 内部分辨率：柔光不需要 1:1，放大时的双线性插值反而白送一层柔化。
  // 封顶 780 是为了超宽屏 —— 再宽也不该多花钱。
  const SCALE = 0.42, CAP = 780;
  // 遮挡图跟光源层同一个内部分辨率 —— uv 要一一对上，差一点影子就错位
  const occl = makeOccluders(1, 1);
  function fit() {
    const w = Math.max(1, Math.round(Math.min(window.innerWidth * SCALE, CAP)));
    const h = Math.max(1, Math.round(w * (window.innerHeight / Math.max(window.innerWidth, 1))));
    for (const l of layers) l.resize(w, h);
    // ⭐⭐ 遮挡图跟光源层同分辨率（从前是一半）。
    // ⛔ 半分辨率约等于 4.8 个 CSS 像素一格。**大张的纸看不出来，小东西一放进
    //   这张表就露馅**：输入纸那两片签只有 64×36，摊到半分辨率的图上只剩 13×7 格，
    //   投出来的影子是一段一段的阶梯。09-02 把签加进遮挡表之后当场看见。
    // ⚠️ 代价是上传量翻四倍（915KB 一次）。但上传是按版本号做的，
    //   桌上不动就不传；只有滚动那几秒才真的每帧传。
    occl.resize(w, h);
  }
  fit();
  /** 一张高度为 1 的纸，影子最多投多远（uv）。乘上 cast.len 就是这一刻的长度。 */
  // ⚠️ 素色版里影子的**长短变化**是白天唯一诚实的时间信号（早上长、正午短、
  //    傍晚又长）。0.026 那档三个时刻的影长是 32/26/50 像素，太短看不出来。
  const THROW = LEAVES > 0 ? 0.026 : 0.040;

  // ── 风 ───────────────────────────────────────────────────────
  // 一阵一阵的，不是匀速。匀速漂移就是上一版那张滑动的贴图；真正让人相信
  // "外面有风"的是**大部分时间几乎不动、忽然过去一阵**。
  let flow = 0, gust = 0, nextGust = 3 + Math.random() * 8, gustLeft = 0;
  // 夜的程度自己追目标值：手动切换的时候中间每一帧都是成立的画面，不是跳变
  let night = getLight().night;

  let raf = 0, last = 0, acc = 0;
  /** 上一帧遮挡图的版本号。⭐ 桌上的纸只要动了，这一帧就必须画，不能被帧率闸挡掉。 */
  let lastGeom = -1;
  let lastLight = null;
  // 帧率封顶，而且**分两档**：没风的时候光斑一分钟才挪一个身位，12 帧完全够；
  // 一阵风过去的那三四秒才值 30 帧。装饰层常年占着一台笔记本的 GPU 不合适，
  // 而这个降档不用做取舍 —— 慢的时候本来就看不出帧率。
  const STEP_CALM = 1 / 12, STEP_GUST = 1 / 30;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (document.hidden) { last = now; return; }
    const dt = Math.min(0.25, (now - last) / 1000 || 0);
    last = now;

    // 减少动态只停装饰运动，纸张移动和光源设置仍需重新投影。
    if (!still) {
      nextGust -= dt;
      if (nextGust <= 0 && gustLeft <= 0) { gustLeft = 1.6 + Math.random() * 2.4; nextGust = 6 + Math.random() * 16; }
      if (gustLeft > 0) { gustLeft -= dt; gust = Math.min(1, gust + dt * 1.7); } else { gust = Math.max(0, gust - dt * 0.55); }
      flow += dt * (0.035 + gust * 0.28);
    }

    // ⭐⭐⭐ 先量遮挡图，再过帧率闸。
    //
    // 站主 09-02 判词：「滚动页面的时候阴影会发生非常可怕的跟随和抖动」。
    // 病根就在这儿：页面以 60fps 滚，而这一层没风的时候只画 12fps，于是影子
    // 每 83 毫秒才追一次卡片 —— 卡片连续地走，影子一跳一跳地追，中间那段
    // 时间影子是脱开的。**卡片自己还有一条 CSS 接触影，那条是每帧跟手的**，
    // 于是同一张卡上一条影子跟手、一条影子拖后腿，读起来就是抖。
    // 而这一轮把投影抬到 2.3 倍之后，这个一直存在的毛病才变得刺眼。
    //
    // 修法不是把帧率整体抬上去（那是常年占着 GPU），是**让几何变化自己开闸**：
    // 滚动、hover 抬卡、新卡片进场，都会让遮挡图的版本号变，那一帧就画。
    // 桌上什么都没动的时候，照旧 12fps。
    // ⚠️ update() 每帧都要调（实测 55 个矩形 0.05ms），所以顺手把结果传给
    //    state()，别调两次。
    const o = occl.update();
    const moved = o.version !== lastGeom;
    lastGeom = o.version;

    acc += dt;
    const light = getLight();
    const changed = !lastLight || Object.keys(light).some((k) => light[k] !== lastLight[k]);
    // 素色版没有风中的叶子。光和纸都没变、渐变已结束时，不必反复绘制相同画面。
    if (!moved && !changed && (still || (LEAVES === 0 && Math.abs(light.night - night) < 0.001))) {
      acc = 0;
      return;
    }
    if (!still && !moved && acc < (gust > 0.02 ? STEP_GUST : STEP_CALM)) return;
    lastLight = light;
    const elapsed = acc;
    acc = 0;

    // 按实际经过的时间缓动，不能只算通过帧率闸的那一帧，否则夜色会拖上十几秒。
    night = still ? light.night : night + (light.night - night) * (1 - Math.exp(-elapsed * 5));
    // ⭐ 太阳的位置现在按钟点和季节算（sunFrom），夜里再揉向那盏钉死的灯。
    //   手动换挡的时候 night 是缓过去的，所以光源会**滑**到灯上，不是瞬移。
    for (const l of layers) { if (!l.lost()) l.draw(state(light, night, now, o)); }
  }

  /** 这一帧要画的一切。⭐ cast 跟纸上的 box-shadow 读的是同一个 castAt()。 */
  function state(light, night, now, o) {
    const sun = sunFrom(light);
    const cast = castAt({ ...light, night });
    return {
      occl: occl.canvas, occlN: o.n, occlV: o.version,
      throw: THROW * cast.len,
      soft: 0.55 * cast.blur,
      canScale: CAN_SCALE,
      // ⭐ 叶影正午最实、斜阳稍淡：太阳低的时候大气把光散开，影子没那么黑。
      // ⚠️ 但**衰减不能陡**。第一版写的是 0.46+0.54·elev 再整个乘 gain，
      //    五点钟量出来只剩正午的 38% —— 屏幕上等于没有叶影，而傍晚恰恰是
      //    真实世界里树影**最长最有戏**的时候。两条曲线都抬了底。
      leafA: LEAF_A * (0.64 + 0.36 * clamp01(light.elev))
             * (0.72 + 0.28 * (light.gain / GAIN_REF)),
      // ⭐ 半影：太阳越低影子越软。这是 mip 偏置，跟图里烤死的那一半叠加。
      // ⚠️ 上限压在 1.15：再大就糊成一团，叶子的形状没了 —— 而形状正是这一版的全部。
      bias: 1.15 * (1 - clamp01(light.elev)),
      flow, gust, night, t: now / 1000,
      elev: light.elev, warm: light.warm,
      gain: light.gain / GAIN_REF,
      cast: [cast.x, cast.y], len: cast.len,
      // ⭐ 亮区中心 = 窗子的位置 + 投影方向 × 甩出去的距离。
      //   早上光斑在右、正午在上、傍晚甩到左下，这是一天里最强的时间信号。
      win: [
        WIN.at[0] + cast.x * (WIN.throw[0] + WIN.throw[1] * cast.len),
        WIN.at[1] + cast.y * (WIN.throw[0] + WIN.throw[1] * cast.len),
        WIN.wide,
        WIN.long[0] + WIN.long[1] * cast.len,
      ],
      winSoft: WIN.soft[0] + WIN.soft[1] * cast.len,
      leaves: LEAVES,
      from: [
        sun[0] + (LAMP_AT[0] - sun[0]) * night,
        sun[1] + (LAMP_AT[1] - sun[1]) * night,
      ],
      ...tintOf(light),
    };
  }

  const onResize = () => { fit(); lastGeom = -1; };
  window.addEventListener('resize', onResize);

  if (still) {
    const light = getLight();
    flow = 4.2;
    const s = { ...state(light, light.night, 0, occl.update()), gust: 0 };
    for (const l of layers) l.draw(s);
  }
  raf = requestAnimationFrame(frame);

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
