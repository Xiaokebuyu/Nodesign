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
import { sheetSummaries, latestSheetId, currentSheet, sheetOfPoint } from '../../../lib/board-sheets.js';
import { currentSheetIdOf } from '../../../lib/sheet-state.js';
import { dirtyEvents, describeDirty, splitDirtyByCharge } from '../../../lib/board-dirty.js';
import { fitFor } from '../../../lib/sketch-layout.js';
import { learnedChalkWidth } from '../../../lib/chalk-size-pref.js';
import { readStateVars } from '../../../lib/state-table.js';
import { parseTriggers, evalTriggers, readLatch, writeLatch } from '../../../lib/state-triggers.js';
import { recentChalk, CHALK_DIR } from '../../../lib/chalk.js';
import { listRoleNames } from '../role-card.js';
import { stageStatus } from '../stage-status.js';
import { resetBeat } from '../beat-state.js';
import { roleLabel } from '../../mcp/actor.js';
import { readBoard } from '../../../projects/board-store.js';
import { estimateSizeOn } from '../../../lib/board-kind-sizes.js';
import { layerOf } from '../../../lib/canvas-id.js';
import { shelfItems } from '../../../lib/board-shelf.js';
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
      // 纸（2026-08-29 纸范式）：报当前有哪些纸、剩多少地 —— 空位建议/走向学习
      // 那套启发式随落位引擎一起退役，agent 的空间账本现在是纸的清单。
      let spot = null;
      // 暂存架（2026-08-30）：机器到货的默认座。点名 + 三个安置动词，agent 不动它们就一直在。
      // ⚠️ 判据只有 lib/board-shelf.js shelfItems 一份（2026-08-31）——这儿和 read_board
      // 原来各抄了一遍 `!e.zone`，而那条判据本身是错的（幽灵点名，见 shelfItems 头注）
      const shelfSeats = shelfItems(board);
      const pendingSeats = Array.isArray(board.pending) ? board.pending : [];
      try {
        const ss = sheetSummaries(board);
        // 「最新」按登记时间取（latestSheetId 一份算法）—— 不是数组末项那张最下面的
        const latest = latestSheetId(board);
        const cur = ss.find(s => s.id === latest) || ss[ss.length - 1];
        if (cur) {
          // 报「还能装下什么」不是裸数字（2026-08-30 容量线）：行数是模型真正用来
          // 决策的量纲 —— 顺手教它超过余量别赌一发，flow 会替它拆
          const slots = cur.slots?.length
            ? `；版位 ${cur.slots.map(s => `${s.name} 剩 ~${s.freeLines} 行`).join('、')}`
            : '；这张没规划版位';
          spot = `板上 ${ss.length} 张纸；当前 ${cur.id}${cur.title ? `（${cur.title}）` : ''} 还剩 ~${cur.freeH}px 高的空地${slots}`
            + '（内容眼看要超余量就别赌一发 —— 自己多切几个空位分段填（plan/replan 省掉 at 即竖排接放），'
            + '或兜底 flow:true；写满**不会**自动翻页，自己 open_sheet 规划下一页；新话题也是 open_sheet）';
        } else {
          spot = '板上还没铺过纸 —— 第一笔 write_on_board 会自动铺一张在他视口下，或先 open_sheet';
        }
        const unplaced = [...shelfSeats, ...pendingSeats];
        if (unplaced.length) {
          spot += `；📦 ${unplaced.length} 件在暂存架等你安置（${unplaced.slice(0, 3).map(r => r.split('/').pop()).join('、')}${unplaced.length > 3 ? '…' : ''}）`
            + ' —— 给它们规划的地：open_sheet{plan:[…{for:"artifacts"}]} 或逐件 pin_to_board{path,slot} / edit_board move。'
            + '架不是版面，东西留在架上就是没摆';
        }
      } catch { /* 纸读不出就不占字 */ }
      const dirs = null;
      /**
       * 手机档的版式（2026-08-28 移动端第二轮，用户拍板「一件 = 一屏，纵向单列」；
       * 2026-08-31 起**只剩手机**，平板走桌面那套，判据整条在 sketch-layout 的 fitFor）。
       *
       * ⚠️ 这段是**事前**说的，不是靠 write_on_board 的返回文案事后纠正 —— 一块
       * 1700 宽的板书在 390 的屏上已经写出来了，再告诉它"下次窄一点"没有意义，
       * 用户这一轮拿到的就是要横着滑四屏的东西。
       *
       * ⭐ 同时几何那边也在执行（write-on-board 的 capUnits 封顶 + resolveTemplate
       * 强制单列）。两处都做不是重复：提示词管"它主动写多宽"，几何管"它没照做时
       * 版面还读得了"。
       */
      const fit = fitFor(vp);
      /**
       * 用户对版面表过的态（2026-09-01 叠纸刀 7，站主拍板）。
       *
       * 两个动作是有信息量的：**他手动改了缩放**、**他把板书拖成某个宽度**。
       * 后者从 08-28 起就在学（learnedChalkWidth，判据是前端拖手柄盖的 sized:'user'
       * 章，模型盖不出），但它只影响下一条板书的宽度，够不着纸。前者一直有人报
       * （viewpoint.zoom）却没有任何人读它来定版面。
       *
       * ⚠️ 只在**真有信号**时才占字：他没动过就一个字不说。而且说的是「问一句」
       * 不是「照做」—— 缩放调小可能只是想看全貌，不一定是要更大的纸。
       */
      let wishLine = '';
      try {
        const basis = fit.lane === 'phone' ? 0.5 : 0.75;
        const z = Number(vp?.zoom);
        const zoomed = Number.isFinite(z) && Math.abs(z - basis) / basis > 0.15;
        const learned = learnedChalkWidth(board);
        if (zoomed || learned) {
          const bits = [];
          if (zoomed) bits.push(`他把缩放调到了 ${z.toFixed(2)}（这台机器的基准是 ${basis}）`);
          if (learned) bits.push(`他把板书拖到过 ${learned * 24}px 宽`);
          wishLine = `📐 ${bits.join('；')} —— 这是他对版面表的态。`
            + `下一张纸要不要按他的来（open_sheet{w,h}），**问一句再动**，别自作主张：`
            + '缩小也可能只是想看全貌。';
        }
      } catch { /* 读不出就不说 */ }
      const laneLine = fit.column
        ? `⚠️ 他在手机上（屏幕 ${fit.screen?.w}x${fit.screen?.h}px）。`
          + `版面规矩：**一件 = 一屏，纵向单列**。每件宽度 ≤${fit.w}（超了就要横向滑动，手机上没人受得了），`
          + `高度到 ${fit.h} 都行（竖着滚是手机上读长内容的天然姿势）。`
          + `接着写就往**正下方**接，别用 side:'right'/'left' 并排 —— 并排的第二件在他屏幕外。`
          + `宁可多拆几件竖着排，也别把一件写宽。`
        : '';
      if (line) sections.push({ key: 'viewpoint', title: '用户视点', text: `用户此刻在画布上：${line}。${spot ? `${spot}。` : ''}${dirs ? `${dirs}。` : ''}${wishLine}${laneLine}他说「这个/这里/这张」多半指选中的 > 开着的窗 > 视口里的东西；写板走纸（at = 纸内坐标）。要看画面细节才调 read_user_view。` });
    }
  } catch { /* 视点读不到就沉默 */ }
  // 板上动静（2026-08-29 纸范式刀 4）：用户拖动/搬家/擦组此前完全静默，agent 只能
  // 撞运气。这里报最近半小时的动静（指纹只在有新动静时变，未变随「未变」行收拢）；
  // 回合中途的动静另有 PreToolUse 注入器在 agent 摸板前插话。
  try {
    const evts = dirtyEvents(projectId, 0);
    if (evts.length) {
      const line = describeDirty(evts, { limit: 6 });
      // 有限负责制（刀⑤ 2026-08-30）：动静按纸分拣 —— 挪进你当前纸的要接手处理，
      // 挪去别处的是用户自留地，只报不催（板整个是用户随便动，别拔河）。
      let charge = '';
      try {
        const b = await readBoard(projectId);
        const curId = currentSheet(b, currentSheetIdOf(sessionId))?.id || null;
        const sheetOf = (id) => {
          const e = b.objects?.[id];
          if (!e || !Number.isFinite(e.x)) return null;
          const sz = estimateSizeOn(b, id, e);
          // e.sheet：叠纸之后这件东西自己认领的纸优先（2026-09-01）
          return sheetOfPoint(b, { x: e.x + sz.w / 2, y: e.y + sz.h / 2 }, e.sheet || null)?.id || null;
        };
        const { inMine, elsewhere } = splitDirtyByCharge(evts, { sheetOf, currentSheetId: curId });
        if (inMine.length) {
          charge = `\n⚠️ 其中 ${inMine.slice(0, 4).join('、')}${inMine.length > 4 ? ` 等 ${inMine.length} 件` : ''} 现在落在**你正在写的纸（${curId}）**上：`
            + '这块工作区的版面归你管 —— 若它挡了你的版位/内容，用 edit_board 给它挪个合适的位置（挪要挪得讲理，别甩出用户视野）；用户明说过要放那儿的除外。';
        }
        if (elsewhere.length && inMine.length) {
          charge += `\n其余 ${elsewhere.length} 件在你的纸外 —— 那是用户自留地，不要去动。`;
        } else if (elsewhere.length) {
          charge = '\n这些都在你当前的纸外 —— 用户自留地，看在眼里就好，不要去动。';
        }
      } catch { /* 分拣失败就退回不分拣的报法 */ }
      sections.push({ key: 'boardDirty', title: '板上动静', text:
        `用户最近亲手动过板面：${line}。这些位置以现状为准 —— 摆放前先 read_board，别按你记忆里的旧位置来。${charge}` });
    }
  } catch { /* 动静读不到就沉默 */ }

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

  // 状态表（2026-08-30）：板上那张 `| 键 | 值 |` 的现值，每轮开头端到手边 ——
  // 演出里"会变、要记得"的东西（好感度/时间/线索）不该靠模型自己在上下文里背。
  //
  // ⚠️ 这一节**不给 items**，走整节 hash 比对（renderTurnState 的默认分支）。
  // 给了 items 会被 diffItems 渲染成「新增 好感度=4；移除 好感度=3」—— 信息对、
  // 话是错的（那个渲染器被 9 个节共用，为一张小表去改它不值）。而且对读者来说，
  // 变了的时候看到**整表现值**比看到增量有用：它按现值行事，不按 delta 行事。
  //
  // ⛔ 「解析不出来」必须出声。collectSections 的房规是"采不到就不出现"，对普通节
  // 是对的，对这一节就是坑：表被 set_text / 用户手改写坏之后会静默消失，而写口闸
  // 只守得住 set_vars 那一路（另外两路是合法的写入方）。所以 broken 一律推一节。
  try {
    const st = await readStateVars(workspaceRoot);
    if (st.state === 'ok' && st.rows.length) {
      const table = st.rows.map(r => `  ${r.key} = ${r.value}`).join('\n');
      const parts = [];

      // 条件触发器（2026-08-30）：求值点 = 注入点。只在这里求一次，命中就写进
      // 这一轮的状态块 —— 不在 set_vars 里求值攒到下一轮，那样中间一次进程重启
      // 就静默吞掉一次触发。沿状态落 .nd/（派生记账，丢了只是"上膛不击发"）。
      let trig = null;
      try {
        const parsed = parseTriggers(st.body || '');
        if (parsed.triggers.length || parsed.errors.length) {
          const { latch, fresh } = await readLatch(workspaceRoot);
          trig = evalTriggers(parsed.triggers, st.rows, latch, { fresh });
          try { await writeLatch(workspaceRoot, trig.latch); } catch (e) {
            console.warn('[vars] 沿状态写不进去，下一轮可能重复触发：', e.message);
          }
          if (trig.fired.length) {
            parts.push(`⚡ 这一拍有 ${trig.fired.length} 个条件命中了（你之前挂的）：\n`
              + trig.fired.map(f => `  · ${f.message}\n    （条件：${f.raw}）`).join('\n'));
          }
          const roster = [];
          if (trig.armed) roster.push(`${trig.armed} 条挂着`);
          if (trig.retired) roster.push(`${trig.retired} 条已退休`);
          if (roster.length) parts.push(`  触发器：${roster.join('、')}（声明在 ${st.rel} 的 \`\`\`nd:triggers 围栏里，删一行就是撤一条）`);
          for (const e of [...parsed.errors, ...trig.errors]) {
            parts.push(`  ⚠️ 触发器写错了，这条一直不会响：${e}`);
          }
        }
      } catch (e) { console.warn('[vars] 触发器求值失败：', e.message); }

      parts.push(`状态表现值（${st.rel}，共 ${st.rows.length} 格）：\n${table}\n`
        + `  改数字用 set_vars（只动那一格）；改表的结构/加说明文字才用 edit_board 的 set_text。`);
      sections.push({ key: 'vars', title: '状态表', text: parts.join('\n') });
    } else if (st.state === 'broken') {
      sections.push({
        key: 'vars',
        title: '状态表',
        text: `⚠️ 状态表读不出来了：${st.why}\n`
          + `  在修好之前 set_vars 会一直拒绝（它不会"尽力写"，那只会把表写得更坏）。`
          + `${st.rel ? ` Read 一下 ${st.rel} 看看表被改成什么样了。` : ''}`,
      });
    }
  } catch { /* 状态表这一节自己不能变成故障源 */ }

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
        '【黑板模式：开】用户此刻在画布上专注思考。这一轮默认这么做：先有纸再动笔（新话题 open_sheet）；'
        + '想事情就画成图（write_on_board 给 nodes/edges，小改动用 edit_board 原地改别重画）；'
        + '做完一件东西在它旁边写一条板书（near= 连线说明它说的是谁）；'
        + '用户标注了板上的东西就接在那条下面回（reply_to=）。侧栏照常回复，但板上已经写的别大段重复。'
        + '尺寸守规范（一张纸 = 一屏、正文 md 起、一条板书说一件事）；画完 look_at_board 看一眼再收。' });
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
    // 新的一轮：收尾闸重新记账（判的是「这一轮」，见 beat-state.js）
    resetBeat(sessionId);
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
