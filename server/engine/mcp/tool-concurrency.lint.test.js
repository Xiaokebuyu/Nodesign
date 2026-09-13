/**
 * 并行表的守卫（2026-09-13；同日第二批把截图类 / 搜索 / 出图扩进来后改写第 2 条）。四条：
 *   1. 覆盖：tools/ 里注册的每个工具名都在并行表或串行表里，表里也没有源码里不存在的名字。
 *      新工具不许默认落在「没想过」这一格 —— 写死表家族加新成员必漏（[[nodesign-kinds-architecture]] 那一族）。
 *   2. 判据：会自起 chromium 的工具（capability-gate 表里挂 chromium 位的，那张表有自己的 lint 保证完整）
 *      进并行表，它的源码和它引到的 tools/ 下本地模块里，每一处开浏览器都必须包在 gatedBrowser 里。
 *      量帧时间的必须独占槽位。
 *   3. 装配：真装一台 server，打了 readOnlyHint 的恰好是并行表里注册上的那些，没有漏打、没有多打。
 *   4. 启动期对账会炸。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PARALLEL_SAFE_TOOLS, SERIAL_TOOLS, assertConcurrencyNames } from './tool-concurrency.js';
import { TOOL_CAPABILITIES } from './capability-gate.js';
import { createNodesignMcpServer } from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const toolsDir = path.join(here, 'tools');
const TOOL_NAME = /\btool\(\s*'([a-z_]+)'/g;
const BATCH_NAME = /\bname:\s*'([a-z]+_batch)'/g;

/** 量帧时间的工具：并行表里必须独占浏览器槽位（helpers/browser-slots.js） → [源码文件, 独占写法] */
const TIMING = {
  trace_motion: ['trace-motion.js', /exclusive: true/],
  profile_scroll: ['profile-scroll.js', /exclusive: true/],
  // 胶片条是 screenshot_canvas 的一个模式
  screenshot_canvas: ['screenshot.js', /exclusive: Array\.isArray\(frames\) && frames\.length > 0/],
};
/** 开浏览器的原语本身（它就是被包的那一下），扫描时跳过 */
const LAUNCH_PRIMITIVE = path.join(toolsDir, 'helpers', 'perception-page.js');
/** 槽位闸自己（它的 gatedBrowser 定义不是调用） */
const GATE_SELF = path.join(toolsDir, 'helpers', 'browser-slots.js');
const OPEN = String.raw`(?:launchPerceptionBrowser\s*\(|chromium\s*\.\s*launch(?:PersistentContext)?\s*\()`;
const LAUNCH = new RegExp(OPEN, 'g');
const GATED_LAUNCH = new RegExp(String.raw`gatedBrowser\s*\(\s*(?:async\s*)?\(\s*\)\s*=>\s*(?:await\s*)?` + OPEN, 'g');
/** 本地模块 import：静态（单双引号）与动态 */
const LOCAL_IMPORT = /(?:from\s*|import\s*\(\s*)['"](\.{1,2}\/[^'"]+\.js)['"]/g;

/**
 * 剥注释再匹配：注释里写着的 exclusive: true / 示例调用不算数（09-13 fable 审查 P2-2）。
 * 注释位置用 babel 解析拿（09-13 第三轮 P2-2：正则版把模板串里的 `/**` 当块注释起点，后面的真调用会被剥掉假绿）。
 * parser 只装在 web 下；找不到就让测试红，不退回正则。
 */
const babelParse = createRequire(path.join(here, '../../../web/package.json'))('@babel/parser').parse;
function stripComments(src) {
  const ast = babelParse(src, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true, allowReturnOutsideFunction: true });
  let out = ''; let at = 0;
  for (const c of ast.comments || []) { out += src.slice(at, c.start); at = c.end; }
  return out + src.slice(at);
}

function fileOfTool(name) {
  const re = new RegExp(`\\btool\\(\\s*'${name}'`);
  const f = readdirSync(toolsDir).find((x) => x.endsWith('.js') && !x.includes('.test.') && re.test(readFileSync(path.join(toolsDir, x), 'utf8')));
  return f ? path.join(toolsDir, f) : null;
}

/** 从一个文件出发，沿 tools/ 目录内的相对 import 走一遍，返回 [文件, 未包闸的开浏览器次数] */
function ungatedLaunches(entry) {
  const seen = new Set(); const out = [];
  const walk = (file) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const src = stripComments(readFileSync(file, 'utf8'));
    if (file !== LAUNCH_PRIMITIVE) {
      const all = (src.match(LAUNCH) || []).length;
      const gated = (src.match(GATED_LAUNCH) || []).length;
      if (all !== gated) out.push([path.relative(toolsDir, file), `${all - gated} 处没过槽位闸`]);
    }
    if (file !== GATE_SELF) {
      // 按项目轮转排队（09-13 fable 审查 P1-2）：每处拿槽位都要带来源
      const takes = (src.match(/\bgatedBrowser\s*\(|\bbrowserSlots\.acquire\s*\(/g) || []).length;
      const keyed = (src.match(/key:\s*projectId|browserSlots\.acquire\([^)]*,\s*projectId\)/g) || []).length;
      if (takes > keyed) out.push([path.relative(toolsDir, file), `${takes - keyed} 处拿槽位没带项目 key`]);
    }
    for (const m of src.matchAll(LOCAL_IMPORT)) {
      const next = path.resolve(path.dirname(file), m[1]);
      if (next.startsWith(toolsDir + path.sep)) walk(next);
    }
  };
  walk(entry);
  return { out, seen };
}

