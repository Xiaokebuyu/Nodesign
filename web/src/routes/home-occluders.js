/**
 * 遮挡图 —— 让光源层知道桌上摆着哪些纸（2026-09-01）。
 *
 * ## ⭐⭐ 为什么要有这一层
 *
 * 在此之前光源层是**瞎的**：树影均匀铺满整屏，纸的影子是每张卡用一条 CSS
 * box-shadow 自己画的固定偏移。于是有三件在真实场景里必然发生的事，站点上一件
 * 也没有：
 *
 *   1. 纸挡不住任何东西。一张卡不会在另一张卡上投影，输入栏那一叠也不会。
 *   2. 夜里所有卡的影子朝同一个方向。可台灯是**近处的点光源**，真实情况是影子
 *      从灯那儿放射开来，左边的卡朝左下、右边的卡朝右下。这是整套光里最假的一处。
 *   3. 影子的长短跟它离光源多远无关。
 *
 * 这三件都不是调参能补的，缺的是**几何**。这个文件就是几何：把页面上所有算「纸」
 * 的矩形画进一张小图，着色器拿它当遮挡物去投影。
 *
 * ## 它有多便宜
 *
 * 实测（生产首页 55 个矩形，画进 605x378）：**一次 0.05ms**。所以不必做增量、
 * 不必做脏检查，每帧重画一遍就行 —— 而且必须每帧重画，因为鼠标划过时那张卡会
 * 抬起来转正（280ms 的过渡），影子得跟着走。
 *
 * ⚠️ 转过的纸要按**转过的样子**画，不能用轴对齐的包围盒。
 *   卡片那零点几度无所谓，但揭页动画里那张纸绕回形针转下去（nddPeelOff，520ms），
 *   包围盒当场胀成一个又大又正的矩形 —— 站主 09-02：「动画过程的阴影是一个超级
 *   扩大的输入栏的矩形，而并非真的跟随纸张移动的阴影」。就是它。
 */

/**
 * 什么算纸，以及它离桌面多高。
 *
 * 高度的单位是「一张平放的卡 = 1」，不是像素 —— 影子的实际长度由光的高度角决定
 * （见 daylight.js 的 castAt），这里只说谁比谁高。
 *
 * ⛔ 这张表要跟着色器里真画出来的东西对齐：**列进来的元素会被投影，没列进来的
 *   不会**。所以列进来之后，它自己那条 CSS 影子就得降成接触影，否则一件东西
 *   有两个影子（见 home-light.jsx 的 SHEET_TIERS）。
 */
export const OCCLUDERS = [
  ['.ndd-card > a', 1.0],   // 桌上钉着的一张纸，贴得最平
  ['.ndd-pad', 2.2],        // 手边那一叠，最高的一摞
  ['.ndd-peel', 2.4],       // 正被揭掉的那一张，飞在最上面
  // ⭐⭐ 输入纸的两片签。**两片的矩形一模一样**（都是 64×36、同一个 y、没有
  //   transform），差别只在谁压着谁 —— 选中那片是最上面那张纸的签，所以它更高。
  //   高度不同 → 影子长度不同、受光的角度不同，这正是站主要的"两片反射度不一样"。
  //   ⚠️ 顺序要紧：`.on` 那条在前，否则 :not(.on) 那条会把它一起收了。
  // ⚠️ 选中那片的高度必须**跟纸一模一样**（2.2）。签跟纸是一体的（home-styles.js
  //   里那句"签跟纸是一体的，所以复制品带自己那一片签一起飞"），高一档它就会在
  //   自己那张纸上投影 —— 站主 09-02：「按钮在视觉上需要和其对应的模式输入栏的
  //   样式是一体的，现在看起来是被贴上去的」。同高时 step(selfH+0.03, o.r) 自己
  //   就把这一笔挡掉了，不用特判。
  ['.nd-tabs > *.on', 2.2],
  ['.nd-tabs > *:not(.on)', 1.85], // 压在后面那片，矮一截
  // ⛔ **顶栏不进这张表。** 09-02 试过一版：它确实挡着光却不投影，读起来是透明的，
  //   但补上影子之后更糟。顶栏不是桌上的一张纸，是画框的边。影子值钱是因为它表达
  //   **会动的东西之间的关系**（卡片抬起来、纸叠在纸上、太阳转过去）；顶栏钉死不动，
  //   它的影子是一条恒定的横带，不携带任何信息，却是整页最重的一笔
  //   （实测紧贴下沿 148 对 216，落差 68，比任何一张卡都狠），还正好压在输入纸上沿。
];
/** 高度编码进红色通道时的满量程 */
const H_MAX = 4;

/**
 * 开一张遮挡图。
 *
 * @param {number} w 内部分辨率，跟光源层那两块画布一样（uv 才对得上）
 * @param {number} h
 */
