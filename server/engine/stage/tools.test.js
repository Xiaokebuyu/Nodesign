import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createStageTools } from './tools.js';

/**
 * 演出进程的工具面（2026-09-05）。
 *
 * ⛔⛔ 第二条是血案：write_scene 的 `state` 原来写成 z.record(...)，SDK 在 init 里报
 * stage:connected，**tools 里却一件 mcp__stage__ 都没有** —— 四件工具整体消失，不报错。
 * 模型于是把整拍连把手写成纯文本，台上一个字都没落。逐字段二分才逮到（z.record 一进
 * schema 就中，跟值类型无关）。这条钉子递归扫每个工具的 zod shape：record 一律不许进。
 */
function walk(schema, seen = new Set()) {
  if (!schema || typeof schema !== 'object' || seen.has(schema)) return [];
  seen.add(schema);
  // 注册表里的 inputSchema 是**裸 shape**（{字段: zod}），不是 ZodObject —— 没有 _def 就当字段表扫
  if (!schema._def) return Object.values(schema).flatMap(v => walk(v, seen));
  const out = [schema];
  const d = schema._def || {};
  for (const inner of [d.innerType, d.type, d.valueType, d.keyType, d.schema]) if (inner) out.push(...walk(inner, seen));
  const shape = typeof d.shape === 'function' ? d.shape() : d.shape;
  if (shape) for (const v of Object.values(shape)) out.push(...walk(v, seen));
  if (Array.isArray(d.options)) for (const v of d.options) out.push(...walk(v, seen));
  return out;
}

describe('演出进程的 MCP 工具面', () => {
  const server = createStageTools({ workspaceRoot: '/nonexistent', playRoot: 'x', onScene: () => {} });
  const registered = server.instance?._registeredTools || {};

  it('五件工具都注册上了（09-06 加 update_panel）', () => {
    expect(Object.keys(registered).sort()).toEqual(['forget', 'remember', 'roll', 'update_panel', 'write_scene']);
  });

  it('⛔ 工具 schema 里不许有 z.record（SDK 会静默丢掉整个服务器的工具）', () => {
    for (const [name, t] of Object.entries(registered)) {
      const nodes = walk(t.inputSchema);
      expect(nodes.length, `${name} 的 schema 扫不到任何节点 —— 判据失效了`).toBeGreaterThan(0);
      const records = nodes.filter(s => s instanceof z.ZodRecord);
      expect(records, `${name} 里有 z.record`).toEqual([]);
    }
  });

  it('判据自己能红：塞一个 record 进去要被抓到', () => {
    const bad = z.object({ state: z.record(z.string()).optional() });
    expect(walk(bad).some(s => s instanceof z.ZodRecord)).toBe(true);
  });

  it('write_scene 的把手是必填的（真会话 65% 的拍没带把手，所以放进 schema 逼它）', () => {
    const so = registered.write_scene.inputSchema;
    const shape = so.shape || so;   // ZodObject 有 .shape；裸 shape 就是它自己
    expect(shape.choices.isOptional()).toBe(false);
    // state 也必填（可空数组）：逼它每拍对数值表态，而不是靠它记得（09-05 晚站主点的）
    expect(shape.state.isOptional()).toBe(false);
  });
});
