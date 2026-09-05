import { DECK_EMBED_W } from './board-geometry.js';

/**
 * 产物卡的脚印。
 *
 * 形状 = 一条小顶栏（图标 + 名字）+ 下面一块实时预览，也就是 2026-08-13 之前
 * 那个"展开态"的样子。中间试过 200×200 的方卡（缩略图在上、名字在下），
 * 用户看完的评价是丑 —— 一块 200 宽的缩略图既看不清版式也看不清字，
 * 那张卡既不是图标也不是预览，卡在中间。
 *
 * 现在它只有这一种样子（**没有收起态**）。取的正是老展开态的尺寸，所以
 * 预览的缩放比例、iframe 画幅这些都跟当时一致。
 */
export const ARTIFACT_HEADER_H = 28;
const artifactCard = (previewH) => ({ w: DECK_EMBED_W, h: ARTIFACT_HEADER_H + previewH });

/** 各形态的预览区高度：deck 是 16:9 设计稿，站点取一屏，世界要摊开地图 */
// browse 是 1366×768 视口按 640 宽等比缩 = 360（08-21 视口随 browser_computer 改 16:9，坐标 1:1）
export const ARTIFACT_PREVIEW_H = { deck: 360, site: 400, docx: 420, browse: 360, stage: 400 };  // docx 是竖版 A4，给高一点；stage 取一屏戏
/** 主角档放大倍数（北极星路线1）：预览区放大、顶栏不变 —— sizeOf 与
 *  ArtifactCard 的画框都从这儿算，两处必须同源否则命中区和视觉错位 */
export const HERO_SCALE = 1.5;

/**
 * 形态能力表 —— 每种画布物件「是什么、能做什么」写在一张表里。
 *
 * ## 为什么要有这张表
 *
 * 2026-08-07 清点：BoardCanvas 里散着 49 处 `o.type === '…'` 分支，分布在
 * 五件互不相干的事情上 —— 归属派生、打开行为、hover 工具条、卡体渲染、
 * 收纳带兜底。**每加一种形态就要在十几个地方补 if**，而画布升级要加的
 * annotation / group 至少两种，arrow 还要另开一层。再不立表就是一百多处分支。
 *
 * 思路取自 tldraw 的 `ShapeUtil`：每种形状用一张显式的能力表声明自己
 * （`canBind` / `canResize` / `canEdit` / `getGeometry` / `component`…），
 * 调用方问表，不写分支。**抄的是这个思路，不是它的代码** —— tldraw 是专有
 * 许可证，产品里不能出现它的源码。
 *
 * ## 两条轴
 *
 * - `backing`：这个物件的真相在**磁盘**、只在 **board.json**、还是在**运行时**。
 *   现有七种全是 `file`（产物即真相，路径派生归属），只有 `doc` 例外（它是
 *   记忆/品牌/指引三张卡的画布分身）。**annotation 会是第一个真正的 canvas
 *   物件**：agent 写在画布上的说明文字不对应任何文件，删了也不该动磁盘。
 *   凡是「加入上下文」「打开原始文件」「按路径派生归属」这类动作，都只对
 *   `file` 成立，所以这条轴必须显式写出来，不能靠有没有 `path` 猜。
 * - `variant`：同一种 type 因为自身属性走不同行为。目前只有一例 ——
 *   `.md` 文件也是 `file`，但它能进阅读器（2026-08-03 加的路由）。
 *   放在表里当变体，而不是在调用点写 `type === 'file' && isMarkdown(o)`。
 * - `chrome`：这个物件长不长得像**一张纸**（底色 / 描边 / 影子 / 大圆角）。
 *   `'bare'` = 不是卡片，是画布上的一笔（涂鸦、手写文字）。
 *   2026-08-13 加：在这之前判据是 BoardObject 里硬编码的
 *   `o.type === 'scribble'`，于是 `text` 加进来的时候漏了 —— 画布文字外面
 *   套着一张白卡，而它自己的注释写着"没有卡片外观，就是一段字浮在纸上"。
 *   **这条轴不能用 `backing` 代替**：`doc` 也是 canvas backing，但它要卡片外观。
 * - `card`：卡体由哪个渲染器画。`'artifact'` = 三种产物共用的那张方卡
 *   （`components/canvas/cards/ArtifactCard.jsx`）；其余仍在 BoardObject 里
 *   各画各的 —— 它们每种只有一个分支，没有重复可收。
 *
 * ## 展开态 2026-08-13 退役
 *
 * deck / 站点 / 世界原来各有"收起卡"和"展开成内嵌渲染"两态，六个分支抄了
 * 六遍。现在卡片只有一种样子（方卡 + 实时缩略图），双击直接开那扇窗。
 * 换来的是**尺寸恒定** —— 布局系统按矩形排布，一个会自己变大两倍半的卡片
 * 是所有防遮盖逻辑的噪声源。`sizeExpanded` 随之从表里删除。
 *
 * ⚠️ 存量数据里还有 `expanded: true`（服务端 sanitizeObject 会一直保留它）。
 * `sizeOf` 不再读这个字段 —— 留着读的话，老卡会带着 640×388 的**隐形脚印**
 * 参与命中判定和落点计算，而渲染出来只有 200 宽，手感会玄学到没法查。
 */

