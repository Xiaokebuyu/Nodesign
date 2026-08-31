/**
 * 文档永不滚动 + 滚动链截断（2026-08-31 移动端第三轮 · 第二刀）
 *
 * 用户报：手机上在画布工作区打开对话、拖消息列表，**包括顶栏在内的整个界面
 * 一起脱离视窗**。
 *
 * ## 机制：scroll chaining（滚动链）
 *
 * 一个内层滚动容器滚到尽头之后，浏览器默认把剩下的滚动量继续交给它的祖先，
 * 一路交到文档。文档这一层在真机上表现为 iOS Safari 的橡皮筋回弹、
 * Android Chrome 的下拉刷新，两者都会把整页连同顶栏一起平移出视口。
 *
 * 对照组实测（chain.html，同一个手势、同一个容器结构）：
 *
 *     overscroll-behavior: auto（默认）  → 文档被滚了 250px，整页跟着走
 *     overscroll-behavior: contain       → 文档 0px，一动不动
 *
 * 修前全站实测 22 个组合（7 条路由 × 3 种视口 + 登录墙）：**41 个内联滚动容器
 * 全是 auto，html/body 也是 auto** —— 链从头到尾没有一处闸。
 *
 * ## 兜底的闸只装一处：文档那一层
 *
 * ⛔ 不许改成给**每个**滚动容器挨个加 `overscroll-behavior: contain`：
 *   ① 仓里 41 处内联 `overflow: auto`，挨个加必漏，漏掉哪个哪个就是复发点；
 *   ② 消息里的代码块滚到底时**本来就该**把滚动交给消息列表继续，一刀切
 *      contain 等于把那个正确行为一起掐掉。
 * 兜底装在文档这一层，不管哪个容器把链传过来都拦得住，而且只有一处要维护。
 *
 * 另外**点名**两个容器写 contain（见下面「回弹留在容器里」）：那不是兜底，
 * 是用户要的「橡皮筋只存在于我们的容器内」—— 兜底管的是"别弹错地方"，
 * 这两条管的是"该弹的地方要弹"。两者不冲突，层次不同。
 *
 * ## 连带钉住的：所有外壳用 dvh 不用 vh
 *
 * `100vh` 取的是**地址栏收起时**那个最大高度。手机上地址栏展开时它比看得见的
 * 部分高 60-90px，底部那一截落在屏幕外。以前还能靠"滑一下让地址栏收起来"凑合，
 * 上了 `overflow: hidden` 之后就是**永远看不到**。两条必须一起成立。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
/** 判据读的必须是真生效的声明，不是解释它的文字 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

describe('文档自己永不滚动', () => {
  const css = strip(read('styles/globals.css'));
  const rule = /html,\s*body\s*\{([^}]*)\}/g;
  const bodies = [...css.matchAll(rule)].map(m => m[1]);

  it('globals.css 里有一条只管 html, body 的锁', () => {
    expect(bodies.length, '没找到 html, body 那条规则').toBeGreaterThan(0);
  });

  it('⛔ overflow: hidden —— 文档结构上就没有可滚的量', () => {
    expect(bodies.some(b => /overflow:\s*hidden/.test(b))).toBe(true);
  });

  it('⛔ overscroll-behavior: none —— 关掉下拉刷新和橡皮筋（滚动链的终点）', () => {
    expect(bodies.some(b => /overscroll-behavior:\s*none/.test(b))).toBe(true);
  });

  /**
   * 第二个触发点（同日，用户在首页找到的）：**点进便签本输入框、光标开始闪之后
   * 再拖那一栏，整页照样橡皮筋**。这不是滚动链 —— iOS Safari 在输入框拿到焦点后
   * 会为了「让光标露出来」直接挪文档和视口的相对位置，`overflow: hidden` 绕得过去。
   * 唯一可靠的治法是让 body 自己钉在视口上：Safari 挪不动一个 position: fixed 的 body。
   */
  it('⛔ body 自己 position: fixed 四边贴死 —— overflow:hidden 拦不住 iOS 的光标滚动', () => {
    const only = [...css.matchAll(/(?:^|\})\s*body\s*\{([^}]*)\}/g)].map(m => m[1]);
    expect(only.some(b => /position:\s*fixed/.test(b)), 'body 没有 position: fixed').toBe(true);
    const fixedRule = only.find(b => /position:\s*fixed/.test(b));
    for (const side of ['top', 'left', 'right', 'bottom']) {
      expect(fixedRule, `四边要贴死，缺 ${side}`).toMatch(new RegExp(`${side}:\\s*0`));
    }
  });
});

