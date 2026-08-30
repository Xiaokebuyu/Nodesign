/**
 * server/engine/agent/tool-input-stream.js —— 真流式工具入参（2026-07-28 建，
 * 2026-08-29 从 agent-shared.js 拆出：行数棘轮，胖了就拆别抬上限）
 *
 * input_json_delta 是半截 JSON 碎片。等拼完再发的话，模型逐 token 生成 new_string
 * 的几十秒里前端只能干转圈。这里对点名的工具累积缓冲区，节流用 partial-json 容错
 * 解析累积串，把目标字段相对上次的**纯文本增量**推给前端（run.delta.tool_input）。
 *
 * 转义符跨块断开由解析器兜住；字段单调增长，万一局部解析短暂回缩就跳过本拍
 * （append 只在变长时发）。
 */

import { Events } from './events.js';
import { toWorkspaceRel } from '../../lib/workspace-path.js';
import { parse as parsePartialJson, Allow as PartialAllow } from 'partial-json';

// ── 真流式工具入参（2026-07-28，工作台舞台层代码直播）──
// input_json_delta 是半截 JSON 碎片，等拼完再发一次的话，模型逐 token 生成
// new_string 的几十秒里前端只能干转圈。这里对写代码的工具累积缓冲区，节流用
// partial-json 容错解析累积串，把目标字段相对上次的纯文本增量推给前端
// （run.delta.tool_input）。转义符跨块断开由解析器兜住；字段单调增长，
// 万一局部解析短暂回缩就跳过本拍（append 只在变长时发）。
/**
 * `spot`（2026-08-29 占位契约刀 C）：跟 text 一起抽出来的**位置字段**。
 *
 * 在这之前流式板书的字画在"视口里一块空地"（BoardCanvas 的 liveChalkSpotFor），
 * 跟 agent 给的 at 毫无关系 —— 写完淡出、真卡在真位置接棒，用户看到的是字从假
 * 位置跳到真位置。站主要的是「先把位置选好，内容流到选定位置」。
 *
 * 时机不用另外等：判据跟 file_path 那套一样 —— **目标字段（text）的 key 一出现，
 * 就说明排在它前面的字段都已闭合**（所以 write_on_board 的 schema 把 at/sheet/
 * width 排到了 text 前面）。也就是说框在第一个字到达的那一刻立起来，正好。
 *
 * ⚠️ 不能只看 `at` 在不在：容错解析会把**没写完的数字**也交出来（`{"x": 123`
 * 流到一半是 `{x:12}`，完全合法且看不出来），用它当坐标就是错的位置。
 */
export const TOOL_INPUT_STREAM_FIELDS = {
  Edit: 'new_string',
  Write: 'content',
  // 板书直播（2026-08-25 流式路 A）：write_on_board 的 text 逐 token 流到画布上
  // 的舞台粉笔卡（StageLayer chalk 档）—— 粉笔字在用户眼前一行行长出来。
  mcp__nodesign__write_on_board: { field: 'text', spot: ['at', 'sheet', 'width', 'near', 'side'] },
  // board_batch 批内嵌套（08-25 用户报「流式名存实亡」：skill 教的是一章一次
  // batch，正文藏在 actions[].input.text 里，顶层字段抽取器抓不到 —— 等于亲手
  // 教了大家绕开流式）。batch 档抽**最新一条** write_on_board 动作的 text，
  // 换动作时发 reset 让前端另起一张。
  mcp__nodesign__board_batch: { batch: 'write_on_board', field: 'text', spot: ['at', 'sheet', 'width', 'near', 'side'] },
};
const TOOL_INPUT_THROTTLE_MS = 120;

export function toolInputStreams(ctx) {
  if (!ctx._toolInputStreams) ctx._toolInputStreams = new Map();
  return ctx._toolInputStreams;
}


