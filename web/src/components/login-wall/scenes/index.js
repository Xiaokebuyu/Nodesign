import coffee from './coffee.jsx';
import tibet from './tibet.jsx';
import engine from './engine.jsx';

/**
 * 登录页轮着播的三套（2026-09-12 印刷风改版，站主：一套循环太单调，再配两套；
 * 后两套又按站主意思换成官网案例页里的真实项目）。
 *
 * 顺序就是播放顺序。**每一套都得自成一个能读通的叙事**：①到⑥一条红线讲一件作品从一句话到上线。
 * 三套分别是：新品发布（站点 + 演示稿）/ 深入第三极（演示改成手册站）/ 喷气发动机实验台（3D 教具）。
 * 每套固定六步（STEPS），轮播的定时器按它算进出场要多久。节奏是全局的，在 wall-css.js 的 MOTION。
 */
export const SCENES = [coffee, tibet, engine];
