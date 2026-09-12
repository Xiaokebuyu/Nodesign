import { describe, it, expect } from 'vitest';
import { resolveObjectId, zoneOfObjectId } from './stage.js';

/**
 * 舞台寻址：agent 写的文件 → 画布上的哪张卡。
 *
 * ## 2026-08-13：预言机整个换血
 *
 * 这个文件原来锁的是**任务模型**的规则（`tasks/<任务>/canvas.html` = 任务
 * deck，同名文件在 deck 任务和站点任务下含义相反）。`tasks/` 那一层 08-08
 * 就拆掉了，而这些用例照样全绿 —— 因为它们喂给被测函数的也是 `tasks/…`
 * 路径。**测试锁着一具尸体**：真实路径早就不长那样，寻址在线上静默失效
 * （返回 null → 舞台卡掉 dock），而 CI 一片绿。
 *
 * 换血后的规则见 stage.js 的函数注释。这里额外固化两件靠读代码看不出来的事：
 *
 *   1. **进来的路径必须已经是工作区相对的**。服务端 emit 之前过
 *      `toWorkspaceRel`，因为只有它知道工作区根在哪。所以下面所有用例都用
 *      相对路径 —— 喂绝对路径进来是**调用方的 bug**，不是这里要兜的。
 *   2. **认不出来就返回路径本身，不返回 null**。图片卡 / 便签卡 / 文件卡的
 *      id 本来就是裸路径，"认不出"和"是个普通文件"是同一件事。
 */

// 目录型产物的覆盖表（BoardCanvas 从 objects 派生，按 path 长度降序）
const ROOTS = [
  { path: '鉴赏页/v2', id: 'site:鉴赏页/v2' },     // 子目录站排在父站前面
  { path: '伊蕾娜手账研究站', id: 'site:伊蕾娜手账研究站' },
  { path: '鉴赏页', id: 'site:鉴赏页' },
  { path: '观察日志', id: 'site:观察日志' },
];

