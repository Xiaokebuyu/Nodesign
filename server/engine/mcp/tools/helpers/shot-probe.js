/**
 * helpers/shot-probe.js — screenshot_canvas 的 probe：在页面里求值，把结果当文字带回（09-17，问题库 iss_mtvtvqs2_0ad4）
 *
 * 为什么：agent 调试自己的页面时，要读的多半是数值（某容器的 scrollTop / scrollHeight、接口回了什么、
 * 游戏状态变量、localStorage），不是画面。beforeShot 早就能在页面里跑 JS，但返回值被丢掉，于是只能把数字
 * 写进 DOM 再截图读回来：每张约 1k tokens、不会从上下文里释放，数字还可能读错。真案：桌面用户的 agent
 * 为查「正文为什么没滚到底」连截三张；另有 agent 给 artifact_computer 编了个 `expression` 参数，自述
 * 「没有求值通道」。
 *
 * 能力边界：probe 不新增能力。beforeShot 已经能跑任意 JS，产物页自己的脚本也是 agent 写的、跑在同一个页面里；
 * probe 只是把返回值带回来。求值发生在页面主世界，发出的请求就是页面的请求 —— 同一个浏览器 context、
 * 同一套 route / 代理设置，没有第二条出网路径。
 *
 * 求值形状：先当表达式（`async () => (probe)`），编译不过（SyntaxError）再当语句片段（`async () => { probe }`，
 * 要自己写 return）。运行期异常在页面里就接住、作为结果带回，所以 page.evaluate 抛出的只可能是编译错误或页面没了 ——
 * 这保证了回退重试不会把 probe 执行两遍。
 *
 * 序列化在页面里做（JSON + replacer），不交给 playwright：DOM 节点、函数、循环引用、BigInt、错误对象在
 * playwright 的传输里要么丢、要么变成 {}，agent 看到 {} 会以为是空对象。
 */
import { BEFORE_SHOT_TIMEOUT_MS } from './shot-pipeline.js';

/** 结果文字上限：够装几十个数值和一小段接口返回；超出截断并标明总长 */
export const PROBE_MAX_CHARS = 4000;
const MAX_DEPTH = 8;      // 更深的层写成 [Object] / [Array(n)]
const MAX_ITEMS = 200;    // 单个数组 / 对象最多展开多少项
const MAX_NODES = 5000;   // 整棵最多展开多少个对象，防止 probe 顺手返回一个巨型状态树把页面卡住

/**
 * 页面侧序列化器（字符串形式：不依赖 Function#toString，测试里的代码变换改不到它）。
 * 非 JSON 值统一写成带方括号的字符串标记，列在工具描述里。
 */
export const SERIALIZER_SRC = `(function (root) {
  var MAX_DEPTH = ${MAX_DEPTH}, MAX_ITEMS = ${MAX_ITEMS}, MAX_NODES = ${MAX_NODES};
  var nodes = 0;
  var stack = [];
  function has(name) { return typeof globalThis[name] === 'function'; }
  function capList(list, total) {
    if (total <= MAX_ITEMS) return list;
    var out = list.slice(0, MAX_ITEMS);
    out.push('[… ' + (total - MAX_ITEMS) + ' more]');
    return out;
  }
  function take(iter, n) {
    var out = [];
    for (var v of iter) { if (out.length >= n) break; out.push(v); }
    return out;
  }
  function describeEl(el) {
    var s = String(el.tagName || el.nodeName).toLowerCase();
    if (el.id) s += '#' + el.id;
    var cls = el.classList ? Array.prototype.slice.call(el.classList, 0, 3) : [];
    if (cls.length) s += '.' + cls.join('.');
    return '[Element ' + s + ']';
  }
  function special(x) {
    var t = typeof x;
    if (t === 'undefined') return '[undefined]';
    if (t === 'bigint') return x.toString() + 'n';
    if (t === 'function') return '[Function ' + (x.name || 'anonymous') + ']';
    if (t === 'symbol') return '[' + x.toString() + ']';
    if (t === 'number' && !isFinite(x)) return '[' + String(x) + ']';
    if (x === null || t !== 'object') return x;
    if (x instanceof Error) return '[' + (x.name || 'Error') + ': ' + x.message + ']';
    if (has('Window') && x instanceof Window) return '[Window]';
    if (has('Node') && x instanceof Node) {
      if (x.nodeType === 1) return describeEl(x);
      if (x.nodeType === 3) return '[Text ' + JSON.stringify(String(x.textContent).slice(0, 60)) + ']';
      if (x.nodeType === 9) return '[Document]';
      return '[' + x.nodeName + ']';
    }
    if ((has('NodeList') && x instanceof NodeList) || (has('HTMLCollection') && x instanceof HTMLCollection)) {
      return capList(Array.prototype.slice.call(x, 0, MAX_ITEMS), x.length);
    }
    if (x instanceof Map) return { '[Map]': capList(take(x.entries(), MAX_ITEMS), x.size) };
    if (x instanceof Set) return { '[Set]': capList(take(x.values(), MAX_ITEMS), x.size) };
    if (x instanceof Promise) return '[Promise]';
    if (x instanceof WeakMap) return '[WeakMap]';
    if (x instanceof WeakSet) return '[WeakSet]';
    if (x instanceof ArrayBuffer) return '[ArrayBuffer ' + x.byteLength + ' bytes]';
    if (ArrayBuffer.isView(x) && !(x instanceof DataView)) {
      return capList(Array.prototype.slice.call(x, 0, MAX_ITEMS), x.length);
    }
    return x;
  }
  function replacer(key, raw) {
    var value = special(raw);
    if (value === null || typeof value !== 'object') return value;
    while (stack.length && stack[stack.length - 1].holder !== this) stack.pop();
    for (var i = 0; i < stack.length; i++) if (stack[i].orig === raw) return '[Circular]';
    if (stack.length >= MAX_DEPTH) return Array.isArray(value) ? '[Array(' + value.length + ')]' : '[Object]';
    if (++nodes > MAX_NODES) return '[…]';
    if (value === raw) {
      if (Array.isArray(value)) {
        if (value.length > MAX_ITEMS) value = capList(value.slice(0, MAX_ITEMS), value.length);
      } else {
        var keys = Object.keys(value);
        if (keys.length > MAX_ITEMS) {
          var o = {};
          for (var j = 0; j < MAX_ITEMS; j++) o[keys[j]] = value[keys[j]];
          o['[…]'] = (keys.length - MAX_ITEMS) + ' more keys';
          value = o;
        }
      }
    }
    stack.push({ holder: value, orig: raw });
    return value;
  }
  try {
    var s = JSON.stringify(root, replacer);
    return s === undefined ? '"[undefined]"' : s;
  } catch (e) {
    return JSON.stringify('[unserializable: ' + (e && e.message) + ']');
  }
})`;

