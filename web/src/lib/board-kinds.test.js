import { describe, it, expect } from 'vitest';
import {
  KINDS, kindOf, traitsOf, sizeOf, actionsOf, primaryOf, readerOf,
  chromeOf, cardOf, isFileBacked, legacyBucketOf, isMarkdown, SIZES,
  CATEGORIES, SOURCES, categoryOf, sourceOf, passesFilter, isArchivePath,
} from './board-kinds.js';

/**
 * 形态能力表的回归锁。
 *
 * 手法跟 2026-08-01 那次「旧版 import 成影子模块，真实数据上逐字节 diff」
 * 一样，只是降到单测层：**把重构前散在 BoardCanvas 里的分支原样抄进这里当
 * 预言机**，再拿新表跟它对账。这样断言的不是「我觉得表该长什么样」，而是
 * 「表和被它替换掉的那堆 if 行为完全一致」。
 *
 * 下面三个 legacy* 函数是 2026-08-07 重构前 BoardCanvas.jsx 的原文，
 * 抄自 sizeOf(board-geometry.js:70)、actions(BoardObject:1766-1773)、
 * primaryOpen(BoardCanvas:1027-1036)。**改表时不要顺手改它们** —— 它们
 * 就是那条基线；真要改行为，先在这里改断言并说明为什么。
 *
 * ## 2026-08-13：产物三兄弟的尺寸与双击动作**有意改了**，理由如下
 *
 * 按上面立的规矩，在这里说明白：
 *
 * 1. **展开态整个退役。** deck / 站点 / 世界原来各有"收起条"和"在画布上展开成
 *    内嵌渲染"两态，卡体在 BoardCanvas 里抄了六遍（约 180 行，骨架逐字节相同）。
 *    现在只有一种样子：方卡 + 实时缩略图，双击直接开那扇窗。
 *    换来的是**尺寸恒定** —— 一个会自己变大两倍半的卡片是所有落点/防遮盖逻辑
 *    的噪声源，而"并排看两份 deck"本来就该由窗来做。
 *    → `sizeExpanded` 从表里删除，`isExpandable` 随之删除，`SAMPLES` 里那三个
 *      "展开"样本改成**验证展开态存量数据被忽略**（见下）。
 * 2. **收起态 240×56 退役，卡片就长成老展开态那个样子**（一条小顶栏 + 下面
 *    一块实时预览，尺寸也照搬）。一条只有一行字的窄条上看不出这是什么东西，
 *    三种产物在桌面上长得一模一样。
 *    ⚠️ 中间试过一版 200×200 的方卡（缩略图在上、名字在下），用户看完的评价
 *    是丑 —— 200 宽的缩略图既看不清版式也看不清字，那张卡既不是图标也不是
 *    预览。别再往那个方向回。
 * 3. **双击 `'expand'` → `'open'`。** 老的是两段式（先展开、再双击才开窗），
 *    展开态没了之后第一段没有落点。
 */

const LEGACY_SIZES = {
  deck: { w: 240, h: 88 },
  deckExpanded: { w: 640, h: 28 + 360 },
  image: { w: 200, h: 176 },
  note: { w: 200, h: 148 },
  file: { w: 224, h: 40 },
  site: { w: 240, h: 88 },
  siteExpanded: { w: 640, h: 28 + 400 },
  worldExpanded: { w: 640, h: 28 + 420 },
};

/**
 * 收起态高度的**有意改动**（2026-08-07 晚）。
 *
 * 上面那张基线是重构前 BoardCanvas 里的原样口径，而那个口径本身就跟卡体
 * 实际渲染对不上：产物卡收起态声明 88 高、实渲只有 54；文件卡声明 40、
 * 实渲 29。卡体是 height:auto，声明值只用来给布局占位 —— 于是每一行产物卡
 * 白留 34px，每一行文件卡白留 11px，而且是那种"看着就是不太对但说不出哪儿
 * 不对"的白留。
 *
 * 新值在浏览器里逐个量 offsetHeight 校准，各留 2~3px 呼吸。改卡体高度时
 * 要回来一起改。
 */
const CALIBRATED = {
  deck: { w: 240, h: 56 },
  site: { w: 240, h: 56 },
  file: { w: 224, h: 32 },
};
const expectedSize = (k) => CALIBRATED[k] || LEGACY_SIZES[k];