export function makeOccluders(w, h) {
  let lastSig = NaN;
  let version = 0;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d', { willReadFrequently: false });

  return {
    canvas,
    resize(nw, nh) {
      if (canvas.width !== nw || canvas.height !== nh) { canvas.width = nw; canvas.height = nh; lastSig = NaN; }
    },
    /**
     * 重画一遍。返回 `{ n, version }`：n 是这一帧有几张纸（一张都没有时着色器整段跳过），
     * version 只在**画面真的变了**的时候才加一。
     *
     * ⭐⭐ version 是为了省掉纹理上传。实测每帧都传一张 605x378 的 RGBA（915KB）
     * 要花掉主线程 25ms/秒，而绝大多数帧里桌上什么都没动 —— 没滚、没 hover、
     * 没新卡片。量一次矩形（55 次 getBoundingClientRect，布局是干净的所以很便宜）
     * 换掉一次上传，非常划算。
     *
     * ⚠️ 只读 getBoundingClientRect，不写 DOM。写了再读就会逼出一次强制回流，
     *   而这个函数是每帧跑的。
     */
    update() {
      const vw = window.innerWidth || 1;
      const vh = window.innerHeight || 1;
      const kx = canvas.width / vw;
      const ky = canvas.height / vh;
      // 先量、再比、最后才画。
      // ⚠️ sig 用**数字**不用字符串：这个函数每帧跑，55 个矩形拼一条字符串
      //   每帧要分配一次几百字节，量出来比它省下的还多。数字累加零分配。
      let sig = canvas.width * 7919 + canvas.height;
      const seen = [];
      for (const [sel, height] of OCCLUDERS) {
        let i = 0;
        // ⭐ 高度也进签名：签名该代表**画出来的那张图**，而高度是画进红色通道的。
        // ⚠️ 别把它说成是"修好了切换失效" —— 那两片签的 left 本来就不同
        //   （928 对 985），换 .on 时签名自己就会变。这一项防的是另一种情况：
        //   同一个矩形因为换了选择器而换了高度。
        sig = (sig * 31 + Math.round(height * 16)) | 0;
        for (const el of document.querySelectorAll(sel)) {
          const b = el.getBoundingClientRect();
          i += 1;
          if (b.width < 4 || b.height < 4 || b.bottom < -vh || b.top > vh * 2) continue;
          // ⭐⭐ 转过的元素：包围盒比它本身大。**只有对不上的时候才去读 computed
          //   style** —— 那一步比 getBoundingClientRect 贵得多，而整页 55 个元素里
          //   平时只有零星几个真的转着。
          let rot = 0, ow = b.width, oh = b.height;
          if (el.offsetWidth && Math.abs(b.width - el.offsetWidth) > 2) {
            // ⚠️ 自己解析 matrix 串，不用 DOMMatrix：它是浏览器全局，
            //   仓库那条 no-undef 判据会拦（而且不是每个环境都有）。
            //   matrix(a,b,c,d,e,f) 取前四个；matrix3d 取 m11 m12 m21 m22。
            const n = (getComputedStyle(el).transform.match(/-?[\d.e+]+/g) || []).map(Number);
            const [a, b2, c, d] = n.length >= 16 ? [n[0], n[1], n[4], n[5]] : n;
            if (Number.isFinite(a) && Number.isFinite(b2)) {
              rot = Math.atan2(b2, a);
              ow = el.offsetWidth * Math.hypot(a, b2);
              oh = el.offsetHeight * Math.hypot(c, d);
            }
          }
          // 取整到半个像素：亚像素的抖动不该触发一次重传
          const q = (v) => Math.round(v * 2);
          sig = (sig * 31 + q(b.left)) | 0;
          sig = (sig * 31 + q(b.top)) | 0;
          sig = (sig * 31 + q(b.width)) | 0;
          sig = (sig * 31 + q(b.height)) | 0;
          sig = (sig * 31 + i) | 0;
          sig = (sig * 31 + Math.round(rot * 400)) | 0;
          seen.push([b, height, i, rot, ow, oh]);
        }
      }
      if (sig === lastSig) return { n: seen.length, version };
      lastSig = sig;
      version += 1;

      g.clearRect(0, 0, canvas.width, canvas.height);
      let n = 0;
      for (const [b, height, i, rot, ow, oh] of seen) {
        // 红色通道 = 这张纸有多高，alpha = 这儿是不是纸。
        // ⭐ 每张纸的高度错开一点点。**完全共面的两张纸在物理上永远不会互相投影**
        //   （同一个高度上，一张纸的影子恰好就是它自己的轮廓），所以严格共面的
        //   模型会得到一桌互不相干的卡。真实的一桌纸本来就有厚薄和卷边，
        //   错开之后邻居之间才会互相压出影子，深度是从这儿来的。
        const jitter = height * (1 + ((i * 37) % 11) / 11 * 0.34 - 0.17);
        g.fillStyle = `rgba(${Math.round((jitter / H_MAX) * 255)},0,0,1)`;
        if (rot) {
          // 绕包围盒中心转回去，按它**本来的**大小画
          g.save();
          g.translate((b.left + b.width / 2) * kx, (b.top + b.height / 2) * ky);
          g.rotate(rot);
          g.fillRect(-ow / 2 * kx, -oh / 2 * ky, ow * kx, oh * ky);
          g.restore();
        } else {
          g.fillRect(b.left * kx, b.top * ky, b.width * kx, b.height * ky);
        }
        n += 1;
      }
      return { n, version };
    },
  };
}
