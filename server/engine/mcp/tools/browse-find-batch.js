/**
 * mcp/tools/browse-find-batch.js — browser_find + 通用 batch 工厂 + browser_batch（2026-08-21）
 *
 * 两个都照 Anthropic browser use toolset / Claude in Chrome 的形状：
 *
 * - `browser_find`：自然语言描述 → 元素清单，每个带 `[ref_N]` 和视口中心坐标。
 *   ref 能直接喂给 browser_computer（ref 比像素稳：版面抖一下像素就偏，ref 还在）。
 *   匹配是**词法**的（engine/browse/refs.js 头注释说了为什么），描述里明说。
 *
 * - `makeBatchTool`：一次调用串行跑多条动作，**遇错即停**，后面的条目一律回规格原话
 *   "Not executed: an earlier action in this turn failed."，结尾自动补一张截图（规格：
 *   "your application can attach its own observation on the last result to save a round
 *   trip"）。省掉的是模型往返 —— 浏览和产物检查两条通道唯一真能砍掉的时间。
 *   browser_batch 和 artifact_batch 都是它的实例（同一份合同，别抄两遍）。
 *
 *   ⚠️ 不在 withBrowser / withSession 里套锁：registry 的 mutex 同键串行、不可重入。
 *   batch 逐条调用各工具自己的 handler，每条各自拿一次锁。
 *
 *   典型一趟（采参考站的设计 token）：navigate 内页 A → capture palette+fonts →
 *   navigate 内页 B → capture → navigate 内页 C → capture → 结尾自动截一张。
 *   以前这是 6 个回合，现在是 1 个。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { withBrowser } from '../../browse/registry.js';
import { findInPage, formatMatches } from '../../browse/refs.js';

const asText = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

/** 规格原话（browser 版 halt 文案） */
export const HALT_TEXT = 'Not executed: an earlier action in this turn failed.';
/**
 * browser_batch 能跑的工具。只有 request_help 不进来（它阻塞等人，一等两分钟）。
 * capture **在里面**（用户 08-21 点的）：采参考站的 token 本来就是"进内页 → 采 →
 * 进下一页 → 再采"的多步活，一页一个回合太贵；一趟 batch 把三四页的调色板/字体
 * 一起带回来才对味。
 */
export const BATCHABLE = ['browser_computer', 'browser_find', 'browser_navigate', 'browser_read', 'browser_click', 'browser_screenshot', 'browser_capture'];
const MAX_ITEMS = 20;

export function makeBrowserFindTool({ projectId }) {
  return tool(
    'browser_find',
    `Find elements on the current page by describing them: "search box",
"接受全部 按钮", "pricing link", "logo image". Returns up to 20 matches, each
with a ref (ref_N) you can hand to browser_computer (left_click / hover /
scroll_to with ref) and its viewport-center coordinate. Using refs is cheaper
and steadier than reading pixels off a screenshot.

Matching is LEXICAL, not semantic: your words are matched against the element's
visible text, aria-label, placeholder, alt, role and href. So describe the
element by the words that actually appear on it (button label, link text,
placeholder) plus a role word (button / link / input / image / 按钮 / 链接 /
输入框), and keep it short. No match → read the page (browser_read) to see the
real wording, or screenshot and click by coordinate.

Refs stay valid until the page navigates or re-renders; a stale ref comes back
as an error telling you to find again.`,
    {
      query: z.string().min(1).max(120)
        .describe('What to find, in the words shown on the element plus an optional role word. E.g. "search", "Sign in button", "下一页 链接".'),
      limit: z.number().int().min(1).max(20).optional().describe('Max matches to return (default 20).'),
    },
    async ({ query, limit }) => {
      try {
        return await withBrowser(projectId, async ({ page }) => {
          const r = await findInPage(page, { query, limit: limit ?? 20 });
          return asText(formatMatches(r, query).join('\n'));
        });
      } catch (err) {
        return asText(`browser_find 失败：${err.message}`, true);
      }
    },
  );
}

/**
 * 通用 batch 工厂。
 * @param {object} o
 * @param {string} o.name            工具名
 * @param {string} o.description     描述（调用方写；工厂只负责合同）
 * @param {Array<{name:string, inputSchema:object, handler:Function}>} o.tools   tool() 的返回值；
 *   传进来而不是自己 import 构造：同一批 handler 只该有一份实例（projectId/ctx 都绑在里面）
 * @param {string[]} o.batchable     允许的名字
 * @param {{name:string, input:object}} [o.finalShot]   结尾补的那张"当前状态"；不传就不补
 */