/** 能渲染的 markdown（`.md` / `.markdown`）。 */
export function isMarkdown(o) {
  return /\.(md|markdown)$/i.test(o?.ext || o?.name || o?.path || '');
}

/** json（2026-08-29 刀 B）：卡面画结构预览、双击进站内键值树显示器。 */
export function isJson(o) {
  return /\.json$/i.test(o?.ext || o?.name || o?.path || '');
}

/** 带内容预览的文本文件（08-24：文件卡从细条升级；与服务端 PREVIEW_EXTS/estimateSize 同口径） */
export function isTextPreview(o) {
  return /\.(md|markdown|txt|json|csv|ya?ml)$/i.test(o?.ext || o?.name || o?.path || '');
}

/** 演出的编排配置（`编排.yaml`）——双击进图形设置页，跟 .md 进阅读器同路数。 */
export function isOrchestration(o) {
  return /(^|\/)编排\.yaml$/.test(o?.path || o?.name || '');
}

/**
 * 形态注册表。
 *
 * 字段：
 * - `label`        中文名，给调试和无障碍标签用
 * - `backing`      `'file'` = 磁盘产物 / `'canvas'` = 只活在 board.json /
 *                  `'runtime'` = 真相在服务端进程里（浏览器卡，见下）。
 *                  只有 `'file'` 能加入上下文 / 改名 / 搬家 / 导出（`isFileBacked`）；
 *                  另两种各自不能的东西不一样，所以不能合并成一个布尔
 * - `size`         卡片脚印（布局系统按矩形排布，尺寸必须可预知）。
 *                  **卡体是 height:auto，这里的高度只用来占位** —— 声明得比
 *                  实渲高，每一行就白留那么多；2026-08-07 在浏览器里逐个量过
 *                  offsetHeight 校准，改卡体高度时要回来一起改
 * - `chrome`       `'card'` = 一张纸（底色/描边/影子/大圆角）/ `'bare'` = 一笔墨
 * - `card`         卡体渲染器：`'artifact'` = 三种产物共用的方卡；
 *                  缺省 = 仍在 BoardObject 里各画各的
 * - `reader`       双击/「阅读」进哪个阅读器：
 *                  `'file'` 拉原始文件正文、`'note'` 剥 frontmatter 后读、
 *                  `null` 没有阅读器
 * - `primary`      双击的默认动作：`'read'|'detail'|'open'|'openFile'`
 * - `actions`      hover 工具条按钮，**顺序即渲染顺序**
 * - `legacyBucket` 没有工作区可归时掉进桌面底部收纳带的哪一摞
 * - `category`     **内容轴**：这东西是什么。桌面过滤的两条轴之一，见 CATEGORIES
 */
