import { describe, it, expect } from 'vitest';
import { AGENT_CORE, renderAgentCore, composeSystemPrompt, todayInShanghai, renderPrelude } from './system-prompts.js';

const V = { modelLabel: 'DeepSeek V4 Flash · 视觉', modelId: 'deepseek-v4-flash-vision', modelWindow: 272000, cwd: '/w/proj/shared', memoryDir: '/w/proj/shared/记忆', platform: 'linux', osVersion: 'Linux 6.1', date: '2026-09-08 星期二' };

describe('agent-core.md（API 行的基础约定，09-08 替掉 claude_code 预设）', () => {
  it('加载成功且八节齐全', () => {
    expect(AGENT_CORE.length).toBeGreaterThan(3000);
    for (const h of ['## 身份与运行环境', '## 系统约定', '## 执行任务', '## 谨慎操作', '## 工具使用', '## 输出与语气', '## 记忆', '### 写入方式', '### 读取记忆', '### 本平台的约定']) {
      expect(AGENT_CORE).toContain(h);
    }
  });
  it('渲染后占位符全部换成真值，不留 {{X}}', () => {
    const out = renderAgentCore(V);
    expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(out).toContain('DeepSeek V4 Flash · 视觉');
    expect(out).toContain('`deepseek-v4-flash-vision`');
    expect(out).toContain('272k tokens');
    expect(out).toContain('`/w/proj/shared`');
    expect(out).toContain('`/w/proj/shared/记忆`');
    expect(out).toContain('2026-09-08 星期二');
    expect(out).toContain('linux，Linux 6.1');
  });
  it('记忆段保留 SDK 合同的关键约束：frontmatter 四字段、MEMORY.md 只做索引、200 行截断、先核再推荐', () => {
    const out = renderAgentCore(V);
    for (const k of ['name:', 'description:', 'metadata:', 'type: <user | feedback | project | reference>', 'MEMORY.md 是索引', '第 200 行之后', '**Why:**', '**How to apply:**', '文件路径查是否存在', '不要执行 mkdir']) {
      expect(out).toContain(k);
    }
  });
  it('缺任何一个值都抛错，不静默渲染', () => {
    for (const k of Object.keys(V).filter((k) => !['platform', 'osVersion', 'date'].includes(k))) {
      expect(() => renderAgentCore({ ...V, [k]: '' })).toThrow(/没有值/);
    }
    expect(() => renderAgentCore({ ...V, modelWindow: NaN })).toThrow(/MODEL_WINDOW/);
  });
  it('日期按 Asia/Shanghai：UTC 23:00 已经是北京的第二天', () => {
    expect(todayInShanghai(new Date('2026-09-08T23:30:00Z'))).toMatch(/^2026-09-09 /);
  });
});

describe('composeSystemPrompt：按通路二选一', () => {
  const prelude = renderPrelude('strict', {});
  it('订阅行 = claude_code 预设 + 平台协议作 append（OAuth 要 Claude Code 身份段）', () => {
    const sp = composeSystemPrompt({ mode: 'subscription', prelude });
    expect(sp).toEqual({ type: 'preset', preset: 'claude_code', append: prelude, snapshot: false });
  });
  it('API 行 = 自定义：基础约定在前、平台协议在后', () => {
    const core = renderAgentCore(V);
    const sp = composeSystemPrompt({ mode: 'api', prelude, core });
    expect(sp.type).toBe('custom');
    // SDK 0.3.267 起不写就默认录进转录、续跑沿用旧提示；两条通路都必须显式关
    expect(sp.snapshot).toBe(false);
    expect(sp.prompt.startsWith(core)).toBe(true);
    expect(sp.prompt.endsWith(prelude)).toBe(true);
    expect(sp.prompt).not.toContain('claude_code');
  });
  it('API 行缺 core 抛错', () => {
    expect(() => composeSystemPrompt({ mode: 'api', prelude })).toThrow(/缺 core/);
  });
});

describe('平台协议措辞（09-08 站主：准确正式，不要散文）', () => {
  it('不再引用"append 在 SDK preset 之后"这个已失效的前提', () => {
    expect(renderPrelude('strict', {})).not.toContain('append 在 SDK preset');
  });
  it('破折号插话已清零（协议与基础约定都是）', () => {
    expect(renderPrelude('strict', { mode: 'rp' })).not.toContain('——');
    expect(renderPrelude('strict', { mode: 'design', folder: '/x' })).not.toContain('——');
    expect(renderAgentCore(V)).not.toContain('——');
  });
});
