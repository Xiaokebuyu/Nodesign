/**
 * 树影的契约（2026-09-02，叶子那一版）。
 *
 * 这一轮修的那个 bug 值得单独钉一条：叶影的那一笔从前带着 `(1.0 - uOver)`，
 * 只画在**底层**，而底层压在所有卡片**底下** —— 于是「树叶的影子落在纸上」
 * 这件事一笔都没发生过。它不报错、测试也全绿，只是站主看了三轮之后说
 * 「没有我想要的那种真实的树影婆娑」。
 *
 * ⭐ 这类错误的形状是：**代码完全按写的跑，只是写的那句话说的不是那件事**。
 * 唯一逮得住它的判据是把需求本身写成断言，所以下面三条断言就是站主那句话
 * 拆成的三件事：
 *
 *   1. 叶影必须落在内容**上面**（uOver 那一层），否则纸会把它盖掉
 *   2. 夜里不许有叶影（站主点名："当然晚上就不必有树木叶片影子了"）
 *   3. 三层叶子必须**都被采到**，而且透光率是**相乘**的
 *
 * 每条都攻过：把 uOver 改回 (1.0 - uOver)、把 day 去掉、把 .b 那次采样删掉，
 * 三条分别变红。
 *
 * ## 09-02 第二轮判词：「一堆独立的叶片」
 *
 * 站主看过上面那一版之后说：**「现在有点树影婆娑…但是还不够…真正情况下应该是
 * 所有叶片影子带上枝丫作为一个整体做无规律晃动…现在看起来就像是一堆独立的叶片」**。
 *
 * 这句话里有**两个相反的要求**，下面第三个 describe 就是把它俩一起钉住：
 *   整体   相邻的叶子要一起动 —— 量出来是"邻格位移方向的余弦"，改之前只有 0.33
 *   无规律 整片又不能只是在平移 —— 那是 08-30 否掉的贴图，对照组量出来 0.99
 * 所以判据不是"越像整体越好"，是**两头都不能到**。定稿 0.91 / 共同位移占比 60%。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAYERS, TILE, sprigLeaves } from './home-canopy-texture.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLSL = fs.readFileSync(path.join(HERE, 'home-canopy-glsl.js'), 'utf8');
const DRIVER = fs.readFileSync(path.join(HERE, 'home-canopy.js'), 'utf8');

/** 把注释剥掉再找代码 —— 注释里写着「画在顶层」不算数，得真的写在那一行上 */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/**
 * 叶影那一笔：**画**叶影的那条 lay(...)。
 * ⚠️ 不能只找 uLeafA —— 第一个命中的是文件头上 `uniform float uLeafA;` 那行声明，
 *   而声明里当然既没有 uOver 也没有 day，断言会假红。
 */
function leafLine() {
  const line = code(GLSL).split('\n').find((l) => l.includes('uLeafA') && l.includes('lay('));
  expect(line, '着色器里找不到画叶影的那一行（lay(... uLeafA)）').toBeTruthy();
  return line;
}

