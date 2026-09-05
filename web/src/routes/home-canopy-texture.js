/**
 * 树冠 —— 一张真的画着叶子的图（2026-09-02）。
 *
 * ## ⭐⭐ 为什么换掉 fbm 噪声
 *
 * 08-30 那版树影是四阶 fbm 噪声阈值化出来的「透光率场」。它解决了上一代 CSS
 * 渐变「一张图整体平移」的问题（图案内部关系会变了），但站主看完的判词是：
 * **「没有我想要的那种真实的树影婆娑…我想要真的那种，树叶叶片的阴影」**。
 *
 * 他是对的，而且这不是调参能补的。**噪声没有形状。** fbm 是各向同性的圆团，
 * 放大缩小都还是圆团；而人认树影靠的恰恰是形状 —— 尖头的叶子、连着叶子的细枝、
 * 叶子成簇挂在枝上而不是均匀撒开。少了这些，再怎么调阈值都是一片云。
 *
 * 所以这一层的机制换成：**真的画一遍叶子**，一片一片画进一张可平铺的图。
 *
 * ## ⭐⭐ 但绝不能只烤一层
 *
 * 只烤一层再整体平移，就退回 08-30 之前那条被否掉的老路了（一张图平移，
 * 图案内部关系永远不变，看久了读成滑动的贴纸）。
 *
 * 这里烤**三层**，塞进同一张图的 R / G / B 三个通道，着色器里三层各自漂移、
 * 各自摆动，然后**把透光率乘起来**：
 *
 *     trans = (1-r) × (1-g) × (1-b)
 *
 * ⭐ 相乘不是相加，因为**遮挡本来就是相乘的** —— 光要穿过三层叶子才落到桌上，
 * 每一层各挡掉一部分。这一条同时买到三样东西：
 *
 *   1. 三层缝对齐的地方是**全亮**的日斑，三层都挡着的地方是**很深**的暗，
 *      中间过渡自然。相加只会得到一片灰。
 *   2. **婆娑是免费的**：三层相对错动一点点，缝就会张开、合上、并到一起、灭掉。
 *      这正是站在真树底下看到的那种动法 —— 变的是图案本身不是位置。
 *   3. 层与层错动，任何一帧都不是另一帧的平移。判据见 notatexture 那条。
 *
 * ## 为什么烤成图，不在着色器里现算
 *
 * 程序化画叶子要在每个像素上查它周围 3×3 个格子里有没有叶子（叶子有大小和朝向，
 * 邻格的叶子会伸进来），三层就是 27 次求值 —— 这台 1 vCPU 的机器上 headless 走
 * SwiftShader，跑不动。而**叶子的形状一辈子不变**，烤一次是 O(1)，运行时只剩
 * 三次纹理采样。形状的自由度也从「噪声能拧出什么样」变成「Canvas 2D 能画什么」。
 *
 * ## ⭐ 三层不是同一种模糊
 *
 * 上层的叶子离桌面远，半影张得开，所以烤的时候就先糊掉；底层近，边是清楚的。
 * 这是**在图里烤死的那一半**半影。另一半（太阳低的时候整片影子都软下来）在
 * 着色器里用 mip 偏置做，见 home-canopy-glsl.js 的 uBias。
 */

/** 图的边长。⚠️ 必须是 2 的幂，否则 WebGL1 不给这张图生成 mipmap（半影就没了） */
export const TILE = 512;

/**
 * 三层树冠，从上到下。`blur` 是**烤进图里**的那一半半影：上层的叶子离桌面远，
 * 半影张得开，所以先糊掉；底层近，边是清楚的。
 *
 * ⭐ `ink` 接近 1：**一片叶子是不透光的**。单层的浓淡靠叶子多大多密来调，
 * 不靠把叶子画成半透明 —— 半透明的叶子叠起来是一片均匀的灰，形状就没了，
 * 那正是 fbm 那版的毛病。
 *
 * ⚠️ 靶子看的是 bake.mjs 打出来的**日斑占比**（透光 >90% 的面积）：真树底下
 * 大概一两成。09-02 第一版是 41.6% —— 太疏了，叶子之间空得连不起来，
 * 这也是站主说「一堆独立的叶片」的另一半原因；成簇之后 boughs 调到 8/8/9，
 * 日斑 19.3%。⛔ 别再往密里调，单层遮蔽率到 0.7 时三层乘完只剩 2.7%，整屏黑成一块。
 */
