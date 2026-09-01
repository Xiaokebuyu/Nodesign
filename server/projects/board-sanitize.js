/**
 * server/projects/board-sanitize.js — board.json 的校验/清洗（2026-08-23 从 board-store 拆出）
 *
 * 纯函数，不碰磁盘不碰锁。board-store 是唯一读写方，读进来先过这里、写出去前
 * 也过这里；字段的白名单与上限全在这一份。拆出来只是因为 board-store 胖过了
 * 行数棘轮，语义一个字没改。
 *
 * schema 见 board-store 头注释。黑板字段（2026-08-23）：
 *   object.tag / object.staging / text.data.format / text.data.lid
 *   binding.material / binding.tag / binding.staging
 */

import { isBindingType, isBindingMaterial } from '../lib/binding-types.js';
import { ROLE_SLUG_RE } from '../engine/agent/cast.js';
import { DEFAULT_BOARD_SIZE, MAX_OBJECTS, MAX_ZONES, MAX_BINDINGS, MAX_LANES, MAX_SHEETS, MAX_STACKS } from './board-limits.js';
import { ONE_SCREEN } from '../lib/screen.js';

/**
 * 板上署名的白名单：'user' / 'agent' / 常驻角色 slug（`rp-*`，见 engine/agent/cast.js）。
 * 认不出的一律丢掉（落回无归属），**不透传** —— 这个值由模型写，而它的读者有一串：
 * 前端标题与线标签、read_board 的分段、板书注入、将来的收件箱路由。
 *
 * ⚠️ **有东西寄生在这个值域上**：`lib/board-hero.js` 与 `web/src/lib/hero.js`（parity 对）
 * 把「手画的线」判成 `by && by !== 'auto'` —— 那是个黑名单，只在「值域被这里钉死」的
 * 前提下才与白名单等价。放宽这里的值域前，先去看那两处。
 */
function sanitizeBy(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s === 'user' || s === 'agent') return s;
  return ROLE_SLUG_RE.test(s) ? s : null;
}

export function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function sanitizeSize(raw) {
  return {
    w: clampNum(raw?.w, 1000, 20000, DEFAULT_BOARD_SIZE.w),
    h: clampNum(raw?.h, 800, 20000, DEFAULT_BOARD_SIZE.h),
  };
}

/**
 * **画布原生**物件的形态白名单。
 *
 * 绝大多数画布物件是磁盘产物的影子：board.json 只存它摆在哪，本体是文件
 * （所以 agent 读得到、能进上下文、删文件即消失）。涂鸦不一样 —— 它没有
 * 有意义的文件形态，board.json 就是它的**本体**。这类物件必须显式登记，
 * 否则任何人往 objects 里塞一个 kind 就能造出一个不受形态表管的东西。
 *
 * 2026-08-08 加进 `text`。在那之前画布上打的字一律落成 `.md` 便签，理由是
 * "agent 读得到"。但用户要的是**白板**：在工程文件旁边随手写一句、画一笔，
 * 那是给自己的记号，不是给 agent 的输入。想让 agent 看见的写便利贴 ——
 * 那条路还在，挪到了右键菜单里。
 */
const CANVAS_NATIVE_KINDS = new Set(['scribble', 'text']);

/**
 * 坐标夹持上限。画布 2026-08-13 起全向无限，坐标不再由 board.size 夹住 ——
 * 这个数只挡非有限值和纯属事故的数字（±100 万世界像素之外没有正常操作能到）。
 */
const COORD_LIMIT = 1e6;

/** 涂鸦路径串上限。一条随手画的线约 300~800 字符，8000 够长且撑不爆 board.json */
const MAX_SCRIBBLE_PATH = 24000;
/**
 * 画布文字的字数上限。
 *
 * 它是"写在白板上的一句话"，不是文档 —— 长东西该写成 .md（那是便利贴，
 * agent 读得到）。2000 字够写一段说明，也撑不爆 board.json。
 */
const MAX_TEXT_LEN = 8000;
/**
 * md 档文字的上限（2026-08-23 黑板）。画布上的 markdown/KaTeX/mermaid 节点比手写
 * 一句话长，但它仍是"黑板上的一块"不是文档 —— 想写长的走 .md。
 */