export function makeBatchTool({ name, description, tools = [], batchable, resolve = null, finalShot }) {
  // resolve（2026-08-27 重置，清 08-26 那条「batch 绕闸」挂账）：传了它，子工具在
  // **运行时**从装配完成后的注册表取（index.js 在包装管线跑完后回填 wrappedByName），
  // 能力闸 / 参数消毒 / 模式过滤对 batch 内的调用照常生效。batchable 仍是**政策名单**
  // （哪些名字许进 batch）；resolve 查不到 = 这台机器/该模式把它下架了，如实报。
  // 不传 resolve 走旧的实例表（单测直连用 —— 但生产装配一律传 resolve）。
  const byName = new Map(tools.filter(t => batchable.includes(t.name)).map(t => [t.name, t]));
  const lookup = (n) => (resolve ? (batchable.includes(n) ? resolve(n) : undefined) : byName.get(n));
  const names = resolve ? [...batchable] : [...byName.keys()];
  const shotDefault = finalShot ? finalShot.default !== false : false;
  return tool(
    name,
    description,
    {
      // looseObject（2026-08-29）：**放错层的参数不许静默消失**。模型很自然会写
      // {name, chain:true, input:{…}} —— chain 是 write_on_board 的参数，写在了
      // action 这一层。z.object 默认剥掉未知键，于是那一步照跑、只是丢了半个意图
      // （真会话 proj_mtdr2xpa：两章的 chain:true 都这么没的，章节不接线程、
      // 落到兜底位，正文列当场散架，用户看到的是"摆位乱了"）。收下它们，在
      // handler 里按子工具的 schema 归位，并如实报一句。
      actions: z.array(z.looseObject({
        name: z.string().describe(`Tool name: one of ${names.join(' | ')}.`),
        input: z.record(z.string(), z.unknown()).optional().describe("That tool's input, same shape as calling it directly. Put the tool's OWN parameters in here — a parameter written beside `name` instead of inside `input` is folded in for you and reported."),
      })).min(1).max(MAX_ITEMS)
        .describe(`1-${MAX_ITEMS} items, run in order. Each item: {"name": <tool>, "input": {...}}.`),
      // 没有 finalShot 就不放这个参数 —— 写一个永远无效的旋钮是在骗模型
      ...(finalShot ? { screenshotAfter: z.boolean().optional()
        .describe(shotDefault
          ? 'Append a look at the resulting state at the end (default true). Set false for text-only sequences to save tokens.'
          : 'Pass true to append a look at the resulting state at the end (default false — most board upkeep is text work; ask for eyes when looks matter).') } : {}),
    },
    async ({ actions, screenshotAfter }, extra) => {
      const out = [];
      const n = actions.length;
      let failedAt = -1;
      let failText = '';
      let lastHadImage = false;
      let shotLifted = false;
      for (let i = 0; i < n; i += 1) {
        const { name: toolName, input, ...stray } = actions[i];
        const label = `[${i + 1}/${n}] ${toolName}${input?.action ? ` ${input.action}` : ''}`;
        if (failedAt >= 0) { out.push({ type: 'text', text: `${label}: ${HALT_TEXT}` }); continue; }
        const def = lookup(toolName);
        if (!def) {
          failedAt = i;
          failText = batchable.includes(toolName)
            ? `"${toolName}" 在这台机器/该项目模式下没有注册（能力或模式闸下架了它）——这一步换别的路。`
            : `"${toolName}" is not batchable here (use one of ${names.join(', ')}).`;
          out.push({ type: 'text', text: `${label}: Error: ${failText}` });
          continue;
        }
        // 归位（08-29）：action 这一层的多余键按子工具的 schema 收进 input；
        // screenshotAfter 是 batch 自己的旋钮，抬到 batch 层。都如实报 —— 静默
        // 修正会让下一次还写错，静默丢弃会让这一次就出错。
        let folded = input || {};
        const notes = [];
        const strayKeys = Object.keys(stray);
        if (strayKeys.length) {
          const own = new Set(Object.keys(def.inputSchema || {}));
          const patch = {};
          for (const k of strayKeys) {
            if (k === 'screenshotAfter') { shotLifted = shotLifted || stray[k] === true; notes.push('screenshotAfter 是整批的旋钮，已抬到 batch 层'); continue; }
            if (own.has(k) && !(k in folded)) { patch[k] = stray[k]; continue; }
            notes.push(`${k} 不是 ${toolName} 的参数，忽略了`);
          }
          if (Object.keys(patch).length) {
            folded = { ...folded, ...patch };
            notes.push(`${Object.keys(patch).join('/')} 本该写在 input 里（已收进去，下次直接写 input 内）`);
          }
        }
        const parsed = z.object(def.inputSchema).safeParse(folded);
        if (!parsed.success) {
          failedAt = i;
          const why = parsed.error.issues.map(is => `${is.path.join('.') || '(root)'}: ${is.message}`).join('; ');
          failText = `invalid input — ${why}`;
          out.push({ type: 'text', text: `${label}: Error: ${failText}` });
          continue;
        }
        let r;
        try { r = await def.handler(parsed.data, extra); } catch (err) {
          r = asText(`Error: ${err.message.split('\n')[0]}`, true);
        }
        const blocks = Array.isArray(r?.content) ? r.content : [{ type: 'text', text: String(r) }];
        lastHadImage = blocks.some(b => b.type === 'image');
        // 第一块文本前面挂上 [i/n] 标签；没有文本块（纯图）就补一行标签再放图
        if (!blocks.some(b => b.type === 'text')) out.push({ type: 'text', text: `${label}: done` });
        let prefixed = false;
        const tail = notes.length ? `\n⚠ ${notes.join('；')}` : '';
        for (const b of blocks) {
          if (b.type === 'text' && !prefixed) { out.push({ type: 'text', text: `${label}: ${b.text}${tail}` }); prefixed = true; }
          else out.push(b);
        }
        if (!prefixed && tail) out.push({ type: 'text', text: `${label}:${tail}` });
        if (r?.isError) {
          failedAt = i;
          failText = blocks.find(b => b.type === 'text')?.text || '(no error text)';
        }
      }
      // 失败时把错误行提到最前面：下游（记账层截 120/500 字符、模型扫返回）都先看到
      // 真正的报错，而不是前面成功步骤的输出。同时钉死"别整批重跑"——前面的步骤
      // （click/type 这类非幂等动作）已经执行过了。
      if (failedAt >= 0) {
        const step = actions[failedAt];
        out.unshift({
          type: 'text',
          text: `FAILED at step ${failedAt + 1}/${n} (${step.name}${step.input?.action ? ` ${step.input.action}` : ''}): ${String(failText).split('\n')[0]}\n`
            + `Steps 1-${failedAt} already ran — do NOT re-run the whole batch; continue from the failed step.`,
        });
      }
      const wantShot = screenshotAfter === undefined ? (shotLifted || shotDefault) : screenshotAfter;
      if (finalShot && wantShot && !lastHadImage) {
        const shotDef = lookup(finalShot.name);
        if (shotDef) {
          try {
            const s = await shotDef.handler(finalShot.input || {}, extra);
            out.push({ type: 'text', text: `[after] current state${failedAt >= 0 ? ' (batch stopped early — look and replan)' : ''}:` });
            for (const b of (s.content || [])) out.push(b);
          } catch (err) {
            out.push({ type: 'text', text: `[after] screenshot failed: ${err.message.split('\n')[0]}` });
          }
        }
      }
      return { content: out, ...(failedAt >= 0 ? { isError: true } : {}) };
    },
  );
}

