/**
 * 一天的光（2026-08-30）—— 季节的另一根轴。
 *
 * `season.js` 回答的是「这个月的光是什么颜色」，粒度是天，加载时定一次就够。
 * 这里回答的是「现在几点，太阳在哪」，粒度是分钟，而且**页面活得比它久** ——
 * 一个开着的首页跨得过黄昏。所以这一层不烤进 PAPER，它是给光源层实时读的一份
 * 状态：太阳高度、暖度、夜的程度。
 *
 * ## ⭐ 为什么白天黑夜不是换一套色板
 *
 * 全站是纸和板。纸在夜里不会变成另一种纸 —— 变的是照在它上面的光少了。所以
 * 「夜晚模式」在这套语言里的正确实现是**把光收走**（光源层压一层暗、只在灯下
 * 留一汪），不是把 token 换成深色。
 *
 * 这条选择顺带绕开了两个真问题：
 *   1. 全站色值是在模块加载时插进 CSS 字符串的（见 paper.js 的 P()），换 token
 *      需要整套改成 CSS 变量才能运行时切；压一层光不用动任何既有代码。
 *   2. 板上的字是铅笔色（sketch），纸上的字是墨（ink）。真把板子刷黑，铅笔就得
 *      反过来变浅，而墨不能动 —— 那是两套对比度要分别重算的活。
 *
 * ## 太阳的模型
 *
 * 不查经纬度也不算真实天文：站点不知道用户在哪，问位置为了画光斑也不合适。
 * 按季节给一组日出日落，正弦插一条高度曲线 —— 误差半小时，而这一层的输出是
 * 光斑的软硬和颜色，半小时看不出来。
 *
 * ## ⭐⭐ 2026-09-01：太阳开始走了，影子跟着它走
 *
 * 到这一天为止，方位角是**故意钉死**的：光永远从右上来，因为全站的影子
 * （PAPER_SHADOW）是在模块加载时烤进 CSS 字符串的一个固定偏移，太阳一旦跑到
 * 左边，满屏的纸就会跟树影打架。当时的结论是「表达时间靠高度不靠边」。
 *
 * **那条约束的前提是「影子不会动」，现在这个前提没了。** 影子改成由这一层驱动的
 * 运行时变量（见 paper.js 的 PAPER_SHADOW 和下面的 castAt），于是太阳可以真的从
 * 东边升起、从西边落下，纸上的影子跟着一起转 —— 两者不再打架，而是同一个光源的
 * 两个后果。
 *
 * 屏幕上的东西南北：**左边是东**（日出），右边是西（日落），正午在正上方。
 * 这样站点原来那副样子（光从右上、影子偏左下）正好落在**下午**那一档 ——
 * 一个常年秋天的下午，本来就是它的样子。
 *
 * ⛔ 唯一还钉着的一条：**光永远在纸的上方**（影子的 y 恒为正）。太阳不会低到
 * 让影子朝上，台灯也吊在桌面之上。这条一破，纸就不是摊在桌上而是立起来了。
 */
import { seasonOf } from './season.js';

/** 三档模式。auto = 跟真实时间走 */
export const DAY_MODES = ['auto', 'day', 'night'];
export const DAY_MODE_KEY = 'nd:daylight';

/**
 * 每季的日出 / 日落（本地时，小时小数）。北半球中纬度的粗略值，
 * 跟 season.js 一样不做南半球判断。
 */
export const SUN_HOURS = {
  spring: [6.2, 18.6],
  summer: [5.2, 19.4],
  autumn: [6.4, 18.0],
  winter: [7.2, 17.3],
};

/** 夜色：冷、深、带一点蓝 —— 屋里没开大灯时墙的颜色 */
export const NIGHT_INK = '#101528';
/** 台灯：暖，比任何一季的日光都黄 */
export const LAMP = '#FFD59A';
/**
 * 光在画面里的位置，uv 坐标，y 向下（0 = 屏幕顶上）。
 *
 * SUN_FROM 现在只是**兜底**：真正的位置由 sunFrom() 按钟点和季节算（见下面那条弧）。
 * 它留着是因为拿不到光的时候得有个说得过去的默认值，而这个值正是站点原来的样子，
 * 一个秋天的下午。
 *
 * 台灯不动：它就钉在桌上那个位置，比太阳低一点、往里挪一点 —— 灯照的是你正在读
 * 的那张纸，不是天花板。
 */
export const SUN_FROM = [0.78, 0.14];
export const LAMP_AT = [0.72, 0.18];

