/**
 * stage.js — 舞台投影层的事件翻译（纯函数，无 React 依赖）
 *
 * 工作台画布 = agent 实时动作的展示区。这里把被动监听到的 run.* 事件翻译成
 * 舞台语义（哪个工具、什么形态、锚到哪个画布物件），BoardCanvas 的舞台层消费；
 * 将来的子代理时间轴走同一份翻译 —— 一个事件流，两个投影。
 */

// 工具 → 舞台呈现形态
//   code     代码直播卡（Edit diff / Write 全文，真流式打字）
//   terminal 终端卡（命令 + 输出尾巴，dock 展示）
//   image    生图 shimmer 占位（真图由 board.updated / 产物重拉带进来）
//   chip     不抢戏的状态胶囊（检索 / 读文件 / 装技能这类）
const TOOL_STAGE_KIND = {
  Edit: 'code',
  Write: 'code',
  Bash: 'terminal',
  mcp__nodesign__generate_image: 'image',
  mcp__nodesign__write_on_board: 'chalk',   // 板书直播：text 逐 token 流进纸面卡
  AskUserQuestion: 'question',   // 交互卡直接上画布（dock），聊天栏那张照旧
};

// 不上舞台的工具：聊天栏已有完整交互卡，舞台重复出现只会抢镜头。
// Task/Agent（SDK 新旧两名）也在这：子代理有自己的舞台便利贴（run.task.*
// 事件驱动，key 同 toolUseId），chip 形态会跟它撞 key
const SILENT_TOOLS = new Set(['TodoWrite', 'ExitPlanMode', 'EnterPlanMode', 'Task', 'Agent']);

export function stageKindOf(toolName) {
  if (!toolName || typeof toolName !== 'string') return null;
  if (TOOL_STAGE_KIND[toolName]) return TOOL_STAGE_KIND[toolName];
  if (SILENT_TOOLS.has(toolName)) return null;
  return 'chip';
}

/**
 * agent 写的文件 → 画布物件 id。
 *
 * ## 前提：进来的路径已经是工作区相对的
 *
 * 服务端在 emit 之前过 `toWorkspaceRel`（`server/lib/workspace-path.js`）。
 * 这不是洁癖 —— **只有服务端知道工作区根在哪**。2026-08-08 之前这个函数靠
 * `tasks/<任务>/` 这个特征段从绝对路径里抠相对部分，那一层拆掉之后绝对路径里
 * 再没有可锚定的标志（工作区根就是一串随机 id 的目录名），前端猜不出来。
 *
 * ## 规则（id = kind 前缀 + 工作区相对路径）
 *
 *   1. 记忆 / 品牌两份文档有固定 id（它们是项目区的卡，不按路径派生）
 *   2. 落在某件**目录型产物**（站点 / 世界）里的一切 → 贴那件产物的卡。
 *      站点的 index / about / style.css / 图片各给一个 id 的话，agent 改一次
 *      样式表桌面就多冒一张卡 —— 用户要的是"我那个网站"，不是三张互不相干的卡。
 *   3. 其余 `.html` → 一份 deck（顶层也好、文件夹里也好，都是平等的一份）
 *   4. 剩下的一切 → **路径本身**就是 id（图片卡、便签卡、文件卡都这么派生）
 *
 * 认不出来只有一种情况：路径为空（工作区根自己）。
 *
 * @param {string} filePath 工作区相对路径
 * @param {Array<{path:string,id:string}>} artifactRoots 目录型产物的覆盖表，
 *        **按 path 长度降序**（长的先匹配，子目录站点才不会被父站点吞掉）
 */
