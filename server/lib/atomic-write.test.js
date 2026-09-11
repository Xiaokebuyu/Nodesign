import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { writeFileAtomic } from './atomic-write.js';

const mkdir = () => fs.mkdtemp(path.join(os.tmpdir(), 'nd-atomic-'));
const tmpsIn = async (dir) => (await fs.readdir(dir)).filter(n => n.endsWith('.tmp'));

describe('writeFileAtomic', () => {
  afterEach(() => vi.restoreAllMocks());

  it('写进去、盖掉旧内容、不留临时文件', async () => {
    const dir = await mkdir();
    const f = path.join(dir, 'board.json');
    await fs.writeFile(f, 'old', 'utf8');
    await writeFileAtomic(f, '{"a":1}');
    expect(await fs.readFile(f, 'utf8')).toBe('{"a":1}');
    expect(await tmpsIn(dir)).toEqual([]);
  });

  it('Windows 上改名暂时被占（EPERM / EBUSY）→ 退避重试后写成', async () => {
    const dir = await mkdir();
    const f = path.join(dir, 'board.json');
    const real = fs.rename.bind(fs);
    let calls = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (a, b) => {
      calls += 1;
      if (calls <= 2) throw Object.assign(new Error('busy'), { code: calls === 1 ? 'EPERM' : 'EBUSY' });
      return real(a, b);
    });
    await writeFileAtomic(f, 'ok');
    expect(calls).toBe(3);
    expect(await fs.readFile(f, 'utf8')).toBe('ok');
    expect(await tmpsIn(dir)).toEqual([]);
  });

  it('不可重试的错误直接抛，临时文件删掉；原文件不动', async () => {
    const dir = await mkdir();
    const f = path.join(dir, 'board.json');
    await fs.writeFile(f, 'old', 'utf8');
    vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('nope'), { code: 'EXDEV' }));
    await expect(writeFileAtomic(f, 'new')).rejects.toThrow('nope');
    expect(await fs.readFile(f, 'utf8')).toBe('old');
    expect(await tmpsIn(dir)).toEqual([]);
  });

  it('一直被占也有尽头：重试用完就抛，不无限等', async () => {
    const dir = await mkdir();
    const f = path.join(dir, 'board.json');
    const spy = vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('locked'), { code: 'EACCES' }));
    await expect(writeFileAtomic(f, 'x', { retries: 2 })).rejects.toThrow('locked');
    expect(spy).toHaveBeenCalledTimes(3);
    expect(await tmpsIn(dir)).toEqual([]);
  });
});