function sourceToolNames() {
  const names = new Set();
  for (const f of readdirSync(toolsDir)) {
    if (!f.endsWith('.js') || f.includes('.test.')) continue;
    const s = readFileSync(path.join(toolsDir, f), 'utf8');
    for (const m of s.matchAll(TOOL_NAME)) names.add(m[1]);
    for (const m of s.matchAll(BATCH_NAME)) names.add(m[1]);
  }
  return names;
}

describe('tool-concurrency 并行表', () => {
  it('每个工具都登记了并行或串行，表里没有幽灵名字，两表不相交', () => {
    const names = sourceToolNames();
    // 判据自检：扫描真扫到了东西（批工具走的是 name: 字段，不是 tool('…')）
    expect(names.has('write_on_board')).toBe(true);
    expect(names.has('browser_batch')).toBe(true);
    const unregistered = [...names].filter((n) => !PARALLEL_SAFE_TOOLS.has(n) && !SERIAL_TOOLS.has(n)).sort();
    expect(unregistered, '新工具要在 tool-concurrency.js 登记是并行只读还是串行').toEqual([]);
    const ghosts = [...PARALLEL_SAFE_TOOLS, ...SERIAL_TOOLS].filter((n) => !names.has(n)).sort();
    expect(ghosts, '表里的名字在源码里找不到（改名或删工具后表没跟上）').toEqual([]);
    expect([...PARALLEL_SAFE_TOOLS].filter((n) => SERIAL_TOOLS.has(n))).toEqual([]);
  });

  it('自起 chromium 的工具进并行表：每一处开浏览器都过槽位闸，量帧时间的独占', () => {
    const chromiumParallel = [...PARALLEL_SAFE_TOOLS].filter((n) => TOOL_CAPABILITIES[n]?.cap === 'chromium');
    // 判据自检：capability 表确实把这几件当 chromium 工具（否则下面的扫描恒真）
    expect(chromiumParallel).toEqual(expect.arrayContaining(['look_at_board', 'screenshot_canvas', 'screenshot_url', 'trace_motion']));
    for (const name of chromiumParallel) {
      const file = fileOfTool(name);
      expect(file, `${name} 的源码文件找不到`).toBeTruthy();
      const { out } = ungatedLaunches(file);
      expect(out, `${name}：并行 = 同时拉起多只 chromium；开浏览器要写成 gatedBrowser(() => …)（helpers/browser-slots.js）`).toEqual([]);
    }
    for (const [name, [file, proof]] of Object.entries(TIMING)) {
      expect(PARALLEL_SAFE_TOOLS.has(name)).toBe(true);
      expect(stripComments(readFileSync(path.join(toolsDir, file), 'utf8')), `${name} 量帧时间，要独占浏览器槽位`).toMatch(proof);
    }
    // 判据自检：扫描真的顺着 import 走到了 acquire-page.js，而且那里是包了闸的；拆掉闸扫描能看出来
    const { seen } = ungatedLaunches(fileOfTool('query_elements'));
    expect([...seen].map((f) => path.basename(f))).toContain('acquire-page.js');
    const count = (src) => { const t = stripComments(src); return (t.match(LAUNCH) || []).length - (t.match(GATED_LAUNCH) || []).length; };
    expect(count("const b = await launchPerceptionBrowser();\nconst c = await gatedBrowser(() => launchPerceptionBrowser());")).toBe(1);
    expect(count('const b = await chromium.launchPersistentContext(dir, {});')).toBe(1);
    expect(count('const b = await launchPerceptionBrowser({ x: 1 });')).toBe(1);
    expect(count('const b = await gatedBrowser(async () => chromium.launch({ headless: true }), { key: projectId });')).toBe(0);
    expect(count('// 示例：gatedBrowser(() => launchPerceptionBrowser())\nconst u = `http://127.0.0.1`; const b = await launchPerceptionBrowser();')).toBe(1);
    expect(stripComments('/* exclusive: true */ acquire({})')).not.toMatch(/exclusive: true/);
    // 模板串里的 `/**` 不是注释起点，后面的裸调用照样数得到（第三轮 P2-2 的现成样本在 perception-page.js）
    expect(count('const r = `${ORIGIN}/**`; const b = await launchPerceptionBrowser(); // tail */')).toBe(1);
    expect([...`import('./a.js'); import x from "../b.js";`.matchAll(LOCAL_IMPORT)].map((m) => m[1])).toEqual(['./a.js', '../b.js']);
  });

  it('装配出来的 server：打了 readOnlyHint 的恰好是并行表里注册上的那些', () => {
    for (const mode of ['design', 'rp']) {
      const server = createNodesignMcpServer({
        workspaceRoot: '/tmp', sharedRoot: '/tmp',
        projectId: 'proj_test_concurrency0', sessionId: 'sess-concurrency-test', projectMode: mode,
      });
      const registered = new Set(server.toolNames);
      const expected = [...PARALLEL_SAFE_TOOLS].filter((n) => registered.has(n)).sort();
      expect([...server.readOnlyToolNames].sort()).toEqual(expected);
      // 判据自检：至少板面两件在任何模式下都注册着，名单不会因为全被下架而空着"过"
      expect(expected).toEqual(expect.arrayContaining(['read_board', 'look_at_board', 'web_search', 'generate_image']));
    }
  });

  it('启动期对账：并行表里出现注册表没有的名字就炸', () => {
    expect(() => assertConcurrencyNames(['read_board'])).toThrow(/静默串行/);
    expect(() => assertConcurrencyNames([...PARALLEL_SAFE_TOOLS])).not.toThrow();
  });
});
