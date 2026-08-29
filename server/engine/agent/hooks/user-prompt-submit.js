/**
 * UserPromptSubmit handler — 每次用户输入前注入工作区**状态**（2026-08-21 重做）
 *
 * 注的是状态不是指令：cwd、素材清单、便利贴、画布关系线、产物清单。
 * 怎么用这些东西（路径表、"先看有没有现成的素材"、工具怎么选）住 prelude，那是缓存的
 * system prompt；每轮再说一遍是上下文里的 N 倍重复。
 *
 * ## 首轮全量，之后只报变化
 *
 * 以前每轮全量（实测 540~1300 token/轮），30 轮下来对话历史里是十几份几乎相同的块。
 * 现在每节算指纹记在 turn-state-memory.js（按 sessionId）：
 *   - 首轮（或压缩后 / 进程重启后）：全量 + 结尾"请基于这些信息处理用户的请求"
 *   - 之后：变了的节全文（标「有变化」），素材/便利贴这种清单只报新增/移除；没变的节
 *     只在末尾一行点名"未变：…"（让模型知道它们还在，但不重复内容）；一节都没变就一句话
 *
 * ## 素材块从 turn-compose 搬过来（同日）
 *
 * 以前 assets 摘要是 turn-compose 拼进**用户消息**里的 <system> 块，跟这里的状态块是
 * 两条线两个真相源；而且那块写着"assets/ 是 symlink 别用 Glob"—— 08-07 扁平化后早就是
 * 真目录了。现在合成这一条线，symlink 那句删掉。
 *
 * input: UserPromptSubmitHookInput — output: { hookSpecificOutput: { additionalContext } }
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { readUiConfigFile, withUiDefaults } from '../../../projects/ui-config.js';
import { readAssetsSummary } from '../../../projects/assets-summary.js';
import { relationsDigest } from '../../../lib/board-relations.js';
import { getViewpoint, describeViewpoint } from '../../../projects/viewpoint-store.js';
import { resolvePlacement, inferFlowDir } from '../../../lib/board-place.js';
import { fitFor } from '../../../lib/sketch-layout.js';
import { recentChalk, CHALK_DIR } from '../../../lib/chalk.js';
import { listRoleNames } from '../role-card.js';
import { stageStatus } from '../stage-status.js';
import { roleLabel } from '../../mcp/actor.js';
import { readBoard } from '../../../projects/board-store.js';
import { estimateSizeOn } from '../../../lib/board-kind-sizes.js';
import { layerOf } from '../../../lib/canvas-id.js';
import {
  getActiveArtifact, listWorkspaceArtifacts, taskManifest, kindDef,
  KIND_DECK, KIND_SITE, ENTRY_FILE,
} from '../../../lib/artifact-target.js';
import { getTurnMemory, setTurnMemory, fingerprint, diffItems } from './turn-state-memory.js';

/** PDF/Office 文档的解法（系统自带工具；python 包没装且装不上 —— 08-19 上报实锤）。只在首次出现二进制文档时说一遍。 */
const BINARY_DOC_HINT = 'PDF / PPTX / DOCX / XLSX 直接 Read 拿不到结构化内容（二进制或 zip 包）。用系统自带的工具解'
  + '（pdfplumber/PyPDF2/python-docx/openpyxl 这些 python 包**没装且装不上**，别试）：'
  + 'pdf 文本 `pdftotext -layout 文件.pdf -`；pdf 转页图 `pdftoppm -png -r 100 文件.pdf 页前缀` 再 Read 图片；pdf 嵌入图 `pdfimages -png`。'
  + 'docx/pptx/xlsx 用 `soffice --headless --convert-to txt|csv|pdf --outdir 目录 文件`（xlsx 转 csv；⚠️ soffice 吃不下中文文件名，先拷成 ASCII 名，并加 `-env:UserInstallation=file:///tmp/lo-任意名` 免得和渲染管线抢 profile）；'
  + 'docx/pptx 里的嵌入图直接 `unzip -o 文件 "word/media/*"`（pptx 是 `ppt/media/*`）。'
  + '**提取出来的不只是文本，通常还包含嵌入图片** —— 提取完一定 Read 看图片，别只看 stdout 文本就以为信息齐了。';

