import { useEffect, useState, useRef, useCallback } from 'react';
import { PencilLine, Terminal, X } from 'lucide-react';
import { COLOR, GAP, RADIUS, FONT_MONO, FONT_KAI, FONT_SIZE, TERM, CANVAS, alpha } from '../../lib/theme.js';
import { PAPER } from '../../lib/paper.js';
import MdInk from './cards/MdInk.jsx';
import { stageKindOf, resolveObjectId, zoneOfObjectId, fileNameOf, chipHintOf, toolLabelOf } from '../../lib/stage.js';
import { ZONE, STAGE_CARD_W, POP_IN } from '../../lib/board-geometry.js';
import { sizeOf } from '../../lib/board-kinds.js';
import { AskUserQuestionView } from '../chat/Message.jsx';
import ModelMark, { brandColor } from '../ui/ModelMark.jsx';
import { useCurrentModelBrand } from '../../lib/model-brand.js';

// （生图占位 2026-08-14 迁出：shimmer 从舞台层搬进纸面层的幻影物件
//   （PhantomLayer.jsx，幻影入座+座位过户）。舞台状态机仍然维护 image 条目
//   —— 它是幻影的数据源，只是不再由舞台渲染。）

/**
 * StageLayer — 舞台层（2026-07-28 重构 3 从 BoardCanvas 抽出）
 *
 * 桌面上的"第二渲染平面"：agent 的实时动作演出（代码直播 / 终端 / 生图
 * shimmer / chip / 已更新角标 / 画布内答题）。与桌面只共享一个事实——
 * "物件在哪"（positioned / 可见性），其余状态全部自治：
 *
 *   useStageState   事件驱动的卡片状态机（stageRef 接线、镜头跟随触发都在这）
 *   splitStageCards 渲染分流：锚得到可见物件 → 板内；锚不到 → dock
 *   StageBoardLayer 板内坐标系那一面（角标 + 贴物件卡），随桌面缩放
 *   StageDock       屏幕坐标系那一面（视口底部居中）
 *
 * 聊天时间轴与这里共享 lib/stage.js 的同一份事件翻译。
 */

// ── 状态机 ──

