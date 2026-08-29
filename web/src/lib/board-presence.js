/**
 * 在场（presence）—— 把主 agent 当成画布上的另一个「人」。
 *
 * ## 2026-08-18 子代理退场
 *
 * 这里曾同时追踪每个子代理（run.task.* 上下场、file_changed 挪位置、
 * PresenceLayer 画小徽记）。当日拍板全部退役：子代理的动态收进聊天时间轴
 * 的 Task 抽屉行（Message.jsx），画布上只剩主 agent 的铅笔精灵。带
 * parentToolUseId 的事件（子代理所为）一律忽略 —— 尤其不能算到主 agent
 * 头上，算错了主精灵就会在子代理动的文件之间瞬移。
 *
 * ## 思路
 *
 * 取自 tldraw 的 `TLInstancePresence`（多人协作里每个协作者一条记录：光标、
 * 选中了什么、镜头在哪、叫什么名字、什么颜色、正在跟着谁）。**抄的是这个
 * 数据模型，不是它的代码。**
 *
 * 为什么对我们成立：Nodesign 的 agent 本来就是"另一个在这块板上干活的人"。
 * 它有位置（正在动哪个文件）、有选中（当前目标）、有话说（正在做什么）。
 * 以前这些信息只以**瞬时**形式存在 —— 舞台卡飘一下、跑完就收（StageLayer）——
 * 于是「谁在哪干活」这件事从来没有被持续地表达过。
 *
 * ## 它解决的具体问题
 *
 * 「跟随」以前是跟着**事件**跑（哪个文件被写就飞过去），镜头会在不同来源的
 * 事件之间来回横跳。有了 presence 就能跟**人**（主 agent），稳定得多。
 *
 * ## 这里只做纯逻辑
 *
 * 从既有事件流（run.start / file_changed / delta.tool_input / run.done）
 * 归约出一张在场表。不新增任何服务端事件 —— 信号本来就都有，缺的是把它们
 * 攒成"人"而不是"一串卡片"。
 */
import { CANVAS, COLOR } from './theme.js';

/**
 * 在场者的颜色。用**暖色系里能互相分开**的几支，不用彩虹色 ——
 * 画布是纸面，饱和度高的光标会像贴纸一样浮在上面，很吵。
 */
export const PRESENCE_COLORS = [
  CANVAS.brass,   // 暖棕（主 agent，跟"正在动"的光圈同色）
  '#7C8F6B',   // 苔绿
  '#8A6E9E',   // 灰紫
  COLOR.error,   // 朱
  '#5A7A9A',   // 石青
  '#9E7B5A',   // 陶
];

/** 主 agent 固定第一色（子代理退场后只剩它在用，色表留着备多在场者回归） */
export function colorFor(index) {
  return PRESENCE_COLORS[index % PRESENCE_COLORS.length];
}

export const MAIN_AGENT_ID = 'agent:main';

/**
 * 常驻角色（RP 叙事者 / NPC）在场表里的 id。
 *
 * 2026-08-18 曾把子代理整体从在场表里拆掉（每个子代理一个小徽记 = 噪音）。
 * 现在回来的**只有常驻角色**这一类：它们不是"跑一下就完事的工具人"，是一直
 * 在场、在板上写字、跟用户对话的角色 —— 用户需要看见谁在写。
 * 干活型子代理（vision-checker 那类）照旧不进在场表。
 */
export const rolePresenceId = (slug) => `role:${slug}`;
export const isRolePresence = (id) => typeof id === 'string' && id.startsWith('role:');
export const slugOfPresence = (id) => (isRolePresence(id) ? id.slice(5) : null);

/** 在场者的身份（名字、色号、种类）。角色的展示名由渲染层按 slug 查，这里先放 slug */
function identityOf(id) {
  if (isRolePresence(id)) {
    const slug = slugOfPresence(id);
    // 色号按 slug 稳定派生：同一个角色每次都是同一支颜色，换会话也不变
    const h = [...slug].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 997, 7);
    return { kind: 'role', name: slug, color: colorFor(1 + (h % 5)), slug };
  }
  return { kind: 'main', name: 'Claude', color: colorFor(0) };
}

/** 事件属于谁：常驻角色的事件带 actor（服务端盖章），其余算主 agent */
function actorOf(evt) {
  const a = evt?.actor;
  return typeof a === 'string' && a.startsWith('rp-') ? rolePresenceId(a) : MAIN_AGENT_ID;
}