/**
 * 产物三兄弟只剩一种样子，取的正是**老展开态那个尺寸** —— 所以这里直接拿
 * 基线里的 `xxxExpanded` 当预期值，等于顺带断言了"卡片形状没有另起炉灶"。
 */
const ONLY_SIZE = {
  deck: LEGACY_SIZES.deckExpanded,
  site: LEGACY_SIZES.siteExpanded,
};

function legacySizeOf(o) {
  // 展开态存量数据**必须被忽略**：还读 `pos.expanded` 的话，收起/展开两个
  // 尺寸就又回来了，而布局系统靠"尺寸恒定"才敢不跑避让
  if (ONLY_SIZE[o.type]) return ONLY_SIZE[o.type];
  // 08-24 有意的行为变化：文本类文件卡升级出预览体，身位=note（服务端
  // estimateSize 同口径，parity 测试钉两边）。参照实现跟着新行为走。
  if (o.type === 'file' && /\.(md|markdown|txt|json|csv|ya?ml)$/i.test(o?.ext || o?.name || '')) {
    return expectedSize('note');
  }
  return expectedSize(o.type) || expectedSize('file');
}

function legacyActions(o) {
  const md = /\.(md|markdown)$/i.test(o?.ext || o?.name || o?.path || '');
  const a = [];
  if (o.type !== 'deck') a.push('add');
  if (o.type === 'note') a.push('read');
  if (o.type === 'image') a.push('detail');
  if (o.type === 'file' && md) a.push('read');
  if (o.type === 'file') a.push('open');
  if (o.type === 'note') a.push('delete');
  return a;
}

function legacyPrimary(o) {
  const md = /\.(md|markdown)$/i.test(o?.ext || o?.name || o?.path || '');
  if (o.type === 'note') return 'read';
  if (o.type === 'image') return 'detail';
  if (o.type === 'file') return md ? 'read' : 'openFile';
  if (o.type === 'deck' || o.type === 'site') return 'open';
  return undefined;
}

/** 覆盖全部 type × 展开态 × markdown 变体的样本。 */
const SAMPLES = [
  { label: 'deck', o: { type: 'deck', pos: {} } },
  // 存量 expanded:true —— 断言它跟没有这个字段的完全一样（不再有隐形脚印）
  { label: 'deck 带存量 expanded', o: { type: 'deck', pos: { expanded: true } } },
  { label: 'site', o: { type: 'site', pos: {} } },
  { label: 'site 带存量 expanded', o: { type: 'site', pos: { expanded: true } } },
  { label: 'image', o: { type: 'image', name: 'a.webp', ext: '.webp' } },
  { label: 'note', o: { type: 'note', name: '灵感.md', ext: '.md' } },
  { label: 'file 普通', o: { type: 'file', name: 'a.zip', ext: '.zip' } },
  { label: 'file markdown', o: { type: 'file', name: '世界.md', ext: '.md' } },
  { label: 'file MARKDOWN 大写', o: { type: 'file', name: 'README.MARKDOWN', ext: '.MARKDOWN' } },
];

describe('board-kinds 与重构前的行为一致', () => {
  it.each(SAMPLES)('$label 的尺寸不变', ({ o }) => {
    expect(sizeOf(o)).toEqual(legacySizeOf(o));
  });

  it.each(SAMPLES)('$label 的工具条按钮与顺序不变', ({ o }) => {
    expect(actionsOf(o)).toEqual(legacyActions(o));
  });

  it.each(SAMPLES)('$label 的双击动作不变', ({ o }) => {
    expect(primaryOf(o)).toBe(legacyPrimary(o));
  });
});

/**
 * 唯一一处有意的行为变化，单独拎出来说清楚。
 *
 * 老代码对未知 type 是自相矛盾的：尺寸走 `SIZES[o.type] || SIZES.file` 拿到
 * file 的 224×40，但渲染分支写的是 `{o.type === 'file' && …}` 匹配不上 ——
 * 于是它渲染成一张**空白的 file 尺寸卡**，工具条只有「+」，双击是死的。
 * 新表把未知 type 整体兜底到 file，卡体、按钮、双击三者第一次一致。
 *
 * 当前构造不出未知 type（objects useMemo 里七种全写死），所以这是纯粹的
 * 防御路径整形，线上零影响。往后加形态时它是安全网：新 type 忘了登记，
 * 表现是「退化成文件卡」而不是「空白卡 + 点不开」。
 */
