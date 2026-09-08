/**
 * stores/repoStore.js — 仓库卡的刷新信号（2026-09-08）。
 *
 * 仓库卡和仓库窗自己拉数据（Repo.*），这里只放「该重拉了」的计数和上一轮结算：
 *   - version：agent 每写一个仓库文件 +1、每轮结算 +1。卡面和窗订着它，变了就重拉。
 *   - lastTurn：最近一轮 { runId, changed }，卡面一行小字用。
 */
import { create } from 'zustand';

export const useRepoStore = create((set) => ({
  version: 0,
  lastTurn: null,
  touch: () => set((s) => ({ version: s.version + 1 })),
  turnDone: (evt) => set((s) => ({ version: s.version + 1, lastTurn: { runId: evt.runId, changed: evt.changed || [], at: Date.now() } })),
}));
