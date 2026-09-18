// @vitest-environment happy-dom
/**
 * 工具失败的原因看得见（09-18 站主：「不少工具在失败后不直接返回错误信息」）：
 * 失败的卡不展开也有一行红字；实时推来的 { message } 不再显示成带字面 \n 的 JSON。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

const { default: Message, toolErrorText } = await import('./Message.jsx');

let host; let root;
function render(message) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root.render(<Message message={message} projectId="proj_a" sessionId="sess-1" />); });
  return host;
}
afterEach(() => { act(() => root?.unmount()); host?.remove(); });

const failed = (over) => ({ role: 'tool', id: 'toolu_1', toolName: 'mcp__nodesign__publish_site', toolInput: { task: '站' }, status: 'error', ...over });

describe('toolErrorText', () => {
  it('实时的 { message } 取正文，回放的字符串原样，空的给空', () => {
    expect(toolErrorText({ message: '第一行\n第二行' })).toBe('第一行\n第二行');
    expect(toolErrorText('发布操作失败：正在发布中')).toBe('发布操作失败：正在发布中');
    expect(toolErrorText(null)).toBe('');
    expect(toolErrorText({ code: 1 })).toContain('"code": 1');
  });
});

describe('失败的工具卡', () => {
  it('⭐ 不展开也显示第一行原因（实时推来的对象形态）', () => {
    const el = render(failed({ toolError: { message: '\n发布操作失败：这个站点正在发布中，稍等\n详情……' } }));
    const line = el.querySelector('[data-tool-error-line]');
    expect(line?.textContent).toBe('发布操作失败：这个站点正在发布中，稍等');
    expect(el.textContent).not.toContain('{"message"');
  });

  it('点那行红字展开，ERROR 区显示正文不是 JSON', () => {
    const el = render(failed({ toolError: { message: 'fetch failed（ECONNRESET）' } }));
    act(() => { el.querySelector('[data-tool-error-line]').click(); });
    expect(el.textContent).toContain('ERROR');
    expect(el.textContent).toContain('fetch failed（ECONNRESET）');
    expect(el.textContent).not.toContain('"message"');
    expect(el.querySelector('[data-tool-error-line]')).toBeNull();   // 展开后不重复显示
  });

  it('Edit 失败（回放的字符串形态）也有红字', () => {
    const el = render({ role: 'tool', id: 'toolu_2', toolName: 'Edit', status: 'error',
      toolInput: { file_path: '/w/a.md', old_string: 'x', new_string: 'y' },
      toolError: '<tool_use_error>String to replace not found in file.</tool_use_error>' });
    expect(el.querySelector('[data-tool-error-line]')?.textContent).toContain('String to replace not found');
  });

  it('成功的卡没有红字', () => {
    const el = render(failed({ status: 'success', toolError: undefined, toolOutput: '已发布' }));
    expect(el.querySelector('[data-tool-error-line]')).toBeNull();
  });
});
