/**
 * server/ws/broker.js — Per-project EventBus 注册表
 *
 * 每个 project 一个 EventBus 实例，agent runAgent 跑 turn 时通过 ctx.eventBus.publish
 * 推事件，WS 客户端订阅同一个 bus 收 stream。
 *
 * Bus 是 in-memory pub/sub，不持久化。重启 server 后所有订阅断开，新事件从零开始；
 * 前端要能容忍这个（重连后通过 hydrate 重新拉项目状态，丢的事件不补）。
 */

import { EventBus } from '../engine/agent/events.js';
import { attachLiveTurnTracker } from '../engine/runs/live-turn.js';
import { attachBoardTasklist } from '../engine/runs/board-tasklist.js';
import { attachBoardSeater } from '../engine/runs/board-seater.js';

/** @type {Map<string, EventBus>} */
const projectBuses = new Map();

/** 拿 project 的 EventBus（懒创建） */
export function getProjectBus(projectId) {
  let bus = projectBuses.get(projectId);
  if (!bus) {
    bus = new EventBus();
    // live-turn 快照折叠器：进行中 turn 的事件物化成可恢复状态，
    // WS 重连走"hydrate + ws.live_turn 快照 + 尾随"三段协议。见 live-turn.js
    attachLiveTurnTracker(bus);
    // 步骤清单镜像成板书 + 每步产物连线（2026-08-23 黑板文化，harness 做不靠 agent 记得）
    attachBoardTasklist(bus, projectId);
    // 服务端入座（2026-08-25 范式重做④）：本轮新产物 run 收尾一批排座
    attachBoardSeater(bus, projectId);
    projectBuses.set(projectId, bus);
  }
  return bus;
}

/**
 * project 删除时清理 bus（释放内存）。
 * 不影响已建立的 ws 连接 — 它们还能 publish 但不再有订阅者。
 */
export function disposeProjectBus(projectId) {
  projectBuses.delete(projectId);
}
