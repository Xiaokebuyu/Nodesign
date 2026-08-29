/**
 * engine/agent/stage-status.js —— 「台上现在有谁、谁在写、谁刚写完」（2026-08-29）
 *
 * ## 它补的洞
 *
 * 主持人此前对角色的状态是半盲的：派发的返回、SendMessage 的返回、角色结束时的
 * task-notification —— 全是**事件的瞬间**，没有任何地方能回答「现在怎么样了」。
 * 2026-08-28 真会话里用户自己问出了这个洞（「感觉说书人是不是都需要重启一下？」），
 * 而主持人手里最接近的工具 read_scene 只会背一遍它自己声明过的东西。
 *
 * ## 判据只用 harness 盖的章
 *
 *   在写   SubagentStart 到了、SubagentStop 还没到
 *   刚写完 SubagentStop（`last_assistant_message` 是它收笔时说的话，SDK 现成给）
 *
 * 两个都不是模型能写的（feedback-verify-the-instrument）。这里**不记**「它写了什么
 * 板书」—— 那份真相在画布上，每回合状态块本来就注入最近板书，重复一份就会有两份
 * 各执一词的账。
 *
 * 生命周期：内存态、跟会话走，runSession 的 finally 里清。
 */

const stages = new Map();   // projectId → Map<slug, { writing, startedAt, finishedAt, lastLine }>

function tableFor(projectId) {
  if (!stages.has(projectId)) stages.set(projectId, new Map());
  return stages.get(projectId);
}

/** 角色起飞（SubagentStart，名字由别名桥解析出来） */
export function noteRoleStart(projectId, slug) {
  if (!projectId || !slug) return;
  const t = tableFor(projectId);
  const prev = t.get(slug) || {};
  t.set(slug, { ...prev, writing: true, startedAt: Date.now(), finishedAt: null });
}

/** 角色收笔（SubagentStop）。lastLine = 它这一轮最后说的话，截短存 */
export function noteRoleFinish(projectId, slug, lastLine = null) {
  if (!projectId || !slug) return;
  const t = tableFor(projectId);
  const prev = t.get(slug) || {};
  t.set(slug, {
    ...prev,
    writing: false,
    finishedAt: Date.now(),
    lastLine: lastLine ? String(lastLine).replace(/\s+/g, ' ').trim().slice(0, 120) : (prev.lastLine || null),
  });
}

/**
 * 台上一览（给主持人的每回合状态块用）。
 * @returns {Array<{slug, writing, lastLine, idleMs}>} 按「在写的排前面」排序
 */
export function stageStatus(projectId) {
  const t = stages.get(projectId);
  if (!t || !t.size) return [];
  const now = Date.now();
  return [...t.entries()]
    .map(([slug, v]) => ({
      slug,
      writing: !!v.writing,
      lastLine: v.lastLine || null,
      idleMs: v.finishedAt ? now - v.finishedAt : 0,
    }))
    .sort((a, b) => Number(b.writing) - Number(a.writing) || a.slug.localeCompare(b.slug));
}

/** 会话收摊 */
export function clearStageStatus(projectId) { stages.delete(projectId); }

/** 测试用 */
export function _resetStageStatus() { stages.clear(); }