describe('resolveObjectId — 文件落到哪张卡', () => {
  it('绝对路径一律拒收（home 幽灵案：剥斜杠会把 /home/... 认成 home/... 相对路径）', () => {
    expect(resolveObjectId('/home/u/data/proj/shared/assets/generated/a.png', [])).toBeNull();
    expect(resolveObjectId('/tmp/x.md', [])).toBeNull();
  });

  it('记忆文件按普通路径派生（doc: 特例 08-24 拆除）', () => {
    expect(resolveObjectId('记忆/style-anchor.md', ROOTS)).toBe('记忆/style-anchor.md');
    expect(resolveObjectId('CLAUDE.md', ROOTS)).toBe('CLAUDE.md');
  });

  it('站点目录里的一切都贴同一张站点卡', () => {
    expect(resolveObjectId('伊蕾娜手账研究站/index.html', ROOTS)).toBe('site:伊蕾娜手账研究站');
    expect(resolveObjectId('伊蕾娜手账研究站/about.html', ROOTS)).toBe('site:伊蕾娜手账研究站');
    expect(resolveObjectId('伊蕾娜手账研究站/style.css', ROOTS)).toBe('site:伊蕾娜手账研究站');
    expect(resolveObjectId('伊蕾娜手账研究站/posts/first.html', ROOTS)).toBe('site:伊蕾娜手账研究站');
    // 目录本身（agent 对着整个站做事）也算
    expect(resolveObjectId('伊蕾娜手账研究站', ROOTS)).toBe('site:伊蕾娜手账研究站');
  });

  it('子目录站不被父站吞掉 —— 长前缀先匹配', () => {
    expect(resolveObjectId('鉴赏页/v2/index.html', ROOTS)).toBe('site:鉴赏页/v2');
    expect(resolveObjectId('鉴赏页/index.html', ROOTS)).toBe('site:鉴赏页');
  });

  it('世界目录同理：立绘和地点 .md 都贴世界卡', () => {
    expect(resolveObjectId('观察日志/index.html', ROOTS)).toBe('site:观察日志');
    expect(resolveObjectId('观察日志/posts/一月.html', ROOTS)).toBe('site:观察日志');
    expect(resolveObjectId('观察日志/assets/图.webp', ROOTS)).toBe('site:观察日志');
  });

  it('不在任何产物里的 .html = 一份 deck（根上和文件夹里平等）', () => {
    expect(resolveObjectId('主稿.html', ROOTS)).toBe('deck:主稿.html');
    expect(resolveObjectId('稿件/初稿/主稿.html', ROOTS)).toBe('deck:稿件/初稿/主稿.html');
    expect(resolveObjectId('proto-暖调.htm', ROOTS)).toBe('deck:proto-暖调.htm');
  });

  it('其余一切：路径本身就是 id（图片 / 便签 / 数据文件）', () => {
    expect(resolveObjectId('assets/generated/sc-starfield.webp', ROOTS))
      .toBe('assets/generated/sc-starfield.webp');
    expect(resolveObjectId('notes/灵感.md', ROOTS)).toBe('notes/灵感.md');
    expect(resolveObjectId('稿件/数据.csv', ROOTS)).toBe('稿件/数据.csv');
  });

  it('覆盖表缺省时不猜站点，退回 deck / 裸路径', () => {
    expect(resolveObjectId('伊蕾娜手账研究站/about.html')).toBe('deck:伊蕾娜手账研究站/about.html');
    expect(resolveObjectId('伊蕾娜手账研究站/style.css')).toBe('伊蕾娜手账研究站/style.css');
  });

  it('保留目录里的东西不上画布 → null（09-12：采集件当 id 会让精灵失锚漂移）', () => {
    expect(resolveObjectId('assets/references/web/example.com/home.screenshot.webp', ROOTS)).toBeNull();
    expect(resolveObjectId('exports/x.zip', ROOTS)).toBeNull();
    expect(resolveObjectId('agent-memory/notes.md', ROOTS)).toBeNull();
    // assets 顶层和 generated/ notes/ 两个子目录照旧是卡
    expect(resolveObjectId('assets/photo.png', ROOTS)).toBe('assets/photo.png');
    expect(resolveObjectId('assets/notes/n.md', ROOTS)).toBe('assets/notes/n.md');
  });

  it('工作区根自己 / 空路径 → null（没有对应的卡）', () => {
    expect(resolveObjectId('', ROOTS)).toBe(null);
    expect(resolveObjectId('./', ROOTS)).toBe(null);
    expect(resolveObjectId(null, ROOTS)).toBe(null);
  });

  /**
   * 根站（2026-08-14 真会话抓到的「中途目标消失」）：站住在工作区根上时
   * path 合法地是**空串**。曾经 `!r.path` 一刀跳过 → index.html/style.css
   * 解析成幽灵 id（deck:index.html / 裸路径），rectFor 恒 null，精灵落不到
   * 任何卡上且之后的修改全部失踪。空串是根站的身份，不是"没有值"。
   */
  describe('根站（path 为空串）', () => {
    const ROOT_SITE = [
      { path: '_drafts/纸本.html', id: 'site:_drafts/纸本.html' },
      { path: '', id: 'site:' },
    ];
    it('根层散文件都归根站卡（index/style/模板）', () => {
      expect(resolveObjectId('index.html', ROOT_SITE)).toBe('site:');
      expect(resolveObjectId('style.css', ROOT_SITE)).toBe('site:');
      expect(resolveObjectId('site.template.html', ROOT_SITE)).toBe('site:');
    });
    it('带 / 的路径不被根站吞：notes/assets/子目录站各回各家', () => {
      expect(resolveObjectId('notes/决策.md', ROOT_SITE)).toBe('notes/决策.md');
      expect(resolveObjectId('assets/generated/x.png', ROOT_SITE)).toBe('assets/generated/x.png');
      expect(resolveObjectId('_drafts/纸本.html', ROOT_SITE)).toBe('site:_drafts/纸本.html');
    });
    it('根上的 .md 是自己的阅读卡，不归站', () => {
      expect(resolveObjectId('随笔.md', ROOT_SITE)).toBe('随笔.md');
    });
    it('认领子目录（claims=页面路径顶层段）里的文件也归根站', () => {
      const withClaims = [{ path: '', id: 'site:', claims: ['刊物'] }];
      expect(resolveObjectId('刊物/第一期.html', withClaims)).toBe('site:');
      expect(resolveObjectId('刊物/style.css', withClaims)).toBe('site:');
      // 没被认领的子目录照旧各回各家
      expect(resolveObjectId('稿件/草.html', withClaims)).toBe('deck:稿件/草.html');
    });
  });

  /**
   * 单页产物的伴生文件（2026-08-14）：`_drafts/纸本.css` 属于
   * `site:_drafts/纸本.html` 那张卡 —— _drafts/ 刻意不是文件夹卡，
   * 伴生文件落裸路径的话精灵/舞台卡对它彻底没有落点。
   */
  it('单页站的同名伴生文件归那张卡', () => {
    const R = [{ path: '_drafts/纸本.html', id: 'site:_drafts/纸本.html' }];
    expect(resolveObjectId('_drafts/纸本.css', R)).toBe('site:_drafts/纸本.html');
    expect(resolveObjectId('_drafts/纸本.js', R)).toBe('site:_drafts/纸本.html');
    // 不同名的不吸：纸本v2 是另一份试作
    expect(resolveObjectId('_drafts/纸本v2.html', R)).toBe('deck:_drafts/纸本v2.html');
  });

  it('前后多余的斜杠和 ./ 前缀不影响命中', () => {
    expect(resolveObjectId('./观察日志/index.html', ROOTS)).toBe('site:观察日志');
    expect(resolveObjectId('稿件/初稿/主稿.html/', ROOTS)).toBe('deck:稿件/初稿/主稿.html');
  });
});