describe('未知 type 兜底（有意与老代码不同）', () => {
  const unknown = { type: 'wat', name: 'x.bin' };

  it('尺寸沿用老口径 = file', () => {
    expect(sizeOf(unknown)).toEqual(legacySizeOf(unknown));
  });

  it('工具条补齐了「打开」（老代码只有 +）', () => {
    expect(legacyActions(unknown)).toEqual(['add']);
    expect(actionsOf(unknown)).toEqual(['add', 'open']);
  });

  it('双击从死的变成打开原始文件（老代码 undefined）', () => {
    expect(legacyPrimary(unknown)).toBeUndefined();
    expect(primaryOf(unknown)).toBe('openFile');
  });
});

describe('两条轴', () => {
  /**
   * 这条不是"记录现状"，是**闸门**：canvas-backed 意味着 agent 读不到它
   * （它没有文件）。往这个集合里加东西是产品决定，不能顺手加。
   *
   * - （doc 形态 08-24 拆除：项目文档并入根 CLAUDE.md / 记忆/，普通文件卡）
   * - `scribble` 涂鸦，2026-08-07 加，用户给自己做的记号
   * - `text`  画布手写文字，2026-08-08 加。**这是一次产品决定的翻转**：
   *   在那之前画布上打的字一律落成 .md 便签，理由正是"agent 读得到"。
   *   翻转的理由是用户要的是白板 —— 在工程文件旁边随手写一句，那是记号不是
   *   指令。给 agent 看的那条路没删，挪到了右键「新建便利贴」。
   */
  it('canvas-backed 是白名单，加成员要过这一关', () => {
    const canvasBacked = Object.entries(KINDS)
      .filter(([, v]) => v.backing === 'canvas').map(([k]) => k);
    expect(canvasBacked.sort()).toEqual(['scribble', 'text']);
  });

  it('canvas-backed 一律不能加入上下文（没有 path 可给）', () => {
    for (const [name, k] of Object.entries(KINDS)) {
      if (k.backing !== 'canvas') continue;
      expect(actionsOf({ type: name }), `${name} 不该有 add`).not.toContain('add');
    }
  });

  it('每种形态都得声明 backing，不能漏', () => {
    // 'runtime' 是 2026-08-18 为浏览器卡开的第三个值：真相在服务端进程里，
    // 既不是磁盘文件也不是 board.json 记录。**加值要来改这里**，别默默扩容。
    for (const [name, k] of Object.entries(KINDS)) {
      expect(['file', 'canvas', 'runtime'], `${name} 的 backing`).toContain(k.backing);
    }
  });

  it('只有 file backing 算"磁盘上有东西"（改名/搬家/导出/加上下文的判据）', () => {
    expect(isFileBacked({ type: 'deck' })).toBe(true);
    expect(isFileBacked({ type: 'scribble' })).toBe(false);
    // 浏览器卡最容易被误判成 file —— 它长得像产物卡，但背后没有路径
    expect(isFileBacked({ type: 'browse' })).toBe(false);
  });

  it('markdown 变体只改 file，不影响别的形态', () => {
    const md = { type: 'file', name: 'a.md', ext: '.md' };
    expect(traitsOf(md).reader).toBe('file');
    expect(traitsOf(md).primary).toBe('read');
    // 便签也是 .md，但它有自己的阅读器（要剥 frontmatter），不能被变体污染
    expect(readerOf({ type: 'note', name: 'x.md', ext: '.md' })).toBe('note');
  });

  it('isMarkdown 认扩展名也认路径，三个字段任一命中即可', () => {
    expect(isMarkdown({ ext: '.md' })).toBe(true);
    expect(isMarkdown({ name: '正文.markdown' })).toBe(true);
    expect(isMarkdown({ path: 'tasks/x/世界.md' })).toBe(true);
    expect(isMarkdown({ name: 'a.mdx' })).toBe(false);
    expect(isMarkdown({ name: 'md' })).toBe(false);
    expect(isMarkdown(null)).toBe(false);
  });
});

