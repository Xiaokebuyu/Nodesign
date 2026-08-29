/**
 * 检查通道的假数据（`scripts/inspect.mjs` 用）。
 *
 * ## 为什么是假数据而不是连真后端
 *
 * 8443 有登录墙，拿 playwright 去撞登录墙意味着要处理密码 —— 那条路不走。
 * 而且真数据每天在变，"上次看着好好的"没法复现。假数据这边：**一份固定的
 * 桌面**，形态凑齐（deck / 站点 / 世界 / 图片 / 便签 / 普通文件 / 文件夹 /
 * 嵌套文件夹），改完前后两张图能逐像素比。
 *
 * ## 怎么加
 *
 * 跑 inspect 时未匹配的接口会打在 `unmatched` 里（并回一个空对象兜住）。
 * 看到它就来这儿补一条 —— **别去改前端迁就检查台**。
 */

export const PROJECT_ID = 'p_demo';
export const SESSION_ID = 's_demo';

/** 一份固定的桌面：形态凑齐，且带一层嵌套文件夹 */
const TASKS = [
  {
    id: '', title: 'Demo 项目', kind: 'mixed', sessionId: null,
    mtime: '2026-08-13T02:00:00.000Z',
    artifacts: [
      { kind: 'deck', file: '主稿.html', entryRel: '主稿.html', title: '主稿', exports: ['html', 'pdf', 'pptx', 'handoff'] },
    ],
  },
  {
    id: '鉴赏页', title: '鉴赏页', kind: 'mixed', sessionId: null,
    mtime: '2026-08-13T03:00:00.000Z',
    artifacts: [
      { kind: 'deck', file: '鉴赏页/初稿.html', entryRel: '鉴赏页/初稿.html', title: '初稿', exports: ['html', 'pdf'] },
      {
        kind: 'site', root: '鉴赏页/站点', base: '鉴赏页/站点', srcRoot: '鉴赏页/站点',
        entry: 'index.html', entryRel: '鉴赏页/站点/index.html',
        pages: ['index.html', 'about.html'], title: '研究站', exports: ['site', 'html', 'handoff'],
      },
    ],
  },
  {
    id: '雾都', title: '雾都', kind: 'world', sessionId: null,
    mtime: '2026-08-13T04:00:00.000Z',
    artifacts: [
      {
        kind: 'world', root: '雾都', base: '雾都', entryRel: '雾都/世界.md', title: '雾都',
        exports: ['handoff'],
        nodes: [
          // 形状照 server/lib/kinds/world.js 的 nodes（type/path/name/parent/depth）
          { type: 'place', path: '世界/旧钟酒馆', name: '旧钟酒馆', parent: null, depth: 0, file: '地点.md' },
          { type: 'place', path: '世界/码头', name: '码头', parent: null, depth: 0, file: '地点.md' },
          { type: 'character', path: '世界/旧钟酒馆/维克多', name: '维克多', parent: '世界/旧钟酒馆', depth: 1, file: '角色.md' },
        ],
      },
    ],
  },
];

const ARTIFACTS = [
  { kind: 'note', path: 'notes/灵感.md', name: '灵感.md', ext: '.md', text: '# 灵感\n\n先做一版暖调的。', mtime: '2026-08-13T05:00:00.000Z' },
  { kind: 'task-file', path: '鉴赏页/数据.csv', name: '数据.csv', ext: '.csv', size: 20480, mtime: '2026-08-13T05:10:00.000Z' },
  // ⚠️ `isImage` 是前端分派图片卡的判据（BoardCanvas 只看它不看 kind），
  // 真服务端每条产物都带（assets.js 按扩展名算）。这里漏掉过一次 ——
  // 图片在检查通道里静默降级成 file 卡，而真站没病。假数据不同构比没有更坏。
  { kind: 'image', path: 'assets/generated/星空.webp', name: '星空.webp', ext: '.webp', isImage: true, hasThumb: false, size: 149614, mtime: '2026-08-13T05:20:00.000Z' },
  // isVideo 同 isImage：真服务端按扩展名给（assets.js VIDEO_EXTS），前端据此渲 16:9 播放器卡
  { kind: 'video', path: 'assets/generated/片段.mp4', name: '片段.mp4', ext: '.mp4', isVideo: true, size: 2400000, mtime: '2026-08-13T05:25:00.000Z' },
];

/** 文件夹清单（递归全量，含嵌套）——磁盘扫描的真相 */
// ⚠️ 不含 '雾都'：世界目录被 manifest 认领成一件产物，服务端的 claimed 机制
// 就不会再把它当文件夹吐出来（assets.js 里那段"它是产物，不是容器"）
const FOLDERS = ['鉴赏页', '鉴赏页/初稿'];  // ← 会被 createFolder / moveEntry 改