export function useStageState({
  stageRef, artifactRoots, followToObject,
  onStageTarget, onPreviewRequest,
  /**
   * 原始事件旁路。舞台层独占 `stageRef`，别的消费者（在场层）没有第二个入口 ——
   * 与其再开一条事件通道，不如让它在这儿分一份出去。**先分再处理**：舞台层
   * 自己的 switch 会 `return` 掉不认识的事件，放在后面就漏掉一半。
   */
  onRawEvent,
}) {
  const [stageCards, setStageCards] = useState({});
  const [stageBadges, setStageBadges] = useState({});
  // 铅笔精灵的手写行（2026-08-14 日记本批）：服务端把回复压成短句推过来
  // （run.sprite_summary）。曾经这里是 voice（正文流全文尾巴、SpriteVoiceBubble
  // 直播），同日退役：画布上要的是一行手写旁白，不是聊天记录的镜像。
  // ⚠️ 2026-08-19 前一个 round 会来两发（底稿 + haiku 精修覆盖，refined 标志
  // 谁压得过谁），那发 haiku 写死走订阅已整条拆除 —— 现在一发就是终稿，
  // 既不用 refined 也不用防"旧回合的精修迟到"。同批退役的还有 run.recap。
  const [spriteLine, setSpriteLine] = useState(null);   // { text }
  const followedBlocksRef = useRef(new Set());   // 每张舞台卡只推一次镜头
  // 用 ref 转一手：直接进 handleStageEvent 的依赖会让 stageRef 每次重挂，
  // 重挂的缝里到达的事件会丢。
  const onRawEventRef = useRef(null);
  onRawEventRef.current = onRawEvent;

  const removeStageCardLater = useCallback((blockId, ms) => {
    setTimeout(() => {
      setStageCards(prev => {
        if (!prev[blockId]) return prev;
        const next = { ...prev };
        delete next[blockId];
        return next;
      });
    }, ms);
  }, []);

  const newStageCard = (evt, kind) => ({
    blockId: evt.blockId, kind, tool: evt.name, status: 'running',
    text: '', filePath: null, objectId: null, oldString: null, startedAt: Date.now(),
  });

  const handleStageEvent = useCallback((evt) => {
    onRawEventRef.current?.(evt);
    switch (evt.type) {
      case 'run.sprite_summary': {
        // 子代理的话不上精灵 —— 主精灵只替主 agent 说话
        if (evt.parentToolUseId || !evt.text) return;
        setSpriteLine({ text: evt.text });
        break;
      }
      case 'run.tool_use.started': {
        const kind = stageKindOf(evt.name);
        if (!kind || !evt.blockId) return;
        setStageCards(prev => (prev[evt.blockId] ? prev : { ...prev, [evt.blockId]: newStageCard(evt, kind) }));
        break;
      }
      case 'run.delta.tool_input': {
        // 真流式：append = Edit.new_string / Write.content 的纯文本增量
        if (!evt.blockId) return;
        const oid = evt.filePath ? resolveObjectId(evt.filePath, artifactRoots) : null;
        setStageCards(prev => {
          const c = prev[evt.blockId] || newStageCard(evt, stageKindOf(evt.name) || 'code');
          return {
            ...prev,
            [evt.blockId]: {
              ...c,
              filePath: c.filePath || evt.filePath || null,
              objectId: c.objectId || oid,
              // 位置（08-29 刀 C）：agent 给的纸内坐标，随 text 的第一拍一起到 ——
              // 有它就能把字直接流到真位置，而不是先写在一块空地上再跳过去。
              // reset（批里换了一条）时跟着换成新那条的位置。
              spot: evt.reset ? (evt.spot || null) : (c.spot || evt.spot || null),
              // reset = 批里换了一条板书：另起一张（不清的话两条正文粘一起）
              text: evt.reset ? (evt.append || '') : c.text + (evt.append || ''),
            },
          };
        });
        if (oid && !followedBlocksRef.current.has(evt.blockId)) {
          followedBlocksRef.current.add(evt.blockId);
          onStageTarget?.(oid);
          followToObject?.(oid);
        }
        break;
      }
      case 'run.delta.tool_use': {
        // 完整入参快照（工具执行前到达）。Task/Agent 是 SILENT 工具
        //（kind 为 null 直接 return）—— 子代理动态在聊天时间轴的抽屉行里看。
        const kind = stageKindOf(evt.name);
        if (!kind || !evt.blockId) return;
        const input = evt.input || {};
        const oid = typeof input.file_path === 'string' ? resolveObjectId(input.file_path, artifactRoots) : null;
        setStageCards(prev => {
          const c = prev[evt.blockId] || newStageCard(evt, kind);
          const patch = {
            filePath: c.filePath || input.file_path || null,
            objectId: c.objectId || oid,
          };
          if (kind === 'code') {
            if (typeof input.old_string === 'string' && input.old_string) patch.oldString = input.old_string;
            const full = typeof input.new_string === 'string' ? input.new_string
              : typeof input.content === 'string' ? input.content : null;
            if (full != null && full.length > c.text.length) patch.text = full;
          } else if (kind === 'chalk') {
            // 完整入参快照兜底（不吐流式增量的模型也能看到全文）；画图调用没有 text；
            // board_batch 认批内最后一条 write_on_board 的 text
            const t = typeof input.text === 'string' ? input.text
              : Array.isArray(input.actions)
                ? [...input.actions].reverse().find(a => /write_on_board$/.test(String(a?.name || '')) && typeof a?.input?.text === 'string')?.input?.text
                : null;
            if (t && t.length > c.text.length) patch.text = t;
            else if (!t && (input.nodes || input.shapes || input.actions)) patch.sketching = true;
          } else if (kind === 'terminal') {
            patch.command = typeof input.command === 'string' ? input.command : '';
          } else if (kind === 'image') {
            patch.prompt = typeof input.prompt === 'string' ? input.prompt : '';
          } else if (kind === 'question') {
            patch.input = input;   // 完整 questions 给画布上的答题卡
          } else {
            patch.hint = chipHintOf(evt.name, input);
          }
          return { ...prev, [evt.blockId]: { ...c, ...patch } };
        });
        if (kind === 'code' && oid && !followedBlocksRef.current.has(evt.blockId)) {
          followedBlocksRef.current.add(evt.blockId);
          onStageTarget?.(oid);
          followToObject?.(oid);
        }
        break;
      }
      case 'run.deck_preview': {
        // preview_deck 工具：agent 把 deck 摊到用户眼前（= 用户双击那张卡）
        const oid = evt.path ? resolveObjectId(evt.path, artifactRoots) : null;
        if (oid) onPreviewRequest?.(oid, evt.path);   // 带路径：整站卡 id 丢掉了页信息
        break;
      }
      case 'run.delta.tool_result': {
        if (!evt.blockId) return;
        setStageCards(prev => {
          const c = prev[evt.blockId];
          if (!c) return prev;
          const patch = { status: evt.ok ? 'ok' : 'fail', doneAt: Date.now() };
          if (typeof evt.output === 'string' && evt.output) {
            patch.output = evt.output.split('\n').slice(-8).join('\n').slice(-1200);
          }
          if (!evt.ok && typeof evt.error === 'string') patch.error = evt.error.slice(0, 600);
          return { ...prev, [evt.blockId]: { ...c, ...patch } };
        });
        // 失败卡多留一会儿（红卡要被看见）但也自动收束 —— 详细错误在聊天时间轴
        // 里一直都有，画布不该积着一排要手点 × 的尸体（2026-07-29 用户反馈）
        removeStageCardLater(evt.blockId, evt.ok ? 1600 : 10000);
        break;
      }
      case 'run.file_changed': {
        // 物件"已更新"角标（在板上才有意义）
        const oid = resolveObjectId(evt.filePath, artifactRoots);
        if (!oid) return;
        // ⚠️ 这里曾经"agent 正在写 deck → 自动把那张卡展开成内嵌渲染"。
        // 展开态 2026-08-13 退役，而**不该原样映射成"自动开窗"** —— file_changed
        // 是每写一个文件就来一发，那会变成 agent 每存一次盘就把一扇模态窗拍在
        // 用户脸上。方卡自带实时缩略图，"工作过程当场可见"它自己就做到了；
        // 视图跟到那个文件夹由 onStageTarget 那条负责，不必在这儿再来一次。
        const ts = Date.now();
        setStageBadges(prev => ({ ...prev, [oid]: ts }));
        setTimeout(() => {
          setStageBadges(prev => {
            if (prev[oid] !== ts) return prev;
            const next = { ...prev };
            delete next[oid];
            return next;
          });
        }, 2600);
        break;
      }
      // （子代理舞台便利贴 2026-07-30 上、2026-08-18 退役：run.task.* /
      //   run.subagent.stop 不再进舞台层 —— 子代理动态收进聊天时间轴的
      //   Task 抽屉行（Message.jsx），画布不再为它们出卡。）
      case 'run.done':
      case 'run.error':
      case 'run.cancelled': {
        // 收场：残留 running/ok 卡淡出；失败卡留到自己的 10s 定时器收束
        setTimeout(() => {
          setStageCards(prev => {
            const next = {};
            for (const [k, c] of Object.entries(prev)) {
              if (c.status === 'fail') next[k] = c;
            }
            return next;
          });
        }, 900);
        followedBlocksRef.current.clear();
        // 手写行收场：工作精灵随 run 一起下场，行也一起清（闲时轮到问候语上）
        setTimeout(() => setSpriteLine(null), 900);
        break;
      }
      default: break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactRoots, followToObject, removeStageCardLater, onStageTarget, onPreviewRequest]);

  useEffect(() => {
    if (!stageRef) return;
    stageRef.current = { onEvent: handleStageEvent };
    return () => { stageRef.current = null; };
  }, [stageRef, handleStageEvent]);

  const dismissStageCard = useCallback((blockId) => {
    setStageCards(prev => {
      const next = { ...prev };
      delete next[blockId];
      return next;
    });
  }, []);

  return { stageCards, stageBadges, spriteLine, dismissStageCard };
}

// （2026-08-14 当日拆除：SpriteVoiceBubble —— 正文流直播泡只活了半天，被
//   铅笔精灵的手写短句取代（SpriteSketchLayer.jsx）。拆干净不留空壳。）

// ── 渲染分流 ──

/**
 * 落点三级兜底（2026-07-28）：
 *   ① 目标物件已经在墙上且可见 → 贴着它摆
 *   ② 物件还没上墙（新文件正在写，产物列表要等这次写完才知道它存在）
 *      → 贴到它天然归属的那块工作区里（zone id 由路径派生）
 *   ③ 连工作区都定位不到（路径认不出 / 那块区被收纳了）→ 落 dock
 *
 * ② 是这次补的：以前 ①失败直接掉 dock，于是"写新文件"的代码卡整场都钉在屏幕
 * 底部，等写完 file_changed 触发产物重拉、物件出现，才突然跳到文件旁边。
 */
/**
 * 落点兜底（2026-07-28；2026-08-14 生图占位迁出后简化）：
 *   ① 目标物件已经在墙上且可见 → 贴着它摆
 *   ② 物件还没上墙（新文件正在写，产物列表要等这次写完才知道它存在）
 *      → 贴到它天然归属的那块工作区里（zone id 由路径派生）
 *   ③ 连工作区都定位不到（路径认不出 / 那块区被收纳了）→ 落 dock
 *
 * image 卡不再走这里 —— 它是纸面层的幻影物件（PhantomLayer.jsx），
 * 占位在哪成品就落哪，跟舞台浮层无关。
 *
 * ⚠️ 曾经还有第三级兜底"回落到当前会话区"。会话不再产生画布物件
 * （2026-08-08）之后那一级只会指向一个不存在的 id，2026-08-13 拆掉：
 * 认不出来就老实掉 dock，别猜。
 */
export function splitStageCards({ stageCards, positioned, visibleIdSet, visibleZones, focusZone }) {
  const anchoredCards = [];
  const dockPanels = [];
  const dockChips = [];
  const spriteCards = [];
  const chalkCards = [];
  const visibleZoneOf = (zid) => (zid ? visibleZones.find(v => !v.collapsed && v.id === zid) : null);
  // 同一块区里并发的同类卡各占一个坑位，不要叠在同一个点上
  const slots = new Map();
  const takeSlot = (zid, kind) => {
    const k = `${zid}|${kind}`;
    const n = slots.get(k) || 0;
    slots.set(k, n + 1);
    return n;
  };
  for (const c of Object.values(stageCards)) {
    if (c.kind === 'image') continue;   // 幻影层接管（PhantomLayer.jsx）
    // 代码直播 / 终端 = 精灵的输出框（2026-08-14 用户拍板）：不再贴目标物件
    // 或掉 dock，跟着精灵走、绕它找位（AmbientSpriteLayer 的 findFrameSpot）。
    // 贴物件那条路留给"已更新"角标。
    if (c.kind === 'chalk') { chalkCards.push(c); continue; }   // 直接写在画布世界坐标里（08-25 拍板：不要浮层输入框）
    if (c.kind === 'code' || c.kind === 'terminal') { spriteCards.push(c); continue; }
    if (c.kind === 'chip') { dockChips.push(c); continue; }
    if (c.kind === 'question') { dockPanels.push(c); continue; }
    const o = c.objectId ? positioned.find(it => it.id === c.objectId) : null;
    if (o && visibleIdSet.has(o.id)) { anchoredCards.push({ card: c, obj: o }); continue; }
    const zid = zoneOfObjectId(c.objectId) || focusZone;
    const zr = visibleZoneOf(zid);
    if (!zr) { dockPanels.push(c); continue; }
    anchoredCards.push({ card: c, zoneRect: zr, slot: takeSlot(zr.id, c.kind) });
  }
  // 并发时序稳定：按开工时间排，"最近两张露出"的口径才不会抖
  spriteCards.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  chalkCards.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  return { anchoredCards, dockPanels, dockChips, spriteCards, chalkCards };
}

// ── 板内坐标系那一面（角标 + 贴物件卡）──

export function StageBoardLayer({ stageBadges, anchoredCards, positioned, visibleIdSet, boardSize, scale = 1, onDismiss }) {
  return (
    <>
      {Object.entries(stageBadges).map(([oid, ts]) => {
        const o = positioned.find(it => it.id === oid);
        if (!o || !visibleIdSet.has(oid)) return null;
        const sz = sizeOf(o);
        return (
          <div key={`${oid}:${ts}`} data-stage="badge" style={{
            position: 'absolute', left: o.pos.x + sz.w - 40, top: o.pos.y - 13,
            zIndex: 55, pointerEvents: 'none', animation: POP_IN,
            background: CANVAS.brass, color: COLOR.bgWhite, borderRadius: RADIUS.md,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, padding: `${GAP.xxs}px ${GAP.sm}px`,
          }}>已更新</div>
        );
      })}
      {anchoredCards.map(({ card, obj, zoneRect, slot }) => (
        <StageCard
          key={card.blockId}
          card={card}
          obj={obj}
          zoneRect={zoneRect}
          slot={slot}
          boardSize={boardSize}
          scale={scale}
          onDismiss={() => onDismiss(card.blockId)}
        />
      ))}
    </>
  );
}

// ── 屏幕坐标系那一面（dock）──

export function StageDock({ dockPanels, dockChips, onDismiss }) {
  if (dockPanels.length === 0 && dockChips.length === 0) return null;
  return (
    <div data-stage="dock" style={{
      position: 'absolute', left: '50%', bottom: 14, transform: 'translateX(-50%)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: GAP.sm,
      zIndex: 80, pointerEvents: 'none', maxWidth: '74%',
    }}>
      {[...dockPanels.filter(c => c.kind !== 'question'), ...dockPanels.filter(c => c.kind === 'question')]
        .slice(-3).map((card) => (
          <div key={card.blockId} style={{ pointerEvents: 'auto', width: card.kind === 'question' ? 'min(640px, 62vw)' : 'min(560px, 56vw)' }}>
            {card.kind === 'question'
              ? <QuestionStageCard card={card} onDismiss={() => onDismiss(card.blockId)} />
              : <StageCardBody card={card} onDismiss={() => onDismiss(card.blockId)} />}
          </div>
        ))}
      {dockChips.length > 0 && (
        <div style={{ display: 'flex', gap: GAP.sm, flexWrap: 'wrap', justifyContent: 'center', pointerEvents: 'auto' }}>
          {dockChips.map((card) => (
            <StageChip key={card.blockId} card={card} onDismiss={() => onDismiss(card.blockId)} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── 卡片组件 ──

/** 舞台卡（板内坐标系定位）：贴目标物件摆（右侧优先，放不下换左/下） */
function StageCard({ card, obj, zoneRect, slot = 0, boardSize, scale = 1, onDismiss }) {
  // 物件还没上墙：贴在工作区右上（标题栏下面），跟着这块区一起动。
  // 同区并发多张时逐张往左下错开，免得后来的把前面那张完全盖住。
  if (!obj && zoneRect) {
    const step = Math.min(slot, 3) * 18;
    const x = Math.max(12, Math.min(boardSize.w - STAGE_CARD_W - 12,
      zoneRect.x + zoneRect.w - STAGE_CARD_W - ZONE.pad - step));
    const y = zoneRect.y + ZONE.header + ZONE.pad + step;
    return (
      <div style={{ position: 'absolute', left: x, top: y, width: STAGE_CARD_W, zIndex: 60 + slot, pointerEvents: 'auto' }}>
        <StageCardBody card={card} scale={scale} onDismiss={onDismiss} />
      </div>
    );
  }
  const sz = sizeOf(obj);
  let x = obj.pos.x + sz.w + 24;
  let y = obj.pos.y;
  if (x + STAGE_CARD_W > boardSize.w - 12) x = obj.pos.x - STAGE_CARD_W - 24;
  if (x < 12) {
    x = Math.max(12, Math.min(boardSize.w - STAGE_CARD_W - 12, obj.pos.x));
    y = obj.pos.y + sz.h + 20;
  }
  y = Math.max(12, Math.min(boardSize.h - 400, y));
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: STAGE_CARD_W, zIndex: 60, pointerEvents: 'auto' }}>
      <StageCardBody card={card} scale={scale} onDismiss={onDismiss} />
    </div>
  );
}

/**
 * 舞台卡内容体（代码直播 / 终端）—— 板内锚定与 dock 共用。
 *
 * 2026-08-14 起它是**精灵的输出框**：头上一枚 Claude 星芒 + 跑动时描
 * 品牌橙边 —— 跟精灵徽记、语音泡同一个身份。墨面正文不动：机器写的
 * 东西保持等宽墨底，这条是设计语言的底线，换身份不换物料。
 */
export function StageCardBody({ card, scale = 1, onDismiss }) {
  void scale;   // 位移拖拽随子代理便利贴一起退役（2026-08-18），参数保留兼容调用方
  const running = card.status === 'running';
  const isTerm = card.kind === 'terminal';
  // 身份跟着会话模型走（08-21）：边色和徽记都是"谁在写这段代码"，跑 DeepSeek 就不该是 Claude 的橙
  const brand = useCurrentModelBrand();
  const border = card.status === 'fail' ? '#b0554f' : card.status === 'ok' ? '#4f8f5b' : alpha(brandColor(brand) || '#D97757', 0.7);
  const label = card.tool === 'Edit' ? '修改' : card.tool === 'Write' ? '写入' : toolLabelOf(card.tool);
  return (
    <div
      data-stage="card" data-stage-kind={card.kind} data-stage-status={card.status}
      style={{
        borderRadius: RADIUS.xxl, overflow: 'hidden', border: `1.5px solid ${border}`,
        background: TERM.bg, boxShadow: '0 10px 30px rgba(40,32,16,0.35)',
        animation: card.status === 'ok'
          ? `${POP_IN}, ndPulse 700ms ease-out, ndStageOut 380ms ease 1150ms forwards`
          : POP_IN,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm, padding: `${GAP.sm}px ${GAP.base}px`, background: 'rgba(255,255,255,0.06)' }}>
        {/* 深色终端面：铅笔稿在这儿是看不见的（它是给纸面画的），关掉；OpenCode 那枚换 onDark 档 */}
        <ModelMark brand={brand} size={12} pencil={false} dark />
        {isTerm ? <Terminal size={10} color="#c8b98c" /> : <PencilLine size={10} color="#c8b98c" />}
        <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: TERM.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {isTerm ? (card.command || 'bash') : `${label} · ${fileNameOf(card.filePath) || '…'}`}
        </span>
        {running ? (
          <span style={{ width: 10, height: 10, border: '1.5px solid rgba(232,226,210,0.35)', borderTopColor: TERM.ink, borderRadius: RADIUS.round, animation: 'ndSpin 800ms linear infinite', flexShrink: 0 }} />
        ) : (
          <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: card.status === 'ok' ? TERM.ok : TERM.err, flexShrink: 0 }}>
            {card.status === 'ok' ? '✓' : '✗'}
          </span>
        )}
        {card.status === 'fail' && (
          <button onClick={onDismiss} style={{ border: 0, background: 'transparent', color: TERM.ink, cursor: 'pointer', display: 'flex', padding: GAP.xxs }}>
            <X size={10} />
          </button>
        )}
      </div>
      {card.kind === 'code' && card.oldString && (
        <div style={{
          padding: `${GAP.xs}px ${GAP.base}px`, background: 'rgba(176,85,79,0.16)', color: '#dba49f',
          fontFamily: FONT_MONO, fontSize: 9.5, lineHeight: 1.5,
          whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 64, overflow: 'hidden',
          borderBottom: '1px solid rgba(255,255,255,0.05)',
        }}>
          {clampLines(card.oldString, 3)}
        </div>
      )}
      <AutoScrollPre
        text={isTerm ? (card.output || '') : card.text}
        running={running}
        color={isTerm ? '#cfe3cf' : '#d9e4c9'}
        placeholder={running ? (isTerm ? '运行中…' : '正在生成…') : ''}
      />
      {card.status === 'fail' && card.error && (
        <div style={{ padding: `5px ${GAP.base}px`, fontFamily: FONT_MONO, fontSize: 9.5, color: TERM.err, whiteSpace: 'pre-wrap', wordBreak: 'break-all', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          {card.error}
        </div>
      )}
    </div>
  );
}

/**
 * 板书直播 —— **直接写在画布上**（08-25 拍板：不要浮层输入框）。
 * 世界坐标裸板书的样子：楷体 md、无卡片外观、跟着镜头缩放平移；running 带光标，
 * 工具执行完淡出，真板书经 board.updated 上墙接棒。位置由 BoardCanvas 定
 * （视口里的一块空地，进行中钉死不追手）。
 */
export function ChalkLiveInk({ card, spot }) {
  if (!spot) return null;
  const running = card.status === 'running';
  // 落在 agent 自己选的位置上（08-29 刀 C）：画一道很淡的左缘，表示"这块地已经
  // 定下了，字正往里流"。落在我们找的空地上（agent 没给位置）时不画 —— 那块地
  // 并不是真的属于它，画个框反而是撒谎。
  const placed = spot.placed && running;
  return (
    <div data-stage="chalk-live" data-placed={spot.placed ? '1' : undefined} style={{
      position: 'absolute', left: spot.x, top: spot.y, width: spot.w || 432, zIndex: 3,
      pointerEvents: 'none', padding: '4px 6px', opacity: card.status === 'fail' ? 0.3 : 0.88,
      animation: card.status === 'ok' ? 'ndStageOut 500ms ease 700ms forwards' : POP_IN,
      ...(placed ? { borderLeft: `2px solid ${alpha(PAPER.ink, 0.16)}`, marginLeft: -8, paddingLeft: 6 } : null),
    }}>
      {card.sketching && !card.text
        ? <span style={{ fontFamily: FONT_KAI, fontSize: 14, color: COLOR.sub }}>（正在画图…）</span>
        : (
          <>
            <MdInk text={card.text || ''} fontFamily={FONT_KAI} fontSize={16} color={COLOR.ink} />
            {running && <span style={{ color: COLOR.sub, animation: 'ndSpin 1s steps(2) infinite' }}>▍</span>}
          </>
        )}
    </div>
  );
}

/** 代码/终端正文：文本追加时自动贴底滚动（直播视角永远看最新一行）*/
function AutoScrollPre({ text, running, color, placeholder }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  if (!text && !running) return null;
  return (
    <div ref={ref} style={{ maxHeight: 280, overflowY: 'auto', padding: `${GAP.md}px ${GAP.base}px` }}>
      <pre style={{ margin: 0, fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, lineHeight: 1.55, color, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {text || placeholder}
        {running && (
          <span style={{ display: 'inline-block', width: 6, height: 11, marginLeft: GAP.xxs, verticalAlign: '-2px', background: TERM.ink, animation: 'ndCaret 900ms step-end infinite' }} />
        )}
      </pre>
    </div>
  );
}

// （SubagentStickyCard + useCardDrag 2026-08-18 拆除：子代理便利贴退役，
//   动态收进聊天时间轴的 Task 抽屉行。拆干净不留空壳。）

/** agent 提问直接在画布里答：复用聊天栏的 wizard 卡（同一个 /answer 端点，
 *  谁先答谁生效，另一张随 tool_result 变已答态）*/
function QuestionStageCard({ card, onDismiss }) {
  const status = card.status === 'ok' ? 'success' : card.status === 'fail' ? 'error' : 'running';
  return (
    <div
      data-stage="card" data-stage-kind="question" data-stage-status={card.status}
      style={{
        borderRadius: RADIUS.xxl, border: `1.5px solid ${alpha(CANVAS.brass, 0.65)}`, background: COLOR.bg,
        boxShadow: '0 12px 34px rgba(40,32,16,0.28)', padding: GAP.md,
        maxHeight: '52vh', overflowY: 'auto',
        animation: card.status === 'ok' ? `${POP_IN}, ndStageOut 380ms ease 1150ms forwards` : POP_IN,
      }}
    >
      {Array.isArray(card.input?.questions) && card.input.questions.length > 0 ? (
        <AskUserQuestionView
          toolInput={card.input}
          toolOutput={card.output}
          status={status}
          toolUseId={card.blockId}
        />
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm, fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>
          <span style={{ width: 9, height: 9, border: `1.5px solid ${COLOR.borderLt}`, borderTopColor: COLOR.text, borderRadius: RADIUS.round, animation: 'ndSpin 800ms linear infinite' }} />
          agent 正在整理问题…
        </div>
      )}
      {card.status === 'fail' && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: GAP.sm }}>
          <button onClick={onDismiss} style={{
            display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
            border: `1px solid ${COLOR.borderLt}`, borderRadius: RADIUS.md,
            background: COLOR.bgCard, color: COLOR.text, cursor: 'pointer',
            padding: `${GAP.xs}px ${GAP.sm + 2}px`, fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
          }}><X size={10} /> 关闭</button>
        </div>
      )}
    </div>
  );
}

/** 轻量工具 chip：检索 / 读文件 / 装技能这类不抢戏的动作 */
function StageChip({ card, onDismiss }) {
  const running = card.status === 'running';
  return (
    <span
      data-stage="chip" data-stage-status={card.status}
      onClick={card.status === 'fail' ? onDismiss : undefined}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px',
        borderRadius: RADIUS.pill, background: 'rgba(33,30,23,0.88)', color: TERM.ink,
        fontFamily: FONT_MONO, fontSize: 9.5, animation: POP_IN,
        border: `1px solid ${card.status === 'fail' ? '#b0554f' : 'transparent'}`,
        cursor: card.status === 'fail' ? 'pointer' : 'default',
      }}
    >
      {running ? (
        <span style={{ width: 8, height: 8, border: '1.5px solid rgba(232,226,210,0.3)', borderTopColor: TERM.ink, borderRadius: RADIUS.round, animation: 'ndSpin 800ms linear infinite' }} />
      ) : (
        <span style={{ color: card.status === 'ok' ? TERM.ok : TERM.err }}>{card.status === 'ok' ? '✓' : '✗'}</span>
      )}
      {toolLabelOf(card.tool)}{card.hint ? ` ${card.hint}` : ''}
    </span>
  );
}

function clampLines(s, n) {
  const lines = String(s).split('\n');
  return lines.length <= n ? s : `${lines.slice(0, n).join('\n')}\n…`;
}
