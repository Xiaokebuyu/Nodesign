/**
 * markdown-math —— 全站 markdown 的公式支持（2026-08-15）
 *
 * 一处定义、四处用（聊天正文、舞台卡的子代理结果、.md 阅读器、方案评审卡）：
 * `<ReactMarkdown {...MATH_PLUGINS}>{normalizeMath(text)}</ReactMarkdown>`。
 * katex 的 CSS 和字体在这儿 import，打进包不吃 CDN；字体是按需加载的，
 * 没公式的页面不会去取。
 *
 * ⭐ 美元符号的取舍（这个产品满屏都是「$0.75 / $3.75 每百万」这种价钱，
 *    而模型答数学时又满屏 `$r(AB)\le r(A)$` 这种单美元行内公式）：
 *   - 单美元**开**（2026-08-18；08-15 曾整个关掉，代价是数学消息里行内公式
 *     全部露源码 —— 用户实报）。价钱靠**预转义**保护：长得像钱的 `$`（紧跟
 *     数字、且数字串之后不是数学续写）先换成 `\$`，剩下的 `$…$` 才交给
 *     remark-math。`$15$` 这种刻意写的纯数字公式照常放行（判据看闭合 $）。
 *   - 模型常写的 `\( … \)` / `\[ … \]` 在进 markdown 前换成 `$$ … $$` —— 前者
 *     留在行内（math text），后者独占段落（math flow）。
 *   - 两步都只在**代码之外**做：围栏代码块和行内 code 里的 `\(`、`$` 是代码。
 */
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

/** 围栏代码块 / 行内 code：这些片段原样留着，别在里面动手 */
const CODE_SPANS = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g;

/**
 * 长得像钱的 `$`：`$3`、`$0.75`、`$1,200 每百万`。判据 = `$` 紧跟数字，且数字串
 * （含 `,` 千分位、`.` 小数）之后**不是**数学续写（`^ _ \ { } =` 或字母）也不是
 * 紧跟的闭合 `$`。命中就转义成 `\$`，这样它对 remark-math 隐形。
 * `$2^n$`（数字后是 ^）和 `$15$`（数字后是闭合 $）都不命中，照常当公式。
 */
// ⚠️ 续写禁集里必须含 `\d , .`：不含的话 `[\d,]*` 少吃一位就能让 `$15$` 的
// 「5」冒充续写字符绕过检查（回溯），钱形判定误伤刻意写的纯数字公式
const CURRENCY = /\$(?=\d[\d,]*(?:\.\d+)?(?![\d,.$^_\\{}=a-zA-Z]))/g;

/** `\( … \)` → 行内 `$$ … $$`；`\[ … \]` → 独占一段的 `$$ … $$`；钱形 `$` 转义 */
function convertDelimiters(seg) {
  return seg
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, body) => `\n\n$$\n${body.trim()}\n$$\n\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, body) => `$$${body.trim()}$$`)
    .replace(CURRENCY, '\\$');
}

/** 只在代码之外换公式写法（导出给测试钉住这条边界） */
export function normalizeMath(text) {
  const s = String(text ?? '');
  if (!s.includes('\\(') && !s.includes('\\[') && !s.includes('$')) return s;
  return s.split(CODE_SPANS).map((seg, i) => (i % 2 ? seg : convertDelimiters(seg))).join('');
}

/**
 * 直接摊给 ReactMarkdown 的插件对。
 * throwOnError:false —— 模型写错的公式显示成红字就够了，不该炸掉整条消息/整张卡。
 *
 * ## remark-gfm（2026-08-17 补）
 *
 * react-markdown 默认只认 **CommonMark**，而 CommonMark 里没有表格。用户报的
 * 「AI 侧边栏 markdown 显示不全，表格渲染不出来」就是这个 —— 表格源码原样躺在
 * 那儿。同一批缺的还有：删除线 `~~x~~`、任务列表 `- [ ]`、裸链接自动成链、
 * 脚注。模型写这几样是家常便饭，缺一样就是"它答对了但我看不懂"。
 *
 * ⚠️ **gfm 要排在 math 前面**。两个插件都要动 `~` 和 `$` 附近的文本：gfm 先把
 * 表格和删除线切成节点，math 再在剩下的文本里找公式；反过来的话表格分隔行里的
 * 内容有机会先被别的规则吃掉。顺序在这种插件链里是语义不是风格。
 */
export const MATH_PLUGINS = Object.freeze({
  // 单美元开着：钱已经在 normalizeMath 里预转义了（CURRENCY），这里放行的
  // 全是真公式。⚠️ 两处是一对 —— 谁绕过 normalizeMath 直接渲染，价钱就会被吃
  // cjk-friendly：CommonMark 的 flanking 规则把 他说**「你好」**然后 里的加粗当
  // 普通星号（闭合 ** 前是标点后是汉字 = 不算右翼）。板书/聊天里中文引号套加粗
  // 是家常便饭（08-25 信箱案），这个插件按 CJK 语境放宽判定。
  remarkPlugins: [remarkGfm, remarkCjkFriendly, [remarkMath, { singleDollarTextMath: true }]],
  rehypePlugins: [[rehypeKatex, { throwOnError: false, strict: 'ignore' }]],
});