const MAX_MD_TEXT_LEN = 8000;
/** 文字的排版格式：plain = 原样手写；md = Markdown（含 KaTeX 与 mermaid 围栏） */
const TEXT_FORMATS = ['plain', 'md'];
/**
 * 分组标签（2026-08-23 黑板）：物件和线都可以带。它**不是几何容器**，只是一个
 * 字段 —— 读侧按它过滤、渲染侧按它画包络、staging 落定按它成批。字符集收紧
 * 是因为它会进 DOM 属性和 URL 查询串。
 */
const TAG_RE = /^[\w\u4e00-\u9fff\u3040-\u30ff-]{1,40}$/;
/**
 * 画布 id 的路径安全（2026-08-23 fable 审出 P0）：id 大多是工作区相对路径，下游有人拿它拼
 * 文件路径（removeByTag 删板书、chalkExcerpts 读板书）。拒掉 `..` 段、绝对路径、反斜杠、NUL；
 * 带形态前缀（deck:/site:/…）的先剥前缀再查。
 */
export function isSafeCanvasId(id) {
  if (typeof id !== 'string' || !id || id.length > 300) return false;
  if (id.includes('\0') || id.includes('\\')) return false;
  const c = id.indexOf(':');
  const p = (c > 0 && /^[a-z]+$/.test(id.slice(0, c))) ? id.slice(c + 1) : id;
  if (p.startsWith('/')) return false;
  return !p.split('/').some(seg => seg === '..');
}

export { TAG_RE };
export function sanitizeTag(v) {
  return typeof v === 'string' && TAG_RE.test(v) ? v : null;
}

/** 画布文字可选的字体。**白名单而不是自由字符串** —— 这个值会进 CSS */
export const TEXT_FONTS = ['pen', 'kai', 'sans', 'serif', 'mono'];
const TEXT_SIZES = ['sm', 'md', 'lg', 'xl'];

/**
 * 变换字段（2026-08-13，选中态控制器）。缺省不落字段 —— 没转过没缩过的物件
 * 别背两个恒等值，board.json 的 diff 要能一眼看出"谁被动过"。
 */
function sanitizeTransform(data) {
  const out = {};
  const rot = Number(data?.rotation);
  if (Number.isFinite(rot) && rot !== 0) out.rotation = clampNum(rot, -360, 360, 0);
  const sc = Number(data?.scale);
  if (Number.isFinite(sc) && sc !== 1) out.scale = clampNum(sc, 0.2, 10, 1);
  return out;
}

function sanitizeCanvasData(kind, data) {
  if (kind === 'text') {
    const format = TEXT_FORMATS.includes(data?.format) ? data.format : 'plain';
    const max = format === 'md' ? MAX_MD_TEXT_LEN : MAX_TEXT_LEN;
    const t = typeof data?.t === 'string' ? data.t.slice(0, max) : '';
    if (!t.trim()) return null;
    return {
      t,
      // plain 不落字段：存量条目全是 plain，别让 diff 里凭空多一行
      ...(format === 'md' ? { format } : {}),
      font: TEXT_FONTS.includes(data?.font) ? data.font : 'kai',
      size: TEXT_SIZES.includes(data?.size) ? data.size : 'md',
      color: ['ink', 'red', 'pencil', 'brass'].includes(data?.color) ? data.color : 'ink',
      // lid = sketch_on_board 里那个局部 id（linfan / zhangwei…）。留着它，
      // edit_sketch 才能按 agent 当初起的名字找回这个节点 —— 否则局部 id 一落定
      // 就作废，加条线得先去翻上一次调用的返回。这层是白名单重建，不列就丢。
      ...(typeof data?.lid === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(data.lid) ? { lid: data.lid } : {}),
      ...sanitizeTransform(data),
    };
  }
  if (kind !== 'scribble') return null;
  const d = typeof data?.d === 'string' ? data.d.slice(0, MAX_SCRIBBLE_PATH) : '';
  // 只收 SVG path 里合法的那几个字符，挡住任何往 DOM 里塞东西的尝试
  if (!d || !/^[\dMLQCZ ,.\-eE]+$/.test(d)) return null;
  return {
    d,
    color: ['ink', 'red', 'pencil', 'brass'].includes(data.color) ? data.color : 'ink',
    width: clampNum(data.width, 1, 24, 2),
    ...sanitizeTransform(data),
  };
}

