/**
 * board-kind-sizes 覆盖断言（2026-08-28，写死表家族第 5 处的看门狗）。
 *
 * 前缀表已从 KINDS 注册表派生（第 4 处收敛），但 ARTIFACT_PREVIEW_H 仍是手写对象：
 * 加新形态忘了给它加一行，不报错 —— 新形态的卡掉到 file 兜底（224×32 细条），
 * agent 摆位按错矩形算，症状是"新形态的卡总被压"。这里把「注册表每个形态都有
 * 预览高」钉成断言：加形态漏表当场红，别等真会话摆坏了才发现。
 */
import { describe, it, expect } from 'vitest';
import { KINDS } from './kinds/index.js';
import { ARTIFACT_PREVIEW_H, estimateSize } from './board-kind-sizes.js';

describe('ARTIFACT_PREVIEW_H 覆盖注册表', () => {
  it('KINDS 里每个形态都有预览高（漏一行 = 该形态摆位矩形是 file 细条）', () => {
    for (const kind of Object.keys(KINDS)) {
      expect(Number.isFinite(ARTIFACT_PREVIEW_H[kind]), `形态「${kind}」没有 ARTIFACT_PREVIEW_H 行`).toBe(true);
    }
  });

  it('反向：表里的键除 browse 单例外都是真形态（改名/下线后别留幽灵行）', () => {
    for (const k of Object.keys(ARTIFACT_PREVIEW_H)) {
      if (k === 'browse') continue;   // 浏览器卡是单例，不在 KINDS 里（见 estimateSize 分支）
      expect(KINDS[k], `ARTIFACT_PREVIEW_H 里的「${k}」不在 KINDS 注册表`).toBeTruthy();
    }
  });

  it('注册表形态的卡不落 file 兜底（端到端一遍：estimateSize 真用上了预览高）', () => {
    for (const kind of Object.keys(KINDS)) {
      const { h } = estimateSize(`${kind}:某个产物.html`, null);
      expect(h, `形态「${kind}」的估高像 file 细条`).toBeGreaterThan(100);
    }
  });
});
