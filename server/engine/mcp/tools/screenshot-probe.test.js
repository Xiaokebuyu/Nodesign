/**
 * screenshot_canvas 的 probe / shot:false（09-17，问题库 iss_mtvtvqs2_0ad4）
 *
 * - 页面侧序列化器：循环引用、undefined、函数、DOM 节点、BigInt、错误对象、Map/Set、深度与宽度上限
 * - runProbe：表达式 / 语句两种形态、运行期异常不重跑、超时、截断
 * - 接线：probe 在 waitFor / beforeShot / scrollTo 之后、截图之前；shot:false 不出图；组合合同；
 *   胶片条在录完之后跑；live 模式；artifact_batch 里可用
 * 页面用 node:vm 里的假 DOM 代替，不起浏览器（真浏览器核对另做）。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import vm from 'node:vm';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SERIALIZER_SRC, runProbe, probeLines, capText, PROBE_MAX_CHARS } from './helpers/shot-probe.js';

// ── 假页面：probe 的字符串在 vm 里跑；编译错误照 playwright 的报文形状抛 ──
class Node { constructor(o) { Object.assign(this, o); } }
class Element extends Node {}
class NodeList { constructor(items) { items.forEach((x, i) => { this[i] = x; }); this.length = items.length; } }
class HTMLCollection extends NodeList {}
class Window {}

function makeSandbox(extra = {}) {
  const el = new Element({ nodeType: 1, tagName: 'DIV', id: 'app', classList: ['main', 'dark'], scrollTop: 120, scrollHeight: 2000 });
  const sandbox = {
    Node, NodeList, HTMLCollection, Window,
    document: { title: 'T', querySelector: () => el, querySelectorAll: () => new NodeList([el, el]) },
    calls: [],
    ...extra,
  };
  sandbox.window = sandbox;
  return vm.createContext(sandbox);
}

function vmPage(context, log = []) {
  return {
    log,
    async evaluate(fn, arg) {
      if (typeof fn !== 'string') { log.push('fn'); return typeof arg === 'string' ? { x: 0, y: 0, width: 10, height: 10, docW: 10, docH: 10 } : []; }
      log.push('probe');
      let script;
      try { script = new vm.Script(fn); } catch (e) { throw new Error(`page.evaluate: ${e.name}: ${e.message}`); }
      return script.runInContext(context);
    },
    waitForTimeout: async () => {},
  };
}

const ser = (expr, context = makeSandbox()) => vm.runInContext(`${SERIALIZER_SRC}((() => { ${expr} })())`, context);

describe('页面侧序列化器', () => {
  it('普通对象原样 JSON', () => {
    expect(ser('return { top: 10, h: 2000, s: "x", ok: true, n: null }')).toBe('{"top":10,"h":2000,"s":"x","ok":true,"n":null}');
  });
  it('循环引用写 [Circular]；同一对象出现两次（非循环）照常展开', () => {
    expect(ser('const a = { x: 1 }; a.self = a; return a')).toBe('{"x":1,"self":"[Circular]"}');
    expect(ser('const o = { v: 1 }; return { a: o, b: o }')).toBe('{"a":{"v":1},"b":{"v":1}}');
  });
  it('undefined / 函数 / BigInt / NaN / 错误对象 / Symbol 都带标记，不丢', () => {
    expect(JSON.parse(ser('return { u: undefined, f: function foo() {}, g: () => 1, b: 10n, n: NaN, i: -Infinity, e: new TypeError("bad"), y: Symbol("k") }')))
      .toEqual({ u: '[undefined]', f: '[Function foo]', g: '[Function g]', b: '10n', n: '[NaN]', i: '[-Infinity]', e: '[TypeError: bad]', y: '[Symbol(k)]' });
    expect(ser('return [undefined, 1]')).toBe('["[undefined]",1]');
  });
  it('DOM 节点写成简短描述；NodeList 展开成数组；window 不展开', () => {
    expect(ser('return document.querySelector(".x")')).toBe('"[Element div#app.main.dark]"');
    expect(ser('return document.querySelectorAll("div")')).toBe('["[Element div#app.main.dark]","[Element div#app.main.dark]"]');
    expect(ser('return { w: new Window(), t: new Node({ nodeType: 3, textContent: "hello" }), d: new Node({ nodeType: 9 }) }'))
      .toBe('{"w":"[Window]","t":"[Text \\"hello\\"]","d":"[Document]"}');
  });
  it('Map / Set / 类型化数组', () => {
    expect(JSON.parse(ser('return { m: new Map([["a", 1]]), s: new Set([1, 2]), u: new Uint8Array([3, 4]) }')))
      .toEqual({ m: { '[Map]': [['a', 1]] }, s: { '[Set]': [1, 2] }, u: [3, 4] });
  });
  it('宽度与深度封顶', () => {
    const arr = JSON.parse(ser('return Array.from({ length: 250 }, (_, i) => i)'));
    expect(arr).toHaveLength(201);
    expect(arr[200]).toBe('[… 50 more]');
    const obj = JSON.parse(ser('const o = {}; for (let i = 0; i < 230; i++) o["k" + i] = i; return o'));
    expect(obj['[…]']).toBe('30 more keys');
    expect(ser('let o = { v: 1 }; for (let i = 0; i < 12; i++) o = { c: o }; return o')).toContain('"[Object]"');
  });
  it('getter 抛错 → 标明不可序列化，不炸', () => {
    expect(ser('return { get x() { throw new Error("nope"); } }')).toBe('"[unserializable: nope]"');
  });
});

describe('runProbe', () => {
  it('表达式形态：结尾分号也按表达式跑', async () => {
    const page = vmPage(makeSandbox());
    const r = await runProbe(page, "({ top: document.querySelector('.beats').scrollTop, h: document.querySelector('.beats').scrollHeight });");
    expect(r).toMatchObject({ ok: true, form: 'expression', text: '{"top":120,"h":2000}', truncated: false });
  });
  it('支持 await', async () => {
    const r = await runProbe(vmPage(makeSandbox()), 'await Promise.resolve(document.title)');
    expect(r.text).toBe('"T"');
  });
  it('语句片段：带 return 取到值；不带 return 给出提示', async () => {
    const page = vmPage(makeSandbox());
    const r = await runProbe(page, 'const el = document.querySelector(".x"); return el.scrollHeight - el.scrollTop');
    expect(r).toMatchObject({ ok: true, form: 'statements', text: '1880' });
    const r2 = await runProbe(page, 'const el = document.querySelector(".x"); el.scrollTop');
    expect(r2).toMatchObject({ ok: true, form: 'statements', undef: true });
    expect(probeLines(r2).join('\n')).toContain('end a multi-statement probe with `return');
  });
  it('运行期异常：如实带回，且 probe 只执行一次（不因回退重跑）', async () => {
    const context = makeSandbox();
    const r = await runProbe(vmPage(context), 'calls.push(1), document.nothing.x');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^TypeError: /);
    expect(context.calls).toHaveLength(1);
    expect(probeLines(r)[0]).toMatch(/^probe error: TypeError: .*\(the screenshot was still taken\)$/);
  });
  it('两种形态都编译不过 → 报语法错误', async () => {
    const r = await runProbe(vmPage(makeSandbox()), 'return )(');
    expect(r).toMatchObject({ ok: false, form: 'statements' });
    expect(r.error).toMatch(/SyntaxError/);
  });
  it('超时 → 报超时，不挂死', async () => {
    const page = { evaluate: () => new Promise(() => {}) };
    const r = await runProbe(page, '1', { timeoutMs: 30 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('probe timeout');
  });
  it('超长结果截到上限并标明总长', async () => {
    const r = await runProbe(vmPage(makeSandbox()), '"x".repeat(5000)');
    expect(r.truncated).toBe(true);
    expect(r.text).toHaveLength(PROBE_MAX_CHARS);
    expect(r.total).toBe(5002);
    expect(probeLines(r)[1]).toContain('5002 chars in total, showing the first 4000');
  });
  it('capText 不切开代理对', () => {
    const s = `${'a'.repeat(3)}😀`;
    expect(capText(s, 4)).toMatchObject({ text: 'aaa', truncated: true, total: 5 });
  });
});

// ── 接线：取页、截图管线、胶片条换成假的 ──
const ws = mkdtempSync(path.join(tmpdir(), 'nd-probe-0917-'));
mkdirSync(path.join(ws, 'site'));
writeFileSync(path.join(ws, 'site', 'index.html'), '<!doctype html><div class="beats"></div>');
afterAll(() => rmSync(ws, { recursive: true, force: true }));
let targetKind = 'site';
vi.mock('../../../lib/artifact-target.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveCanvasTarget: async () => (targetKind === 'site'
    ? { ok: true, kind: 'site', absPath: path.join(ws, 'site', 'index.html'), relPath: 'site/index.html' }
    : { ok: true, kind: 'docx', absPath: path.join(ws, '简历.docx'), relPath: '简历.docx' }),
  requireBrowsable: () => null,
}));

const events = [];
let context;
const acquireCalls = [];
vi.mock('./helpers/acquire-page.js', () => ({
  LIVE_PARAM_DESC: 'live',
  acquireArtifactPage: async (o) => {
    acquireCalls.push(o);
    const page = vmPage(context, events);
    return { page, live: !!o.live, viewport: o.live ? { width: 800, height: 600 } : o.viewport, note: null, viaHttp: true,
      gotoNote: null, liveNote: o.live ? 'LIVE-NOTE' : null,
      diag: { summary: () => 'DIAG-SUMMARY' }, release: async () => {} };
  },
}));
vi.mock('./helpers/shot-pipeline.js', async (importOriginal) => ({
  ...(await importOriginal()),
  runWaitFor: async () => { events.push('waitFor'); return null; },
  runBeforeShot: async () => { events.push('beforeShot'); return null; },
  normalizeShot: async () => ({ data: 'x', mimeType: 'image/webp', note: null }),
  detectPaintTransform: async () => null,
  shotWithFallback: async () => { events.push('shot'); return { buf: Buffer.from('png'), degraded: false }; },
  clipShotWithFallback: async () => { events.push('shot'); return { buf: Buffer.from('png'), degraded: false }; },
  longPageSheet: async () => null,
}));
vi.mock('./helpers/motion-lab.js', () => ({
  recordMotion: async () => { events.push('record'); return { shots: [{ t: 0 }], elems: [] }; },
  pickNearestFrames: (shots, wanted) => wanted.map((w) => ({ want: w, actual: w })),
  composeSheet: async () => ({ buf: Buffer.from('sheet'), layout: { cols: 1, rows: 1 } }),
  encodeWebm: async () => ({ bytes: 0 }),
  motionCaptionLines: () => [],
}));
vi.mock('./helpers/motion-scroll.js', () => ({
  wheelScroll: async () => {},
  elementMotionReport: () => null,
  elementMotionLines: () => [],
}));

const { makeScreenshotCanvasTool } = await import('./screenshot.js');
const { makeArtifactBatchTool } = await import('./artifact-session.js');
const canvasTool = makeScreenshotCanvasTool({ workspaceRoot: ws, projectId: 'p', sessionId: 's' });
const shoot = (args) => canvasTool.handler(args, {});
const textOf = (r) => r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
const PROBE = "({ top: document.querySelector('.beats').scrollTop, h: document.querySelector('.beats').scrollHeight })";

beforeEach(() => {
  events.length = 0; acquireCalls.length = 0; targetKind = 'site'; context = makeSandbox();
});

describe('screenshot_canvas 接线', () => {
  it('probe：结果进 caption，且在 waitFor / beforeShot / scrollTo 之后、截图之前执行', async () => {
    const r = await shoot({ probe: PROBE, waitFor: 'window.ready', beforeShot: 'x()', scrollTo: 100 });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('probe result: {"top":120,"h":2000}');
    expect(r.content.some((b) => b.type === 'image')).toBe(true);
    // scrollTo 是一次函数求值（'fn'），probe 在它之后、shot 之前
    expect(events.indexOf('waitFor')).toBeLessThan(events.indexOf('beforeShot'));
    expect(events.indexOf('beforeShot')).toBeLessThan(events.indexOf('probe'));
    expect(events.indexOf('fn')).toBeLessThan(events.indexOf('probe'));
    expect(events.indexOf('probe')).toBeLessThan(events.indexOf('shot'));
    expect(textOf(r)).toMatch(/timing: .*probe \d+\.\ds/);
  });
  it('shot:false：只回文字（probe 结果 + 诊断摘要），不截图', async () => {
    const r = await shoot({ probe: PROBE, shot: false });
    expect(r.isError).toBeFalsy();
    expect(r.content.every((b) => b.type === 'text')).toBe(true);
    const t = textOf(r);
    expect(t).toContain('shot:false — no image');
    expect(t).toContain('probe result: {"top":120,"h":2000}');
    expect(t).toContain('DIAG-SUMMARY');
    expect(events).not.toContain('shot');
  });
  it('probe 报错不挡截图', async () => {
    const r = await shoot({ probe: 'document.nothing.x' });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/probe error: TypeError: .*still taken/);
    expect(r.content.some((b) => b.type === 'image')).toBe(true);
  });
  it('live 模式：对着会话页求值，视口报会话的', async () => {
    const r = await shoot({ probe: 'document.title', shot: false, live: true });
    expect(acquireCalls[0].live).toBe(true);
    expect(textOf(r)).toContain('live session page, viewport 800x600');
    expect(textOf(r)).toContain('probe result: "T"');
    expect(textOf(r)).toContain('LIVE-NOTE');
  });
  it('胶片条：probe 在录制结束后跑，caption 标明', async () => {
    const r = await shoot({ probe: 'document.title', frames: [0, 100] });
    expect(r.isError).toBeFalsy();
    expect(events.indexOf('record')).toBeLessThan(events.indexOf('probe'));
    expect(events.filter((e) => e === 'probe')).toHaveLength(1);
    expect(textOf(r)).toContain('probe (after the recording) result: "T"');
  });
  it.each([
    [{ shot: false }, /shot:false needs probe/],
    [{ shot: false, probe: '1', frames: [0, 100] }, /cannot be combined with frames/],
    [{ saveTo: '交付/图' }, /saveTo only applies to \.docx/],
  ])('组合合同（站点）：%o → 拒绝且不开页', async (args, re) => {
    const r = await shoot(args);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(re);
    expect(acquireCalls).toHaveLength(0);
  });
  it.each([
    [{ probe: 'document.title' }, /probe does not apply to \.docx/],
    [{ shot: false }, /shot:false needs saveTo for a \.docx/],
  ])('组合合同（docx）：%o → 拒绝', async (args, re) => {
    targetKind = 'docx';
    const r = await shoot(args);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(re);
  });
  it('docx：saveTo / shot 透传到 screenshotDocx（非法路径在渲染前就被拒）', async () => {
    targetKind = 'docx';
    const bad = await shoot({ saveTo: '.claude/页图' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/saveTo rejected: "\.claude" starts with "\."/);
    const ok = await shoot({ saveTo: '页图', shot: false });   // 合同放行，走到 docx 分支（文件不存在）
    expect(textOf(ok)).toContain('还没构建出来');
  });
  it('artifact_batch 里可用：新参数过得了 batch 的 schema 校验', async () => {
    const batch = makeArtifactBatchTool({ tools: [canvasTool] });
    const r = await batch.handler({
      actions: [{ name: 'screenshot_canvas', input: { live: true, probe: PROBE, shot: false } }],
      screenshotAfter: false,
    }, {});
    const t = textOf(r);
    expect(t).toContain('[1/1] screenshot_canvas');
    expect(t).toContain('probe result: {"top":120,"h":2000}');
    expect(t).not.toContain('不是 screenshot_canvas 的参数');
    expect(r.content.some((b) => b.type === 'image')).toBe(false);
  });
});