/**
 * 太阳在天上走的那条弧，一季一档。
 *
 *   peak  正午时它在屏幕上的高度（y，越小越高）
 *   swing 一天里横向走多远：x 从 0.5-swing（日出，东）到 0.5+swing（日落，西）
 *   gain  这一季的光有多强（正午的满值）
 *
 * ⭐ 三个数一起决定「这是哪一季的光」，而且互相是一致的：夏天的太阳升得高、从很
 * 偏的东边升到很偏的西边、光最硬；冬天的太阳一整天都低，横着划过去一小段，光也弱。
 * 所以冬天的影子一整天都是长的 —— 这件事不用另写一条规则，它是 peak 和 swing 的
 * 自然后果。
 *
 * ⚠️ swing 的归一化基准是**全年最宽的那一档**（NOON_SWING，也就是夏天），不是
 * 每一季自己的 swing。拿自己的当基准的话，冬天那条窄弧会被拉成跟夏天一样宽，
 * 影子照样甩到 ±40 度 —— 那就把「冬天的太阳不往两边跑」这件事抹掉了。
 */
export const SUN_ARC = {
  spring: { peak: 0.05, swing: 0.37, gain: 0.94 },
  summer: { peak: 0.00, swing: 0.43, gain: 1.00 },
  autumn: { peak: 0.09, swing: 0.33, gain: 0.88 },
  winter: { peak: 0.19, swing: 0.23, gain: 0.74 },
};

/** 归一化基准：全年最宽的那条弧 */
const NOON_SWING = 0.43;
/**
 * 光强的基准：**秋天的正午**。
 * 站点常年是秋天（见 season.js 那份盘点），所以拿秋天的正午当 1.0，
 * 别的时刻和季节都是相对它的倍数 —— 这样「今天中午的首页」跟从前一模一样，
 * 变的是它前后那些钟点。
 */
export const GAIN_REF = 0.88;
/** 贴着地平线时光源在屏上的高度。不是 1.0 —— 站点没画地平线，这是一片光的中心 */
const HORIZON_Y = 0.30;
/**
 * 影子最多偏离竖直方向多少（横竖之比，1.34 约等于 53 度）。
 *
 * ⭐⭐ 09-01 当天从 0.84（40 度）提到 1.34。第一版的幅度是**锚在原来那六条烤死
 * 的偏移上**的，只做旋转和缩放，而那些影子本身只有 1 到 14 像素、透明度 0.09
 * 到 0.22。量出来的后果是：同一帧里只换影子，**差超过 8 个灰阶的像素只占 0.06%，
 * 最大差 16 灰阶** —— 用户的原话是「感觉视觉表现没什么变化」，而他是对的。
 *
 * ⭐ 教训写在这：**「方向在转」这件事本身不产生观感，产生观感的是位移的绝对像素数。**
 * 一条 3 像素的影子转 30 度只挪了 1.5 像素，谁都看不见。做这类联动的时候，
 * 判据不能是「值确实变了」，得是「变了多少个肉眼看得出的像素」。
 */
const MAX_TILT = 1.34;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** 一天里的第几个小时（带小数） */
export function hourOf(date) {
  return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
}

/**
 * 太阳此刻的状态。
 *
 * @returns {{hour:number, alt:number, night:number, warm:number, phase:string}}
 *   alt   太阳高度 −1…1（正午 1，日出日落 0，深夜负）
 *   night 夜的程度 0…1（民用暮光那段是小数，光源层拿它做插值）
 *   warm  光的暖度 0…1（正午最白，贴地平线最橙）
 */
export function sunAt(date = new Date(), season = seasonOf(date)) {
  const [rise, set] = SUN_HOURS[season] || SUN_HOURS.autumn;
  const hour = hourOf(date);
  // u = 白天走完的比例，正弦的一个半周就是一天：u∈[0,1] 是白天，负半周是夜。
  //
  // ⚠️ 夹在 [-0.6, 1.6] 是道**保险**，不是当前需要的修正：按现在这张
  // SUN_HOURS，一天 24 小时里 u 最远只走到 1.52，还在负半周里。但白天要是
  // 被改短（比如某季填成 7 小时），u 会越过 2，sin 绕回正数 —— **半夜忽然
  // 天亮**，而且不报错。daylight.test.js 里那条逐分钟扫描守的就是这个。
  const u = clamp((hour - rise) / (set - rise), -0.6, 1.6);
  const alt = Math.sin(Math.PI * u);

  // 暮光窗口：alt 0.10 以上是白天，−0.18 以下是全黑，中间那 40 分钟是过渡。
  const night = clamp((0.10 - alt) / 0.28, 0, 1);
  // 太阳越低光越暖。1.6 这个系数让「金色时刻」落在日落前一小时左右。
  const warm = clamp(1 - alt * 1.6, 0, 1);

  const arc = SUN_ARC[season] || SUN_ARC.autumn;
  // 这一季的光有多强。**不归零** —— 贴着地平线的时候光是弱的，不是没有。
  const gain = arc.gain * (0.55 + 0.45 * clamp(alt, 0, 1));

  // ⭐⭐ alt 是「走到白天的哪一段」，每一季的正午都是 1.0。**它不是太阳有多高。**
  // 冬天的正午太阳也在南边低低地挂着，影子一整天都是长的 —— 那件事写在 peak 里
  // （正午时它在屏上的高度），所以真正该拿去算影子的是这个折算过的高度：
  //
  //   elev = alt × (1 - peak / 地平线高度)
  //
  // 夏天 peak=0 → elev 就是 alt（正午真到头顶）；冬天 peak=0.19 → 正午也只有 0.37。
  // ⛔ 别拿 alt 去算影子长度，那样四季的正午会长得一模一样。
  const elev = clamp(alt, 0, 1) * (1 - arc.peak / HORIZON_Y);

  return { hour, u, alt, elev, night, warm, gain, phase: phaseOf(alt, night, u) };
}