describe('叶影的契约', () => {
  it('⭐⭐ 叶影画在内容之上，不是之下 —— 画在下面等于没画', () => {
    const line = leafLine();
    expect(line, '叶影那一笔要乘 uOver（顶层）').toMatch(/\buOver\b/);
    // ⛔ 这就是 09-02 之前的写法。底层在所有卡片底下，叶影一笔也落不到纸上。
    expect(line, '⛔ 叶影带了 (1.0 - uOver)：又画回底层了，纸会把它整个盖掉')
      .not.toMatch(/1\.0\s*-\s*uOver/);
  });

  it('⭐ 夜里没有叶影（站主点名的一条）', () => {
    // day = 1.0 - uNight。太阳下去了树冠就不在光路上，屋里的光源是桌上那盏灯。
    expect(leafLine(), '叶影那一笔要乘 day，否则天黑之后屋里还站着一棵树')
      .toMatch(/\bday\b/);
    expect(code(GLSL)).toMatch(/float\s+day\s*=\s*1\.0\s*-\s*uNight/);
  });

  it('⭐⭐ 三层叶子都要采到，而且透光率是相乘的', () => {
    const src = code(GLSL);
    const fn = src.slice(src.indexOf('float leafShade'), src.indexOf('float castShadow'));
    for (const ch of ['r', 'g', 'b']) {
      expect(fn, `树冠图的 .${ch} 那一层没人采 —— 少一层就少一重遮挡，深浅全平了`)
        .toMatch(new RegExp(`texture2D\\(uCanopy[\\s\\S]*?\\.${ch}\\b`));
    }
    expect(LAYERS.length, 'LAYERS 有几层，leafShade 就得采几次').toBe(3);
    // ⭐ 相乘不是相加：相加只会得到一片灰，相乘才有"三层的缝对齐"那种全亮的日斑
    expect(fn, '透光率要相乘（1-r)(1-g)(1-b)，相加出来的是一片灰')
      .toMatch(/\(1\.0\s*-\s*t\.r\)\s*\*\s*\(1\.0\s*-\s*t\.g\)\s*\*\s*\(1\.0\s*-\s*t\.b\)/);
  });

  it('⭐ 半影靠 mip 偏置，所以纹理必须真的有 mipmap', () => {
    // ⛔ MIN_FILTER 停在 LINEAR 的话 uBias 一点作用都没有，影子一整天硬得像剪纸，
    //   而且不报任何错。这条同时钉住 TILE 是 2 的幂（WebGL1 只给 POT 生成 mipmap）。
    expect(DRIVER).toMatch(/LINEAR_MIPMAP_LINEAR/);
    expect(DRIVER).toMatch(/generateMipmap/);
    expect(Math.log2(TILE) % 1, `树冠图边长 ${TILE} 不是 2 的幂，WebGL1 不会给它生成 mipmap`).toBe(0);
    expect(code(GLSL), '采样时要传 uBias，不然 mipmap 白生成').toMatch(/uCanopy[\s\S]{0,160}uBias/);
  });

  it('⭐ 树冠图要能平铺（REPEAT），不然一屏只够铺一张', () => {
    const canopyBlock = DRIVER.slice(DRIVER.indexOf('const canopy = gl.createTexture'));
    expect(canopyBlock.slice(0, 600)).toMatch(/TEXTURE_WRAP_S,\s*gl\.REPEAT/);
    expect(canopyBlock.slice(0, 600)).toMatch(/TEXTURE_WRAP_T,\s*gl\.REPEAT/);
  });
});

describe('树冠图这张图本身', () => {
  it('三层各占一个通道，从上到下越来越清楚', () => {
    expect(LAYERS.map((l) => l.ch)).toEqual([0, 1, 2]);
    // 上层离桌面远，半影张得开；底层近，边是清楚的
    for (let i = 1; i < LAYERS.length; i++) {
      expect(LAYERS[i].blur, `第 ${i} 层该比上一层清楚`).toBeLessThan(LAYERS[i - 1].blur);
      expect(LAYERS[i].leaf, `第 ${i} 层该比上一层的叶子小（近大远小的反面：它投得近）`)
        .toBeLessThan(LAYERS[i - 1].leaf);
    }
  });

  it('⭐ 叶子是不透光的 —— 浓淡靠密度调，不靠把叶子画成半透明', () => {
    // 半透明的叶子叠起来是一片均匀的灰，形状就没了，那正是 fbm 那版的毛病。
    for (const l of LAYERS) expect(l.ink, '叶子的 alpha 该接近 1').toBeGreaterThan(0.85);
  });

  it('叶子成簇挂在枝上，不是均匀撒开', () => {
    let s = 12345;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const { leaves, tip } = sprigLeaves(rnd, 100, 100, 0.3, 6);
    expect(leaves.length).toBeGreaterThan(4);
    // 枝是走出去的：末端离起点该有一段距离，而不是原地打转
    expect(Math.hypot(tip[0] - 100, tip[1] - 100)).toBeGreaterThan(30);
    // 每片叶子都该长在枝上（离枝的走向不远），不是撒在整张图上
    for (const lf of leaves) {
      const d = Math.hypot(lf.x - 100, lf.y - 100);
      expect(d).toBeLessThanOrEqual(Math.hypot(tip[0] - 100, tip[1] - 100) + 1e-6);
    }
  });

  it('⭐ 随机数是钉死的：树冠每次刷新都长得一样', () => {
    // 不钉的话每次截图的树影都不同，所有逐像素判据当场作废。
    const mk = (seed) => {
      let s = (seed * 1103515245 + 12345) >>> 0;
      return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    };
    const a = sprigLeaves(mk(7), 0, 0, 0, 5);
    const b = sprigLeaves(mk(7), 0, 0, 0, 5);
    expect(a).toEqual(b);
  });
});

/**
 * 「整体地晃」和「不是一张滑动的贴图」是同一根轴的两头，下面这些断言拦的是
 * **往两头掉**。量具在 scratchpad/motion2.mjs：分块匹配算出每一格的位移，
 * 再看这些位移向量彼此像不像。
 */
