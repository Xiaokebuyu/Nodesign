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

/** @type {Map<string, EventBus>} */
const projectBuses = new Map();

/** 拿 project 的 EventBus（懒创建） */
export function getProjectBus(projectId) {
  let bus = projectBuses.get(projectId);
  if (!bus) {
    bus = new EventBus();
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