/**
 * 太阳此刻在屏幕上的位置（uv，y 向下）。
 *
 * 左边是东，右边是西，正午在正上方 —— 一天里它真的从这头走到那头。
 *
 * ⚠️ u 夹在 [0,1]：天黑之后太阳停在日落那个点上，天亮之前停在日出那个点上。
 * 让它继续往外走的话，天没亮的时候光源会跑到屏幕外面去，而黎明前那一点点微光
 * 本来就该在东边。夜里这个位置会被光源层按 night 揉向台灯，所以停在哪儿只影响
 * 暮光那半小时。
 */
export function sunFrom(light) {
  const arc = SUN_ARC[light.season] || SUN_ARC.autumn;
  const u = clamp(light.u == null ? 0.5 : light.u, 0, 1);
  const alt = clamp(light.alt, 0, 1);
  // ⭐⭐⭐ 太阳在**屏幕上**从右走到左，因为这张桌子**朝北**。
  //
  // 这一行编码的不是天文，是「桌子朝哪边」，而我们一直没定过。太阳的高度、
  // 影子的长短虚实、光的暖度全是 sunAt() 真算出来的（而且分季节，冬天正午的
  // elev 只有 0.37，影子一整天都长）；只有**横向扫过屏幕的方向**是个选择：
  //
  //   桌子朝南坐（太阳在你面前）  太阳左→右，影子右→左
  //   桌子朝北坐（太阳在你身后）  太阳右→左，影子左→右   ← 现在这个
  //
  // 09-02 站主拍板走朝北这一档：东（日出）在你的右手边，所以早上的影子朝左，
  // 傍晚朝右。朝北也是摆桌子的常见建议，屏幕不迎着窗就不晃眼。
  //
  // ⚠️ 南北半球是**同一个旋钮**：南半球太阳在北天，同一张桌子的扫向正好反过来，
  //    要做的话就是在这一项上再乘一个 ±1，不要另起一套。
  return [
    0.5 + arc.swing * (1 - 2 * u),
    HORIZON_Y + (arc.peak - HORIZON_Y) * alt,
  ];
}

/** 台灯那一档影子的样子。灯不动，所以这三个数是常量。 */
const LAMP_CAST = { len: 2.60, blur: 2.17, alpha: 1.05, cool: 0.55 };

/**
 * ⭐⭐ 影子。这一层输出的是**几何**，不是色值：方向、多长、多虚、多浓。
 * 真正拼成一条 box-shadow 是 paper.js 的活（颜色归材质管）。
 *
 * 返回的 (x, y) 是**单位向量**，长短全交给 len 一个数 —— 两者混在一起的话，
 * 「太阳偏了多少」和「影子有多长」就再也分不开调了。
 *
 * 四件事一起动，它们在真实世界里本来就是连着的：
 *
 *   方向  背着太阳。太阳在右上 → 影子偏左下；早上太阳在左 → 影子偏右下
 *   长度  太阳越低影子越长（正午 0.70 倍，贴地平线 1.85 倍）
 *   虚实  越长越虚。低角度的光要穿过更厚的大气，半影本来就宽
 *   浓淡  正午最实，斜阳最淡 —— 长而虚的影子同时也是浅的
 *
 * ⭐ 夜里整组换成台灯：方向从灯口指向桌面中央，比日光更长更虚，而且**偏冷**
 * （cool）。屋里只剩一盏暖灯的时候，影子里没有第二个光源去把它填亮，
 * 所以它是这一天里最深最冷的一档影子。
 */