export function sanitizeObject(o, size) {
  if (!o || typeof o !== 'object') return null;
  const kind = typeof o.kind === 'string' && CANVAS_NATIVE_KINDS.has(o.kind) ? o.kind : null;
  const data = kind ? sanitizeCanvasData(kind, o.data) : null;
  // 登记了 kind 却给不出合法内容 → 整条丢弃。留一个空壳会在画布上变成
  // 一个看不见也删不掉的幽灵物件。
  if (kind && !data) return null;
  return {
    // 画布 2026-08-13 起全向无限：坐标不再被桌面尺寸夹持（原来非 native 只许
    // 正区间、native 也出不了 ±size）。这里只挡非有限值和纯属事故的数字 ——
    // 夹得再紧一点都意味着"用户摆在那儿的东西刷新后跳走"，那是静默数据损坏。
    x: clampNum(o.x, -COORD_LIMIT, COORD_LIMIT, 0),
    y: clampNum(o.y, -COORD_LIMIT, COORD_LIMIT, 0),
    z: clampNum(o.z, 0, 1e6, 0),
    ...(Number.isFinite(Number(o.w)) ? { w: clampNum(o.w, 4, COORD_LIMIT, 200) } : {}),
    ...(Number.isFinite(Number(o.h)) ? { h: clampNum(o.h, 4, COORD_LIMIT, 200) } : {}),
    ...(o.expanded ? { expanded: true } : {}),
    // 显式归属：'' = 明确无归属（覆盖 sid 派生），非空 = 所属工作区 id
    ...(typeof o.zone === 'string' && o.zone.length <= 300 ? { zone: o.zone } : {}),
    // 出处（2026-08-14 agent 摆位/建元素）：谁**造**的这件东西。08-25 起也收
    // 'user'（原来只认 agent，跟 bindings 三值不对称是口径病）；08-26 起再收
    // 常驻角色的 slug（rp-*）—— RP 场里板上大半东西是角色写的，全落回 'agent'
    // 就丢了归属。⚠️ 这里是白名单，不是透传：写这个值的是模型，而 by 有一串读者
    // （前端显示 / read_board 分段 / 板书注入 / 将来的收件箱路由）。
    ...(sanitizeBy(o.by) ? { by: sanitizeBy(o.by) } : {}),
    // 座位出处（2026-08-25 范式重做）：谁**摆**的这个座。三值：
    //   user  = 用户亲手拖的 —— 出处记号+学习票源（inferFlowDir 认它学摆放方向）。
    //           08-28 起**不再是禁令**（用户拍板全放开）：move/reflow/组操作都挪得动，
    //           但工具返回必须注明"原是用户亲手摆的"，且他拖回去就是定案。
    //   auto  = 入座算法排的 —— 可以被重排
    //   agent = agent 显式摆的 —— 用户可拖走（拖走后变 user）
    // 没有这个字段，用户拖的和自动排的在数据上分不清
    // （08-25 体检结论：老数据 by 被前端回写抹掉）。
    //   shelf = 暂存架上等安置（2026-08-30）—— 机器到货默认座。pin_to_board /
    //           edit_board move / 用户拖拽一改写 seat 就自然离架（lib/board-shelf.js）
    ...(o.seat === 'user' || o.seat === 'auto' || o.seat === 'agent' || o.seat === 'shelf' ? { seat: o.seat } : {}),
    // 尺寸出处（2026-08-28）：'user' = 这块板书的宽高是用户亲手拖出来的。
    // 两个用途：① 重排/估算别拿内容宽度盖掉他调过的宽 ② 写入端拿它当**学习票源**
    // 推断"他喜欢多宽的板书"（lib/chalk-size-pref.js）。跟 seat 是两件事 ——
    // seat 说"谁摆的位置"，sized 说"谁定的大小"，用户可以只调一个。
    ...(o.sized === 'user' ? { sized: 'user' } : {}),
    // 贴身跟随（2026-08-27 shapes 编辑面）：这个涂鸦是"圈住 hug 那件东西"的记号，
    // 挪那件东西时它跟着走（edit_board move/move_group/reflow；前端拖拽同口径）
    ...(typeof o.hug === 'string' && o.hug.length <= 300 ? { hug: o.hug } : {}),
    // 分组标签 + 草稿位（2026-08-23 黑板）。staging = agent 这一轮还在打草稿：
    // 入座不看它、read_board 默认不列它、画面上半透明；落定（commitStaging）清位。
    ...(sanitizeTag(o.tag) ? { tag: sanitizeTag(o.tag) } : {}),
    ...(o.staging === true ? { staging: true } : {}),
    /**
     * 这件东西写在哪张纸上（2026-09-01 叠纸刀 0）。
     *
     * 在这之前成员归属是**几何派生**的：中心点落在哪张纸的矩形里就算谁的。
     * 那套判据换来一件好事（用户把卡拖出纸外，归属自动跟着变，机器不用维护
     * 第二份成员表），但它有一个前提：**两张纸不许占同一块地**。叠纸把这个
     * 前提拿掉了，于是同一个坐标上会有好几张纸，几何再也分不出这件东西属于
     * 其中哪一张 —— 在第二页上写第一笔，第一页的全部内容都会被算成障碍。
     *
     * 所以归属改成显式登记。⚠️ 缺这个字段时调用方**回落几何**（存量的 103 张
     * 纸一张都没有这个字段，而它们本来就不叠，几何在那儿是准的）：显式优先、
     * 几何兜底，不需要先跑一次全库迁移才敢上线。
     */
    ...(sanitizeTag(o.sheet) ? { sheet: sanitizeTag(o.sheet) } : {}),
    ...(kind ? { kind, data } : {}),
  };
}