// （doc 形态 2026-08-24 拆除：记忆/品牌/指引的画布分身退役 —— 记忆住 记忆/、
//  档案在根 CLAUDE.md，都是普通文件卡）
export const KINDS = {
  deck: {
    label: '幻灯',
    category: 'work',
    backing: 'file',
    chrome: 'card',
    card: 'artifact',
    size: artifactCard(ARTIFACT_PREVIEW_H.deck),
    reader: null,
    primary: 'open',
    // 方卡整张就是"打开"的按钮（双击 / 点缩略图），不外挂 hover 工具标
    actions: [],
    legacyBucket: 'deck',
  },

  site: {
    label: '站点',
    category: 'work',
    backing: 'file',
    chrome: 'card',
    card: 'artifact',
    size: artifactCard(ARTIFACT_PREVIEW_H.site),
    reader: null,
    primary: 'open',
    actions: ['add'],
    legacyBucket: 'art',
    // 目录型实例判据（卡即文件夹）：单页（_drafts）是一个文件，其余站都是一棵树。
    // 与服务端 kinds/site.js 的同名声明一对，调用点只问 isDirArtifact
    directory: (o) => !o.single,
  },


  // word 文档（2026-08-17）。预览是**一张页图**不是活页面 —— 服务端一次渲整份、
  // 按源 mtime 缓存（lib/docx-pages.js），卡上只看第一页，翻页是窗里的事。
  docx: {
    label: '文档',
    category: 'work',
    backing: 'file',
    chrome: 'card',
    card: 'artifact',
    size: artifactCard(ARTIFACT_PREVIEW_H.docx),
    reader: null,
    primary: 'open',
    actions: ['add'],
    legacyBucket: 'doc',
    // 目录型实例判据：word 文件夹带成员表；根层散放的单份 .docx 是单文件产物
    directory: (o) => !!o.members,
  },

  /**
   * agent 的浏览器（2026-08-18）。**唯一一张 backing 既不是 file 也不是 canvas
   * 的卡** —— 它的真相是一段浏览痕迹（服务端 `.browser/state.json`），
   * 背后那只 chromium 是运行时，可以不在。
   *
   * 所以：不能加入上下文（没有工作区路径可给）、没有阅读器、没有导出、
   * 删不掉（它不是文件；不逛了自然就没了）。
   *
   * ⚠️ `backing` 给它开了第三个值 `'runtime'`，**不能拿 `'canvas'` 凑**：
   * `sizeOf` 对 canvas backing 会去读 `pos.w/h`（涂鸦的尺寸是画出来的），
   * 这张卡一旦被写进过带 w/h 的 layout 就会顶着一个错的脚印参与命中判定 ——
   * 正是"存量 expanded 隐形脚印"那个病的形状。
   *
   * 卡上的预览是**上次看到的样子**（服务端存的一帧 webp），跟 word 卡的页图
   * 同一路数。活画面流只在窗里给：实测每 fps 约 3.1pp 单核。
   */
  browse: {
    label: '浏览器',
    category: 'tool',
    backing: 'runtime',
    chrome: 'card',
    card: 'artifact',
    size: artifactCard(ARTIFACT_PREVIEW_H.browse),
    reader: null,
    primary: 'open',
    actions: [],
    legacyBucket: 'art',
  },

  /**
   * 演出（RP 显示器，2026-09-05）。真相是任务目录下的 `stage/`（stage.json 设定 +
   * scenes.jsonl 一拍一行 + memory/），所以是 file backing、目录型（卡即文件夹）。
   *
   * 卡上和窗里装的是**同一个页面**（服务端 /stage/view 现渲染，SSE 推每一拍），
   * 差别只在 `?embed=1` 少了输入框。工具栏切成 RP 专用那条（StageWindow）。
   * 没有导出：要留档就是那个文件夹本身。
   */
  stage: {
    label: '演出',
    category: 'work',
    backing: 'file',
    chrome: 'card',
    card: 'artifact',
    size: artifactCard(ARTIFACT_PREVIEW_H.stage),
    reader: null,
    primary: 'open',
    actions: [],
    legacyBucket: 'art',
    directory: () => true,
  },

  image: {
    chrome: 'card',
    label: '图片',
    category: 'material',
    backing: 'file',
    size: { w: 200, h: 176 },
    reader: null,
    primary: 'detail',
    actions: ['add', 'detail'],
    legacyBucket: 'art',
  },

  // 视频（roll_film / paint_still 产线的 mp4/webm，2026-08-08 main 加、
  // 合流时移植进形态表）：16:9 播放器卡，播放走既有 Range+派生档管线
  video: {
    chrome: 'card',
    label: '视频',
    category: 'material',
    backing: 'file',
    size: { w: 240, h: 160 },
    reader: null,
    primary: 'openFile',
    actions: ['add', 'open'],
    legacyBucket: 'file',
  },

  note: {
    chrome: 'card',
    label: '便签',
    category: 'material',
    backing: 'file',
    size: { w: 200, h: 148 },
    reader: 'note',
    primary: 'read',
    actions: ['add', 'read', 'delete'],
    legacyBucket: 'art',
    /**
     * 板书（2026-08-23 黑板三期）：agent/用户写在画布上的话。本体仍是 notes/板书/ 下
     * 的 .md（删/导出/寻址全沿用便签），只是脸不同 —— 裸 md 文字浮在纸上，没有卡
     * 片外观；尺寸由落盘时的估算 w/h 定（见 sizeOf）。
     */
    variant: (o) => (o?.chalk ? { chrome: 'bare', label: '板书', category: 'ink', primary: 'editText', actions: ['read', 'delete'] } : null),
  },

  /**
   * 涂鸦 —— **第一个真正的画布原生物件**（2026-08-07）。
   *
   * 它不对应任何文件：笔画只活在 board.json 里（服务端 `CANVAS_NATIVE_KINDS`
   * 白名单登记）。所以 `backing: 'canvas'`，而这条轴带来的后果是具体的：
   * 不能加入上下文（没有 path 可给）、没有阅读器、删它不动磁盘、
   * **agent 读不到它**。
   *
   * 最后那条是设计取舍不是缺陷：涂鸦是用户给自己做的记号（圈一下、划条线），
   * 要说给 agent 听的话走右键「新建便利贴」（落盘成 .md，进它的注入清单）。
   *
   * 尺寸由笔画包围盒定，不走这张表 —— 这里的 size 只是兜底。
   */
  scribble: {
    chrome: 'bare',
    label: '涂鸦',
    category: 'ink',
    backing: 'canvas',
    size: { w: 160, h: 120 },
    reader: null,
    primary: null,
    actions: ['delete'],
    legacyBucket: 'art',
    // 拉远了也照画（2026-08-31 分级渲染）：换脸的前提是"内容缩小之后变成噪点、
    // 而名字比它有信息量"。一笔画缩小了还是那笔画，而它的名字就是「一笔涂鸦」——
    // 换过去等于把有信息的东西换成没信息的。判据在 board-lod.test.js。
    farFace: false,
  },

  /**
   * 画布文字（2026-08-08）：写在白板上的一句话。
   *
   * 跟便利贴的分工：**便利贴是给 agent 看的**（落盘成 .md，进它的注入清单），
   * **画布文字是给自己看的**（只活在 board.json）。以前画布上打的字一律走
   * 便签那条路，理由是"agent 读得到"—— 但用户要的是在工程文件旁边随手写一句，
   * 那是记号不是指令。想让 agent 看见的走右键「新建便利贴」。
   *
   * 尺寸跟涂鸦一样由内容决定（sizeOf 读 pos.w/h），这里给的是没量过时的兜底。
   */
  text: {
    chrome: 'bare',
    label: '文字',
    category: 'ink',
    backing: 'canvas',
    size: { w: 220, h: 40 },
    reader: null,
    // 2026-08-13 从 null 改成编辑：写下的字原来永远改不了 —— 双击什么都
    // 不发生，是"操作字框还弹新建输入框"那批投诉的另一半
    primary: 'editText',
    actions: ['delete'],
    legacyBucket: 'doc',
  },

  file: {
    chrome: 'card',
    label: '文件',
    category: 'material',
    backing: 'file',
    size: { w: 224, h: 32 },
    reader: null,
    primary: 'openFile',
    actions: ['add', 'open'],
    legacyBucket: 'file',
    // `.md` 也是 file，但它能进阅读器：「阅读」是渲染过的（双击默认走这条），
    // 「打开」仍留着给原始文件。frontmatter 不剥 —— 便签的 `---` 头是会话
    // 元数据该藏，普通 md 的 frontmatter 是内容的一部分。
    variant: (o) => {
      if (isMarkdown(o)) return { reader: 'file', primary: 'read', actions: ['add', 'read', 'open'] };
      // 编排.yaml：双击/「编排」按钮进图形设置页；「打开」留给原始文件
      if (isOrchestration(o)) return { label: '编排', primary: 'orchestrate', actions: ['orchestrate', 'open'] };
      // json（2026-08-29 刀 B）：跟 .md 同路数 —— 双击进站内显示器（可折叠键值树），
      // 「打开」仍留给原始文件。以前双击直接把原文丢给浏览器自带的 json 查看器。
      if (isJson(o)) return { reader: 'json', primary: 'read', actions: ['add', 'read', 'open'] };
      return null;
    },
  },
};