describe('zoneOfObjectId — 物件住在哪个文件夹', () => {
  it('剥掉 kind 前缀后取上级目录', () => {
    expect(zoneOfObjectId('deck:稿件/初稿/主稿.html')).toBe('稿件/初稿');
    expect(zoneOfObjectId('site:鉴赏页/v2')).toBe('鉴赏页');
    expect(zoneOfObjectId('site:文章区/观察日志')).toBe('文章区');
    expect(zoneOfObjectId('assets/generated/a.webp')).toBe('assets/generated');
  });

  it('住在工作区根上的 → null（桌面本身不是文件夹）', () => {
    expect(zoneOfObjectId('deck:主稿.html')).toBe(null);
    expect(zoneOfObjectId('site:伊蕾娜手账研究站')).toBe(null);
    expect(zoneOfObjectId('site:观察日志')).toBe(null);
  });

  it('项目区的文档不归任何文件夹', () => {
  });

  /**
   * ⚠️ 回归锁：**不许有"回落到当前会话"这一支**。
   *
   * 它的下游 `ensureZoneForTarget` 会照单全收地长出一块影子文件夹，而影子
   * 不过磁盘权威剪枝（`zonesEff` 里无条件并入），退场条件是"这个文件夹真的
   * 出现了" —— 对一个 session uuid 来说永远不会。症状是画布上多一个 uuid
   * 标题的虚线框，刷新才消失。
   */
  it('认不出来就是 null，不拿会话 id 兜底', () => {
    expect(zoneOfObjectId('deck:0a1b2c3d-4e5f-6789-abcd-ef0123456789')).toBe(null);
    expect(zoneOfObjectId('')).toBe(null);
    expect(zoneOfObjectId(null)).toBe(null);
  });
});