/**
 * 关系线。**不存坐标** —— 端点是 object id 或 zone id，线跟着端点走。
 *
 * 词汇表在 `server/lib/binding-types.js`（前端画线那份视觉映射要跟它对齐，
 * 有 parity 断言看着）。不认识的 type 一律丢弃：宁可少画一条线，也不要在
 * 画布上留一条没人知道什么意思的连线。
 *
 * 自环（from === to）也丢：它画不出来，且多半是 agent 传错了 id。
 */
export function sanitizeBinding(b) {
  if (!b || typeof b !== 'object') return null;
  if (!isBindingType(b.type)) return null;
  const from = typeof b.from === 'string' ? b.from.slice(0, 300) : '';
  const to = typeof b.to === 'string' ? b.to.slice(0, 300) : '';
  if (!from || !to || from === to) return null;
  return {
    type: b.type,
    from,
    to,
    // 线上的字。没写就渲染时回落到词汇表的默认词，不在这里补 —— 存了默认词
    // 之后改词汇表就改不动存量了。
    ...(typeof b.label === 'string' && b.label.trim()
      ? { label: b.label.trim().slice(0, 60) }
      : {}),
    // 谁画的。用户画的线 agent 不该擅自删，反过来也一样；auto = 机器可证的
    // 引用关系（auto-relations.js 对账层专属，只有它增删自家 b:auto:* 条目）。
    ...(b.by === 'auto' ? { by: 'auto' } : sanitizeBy(b.by) ? { by: sanitizeBy(b.by) } : {}),
    // 材质（2026-08-23 黑板）：语义之外的第二个轴 —— 墨线/手绘/丝线。不落默认值，
    // 渲染侧按语义给缺省材质；存了默认值以后改缺省就改不动存量。
    ...(isBindingMaterial(b.material) && b.material !== 'ink' ? { material: b.material } : {}),
    ...(sanitizeTag(b.tag) ? { tag: sanitizeTag(b.tag) } : {}),
    ...(b.staging === true ? { staging: true } : {}),
    // 跟随线（2026-08-25 范式重做，RP「状态板重锚」案）：follow = 目标 tag ——
    // 这条线的 to 端永远指向该 tag 最新落板的那件，服务端在新件落板时自动重指
    // 并把 from 端所在的组挪过去（board-follow.js）。followSide = 挪到哪一侧。
    ...(sanitizeTag(b.follow) ? { follow: sanitizeTag(b.follow) } : {}),
    ...(['right', 'left', 'above', 'below'].includes(b.followSide) ? { followSide: b.followSide } : {}),
  };
}

/**
 * zones 一行只剩坐标（2026-08-13 瘦身，#14）。
 *
 * 逐字段的下场：
 * - `w`/`h` —— 文件夹变方卡后前端视图**强制** FOLDER_CARD 尺寸，存的数字
 *   没人读，还会成为"画布上 288 宽、存档里 1340"那种自相矛盾的证据。
 * - `title` —— 名字从路径读（id 就是路径），存一份就是第二个真相源，
 *   改名后立刻过期（实测过）。
 * - `collapsed` —— 收起/展开两态 2026-08-13 随"当前目录"模型退役。
 * - `pinned` —— 纵向堆叠 2026-08-08 退役，字段没有了对立面。
 * 存量数据里这些字段读进来直接丢，下次写盘自然消失。
 */
