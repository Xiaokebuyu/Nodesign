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
  // ⚠️ 「会自动翻页」那条前面必须要求一个**非否定字**：正确的说法「不会自动翻页」
  // 跟错话只差这一个字，靠泛匹配必然误伤（这是这条 lint 第三次改写的原因）
  ['写满自动翻页', [/写满自动翻页/, /写满一张纸自动翻页/, /纸满自动翻页/, /[^不别绝没勿]会自动翻页/, /自动翻到下一页/],
    '08-29 刀 F 起纸满是拒收 / 08-31 起是溢出上架，机器绝不替 agent 翻页'],
  ['竖直往下长', [/竖直往下长/, /纸\s*=\s*用户一屏/],
    '09-01 起 open_sheet 缺省是叠在当前这一摞上，不是往下铺'],
  // 同理：「装不下**不再**拒收」是现在的正确说法，得放过
  ['装不下就拒收', [/装不下(?!.{0,4}不)[^。\n]{0,4}拒收/, /排不下(?!.{0,4}不)[^。\n]{0,4}拒收/],
    '08-31 刀 1 起装不下是照写并落暂存架，不再拒收'],
];
const hits = (pats) => (line) => pats.some((re) => re.test(line));
/** 现行的默认值：教落位的那几份里，凡提到 open_sheet 的都必须说清缺省是叠 */
const MUST_SAY_STACK = /叠(在|一页|上去)|一摞|stack/;

describe('教义对账：说出去的话跟代码对得上', () => {
  it('⛔ 退役的说法一处都不许留（它们不报错，只让模型做昂贵的决定）', () => {
    const bad = [];
    for (const f of doctrineFiles()) {
      const txt = fs.readFileSync(f, 'utf8');
      for (const [name, pats, why] of RETIRED) {
        const test = hits(pats);
        // 只查正文，不查明确在讲「这条已经作废」的历史说明（那些是有意留的课）
        const lines = txt.split('\n').filter((l) => test(l) && !/⛔|已作废|不再|改成了?|起是/.test(l));
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

  /**
   * ⭐ 这条不是形式主义：第一版的正则把「纸写满**不会**自动翻页」判成了假话，
   * 就是被这几行逮住的。黑名单类的判据最容易写成「见字就叫」，而教义里正确与
   * 错误的说法常常只差一个否定词。
   */
  it('⭐ 判据本身没瞎：退役的说法抓得到，正确的说法不误伤', () => {
    const [fold, down, refuse] = RETIRED.map(([, pats]) => hits(pats));
    expect(fold('纸写满会自动翻页')).toBe(true);
    expect(down('竖直往下长（纸 = 用户一屏）')).toBe(true);
    expect(refuse('装不下就拒收，一个字不落盘')).toBe(true);
    // ⭐ 正确的说法一律不许误伤 —— 它们跟错话只差一个否定词
    expect(fold('纸写满不会自动翻页'), '正确的说法不许误伤').toBe(false);
    expect(fold('机器绝不替你自动翻页'), '同上').toBe(false);
    expect(refuse('装不下不再拒收，改成溢出上架'), '同上').toBe(false);
    expect(refuse('装不下的内容照写，落暂存架等你安置'), '同上').toBe(false);
  });
});
