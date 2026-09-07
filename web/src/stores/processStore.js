/**
 * stores/processStore.js — 进程卡的客户端状态（2026-09-07 桌面端·缝三）
 *
 * 真相在服务端登记表（engine/process/registry.js），这里是它的镜像：
 *   - load(pid)         拉一次全量
 *   - applyEvent(evt)   WS 的 process.changed / process.log 打进来（aux-events.js 转发）
 *   - 动作直接打接口，结果靠事件回流，不做乐观更新（进程状态不该猜）
 *
 * 日志每个进程只留最近 400 行，跟服务端环形缓冲一样大；要更早的去看 .nd/processes/<id>.log。
 */

import { create } from 'zustand';
import { Processes } from '../lib/api.js';

const LOG_KEEP = 400;

export const useProcessStore = create((set, get) => ({
  /** pid → { list: Process[], logs: { [id]: string[] }, loaded: boolean } */
  byProject: {},

  _bucket(pid) {
    return get().byProject[pid] || { list: [], logs: {}, loaded: false };
  },

  load: async (pid) => {
    const { processes } = await Processes.list(pid);
    set((s) => ({ byProject: { ...s.byProject, [pid]: { ...get()._bucket(pid), list: processes, loaded: true } } }));
    return processes;
  },

  applyEvent: (evt) => {
    const p = evt?.process;
    if (!p?.projectId) return false;
    const pid = p.projectId;
    set((s) => {
      const b = s.byProject[pid] || { list: [], logs: {}, loaded: false };
      let list = b.list;
      const logs = { ...b.logs };
      if (evt.type === 'process.changed') {
        const i = list.findIndex((x) => x.id === p.id);
        list = i >= 0 ? list.map((x) => (x.id === p.id ? { ...x, ...p } : x)) : [p, ...list];
      } else if (evt.type === 'process.log') {
        const cur = logs[p.id] || [];
        const next = cur.concat(evt.lines || []);
        logs[p.id] = next.length > LOG_KEEP ? next.slice(next.length - LOG_KEEP) : next;
        if (!list.some((x) => x.id === p.id)) list = [p, ...list];
      }
      return { byProject: { ...s.byProject, [pid]: { ...b, list, logs } } };
    });
    return true;
  },

  fetchLog: async (pid, id) => {
    const { lines } = await Processes.log(pid, id, LOG_KEEP);
    set((s) => {
      const b = s.byProject[pid] || { list: [], logs: {}, loaded: false };
      return { byProject: { ...s.byProject, [pid]: { ...b, logs: { ...b.logs, [id]: lines } } } };
    });
  },

  start: (pid, command, name) => Processes.start(pid, { command, name }),
  stop: (pid, id) => Processes.stop(pid, id),
  restart: (pid, id) => Processes.restart(pid, id),
  remove: async (pid, id) => {
    await Processes.remove(pid, id);
    set((s) => {
      const b = s.byProject[pid];
      if (!b) return {};
      const logs = { ...b.logs }; delete logs[id];
      return { byProject: { ...s.byProject, [pid]: { ...b, list: b.list.filter((x) => x.id !== id), logs } } };
    });
  },
}));
