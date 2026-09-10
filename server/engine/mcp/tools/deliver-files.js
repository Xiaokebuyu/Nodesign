/**
 * mcp/tools/deliver-files.js — deliver_files MCP tool
 *
 * agent 交付：把它挑好的产物直接推进用户浏览器的下载列表，不用用户再自己去
 * 导出菜单里找。单个文件原样交付，多个打成一个 zip。
 *
 * 与 export_handoff 的分工：
 *   export_handoff  整包工程交付（HTML + spec + 全部 assets + README），给"接手的人"
 *   deliver_files   用户要什么就给什么（"把那三张图给我" / "只要这份 deck"）
 *
 * 落点 workspace/exports/，然后 emit run.download_ready —— 前端收到即触发下载。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { safeResolveRead } from '../../../lib/safe-path.js';
import JSZip from 'jszip';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/** 文件名清洗：留中文和常见符号（含连字符、空格），只去掉路径分隔、控制字符与 `..`。
 *  09-07 前那版字符类里有个裸 `-`，把 gen-cover-v1.png 交成了 gencoverv1.png（设计线对账 A4） */
export function safeName(name, fallback) {
  // eslint-disable-next-line no-control-regex
  const base = String(name || '').replace(/[\\/\u0000-\u001f]/g, '_').replace(/\.\./g, '').trim();
  return base || fallback;
}

const DIR_SKIP = new Set(['node_modules', '.git', 'exports', '__pycache__']);
const DIR_FILE_CAP = 2000;
/** 递归收一个文件夹里的文件（工作区相对路径，/ 分隔）；软链一律不跟（safeResolveRead 那条同款理由） */
export async function collectDir(root, relDir, out) {
  const stack = [relDir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = await fs.readdir(path.join(root, cur), { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith('.') || DIR_SKIP.has(e.name)) continue;
      const rel = `${cur}/${e.name}`;
      if (e.isDirectory()) stack.push(rel);
      else if (e.isFile()) {
        if (out.length >= DIR_FILE_CAP) return;
        const abs = path.join(root, rel);
        const st = await fs.stat(abs);
        out.push({ rel, abs, size: st.size });
      }
    }
  }
}

export function makeDeliverFilesTool({ workspaceRoot, projectId, sessionId, ctx }) {
  return tool(
    'deliver_files',
    `Hand finished work to the user: the files land directly in their browser's
download list. Use this when the user asks for something concrete ("give me
those three images", "send me the deck", "export the cover").

- One path → that file is delivered as-is.
- Several paths, or a folder → they are zipped into a single download (a folder
  is delivered whole, keeping its structure; node_modules/.git are skipped).

Paths are workspace-relative (e.g. "canvas.html", "稿件/主稿.html",
"assets/generated/cover.png"). Pick exactly what the user asked for — do not
dump the whole task folder unless they asked for everything.

Note: this delivers the **raw files**. For a self-contained single HTML (all
images and fonts inlined), a PDF or a PPTX, tell the user to use the export
menu — those go through the export pipeline, not this tool. For a full
engineering handoff package use export_handoff instead.`,
    {
      paths: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe('Workspace-relative paths to deliver'),
      filename: z
        .string()
        .optional()
        .describe('Name for the zip when delivering several files (no extension needed)'),
      note: z
        .string()
        .optional()
        .describe('One short line telling the user what this is'),
    },
    async ({ paths, filename, note }) => {
      try {
        if (!workspaceRoot) {
          return { content: [{ type: 'text', text: 'No workspace bound.' }], isError: true };
        }
        const root = path.resolve(workspaceRoot);
        const picked = [];
        const missing = [];
        for (const rel of paths) {
          // ⛔ 纯词法 `path.resolve` 挡不住软链。真攻过（2026-08-18）：工作区里
          // `ln -s <仓库>/.env x.html`，`deliver_files(['x.html'])` 把 **.env 一字不差
          // 推进用户浏览器的下载列表**（5650 字节对上）。这条工具跑在 server 主进程，
          // 沙盒和 permissions.deny 都管不着它 —— 跟 08-17 那次越权同一个形状
          // （抄了守卫的形状没抄 realpath 复核）。判据用仓库里已有的那一份。
          const abs = await safeResolveRead(root, rel);
          if (!abs) {
            return { content: [{ type: 'text', text: `path escapes workspace: ${rel}`
              + '（软链会被解析后再判 —— 指向工作区外的软链不能交付）' }], isError: true };
          }
          try {
            const st = await fs.stat(abs);
            if (st.isFile()) picked.push({ rel, abs, size: st.size });
            else if (st.isDirectory()) {
              // 文件夹整个交付（09-09 案：用户标注站点文件夹说「打包发给我」，agent 传文件夹名被拒，
              // 只好自己 ls 再列 19 条路径）。递归收文件，跳过依赖目录与隐藏目录，封顶防止把仓库打进去。
              const before = picked.length;
              await collectDir(root, rel.replace(/\/+$/, ''), picked);
              if (picked.length === before) missing.push(`${rel} (empty folder)`);
            }
            else missing.push(`${rel} (not a file)`);
          } catch {
            missing.push(rel);
          }
        }
        if (picked.length === 0) {
          return {
            content: [{ type: 'text', text: `Nothing to deliver — not found: ${missing.join(', ')}` }],
            isError: true,
          };
        }

        const exportDir = path.join(root, 'exports');
        await fs.mkdir(exportDir, { recursive: true });

        let outName;
        let bytes;
        if (picked.length === 1) {
          outName = safeName(path.basename(picked[0].rel), 'delivery');
          await fs.copyFile(picked[0].abs, path.join(exportDir, outName));
          bytes = picked[0].size;
        } else {
          const zip = new JSZip();
          // 条目名用工作区相对路径：v1/index.html 与 v2/index.html 同名，按 basename 展平会互相覆盖，
          // 而返回文本照报「2 file(s)」（09-07 设计线对账 A3）
          for (const f of picked) zip.file(f.rel, await fs.readFile(f.abs));
          const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
          outName = `${safeName(filename, 'delivery')}.zip`;
          await fs.writeFile(path.join(exportDir, outName), buf);
          bytes = buf.length;
        }

        const url = `/api/projects/${encodeURIComponent(projectId || '')}`
          + `/sessions/${encodeURIComponent(sessionId || '')}`
          + `/exports/file/${encodeURIComponent(outName)}`;
        try {
          ctx?.emit?.({
            type: 'run.download_ready',
            url,
            filename: outName,
            sizeBytes: bytes,
            count: picked.length,
            note: note || null,
          });
        } catch { /* emit fail-safe */ }

        const kb = (bytes / 1024).toFixed(1);
        return {
          content: [{
            type: 'text',
            text: `Delivered ${outName} (${kb} KB, ${picked.length} file(s)) — it is already downloading in the user's browser.`
              + (missing.length ? `\nSkipped (not found): ${missing.join(', ')}` : '')
              + `\nSay one line about what you handed over; don't repeat the path list.`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `deliver_files failed: ${err?.message || String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
