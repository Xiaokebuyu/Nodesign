/**
 * write_on_board 的图形入参 schema（2026-08-28 从 write-on-board.js 拆出 —— 行数棘轮；
 * 纯数据，跟落板逻辑零耦合）。上限是失控兜底不是风格闸：zod 硬拒（-32602 整调用作废）
 * 是最贵的失败模式，可读性走返回值里的软提醒（08-25 用户拍板「移除画板上限」）。
 */

import { z } from 'zod';
import { BINDING_TYPE_IDS, BINDING_MATERIALS } from '../../../lib/binding-types.js';

const MAX_NODES = 200;
const MAX_SHAPES = 120;
const MAX_EDGES = 400;

const LOCAL_ID = z.string().regex(/^[A-Za-z0-9_-]{1,48}$/, 'local id: letters/digits/_/-');
const GRID_PT = z.object({ x: z.number().min(-2000).max(2000), y: z.number().min(-2000).max(2000) });
export const WORLD_PT = z.object({ x: z.number().min(-1e6).max(1e6), y: z.number().min(-1e6).max(1e6) });
/**
 * 纸内坐标（2026-08-29 纸范式）：以当前纸版心左上角为原点的像素。越界**钳住不拒收**
 * （schema 整单拒是最贵的失败模式；钳过在返回里如实报）。preprocess 在给模型看的
 * JSON schema 里隐形 —— 文档照旧严格，垫片只当安全网。
 */
const clampN = (lo, hi) => (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : v);
export const SHEET_PT = z.object({
  x: z.preprocess(clampN(0, 12000), z.number().min(0).max(12000)),
  y: z.preprocess(clampN(0, 12000), z.number().min(0).max(12000)),
});

export const NODES = z.array(z.object({
  id: LOCAL_ID.describe('Local id to reference from edges/shapes'),
  text: z.string().min(1).max(8000),
  format: z.enum(['plain', 'md']).optional().describe('Default: md when the text carries markdown marks, else plain'),
  size: z.enum(['sm', 'md', 'lg', 'xl']).optional(),
  font: z.enum(['pen', 'kai', 'sans', 'serif', 'mono']).optional(),
  color: z.enum(['ink', 'red', 'pencil', 'brass']).optional(),
  at: GRID_PT.optional().describe('Grid position (layout free); top-left of the node'),
  w: z.number().min(3).max(120).optional().describe('Width in grid units (prefer ≤22 = 528px: paragraphs read better growing down than wide)'),
})).max(MAX_NODES);

export const SHAPES = z.array(z.object({
  id: LOCAL_ID.optional(),
  kind: z.enum(['rect', 'ellipse', 'circle', 'line', 'arrow', 'underline', 'path']),
  at: GRID_PT.optional(),
  around: LOCAL_ID.optional().describe('rect/ellipse/circle/underline: wrap this node instead of at/w/h'),
  w: z.number().min(0).max(200).optional(),
  h: z.number().min(0).max(200).optional(),
  to: GRID_PT.optional(),
  toNode: LOCAL_ID.optional(),
  d: z.string().max(8000).optional().describe('path kind: SVG M/L/Q/Z in local px'),
  color: z.enum(['ink', 'red', 'pencil', 'brass']).optional(),
  width: z.number().min(1).max(12).optional(),
})).max(MAX_SHAPES);

export const EDGES = z.array(z.object({
  from: z.string().min(1).max(300).describe('local node id or canvas id'),
  to: z.string().min(1).max(300).describe('local node id or canvas id'),
  type: z.enum(BINDING_TYPE_IDS).optional().describe('default link'),
  material: z.enum(BINDING_MATERIALS).optional().describe('default pencil'),
  label: z.string().max(60).optional(),
})).max(MAX_EDGES);