/** 未知 type 一律按 file 处理（跟老的 `SIZES[o.type] || SIZES.file` 同口径）。 */
export function kindOf(o) {
  return KINDS[o?.type] || KINDS.file;
}

/** 形态能力 + 变体覆盖。**所有调用点都该问这个，不要直接读 KINDS。** */
export function traitsOf(o) {
  const k = kindOf(o);
  const v = k.variant?.(o);
  return v ? { ...k, ...v } : k;
}

/**
 * 物件占的矩形。
 *
 * **画布原生物件（涂鸦）自带尺寸**：它的大小是画出来的，不是形态表能预设的。
 * 创建时就把真实包围盒写进了 `layout.w/h`，这里必须读回来 —— 2026-08-07 前
 * 这两个字段写了没人读，涂鸦一律按形态表的 160×120 算，于是画一条长线只有
 * 左上角那一块能拖，笔画其余部分看得见摸不着（靠 `overflow:visible` 才画得出
 * 来），鼠标落上去直接穿透去平移画布。写了没人读的字段就是这么坑人的。
 */
export function sizeOf(o) {
  const k = kindOf(o);
  // 板书（文件本体）也带落盘尺寸：agent 写入时按正文估好写进 layout.w/h
  if ((k.backing === 'canvas' || o?.chalk) && o?.pos?.w > 0 && o?.pos?.h > 0) {
    return { w: o.pos.w, h: o.pos.h };
  }
  // 主角档（tier 由入座时的 pickHero 标）：预览区 ×HERO_SCALE、顶栏原高
  if (o?.tier === 'hero' && ARTIFACT_PREVIEW_H[o?.type] != null) {
    return {
      w: Math.round(DECK_EMBED_W * HERO_SCALE),
      h: ARTIFACT_HEADER_H + Math.round(ARTIFACT_PREVIEW_H[o.type] * HERO_SCALE),
    };
  }
  // 文本类文件卡带预览体（08-24），身位=note（服务端 estimateSize 同口径，parity 钉着）
  if (o?.type === 'file' && isTextPreview(o)) return KINDS.note.size;
  // ⚠️ 这里曾经是 `(o.pos.expanded && k.sizeExpanded) || k.size`。展开态退役后
  // 存量数据里的 `expanded: true` 必须**读都不读** —— 读了老卡就会带着
  // 640×388 的隐形脚印参与命中和落点计算，渲染却只有 200 宽。
  return k.size;
}

