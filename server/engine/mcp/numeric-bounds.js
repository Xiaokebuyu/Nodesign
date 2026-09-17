/**
 * mcp/numeric-bounds.js —— 工具数值参数的上下限：从 zod schema 取出来，越界值夹到边界（2026-09-17）
 *
 * 站主定的行为：agent 给工具传的数值越过上下限时，不再整个调用被拒，按边界执行
 * （browser_find limit 传 30、上限 20 → 按 20 跑）。
 *
 * 为什么要在调用之前夹：越界值由 MCP server 侧的 zod 拒掉（MCP error -32602），工具体根本
 * 不执行，挂在 handler 外面的包装（param-sanitizer）看不到这次调用。能拿到原始入参并改写的
 * 只有 PreToolUse 钩子（hooks/pre-numeric-clamp.js），这里给它提供边界表和夹紧算法。
 *
 * 真相源只有 zod schema 一份：边界从 schema 转出的 JSON schema 上取，转换参数与 SDK 给模型
 * 生成工具定义时相同（draft-7、io:'input'），所以夹紧用的数就是模型在工具定义里看到的
 * minimum/maximum。不手抄第二份上限表。
 *
 * 范围：
 *   - 只处理 number/integer 的 minimum/maximum（含嵌套在 object、数组元素、record 值、
 *     带判别字段的 union 分支里的）。exclusiveMinimum/exclusiveMaximum 不夹，留给 zod 报错。
 *   - 非数字、NaN、Infinity 不动，留给 zod 报错。
 *   - 字符串超长、数组超长不夹：夹等于静默丢内容，照旧拒绝。
 *   - union 里判不出唯一分支时不动（夹错分支比被拒更糟）。
 *   - zod 的 min/max 保持不变，作为兜底。
 */

import { z } from 'zod';

const MAX_DEPTH = 24;
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** JSON schema 的 type 归成一组（type 可能是数组，也可能缺省） */
function typesOf(js) {
  if (Array.isArray(js.type)) return new Set(js.type);
  if (typeof js.type === 'string') return new Set([js.type]);
  if (js.properties || js.additionalProperties) return new Set(['object']);
  if (js.items || js.prefixItems) return new Set(['array']);
  return null;   // 不知道 → 当作什么都可能
}

/** 分支里写死了值的字段（z.literal / 单值 enum）：union 判别用 */
function constsOf(js) {
  const out = [];
  for (const [k, p] of Object.entries(js.properties || {})) {
    if (!p || typeof p !== 'object') continue;
    if ('const' in p) out.push([k, p.const]);
    else if (Array.isArray(p.enum) && p.enum.length === 1) out.push([k, p.enum[0]]);
  }
  return out;
}

function resolveRef(ref, root) {
  const m = /^#\/(definitions|\$defs)\/(.+)$/.exec(ref || '');
  if (!m) return null;
  return root?.[m[1]]?.[decodeURIComponent(m[2])] || null;
}

/**
 * JSON schema → 只留「通向有边界数值」的骨架。没有任何边界时返回 null。
 * 节点形状：
 *   { kind:'num', min?, max? }
 *   { kind:'obj', props:{k:node}, extra?:node, declared:Set }
 *   { kind:'arr', items?:node, tuple?:node[] }
 *   { kind:'union', branches:[{ types:Set|null, consts:[[k,v]], required:Set, node }] }
 */
function compile(js, root, depth) {
  if (!js || typeof js !== 'object' || depth > MAX_DEPTH) return null;
  if (js.$ref) return compile(resolveRef(js.$ref, root), root, depth + 1);

  const alts = js.anyOf || js.oneOf;
  if (Array.isArray(alts)) {
    const branches = alts.map((b0) => {
      const b = b0?.$ref ? resolveRef(b0.$ref, root) || {} : (b0 || {});
      return {
        types: typesOf(b),
        consts: constsOf(b),
        required: new Set(Array.isArray(b.required) ? b.required : []),
        node: compile(b, root, depth + 1),
      };
    });
    return branches.some((b) => b.node) ? { kind: 'union', branches } : null;
  }

  const types = typesOf(js);
  if (types && (types.has('number') || types.has('integer'))) {
    const min = finite(js.minimum);
    const max = finite(js.maximum);
    return min === undefined && max === undefined ? null : { kind: 'num', min, max };
  }
  if (types && types.has('object')) {
    const props = {};
    for (const [k, p] of Object.entries(js.properties || {})) {
      const n = compile(p, root, depth + 1);
      if (n) props[k] = n;
    }
    const extra = isPlainObject(js.additionalProperties) ? compile(js.additionalProperties, root, depth + 1) : null;
    if (!Object.keys(props).length && !extra) return null;
    return { kind: 'obj', props, extra, declared: new Set(Object.keys(js.properties || {})) };
  }
  if (types && types.has('array')) {
    const tupleSrc = Array.isArray(js.prefixItems) ? js.prefixItems : (Array.isArray(js.items) ? js.items : null);
    if (tupleSrc) {
      const tuple = tupleSrc.map((s) => compile(s, root, depth + 1));
      const restSrc = Array.isArray(js.items) ? js.additionalItems : (Array.isArray(js.prefixItems) ? js.items : null);
      const items = isPlainObject(restSrc) ? compile(restSrc, root, depth + 1) : null;
      return tuple.some(Boolean) || items ? { kind: 'arr', tuple, items } : null;
    }
    const items = compile(js.items, root, depth + 1);
    return items ? { kind: 'arr', items } : null;
  }
  return null;
}

