/** soffice 失败的报错：缺 DLL 那种要说真话，其余原样透传（09-15 退出码 127 案） */
import { describe, it, expect } from 'vitest';
import { explainSofficeFailure } from './render.js';

describe('explainSofficeFailure', () => {
  it('0xC0000135（两种符号写法）→ 报缺运行库并保留原始错误', () => {
    for (const code of [3221225781, -1073741515]) {
      const err = Object.assign(new Error('Command failed: soffice.com --convert-to pdf'), { code });
      const out = explainSofficeFailure(err);
      expect(out).toBe(err);
      expect(out.message).toMatch(/缺 VC\+\+ 运行库/);
      expect(out.message).toMatch(/Command failed: soffice\.com/);
    }
  });
  it('别的失败（超时、退出码 1、ENOENT）不改', () => {
    for (const code of [1, 'ENOENT', undefined]) {
      const err = Object.assign(new Error('boom'), { code });
      expect(explainSofficeFailure(err).message).toBe('boom');
    }
  });
});