export const LAYERS = [
  { ch: 0, leaf: 40, wide: 0.66, ink: 0.95, blur: 2.8, boughs: 7, perBough: 3, seed: 1 },
  { ch: 1, leaf: 34, wide: 0.68, ink: 0.95, blur: 1.6, boughs: 7, perBough: 3, seed: 2 },
  { ch: 2, leaf: 29, wide: 0.70, ink: 0.95, blur: 0.7, boughs: 8, perBough: 3, seed: 3 },
];

/** 烤的时候往外扩这么多，模糊完再裁掉 —— 不扩的话四条边会被糊出一圈亮边 */
const MARGIN = 28;

/** 定死的随机数。⭐ 树冠每次刷新都长得一样，不然截图判据全部作废 */
function rng(seed) {
  let s = (seed * 1103515245 + 12345) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * 一根小枝上挂一串叶子。返回**纯数据**（不碰 canvas），所以这一半是可测的。
 *
 * ⭐ 叶子必须**成簇挂在枝上**，不能均匀撒。均匀撒出来的是壁纸不是树 ——
 * 真树冠的疏密来自枝条的走向，叶子只是挂在枝上的东西。
 *
 * ⭐ 也返回 `path`（枝走过的那几个节点）。枝得画出来，而且要有粗细变化 ——
 * 站主 09-02 的判词里「一堆**独立**的叶片」有一半是字面意思：**没有枝**，
 * 叶子之间没有任何东西连着，那当然读不成一根在摆的枝条。
 *
 * @returns {{leaves:{x,y,a,s}[], tip:number[], path:number[][]}}
 */
export function sprigLeaves(rnd, x0, y0, ang, joints) {
  const out = [];
  const path = [[x0, y0]];
  let x = x0; let y = y0; let a = ang;
  const step = 11 + rnd() * 7;
  for (let i = 0; i < joints; i++) {
    // 枝条自己会拐，但拐得不多 —— 拐狠了就成了一团乱线
    a += (rnd() - 0.5) * 0.5;
    x += Math.cos(a) * step;
    y += Math.sin(a) * step;
    path.push([x, y]);
    // 一个节上左右各一片，交替着先长哪边
    for (const side of [-1, 1]) {
      if (rnd() > 0.86) continue;              // 有的节是秃的，太齐整不像真枝
      out.push({
        x, y,
        a: a + side * (0.5 + rnd() * 0.7),     // 叶子从枝上斜着支出去
        s: 0.62 + rnd() * 0.62,
      });
    }
  }
  return { leaves: out, tip: [x, y, a], path };
}

/** 一片叶子的轮廓：两段二次曲线在尖和柄上碰头。⭐ 尖头是叶子最认得出的特征 */
function leafPath(g, len, wide) {
  g.beginPath();
  g.moveTo(0, 0);
  // 两段三次曲线：柄那头鼓出来收圆，尖那头收细 —— 阔叶树的叶子是这个轮廓，
  // 两段二次曲线画出来最宽处正在当中，那是柳叶或者竹叶。
  g.bezierCurveTo(len * 0.10, -wide, len * 0.52, -wide, len, 0);
  g.bezierCurveTo(len * 0.52, wide, len * 0.10, wide, 0, 0);
  g.closePath();
}

/** 一层树冠画进一块灰度画布（白 = 挡光） */
function bakeLayer(mk, spec) {
  const S = TILE + MARGIN * 2;
  const c = mk(S, S);
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);

  const rnd = rng(spec.seed);
  const ink = `rgba(255,255,255,${spec.ink})`;
  g.fillStyle = ink;
  g.strokeStyle = ink;
  g.lineCap = 'round';
  g.lineJoin = 'round';

  // ⭐⭐ 枝**成簇**长，不是十几根散落在图上。真树冠的疏密来自枝条的分叉：
  //   一个丫上分出去几根小枝，几根小枝上挂着一片叶子。散落的枝画出来是壁纸，
  //   而站主说的「一堆独立的叶片」正是壁纸的读法。
  for (let t = 0; t < spec.boughs; t++) {
    const bx = rnd() * TILE;
    const by = rnd() * TILE;
    const ba = rnd() * Math.PI * 2;
    const sprigs = [];
    let reach = spec.leaf * 1.3;
    for (let j = 0; j < spec.perBough; j++) {
      // 同一个丫上的小枝朝**相近**的方向散开（±0.5 弧度上下），不是四面八方
      const a0 = ba + (j - (spec.perBough - 1) / 2) * (0.46 + rnd() * 0.40);
      const sp = sprigLeaves(rnd, bx, by, a0, 5 + Math.floor(rnd() * 5));
      sprigs.push(sp);
      for (const [px, py] of sp.path) reach = Math.max(reach, Math.hypot(px - bx, py - by) + spec.leaf * 1.3);
    }
    // ⭐ 图要能平铺，所以跨过边的丫得从对面接回来。
    //   ⚠️ 只补**需要的那一侧**：贴着左边的丫是往左伸出去的，要在右边补一份
    //   （ox=+1），补左边那份是白画。成簇之后 reach 大了不少，八个邻位全补
    //   会让烤一次从 44ms 涨到 119ms —— 而真正用得上的最多三个。
    const side = (v) => (v < reach ? [0, 1] : v > TILE - reach ? [-1, 0] : [0]);
    const nx = side(bx);
    const ny = side(by);
    for (const ox of nx) {
      for (const oy of ny) {
        g.save();
        g.translate(MARGIN + ox * TILE, MARGIN + oy * TILE);
        for (const sp of sprigs) {
          // ⭐ 枝条**从根到梢由粗到细**，一段一段画。等宽的一条细线读作铁丝，
          //   有收梢的才读作枝条 —— 而枝条是把一簇叶子绑成"一个整体"的那样东西。
          for (let i = 1; i < sp.path.length; i++) {
            g.lineWidth = spec.leaf * (0.20 - 0.145 * (i / sp.path.length));
            g.beginPath();
            g.moveTo(sp.path[i - 1][0], sp.path[i - 1][1]);
            g.lineTo(sp.path[i][0], sp.path[i][1]);
            g.stroke();
          }
          for (const lf of sp.leaves) {
            g.save();
            g.translate(lf.x, lf.y);
            g.rotate(lf.a);
            leafPath(g, spec.leaf * lf.s, spec.leaf * lf.s * spec.wide * 0.5);
            g.fill();
            g.restore();
          }
        }
        g.restore();
      }
    }
  }

  // ⛔ **先糊整张，再裁**。反过来（裁的时候顺手糊）糊的是裁完那一块，
  //   框外算透明 —— 四条边会被糊出一圈没有叶子的亮边。第一版正是这样。
  const blurred = mk(S, S);
  const bg = blurred.getContext('2d');
  // ⚠️ ctx.filter 在老 Safari 上没有。没有就不糊 —— 影子硬一点，不是坏掉
  if ('filter' in bg && spec.blur > 0) bg.filter = `blur(${spec.blur}px)`;
  bg.drawImage(c, 0, 0);
  bg.filter = 'none';

  const out = mk(TILE, TILE);
  out.getContext('2d').drawImage(blurred, MARGIN, MARGIN, TILE, TILE, 0, 0, TILE, TILE);
  return out;
}

/**
 * 烤出树冠图：R / G / B 各是一层，从上到下。
 *
 * @param {(w:number,h:number)=>HTMLCanvasElement} [mk] 造画布（测试注入）
 * @returns {HTMLCanvasElement}
 */
export function bakeCanopy(mk) {
  const make = mk || ((w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  });
  const out = make(TILE, TILE);
  const g = out.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, TILE, TILE);
  // ⭐ 三层塞进三个通道：拿纯红/绿/蓝去乘，再用 lighter 累加，通道之间互不干扰。
  //   （一张图三次采样，比三张图三次绑定便宜，也省两个纹理单元。）
  const MASK = ['#f00', '#0f0', '#00f'];
  for (const spec of LAYERS) {
    const layer = bakeLayer(make, spec);
    const tinted = make(TILE, TILE);
    const tg = tinted.getContext('2d');
    tg.drawImage(layer, 0, 0);
    tg.globalCompositeOperation = 'multiply';
    tg.fillStyle = MASK[spec.ch];
    tg.fillRect(0, 0, TILE, TILE);
    g.globalCompositeOperation = 'lighter';
    g.drawImage(tinted, 0, 0);
  }
  g.globalCompositeOperation = 'source-over';
  return out;
}
