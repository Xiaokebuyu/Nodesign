/**
 * engine/agent/_smoke.js — agent 模块烟雾测试
 *
 * 4 项基础检查（不依赖 LLM gateway，始终跑）：
 *   1. EventBus 订阅 / 发布 / 模式匹配
 *   2. AgentContext 构造 + ensureNotAborted + cancel
 *   3. parseFrontmatter SKILL.md 解析
 *   4. loadSkill() 单个 skill + loadInstalledPlugins() 全量扫
 *
 * 跑：node server/engine/agent/_smoke.js
 *
 * （注：原 5. runAgent live 测试已撤——streamInput 重构后产线走 runSession，
 * 测试设置过重；live 端到端测放在 turn 真跑场景）
 */

import { EventBus, Events } from './events.js';
import { AgentContext } from './context.js';
import { loadSkill, parseFrontmatter } from './skill.js';
import { loadInstalledPlugins } from './plugin-loader.js';

const log = (s) => console.log(`  ${s}`);
const ok = (s) => console.log(`  ✅ ${s}`);
const fail = (s, e) => { console.error(`  ❌ ${s}`, e || ''); process.exit(1); };

async function main() {
  console.log('\n[smoke] engine/agent\n');

  // ── 1. EventBus ──
  console.log('1) EventBus');
  {
    const bus = new EventBus();
    const events = [];
    const off = bus.subscribe('*', e => events.push(e));
    bus.publish({ type: 'run.start', runId: 'r1' });
    bus.publish({ type: 'run.delta.text', runId: 'r1', text: 'hi' });
    bus.publish({ type: 'run.done', runId: 'r1' });
    if (events.length !== 3) fail('全订没全收到', events);
    off();
    bus.publish({ type: 'run.error', runId: 'r1' });
    if (events.length !== 3) fail('取消订阅后还收到了', events);
    ok('全订 + 取消订阅');

    // 前缀匹配
    const deltaOnly = bus.collect('run.delta');
    bus.publish({ type: 'run.delta.text', runId: 'r1' });
    bus.publish({ type: 'run.delta.thinking', runId: 'r1' });
    bus.publish({ type: 'run.done', runId: 'r1' });
    if (deltaOnly.buffer.length !== 2) fail(`前缀匹配错: ${deltaOnly.buffer.length}`);
    deltaOnly.stop();
    ok('前缀匹配（run.delta → text + thinking 各一）');

    // listener 抛错不应影响其他订阅者
    const bus2 = new EventBus();
    const collected = [];
    bus2.subscribe('*', () => { throw new Error('intentional'); });
    bus2.subscribe('*', e => collected.push(e));
    bus2.publish({ type: 'run.start', runId: 'r1' });
    if (collected.length !== 1) fail('一个 listener 抛错把另一个连累了');
    ok('listener 错误隔离');
  }

  // ── 2. AgentContext ──
  console.log('2) AgentContext');
  {
    const bus = new EventBus();
    const collected = bus.collect('*');
    const ctx = new AgentContext({ runId: 'run_smoke_0001', skillId: 'deskskill-engine-mini', eventBus: bus });

    ctx.emit({ type: 'run.start' });
    if (collected.buffer.length !== 1) fail('emit 没推到 bus');
    if (!collected.buffer[0].runId || !collected.buffer[0].ts) fail('emit 没补 runId/ts');
    ok('emit 自动补 runId + ts');

    ctx.recordSdkSession('sess-abc');
    if (ctx.sdkSessionId !== 'sess-abc') fail('recordSdkSession 没生效');
    if (!collected.buffer.find(e => e.type === 'run.sdk.session')) fail('sdk.session 事件没推');
    ok('recordSdkSession 推 run.sdk.session 事件');

    ctx.cancel('test_reason');
    if (!ctx.signal.aborted) fail('cancel 没 abort');
    let threw = false;
    try { ctx.ensureNotAborted(); } catch { threw = true; }
    if (!threw) fail('ensureNotAborted 没抛');
    if (!collected.buffer.find(e => e.type === 'run.cancelled')) fail('cancelled 事件没推');
    ok('cancel + ensureNotAborted + run.cancelled 事件');

    // counters
    ctx.absorbResult({
      num_turns: 5,
      duration_ms: 12345,
      duration_api_ms: 8000,
      total_cost_usd: 0.012,
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 50,
      },
    });
    if (ctx.counters.turns !== 5 || ctx.counters.totalCostUsd !== 0.012) fail('absorbResult 没生效', ctx.counters);
    ok(`absorbResult: turns=${ctx.counters.turns}, $=${ctx.counters.totalCostUsd}, cacheR=${ctx.counters.cacheReadTokens}`);
  }

  // ── 3. parseFrontmatter ──
  console.log('3) parseFrontmatter');
  {
    const a = parseFrontmatter('---\nname: foo\nversion: 1.0\n---\nbody here');
    if (a.frontmatter.name !== 'foo' || a.body !== 'body here') fail('基本解析失败', a);
    ok('基本 key:value');

    const b = parseFrontmatter('---\nname: "with spaces"\ndesc: \'q\'\n---\n');
    if (b.frontmatter.name !== 'with spaces' || b.frontmatter.desc !== 'q') fail('引号去掉失败', b);
    ok('引号成对去掉');

    const c = parseFrontmatter('plain markdown no frontmatter');
    if (Object.keys(c.frontmatter).length !== 0 || c.body !== 'plain markdown no frontmatter') fail('无 frontmatter 兜底失败', c);
    ok('无 frontmatter 兜底');

    const d = parseFrontmatter('---\n# comment\nname: foo\n---\nbody');
    if (d.frontmatter.name !== 'foo') fail('注释行干扰了解析', d);
    ok('YAML 注释行被忽略');
  }

  // ── 4. loadSkill + loadInstalledPlugins ──
  console.log('4) loadSkill / loadInstalledPlugins');
  {
    const skill = await loadSkill('site-craft');
    if (skill.name !== 'site-craft') fail('skill name 错', skill);
    if (!skill.systemPrompt.includes('站点')) fail('systemPrompt 内容不像 site-craft', skill.systemPrompt.slice(0, 100));
    if (!skill.description) fail('description 没解析');
    ok(`deskskill-engine-mini v${skill.version} 加载成功（systemPrompt ${skill.systemPrompt.length} 字节）`);

    let threw = false;
    try { await loadSkill('does-not-exist'); } catch (e) { threw = e.code === 'SKILL_NOT_FOUND'; }
    if (!threw) fail('找不到的 skill 没抛 SKILL_NOT_FOUND');
    ok('不存在 skill 抛 SKILL_NOT_FOUND');

    // 全量扫：内置 nodesign plugin 至少含 deskskill-engine-mini
    const installed = await loadInstalledPlugins({});
    if (installed.plugins.length === 0) fail('loadInstalledPlugins 应至少含 builtin nodesign');
    if (!installed.skills.includes('deskskill-engine-mini')) {
      fail('loadInstalledPlugins.skills 缺 deskskill-engine-mini', installed.skills);
    }
    ok(`loadInstalledPlugins → plugins=${installed.plugins.length} skills=[${installed.skills.join(', ')}]`);
  }

  console.log('\n✅ 全部通过\n');
  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ smoke 抛异常:', err);
  process.exit(1);
});
