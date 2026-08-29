/**
 * engine/agent/rp-mode.js —— 「RP 编排机械开不开」的唯一谓词（2026-08-28 归一）
 *
 * 此前这个判断散在三处、口径不一：stage-broadcast 判 mode==='rp'，scene.js 和
 * roles.js 不判 —— design 项目手动 cast_role 之后进入「半条腿」状态：say 能开轮、
 * onRoleWait 能推进，广播却整机不转，没有任何一处报错。
 *
 * 归一口径（08-28）：**编排机械（台上广播 / 轮次机 / set_scene）只在 rp 模式活**；
 * 直投通道（say 私语、cue_role、SendMessage 召回）任何模式都通 —— design 项目里
 * 轻度 RP（blackboard-rp skill + cast_role）照样能跟角色说话，只是没有机器替它转。
 */

import { getProject } from '../../projects/store.js';

export function isRpProject(projectId) {
  return !!projectId && (getProject(projectId)?.mode || 'design') === 'rp';
}
