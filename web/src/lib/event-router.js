/**
 * event-router —— WS 事件的分流判据（2026-08-14 可维护性行动 C 刀，从
 * ProjectWorkspace.handleEvent 抽出）。
 *
 * ## 为什么抽
 *
 * 一条 WS 通道进来的事件走三条管线：①舞台旁路（STAGE_EVENTS → stageRef，
 * **不 return**，同一事件可以继续走后面的管线）②聊天流折叠
 * （CHAT_STREAM_EVENTS → chat-stream reducer，消费即止）③控制帧与 run 生命
 * 周期（switch）。谁进哪条管线、哪些算过期 —— 这两个判据是"精灵丢状态"
 * 病族的老巢（六批通道体检、七修 run.start 死名单都在这里），却一直没有
 * 单测。抽成纯数据+纯函数，钉子见 event-router.test.js。
 *
 * ## 两张名单的关系
 *
 * 有交集是**刻意的**：`run.tool_use.started` 等既要演在画布上（舞台），又要
 * 折进聊天时间轴。管线 1 是旁路不短路，所以一个事件可以两边都吃。
 */

/** 舞台旁路（BoardCanvas stageRef：舞台卡 / 在场精灵 / 幻影 / 手写行） */
export const STAGE_EVENTS = new Set([
  // run.start（七修补进）：在场 reducer 的上场信号。曾不在名单 —— reducer 的
  // run.start 案是死路，精灵整个思考/开场白阶段装闲。
  // run.tool_use_summary 同批：reducer 的"正在做什么"案同样从没收到过事件。
  // ⚠️ 名单与 board-presence reducer 消费的类型有 parity 钉子
  //（board-presence.test.js："消费的类型必须在转发名单里"）——两头都在事件才活。
  'run.start', 'run.tool_use_summary',
  'run.tool_use.started', 'run.delta.tool_use', 'run.delta.tool_input', 'ui.chalk_edit',
  'run.delta.tool_result', 'run.file_changed', 'run.deck_preview',
  'run.done', 'run.error', 'run.cancelled',
  // 铅笔精灵：服务端压好的手写短句
  //（run.recap 2026-08-19 移出名单：收场 recap 随那条 haiku 小结线路一起退役，
  //  服务端不再 emit —— 名单里留着就是"等一个永远不来的事件"的空壳）
  'run.sprite_summary',
  // 板书落定（08-24 精灵体检 1a）：write_on_board 不走 Write/Edit，file_changed
  // 整条追踪链对它沉默 —— 精灵不知道 agent 在板上写了话。board.focus 带着
  // chalk 路径（= 画布 id），进在场 reducer 收编成目标。
  'board.focus',
  // 角色挂上/离开 await_user（2026-08-26）：角色挂着等用户时事件流是**静默**的，
  // 没有这条在场表分不出「在等你回话」和「已经没了」，精灵只能一直显工作态。
  'run.role.wait',
  // 角色上场（2026-08-27 编排）：candidacy —— 还没写过板书的角色也要有精灵
  // （候场位），在场条目从这条立，不再等 board.focus。
  'run.subagent.start',
  // 场声明变了（set_scene / 轮次推进 / pass_turn）：画布要知道轮到谁
  'run.scene',
  // run.subagent.stop **2026-08-26 只为常驻角色重新入列**：角色的在场条目
  // 由 board.focus 建立，而 run.done 分支明确跳过角色（它在后台自己活着）——
  // 于是它**一条删除路径都没有**，退场后精灵永远留在画布上当幽灵，
  // 而侧栏的 roleStage 会正确摘掉它 → 两个状态源背离。见 board-presence reducer。
  'run.subagent.stop',
  // （run.task.* 2026-08-18 移出名单：子代理便利贴与
  //   在场徽记退役，画布不再消费它们 —— 聊天侧栏的 Task 抽屉行走
  //   ProjectWorkspace 自己的 switch，不经这份名单。）
]);

/** 聊天流折叠（lib/chat-stream.js reducer 接管，消费即止） */
export const CHAT_STREAM_EVENTS = new Set([
  'run.delta.text', 'run.delta.thinking', 'run.tool_use_summary',
  'run.tool_use.started', 'run.delta.tool_use', 'run.delta.tool_result',
]);

/**
 * 过期判据：WS replay / 跨 session 旁路 / 多 tab 同 sid 收到非当前 turn 的
 * delta。**两个条件都是"有值且不匹配才算过期"** —— 事件没带 id（老事件没
 * enrich）或本地还没有基准（首条消息 POST 未返回）时一律放行，宁可多收一拍
 * 也不能把新一轮的开头吞掉（run.start 认领与 delta 同拍到达的老案）。
 *
 * @param {object} evt  WS 事件
 * @param {{ runId?: string|null, sessionId?: string|null }} live 本地基准
 */
export function isStaleEvent(evt, { runId = null, sessionId = null } = {}) {
  if (!evt) return false;
  return Boolean(
    (evt.runId && runId && evt.runId !== runId)
    || (evt.sessionId && sessionId && evt.sessionId !== sessionId),
  );
}