describe('晃动的契约：整片一起动，但不是整片一起平移', () => {
  const shade = () => {
    const src = code(GLSL);
    return src.slice(src.indexOf('float leafShade'), src.indexOf('float castShadow'));
  };
  const field = () => {
    const src = code(GLSL);
    return src.slice(src.indexOf('vec2 windField'), src.indexOf('float leafShade'));
  };

  it('⭐⭐⭐ 三层叶子同向走 —— 反向走就是"一堆独立的叶片"', () => {
    const fn = shade();
    // ⛔ 从前是 +wind / -0.68·sway / +0.31·sway：三层朝相反方向切过彼此。
    //   眼睛没法把朝三个方向走的东西归成一棵树，这就是站主看到的那个画面。
    expect(fn, '三层都要吃到风').toMatch(/wind[\s\S]*wind[\s\S]*wind/);
    expect(fn, '⛔ 有一层的风带着减号：它在朝反方向走，整棵树就散了')
      .not.toMatch(/-\s*wind/);
    // 同向不等于同步：三层的纹理尺度不同，屏幕位移自然差着一倍多，婆娑从这儿来
    const ks = [...fn.matchAll(/p \* k(?: \* ([\d.]+))?/g)].map((m) => Number(m[1] || 1));
    expect(ks.length, 'leafShade 该采三层').toBe(3);
    expect(new Set(ks).size, '三层的纹理尺度要各不相同，否则三层完全同步 = 一张贴图').toBe(3);
  });

  it('⭐⭐ 风是一个**随位置变**的场，不是全屏一个常数', () => {
    const fn = field();
    // 这一条是"不是贴图"的全部依据：位移随位置平滑变化 = 图案在形变。
    // 相位里不带位置的话，全屏同相，整片一起平移 —— 对照组量出来共同位移 99%。
    expect(fn, '⛔ 相位里没有位置（dot(p, dir)）：全屏同相 = 一张在平移的贴图')
      .toMatch(/dot\(p,\s*dir\)/);
    expect(fn, '摆幅要随位置变（grip），否则整片一样凶').toMatch(/vnoise\(p/);
  });

  it('⭐ 摆动是几个不通约的频率叠起来的，不是一个正弦', () => {
    // 单个正弦有节拍，听得出来就不像风了。"无规律"是站主的原话。
    // ⚠️ 只数**摆动**那两行（sw / cr）里的频率。第一版数的是整个 windField 里的
    //    sin/cos，可风向那两行本身就带着四个 —— 于是把 sw 收成一个正弦它照样绿。
    //    判据要挑"有守卫和没守卫结果不同"的那个点。
    const fn = field();
    const swing = fn.slice(fn.indexOf('float sw'), fn.indexOf('float grip'));
    const freqs = new Set([...swing.matchAll(/uT \* ([\d.]+)/g)].map((m) => m[1]));
    expect(freqs.size, `摆动只有 ${freqs.size} 个频率，会摆出节拍来`).toBeGreaterThanOrEqual(4);
  });

  it('⭐⭐⭐ 低频密度层也得跟着树冠一起动', () => {
    // 它是整幅画面里尺度最大、对比最强的一层。从前它挂在 uFlow 上匀速平移，
    // 一帧走 19 个像素，比叶子还快 —— 于是屏幕上真正在动的东西是它，
    // 分块匹配锁在它身上（共同位移 98%），眼睛读到的也是"一整片在滑"。
    const line = code(GLSL).split('\n').find((l) => l.includes('float dens'));
    expect(line, '找不到 dens 那一行').toBeTruthy();
    expect(line, '⛔ dens 没吃到 wind：它会自己匀速滑过去，盖住所有摆动').toMatch(/\bwind\b/);
  });

  it('⭐⭐ 叶子成簇长在丫上，不是十几根散落在图上', () => {
    // 散落的枝画出来是壁纸；「一堆独立的叶片」正是壁纸的读法。
    for (const l of LAYERS) {
      expect(l.boughs, '每层要有几个丫').toBeGreaterThanOrEqual(3);
      expect(l.perBough, '一个丫上至少两根小枝，否则"成簇"没有发生').toBeGreaterThanOrEqual(2);
    }
  });

  it('⭐ 枝条画得出来，而且从根到梢由粗到细', () => {
    // 「一堆**独立**的叶片」有一半是字面意思：叶子之间没有东西连着。
    // 等宽的一条细线读作铁丝，有收梢的才读作枝条。
    const src = fs.readFileSync(path.join(HERE, 'home-canopy-texture.js'), 'utf8');
    const m = src.match(/g\.lineWidth = spec\.leaf \* \(([\d.]+) - ([\d.]+) \*/);
    expect(m, '枝条的线宽不是"基宽 - 收梢"的形状，说明没有收梢').toBeTruthy();
    expect(Number(m[1]), '枝根太细了，糊过之后就看不见了').toBeGreaterThan(0.12);
    expect(Number(m[2]), '收梢的量不能是 0，否则是一根等宽的铁丝').toBeGreaterThan(0.05);
  });

  it('sprigLeaves 交出枝走过的那条路径，节数对得上', () => {
    let s = 999;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const { path: walk, tip } = sprigLeaves(rnd, 10, 20, 0.7, 6);
    expect(walk[0]).toEqual([10, 20]);
    expect(walk.length, '起点 + 6 个节').toBe(7);
    expect(walk.at(-1)).toEqual([tip[0], tip[1]]);
  });
});

/**
 * 09-02 第三轮判词：「这种拟物化的语言不是当前主流的审美语言」。
 *
 * 拆下来最要害的一条不是"拟物过时了"（Apple 2025 年整套系统换成实时折射的
 * 玻璃材质，光学正当红），而是：**叶影铺满整个视口，没有边界。**
 * 没有边界的影子是纹理，有边界的影子才是物体。满屏半透明叶影正是素材站上
 * 最泛滥的那张模板贴图，而观众看不见我们的着色器，只看得见画面。
 *
 * Apple 自己的规范里有一条正对着这件事（HIG Materials，逐字）：
 *   "Don't use Liquid Glass in the content layer... can result in
 *    unnecessary complexity and a confusing visual hierarchy."
 *   "Use Liquid Glass effects sparingly... Limit these effects to the most
 *    important functional elements in your app."
 *
 * 下面几条钉的就是"光得有形状，而且这形状会走"。
 */
describe('光得有一块形状，而不是铺满整屏', () => {
  const src = () => code(GLSL);
  const drv = () => code(DRIVER);

  it('⭐⭐⭐ 叶影乘了窗光遮罩 —— 没有遮罩就是一张铺满屏的贴图', () => {
    const line = src().split('\n').find((l) => /float\s+leaf\s*=/.test(l));
    expect(line, '找不到算 leaf 的那一行').toBeTruthy();
    expect(line, '⛔ leaf 没乘 win：叶影会铺满整个视口，没有边界').toMatch(/\bwin\b/);
    expect(src(), '没有 windowLight()：光没有形状').toMatch(/float\s+windowLight\s*\(/);
  });

  it('⭐⭐⭐ 光区外没有直射光 —— 这里最容易写反', () => {
    // ⛔ 踩过：light 写成 (1.0 - leaf) * ...，而 leaf 已经乘过 win，
    //   于是光区外 leaf=0、(1-leaf)=1，得到**全亮**，正好反了。
    //   要用**没乘过 win 的** shade，再单独乘一次 win。
    const line = src().split('\n').find((l) => /float\s+light\s*=/.test(l));
    expect(line, '找不到算 light 的那一行').toBeTruthy();
    expect(line, '⛔ 用了 (1.0 - leaf)：leaf 乘过 win 了，光区外会算成全亮')
      .not.toMatch(/1\.0\s*-\s*leaf\b/);
    expect(line, 'light 要用没乘过 win 的 shade').toMatch(/1\.0\s*-\s*shade\b/);
    expect(line, 'light 自己也要乘一次 win').toMatch(/\bwin\b/);
  });

  it('⭐⭐ 窗子钉在墙上不动，动的是光斑', () => {
    // ⛔ 踩过：锚点写成 sunFrom()（跟着太阳走），投影方向的位移正好把太阳的
    //   位移抵消，光斑一整天钉在屏幕中间 —— 太阳从 x=0.26 走到 0.83，
    //   光斑只在 0.45 到 0.54 之间晃。「光会走」一天都没发生。
    const block = drv().slice(drv().indexOf('const WIN = {'), drv().indexOf('const clamp01'));
    expect(block, 'WIN.at 该是一对写死的常数（墙上的位置）').toMatch(/at:\s*\[\s*[\d.]+\s*,\s*[\d.]+\s*\]/);
    // ⚠️ 从 'win: [' 那一处往后找终点。'winSoft' 在 draw() 里先出现过一次
    //   （gl.uniform1f(u.uWinSoft, s.winSoft)），直接 indexOf 会切出空串。
    const d = drv(); const i = d.indexOf('win: [');
    const win = d.slice(i, d.indexOf('winSoft', i));
    expect(win, '⛔ 光斑中心跟着 sun 走：那会把太阳自己的位移抵消掉').not.toMatch(/\bsun\b/);
    expect(win, '光斑中心要从 WIN.at 起算').toMatch(/WIN\.at/);
    expect(win, '光斑要顺着投影方向甩出去，这样它才会随太阳移动').toMatch(/cast\.[xy]/);
  });

  it('⭐ 太阳越低，光斑甩得越远、拉得越长、边越软', () => {
    const drvS = drv(); const i = drvS.indexOf('win: [');
    const win = drvS.slice(i, drvS.indexOf('...tintOf', i));
    // ⚠️ 别数总数。中心的 x 和 y 各用一次 cast.len，光斑半长那一处删掉之后
    //   还剩三处，凑得够阈值 —— 第一版正是这么放过去的。**三个量各自都要吃到。**
    const line = (k) => win.split('\n').find((l) => l.includes(k)) || '';
    // ⚠️ 别用 win.indexOf(']') 去切"中心"那两行：第一个 ] 是 WIN.at[0] 的。
    const centre = win.split('\n').filter((l) => l.includes('WIN.at['));
    expect(centre.length, '光斑中心该是 x / y 两行').toBe(2);
    for (const l of centre) expect(l, '甩多远要随太阳高度变').toMatch(/cast\.len/);
    expect(line('WIN.long'), '光斑的长短要随太阳高度变（太阳越低影子越长）').toMatch(/cast\.len/);
    expect(line('WIN.soft'), '边的软硬要随太阳高度变（太阳越低半影越宽）').toMatch(/cast\.len/);
  });
});

/**
 * 09-02 站主报的三条阴影缺陷里的第二条：「晚上切换到台灯，阴影没处理好」。
 * 病根是投射距离没封顶 —— 夜里 uThrow × far × 2.25 ≈ 0.50 uv（452 像素），
 * 而白天只有 89。采样点铺不满那么长，影子断成一条条硬边的条带。
 */
describe('影子的行进契约', () => {
  const march = () => {
    const src = code(GLSL);
    return src.slice(src.indexOf('float castShadow'), src.indexOf('vec4 lay('));
  };

  it('⭐⭐⭐ 投射距离要封顶，否则长影子会断成条带', () => {
    const fn = march();
    expect(fn, '没有给 uThrow × far 封顶').toMatch(/min\(\s*uThrow\s*\*\s*far\s*,/);
    // ⛔ 封了顶还拿原值去走，等于没封
    const loop = fn.slice(fn.indexOf('for (int i'));
    expect(loop, '⛔ 步长还在用没封顶的 uThrow * far').not.toMatch(/d\s*=\s*uThrow\s*\*\s*far/);
    expect(loop, 'reach 也要用封过顶的那个值，否则尾巴收在屏幕外').not.toMatch(/reach\s*=\s*[^;]*uThrow/);
  });

  it('⭐⭐⭐ 行进方向是**朝着光**走，不是顺着影子的去向走', () => {
    // ⛔ 09-01 起这个符号一直是反的：写成 +dir*d 等于顺着下游找遮挡物，
    //   影子会落在每张卡**朝光的那一面**。夜里灯在右上，影子就出现在右上。
    //   dir 是"影子落向哪儿"（跟 paper.js 那条 box-shadow 的 offset 同一个量），
    //   所以要找挡光的纸，必须往 -dir 走。
    const fn = march();
    const line = fn.split('\n').find((l) => /vec2\s+off\s*=/.test(l));
    expect(line, '找不到算行进偏移的那一行').toBeTruthy();
    expect(line, '⛔ off 顺着 +dir 走：影子会跑到卡片朝光的那一面').toMatch(/=\s*-\s*dir\s*\*/);
  });

  it('⭐⭐ 采样点数、横向居中的常数、除数三者要对得上', () => {
    // ⛔ 这是这类行进循环最经典的错：改了点数忘了改另外两个，
    //   影子会歪到一边（居中错）或者整体变浓变淡（除数错）。
    const fn = march();
    const n = Number((fn.match(/for \(int i = 0; i < (\d+); i\+\+\)/) || [])[1]);
    expect(n, '找不到采样点数').toBeGreaterThan(0);
    const centre = Number((fn.match(/float\(i\)\s*-\s*([\d.]+)/) || [])[1]);
    expect(centre, `${n} 个点的横向扇形该以 ${(n - 1) / 2} 为中心，现在是 ${centre}`).toBeCloseTo((n - 1) / 2, 2);
    const div = Number((fn.match(/acc\s*\/\s*([\d.]+)/) || [])[1]);
    expect(div, `${n} 个点攒出来的量要除以约 ${(n * 0.4).toFixed(1)}，现在除的是 ${div}`)
      .toBeGreaterThan(n * 0.3);
    expect(div).toBeLessThan(n * 0.5);
  });
});
