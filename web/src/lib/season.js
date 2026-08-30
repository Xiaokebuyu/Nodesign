/**
 * 季节皮肤（2026-08-29）—— 站点跟着一年走一圈。
 *
 * ## 为什么是「光」不是「色」
 *
 * 全站盘点下来，329 个色值里 81% 的用量挤在 25°–60° 一格，也就是暖橙到黄褐 ——
 * **那正是秋天的色相**。所以这件事的真实含义不是给站点做四套皮，而是把一个
 * 常年秋天的站点变成会走一圈的站点。
 *
 * 一年四季纸差不多，差的是**打在纸上的光**：什么颜色、多硬、从哪边来。所以
 * 季节层动的是板面那几道光斑和暗斑，加上纸自己的一点色温；墨、铅笔、红笔、
 * 图钉和长尾夹一律不动 —— 那些是身份和物件，不是天气。
 *
 * ## 四个空位，没做的那一格保持现状
 *
 * `SKINS` 里 `null` = 这一季还没做。当天落到一个没做的季节时，整套值回到
 * `null` 之外的基线（也就是 paper.js 里那份原值），站点**什么都不会变**。
 * 这是用户拍的板：「如果在下个季节到来前我还没有做出冬季皮肤的话，就不动」。
 * 所以「不动」是默认行为，不需要额外的开关，也不会露出半成品。
 *
 * ## 为什么在模块加载时定，而不是运行时切
 *
 * 季节的粒度是天，页面活不了那么久。加载时算一次、值直接烤进 PAPER，
 * 于是所有既有的 `${PAPER.x}` / `P('x', a)` 插值点自动跟着走，一行调用代码
 * 都不用改。要做运行时切换才需要 CSS 变量那条路，现在不需要。
 */

/** 北半球的四季分界（月份，1-12）。用户在中国，不做南半球判断。 */
export const SEASON_OF_MONTH = [
  'winter', 'winter',                       // 1  2
  'spring', 'spring', 'spring',             // 3  4  5
  'summer', 'summer', 'summer',             // 6  7  8
  'autumn', 'autumn', 'autumn',             // 9  10 11
  'winter',                                 // 12
];

/** 今天属于哪一季 */
export function seasonOf(date = new Date()) {
  return SEASON_OF_MONTH[date.getMonth()];
}

/**
 * 每一季覆盖哪些 token。**只列会变的**，没列到的一律用 paper.js 的基线值。
 *
 * ⚠️ 幅度的判据：并排放在一起能看出「这纸不太一样」，单独看仍然是**纸**。
 * 一旦一眼读成「这是绿纸/蓝纸」就过头了 —— 那不是换季是换材料。
 * 光那几档可以放开一点（光本来就有颜色），纸身自己的偏移最小。
 */
export const SKINS = {
  /** 春：光是新的、偏青，纸把黄压掉一点 */
  spring: null,

  /**
   * 夏：光最白最硬，纸退掉一点黄显得清爽。
   * 暗斑也跟着偏冷 —— 夏天的阴影是蓝的，不是褐的。
   */
  summer: {
    wall:     '#EFEDE3',
    paper:    '#FFFEF9',
    shot:     '#EDEBE2',
    chrome:   '#FAF9F0',
    ruled:    '#FAF8EA',
    stack:    '#F6F5EA',
    aged:     '#F8F5E2',
    lit:      '#FFFBEF',
    litSoft:  '#FCFAEC',
    litWarm:  '#FFE3B4',
    litSlant: '#FBF8E4',
    litCool:  '#FFFEFA',
    dusk:     '#6F6A4E',
    dusk2:    '#4A4735',
    hole:     '#42402C',
  },

  /**
   * 秋：站点的原生季节。基线本来就是秋，这一档只是把它说得更明确一点 ——
   * 光更金、暗斑更褐，纸多一点点旧。
   */
  autumn: {
    wall:     '#F0E8D3',
    paper:    '#FFFDF2',
    shot:     '#EFE8DA',
    chrome:   '#FBF5E6',
    ruled:    '#FBF2DC',
    stack:    '#F8F1E0',
    aged:     '#FAF0D5',
    lit:      '#FFF3D4',
    litSoft:  '#FFF1CE',
    litWarm:  '#FFC97A',
    litSlant: '#FFF0C8',
    litCool:  '#FFFAE8',
    dusk:     '#7C5A2E',
    dusk2:    '#523A20',
    hole:     '#4A3318',
  },

  /** 冬：光短而冷，纸偏灰 */
  winter: null,
};

/** 这一季有没有做出来（没做 = 用基线，站点不变） */
export function hasSkin(season) {
  return !!SKINS[season];
}

/**
 * 当前该用的那份覆盖。没做的季节返回空对象 —— 调用方 spread 上去等于没动。
 * @param {Date} [date] 用于测试注入
 */
export function currentSkin(date) {
  return SKINS[seasonOf(date)] || {};
}