const BOARD = {
  size: { w: 4000, h: 2600 },
  // 大体留空走"首次落点"那条路（验自动排布）；墨类两件是例外 —— 它们的
  // 本体就在 board.json 里，不给就永远测不到（选中/变换/编辑都在它们身上）
  objects: {
    'text:demo1': {
      x: 620, y: 320, w: 140, h: 40, z: 5,
      kind: 'text', data: { t: '手写示例', font: 'pen', size: 'lg', color: 'ink', rotation: 20, scale: 1.5 },
    },
    'scribble:demo1': {
      x: 640, y: 420, w: 80, h: 40, z: 6,
      kind: 'scribble', data: { d: 'M 8 8 Q 28 38 48 16 L 72 28', color: 'ink', width: 2 },
    },
  },
  zones: {},
  bindings: {},
};

const SESSIONS = [
  { id: SESSION_ID, title: '做一版鉴赏页', updatedAt: '2026-08-13T05:30:00.000Z', createdAt: '2026-08-13T02:00:00.000Z', tag: null },
];

/**
 * ## 有状态
 *
 * 新建文件夹、搬家这类动作**必须真的改这份数据**，否则测不出"建完之后能不能
 * 拖进去"这种跨请求的流程 —— 而 2026-08-13 用户报的「目标文件夹不存在」正是
 * 那种：单看任何一个请求都是对的。
 */
function createFolder(parent, wanted = '新建文件夹') {
  let name = wanted;
  const full = () => (parent ? `${parent}/${name}` : name);
  for (let n = 2; FOLDERS.includes(full()); n += 1) name = `${wanted} ${n}`;
  FOLDERS.push(full());
  return full();
}

function moveEntry(from, to) {
  const base = from.split('/').pop();
  const next = to ? `${to}/${base}` : base;
  for (const a of ARTIFACTS) if (a.path === from) { a.path = next; a.name = base; }
  for (const t of TASKS) for (const a of (t.artifacts || [])) {
    if (a.file === from) a.file = next;
    if (a.entryRel === from) a.entryRel = next;
  }
  const i = FOLDERS.indexOf(from);
  if (i >= 0) FOLDERS[i] = next;
  return next;
}