/** 长得像一张纸，还是画布上的一笔墨。 */
/** 中文名（标注浮层、无障碍标签用） */
export function labelOf(o) {
  return traitsOf(o).label || '产物';
}

/**
 * 拉远之后换不换脸（2026-08-31 分级渲染）。
 *
 * 缺省换。⛔ 只有"内容本身就是一幅画、而且没有比它更有信息量的名字"的形态才写
 * `farFace: false`，理由写在那条形态条目上。别拿它当"我这张卡很重要"的标记 ——
 * 每多一个豁免，拉远看全局时就多一张糊掉的卡。
 */
export function farFaceOf(o) {
  return traitsOf(o).farFace !== false;
}

/**
 * 这张卡叫什么（2026-08-31 从 BoardCanvas 的 titleOfId 抽出来）。
 *
 * 两个读者：连线浮层说「A 指向 B」时要念的名字，和拉远之后卡片上画的那个名字
 * （cards/FarFace.jsx）。⭐ 抽出来是因为第二个读者出现的时候，原地再写一遍
 * "怎么称呼一张卡"必然跟第一份分叉 —— 画布上写着一个名字、连线弹窗里念另一个。
 *
 * ⚠️ 墨类没有名字可用，只能拿内容顶上：手写字取头 14 个字，涂鸦压根没有内容。
 * 板书优先 frontmatter 的标题，没有标题才退到正文首行 —— 退到文件名（xxx.md）
 * 是最差的一档，那个名字用户从来没见过。
 */
