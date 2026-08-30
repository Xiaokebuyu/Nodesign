/**
 * 散装 .html 的形态嗅探（2026-08-30）。钉的是 proj_mtfz7n8p 那发真误注入：
 * site-craft 的试作按方法论放 `_drafts/<名字>.html`（不在清单里、不叫 index），
 * kindOfPath 一律回落 deck → 每场站点会话的第一笔试作都被塞 deck 参考，
 * 该到的 site 参考反而没到。嗅探判据：deck 有模板 verbatim 军规兜底，正身必带
 * __nd-deck-wrap / data-page；一个都没有的散装 .html 按 site 注入。
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { makePreToolUseHybridReferenceInjector } from './pre-injectors.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-sniff-'));

const call = async (injector, rel, content) => {
  const out = await injector({ tool_input: { file_path: path.join(root, rel), content } }, 't1', {});
  return out?.hookSpecificOutput?.additionalContext || null;
};

describe('首写 HTML 技术参考的形态分派', () => {
  it('⭐ _drafts 站点试作（无 deck 标记）→ 注 site 参考，不再是 deck', async () => {
    const inj = makePreToolUseHybridReferenceInjector({ workspaceRoot: root });
    const ctx = await call(inj, '_drafts/spica-home-proto.html', '<!DOCTYPE html>\n<html lang="zh-CN"><body>hero</body></html>');
    expect(ctx).toBeTruthy();
    expect(ctx).not.toContain('Hybrid deck');
  });

  it('canvas.html 与带 __nd-deck-wrap 的散装稿 → 仍是 deck 参考', async () => {
    const inj = makePreToolUseHybridReferenceInjector({ workspaceRoot: root });
    const ctx = await call(inj, 'canvas.html', '<!DOCTYPE html><body>还没写模板</body>');
    expect(ctx).toContain('Hybrid deck');
    const inj2 = makePreToolUseHybridReferenceInjector({ workspaceRoot: root });
    const ctx2 = await call(inj2, '_drafts/cover.html', '<div class="__nd-deck-wrap" data-deck-aspect="16:9"><section data-page="1"></section></div>');
    expect(ctx2).toContain('Hybrid deck');
  });

  it('每形态一次：site 注过之后 index.html 不再注，换写 deck 还能注', async () => {
    const inj = makePreToolUseHybridReferenceInjector({ workspaceRoot: root });
    expect(await call(inj, '_drafts/a.html', '<body>site 试作</body>')).toBeTruthy();
    expect(await call(inj, 'index.html', '<body>正式首页</body>')).toBeNull();
    expect(await call(inj, 'canvas.html', '<body></body>')).toContain('Hybrid deck');
  });
});