export function castAt(light) {
  const arc = SUN_ARC[light.season] || SUN_ARC.autumn;
  // ⛔ 用 elev 不是 alt：alt 每一季的正午都是 1.0，拿它算的话冬天正午的影子会跟
  // 夏天正午一样短。见 sunAt 里 elev 那段。
  const alt = clamp(light.elev == null ? light.alt : light.elev, 0, 1);
  const low = 1 - alt;
  const [sx] = sunFrom(light);

  // 白天：横向分量按太阳偏离正上方多少给。归一化基准是全年最宽的那条弧，
  // 所以冬天甩不到夏天那个角度（见 SUN_ARC 的 ⚠️）。
  // ⭐⭐ 09-01 第二刀：**把曲线拉陡，不是整条乘一个数。**
  //
  // 用户对着傍晚那一格挑了「长度 ×2」。整条 ×2 确实给出他挑的那个傍晚，但顺手
  // 也把正午翻了一倍（秋天正午 1.00 → 1.85），而正午是站点每天大部分时间的样子，
  // 他没看过那一格。所以改成底不动、只把低角度那一头拉开：
  //
  //        从前   整条×2   现在
  //   夏正午 1.00   1.40    0.85
  //   秋正午 1.00   1.85    1.10   ← 跟今天线上几乎一样
  //   秋三点 1.00   2.28    1.58
  //   冬正午 1.00   2.63    2.12
  //   五点半 1.00   3.40    3.63   ← 他挑的那一格，给到了
  //
  // ⭐ 判据是「他挑的那个钟点要到位」，不是「照他说的倍数乘一遍」。
  //   浓淡仍然不动 —— 加深会改掉全站质感，而这一刀要解决的是看不出方向在转。
  const day = {
    tilt: -((sx - 0.5) / NOON_SWING) * MAX_TILT,
    len: 0.85 + 3.50 * low ** 2.2,
    blur: 0.90 + 1.90 * low ** 1.7,
    alpha: (0.70 + 0.44 * alt) * (0.80 + 0.20 * arc.gain),
  };
  // 夜里：光源换成钉死的那盏灯，方向 = 灯口指向桌面中央
  const lampTilt = (0.5 - LAMP_AT[0]) / (0.5 - LAMP_AT[1]);

  const t = clamp(light.night, 0, 1);
  const mix = (a, b) => a + (b - a) * t;
  const tilt = mix(day.tilt, lampTilt);
  // 单位化：len 是唯一管长短的旋钮
  const k = 1 / Math.hypot(tilt, 1);
  return {
    x: tilt * k,
    y: k,
    len: mix(day.len, LAMP_CAST.len),
    blur: mix(day.blur, LAMP_CAST.blur),
    alpha: mix(day.alpha, LAMP_CAST.alpha),
    cool: t * LAMP_CAST.cool,
  };
}

/** 给人看的名字（顶栏那枚按钮的提示语用） */
function phaseOf(alt, night, u) {
  if (night >= 0.98) return 'night';
  if (night > 0.02) return u < 0.5 ? 'dawn' : 'dusk';
  if (alt > 0.86) return 'noon';
  if (alt < 0.42) return u < 0.5 ? 'morning' : 'golden';
  return u < 0.5 ? 'morning' : 'afternoon';
}

/** 同一天的某个钟点。手动挡靠它假装现在是白天 / 夜里 */
function atHour(date, h) {
  const d = new Date(date.getTime());
  d.setHours(Math.floor(h), Math.round((h % 1) * 60), 0, 0);
  return d;
}

/**
 * 光源层真正要读的那份状态。手动挡把时间挪到一个有代表性的钟点，
 * 而不是另写一套常量 —— 手动的白天和真实的正午必须是同一个东西，
 * 不然「白天」看起来会跟中午不一样，那就是两套光了。
 */
export function lightAt(mode = 'auto', date = new Date()) {
  const season = seasonOf(date);
  const when = mode === 'day' ? atHour(date, 11.5)
    : mode === 'night' ? atHour(date, 22.5)
      : date;
  return { ...sunAt(when, season), mode, season };
}

/** 读存下来的模式。坏值一律当 auto —— 这是装饰层，不值得报错 */
export function readMode(store) {
  try {
    const v = (store || window.localStorage).getItem(DAY_MODE_KEY);
    return DAY_MODES.includes(v) ? v : 'auto';
  } catch {
    return 'auto';   // 隐私模式 / 禁用存储
  }
}

export function writeMode(mode, store) {
  try {
    (store || window.localStorage).setItem(DAY_MODE_KEY, mode);
  } catch { /* 存不下就只在这一页有效 */ }
}

/** 点一下换下一档 */
export function nextMode(mode) {
  return DAY_MODES[(DAY_MODES.indexOf(mode) + 1) % DAY_MODES.length];
}
