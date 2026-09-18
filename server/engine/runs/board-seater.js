/**
 * server/engine/runs/board-seater.js —— 服务端入座（2026-08-25 范式重做④）
 *
 * 病根（08-25 信箱实证）：入座算法原来只住前端 board-seating.js，只在浏览器渲染
 * 那一层时发生。agent 写完 `小说/第一章.md`，26 秒后 `write_on_board {near:它}`
 * 失败「还没有座位」，6 小时后依然没有 —— 用户没打开过那个文件夹。而工具描述
 * 正教 agent「Use it right after you finish something」。read_board 同病：刚写的
 * 文件看不见 → agent 误判"没上画布" → 去 pin → 重影。
 *
 * 这里把入座下沉：挂在 project bus 上收本轮的 run.file_changed，**回合末一批**
 * 排座（站主拍板的时机）。判据不新写黑名单 —— 复用 task-scan 的同一套排除件
 * （隐藏目录 / node_modules / _drafts / 保留文件），层隔离照 layerOf。
 *
 * 板书领养：prelude 说「你写的每张 .md 在桌面上渲成贴纸」，但 Write 直接落
 * notes/板书/ 的文件从来不上墙（10-05 friction）。这里把它领养成正式板书：
 * 认 frontmatter（nd: chalk 的 anchor/reply_to/tag），照 write_on_board 同款
 * 画线落座 —— 从此那句 prelude 是真话。
 *
 * 座位一律 seat:'auto'（可被前端重排）；已有座位的绝不动。
 *
 * ## 2026-09-05 意图层：机器的手 = 同一个求解器
 *
 * 纸和暂存架都退役了（lib/board-place.js 头注有数据）。到货落位只有四档，全走
 * 求解器：接楼（板书带 replyTo）> 贴着锚（板书带 anchor）> 用户视口的空地 >
 * 内容底下。没有「等 agent 安置」这一档：东西到了就有位置，agent 要摆到别处
 * 用 pin_to_board{place} / edit_board move{to:{by,…}} 说关系。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { readBoard, patchBoard } from '../../projects/board-store.js';
import { getSharedDir } from '../../projects/workspace.js';
import { estimateSizeOn } from '../../lib/board-kind-sizes.js';
import { obstaclesIn } from '../../lib/board-obstacles.js';
import { layerOf, normalizeCanvasId } from '../../lib/canvas-id.js';
import { placeBelow, solvePlace } from '../../lib/board-place.js';
import { FOLDER_CARD as FOLDER_BOX } from '../../lib/board-kind-sizes.js';
import { textBox } from '../../lib/sketch-layout.js';
import { getViewpoint } from '../../projects/viewpoint-store.js';
import { parseChalk, CHALK_DIR } from '../../lib/chalk.js';
import { isReservedFile, HARD_IGNORE_DIRS, RESERVED_DIRS, DRAFTS_DIR } from '../../lib/task-scan.js';
import { applyFollows } from '../../lib/board-follow.js';
import { canvasIdForRel } from '../../lib/canvas-id.js';
import { cardIdForPath, KIND_PREFIX_RE } from '../../lib/kinds/index.js';
import { isCanvasFolder } from '../../lib/folder-claims.js';
import { dirCardOn } from '../../lib/board-anchor.js';
import { GENERATED_DIR, inGeneratedDir } from '../../lib/generated-folder.js';

const MAX_SEATS_PER_RUN = 24;   // 一轮生成几百个文件的（构建产物漏网）也别刷爆板

/**
 * 会渲染成卡的才配座位：跟 api/assets.js 的扫描面**同一形状**（09-07 设计线对账 A2/C3）。
 * 此前这里只抄了 task-scan 的排除件，于是两面不对称：assets/references/**、exports/** 有座位却
 * 不渲染（read_board 报一批用户看不见的东西、状态块催 agent 去 pin 而 pin 拒收）；
 * _drafts/<名>.html 渲染成卡却永远没座位（near / place.by 全失败）。现在按扫描口逐条对齐：
 *   - 根上的 _drafts/<名>.html 是正式产物（kinds/site.js single 实例）→ 入座；_drafts 更深的不算
 *   - assets/ 只有三个口上墙：顶层文件、generated/<文件>、notes/<文件>
 *   - notes/ 顶层便利贴 + notes/板书/ 板书；exports / node_modules / agent-memory 整段不上墙
 */