/**
 * 用户要的是「橡皮筋只存在于我们的页面容器内」。所以外层是 none（文档一下都不许弹），
 * 而**真正在滚的那两个容器**是 contain —— contain 只截断往外传的链，容器自己那下
 * 回弹留着。写成 none 会把回弹一起掐掉，那是另一种难看。
 */
describe('回弹留在容器里', () => {
  it('页面主滚动容器（顶栏下面那个）是 contain', () => {
    const src = strip(read('components/layout/AppShell.jsx'));
    expect(src).toMatch(/overflow: 'auto', overscrollBehavior: 'contain'/);
  });

  it('首页便签本的输入框是 contain（用户报的第二个触发点就在它身上）', () => {
    const css2 = strip(read('routes/home-styles.js'));
    const rule = /\.ndd-pad textarea\s*\{([\s\S]*?)\}/.exec(css2)?.[1];
    expect(rule, '找不到 .ndd-pad textarea 规则').toBeTruthy();
    expect(rule).toMatch(/overscroll-behavior:\s*contain/);
  });
});

/**
 * 撑满一屏的高度：dvh 优先 + vh 兜底，而且**只能写在 CSS 里**。
 *
 * `100vh` 取的是地址栏收起时那个最大高度，手机上比看得见的高 60-90px，底部那截
 * 会被 body 的 overflow:hidden 永久裁掉 —— 所以正常情况要走 dvh。
 * 但 dvh 要 Chrome 108 / Safari 15.4 以上，**不认识它的浏览器会把整条声明丢掉**，
 * 高度当场变成 auto，而 body 是 fixed + overflow:hidden，塌掉的外壳就是一张白页。
 * 兜底靠"同一个属性写两遍"，而内联样式压根写不出这个形状（对象的键唯一）。
 * 所以外壳高度一律 class，不许回到内联。
 */
describe('外壳撑满一屏：dvh 优先、vh 兜底', () => {
  const css = strip(read('styles/globals.css'));

  it('.nd-shell 里 vh 和 dvh 两条都在，且 dvh 在后面（后面那条才盖得住前面）', () => {
    const rule = /\.nd-shell\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(rule, '找不到 .nd-shell').toBeTruthy();
    const iVh = rule.indexOf('100vh'), iDvh = rule.indexOf('100dvh');
    expect(iVh, '缺 vh 兜底').toBeGreaterThan(-1);
    expect(iDvh, '缺 dvh').toBeGreaterThan(-1);
    expect(iDvh, 'dvh 必须写在 vh 后面，不然反过来被兜底盖掉').toBeGreaterThan(iVh);
  });

  it('弹窗的高度上限同样两条都在', () => {
    const rule = /\.nd-vh-cap\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(rule, '找不到 .nd-vh-cap').toBeTruthy();
    expect(rule.indexOf('100dvh')).toBeGreaterThan(rule.indexOf('100vh'));
  });

  /** 撑满一屏的那几层。⚠️ 加新外壳要往这儿补一行 */
  const SHELLS = ['components/layout/AppShell.jsx', 'components/AuthGate.jsx', 'components/ui/Modal.jsx'];

  it('⛔ 这几个文件里不许再内联写高度（内联压不出兜底那个形状）', () => {
    for (const f of SHELLS) {
      const src = strip(read(f));
      expect(src, `${f} 内联写了 100vh / 100dvh —— 搬去 .nd-shell / .nd-vh-cap`)
        .not.toMatch(/(?:height|maxHeight|minHeight):\s*'[^']*\b100d?vh\b/);
    }
  });

  it('AppShell 三条路（普通页 / 触屏工作台 / 桌面工作台）都挂着 .nd-shell 且自己不滚', () => {
    const src = strip(read('components/layout/AppShell.jsx'));
    expect((src.match(/className="nd-shell"/g) || []).length, '三条 return 各一条').toBe(3);
    expect(src).toMatch(/className="nd-shell"[\s\S]{0,140}<TopBar[\s\S]{0,240}overflow: 'auto'/);
  });
});
