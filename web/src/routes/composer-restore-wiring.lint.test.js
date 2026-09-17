/**
 * 工作台那头「原话不丢」的接线（09-17，问题库 iss_mtxylgs4_xmmz）。
 *
 * 行为在 components/chat/composer-restore.test.jsx 里真跑；ProjectWorkspace 太重渲染不起来，
 * 它身上的三处接线只能在这里钉：两条发送路径（输入框 handleSend、首页带来的首条消息）
 * 都要 ① 发出去时记下原文与附件 ② 失败时放回输入框；③ 托盘的 setter 要交给 useRewindEvents，
 * 附件才回得了托盘。任何一处被删，回退 / 发送失败时又会静默丢字。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ProjectWorkspace.jsx'), 'utf8');
const count = (re) => (SRC.match(re) || []).length;

describe('ProjectWorkspace：原话不丢的接线', () => {
  it('两条发送路径都记下原文、失败都放回', () => {
    expect(count(/\brememberSent\(userMessageUuid,/g)).toBe(2);
    expect(count(/\brestoreAfterFailedSend\(/g)).toBe(2);
    // 失败提示用的是放回之后的文案与按钮，不是原来那句
    expect(count(/showToast\(toast\.msg,[^)]*toast\.opts\)/g)).toBe(2);
  });

  it('托盘 setter 交给了 useRewindEvents（附件回托盘靠它）', () => {
    expect(SRC).toMatch(/useRewindEvents\(\{[^}]*\bsetInputs\b[^}]*\}\)/);
  });
});
