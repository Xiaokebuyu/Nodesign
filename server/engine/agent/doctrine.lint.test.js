/**
 * 教义对账（2026-09-01）——「说出去的话跟代码对不对得上」。
 *
 * ## 为什么要有这一条
 *
 * 这个仓库为**同一个病**翻过至少三次车，每次都是教义里留着一句已经不成立的话，
 * 而模型照着那句话做：
 *
 *   08-30  六处「写满自动翻页」全是假话（其中两处每回合进上下文，
 *          同一份 prelude 第 291 行说「不会有人替你翻页」、第 366 行说「自动翻页」）
 *   08-30  skill 教的 follow 顺序跟代码要求正好反着（全库 5 次、跨 4 个项目）
 *   09-01  prelude 改成了「缺省叠一页」，而 blackboard-rp 的 SKILL 还写着
 *          「竖直往下长」—— 真会话里 agent 第三发就传了 where:"next"，
 *          纸往下铺了 1032px（proj_mtiwlrtz 17:00:33）
 *
 * 三次的形状一模一样：**改了行为、漏了某一份教义**。而教义不会报错 —— 它只是让
 * 模型做出昂贵的决定。这道闸就是为它装的。
 *
 * ## 判据怎么写才不是同义反复
 *
 * ⛔ 不能只查「文件里有没有出现某个词」——那种断言改一个字就绕过去了。
 * 这里查的是**成对的东西**：退役的说法一处都不许有（黑名单），而现行的默认值
 * 必须在每一份会教落位的教义里都说到（白名单）。两边都写才拦得住「改了一处忘了另一处」。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRELUDE = path.join(HERE, 'prompts/nodesign-prelude.md');
const SKILLS = path.join(HERE, '../plugins/nodesign/skills');

/** 会教「东西落在哪」的那几份 —— 加新的落位教义时把文件加进来 */
function doctrineFiles() {
  const out = [PRELUDE];
  for (const d of fs.readdirSync(SKILLS, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = path.join(SKILLS, d.name, 'SKILL.md');
    if (fs.existsSync(f)) out.push(f);
  }
  return out;
}

/**
 * 退役的说法。每一条都配一句「它是什么时候、被什么替掉的」——
 * 将来谁想加回来，先得读懂那句话。
 */
/**
 * ⚠️ 判据要按**语义**判不按字面判 —— 第一版写成 `/写满.{0,6}自动翻页/`，当场把
 * 「纸写满**不会**自动翻页」这句**正确**的话判成了假话。正确的说法长得跟错误的
 * 只差一个「不」字，而这类教义里那个「不」正是全部意思所在。
 * ⭐ 是下面那条「判据本身没瞎」的自检把它逮出来的 —— 那条测试第一次跑就还了本。
 */
/**
 * ⭐⭐ 判据钉的是**具体那几句错话**，不是「某个语义类」。
 *
 * 第一版想聪明一点：查动词前面几个字有没有否定词。中文里这条走不通 ——
 *   「纸写满**不会**自动翻页」  正确，得放过
 *   「装**不**下就拒收」        错的，可「装不下」自带一个否定词
 * 同一个「不」在一处是语义、在另一处只是词的一部分，靠邻近判必然两头都错。
 * ⭐ 这两次都是下面那条「判据本身没瞎」的自检当场逮出来的，不是跑真数据发现的。
 *
 * 所以这里退回最笨也最准的形状：**把见过的错句子一句句列出来**。代价是新造的
 * 错话它抓不到 —— 那一半由下面「必须说到缺省是叠」的白名单顶着，两边合起来
 * 才拦得住「改了行为、漏了某一份教义」。
 */
const RETIRED = [
  /**
   * ⭐⭐ 2026-09-01 刀 2：这一条**翻了个面**。
   *
   * 08-29 到 09-01 之间，「写满自动翻页」是假话（机器绝不替 agent 翻页），所以
   * 它在黑名单上。刀 2 把版位撤了之后翻页不再毁掉任何东西 —— **现在自动翻页是
   * 真的**，反过来「纸满不会自动翻页」成了那句要抓的假话。
   *
   * ⚠️ 留着这段历史是有用的：下一个想改这条行为的人得先读懂它翻过两次。
   */
  ['纸满不会自动翻页', [/不会自动翻页/, /不替(你|它|她|agent)翻页/, /绝不替[^。\n]{0,6}翻页/, /(没|不会)有人替你翻页/],
    '09-01 刀 2 起纸满由机器翻到这一摞的下一页（版位撤了，新页不再"没有版面"）'],
  ['竖直往下长', [/竖直往下长/, /纸\s*=\s*用户一屏/],
    '09-01 起 open_sheet 缺省是叠在当前这一摞上，不是往下铺'],
  // 同理：「装不下**不再**拒收」是现在的正确说法，得放过
  ['装不下就拒收', [/装不下(?!.{0,4}不)[^。\n]{0,4}拒收/, /排不下(?!.{0,4}不)[^。\n]{0,4}拒收/],
    '08-31 刀 1 起装不下是照写并落暂存架，不再拒收'],
  /**
   * 版位（slot / plan / replan / for:"artifacts"）—— 09-01 刀 2 整族退役。
   * 这一条最容易漏：它散在四份教义里，而且长得像"正常的用法示例"。
   */
  ['纸内版位', [/open_sheet\{\s*plan/, /open_sheet\{[^}\n]*plan:/, /write_on_board\{\s*slot/,
    /op:\s*["']replan["']/, /for:\s*["']artifacts["']/, /先切版面/, /先规划整版/, /切成几块地/],
    '09-01 刀 2 起纸内不再有块，机器按栏排（站主：模型只输入内容，机械层自动排版切层）'],
];
const hits = (pats) => (line) => pats.some((re) => re.test(line));
/** 现行的默认值：教落位的那几份里，凡提到 open_sheet 的都必须说清缺省是叠 */
const MUST_SAY_STACK = /叠(在|一页|上去)|一摞|stack/;
/**
 * 教「怎么写、写到哪」的那几份（同时讲 write_on_board 和 open_sheet）**必须说到
 * 机器会自动翻页** —— 不说的话模型只会照旧手动开纸，那正是刀 2 要省掉的动作。
 */
const MUST_SAY_AUTOTURN = /自动翻(页|到下一页|下一页)|机器[^。\n]{0,8}翻页|turns the page/;

describe('教义对账：说出去的话跟代码对得上', () => {
  it('⛔ 退役的说法一处都不许留（它们不报错，只让模型做昂贵的决定）', () => {
    const bad = [];
    for (const f of doctrineFiles()) {
      const txt = fs.readFileSync(f, 'utf8');
      for (const [name, pats, why] of RETIRED) {
        const test = hits(pats);
        // 只查正文，不查明确在讲「这条已经作废」的历史说明（那些是有意留的课）
        // 明确在讲「这条已经作废」的历史说明是有意留的课，不算违规
        const lines = txt.split('\n').filter((l) => test(l) && !/⛔|已作废|不再|改成了?|起是|退役|撤掉/.test(l));
        for (const l of lines) bad.push(`${path.basename(path.dirname(f))}/${path.basename(f)}：「${name}」—— ${why}\n    ${l.trim().slice(0, 90)}`);
      }
    }
    expect(bad, `教义里留着已经不成立的话：\n${bad.join('\n')}`).toEqual([]);
  });

  it('⭐ 凡是教 open_sheet 的地方，都得说清缺省是「叠一页」', () => {
    const missing = [];
    for (const f of doctrineFiles()) {
      const txt = fs.readFileSync(f, 'utf8');
      if (!txt.includes('open_sheet')) continue;      // 不教这个的不管
      if (!MUST_SAY_STACK.test(txt)) missing.push(path.basename(path.dirname(f)));
    }
    expect(missing, `这几份教了 open_sheet 却没说缺省是叠：${missing.join('、')}`).toEqual([]);
  });

  it('⭐ 教「写在哪」的那几份都得说到机器会自动翻页', () => {
    const missing = [];
    for (const f of doctrineFiles()) {
      const txt = fs.readFileSync(f, 'utf8');
      // 判据收在「同时教 write_on_board 和 open_sheet」那几份上 —— 只提一句
      // open_sheet{near} 的（site-craft 那类）不该被这条拖下水
      if (!txt.includes('open_sheet') || !txt.includes('write_on_board')) continue;
      if (!MUST_SAY_AUTOTURN.test(txt)) missing.push(path.basename(path.dirname(f)));
    }
    expect(missing, `这几份教了怎么写却没说纸满会自动翻页：${missing.join('、')}`).toEqual([]);
  });

  /**
   * ⭐ 这条不是形式主义：第一版的正则把「纸写满**不会**自动翻页」判成了假话，
   * 就是被这几行逮住的。黑名单类的判据最容易写成「见字就叫」，而教义里正确与
   * 错误的说法常常只差一个否定词。
   */
  it('⭐ 判据本身没瞎：退役的说法抓得到，正确的说法不误伤', () => {
    const [noturn, down, refuse, slots] = RETIRED.map(([, pats]) => hits(pats));
    // ⭐⭐ 这一条 09-01 翻了面：现在要抓的是「不会自动翻页」，放过的是「会自动翻页」
    expect(noturn('纸写满不会自动翻页')).toBe(true);
    expect(noturn('机器绝不替你翻页')).toBe(true);
    expect(noturn('纸满时不会有人替你翻页')).toBe(true);
    expect(noturn('纸写满机器自动翻下一页'), '现在这才是真话，不许误伤').toBe(false);
    expect(down('竖直往下长（纸 = 用户一屏）')).toBe(true);
    expect(refuse('装不下就拒收，一个字不落盘')).toBe(true);
    expect(refuse('装不下不再拒收，改成溢出上架'), '正确的说法不许误伤').toBe(false);
    expect(refuse('装不下的内容照写，落暂存架等你安置'), '同上').toBe(false);
    // 版位那一族
    expect(slots('open_sheet{plan:[{slot:"main", w:600, h:800}]}')).toBe(true);
    expect(slots('write_on_board{ slot:"main", text:"…" }')).toBe(true);
    expect(slots('edit_board{ops:[{op:"replan", plan:[…]}]}')).toBe(true);
    expect(slots('切一块 for:"artifacts" 的地')).toBe(true);
    expect(slots('open_sheet{stack:"main", order:"asc"}'), '现行的用法不许误伤').toBe(false);
    expect(slots('write_on_board{ text:"…" }'), '同上').toBe(false);
    expect(slots('open_sheet{near:"assets/封面.png", w:480, h:600}'), '同上').toBe(false);
  });
});