/**
 * 一个工具的边界骨架。inputSchema 是 tool() 收的 raw shape（也兼容整个 z.object）。
 * 转不动（schema 里有 JSON schema 表达不了的东西且没被兜住）→ null：不夹，zod 照旧拦。
 */
export function compileNumericBounds(inputSchema) {
  if (!inputSchema || typeof inputSchema !== 'object') return null;
  try {
    const schema = inputSchema._zod ? inputSchema : z.object(inputSchema);
    const js = z.toJSONSchema(schema, { target: 'draft-7', io: 'input', unrepresentable: 'any' });
    return compile(js, js, 0);
  } catch {
    return null;
  }
}

function fmtPath(path) {
  return path.reduce((s, seg) => (typeof seg === 'number' ? `${s}[${seg}]` : (s ? `${s}.${seg}` : seg)), '');
}

/** union：按类型和判别字段挑分支，唯一时才往下走 */
function pickBranch(node, value) {
  const kind = typeof value === 'number' ? 'number' : Array.isArray(value) ? 'array' : isPlainObject(value) ? 'object' : 'other';
  const fits = node.branches.filter((b) => {
    if (b.types) {
      if (kind === 'number' && !(b.types.has('number') || b.types.has('integer'))) return false;
      if (kind === 'array' && !b.types.has('array')) return false;
      if (kind === 'object' && !b.types.has('object')) return false;
      if (kind === 'other') return false;
    }
    if (kind === 'object') {
      for (const [k, v] of b.consts) {
        if (k in value ? value[k] !== v : b.required.has(k)) return false;
      }
    }
    return true;
  });
  return fits.length === 1 ? fits[0].node : null;
}

function clampAt(node, value, path, changes) {
  if (!node) return value;
  switch (node.kind) {
    case 'num': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return value;
      if (node.max !== undefined && value > node.max) {
        changes.push({ path: fmtPath(path), from: value, to: node.max, bound: 'max' });
        return node.max;
      }
      if (node.min !== undefined && value < node.min) {
        changes.push({ path: fmtPath(path), from: value, to: node.min, bound: 'min' });
        return node.min;
      }
      return value;
    }
    case 'obj': {
      if (!isPlainObject(value)) return value;
      let out = value;
      for (const k of Object.keys(value)) {
        const child = Object.hasOwn(node.props, k) ? node.props[k] : (!node.declared.has(k) ? node.extra : null);
        if (!child) continue;
        const nv = clampAt(child, value[k], [...path, k], changes);
        if (nv !== value[k]) {
          if (out === value) out = { ...value };
          out[k] = nv;
        }
      }
      return out;
    }
    case 'arr': {
      if (!Array.isArray(value)) return value;
      let out = value;
      value.forEach((v, i) => {
        const child = node.tuple ? (i < node.tuple.length ? node.tuple[i] : node.items) : node.items;
        const nv = clampAt(child, v, [...path, i], changes);
        if (nv !== v) {
          if (out === value) out = value.slice();
          out[i] = nv;
        }
      });
      return out;
    }
    case 'union':
      return clampAt(pickBranch(node, value), value, path, changes);
    default:
      return value;
  }
}

/**
 * 按边界夹一份入参。不改原对象：有改动的那几层是新对象，其余原样引用。
 * @returns {{ value: any, changes: Array<{path:string, from:number, to:number, bound:'max'|'min'}> }}
 */
export function clampToBounds(bounds, value, basePath = []) {
  const changes = [];
  const out = clampAt(bounds, value, basePath, changes);
  return { value: out, changes };
}

/** 一条改动给模型读的说法：参数 limit 传了 30，上限 20，已按 20 执行 */
export function describeClamp(c) {
  return `参数 ${c.path} 传了 ${c.from}，${c.bound === 'max' ? '上限' : '下限'} ${c.to}，已按 ${c.to} 执行`;
}
