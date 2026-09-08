/**
 * turn-compose.test.js — composeUserMessage 的**基数**回归（2026-08-21 加）。
 *
 * 背景：f6380f4 那笔提交本意只是删一段过时注释，实际把「用户文字 + 附件」整段
 * 又贴了一遍（同一个 chat 被 blocks.push 两次）。结果每条用户消息进 SDK 都是两份
 * 相同的 text block，转录里 `[{text:"你好！"},{text:"你好！"}]`，附件图连 base64
 * 都双份。整份文件语法没错、测试也没有 —— 靠人眼看 diff 是拦不住的。
 *
 * 所以这里断言的不是"内容对不对"而是"每样东西只出现一次"：
 * 复制粘贴多一份立刻红。
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import { composeUserMessage } from './turn-compose.js';

const EMPTY_PENDING = { count: 0, summary: '' };
const texts = (blocks) => blocks.filter((b) => b.type === 'text').map((b) => b.text);

describe('composeUserMessage 基数', () => {
  it('纯文字：正好一个 text block，就是用户那句话', async () => {
    const { blocks } = await composeUserMessage('你好！', [], EMPTY_PENDING, os.tmpdir());
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: 'text', text: '你好！' });
  });

  it('带 pendingSummary：system 块 + 用户那句话各一份', async () => {
    const { blocks } = await composeUserMessage(
      '继续', [], { count: 2, summary: '用户改了 2 处' }, os.tmpdir(),
    );
    expect(texts(blocks).filter((t) => t === '继续')).toHaveLength(1);
    expect(texts(blocks).filter((t) => t.startsWith('<system>'))).toHaveLength(1);
  });

  it('只发附件没文字：占位句只出现一次，素材清单也只有一份', async () => {
    const { blocks } = await composeUserMessage(
      '', [{ path: 'assets/nope.zip', name: 'nope.zip' }], EMPTY_PENDING, os.tmpdir(),
    );
    expect(texts(blocks).filter((t) => t.includes('用户只发了附件'))).toHaveLength(1);
    expect(texts(blocks).filter((t) => t.includes('可用素材'))).toHaveLength(1);
  });

  it('displayText 不重复用户那句话', async () => {
    const { displayText } = await composeUserMessage('唯一一句', [], EMPTY_PENDING, os.tmpdir());
    expect(displayText.split('唯一一句')).toHaveLength(2); // 出现 1 次
  });
});

describe('附件路径 × 桌面 ≠ cwd（09-08 桌面版仓库项目）', () => {
  it('小图按桌面找到并内联；大文件给绝对路径；文档给相对桌面的路径', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-compose-'));
    const desk = path.join(folder, '.nodesign');
    fs.mkdirSync(path.join(desk, '用户内容'), { recursive: true });
    // 1×1 PNG
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    fs.writeFileSync(path.join(desk, '用户内容', 'a.png'), png);
    fs.writeFileSync(path.join(desk, '用户内容', 'big.bin'), Buffer.alloc(16));
    const attachments = [
      { type: 'asset', path: '用户内容/a.png', name: 'a.png', mime: 'image/png', size: png.length },
      { type: 'asset', path: '../../shared/用户内容/big.bin', name: 'big.bin', mime: 'application/octet-stream', size: 16 },   // 老形状也认
      { type: 'asset', path: '用户内容/spec.docx', name: 'spec.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 10 },
    ];
    const { blocks } = await composeUserMessage('看看', attachments, EMPTY_PENDING, { desk, cwd: folder });
    expect(blocks.some((b) => b.type === 'image')).toBe(true);
    const texts = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    expect(texts).toContain(path.join(desk, '用户内容', 'big.bin'));   // Read 用绝对路径
    expect(texts).toContain('用户内容/spec.docx');                     // read_document 相对桌面
    expect(texts).not.toContain('../../shared');
    // 旧签名（cwd = 桌面）：路径相对 cwd
    const old = await composeUserMessage('看看', [attachments[1]], EMPTY_PENDING, desk);
    expect(old.blocks.map((b) => b.text).join('\n')).toContain('- 用户内容/big.bin');
  });
});