export function seatable(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 300) return false;
  if (rel.startsWith('/') || rel.includes('\\') || rel.includes('\0')) return false;
  const segs = rel.split('/');
  if (segs.some(s => s === '..' || HARD_IGNORE_DIRS.has(s))) return false;
  // 点开头的段（.nd/.claude/.thumbnails…）整条不渲染
  if (segs.some(s => s.startsWith('.'))) return false;
  if (isReservedFile(segs[segs.length - 1])) return false;
  const [top] = segs;
  if (top === DRAFTS_DIR) return segs.length === 2 && /\.html?$/i.test(segs[1]);
  if (segs.includes(DRAFTS_DIR)) return false;
  if (top === 'assets') return segs.length === 2 || (segs.length === 3 && (segs[1] === 'generated' || segs[1] === 'notes'));
  if (top === 'notes') return segs.length === 2 || (segs.length === 3 && `${segs[0]}/${segs[1]}` === CHALK_DIR);
  if (RESERVED_DIRS.has(top)) return false;
  return true;
}

let seq = 0;
const stamp = () => `${Date.now().toString(36)}${(seq++ % 1000).toString(36)}`;

/**
 * 给一批相对路径排座（幂等：已有座位的跳过）。导出给测试与手动对账用。
 *
 * 09-17（问题库 iss_mt9cmke6_pset）：返回里带上**点名的每条路径最后落在哪张卡上**。救援入座
 * （lib/board-anchor.js）原来按 `deck:<路径>` / 裸路径回查，而这里按注册表落的是 `site:X`、
 * `site:_drafts/x.html`、`docx:x.docx` —— 查不到就报「磁盘上也没有这个文件」，第二次调用才成功。
 *   ids      rel → 卡 id（这一批坐下的，或那张卡本来就有座位）
 *   missing  真去磁盘上查过、文件不在的 rel（只有这一类才配说「磁盘上没有」）
 *   skipped  不上画布的 rel（seatable 不收的位置，或普通目录 —— 目录是文件夹卡，不是文件卡）
 * @returns {Promise<{seated: number, lines: number, pending: number, ids: object, missing: string[], skipped: string[]}>}
 */
export async function seatArtifacts(projectId, rels) {
  const trace = { asked: new Set(rels), relId: new Map(), deadIds: new Set(), missing: [], skipped: [], live: {} };
  const out = await seatBatch(projectId, rels, trace);
  const ids = {};
  for (const rel of trace.asked) {
    const id = trace.relId.get(rel);
    if (id && !trace.deadIds.has(id) && Number.isFinite(trace.live[id]?.x)) ids[rel] = id;
  }
  return { ...out, ids, missing: trace.missing, skipped: [...rels.filter((r) => !seatable(r)), ...trace.skipped] };
}