export function sanitizeZone(z) {
  if (!z || typeof z !== 'object') return null;
  return {
    // 同 sanitizeObject：无限画布，文件夹卡也能摆在任何地方（含负坐标）
    x: clampNum(z.x, -COORD_LIMIT, COORD_LIMIT, 0),
    y: clampNum(z.y, -COORD_LIMIT, COORD_LIMIT, 0),
  };
}

/**
 * 线（lane）注册表条目（2026-08-27 空间规划）：{x,y,w,parent}。
 * 键 = tag（线就是 tag，见 lib/board-lanes.js 头注）；frontier 不存 —— 从成员现算。
 */
export function sanitizeLane(l) {
  if (!l || typeof l !== 'object') return null;
  const x = Number(l.x); const y = Number(l.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const parent = typeof l.parent === 'string' && l.parent.length <= 300 ? l.parent : null;
  return {
    x: Math.round(x), y: Math.round(y),
    w: clampNum(l.w, 96, 2400, 480),
    ...(parent ? { parent } : {}),
  };
}

/**
 * 卷（2026-08-27 收纳器）：{ at, by, label? }。有条目 = 这个 tag 收着。
 * 只是视觉收纳的状态位 —— 成员对象的座位原样留在 objects 里（展开即归位），
 * 落位引擎照旧把它们当障碍。
 */
export function sanitizeRoll(r) {
  if (!r || typeof r !== 'object') return null;
  const at = typeof r.at === 'string' && r.at.length <= 40 ? r.at : new Date().toISOString();
  const by = typeof r.by === 'string' && r.by.length <= 40 ? r.by : 'user';
  const label = typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 60) : null;
  return { at, by, ...(label ? { label } : {}) };
}

/**
 * 纸（sheet 注册表，2026-08-29 纸范式）：{ x, y, w, h, by?, at?, title? }。
 * 键 = 纸名（TAG_RE 字符集）。纸是**分配纪律不是本体容器**：成员按几何派生
 * （中心点落在纸内），这里只登记「这块地是谁在什么时候铺的、多大」。
 * w/h 显式存 —— 纸尺寸取决于铺纸那一刻的设备档（手机纸小、桌面纸大），
 * 不能全局常量化。
 */
/** 一张纸上最多规划几块地（版面切太碎就不是版面了） */
export const MAX_SLOTS = 24;

/**
 * 版位（slot，2026-08-29 占位契约刀 E）。
 *
 * ⛔ **2026-09-01 刀 2 起没有任何一处再产生版位**（站主撤掉纸内切块，改机器按栏排
 * —— 见 lib/board-sheets.js 那段「版位退役」）。这一份**只为存量数据留着**：
 * 09-01 之前的板上有 108 张纸带 slots，读它的人已经一个都不剩，但把它从白名单里
 * 摘掉等于下一次落盘时**静默删掉用户板上的一段历史**，而这一刀还在验收期。
 * 验收通过之后连同 MAX_SLOTS 一起删。
 *
 * ⚠️ 坐标跟 at 同一套：纸内局部像素、原点在版心左上角。
 */
export function sanitizeSlot(s) {
  if (!s || typeof s !== 'object') return null;
  const x = Number(s.x); const y = Number(s.y);
  const w = Number(s.w); const h = Number(s.h);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  if (w < 48 || h < 24) return null;      // 比这还小的地放不下一行字
  return {
    x: Math.round(Math.min(Math.max(0, x), 12000)),
    y: Math.round(Math.min(Math.max(0, y), 12000)),
    w: Math.round(Math.min(w, 12000)),
    h: Math.round(Math.min(h, 12000)),
    ...(typeof s.about === 'string' && s.about.trim() ? { about: s.about.trim().slice(0, 60) } : {}),
    /**
     * 用户亲手调过这一块（2026-09-01 册）。版式画出来给用户看之后他就能拖了，
     * 而 agent 的 replan 随时会改同一块地 —— 「别跟用户拔河」那条规矩要成立，
     * 前提是 agent **知道**这一块是他调的。所以留一个章，跟 objects 的
     * `sized:'user'` 同一个用法：模型盖不出来（白名单只收 'user'），
     * 它只是让 replan 的报文能说一句「这块是他调的，你改了」。
     */
    ...(s.by === 'user' ? { by: 'user' } : {}),
    // 收产物的那块地（2026-08-30 刀 G）：`for:'artifacts'` 一张纸上最多一块。
    // 产物（生成的图、写出来的文件、目录型产物）是 agent 干活的**副产品**，
    // 它没法在写之前一件件点名落位 —— 但它可以提前说「这一页的产物都放这儿」。
    // 没有这块地，机器就只能自己决定，那就又回到「机器定版面」了。
    ...(s.for === 'artifacts' ? { for: 'artifacts' } : {}),
  };
}