/**
 * 采集各节。每节 { key, title, text, items? }：text 是全量文案；items 是可按项报变化的清单。
 * 任一节采不到就不出现（跟以前一样：扫不动就不说，别拿错信息误导）。
 */
async function collectSections({ workspaceRoot, sessionId, projectId }) {
  const sections = [];

  // cwd：唯一真正动态的一行。路径表（./ notes/ assets/ .claude/agent-memory/ 各是什么）在 prelude
  sections.push({ key: 'cwd', title: '工作区', text: `你的 cwd 是 ${workspaceRoot} —— 项目工作区，产物直接住这儿（路径表见 prelude「你跑在哪」）。` });

  // 素材：顶层 assets/ + assets/references/**（逛站采回来的）
  try {
    const a = await readAssetsSummary(workspaceRoot);
    if (a.count > 0) {
      const all = Array.isArray(a.allPaths) ? a.allPaths : [];
      const shown = Array.isArray(a.paths) ? a.paths : [];
      const text = `${a.summary}\n完整路径（直接 Read；Glob/Grep 也能用）：\n${shown.map(p => `- ${p}`).join('\n')}`
        + (a.hasBinaryDocs ? `\n${BINARY_DOC_HINT}` : '');
      sections.push({ key: 'assets', title: '素材', text, items: all, hasBinaryDocs: a.hasBinaryDocs });
    }
  } catch { /* 素材读不到就沉默 */ }

  // （spec.json 决策档案注入 2026-08-24 拆除：决策体系退役，长期事实走 CLAUDE.md/记忆）

  // 便利贴：metadata-not-content，只列文件和首行标题
  try {
    const notesDir = path.join(workspaceRoot, 'notes');
    const noteFiles = (await fs.readdir(notesDir)).filter(n => n.endsWith('.md') && !n.startsWith('.'));
    const lines = []; const items = [];
    for (const n of noteFiles.slice(0, 12)) {
      let title = ''; let faces = 0;
      try {
        const raw = await fs.readFile(path.join(notesDir, n), 'utf8');
        title = (raw.match(/^#\s+(.{1,60})/m)?.[1] || '').trim();
        faces = raw.split(/\n---\n/).length;
      } catch { /* 列出文件名就够 */ }
      const meta = [title, faces > 1 ? `${faces} 面` : ''].filter(Boolean).join(' · ');
      lines.push(`  notes/${n}${meta ? `（${meta}）` : ''}`);
      items.push(`notes/${n}`);
    }
    if (lines.length) sections.push({ key: 'notes', title: '便利贴', text: `便利贴（和用户共享，他看得到也可能改过；细节 Read）：\n${lines.join('\n')}`, items });
  } catch { /* notes/ 不存在：noop */ }

  // 画布关系线：用户画的排前面
  // 用户视点（2026-08-23 黑板）：一行，只在变化时进注入（renderTurnState 按 hash 判）。
  // 视口矩形按 1/8 视口量化再进 hash，不然相机挪一像素就算"变了"。
  try {
    const vp = getViewpoint(projectId);
    if (vp) {
      const board = await readBoard(projectId);
      const known = new Set(Object.keys(board.zones || {}));
      const rects = Object.entries(board.objects || {})
        .filter(([id, e]) => Number.isFinite(e?.x) && layerOf(id, e, known) === (vp.layer || ''))
        .map(([id, e]) => ({ id, x: e.x, y: e.y, ...estimateSizeOn(board, id, e) }));
      const q = vp.camera ? { ...vp, camera: {
        x: Math.round(vp.camera.x / Math.max(1, vp.camera.w / 8)) * Math.round(vp.camera.w / 8),
        y: Math.round(vp.camera.y / Math.max(1, vp.camera.h / 8)) * Math.round(vp.camera.h / 8),
        w: vp.camera.w, h: vp.camera.h,
      } } : vp;
      const line = describeViewpoint(q, rects);
      // 空位建议（08-27 用户提）：替 agent 把"落哪能进用户眼帘"算好 —— 大身位先试，
      // 不行退小身位，再不行明说视口已满。数字来自 resolvePlacement 的视口扫描，
      // 跟真实落位同一套判据（建议和落位算法分家=两份真相源）。
      let spot = null;
      if (vp.camera) {
        const big = resolvePlacement({ box: { w: 480, h: 360 }, obstacles: rects, contentBottom: 0, viewport: vp.camera });
        if (big.resolution === 'viewport') spot = `视口内空位：(${big.x},${big.y}) 起可容 ~480x360（一条板书的身位）`;
        else {
          const small = resolvePlacement({ box: { w: 300, h: 160 }, obstacles: rects, contentBottom: 0, viewport: vp.camera });
          spot = small.resolution === 'viewport'
            ? `视口内只剩小空位：(${small.x},${small.y}) 可容 ~300x160，大件会落到视口外`
            : '视口内已满 —— 新东西会落到视口外，要么 near 贴着视口里的东西写，要么落完说清在哪';
        }
      }
      // 摆放走向（08-27 落位直觉可见化）：用户亲手掰过方向的线报出来 ——
      // 不报的话 agent 事前只能靠视口位置猜用户想要的版面方向（用户点名的盲区）
      let dirs = null;
      try {
        const tags = [...new Set(Object.values(board.bindings || {})
          .filter(e => e?.type === 'flow' && e.tag).map(e => e.tag))];
        const arrow = { right: '→右', left: '←左', below: '↓下', above: '↑上' };
        const learned = tags.map(t => ({ t, d: inferFlowDir(board, { tag: t }) })).filter(x => x.d);
        if (learned.length) {
          dirs = `他摆过的走向：${learned.slice(0, 4).map(x => `#${x.t} ${arrow[x.d]}`).join('、')}`
            + `${learned.length > 4 ? ' 等' : ''}（接楼和自动挑侧会跟这个方向，别对着摆）`;
        }
      } catch { /* 学不出就不占字 */ }
      /**
       * 手机 / 平板档的版式（2026-08-28 移动端第二轮，用户拍板「一件 = 一屏，纵向单列」）。
       *
       * ⚠️ 这段是**事前**说的，不是靠 write_on_board 的返回文案事后纠正 —— 一块
       * 1700 宽的板书在 390 的屏上已经写出来了，再告诉它"下次窄一点"没有意义，
       * 用户这一轮拿到的就是要横着滑四屏的东西。
       *
       * ⭐ 同时几何那边也在执行（resolvePlacement 的 column：左右侧一律降级成正下方）。
       * 两处都做不是重复：提示词管"它主动写多宽"，几何管"它没照做时版面还读得了"。
       */
      const fit = fitFor(vp);
      const laneLine = fit.column
        ? `⚠️ 他在${fit.lane === 'phone' ? '手机' : '平板'}上（屏幕 ${fit.screen?.w}x${fit.screen?.h}px）。`
          + `版面规矩：**一件 = 一屏，纵向单列**。每件宽度 ≤${fit.w}（超了就要横向滑动，手机上没人受得了），`
          + `高度到 ${fit.h} 都行（竖着滚是手机上读长内容的天然姿势）。`
          + `接着写就往**正下方**接，别用 side:'right'/'left' 并排 —— 并排的第二件在他屏幕外。`
          + `宁可多拆几件竖着排，也别把一件写宽。`
        : '';
      if (line) sections.push({ key: 'viewpoint', title: '用户视点', text: `用户此刻在画布上：${line}。${spot ? `${spot}。` : ''}${dirs ? `${dirs}。` : ''}${laneLine}他说「这个/这里/这张」多半指选中的 > 开着的窗 > 视口里的东西；落新东西优先进他的视口或贴着视口里的东西（near/at）。要看画面细节才调 read_user_view。` });
    }
  } catch { /* 视点读不到就沉默 */ }
  try {
    const digest = await relationsDigest(projectId, { limit: 12 });
    if (digest) {
      sections.push({ key: 'relations', title: '画布关系线', text: `画布关系线（用户和你手动画的连线，端点跟着改名走；语义看线上的词）：\n${digest}\n  产出新东西后记得用 edit_board add_edge 把「改自/对照/接着/取材」画上去。` });
    }
  } catch { /* 板读不到就沉默 */ }

  // 产物清单：按形态报（deck 报页数，站点报页面清单 + 产物根）
  try {
    const artifacts = await listWorkspaceArtifacts(workspaceRoot);
    if (artifacts.length === 0) {
      sections.push({ key: 'artifacts', title: '产物', text: `这个工作区还没有产物 —— 直接在工作区根上写：deck 写 ${ENTRY_FILE[KIND_DECK]}，站点写 ${ENTRY_FILE[KIND_SITE]}。` });
    } else {
      const active = getActiveArtifact(sessionId)?.path || null;
      const lines = [];
      let manifest = null;
      for (const a of artifacts.slice(0, 8)) {
        let note = '';
        try {
          if (!manifest) manifest = await taskManifest(workspaceRoot);
          const art = manifest?.artifacts?.find(x => x.entryRel === a.rel) || null;
          note = art ? await kindDef(art.kind).describe(workspaceRoot, art) : '还判不出形态';
        } catch { note = '读不到'; }
        lines.push(`  ${a.rel}（${note}）${a.rel === active ? '  ← 画布工具默认打这份' : ''}`);
      }
      sections.push({ key: 'artifacts', title: '产物', text: `现有产物：\n${lines.join('\n')}` });
    }
  } catch { /* 扫不动就不说 */ }

  // 最近板书（2026-08-23；08-24 记忆改版时被误删，同日修回）：你/用户在画布上
  // 说过的最近几句 —— 对话在板上，得记得板上说了什么
  try {
    const all = await recentChalk(workspaceRoot, { limit: 24 });
    const roleNames = await listRoleNames(workspaceRoot);
    // 前 8 条 + 保底：每个角色最新那条就算被 GM 自己的章节/状态板挤出前 8 也要在 ——
    // GM 需要知道台上角色说了什么（08-28 用户拍板），漏了它就会旁白转述/代笔补戏。
    const recent = all.slice(0, 8);
    const seenRole = new Set(recent.map(c => c.by));
    for (const c of all.slice(8)) {
      if (c.by && c.by !== 'agent' && c.by !== 'user' && !seenRole.has(c.by)) {
        recent.push(c); seenRole.add(c.by);
      }
    }
    if (recent.length) {
      // 这段是注给**主 agent** 的，所以「你」= 主 agent；角色写的板书报它的名字，
      // 否则主 agent 会把角色写的东西当成自己写的（RP 线里那是大部分板书）。
      const lines = recent.map(c => `  ${c.path}（${c.by === 'user' ? '用户' : c.by && c.by !== 'agent' ? roleLabel(c.by, roleNames.get(c.by)) : '你'}${c.anchor ? `，关于 ${c.anchor}` : ''}${c.replyTo ? `，回应 ${c.replyTo.replace(`${CHALK_DIR}/`, '')}` : ''}）「${c.first}」`);
      sections.push({ key: 'chalk', title: '最近板书', text: `画布上最近的板书（${CHALK_DIR}/，新在前；正文 Read 文件）：\n${lines.join('\n')}`, items: recent.map(c => c.path) });
    }
  } catch { /* 板书读不到就沉默 */ }

  // 台上（2026-08-29）：角色现在的状态。判据全是 harness 盖的章（SubagentStart/Stop，
  // 见 stage-status.js）—— 此前主持人对这件事是半盲的：只在角色**结束**时收到一条
  // 通知，中间既不知道谁在写，也不知道谁写完在等它接。08-28 真会话里用户替它问出了
  // 这个洞（「说书人是不是要重启一下？」），而主持人手上没有任何工具能回答。
  try {
    const st = stageStatus(projectId);
    if (st.length) {
      const names = await listRoleNames(workspaceRoot);
      const mins = (ms) => Math.round(ms / 60000);
      const lines = st.map((r) => {
        const who = roleLabel(r.slug, names.get(r.slug));
        if (r.writing) return `  ${who}（${r.slug}）正在写`;
        const idle = r.idleMs > 90000 ? `，${mins(r.idleMs)} 分钟没动了` : '';
        return `  ${who}（${r.slug}）写完了这一段${idle}${r.lastLine ? `，收笔时说：「${r.lastLine}」` : ''}`;
      });
      sections.push({ key: 'stage', title: '台上', text:
        `这场故事里的角色：\n${lines.join('\n')}\n`
        + `写完的角色这一轮已经结束了 —— 要它接着演，SendMessage 寄给它的名字（当场醒，记得之前所有事）；`
        + `不用重新派（重派会新起一个失忆的同名角色顶掉它）。` });
    }
  } catch { /* 台上读不到就沉默 */ }

  // 黑板模式（2026-08-23；08-24 起默认开 —— 没写过这个键的按开算，显式 false 才算关）
  try {
    const cfg = withUiDefaults(await readUiConfigFile(workspaceRoot));
    if (cfg.blackboard_mode === true) {
      sections.push({ key: 'blackboard', title: '黑板模式', text:
        '【黑板模式：开】用户此刻在画布上专注思考。这一轮默认这么做：想事情就画成图（write_on_board 给 nodes/edges，'
        + '小改动用 edit_board 原地改别重画）；做完一件东西在它旁边写一条板书（write_on_board near=）；'
        + '用户标注了板上的东西就接在那条下面回（reply_to=）。侧栏照常回复，但板上已经写的别大段重复。'
        + '尺寸守规范（0.8 倍一屏可读、正文 md 起、一条板书说一件事）；画完 look_at_board 看一眼再收。' });
    }
  } catch { /* 读失败：不注入 */ }

  // （tweaks 开关注入 2026-08-24 随 expose_tweaks 暂退役一起摘除；工具升级后再回来）

  return sections;
}

/**
 * 把各节渲染成这一轮的注入文本（纯函数，可单测）。
 * @param {Array} sections  collectSections 的结果
 * @param {Map|null} prev   上一轮记忆（null = 首轮）
 * @returns {{ text: string|null, next: Map }}
 */
export function renderTurnState(sections, prev) {
  const next = new Map();
  for (const s of sections) next.set(s.key, { hash: fingerprint(s.text), items: s.items ? [...s.items] : null, hasBinaryDocs: !!s.hasBinaryDocs });
  if (!sections.length) return { text: null, next };

  if (!prev) {
    const body = sections.map(s => s.text).join('\n\n');
    return { text: `[NoDesign 工作台自动注入的当前状态]\n\n${body}\n\n请基于这些信息处理用户的请求。`, next };
  }

  const changed = []; const unchanged = []; const gone = [];
  for (const s of sections) {
    const p = prev.get(s.key);
    if (!p) { changed.push(`（新出现）${s.text}`); continue; }
    if (p.hash === next.get(s.key).hash) { unchanged.push(s.title); continue; }
    if (s.items && p.items) {
      const d = diffItems(p.items, s.items);
      const bits = [];
      if (d.added.length) bits.push(`新增 ${d.added.length}：${d.added.slice(0, 8).join('、')}${d.added.length > 8 ? ' 等' : ''}`);
      if (d.removed.length) bits.push(`移除 ${d.removed.length}：${d.removed.slice(0, 8).join('、')}${d.removed.length > 8 ? ' 等' : ''}`);
      if (bits.length) {
        let line = `${s.title}（有变化）：${bits.join('；')}（现共 ${s.items.length} 件）`;
        if (s.hasBinaryDocs && !p.hasBinaryDocs) line += `\n${BINARY_DOC_HINT}`;
        changed.push(line);
        continue;
      }
    }
    changed.push(`（有变化）${s.text}`);
  }
  for (const [key] of prev) if (!next.has(key)) gone.push(key);
  const lines = [];
  if (changed.length) lines.push(...changed);
  if (gone.length) lines.push(`（已不存在：${gone.join('、')}）`);
  if (!changed.length && !gone.length) {
    return { text: `[工作台状态：与上轮相同（${unchanged.join('、')}）]`, next };
  }
  lines.push(`未变：${unchanged.join('、') || '（无）'}`);
  return { text: `[工作台状态 · 只报变化]\n\n${lines.join('\n\n')}`, next };
}

export function makeUserPromptSubmitHandler({ ctx: _ctx, workspaceRoot, sessionId, projectId }) {
  return async (_input, _toolUseId, _options) => {
    try {
      if (!workspaceRoot) return {};
      const sections = await collectSections({ workspaceRoot, sessionId, projectId });
      const prev = getTurnMemory(sessionId)?.sections || null;
      const { text, next } = renderTurnState(sections, prev);
      setTurnMemory(sessionId, next);
      if (!text) return {};
      // 不 emit 业务事件 —— additionalContext 注入是私域提示，不需要前端展示
      return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } };
    } catch (err) {
      console.warn('[hooks/UserPromptSubmit] handler threw:', err.message);
      return {};
    }
  };
}
