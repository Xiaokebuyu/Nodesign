/**
 * 工作台外壳的纯派生（2026-08-29，行数棘轮拆件）
 *
 * 这儿只装「从状态算出外壳要显示什么」的函数 —— 不持有 state、不发请求、
 * 不认识 React。ProjectWorkspace 那 2400 行里绝大多数是句柄和 effect，
 * 这类纯计算混在里面既占行数又不好单测。
 */

/**
 * 面包屑 = **当前目录一路拆到根**（2026-08-13）。
 *
 * 以前这里最多两级（项目名 / 任务名），因为那时只有"在项目区"和"聚焦某一块区"
 * 两种状态。现在文件夹可以套文件夹，进到第三层就得能一眼看出自己在哪、
 * 还能点回去任意一级。
 *
 * 项目名那一级 = 根目录。点它回根，跟点 logo 回首页不是一回事。
 * 最后一级是"你现在在这儿"，不给 onClick —— 触屏那条常驻窄条拿**倒数第二级**
 * 当「上一层」，所以这里少给一个 onClick 就等于那颗 ‹ 会灰掉，别顺手补全。
 *
 * @param {string} name        项目名
 * @param {object|null} boardUi 画布上报的 { cwd, crumbs:[{id,title}] }
 * @param {(id:string)=>void} goTo 换层（'' = 回根）
 */
export function buildBreadcrumb(name, boardUi, goTo) {
  return [
    {
      label: name,
      title: '回到桌面根',
      ...(boardUi?.cwd ? { onClick: () => goTo('') } : {}),
    },
    ...((boardUi?.crumbs || []).map((c, i, all) => ({
      label: c.title,
      ...(i < all.length - 1 ? { onClick: () => goTo(c.id) } : {}),
    }))),
  ];
}
