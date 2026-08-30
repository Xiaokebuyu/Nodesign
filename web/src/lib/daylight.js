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
 * ⛔ **方位角故意不绕过头顶。** 全站影子只有一个光向（右上打光 → 影子偏左下，
 * 见 PAPER_SHADOW），要是让太阳下午跑到左边，满屏的纸就会跟树影打架。所以
 * 变的是**高度**（光斑的长短软硬）不是**边**。这是设计约束赢过物理的一处，
 * 写在这别当 bug 修。
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
 * 光在画面里的位置，uv 坐标，y 向下。
 *
 * ⭐ 两个都在**右半边**：全站的影子只有一个光向（右上打光 → 影子偏左下），
 * 光源要是跑到左边，满屏的纸就会跟树影打架。daylight.test.js 钉住了这一条。
 * 台灯比太阳低一点、往里挪一点 —— 灯照的是你正在读的那张纸，不是天花板。
 */
export const SUN_FROM = [0.86, 0.02];
export const LAMP_AT = [0.72, 0.18];

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

  return { hour, alt, night, warm, phase: phaseOf(alt, night, u) };
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
