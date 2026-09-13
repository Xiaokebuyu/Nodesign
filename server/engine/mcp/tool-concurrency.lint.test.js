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
import { PARALLEL_SAFE_TOOLS, SERIAL_TOOLS, assertConcurrencyNames } from './tool-concurrency.js';
import { TOOL_CAPABILITIES } from './capability-gate.js';
import { createNodesignMcpServer } from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const toolsDir = path.join(here, 'tools');
const TOOL_NAME = /\btool\(\s*'([a-z_]+)'/g;
const BATCH_NAME = /\bname:\s*'([a-z]+_batch)'/g;

/** 量帧时间的工具：并行表里必须独占浏览器槽位（helpers/browser-slots.js） → 源码文件 */
const TIMING = { trace_motion: 'trace-motion.js', profile_scroll: 'profile-scroll.js' };
/** 开浏览器的原语本身（它就是被包的那一下），扫描时跳过 */
const LAUNCH_PRIMITIVE = path.join(toolsDir, 'helpers', 'perception-page.js');
const LAUNCH = /\b(?:launchPerceptionBrowser\(\)|chromium\.launch\()/g;
const GATED_LAUNCH = /gatedBrowser\(\(\) => (?:launchPerceptionBrowser\(\)|chromium\.launch\()/g;

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
    const src = readFileSync(file, 'utf8');
    if (file !== LAUNCH_PRIMITIVE) {
      const all = (src.match(LAUNCH) || []).length;
      const gated = (src.match(GATED_LAUNCH) || []).length;
      if (all !== gated) out.push([path.relative(toolsDir, file), all - gated]);
    }
    for (const m of src.matchAll(/from '(\.{1,2}\/[^']+\.js)'/g)) {
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
    for (const [name, file] of Object.entries(TIMING)) {
      expect(PARALLEL_SAFE_TOOLS.has(name)).toBe(true);
      expect(readFileSync(path.join(toolsDir, file), 'utf8'), `${name} 量帧时间，要独占浏览器槽位`).toMatch(/exclusive: true/);
    }
    // 判据自检：扫描真的顺着 import 走到了 acquire-page.js，而且那里是包了闸的；拆掉闸扫描能看出来
    const { seen } = ungatedLaunches(fileOfTool('query_elements'));
    expect([...seen].map((f) => path.basename(f))).toContain('acquire-page.js');
    const naked = "const b = await launchPerceptionBrowser();\nconst c = await gatedBrowser(() => launchPerceptionBrowser());";
    expect((naked.match(LAUNCH) || []).length - (naked.match(GATED_LAUNCH) || []).length).toBe(1);
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