/**
 * 空表。形状固定，调用方不用到处判空。
 * `[id]: { id, name, kind, color, targetId, zoneId, message, active, at }`
 */
export function emptyPresence() {
  return {};
}

/**
 * 把一条事件归约进在场表（纯函数，不改入参）。
 *
 * 只认这些信号，别的一律原样返回：
 * - `run.start`            主 agent 上场
 * - `run.delta.tool_input` / `run.file_changed`  在动哪个文件 → 更新位置
 * - `run.tool_use.started` / `run.tool_use_summary`  正在做什么 → 更新那句话
 * - `run.done` / `run.error` / `run.cancelled` 下场
 *
 * 带 parentToolUseId 的事件（子代理所为）一律忽略（2026-08-18 子代理退场）。
 *
 * @param {object} table 当前在场表
 * @param {object} evt   事件
 * @param {(fileOrId:string)=>{objectId:string, zoneId:string}|null} resolve
 *        把文件路径解析成画布物件（调用方给，因为寻址规则住在 stage.js）
 */
export function reducePresence(table, evt, resolve) {
  if (!evt?.type) return table;
  // 子代理的事件：**常驻角色**为自己立条目（它一直在场、在板上写字，用户要看见
  // 是谁在写）；干活型子代理照旧丢弃（08-18 拆徽记的理由没变 —— 跑一下就完事的
  // 工具人立条目只是噪音）。丢弃时尤其不能算到主 agent 头上，那会让主精灵在
  // 子代理写的东西之间瞬移。
  if (evt.parentToolUseId && !evt.actor) return table;
  const t = evt.type;
  const who = actorOf(evt);

  /**
   * 主 agent 的"接管显形"（2026-08-14）：主 agent 的活动事件到了但表里没有它
   * —— 典型场景是**切进一个正在跑的会话**（run.start 早发过了，这个标签页没
   * 看见）。活动本身就是"在跑"的铁证，就地把主 agent 立起来，别把整轮事件
   * 当无主拒收（那就是"换会话精灵丢状态"）。
   */
  const materializeMain = () => ({
    ...table,
    [who]: {
      id: who, ...identityOf(who),
      active: true, targetId: null, zoneId: null, message: null, at: evt.at || null,
    },
  });

  switch (t) {
    case 'run.start': {
      const cur = table[who];
      if (cur?.active) return table;
      return {
        ...table,
        [who]: {
          id: who, ...identityOf(who), active: true,
          // 常驻（2026-08-14）：上一轮的落点不清零 —— 精灵从"住的地方"起飞
          // 滑向新目标，而不是凭空消失再冒出来。
          targetId: cur?.targetId ?? null, zoneId: cur?.zoneId ?? null,
          message: null, at: evt.at || null,
        },
      };
    }

    // 在动哪个文件 → 更新位置。两个来源：
    //   run.delta.tool_input  Edit/Write 入参正在流（filePath 是工作区相对路径，
    //                         路径闭合就发、只发一次）—— 精灵**开写就位**，不等
    //                         写完。只听 file_changed 的话，一个大文件写十几秒，
    //                         精灵全程站在上一个目标上（2026-08-14「追踪不及时」
    //                         的另一半病根；run.delta.tool_use 不听 —— 那条快照
    //                         里的 file_path 是绝对路径，前端解析不了）。
    //   run.file_changed      写完落盘（权威，兜住非流式工具写的文件）。
    case 'run.delta.tool_input':
    case 'run.file_changed': {
      let cur = table[who];
      if (!cur) {
        table = materializeMain();
        cur = table[who];
      }
      // ⚠️ 字段名是 `filePath`（events.js:fileChanged 的真实形状）。这里曾读
      // `evt.path || evt.file` —— 两个都不存在，resolve(undefined) 恒 null，
      // **在场者的位置从未被设置过**，镜头跟随和精灵定位因此整个失效；
      // 而 19 条测试全绿，因为测试自己 mock 了一套不存在的事件形状
      // （2026-08-13 查实）。真形状现在有 parity 断言钉在测试里。
      const hit = resolve?.(evt.filePath);
      if (!hit) {
        // 解析不到 ≠ 路径是错的 —— 多半是**新文件**：开写就位和落盘两发事件
        // 都赶在产物清单收编它之前，直接丢就再没有事件来救了（"从 0 产物到
        // 有产物追踪不靠谱"的病根，2026-08-14 查实）。把路记在案，清单刷新
        // 后 resolvePending 补射。
        if (!evt.filePath || cur.pendingFile === evt.filePath) return table;
        return { ...table, [who]: { ...cur, pendingFile: evt.filePath } };
      }
      if (cur.targetId === hit.objectId && cur.zoneId === hit.zoneId) {
        return cur.pendingFile ? { ...table, [who]: { ...cur, pendingFile: null } } : table;
      }
      return { ...table, [who]: { ...cur, targetId: hit.objectId, zoneId: hit.zoneId, pendingFile: null, at: evt.at || cur.at } };
    }

    // "正在做什么"那句话。⚠️ 事件类型是 `run.tool_use.started`（只带工具名）
    // 和 `run.tool_use_summary`（SDK 的一句话摘要，更好读，来了就覆盖）——
    // 这里曾监听不存在的 `run.tool_use`，message 永远是 null（同上那批测试
    // 假形状事故）。
    case 'run.tool_use.started':
    case 'run.tool_use_summary': {
      let cur = table[who];
      if (!cur) {
        table = materializeMain();
        cur = table[who];
      }
      const msg = evt.summary || evt.name || null;
      if (!msg || cur.message === msg) return table;
      return { ...table, [who]: { ...cur, message: msg } };
    }

    // 角色上场（2026-08-27 编排）：派发那一刻就立条目 —— 之前条目由 board.focus
    // 建立，于是「还没写过板书的角色」在画布上不存在，用户看不见谁在候场。
    // targetId 留空 = 没有落点，渲染层给它排候场位（findAmbientSlot）。
    case 'run.subagent.start': {
      const slug = evt.agentType;
      if (typeof slug !== 'string' || !slug.startsWith('rp-')) return table;
      const id = rolePresenceId(slug);
      if (table[id]) return table;
      return {
        ...table,
        [id]: { id, ...identityOf(id), active: true, targetId: null, zoneId: null, message: null, at: evt.at || null },
      };
    }

    // 板书落定（08-24 精灵体检 1a）：MCP 板上工具不产生 run.delta.tool_input /
    // run.file_changed —— 上面那条链对板书整个沉默，精灵留在旧目标上，服务端
    // 落位又看不见精灵（它不是 board object），于是"板书压精灵、精灵不让"。
    // board.focus 是板书落定的唯一信号，chalk 字段就是画布 id。只在活跃时收编
    //（草图没有单一对象 id，不进来 —— 它有黑板模式的镜头跟随）。
    case 'board.focus': {
      const tid = evt.chalk || null;
      if (!tid) return table;
      const cur = table[who];
      // 角色：板书落定就是它「正在写」的证据，没有条目就地立一个 —— 它的在场
      // 不跟主 run 的 active 走（角色在后台写字时主 run 可能早就收了）。
      // 主 agent：照旧只在活跃时更新，不然闲着的精灵会被别人的落定拽走。
      if (isRolePresence(who)) {
        const base = cur || { id: who, ...identityOf(who), message: null };
        if (cur && cur.targetId === tid && cur.active) return table;
        return { ...table, [who]: { ...base, active: true, targetId: tid, zoneId: evt.layer || null, at: evt.at || base.at || null } };
      }
      if (!cur?.active) return table;
      if (cur.targetId === tid) return table;
      return { ...table, [who]: { ...cur, targetId: tid, zoneId: evt.layer || null, at: evt.at || cur.at } };
    }

    // （run.role.wait / run.scene 两个分支 2026-08-29 随收件箱与场声明一起退役。
    //  小人的「在写 / 写完了」现在只看子代理起飞落地：run.subagent.start 立条目、
    //  run.subagent.stop 收场，中间它就是在写。）

    // 角色退场（2026-08-26）：**唯一**的删除路径。
    // 角色不跟主 run 收场（下面那个分支明确跳过它），所以没有这条它就永远留在画布上。
    // ⚠️ 只认常驻角色：干活型子代理压根没进过这张表（上面那条 parentToolUseId 守卫挡掉了）。
    case 'run.subagent.stop': {
      const id = evt.agentType ? rolePresenceId(evt.agentType) : null;
      if (!id || !isRolePresence(id) || !table[id]) return table;
      const next = { ...table };
      delete next[id];
      return next;
    }

    case 'run.done':
    case 'run.error':
    case 'run.cancelled': {
      // 整轮结束：下场。
      // ⚠️ cancelled 曾不在案（2026-08-14 查实）：用户取消一轮之后精灵
      // 永远停在"正在干活"里转圈 —— 收场信号三种，一种都不能漏。
      let touched = false;
      const next = {};
      for (const [id, p] of Object.entries(table)) {
        // ⚠️ 常驻角色不跟主 run 收场：它在后台自己活着（挂在 await_user 上等用户、
        // 或正在写下一段），主 agent 这一轮结束跟它没关系。一起收的话，派发那个
        // 回合一结束角色精灵就灭了，而它其实还在写（2026-08-26 审出）。
        if (isRolePresence(id)) { next[id] = p; continue; }
        // pendingFile 一起清：挂账的是"这一轮正在写的新文件"，轮都收了账就作废
        if (p.active) { touched = true; next[id] = { ...p, active: false, message: null, pendingFile: null }; }
        else next[id] = p;
      }
      return touched ? next : table;
    }

    default:
      return table;
  }
}