/** 一批排座的本体；trace 收集回报用的中间量（rel → 卡 id、文件不在 / 不该坐的卡、本批的 live） */
async function seatBatch(projectId, rels, trace) {
  const sharedRoot = getSharedDir(projectId);
  const board = await readBoard(projectId);
  // 待摆队列先并进来（刀 G）：上一批排不下的，这一批 agent 可能已经规划出地方了。
  // 排在新来的前面 —— 等得久的先落。
  const queued = Array.isArray(board.pending) ? board.pending : [];
  const all = [...new Set([...queued, ...rels])].filter(seatable);
  // 这一批只处理前 2×上限；再往后的**进待摆队列**而不是静默丢（09-07 设计线对账 B1：
  // 原来 slice 掉的第 49 件起既不入座也不排队，构建产物一多就悄悄少东西）
  const uniq = all.slice(0, MAX_SEATS_PER_RUN * 2);
  const overflow = all.slice(MAX_SEATS_PER_RUN * 2);
  if (!uniq.length) return { seated: 0, lines: 0, pending: 0 };
  const known = new Set(Object.keys(board.zones || {}));
  const vp = getViewpoint(projectId);
  const objects = {}; const bindings = {};
  // 本批内后来者要避开先来者：live 副本随排随更新
  const live = { ...board.objects };
  trace.live = live;
  // 暂存架（2026-08-30）：批内原点算一次（架立了就不挪）；本批内后来者靠
  // live 障碍矩形自然码在先来者下面。
  const rootCam = (vp?.camera && !vp.layer) ? vp.camera : null;
  const stillPending = [];          // 本批没轮到的（只剩封顶截流一种情况）
  let seated = 0; let lines = 0;

  // 文件夹卡也上架（2026-08-30，站主拍板「文件夹和单个文件一律落暂存区」）：
  // 这批文件揭示的顶层目录，还没有文件夹卡坐标的，先码在架上 —— 前端的
  // newStackedZoneRect 只给没坐标的排位，这里写了它就不再排。判据与 seatable
  // 同一套精神：保留目录（assets/notes/…）和隐藏目录不是用户的文件夹。
  const zonesPatch = {};
  const noFolder = new Set();
  const zoneRects = Object.entries(board.zones || {})
    .filter(([, z]) => Number.isFinite(z?.x) && Number.isFinite(z?.y))
    .map(([, z]) => ({ x: z.x, y: z.y, w: FOLDER_BOX.w, h: FOLDER_BOX.h }));
  for (const rel of uniq) {
    const segs = rel.split('/');
    if (segs.length < 2 || !seatable(rel)) continue;
    // 生成图文件夹（09-18）：assets/ 是保留目录，但 assets/generated 在画布上是「生成图」文件夹卡
    const gen = inGeneratedDir(rel);
    const top = gen ? GENERATED_DIR : segs[0];
    if ((!gen && RESERVED_DIRS.has(top)) || zonesPatch[top] || noFolder.has(top)) continue;
    if (board.zones?.[top] && Number.isFinite(board.zones[top].x)) continue;
    // 站点 / word 文件夹 / 构建目录不是文件夹卡（09-17 iss_mtp465ds_ctko）：原来不问就建，
    // 建出来的坐标前端不画，锚点解析却先认它 —— 「X（site）」被认成一层隐形文件夹。判据与 /artifacts 同一份
    // 先看板上有没有同名的目录型卡（便宜），没有再按扫描口径判（要读 manifest）
    if (!gen && (dirCardOn({ objects: live }, top) || !(await isCanvasFolder(sharedRoot, top).catch(() => false)))) { noFolder.add(top); continue; }
    const rootRects = Object.entries(live)
      .filter(([id, e]) => Number.isFinite(e?.x) && layerOf(id, e, known) === '')
      .map(([id, e]) => ({ x: e.x, y: e.y, ...estimateSizeOn(board, id, e) }));
    // 新文件夹卡：用户视口的空地，没有视口就排在内容底下（2026-09-05 求解器）
    const spot = solvePlace({ box: FOLDER_BOX, viewport: rootCam, obstacles: [...rootRects, ...zoneRects] });
    zonesPatch[top] = { x: spot.x, y: spot.y };
    zoneRects.push({ x: spot.x, y: spot.y, w: FOLDER_BOX.w, h: FOLDER_BOX.h });
    known.add(top);   // 这批的文件按新文件夹归层（跟前端 homeOf 同判）
  }

  const seenIds = new Set();
  const { asked, relId, deadIds } = trace;   // 回报用：rel → 卡 id；文件不在 / 不该坐的卡
  for (const rel of uniq) {
    let id = canvasIdForRel({ objects: live, zones: board.zones }, rel);
    if (!id) continue;
    // 还没上墙的产物**问注册表**要正字法 id（09-07 站主：站点卡「没有碰撞面积」案）：
    // canvasIdForRel 对没见过的 html 一律猜 deck:<路径>，于是 `第二站/index.html` 被排成
    // 「第二站」层里的一张 deck 幻影，而画布上真正的卡是桌面层的 `site:第二站` —— 它从此
    // 没有服务端座位、也不在任何障碍集合里，后来的东西全压在它身上。pin_to_board 早就走
    // cardIdForPath 了，这里同口径。一个站的多个文件归一张卡，只排一次。
    if (!live[id]) {
      try { const canon = await cardIdForPath(sharedRoot, rel); if (canon) id = canon; } catch { /* 按猜的来 */ }
    }
    relId.set(rel, id);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    // 已有座位就不动 —— 除非那是前端抢先排的临时座（provisional，见 board-sanitize）：
    // 前端 packRow 不认障碍（真案：deck 压在文件夹卡上、site 压在 deck 上），服务端按
    // 障碍重解一次，写回时清标。用户拖过的（seat:'user'）不算临时。
    const prev0 = live[id];
    const provisional = !!(prev0 && Number.isFinite(prev0.x) && prev0.provisional && prev0.seat === 'auto');
    if (prev0 && Number.isFinite(prev0.x) && !provisional) continue;
    // 封顶截流：没轮到的留在队列里下批再来（暂存架永远有地方，这是唯一的排队原因）
    if (seated >= MAX_SEATS_PER_RUN) { stillPending.push(rel); continue; }
    // 文件还在才入座（本轮建又删的别复活）
    let st = null;
    try { st = await fs.stat(path.join(sharedRoot, rel)); } catch { deadIds.add(id); if (asked.has(rel)) trace.missing.push(rel); continue; }
    // 普通目录不当文件卡坐（09-17）：前端把它画成文件夹卡（zones），裸路径座位是一张画不出来的幽灵。
    // 站点 / word 文件夹 / 演出这类目录型产物有形态前缀，照常入座。
    if (st.isDirectory() && !KIND_PREFIX_RE.test(id)) { deadIds.add(id); if (asked.has(rel)) trace.skipped.push(rel); continue; }

    let box = estimateSizeOn(board, id, null);
    let anchorRect = null; let replyRect = null;
    let anchorId = null; let parentId = null; let tag = null; let by = null;

    // 板书领养：Write 直接落盘的 notes/板书/*.md 按 frontmatter 接线
    if (rel.startsWith(`${CHALK_DIR}/`) && rel.endsWith('.md')) {
      try {
        const raw = await fs.readFile(path.join(sharedRoot, rel), 'utf8');
        const { body, chalk } = parseChalk(raw);
        if (chalk) {
          by = chalk.by;
          tag = chalk.tag || null;
          box = textBox(body, 'md', { md: true });
          if (chalk.anchor) {
            const aid = normalizeCanvasId(chalk.anchor);
            const e = aid && live[aid];
            if (e && Number.isFinite(e.x)) { anchorId = aid; anchorRect = { x: e.x, y: e.y, ...estimateSizeOn(board, aid, e) }; }
          }
          if (chalk.replyTo) {
            const pid2 = normalizeCanvasId(chalk.replyTo);
            const e = pid2 && live[pid2];
            if (e && Number.isFinite(e.x)) { parentId = pid2; replyRect = { x: e.x, y: e.y, ...estimateSizeOn(board, pid2, e) }; }
          }
        }
      } catch { /* 读不到就按普通文件排 */ }
    }

    const zone = layerOf(id, live[id], known);
    const obstacles = obstaclesIn(board, zone, { objects: live, exclude: [id], projectId, sharedRoot });
    // 落位（2026-09-05 求解器）：接楼 > 贴着锚 > 视口空地 > 内容底下。
    // 文件夹卡不在 objects 里，根层避让要把 zoneRects 一并算上。
    let placed = null;
    if (replyRect) placed = placeBelow(replyRect, box, obstacles);
    else if (anchorRect) placed = solvePlace({ box, anchor: anchorRect, side: 'below', obstacles });
    else placed = solvePlace({ box, viewport: zone ? null : rootCam, obstacles: [...obstacles, ...(zone ? [] : zoneRects)] });
    const entry = {
      x: Math.round(placed.x), y: Math.round(placed.y), z: 1,
      w: Math.round(box.w), h: Math.round(box.h),
      seat: 'auto', provisional: false,   // 不写 zone：归属由路径回答（09-07，见 layerOf）
      ...(by ? { by } : {}), ...(tag ? { tag } : {}),
    };
    objects[id] = entry; live[id] = entry;
    seated += 1;
    if (anchorId) { bindings[`b:a${stamp()}`] = { type: 'annotates', from: id, to: anchorId, by: by || 'agent', ...(tag ? { tag } : {}) }; lines += 1; }
    if (parentId) { bindings[`b:a${stamp()}`] = { type: 'flow', from: parentId, to: id, by: by || 'agent', material: 'pencil', ...(tag ? { tag } : {}) }; lines += 1; }
  }

  // 收编（09-14 问题库：站点目录里的 data.js / sheet.css / render.js 各占一个散件座位）：
  // agent 先写资源、后写 index.html 且分在不同批时，资源到的那一刻目录还不是站，只能按裸路径入座；
  // 站点卡坐下之后这些座位就归它 —— 画布本来就不画它们（assets.js 把整个站点目录认领给站点卡），
  // 留着只剩 read_board 里的散件和一堵看不见的墙。早先按 deck:<站>/x.html 猜出来的座位同理。
  let absorbed = 0;
  for (const cardId of Object.keys(live)) {
    const dir = cardId.startsWith('site:') ? cardId.slice(5) : '';
    if (!dir || !live[cardId]) continue;
    for (const [k, e] of Object.entries(live)) {
      const bare = k.replace(/^deck:/, '');
      if (!e || e.kind || /^[a-z]+:/.test(bare) || !bare.startsWith(`${dir}/`)) continue;
      objects[k] = null; delete live[k]; absorbed += 1;
    }
  }

  // 队列整表写回：**必须无条件写**，哪怕这一批一件都没坐下 ——
  // 队列清空也是一次状态变化（旧 pending 这一轮上了架，队列该空）。
  stillPending.push(...overflow);
  const pendingChanged = JSON.stringify(queued) !== JSON.stringify(stillPending);
  const zoned = Object.keys(zonesPatch).length;
  if (seated || absorbed || pendingChanged || zoned) {
    await patchBoard(projectId, {
      ...(seated || absorbed ? { objects, bindings } : {}),
      ...(zoned ? { zones: zonesPatch } : {}),
      ...(pendingChanged ? { pending: stillPending } : {}),
    });
  }
  // 领养的板书带 tag：有人跟着这个 tag（状态板）就自动重锚（fail-soft）
  for (const [id, e] of Object.entries(objects)) {
    if (e?.tag) { try { await applyFollows(projectId, { tag: e.tag, newId: id }); } catch { /* */ } }
  }
  return { seated, lines, pending: stillPending.length, absorbed };
}

