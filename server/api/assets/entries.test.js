import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { guardRel } from './entries.js';

const root = path.resolve('/ws/proj1');
describe('guardRel（删除类路由共用的闸）', () => {
  it('正常路径放行；越界、保留目录、点打头顶层拒绝', () => {
    expect(guardRel('封面.png', root)).toBeNull();
    expect(guardRel('站点/index.html', root)).toBeNull();
    expect(guardRel('../proj2/x', root)).toBe('path escapes workspace');
    expect(guardRel('.git', root)).toBe('reserved directory');
    expect(guardRel('.claude/CLAUDE.md', root)).toBe('reserved directory');
    expect(guardRel('assets', root)).toBe('reserved directory');
  });
  it('⛔ 09-08 评审：编码斜杠带进来的 a/../.git 这种「留在根内的 ..」也要按归一化后的路径判', () => {
    expect(guardRel('a/../.git', root)).toBe('reserved directory');
    expect(guardRel('a/../.git/HEAD', root)).toBe('reserved directory');
    expect(guardRel('a/../assets/x.png', root)).toBe('reserved directory');
    expect(guardRel('x/../../proj2', root)).toBe('path escapes workspace');
    expect(guardRel('', root)).toBe('path escapes workspace');
    expect(guardRel('.', root)).toBe('path escapes workspace');
    // 内层的点文件不在闸的范围（原语义只管顶层）
    expect(guardRel('站点/.htaccess', root)).toBeNull();
  });
});
