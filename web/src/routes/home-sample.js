import { useEffect, useRef } from 'react';
import { Onboarding } from '../lib/api.js';

/**
 * 首页这一侧的「新手示例项目」（2026-09-12）。
 *
 * 服务端那半在 server/onboarding/seed.js：第一次进来、而且一个项目都没有的人，
 * 领到一份做好的雾岭咖啡（画布 / 站点 / 演示稿 / 品牌手册 / 产品图都在里面）。
 * 判断和幂等全在服务端，这里只负责问一次、领到了把列表刷一遍。
 *
 * 从 Home.jsx 拆出来是因为行数棘轮（Home 冻结在 600 行）—— 规矩是胖了就拆，别抬上限。
 */

/**
 * 「我的项目」不算系统送的那份。
 *
 * ⛔ 首页凡是判断「这个人还没动手」的地方都要用它，别用 `projects.length`：
 * 空状态那张大卡和「找找灵感」是给还没动手的人看的，示例一进来就把两样都顶掉，
 * 新人反而比改之前少看见东西（判据在 home-newbie.lint.test.js）。
 */
export function ownProjects(projects) {
  return projects.filter((p) => !p.isSample);
}

/**
 * 列表拿到了、而且是空的 → 问服务端要一份示例；领到了就重新拉列表。
 * 领不到就当没这回事：首页不该因为送东西失败而出错。
 * @param {{hydrated:boolean, count:number, reload:() => Promise<any>}} o
 */
export function useSampleClaim({ hydrated, count, reload }) {
  const asked = useRef(false);
  useEffect(() => {
    if (!hydrated || asked.current || count > 0) return;
    asked.current = true;
    Onboarding.claimSample()
      .then((r) => { if (r?.seeded) reload()?.catch?.(() => {}); })
      .catch(() => { /* 静默 */ });
  }, [hydrated, count, reload]);
}