/**
 * 挂 project bus（与 board-tasklist 同栖）。时机 = **即时**：file_changed 攒 1.5s
 * 就排一批（回合中写完马上 near 它/read_board 都要看得见 —— 惰性到回合末只修
 * 一半病）；run 收尾再冲一次兜底（防抖窗口里挂掉的尾巴）。
 */
const FLUSH_MS = 1500;

export function attachBoardSeater(bus, projectId) {
  const pending = new Set();
  let timer = null;
  const flush = async () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!pending.size) return;
    const batch = [...pending]; pending.clear();
    try {
      const { seated } = await seatArtifacts(projectId, batch);
      // 上架的要出声：架不是版面，agent 得给它们找地方（状态块每回合也点名）
      if (seated) {
        bus.publish({ type: 'board.updated', sessionId: null,
          summary: `${seated} 件新产物入了座` });
      }
    } catch (err) {
      console.warn('[board-seater]', projectId, err?.message || err);
    }
  };
  const unsubscribe = bus.subscribe('*', (evt) => {
    if (!evt?.runId) return;
    if (evt.type === 'run.file_changed') {
      // 两种历史载荷形状都认（Events.fileChanged 的 filePath / 旧内联对象的 path）
      const rel = typeof evt.filePath === 'string' ? evt.filePath : (typeof evt.path === 'string' ? evt.path : null);
      if (!rel || !seatable(rel)) return;
      pending.add(rel);
      if (!timer) timer = setTimeout(flush, FLUSH_MS);
      return;
    }
    if (evt.type === 'run.done' || evt.type === 'run.cancelled' || evt.type === 'run.error') void flush();
  });
  // 项目删除时由 broker.disposeProjectBus 调（09-17，iss_mtjex6wv_5xhn）：攒着的 1.5s 批次不再落板，
  // 否则删完之后它还会 patchBoard 一次（写画布会把工作区建回来，现在是撞 PROJECT_GONE）
  return () => {
    unsubscribe();
    if (timer) { clearTimeout(timer); timer = null; }
    pending.clear();
  };
}