export function makeBrowserBatchTool({ tools, resolve = null }) {
  const names = BATCHABLE.filter(n => tools.some(t => t.name === n));
  return makeBatchTool({
    name: 'browser_batch',
    tools,
    resolve,
    batchable: BATCHABLE,
    finalShot: { name: 'browser_screenshot', input: {} },
    description: `Run a sequence of browser tool calls in ONE round trip. Each item is
{name, input} where input is exactly what you would pass to that tool on its
own. Items run SEQUENTIALLY and the batch STOPS at the first error: the failed
item reports its error, every later item is answered "${HALT_TEXT}", and you
replan from there. A viewport screenshot is appended at the end (unless the
last item already produced an image, or screenshotAfter:false), so you always
see the resulting state.

Use this whenever you can predict two or more steps ahead — navigate, find the
field, click it, type, press Enter, look — instead of paying a model round trip
per action. The classic design-reference run is one batch: navigate to inner
page A → browser_capture palette+fonts → navigate to inner page B → capture →
navigate to C → capture. Six round trips become one, and every page's tokens
land in assets/references/web/ with provenance. Coordinates you write in a
batch refer to the screenshot you saw BEFORE the call; refs from an earlier
browser_find are fine as long as the page has not navigated. Batchable tools:
${names.join(', ')}. browser_batch cannot be nested.
Example: [{"name":"browser_find","input":{"query":"search"}},{"name":"browser_computer","input":{"action":"left_click","ref":"ref_1"}},{"name":"browser_computer","input":{"action":"type","text":"hello"}},{"name":"browser_computer","input":{"action":"key","text":"Enter"}}]`,
  });
}