describe('派生判定', () => {
  it('走统一方卡的就是那几种（三种产物 + 浏览器）', () => {
    const artifacts = Object.keys(KINDS).filter(k => cardOf({ type: k }) === 'artifact');
    expect(artifacts.sort()).toEqual(['browse', 'deck', 'docx', 'site']);
  });

  /**
   * `chrome` 是**闸门**，不是记录现状：`'bare'` = 这东西不是一张纸，是画布上
   * 的一笔墨（不给底色/描边/影子/圆角）。加成员是产品决定。
   *
   * 这条轴 2026-08-13 才立起来，起因是它漏过一次：判据原本硬编码在 BoardObject
   * 里写 `o.type === 'scribble'`，`text` 加进来时没人想起改那一行，于是画布上
   * 手写的字外面套着一张白卡 —— 而它自己的注释写着"没有卡片外观"。
   * **不能用 backing 代替**：canvas backing 不等于要涂鸦外观。
   */
  it('bare（一笔墨）是白名单', () => {
    const bare = Object.entries(KINDS).filter(([, v]) => v.chrome === 'bare').map(([k]) => k);
    expect(bare.sort()).toEqual(['scribble', 'text']);
  });

  it('每种形态都得声明 chrome，不能漏', () => {
    for (const [name, k] of Object.entries(KINDS)) {
      expect(['card', 'bare'], `${name} 的 chrome`).toContain(k.chrome);
    }
    expect(chromeOf({ type: 'nope' })).toBe('card');   // 未知兜底成卡片
  });

  it('deck 不给外挂工具条（整张方卡就是打开的按钮）', () => {
    expect(actionsOf({ type: 'deck' })).toEqual([]);
  });

  it('canvas 形态不是磁盘产物，其余都是', () => {
    expect(isFileBacked({ type: 'text' })).toBe(false);
    expect(isFileBacked({ type: 'note' })).toBe(true);
    expect(isFileBacked({ type: 'deck' })).toBe(true);
  });

  it('收纳带分摞与重构前一致', () => {
    // 老代码：deck→deck、file→file、其余→art（doc 摞 08-24 随形态拆除）
    for (const t of ['deck', 'file']) expect(legacyBucketOf({ type: t })).toBe(t);
    for (const t of ['note', 'image', 'site']) expect(legacyBucketOf({ type: t })).toBe('art');
    expect(legacyBucketOf({ type: 'wat' })).toBe('file');   // 未知按 file
  });

  it('kindOf 对未知 type 兜底到 file', () => {
    expect(kindOf({ type: 'nope' })).toBe(KINDS.file);
    expect(kindOf(null)).toBe(KINDS.file);
  });
});

describe('SIZES 兼容出口', () => {
  /**
   * 断言的是「**老的每一项一个字节都没变**」，不是「两张表完全相等」——
   * 后者会在每次加新形态时红一次，红久了就没人当真了。新增项另测。
   */
  it('老的尺寸逐项未变（校准见 CALIBRATED，方卡见 SQUARE）', () => {
    for (const [k, v0] of Object.entries(LEGACY_SIZES)) {
      if (k.endsWith('Expanded')) continue;            // 展开态整档退役
      const v = ONLY_SIZE[k] || CALIBRATED[k] || v0;
      expect(SIZES[k], `SIZES.${k}`).toEqual(v);
    }
  });

  it('新形态也进了铺平表', () => {
    expect(SIZES.scribble).toEqual(KINDS.scribble.size);
  });

  it('展开态退役后不再铺 xxxExpanded 这一档', () => {
    expect(Object.keys(SIZES).filter(k => k.endsWith('Expanded'))).toEqual([]);
  });
});

/**
 * 涂鸦墨色的两端一致性。
 *
 * 前端渲染表（cards/BoardObject.jsx 的 SCRIBBLE_INK，2026-08-13 随卡体从
 * BoardCanvas 搬过去）和服务端白名单
 * （board-sanitize.js 的 sanitizeCanvasData，2026-08-23 从 board-store 拆出）是两份手写的字符串列表。
 * 两边不一致的表现很隐蔽：**"我选了红色，存下来变黑"** —— 不报错、
 * 不失败，只是颜色悄悄回落成 ink。所以钉一条。
 */
