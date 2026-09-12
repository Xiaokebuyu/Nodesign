/**
 * write_on_board 的环境与板书落位解析（2026-09-12 从 write-on-board.js 抽出）。
 *
 * 为什么抽：落板和**流式预解算**要用同一套代码。入参流式到达，位置字段先闭合、正文再流；
 * 服务端在那一拍就用这里解一次落点，前端直播框立在真位置上（以前前端只能按关系近似、
 * 不避碰，落盘后再跳一次）。两条路一份代码，预告的和最后落的才是同一个地方。
 */
import { readBoard } from '../../../projects/board-store.js';
import { estimateSizeOn } from '../../../lib/board-kind-sizes.js';
import { layerOf, normalizeCanvasId } from '../../../lib/canvas-id.js';
import { UNIT, textBox, fitFor } from '../../../lib/sketch-layout.js';
import { CARD_MAX_H } from '../../../lib/screen.js';
import { obstaclesIn } from '../../../lib/board-obstacles.js';
import { lastOfGroup } from '../../../lib/board-place.js';
import { heroAfterLine, heroSize } from '../../../lib/board-hero.js';
import { makePlacer } from './write-on-board-place.js';
import { makeAnchorResolver, anchorMissHint } from '../../../lib/board-anchor.js';
import { getViewpoint } from '../../../projects/viewpoint-store.js';
import { CHALK_DIR } from '../../../lib/chalk.js';
import { ROLE_SLUG_RE } from '../../agent/cast.js';
import { WIDTH_UNITS } from './write-on-board-schema.js';
import { roleDefaultAnchor } from './write-on-board-role-anchor.js';
import { seatArtifacts } from '../../runs/board-seater.js';
import { learnedChalkWidth } from '../../../lib/chalk-size-pref.js';

/** 一次调用的环境：板、视点、锚解析、落位器。exclude = 障碍集里要剔掉的 id（自己的直播框） */
export async function makeChalkEnv({ projectId, sharedRoot, by, exclude = [] }) {
  const board = await readBoard(projectId);
  const known = new Set(Object.keys(board.zones || {}));
  // 这一层上谁占着地方（含文件夹卡/卷卡/精灵身位，见 lib/board-obstacles.js）。
  const obstaclesOf = (b, zone) => obstaclesIn(b, zone, { projectId, sharedRoot, exclude });
  const vp = getViewpoint(projectId);
  const fit = fitFor(vp);
  // 车道封顶（08-28）：触屏档一件不许超过一屏宽。**板书和草图两条路都要过它** ——
  // 只封一条的下场是真会话里量到的：草图乖乖 336，板书照旧 432（判据在 device-lane）。
  // ⛔ 要传 wUnits 不能事后夹 w：textBox 按宽度回推行数算高度，只夹宽＝文字溢出框外且不报错。
  const capUnits = fit.column ? Math.max(4, Math.floor(fit.w / UNIT)) : null;
  const capW = (u) => (capUnits ? Math.min(u || capUnits, capUnits) : u);
  const vpRectFor = (zone) => (vp && (vp.layer || '') === (zone || '') && vp.camera) ? vp.camera : null;
  // 锚点解析（真 id > tag 包络 > 救援入座）本体在 lib/board-anchor.js（棘轮拆件）
  // 宽认命中要如实报（09-11）：落点描述里点名的是真锚，这里再补一句「按什么认成了谁」
  const fuzzyNotes = []; const resolveAnchor0 = makeAnchorResolver({ projectId, known, readBoard, seatArtifacts });
  const resolveAnchor = async (raw, b) => { const a = await resolveAnchor0(raw, b); if (a?.fuzzy) fuzzyNotes.push(`（锚点按「${a.fuzzy.from}」认成了 ${a.anchorId}：${a.fuzzy.how}）`); return a; };
  // 意图层落位（见 write-on-board-place.js / lib/board-place.js）
  const { placeNote, describeSpot, describeChalkWrite, visibleIn } = makePlacer();
  /**
   * place 的解析：by 是锚（'view' = 没有锚，'user' = 他选中的），with 是组尾。
   * 返回 {anchor:{id,rect,zone,board}|null, group:{tag,rect}|null, error}
   */
  const resolvePlace = async (b, place, { allowView = true } = {}) => {
    const out = { anchor: null, group: null, error: null, view: false };
    if (!place) return out;
    if (place.with) {
      const tag = place.with;
      const g = lastOfGroup(b, tag, (id, e) => estimateSizeOn(b, id, e));
      if (g) out.group = { tag, rect: g, zone: layerOf(g.id, b.objects[g.id], known) };
      else out.groupMissing = tag;   // 组还没有东西：落视口，返回里说明
    }
    const by0 = place.by ? String(place.by).trim() : '';
    if (!by0 || by0 === 'view') { out.view = allowView; return out; }
    const raw = by0 === 'user' ? (vp?.selected?.[0] || null) : by0;
    if (!raw) { out.error = "place.by:'user' but the user has nothing selected — use 'view' or name a thing"; return out; }
    const a = await resolveAnchor(raw, b);
    if (!a) { out.error = `place.by ${raw} 不在板上：既没有座位、不是任何 tag，磁盘上也没有这个文件 —— ${anchorMissHint(raw, b)}。`; return out; }
    out.anchor = { id: a.anchorId, rect: a.rect, zone: a.zone, board: a.board };
    return out;
  };


  return { board, known, obstaclesOf, vp, fit, capW, vpRectFor, resolveAnchor, fuzzyNotes, placeNote, describeSpot, describeChalkWrite, visibleIn, resolvePlace, by, sharedRoot };
}