export function sanitizeSheet(s) {
  if (!s || typeof s !== 'object') return null;
  const x = Number(s.x); const y = Number(s.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const slots = {};
  let slotN = 0;
  for (const [nm, v] of Object.entries(s?.slots && typeof s.slots === 'object' ? s.slots : {})) {
    if (slotN >= MAX_SLOTS) break;
    if (!TAG_RE.test(nm)) continue;
    const sl = sanitizeSlot(v);
    if (sl) { slots[nm] = sl; slotN += 1; }
  }
  return {
    x: Math.round(x), y: Math.round(y),
    w: clampNum(s.w, 240, 8000, ONE_SCREEN.w),
    h: clampNum(s.h, 240, 12000, ONE_SCREEN.h),
    /**
     * 这张纸的栏宽（2026-09-01 刀 2）：机器按它把版心切成几栏（sheetColumns）。
     * 铺纸那一刻按设备档 + 用户拖出来的宽度定死并存进来 —— **存下来而不是每次
     * 现算**，否则用户拖宽一条板书，整张纸的栏格跟着变，已经写好的内容当场错位。
     * 存量的纸没有这个字段，读的时候退回 DEFAULT_CHALK_W（行为跟以前一样）。
     */
    ...(Number.isFinite(Number(s.colW)) ? { colW: clampNum(s.colW, 120, 4000, 432) } : {}),
    ...(sanitizeBy(s.by) ? { by: sanitizeBy(s.by) } : {}),
    ...(typeof s.at === 'string' && s.at.length <= 40 ? { at: s.at } : {}),
    ...(typeof s.title === 'string' && s.title.trim() ? { title: s.title.trim().slice(0, 60) } : {}),
    /**
     * 这张纸属于哪一摞（2026-09-01 叠纸刀 0）。没有这个字段 = 它自己单独一摞
     * （存量的纸全是这样，行为一个字不变）。
     *
     * ⚠️ 不变量：**同一摞里所有纸的 x/y 必须相等**（那就是"叠在一起"的定义）。
     * 位置仍然存在纸上而不是搬到栈上，是因为有二十来处代码在 `{...board.sheets[id]}`
     * 上直接读 x/y，把位置抽走会让它们静默拿到 undefined，再经 innerRect 变成
     * NaN —— 那是最难查的一类坏法。栈只管身份和顺序，几何照旧长在纸上，
     * 不变量由铺纸那一个入口守（lib/board-stacks.js stackOriginOf）。
     */
    ...(sanitizeTag(s.stack) ? { stack: sanitizeTag(s.stack) } : {}),
    /**
     * 铺这张纸的那一轮对话（2026-09-01 叠纸刀 8）。
     *
     * 叠纸之前板上的东西和聊天记录之间**没有任何链接**：板书文件名带时间戳，纸只有
     * 一个 at，要对上得靠人用眼睛比时间。一摞纸叠起来之后这件事更要紧了 —— 用户
     * 看到第三页想不起来当时聊的是什么，而那一页在屏幕上就是全部线索。
     *
     * 存会话 id 不存 run id：一页纸常常横跨好几个回合，而"当时在跟哪一段对话说话"
     * 才是他要找的东西。⚠️ 只是一个指针，会话删了就指不到 —— 目录那边找不到就
     * 不显示入口，不报错（板上的字不该因为对话没了而变成坏链接）。
     */
    ...(typeof s.sid === 'string' && s.sid.length <= 100 ? { sid: s.sid } : {}),
    ...(slotN ? { slots } : {}),
  };
}

/**
 * 栈（stack，2026-09-01 叠纸）：一摞纸。**只有身份，没有几何** —— 原点是成员
 * 纸的 x/y（同一摞里它们相等），宽高是成员的最大值，都现算不存。
 *
 * 为什么栈要有名字：翻页从一条轴变成两条（左右换摞、上下翻这一摞里的纸）之后，
 * 相邻的那一摞得能被点名 —— agent 要说得出「把状态表铺到旁边那一摞」。一条
 * 匿名的链表达不了这件事。
 */
export function sanitizeStack(s) {
  if (!s || typeof s !== 'object') return null;
  /** 存量的摞级版式（⛔ 09-01 刀 2 起没有写入方，留着只为不删用户的旧数据） */
  const slots = {};
  let slotN = 0;
  for (const [nm, v] of Object.entries(s?.slots && typeof s.slots === 'object' ? s.slots : {})) {
    if (slotN >= MAX_SLOTS) break;
    if (!TAG_RE.test(nm)) continue;
    const sl = sanitizeSlot(v);
    if (sl) { slots[nm] = sl; slotN += 1; }
  }
  const artifacts = s.artifacts && typeof s.artifacts === 'object' ? s.artifacts : null;
  const ax = Number(artifacts?.x); const ay = Number(artifacts?.y);
  const aw = Number(artifacts?.w); const ah = Number(artifacts?.h);
  const artOk = [ax, ay, aw, ah].every(Number.isFinite) && aw >= 48 && ah >= 24;
  return {
    ...(sanitizeBy(s.by) ? { by: sanitizeBy(s.by) } : {}),
    ...(typeof s.at === 'string' && s.at.length <= 40 ? { at: s.at } : {}),
    ...(typeof s.title === 'string' && s.title.trim() ? { title: s.title.trim().slice(0, 60) } : {}),
    /**
     * 这一摞正着读还是倒着读（2026-09-01 刀 2，站主点名的参数）。
     *
     *   desc（缺省）= 最新的一页在最上面，读的人**跟着 agent 走** —— 一场戏、
     *                 一段日志、一次对话该是这样。
     *   asc         = 这一摞是一份文档：读的人停在第一页，自己往后翻。
     *
     * ⚠️ 只影响「用户还没翻过时停在哪一页」。翻页的方向和纸的顺序都不变
     * （纸永远按登记时间排，下＝更新的一页）—— 那是手势与内容的关系，不随参数走。
     */
    ...(s.order === 'asc' || s.order === 'desc' ? { order: s.order } : {}),
    /**
     * 这一摞的产物地（相对栈原点的像素，跟版位同一套坐标）。
     *
     * 产物地原来是**纸**的属性（版位的 `for:'artifacts'`）。叠纸之后那样不成立：
     * 两张叠在一起的纸各规划一块产物地，两件产物会落在同一块世界坐标上互相压，
     * 而产物是**不参与叠放**的（这一版栈只叠墨：板书、手写字、涂鸦）。所以这块
     * 地升到栈上，一摞纸共享一块，翻页只换正文，产物原地不动。
     */
    ...(slotN ? { slots } : {}),
    ...(artOk ? {
      artifacts: {
        x: Math.round(Math.min(Math.max(-12000, ax), 12000)),
        y: Math.round(Math.min(Math.max(-12000, ay), 12000)),
        w: Math.round(Math.min(aw, 12000)),
        h: Math.round(Math.min(ah, 12000)),
      },
    } : {}),
  };
}

export function sanitizeBoard(raw) {
  const size = sanitizeSize(raw?.size);
  const objects = {};
  const zones = {};
  const bindings = {};
  let count = 0;
  for (const [id, o] of Object.entries(raw?.objects && typeof raw.objects === 'object' ? raw.objects : {})) {
    if (count >= MAX_OBJECTS) break;
    if (!isSafeCanvasId(id)) continue;
    const s = sanitizeObject(o, size);
    if (s) { objects[id] = s; count += 1; }
  }
  let zCount = 0;
  for (const [id, z] of Object.entries(raw?.zones && typeof raw.zones === 'object' ? raw.zones : {})) {
    if (zCount >= MAX_ZONES) break;
    if (!isSafeCanvasId(id)) continue;
    const s = sanitizeZone(z);
    if (s) { zones[id] = s; zCount += 1; }
  }
  let bCount = 0;
  for (const [id, b] of Object.entries(raw?.bindings && typeof raw.bindings === 'object' ? raw.bindings : {})) {
    if (bCount >= MAX_BINDINGS) break;
    if (typeof id !== 'string' || id.length > 300) continue;
    const s = sanitizeBinding(b);
    if (s) { bindings[id] = s; bCount += 1; }
  }
  // 主角覆盖（2026-08-14 agent 摆位）：显式立的主角压过前端 pickHero 的推断。
  // 存 id 不存理由 —— 理由在会话里，画布只要知道谁站 C 位
  const hero = typeof raw?.hero === 'string' && raw.hero.length <= 300 ? raw.hero : null;
  const lanes = {};
  let lCount = 0;
  for (const [name, l] of Object.entries(raw?.lanes && typeof raw.lanes === 'object' ? raw.lanes : {})) {
    if (lCount >= MAX_LANES) break;
    const tag = sanitizeTag(name);
    if (!tag) continue;
    const s = sanitizeLane(l);
    if (s) { lanes[tag] = s; lCount += 1; }
  }
  const rolls = {};
  let rCount = 0;
  for (const [name, r] of Object.entries(raw?.rolls && typeof raw.rolls === 'object' ? raw.rolls : {})) {
    if (rCount >= MAX_LANES) break;   // 卷跟线同量级：一线一卷
    const tag = sanitizeTag(name);
    if (!tag) continue;
    const s = sanitizeRoll(r);
    if (s) { rolls[tag] = s; rCount += 1; }
  }
  const sheets = {};
  let sCount = 0;
  for (const [name, s0] of Object.entries(raw?.sheets && typeof raw.sheets === 'object' ? raw.sheets : {})) {
    if (sCount >= MAX_SHEETS) break;
    const nm = sanitizeTag(name);
    if (!nm) continue;
    const s = sanitizeSheet(s0);
    if (s) { sheets[nm] = s; sCount += 1; }
  }
  // 栈（2026-09-01 叠纸）：一摞纸的身份。几何不在这儿，见 sanitizeStack 头注。
  const stacks = {};
  let stCount = 0;
  for (const [name, s0] of Object.entries(raw?.stacks && typeof raw.stacks === 'object' ? raw.stacks : {})) {
    if (stCount >= MAX_STACKS) break;
    const nm = sanitizeTag(name);
    if (!nm) continue;
    const s = sanitizeStack(s0);
    if (s) { stacks[nm] = s; stCount += 1; }
  }
  /**
   * 跟随规则（2026-08-30）：`{ 组tag: { target, side?, label? } }`。
   *
   * 以前 follow 只有「线」这一种形态，而线要求两端**此刻都在板上**。真会话里最常见的
   * 写法是开场先立规则再写第一章（skill 的原话就是「开场画一次状态板，然后立一条跟随
   * 规则」）—— 那一刻目标 tag 还是空的，于是必炸。全库 5 次、跨 4 个项目，形态一模一样。
   * 规则和线分开存之后，规则可以先立着，目标一出现 applyFollows 顺手把线接上。
   */
  const follows = {};
  let fCount = 0;
  for (const [g, r] of Object.entries(raw?.follows && typeof raw.follows === 'object' ? raw.follows : {})) {
    if (fCount >= 12) break;
    const gt = sanitizeTag(g);
    const target = sanitizeTag(r?.target);
    if (!gt || !target || gt === target) continue;
    follows[gt] = {
      target,
      ...(['right', 'left', 'above', 'below'].includes(r?.side) ? { side: r.side } : {}),
      ...(typeof r?.label === 'string' && r.label.trim() ? { label: r.label.trim().slice(0, 60) } : {}),
    };
    fCount += 1;
  }
  /**
   * 待摆产物（2026-08-30 刀 G）：磁盘上有、但板上还没地方放的工作区相对路径。
   * 入座不再自己铺纸（那是「机器替 agent 定版面」），排不下就进这条队列，
   * 每回合状态块点名，等 agent 规划出地方再落座。
   */
  const pending = [];
  for (const v of Array.isArray(raw?.pending) ? raw.pending : []) {
    if (pending.length >= 50) break;
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (!t || t.length > 300 || t.includes('..') || t.startsWith('/')) continue;
    if (!pending.includes(t)) pending.push(t);
  }
  // 暂存架原点（2026-08-30，lib/board-shelf.js）：机器到货码放的竖带左上角
  const shelf = (raw?.shelf && Number.isFinite(Number(raw.shelf.x)) && Number.isFinite(Number(raw.shelf.y)))
    ? { x: clampNum(raw.shelf.x, -COORD_LIMIT, COORD_LIMIT, 0), y: clampNum(raw.shelf.y, -COORD_LIMIT, COORD_LIMIT, 0) }
    : null;
  return {
    size, zones, objects, bindings,
    ...(hero ? { hero } : {}), ...(lCount ? { lanes } : {}), ...(rCount ? { rolls } : {}),
    ...(sCount ? { sheets } : {}),
    ...(stCount ? { stacks } : {}),
    ...(fCount ? { follows } : {}),
    ...(pending.length ? { pending } : {}),
    ...(shelf ? { shelf } : {}),
  };
}

