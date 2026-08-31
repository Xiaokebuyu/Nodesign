// 板书就地编辑：写一条板书 → 双击 → 改字 → ⌘Enter → 文件内容变、frontmatter 还在、座位还在
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { mintToken, COOKIE_NAME } from './auth/session.js';
import { makeWriteOnBoardTool } from './engine/mcp/tools/write-on-board.js';
import { getSharedDir } from './projects/workspace.js';
import { removeByTag } from './projects/board-tags.js';
const [pid, owner] = process.argv.slice(2);
const origin = process.env.NODESIGN_WEB_ORIGIN;
const tag = `chalkedit-${Date.now().toString(36)}`;
const write = makeWriteOnBoardTool({ projectId: pid, sharedRoot: getSharedDir(pid), sessionId: null, ctx: { counters: { turns: 1 }, emit() {} } });
const r = await write.handler({ text: '**就地编辑测试**\n第一行\n第二行', tag }, {});
const rel = /board note (\S+) at/.exec(r.content[0].text)?.[1];
console.log('wrote', rel);
const b = await chromium.launch({ args: ['--no-sandbox'] });
const c = await b.newContext({ viewport: { width: 1400, height: 900 } });
await c.addCookies([{ name: COOKIE_NAME, value: mintToken(owner), url: origin }]);
const p = await c.newPage();
await p.goto(`${origin}/projects/${pid}/work?eye=1&tag=${encodeURIComponent(tag)}`, { waitUntil: 'domcontentloaded' });
await p.waitForSelector('html[data-eye-ready="1"]', { timeout: 25000 });
// tag 视角里只有一件 → 包络不画（<2）；直接双击那块
const el = await p.$(`[data-board-object="${rel}"]`);
if (!el) { console.log('chalk not on board'); await b.close(); process.exit(1); }
await el.dblclick(); await p.waitForTimeout(600);
const ta = await p.$('textarea');
console.log('editor opened:', !!ta, ta ? 'value=' + JSON.stringify(await ta.inputValue()) : '');
await ta.press('End'); await ta.type('\n第三行（就地改的）');
await ta.press('Control+Enter'); await p.waitForTimeout(1500);
const raw = fs.readFileSync(path.join(getSharedDir(pid), rel), 'utf8');
console.log('file now:\n' + raw);
const shown = await p.evaluate((s) => document.querySelector(s)?.innerText, `[data-board-object="${rel}"]`);
console.log('rendered:', JSON.stringify(shown));
await b.close();
console.log('erase', (await removeByTag(pid, tag)).removed);