/**
 * 单条板书的落位解析：open_lane / chain / 角色缺省锚 / 宽度 / reply_to / near / 主角放大 / place /
 * 障碍集 / 卡高封顶 / 求解。返回 { error } 或全部中间量 + placed。
 * ⚠️ 会写 args.tag（进角色专线时跟线的 tag）—— 预解算传拷贝。
 */
export async function resolveChalkSpot(env, args, body) {
  const { board, known, by, sharedRoot, fit, capW, vpRectFor, resolveAnchor, resolvePlace, obstaclesOf, placeNote } = env;
  const fail = (t) => ({ error: t });
  // ── 开新线（open_lane）：模型声明拓扑，机器给这条线铺自己的纸 ──
  if (args.open_lane) {
    if (!args.tag) return fail('open_lane 要配 tag：tag 就是这条线的名字，后续用 {tag, chain:true} 续。');
    if (args.reply_to || args.chain || args.near || args.place?.with) {
      return fail('open_lane 是开新线，跟 reply_to/chain/near/place.with 互斥 —— 岔出点直接写在 open_lane 里。');
    }
    if (board.lanes?.[args.tag]) {
      return fail(`线 #${args.tag} 已经开过了（read_board 的「线的清单」那一节看得到）。接着写用 {tag:"${args.tag}", chain:true}；如需另开一条线，请更换名称。`);
    }
  }
  // chain：接在同 tag 最新一条**自己写的**板书后面（chapter 线程不再手抄路径）。
  // 接续权（2026-08-27 编排）：chain 是「续写我的线程」，永远不跨作者 ——
  // GM 的章节线和每个角色的叙事线各自延各自的，中间插了别人的话也不串线。
  let replyToRaw = args.reply_to || null;
  if (!replyToRaw && args.chain) {
    const chalks = Object.entries(board.objects)
      .filter(([id, e]) => id.startsWith(`${CHALK_DIR}/`) && Number.isFinite(e?.x)
        && (!args.tag || e.tag === args.tag) && (e.by || 'agent') === by)
      .map(([id]) => id).sort();
    if (chalks.length) replyToRaw = chalks[chalks.length - 1];
  }
  // 角色缺省锚（08-28；专线优先、「这一拍」其次，拆件见 write-on-board-role-anchor.js）
  let nearRaw = args.near || null;
  if (args.ink !== 'hand' && !replyToRaw && !nearRaw && !args.place && !args.open_lane
    && ROLE_SLUG_RE.test(by)) {
    const d = await roleDefaultAnchor({ board, by, sharedRoot });
    if (d.replyTo) {
      replyToRaw = d.replyTo;
      if (d.tag && !args.tag) args.tag = d.tag;   // 进线就着线的 tag，下一条才续得上
    }
  }

  const em = (l) => [...l].reduce((n, c) => n + (/[　-鿿＀-￯]/.test(c) ? 1 : 0.62), 0);
  const longest = Math.max(...body.split('\n').map(em));
  // 宽度三档回落（2026-08-28；09-05 档位改成词）：模型点名 > 用户调出来的偏好 > 按正文估。
  // 中间那档是「模仿用户」：他拖宽过板书就说明这个版心读着舒服，下一拍照做，
  // 别让他反复调同一件事。判据是前端拖手柄盖的 sized:'user' 章，模型盖不出。
  const wUnits = capW(WIDTH_UNITS[args.width] || learnedChalkWidth(board)
    || (longest <= 12 ? null : Math.max(12, Math.min(18, Math.ceil(longest * 16 / 24) + 1))));
  let box = textBox(body, args.size === 'sm' ? 'md' : (args.size || 'md'), { md: true, wUnits });

  let zone = '';
  let anchorId = null; let parentId = null;
  let replyRect = null; let anchorRect = null;
  let b2 = board;   // 救援入座后换新板（新座要进压上判定）
  // 开新线：岔出点解析（fresh = 无岔出点）
  let laneFrom = null;   // {id, rect} | 'fresh'
  if (args.open_lane) {
    if (args.open_lane === 'fresh') {
      laneFrom = 'fresh';
    } else {
      const a = await resolveAnchor(args.open_lane, board);
      if (!a) {
        return fail(`open_lane 的岔出点 ${args.open_lane} 不在板上 —— ${anchorMissHint(args.open_lane, board)}。全新话题用 open_lane:'fresh'。`);
      }
      laneFrom = { id: a.anchorId, rect: a.rect };
      zone = a.zone; if (a.board) b2 = a.board;
      // 分支线：岔出点 → 新线头（flow 读序），跟 near 的画线机制共用
      anchorId = a.anchorId; anchorRect = a.rect;
    }
  }
  if (replyToRaw) {
    const pid2 = normalizeCanvasId(replyToRaw);
    const e = pid2 ? board.objects?.[pid2] : null;
    if (!e || !Number.isFinite(e.x)) return fail(`reply_to ${replyToRaw} 不在板上（read_board 里看不到就接不上）。`);
    // 接续权（2026-08-27 编排）：角色的话头只有它自己和用户能接。主控接上去
    // 就是代笔/插嘴的物理形态 —— 这条按板上对象的**作者**判，不看内容不看场。
    // 角色之间可以互接（那就是对话），角色接主控的旁白也行。
    if (by === 'agent' && typeof e.by === 'string' && ROLE_SLUG_RE.test(e.by)) {
      return fail(`该条为「${e.by}」所写，不应在其下续写。如需它继续，请用 SendMessage`
        + `通知它，或让用户直接跟它说；你自己的旁白/场记另起一条（near 指过去就行）。`);
    }
    parentId = pid2; zone = layerOf(pid2, e, known);
    replyRect = { x: e.x, y: e.y, ...estimateSizeOn(board, pid2, e) };
  }
  if (nearRaw) {
    const a = await resolveAnchor(nearRaw, board);
    if (!a && !parentId) {
      return fail(`锚点 ${nearRaw} 不在板上：既没有座位、不是任何 tag，磁盘上也没有这个文件 —— ${anchorMissHint(nearRaw, board)}。`);
    }
    if (a) { anchorId = a.anchorId; anchorRect = a.rect; if (!parentId) zone = a.zone; if (a.board) b2 = a.board; }
  }
  // 这条板书自己那根线会不会把锚推成主角（放大 1.5 倍）？会的话按放大后的身位贴
  // （真案见 lib/board-hero.js heroAfterLine 头注）
  if (anchorId && anchorRect && heroAfterLine(b2, anchorId, by)) anchorRect = { x: anchorRect.x, y: anchorRect.y, ...heroSize(anchorId) };
  // place：落位锚可以跟画线锚不同（near 说「这条关于谁」，place.by 说「放在谁旁边」）
  let placeRect = anchorRect; let placeId = anchorId; let groupRect = null; let groupTag = null;
  const pl = await resolvePlace(b2, args.place);
  if (pl.error) return fail(pl.error);
  if (pl.anchor) { placeRect = pl.anchor.rect; placeId = pl.anchor.id; if (!parentId && !anchorId) zone = pl.anchor.zone; if (pl.anchor.board) b2 = pl.anchor.board; }
  else if (pl.view && args.place?.by === 'view') { placeRect = null; placeId = null; }
  if (pl.group) { groupRect = pl.group.rect; groupTag = pl.group.tag; if (!parentId && !placeRect) zone = pl.group.zone; }

  const obstacles = obstaclesOf(b2, zone);
  const vpRect = vpRectFor(zone);

  // 卡高封顶（09-05）：不再拒收。框按内容撑开，超过一卡的部分折在卡里，返回里如实报
  // —— 一条板书说一件事，真长的内容该是产物，这句话在返回里教，不在拒收里教。
  if (box.h > CARD_MAX_H) box = { ...box, fullH: box.h, h: CARD_MAX_H, capped: true };
  const placed = placeNote(b2, {
    box, anchorRect: placeRect, side: args.place?.side || null, groupRect, replyRect,
    obstacles, vpRect, column: fit.column,
    apart: laneFrom === 'fresh',   // 全新话题：视口满了另起一片，不接旧线尾（board-place.apartOf）
  });
  return { replyToRaw, nearRaw, wUnits, box, zone, anchorId, parentId, replyRect, anchorRect, b2, laneFrom,
    placeRect, placeId, groupRect, groupTag, pl, obstacles, vpRect, placed };
}