/** 路径 → 响应。命中返回 {status?, json|body|contentType}，没命中返回 null */
export function resolve(pathname, method, body) {
  const p = pathname.replace(/^\/api/, '');

  if (method === 'POST' && p === `/projects/${PROJECT_ID}/folders`) {
    return { status: 201, json: { ok: true, folder: createFolder(body?.parent || '', body?.name) } };
  }
  if (method === 'POST' && p === `/projects/${PROJECT_ID}/rename`) {
    const from = String(body?.from || '');
    const parent = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
    const base = from.split('/').pop();
    const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')) : '';
    const next = (parent ? `${parent}/` : '') + String(body?.name || '').trim() + ext;
    if (!FOLDERS.includes(from) && !ARTIFACTS.some(a => a.path === from)
        && !TASKS.some(t => (t.artifacts || []).some(a => a.file === from))) {
      return { status: 404, json: { error: 'source not found' } };
    }
    // 前缀改名：它自己和它下面的一切
    for (let i = 0; i < FOLDERS.length; i += 1) {
      if (FOLDERS[i] === from) FOLDERS[i] = next;
      else if (FOLDERS[i].startsWith(`${from}/`)) FOLDERS[i] = next + FOLDERS[i].slice(from.length);
    }
    for (const a of ARTIFACTS) {
      if (a.path === from) { a.path = next; a.name = next.split('/').pop(); }
      else if (a.path.startsWith(`${from}/`)) a.path = next + a.path.slice(from.length);
    }
    for (const t of TASKS) {
      if (t.id === from) t.id = next;
      else if (t.id.startsWith(`${from}/`)) t.id = next + t.id.slice(from.length);
      // 标题从路径现算 —— 真服务端就是这么给的（assets.js: `title: rel.split('/').pop()`）。
      // 假数据要是只改 id 不改 title，就会做出"改完名字卡上还是旧名"的假象，
      // 而真环境里没有这回事。**假数据跟真服务端不同构，比没有假数据更坏。**
      t.title = t.id ? t.id.split('/').pop() : t.title;
      for (const a of (t.artifacts || [])) {
        for (const k of ['file', 'entryRel', 'root', 'base']) {
          if (a[k] === from) a[k] = next;
          else if (typeof a[k] === 'string' && a[k].startsWith(`${from}/`)) a[k] = next + a[k].slice(from.length);
        }
      }
    }
    return { json: { ok: true, from, to: next, renamed: true } };
  }
  if (method === 'POST' && p === `/projects/${PROJECT_ID}/move`) {
    const from = String(body?.from || '');
    const to = String(body?.to || '');
    /**
     * 照服务端那条判据：`to` 是**目标目录**，必须真的在清单里（'' = 根，永远在）。
     *
     * ⚠️ 这条校验一开始没写，POST 一律回 `{ok:true}` —— 于是 2026-08-13 那次
     * "拖进文件夹"的验证**假通过**了：客户端把新文件路径当目录发过去，真服务端
     * 回 404，而检查台照单全收。**假数据比真服务端宽松，等于把 bug 盖住。**
     */
    if (to && !FOLDERS.includes(to)) {
      return { status: 404, json: { error: 'target folder not found' } };
    }
    return { json: { ok: true, from, to: moveEntry(from, to), moved: true } };
  }

  if (p === '/me/usage') return { json: { usedToday: 0.12, limit: 50, username: 'demo', role: 'user' } };
  if (p === '/me/showcase') return { json: { items: [] } };
  /**
   * 默认已登录 —— 检查通道十有八九是来看工作台的，别每次先撞一次登录墙。
   *
   * `ND_INSPECT_AUTH=off` 反过来：回未登录，于是渲染的是**登录墙本身**。
   * 加这个开关是因为登录墙在这条通道里以前根本照不到（它是唯一一个"接口说
   * 没登录才出现"的页面），而它恰恰是最需要逐像素守门的那一页 —— 改版时的
   * 判据就是"拿登录页跟基线 diff 要求 0"。
   */
  if (p === '/auth/status') {
    return process.env.ND_INSPECT_AUTH === 'off'
      ? { json: { required: true, authed: false } }
      : { json: { authed: true, user: { username: 'demo', role: 'user' } } };
  }
  if (p === '/notices') return { json: { notices: [] } };
  if (p === '/plugins') return { json: { plugins: [] } };

  // 首页卡片那行元信息 + 板书预览。以前这条没喂，落到兜底的空对象上 ——
  // 于是"卡上写着什么"和"板书预览"在检查台里永远看不见
  if (p === '/projects/stats') {
    return { json: { stats: {
      [PROJECT_ID]: { tasks: 2, kinds: { deck: 1, site: 1 } },
      p_demo_rp: { tasks: 0, kinds: {}, chalk: { count: 12, text: '「……」\n我把桌上的口水渍用袖口蹭了蹭，装作没有这回事。\n「就眯了一会儿。」我拿起练习册晃了晃，遮住半张脸。' } },
    }, summary: { published: 2, usedToday: 0.02 } } };
  }
  // 两种纸各来一张：首页的项目卡按 mode 换纸（演出=稿纸、设计=横格本），
  // 只有一条 fixture 的时候另一种永远看不见 —— 检查台看不见的差别等于没做
  if (p === '/projects') {
    return { json: { projects: [
      { id: PROJECT_ID, name: 'Demo 项目', kind: 'project', mode: 'design' },
      { id: 'p_demo_rp', name: '雨夜事务所', kind: 'project', mode: 'rp' },
    ] } };
  }
  if (p === `/projects/${PROJECT_ID}`) {
    return { json: { project: { id: PROJECT_ID, name: 'Demo 项目', kind: 'project', candidates: [], skillId: 'nodesign' } } };
  }
  if (p === `/projects/${PROJECT_ID}/artifacts`) {
    return { json: { artifacts: ARTIFACTS, tasks: TASKS, folders: FOLDERS } };
  }
  if (p === `/projects/${PROJECT_ID}/board`) return { json: { board: BOARD } };
  if (p === `/projects/${PROJECT_ID}/sessions`) return { json: { sessions: SESSIONS } };
  if (p.startsWith(`/projects/${PROJECT_ID}/sessions/`)) {
    if (p.endsWith('/context-usage')) return { json: { used: 12000, limit: 200000 } };
    if (p.endsWith('/spec')) return { json: { spec: { decisions: [] } } };
    if (p.endsWith('/pending-changes')) return { json: { changes: [] } };
    if (p.endsWith('/config')) return { json: { config: {} } };
    if (p.endsWith('/model')) return { json: { model: 'claude-sonnet-5' } };
    return { json: {} };
  }
  if (p === `/projects/${PROJECT_ID}/memory`) return { json: { content: '' } };
  if (p === `/projects/${PROJECT_ID}/instruction`) return { json: { content: '' } };
  if (p === `/projects/${PROJECT_ID}/assets`) return { json: { assets: [] } };

  // 产物文件本身：给一张能一眼认出来的占位页，别让 iframe 空着
  if (p.includes('/artifact-file/')) {
    const name = decodeURIComponent(p.split('/artifact-file/')[1] || '').split('?')[0];
    if (/\.html?$/i.test(name)) {
      return {
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><meta charset="utf-8"><style>
          body{margin:0;font:600 42px/1.4 system-ui;display:flex;align-items:center;
          justify-content:center;height:100vh;background:#FFFEF6;color:#2B2117}
          </style><div>${name}</div>`,
      };
    }
    // 图片给一张 1×1 真图：图片卡上通道之后（isImage 补齐那次）<img> 会真发
    // 请求，404 会作为 console error 落进「errors 必须为空」的判据 ——
    // 判据一旦常态性带噪就没人看了，跟 WS 噪音同一条理由。
    if (/\.(png|jpe?g|webp|gif|svg)$/i.test(name)) {
      return {
        contentType: 'image/png',
        body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
      };
    }
    // 视频给 200 空体：假 mp4 解不出画面（媒体错误不进 console），但 404 会 ——
    // 判据零噪音比画面重要（这里只验"渲成了播放器卡"，不验播放）
    if (/\.(mp4|webm)$/i.test(name)) {
      return { contentType: 'video/mp4', body: Buffer.alloc(0) };
    }
    return { status: 404, json: { error: 'not found' } };
  }

  if (method !== 'GET') return { json: { ok: true } };
  return null;
}