/** 批内嵌套抽取（纯函数好钉测试）：最新一条 <tool> 动作的 <field> 字符串与它的序号 */
export function latestBatchField(obj, toolName, field) {
  const actions = Array.isArray(obj?.actions) ? obj.actions : [];
  for (let i = actions.length - 1; i >= 0; i -= 1) {
    const a = actions[i];
    const name = String(a?.name || '');
    if ((name === toolName || name.endsWith(`__${toolName}`)) && typeof a?.input?.[field] === 'string') {
      return { idx: i, text: a.input[field], input: a.input };
    }
  }
  return null;
}

/**
 * 位置字段抽取（占位契约刀 C）。只在**目标字段已经出现**时调用 —— 那时排在它
 * 前面的位置字段都已闭合，数字不会是流到一半的半截值。
 * @returns {object|null} 有什么给什么；一个都没有（agent 没指定位置）返回 null
 */
export function pickSpot(input, fields) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const k of fields) {
    const v = input[k];
    if (v === undefined || v === null) continue;
    // at 是 {x,y}：两个坐标都得是有限数才算数（缺一个就是没写完）
    if (k === 'at') {
      if (typeof v === 'object' && Number.isFinite(v.x) && Number.isFinite(v.y)) {
        out.at = { x: v.x, y: v.y };
      }
      continue;
    }
    if (typeof v === 'string' || Number.isFinite(v)) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

export function pumpToolInputStream(ctx, st, flush) {
  const now = Date.now();
  if (!flush && now - st.lastEmit < TOOL_INPUT_THROTTLE_MS) return;
  let obj;
  try { obj = parsePartialJson(st.buf, PartialAllow.ALL); } catch { return; }
  if (!obj || typeof obj !== 'object') return;
  let text = '';
  let reset = false;
  let host = obj;              // 位置字段所在的对象（batch 档是那条动作的 input）
  if (st.batch) {
    const hit = latestBatchField(obj, st.batch, st.field);
    if (hit) {
      if (st.actionIdx !== hit.idx) { st.actionIdx = hit.idx; st.sent = 0; st.spotSent = false; reset = true; }
      text = hit.text;
      host = hit.input;
    }
  } else {
    text = typeof obj[st.field] === 'string' ? obj[st.field] : '';
  }
  // 位置（刀 C）：目标字段已出现 = 排在它前面的位置字段都闭合了，这一拍可以定框。
  // 一条动作只发一次（batch 换动作时 spotSent 已随 reset 归位）。
  const spot = (!st.spotSent && st.spot && host?.[st.field] !== undefined)
    ? pickSpot(host, st.spot) : null;
  // file_path 只在确定流完后才取：容错解析会把半截字符串也带出来，第一拍常
  // 截在路径中间（e2e 撞过：抽到项目目录名 → 前端物件寻址指错）。目标字段的
  // key 出现（键序在 file_path 之后）或对象已有第二个键 = 路径已闭合。
  const pathComplete = obj[st.field] !== undefined || Object.keys(obj).length >= 2;
  // 发**工作区相对路径**（2026-08-13）：前端拿它当画布物件 id 的路径部分，
  // 而 id = 工作区相对路径。以前原样转发绝对路径，前端靠 `tasks/<任务>/`
  // 这个特征段抠相对部分 —— 那一层拆掉后绝对路径里没有可锚定的标志了。
  const rawFilePath = !st.filePathSent && pathComplete && typeof obj.file_path === 'string' ? obj.file_path : null;
  const filePath = rawFilePath ? toWorkspaceRel(rawFilePath, ctx.workspace?.root?.()) : null;
  const append = text.length > st.sent ? text.slice(st.sent) : '';
  if (!append && !filePath && !spot && !flush && !reset) return;
  st.lastEmit = now;
  if (append) st.sent = text.length;
  if (filePath) st.filePathSent = true;
  if (spot) st.spotSent = true;
  ctx.emit(Events.deltaToolInput(ctx.counters.turns, st.id, st.name, {
    ...(filePath ? { filePath } : {}),
    ...(spot ? { spot } : {}),
    ...(append ? { append } : {}),
    ...(reset ? { reset: true } : {}),
    ...(flush ? { done: true } : {}),
  }));
}