/**
 * 产物清单刷新后的补射（2026-08-14）：位置事件到达时目标还不是画布物件
 * （新文件），路径挂在 pendingFile 上 —— 清单每次变化调这个重试解析，
 * 解析到了精灵才真正走到新卡上。没变化返回原表（setState 按引用 bail）。
 */
export function resolvePending(table, resolve) {
  let changed = false;
  const next = {};
  for (const [id, p] of Object.entries(table || {})) {
    if (p.active && p.pendingFile) {
      const hit = resolve?.(p.pendingFile);
      if (hit) {
        next[id] = { ...p, targetId: hit.objectId, zoneId: hit.zoneId, pendingFile: null };
        changed = true;
        continue;
      }
    }
    next[id] = p;
  }
  return changed ? next : table;
}

/** 当前真正在场的那些（渲染和跟随都只看这个） */
export function activePresences(table) {
  return Object.values(table || {}).filter(p => p.active);
}

/**
 * 镜头该跟谁。表里如今只有主 agent —— 有目标且在场才跟，
 * 不做"跟最近动的那个"（那正是以前镜头横跳的原因）。
 */
export function followTarget(table) {
  const act = activePresences(table).filter(p => p.targetId);
  if (!act.length) return null;
  return act.find(p => p.kind === 'main') || act[0];
}