/** 页面里跑的那一段：运行期异常就地接住，作为结果带回 */
export function wrapProbe(body) {
  return `(async () => {
  let __ndV;
  try { __ndV = await (async () => ${body})(); }
  catch (e) {
    return { ok: false, error: (e && typeof e === 'object' && 'message' in e)
      ? String(e.name || 'Error') + ': ' + String(e.message) : 'thrown: ' + String(e) };
  }
  if (__ndV === undefined) return { ok: true, undef: true };
  return { ok: true, json: ${SERIALIZER_SRC}(__ndV) };
})()`;
}

async function evalBounded(page, src, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      page.evaluate(src),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`probe timeout (${timeoutMs / 1000}s) — if the value only exists after the page boots, `
          + 'wait with waitFor first')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function oneLine(err) {
  const msg = String(err?.message || err).replace(/^page\.evaluate:\s*/, '').split('\n')[0];
  const named = err?.name && err.name !== 'Error' && !msg.startsWith(err.name) ? `${err.name}: ${msg}` : msg;
  return named.slice(0, 1000);
}

/** 截到上限，不切开 UTF-16 代理对 */
export function capText(s, max = PROBE_MAX_CHARS) {
  if (s.length <= max) return { text: s, truncated: false, total: s.length };
  let cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return { text: cut, truncated: true, total: s.length };
}

/**
 * @param {import('playwright').Page} page
 * @param {string} probe
 * @returns {Promise<{ok:boolean, text?:string, truncated?:boolean, total?:number, undef?:boolean,
 *   error?:string, form:'expression'|'statements', ms:number}>}
 */
export async function runProbe(page, probe, { timeoutMs = BEFORE_SHOT_TIMEOUT_MS, maxChars = PROBE_MAX_CHARS } = {}) {
  const t0 = Date.now();
  const src = String(probe);
  // 结尾的分号是写语句的习惯，表达式形态里是语法错误 —— 去掉再试
  const expr = src.trim().replace(/;+\s*$/, '');
  let form = 'expression';
  let r;
  try {
    r = await evalBounded(page, wrapProbe(`(\n${expr}\n)`), timeoutMs);
  } catch (err) {
    const compileError = err?.name === 'SyntaxError' || /SyntaxError/.test(String(err?.message));
    if (!compileError) return { ok: false, error: oneLine(err), form, ms: Date.now() - t0 };
    form = 'statements';
    try {
      r = await evalBounded(page, wrapProbe(`{\n${src}\n}`), timeoutMs);
    } catch (err2) {
      return { ok: false, error: oneLine(err2), form, ms: Date.now() - t0 };
    }
  }
  const ms = Date.now() - t0;
  if (!r || typeof r !== 'object') return { ok: false, error: 'the page returned nothing (did it navigate away?)', form, ms };
  if (!r.ok) return { ok: false, error: String(r.error).slice(0, 1000), form, ms };
  if (r.undef) return { ok: true, text: 'undefined', undef: true, truncated: false, total: 9, form, ms };
  return { ok: true, ...capText(String(r.json), maxChars), form, ms };
}

/** probe 结果 → caption 行 */
export function probeLines(res, { shotTaken = true } = {}) {
  if (!res) return [];
  if (!res.ok) {
    return [`probe error: ${res.error}${shotTaken ? ' (the screenshot was still taken)' : ''}`];
  }
  const lines = [`probe result: ${res.text}`];
  if (res.truncated) {
    lines.push(`(probe result truncated: ${res.total} chars in total, showing the first ${res.text.length} — return only the fields you need)`);
  }
  if (res.undef && res.form === 'statements') {
    lines.push('(the probe ran as statements and returned nothing — end a multi-statement probe with `return <value>`)');
  }
  return lines;
}

/** shot:false 的整段返回文字：probe 结果 + 各阶段说明 + 诊断摘要，不出图 */
export function probeOnlyText({ relPath, viewport, live, probeRes, notes = [], timing = [], diagSummary }) {
  return [
    `Probe of ${relPath} (${live ? 'live session page' : 'fresh load'}, viewport ${viewport.width}x${viewport.height}; shot:false — no image)`,
    ...probeLines(probeRes, { shotTaken: false }),
    ...notes.filter(Boolean),
    ...(timing.length ? [`timing: ${timing.join(' · ')}`] : []),
    diagSummary,
  ].filter(Boolean).join('\n');
}