export function titleOf(o) {
  if (!o) return '';
  if (o.type === 'text') return `「${String(o.data?.t || '').slice(0, 14)}」`;
  if (o.type === 'scribble') return '一笔涂鸦';
  if (o.chalk && !o.title) {
    const first = String(o.text || '').split('\n').find(l => l.trim());
    if (first) return first.replace(/^#+\s*/, '').slice(0, 24);
  }
  return o.title || String(o.id || '').split('/').pop() || String(o.id || '');
}

export function chromeOf(o) {
  return traitsOf(o).chrome || 'card';
}

/** 卡体由哪个渲染器画（缺省 = BoardObject 里各画各的）。 */
export function cardOf(o) {
  return kindOf(o).card || null;
}

/** 真相在磁盘上吗（决定能否加入上下文 / 打开原始文件 / 按路径派生归属）。 */
export function isFileBacked(o) {
  return kindOf(o).backing === 'file';
}

/**
 * 拖拽落点能不能引发**文件搬家**（BoardCanvas 的落点提示与 drag-end 都问这条）。
 * 板书（chalk）是画布上的"话"：位置自由、归属钉死 notes/板书/ —— 误触搬家会丢
 * chalk 身份渲染成普通细条卡（08-24 案 iss_mt5qujy1；服务端 move-entry 同判据立闸，
 * 这里是体验层：连落点提示都不给，用户就不会以为能搬）。
 */
export function dragMovesFile(o) {
  if (o?.chalk) return false;
  return isFileBacked(o);
}

/**
 * 目录型产物实例（卡即文件夹：目录站、word 文件夹）。判据由形态条目自己声明
 *（`directory(o)`，与服务端 kinds/ 的同名声明成对），调用点别再写
 * `type === 'docx' && o.members` 这种组合 —— 那是「一个事实多份算法」的病根。
 */
export function isDirArtifact(o) {
  return !!kindOf(o).directory?.(o);
}

/** hover 工具条要哪几个按钮，顺序即渲染顺序。 */
export function actionsOf(o) {
  return traitsOf(o).actions;
}

/**
 * 能不能加进上下文托盘。
 *
 * 单卡的「＋」和工作区头的「＋全部加入上下文」必须同一个判据 —— 重构前
 * 它们是两处各写各的 `o.type !== 'deck'`，改一处漏一处只是时间问题。
 */
export function canAddToContext(o) {
  return actionsOf(o).includes('add');
}

/** 双击的默认动作。 */
export function primaryOf(o) {
  return traitsOf(o).primary;
}

/** 进哪个阅读器（null = 没有阅读器）。 */
export function readerOf(o) {
  return traitsOf(o).reader;
}

/** 没有工作区可归时掉进收纳带的哪一摞。 */
export function legacyBucketOf(o) {
  return kindOf(o).legacyBucket;
}

/**
 * 尺寸表的兼容出口。
 *
 * 老代码按 `SIZES.deck` / `SIZES.deckExpanded` 这样取值，这里原样铺平一份，
 * 免得为了立表把十几个调用点一起改。新代码请用 `sizeOf(o)`。
 */
export const SIZES = Object.fromEntries(
  Object.entries(KINDS).map(([k, v]) => [k, v.size]),
);

/**
 * 物件 → 标注浮层的 target 描述（2026-08-17 从 BoardCanvas 收进来）。
 *
 * 收在这儿的理由：这个形状在画布上有两处要一字不差 —— hover 工具条那颗标注
 * 按钮和右键菜单那条（BoardObject 的注释里明写着"逐字一致"）。抄两份的东西
 * 迟早分叉，而分叉的症状是"从右键标注和从按钮标注，agent 收到的对象不一样"，
 * 没人查得出来。
 *
 * `path` 那行的意思：卡 id 可能带形态前缀（`site:` / `deck:`），标注要的是真路径。
 */
export function annotTargetOf(o, roleNames = null) {
  // 摘录（2026-08-23 黑板）：用户在 agent 写的字上回应时，agent 得看见那段字写了什么
  // —— 画布原生手写字 agent 读不回来，板书虽是文件但一句摘录省它一次 Read
  const raw = o.type === 'text' ? (o.data?.t || '') : (o.chalk ? (o.text || '') : '');
  const excerpt = raw ? raw.replace(/\s+/g, ' ').trim().slice(0, 120) : null;
  return {
    kind: 'object',
    id: o.id,
    path: o.path || (typeof o.id === 'string' && /^[a-z]+:/.test(o.id) ? o.id.slice(o.id.indexOf(':') + 1) : o.id),
    title: o.title || o.name || o.id,
    typeLabel: labelOf(o),
    ...(excerpt ? { excerpt } : {}),
    // by 三类：'user' / 'agent' / 常驻角色 slug（rp-*）。手写字那支原来只认 'agent'，
    // 现在角色画的原生 text 也要认出来（否则标注它时会被说成"用户写的"，判正好相反）。
    ...(o.chalk
      ? { chalk: true, by: o.chalk.by || 'agent' }
      : (o.native && byOfNative(o) ? { by: byOfNative(o) } : {})),
    // 展示名随手带上：组标注消息的那一层（ProjectWorkspace）够不到 roleNames
    ...(roleNames ? { byName: roleNames[o.chalk?.by || byOfNative(o)] || null } : {}),
  };
}

/** 画布原生物件（手写字/涂鸦）的作者：agent 或某个常驻角色 */
function byOfNative(o) {
  const v = o.pos?.by || o.by;
  return v === 'agent' || (typeof v === 'string' && v.startsWith('rp-')) ? v : null;
}

/**
 * 任务里的一份产物 → 画布上那张卡的 id（2026-08-17 从 BoardCanvas 收进来）。
 *
 * 这个规则**是导出的寻址地址**：服务端 `export-collect.parseCardId` 按同一套前缀
 * 判据反解它。原来它是 BoardCanvas 里两处内联字符串，导出菜单要用第三处 ——
 * 抄第三遍之前先收成一份。
 */
export function cardIdOf(taskId, a) {
  // site 是目录型产物：地址是产物根，不是某个文件
  if (a.kind === 'site') return `site:${a.single ? a.entryRel : (a.root || taskId)}`;
  // 演出：地址 = 那个 stage/ 文件夹（/artifacts 已把 root 拼成工作区相对路径）
  if (a.kind === 'stage') return `stage:${a.root}`;
  // word 文件夹（带成员表）也是目录型：卡即文件夹，地址 = 文件夹路径。
  // 根层散放的单份 .docx 没有 members，走下面的单文件规则
  if (a.kind === 'docx' && a.members) return `docx:${a.root}`;
  // 其余都是单文件产物（deck 的 .html、docx 的 .docx）：前缀 = 形态名，地址 = 文件。
  // 别写死 'deck:' —— 加形态时忘了这行，新产物的卡 id 会伪装成 deck，
  // 导出那头按 deck 去解析它，错得很安静。
  return `${a.kind || 'deck'}:${a.file}`;
}

