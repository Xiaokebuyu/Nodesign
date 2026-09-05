import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import {
  parseCard, replaceMemoryBlock, renderCard, resolveCardPath, readCardForStage,
  rewriteCardMemoryIndex, saveCardKeepingMachineBlock, MEM_START, MEM_END,
} from './card.js';

/**
 * 角色卡 = 一个人的全部（2026-09-05 站主提议）。盯三件事：
 *   1. 两个笔一份文件：人改块外、机器改块内，谁都覆盖不了谁
 *   2. 没 frontmatter 的老卡（cast_role 09-05 之前写的）也读得出名字
 *   3. 用户在画布上保存时哪怕把机器块删了 / 把头删了，磁盘上的那份接回去
 */

const tmps = [];
async function ws(files = {}) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-card-'));
  tmps.push(d);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(d, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
  }
  return d;
}
afterAll(async () => { await Promise.all(tmps.map(d => fs.rm(d, { recursive: true, force: true }))); });

describe('parseCard / renderCard', () => {
  it('新卡：frontmatter、正文、空机器块三段各归各', () => {
    const raw = renderCard({ name: '晴可', slug: 'rp-qingke', note: '同桌', persona: '说话短，不解释自己。' });
    const c = parseCard(raw);
    expect(c.fm).toMatchObject({ name: '晴可', slug: 'rp-qingke', note: '同桌' });
    expect(c.body).toContain('# 晴可');
    expect(c.body).toContain('说话短，不解释自己。');
    expect(c.body).not.toContain(MEM_START);
    expect(c.memory).toContain('还没有');
  });

  it('老卡（没有 frontmatter）：名字取 # 标题，机器块视为空', () => {
    const c = parseCard('# 墨璃\n\n<!-- rp-moli · cast_role 登记。 -->\n\n你是墨璃。\n');
    expect(c.fm.name).toBe('墨璃');
    expect(c.fm.slug).toBeNull();
    expect(c.memory).toBe('');
    expect(c.body).toContain('你是墨璃。');
  });

  it('replaceMemoryBlock 只换块内；没有块就接在末尾', () => {
    const a = replaceMemoryBlock('---\nname: A\n---\n# A\n人设。\n', '## 记住的事\n- x');
    expect(a).toContain('人设。');
    expect(a).toContain(`${MEM_START}\n## 记住的事\n- x\n${MEM_END}`);
    const b = replaceMemoryBlock(a, '## 记住的事\n- y');
    expect(b).not.toContain('- x');
    expect(b).toContain('- y');
    expect(b.match(new RegExp(MEM_START, 'g')).length).toBe(1);
  });
});

describe('磁盘上的卡', () => {
  it('resolveCardPath：按名字找文件夹，找不到给 null', async () => {
    const d = await ws({ '角色/晴可/角色卡.md': renderCard({ name: '晴可', persona: 'x' }) });
    expect(await resolveCardPath(d, '晴可')).toBe('角色/晴可/角色卡.md');
    expect(await resolveCardPath(d, '不存在')).toBeNull();
  });

  it('remember 落进 角色/<名>/记忆/ 后重扫索引进卡；进提示词的正文带索引', async () => {
    const d = await ws({ '角色/晴可/角色卡.md': renderCard({ name: '晴可', note: '同桌', persona: '人设正文。' }) });
    await fs.mkdir(path.join(d, '角色/晴可/记忆'), { recursive: true });
    await fs.writeFile(path.join(d, '角色/晴可/记忆/nickname.md'), '---\nname: nickname\ntype: character\ndescription: 被当面叫了绰号，记恨\n---\n\n事实。\n');
    expect(await rewriteCardMemoryIndex(d, '角色/晴可/角色卡.md')).toBe(1);
    const raw = await fs.readFile(path.join(d, '角色/晴可/角色卡.md'), 'utf8');
    expect(raw).toContain('[nickname](记忆/nickname.md) `character` — 被当面叫了绰号，记恨');
    expect(raw).toContain('人设正文。');   // 人写的部分一个字没动
    const forStage = await readCardForStage(d, '角色/晴可/角色卡.md');
    expect(forStage.name).toBe('晴可');
    expect(forStage.note).toBe('同桌');
    expect(forStage.text).toContain('人设正文。');
    expect(forStage.text).toContain('nickname');
    expect(forStage.text).toContain('要用自己 Read');
  });

  it('空索引不进提示词（"还没有"那一行是给人看的）', async () => {
    const d = await ws({ '角色/A/角色卡.md': renderCard({ name: 'A', persona: '人设。' }) });
    const f = await readCardForStage(d, '角色/A/角色卡.md');
    expect(f.text).not.toContain('还没有');
    expect(f.text).not.toContain(MEM_START);
  });

  it('⭐ 用户保存：删了机器块 / 删了头，磁盘上的接回去；人写的按他的', async () => {
    const d = await ws({ '角色/晴可/角色卡.md': renderCard({ name: '晴可', persona: '旧人设。' }) });
    await fs.mkdir(path.join(d, '角色/晴可/记忆'), { recursive: true });
    await fs.writeFile(path.join(d, '角色/晴可/记忆/k.md'), '---\nname: k\ntype: character\ndescription: 一条\n---\nx');
    await rewriteCardMemoryIndex(d, '角色/晴可/角色卡.md');
    // 用户把头和机器块全删了，只留正文
    await saveCardKeepingMachineBlock(d, '角色/晴可/角色卡.md', '# 晴可\n\n新人设。\n');
    const raw = await fs.readFile(path.join(d, '角色/晴可/角色卡.md'), 'utf8');
    expect(raw.startsWith('---\nname: 晴可')).toBe(true);
    expect(raw).toContain('新人设。');
    expect(raw).not.toContain('旧人设。');
    expect(raw).toContain('[k](记忆/k.md)');
    expect(parseCard(raw).fm.name).toBe('晴可');
  });
});
