/**
 * mcp/tools/read-document.js — read_document MCP tool（2026-08-07）
 *
 * Word / Excel / PowerPoint 三种格式的读取口。
 *
 * 为什么需要它：用户往上下文托盘里拖一份 .docx（"照这份需求做一版海报"），
 * agent 拿 Read 去读得到的是二进制乱码 —— **而且不报错**，它会当成一份读不懂
 * 的文件继续往下干，交出一个跟需求无关的东西。这是最坏的一种失败：安静的。
 *
 * PDF 不走这里：SDK 的 Read 原生支持，2026-08-07 真跑验过。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { extractDocument, isExtractable, DOC_KINDS, MAX_CHARS } from '../../../lib/doc-extract.js';

const EXT_LIST = Object.keys(DOC_KINDS).join(' / ');

export function makeReadDocumentTool({ workspaceRoot, sharedRoot }) {
  return tool(
    'read_document',
    `Read the text out of a Word / Excel / PowerPoint file (${EXT_LIST}).

The plain Read tool CANNOT read these — they are zip archives, so Read returns
binary garbage without failing, and you end up working from nothing. Whenever a
user attaches or points at one of these files, use this tool instead.

(PDF is different: the normal Read tool handles PDFs natively — use Read for those.)

What you get back is text with structure markers, not layout:
- .docx — the document text, headings/lists/tables flattened in reading order
- .xlsx — one section per worksheet, rows as tab-separated cells
- .pptx — one section per slide, in slide order

Layout is deliberately not preserved. You are being asked what the document
*says*; how it should look is your job to decide.

Long files are cut at ${MAX_CHARS} characters and the result says so.`,
    {
      path: z.string().describe(
        'Workspace-relative path to the file. Files the user uploaded live in 用户内容/ '
        + '(e.g. "用户内容/需求.docx"); older projects may have them under assets/.',
      ),
    },
    async ({ path: rel }) => {
      const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });
      try {
        const raw = String(rel || '').trim();
        if (!raw) return fail('read_document needs a path.');

        // 绝对路径直接用；相对路径先会话工作区、再项目共享目录
        const candidates = path.isAbsolute(raw)
          ? [raw]
          : [workspaceRoot && path.resolve(workspaceRoot, raw),
             sharedRoot && path.resolve(sharedRoot, raw)].filter(Boolean);

        let absPath = null;
        for (const c of candidates) {
          try { await fs.access(c); absPath = c; break; } catch { /* 下一个 */ }
        }
        if (!absPath) {
          return fail(`File not found: ${raw}\nLooked in:\n${candidates.map(c => `  ${c}`).join('\n')}`);
        }

        if (!isExtractable(absPath)) {
          const ext = path.extname(absPath).toLowerCase();
          return fail(
            ext === '.pdf'
              ? 'PDFs are handled by the normal Read tool — call Read on this path instead.'
              : `read_document only handles ${EXT_LIST}. For "${ext}" try the normal Read tool.`,
          );
        }

        const { kind, text, chars, truncated, note } = await extractDocument(absPath);
        if (!text) {
          return {
            content: [{ type: 'text', text: `${kind} ${path.basename(absPath)} 里没有可读的文字${note ? `（${note}）` : ''}。` }],
          };
        }
        const head = [
          `${kind}：${path.basename(absPath)}`,
          `${chars} 字${truncated ? `，只给前 ${MAX_CHARS} 字` : ''}`,
          note,
        ].filter(Boolean).join(' · ');
        return { content: [{ type: 'text', text: `${head}\n\n${text}` }] };
      } catch (err) {
        return fail(`read_document failed: ${err?.message || String(err)}`);
      }
    },
  );
}
