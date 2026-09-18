// 找不到状态表时的报文（09-17，问题库 iss_mtfwdmba_k6j6）：按板书自身的 tag 查，原报文没说，
// agent 去改标题、改画布分组都还是找不到，连撞三次
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeSetVarsOp } from './set-vars.js';
import { CHALK_DIR } from '../../../lib/chalk.js';

describe('set_vars 找不到状态表', () => {
  it('写明按板书自身的 tag 查找，标题写「状态表」不算', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-setvars-'));
    try {
      const dir = path.join(root, ...CHALK_DIR.split('/'));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'a.md'), '# 状态表\n\n| 键 | 值 |\n| --- | --- |\n| 好感度 | 1 |\n');
      const setVars = makeSetVarsOp({ projectId: 'proj_setvars_test', sharedRoot: root });
      const r = await setVars({ vars: { 好感度: 2 } });
      expect(r.isError).toBe(true);
      const text = r.content[0].text;
      expect(text).toMatch(/按板书自身的 tag 查找/);
      expect(text).toMatch(/标题或正文写「状态表」不算/);
      expect(text).toMatch(/tag: "状态表"/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