describe('涂鸦墨色词汇表两端一致', () => {
  it('前端渲染的颜色键 = 服务端接受的颜色键', async () => {
    const fe = await import('fs').then(fs =>
      fs.readFileSync(new URL('../components/canvas/cards/BoardObject.jsx', import.meta.url), 'utf8'));
    const be = await import('fs').then(fs =>
      fs.readFileSync(new URL('../../../server/projects/board-sanitize.js', import.meta.url), 'utf8'));

    // 提取不依赖排版：写成一行还是一行一个键都认得（2026-08-13 栽过 ——
    // 卡体搬文件时顺手写成一行，断言只捞到第一个键，失败信息还挺唬人）
    const feKeys = [...fe.match(/const SCRIBBLE_INK = \{([\s\S]*?)\};/)[1]
      .matchAll(/(\w+)\s*:/g)].map(m => m[1]).sort();
    const beKeys = JSON.parse(
      be.match(/\['ink'[^\]]*\]/)[0].replace(/'/g, '"')).sort();

    expect(feKeys).toEqual(beKeys);
  });
});

/**
 * 两条轴（2026-08-18）。它们是**桌面过滤的判据**，而过滤判错的症状是"东西不见了"
 * —— 用户会以为文件丢了。所以每一条都钉住。
 */
describe('内容轴 × 来源轴', () => {
  const ids = CATEGORIES.map(c => c.id);

  it('每种形态都在内容轴上表态，而且是表里有的那几档', () => {
    for (const [name, k] of Object.entries(KINDS)) {
      expect(ids, `${name} 的 category`).toContain(k.category);
    }
  });

  it('两条轴的档位不重名（过滤器把它们放在一起显示）', () => {
    const all = [...ids, ...SOURCES.map(s => s.id)];
    // 'tool' 两条轴上都有是**故意的**（工具卡的内容是工具，来源也是工具），
    // 除它之外不该再有重名 —— 否则界面上两排一样的词，谁也说不清点的是哪条轴
    expect(all.filter(x => all.indexOf(x) !== all.lastIndexOf(x))).toEqual(['tool', 'tool']);
  });

  it('来源按物件的实际出处判，不跟着形态走', () => {
    // 同一种形态（图）三种来源 —— 这正是"来源不能写在形态表里"的原因
    expect(sourceOf({ type: 'image', kind: 'upload', path: 'assets/x.png' })).toBe('user');
    expect(sourceOf({ type: 'image', kind: 'generated', path: 'assets/generated/x.png' })).toBe('tool');
    expect(sourceOf({ type: 'image', path: 'assets/references/web/a.com/x.screenshot.webp' })).toBe('tool');
    expect(sourceOf({ type: 'deck', deckFile: '主稿.html' })).toBe('agent');
    // 工具卡本身
    expect(sourceOf({ type: 'browse' })).toBe('tool');
    expect(categoryOf({ type: 'browse' })).toBe('tool');
    // 老形状的上传路径（扁平化之前那种）不能被判成 agent 做的
    expect(sourceOf({ type: 'file', path: '../../shared/assets/品牌规范.pdf' })).toBe('user');   // legacy-ok
  });

  it('空过滤器 = 全都看得见（不是全都不要）', () => {
    const o = { type: 'deck' };
    expect(passesFilter(o, null)).toBe(true);
    expect(passesFilter(o, { categories: [], sources: [] })).toBe(true);
  });

  it('两条轴取交集', () => {
    const shot = { type: 'image', path: 'assets/references/web/a.com/x.screenshot.webp' };
    expect(passesFilter(shot, { categories: ['material'] })).toBe(true);
    expect(passesFilter(shot, { sources: ['tool'] })).toBe(true);
    // 内容对、来源不对 → 不显示
    expect(passesFilter(shot, { categories: ['material'], sources: ['user'] })).toBe(false);
  });

  it('档案面判据（08-27）：根 CLAUDE.md 与 记忆/ 算档案，别的都不算', () => {
    expect(isArchivePath('CLAUDE.md')).toBe(true);
    expect(isArchivePath('记忆')).toBe(true);                       // 文件夹 zone id
    expect(isArchivePath('记忆/求职主线.md')).toBe(true);
    // 边界：同名前缀不误伤（「记忆碎片」是个正常文件夹）、子目录里的 CLAUDE.md 不是根档案
    expect(isArchivePath('记忆碎片')).toBe(false);
    expect(isArchivePath('稿件/CLAUDE.md')).toBe(false);
    expect(isArchivePath('notes/板书/x.md')).toBe(false);
    expect(isArchivePath(null)).toBe(false);
  });
});