export function resolveObjectId(filePath, artifactRoots) {
  if (!filePath || typeof filePath !== 'string') return null;
  const norm = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  // 绝对路径直接拒（2026-08-15 home 幽灵案）：前端没有工作区根可对，剥掉开头
  // 斜杠等于把 /home/wangang-dev/... 认成 home/... 的相对路径 —— ensureZoneForTarget
  // 会孵出一块名叫「home」的影子文件夹，光圈/精灵全锚过去，拖一下就消失但锚定
  // 残留。服务端漏 toWorkspaceRel 的 emit 修一个少一个，这道闸管的是"下一个"。
  if (norm.startsWith('/')) return null;
  const p = norm.replace(/\/+$/g, '');
  if (!p) return null;
  // （doc:brand / doc:_root 映射 2026-08-24 拆除：项目文档并入根 CLAUDE.md/记忆/）
  for (const r of (artifactRoots || [])) {
    if (r?.path == null) continue;
    // 根站（2026-08-14 空串病族又一例）：站住在工作区根上时 path 合法地是
    // 空串，`!r.path` 那种写法会把它整个跳过 —— index.html/style.css 全都
    // 解析成幽灵 id（deck:index.html / 裸路径），精灵落不到任何卡上，
    // 「运行中途目标消失、之后的修改无法追踪」就是这么来的。
    // 空前缀语义 = 根层散文件都是这个站的资产；只收根层（带 / 的路径是
    // notes/ assets/ 等别家的地），.md 除外（根上的 md 是自己的阅读卡）。
    // 覆盖表按 path 降序，空串天然排最后 —— 子目录站点先认领，不会被吞。
    if (r.path === '') {
      const slash = p.indexOf('/');
      if (slash < 0) {
        if (!/\.md$/i.test(p)) return r.id;
        continue;
      }
      // 根站的**认领子目录**（2026-08-14 二刀）：服务端收集器把"页面引用到的
      // 一级子目录"算进根站（`刊物/第一期.html` 是它的页不是散文件），前端
      // 覆盖表带 claims（页面路径的顶层段）跟上同一口径 —— 不带的话编辑
      // 认领目录里的文件又是幽灵 id。
      if (Array.isArray(r.claims) && r.claims.includes(p.slice(0, slash))) return r.id;
      continue;
    }
    if (p === r.path || p.startsWith(`${r.path}/`)) return r.id;
    // 单页产物的伴生文件（2026-08-14）：`_drafts/纸本.css` 属于
    // `site:_drafts/纸本.html` 那张卡 —— 同目录同名不同扩展名。不然它落进
    // 裸路径，而 `_drafts/` 又刻意不是文件夹卡（试作各自渲卡、目录本身是
    // 基础设施），精灵和舞台卡对它就彻底没有落点。
    if (/\.html?$/i.test(r.path)) {
      const stem = r.path.replace(/\.[^./]+$/, '');
      if (p.startsWith(`${stem}.`) && !p.slice(stem.length + 1).includes('/')) return r.id;
    }
  }
  if (/\.html?$/i.test(p)) return `deck:${p}`;
  return p;
}

/**
 * 物件 id → 它住在哪个文件夹（与 BoardCanvas 的 `naturalZoneOf` 同一套规则）。
 *
 * 舞台卡的落点用它兜底：物件还没上墙（新文件正在写，产物列表下一次重拉才知道
 * 它存在）时，卡至少能贴到正确的文件夹，而不是掉进屏幕底部的 dock。
 *
 * 返回 null = 住在工作区根上（桌面本身），没有上级文件夹。
 * ⚠️ 不再有"回落到当前会话"这一支：会话不产生画布物件（2026-08-08），回落到
 * sessionId 只会凭空造出一个 key 是 uuid 的影子文件夹，而它永远不会退场。
 */
export function zoneOfObjectId(objectId) {
  if (!objectId || typeof objectId !== 'string') return null;
  // kind 前缀只认字母（`deck:` `site:`）—— 路径里的冒号不算前缀，
  // 判据跟 server/projects/board-store.js 的 mapId 保持一致
  const c = objectId.indexOf(':');
  const p = (c > 0 && /^[a-z]+$/.test(objectId.slice(0, c))) ? objectId.slice(c + 1) : objectId;
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : null;
}

export function fileNameOf(filePath) {
  if (!filePath) return '';
  const p = String(filePath).replace(/\\/g, '/');
  return p.slice(p.lastIndexOf('/') + 1);
}

/** chip 上跟在工具名后面的一小截提示（文件名 / 技能名 / 检索词…） */
export function chipHintOf(toolName, input) {
  if (!input || typeof input !== 'object') return '';
  const take = (v) => (typeof v === 'string' && v ? v : null);
  const hint =
    take(input.file_path && fileNameOf(input.file_path)) ||
    take(input.skill) ||
    take(input.query) ||
    take(input.pattern) ||
    take(input.url) ||
    take(input.path) ||
    take(input.object_path) ||
    '';
  return hint.length > 40 ? `${hint.slice(0, 38)}…` : hint;
}

/** 工具名的展示标签（mcp__nodesign__pin_to_board → pin_to_board） */
export function toolLabelOf(toolName) {
  if (!toolName) return '';
  return toolName.startsWith('mcp__') ? toolName.split('__').slice(2).join('__') : toolName;
}