/**
 * 在场者的目标矩形解析链：物件本身 → 它住的文件夹 → 文件夹的顶层段
 * （桌面只画根层）。主精灵（BoardCanvas 的工作态落点）走这一条，落点
 * 永远一致。（原住 PresenceLayer.jsx；徽记层 2026-08-18 拆除后搬回这里。）
 */
export function rectFor(p, rectOf) {
  const direct = rectOf(p.targetId);
  if (direct) return direct;
  if (!p.zoneId) return null;
  const byZone = rectOf(p.zoneId);
  if (byZone) return byZone;
  const top = p.zoneId.includes('/') ? p.zoneId.split('/')[0] : null;
  return top ? rectOf(top) : null;
}

/**
 * 就地标注发出瞬间的**本地合成在场**（E4，从 BoardCanvas 拆出 —— 行数棘轮）：
 * 真事件（run.start / file_changed）要过服务端一圈才回来，先本地把精灵放到
 * 目标上。message 固定为 HINT_MESSAGE —— 它就是"这是合成条目"的指纹，
 * expireHint 靠它区分"真事件已接管"（接管必换 message）。
 */
export const HINT_MESSAGE = '收到，来了';

export function hintPresence(prev, targetId, zoneId) {
  const cur = prev[MAIN_AGENT_ID] || {};
  return {
    ...prev,
    [MAIN_AGENT_ID]: {
      id: MAIN_AGENT_ID, kind: 'main', name: 'Claude', color: colorFor(0),
      at: null,
      ...cur,
      active: true, targetId, zoneId, message: HINT_MESSAGE,
    },
  };
}

/**
 * 合成在场的看门狗收场（08-24 精灵体检）：合成的 active 没有 run.done 给它
 * 收场 —— 标注 POST 失败 / run 压根没起时，精灵会永久钉在那张卡上。
 * 只在还是合成条目（message 未被真事件换掉）时才下场。
 */
export function expireHint(prev) {
  const cur = prev[MAIN_AGENT_ID];
  if (!cur?.active || cur.message !== HINT_MESSAGE) return prev;
  return { ...prev, [MAIN_AGENT_ID]: { ...cur, active: false } };
}
