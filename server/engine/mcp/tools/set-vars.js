/**
 * mcp/tools/set-vars.js —— `set_vars`：改状态表里的几格（2026-08-30）
 *
 * ## 它跟 `edit_board set_text` 的分工
 *
 * set_text 是「重写这条板书的整篇正文」。状态板每拍都要动几个数字，用 set_text 就得
 * 把整张卡连叙述带表格重写一遍 —— 那正是它老写漏、老写错的地方（改一个数字要重述
 * 十几行，模型每次都在重新生成不该变的部分）。
 *
 * set_vars 只动表里那一格，别的一个字不碰。落盘走的是**跟 set_text 同一个**
 * 重写函数（lib/chalk-rewrite.js），所以 frontmatter 保留、卡高重算、
 * 用户拖出来的留白留得住这三条不会两边不一致。
 *
 * ## 为什么写口要大声失败，不 fail-soft
 *
 * 状态表的真相是一份**三方可写**的自由文本：set_vars、agent 的 set_text/Edit、
 * 以及用户自己（chalk_edit 就是为让他随手改板书造的）。写口只守得住自己那一路。
 * 所以这一路必须**看不懂就当场停**：表被改坏时若还 fail-soft 地"尽力写"，
 * 结果是表被写成第二种坏格式，而且没有任何人知道。
 * 读侧另有一层报警（每轮状态块的 vars 节，见 hooks/user-prompt-submit.js）。
 *
 * ⚠️ 笔权（只有作者能改自己的板书）在这里**不判**：状态表是场务件，不是谁的台词。
 * 谁在管这一场，谁就该能改数字。这跟 edit_board 对叙事板书的规矩是两回事。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { readBoard, patchBoard } from '../../../projects/board-store.js';
import { rewriteChalkBody } from '../../../lib/chalk-rewrite.js';
import {
  findStateTable, applyVars, parseStateTable, renderRows,
  STATE_TABLE_TAG, VALUE_MAX, KEY_MAX,
} from '../../../lib/state-table.js';

/** 一次最多改几个键：再多就不是"改状态"是"重建状态表"，那该用 set_text */
const MAX_KEYS = 20;

export function makeSetVarsTool({ projectId, sharedRoot }) {
  return tool(
    'set_vars',
    `Update values in the board's state table — the one chalk note tagged "${STATE_TABLE_TAG}".

Use this every beat for anything that changed and must be remembered: HP, 好感度, 时间,
线索, 持有物, 进度. It edits ONLY those cells; the rest of the note (your prose, the
layout, other tables) is left byte-for-byte alone, and the card is re-measured for you.

Why not edit_board set_text: that rewrites the whole note, so changing one number means
regenerating a dozen lines that should not change. That is where numbers get silently lost.

The table is plain markdown living in a note the user can see and edit:

  | 键 | 值 |
  | --- | --- |
  | 好感度_苏绵 | 3 |

Values you set here show up at the top of your NEXT turn, so you do not have to carry
them in your head. Keys: letters/digits/CJK/_/-/·, max ${KEY_MAX} chars. Values are
single-line, max ${VALUE_MAX} chars — long text belongs in the note body, not a cell.

If there is no state table yet, this tool creates nothing: write one first with
write_on_board (tag: "${STATE_TABLE_TAG}"), then set values here.`,
    {
      vars: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .describe('Keys to set, e.g. {"好感度_苏绵": 5, "时间": "戌时"}. Existing keys are updated, new ones appended.'),
    },
    async (args) => {
      const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });
      if (!projectId || !sharedRoot) return fail('没有项目工作区，set_vars 不可用。');

      const vars = args?.vars && typeof args.vars === 'object' ? args.vars : null;
      const keys = vars ? Object.keys(vars) : [];
      if (!keys.length) return fail('vars 是空的 —— 给至少一个键值对。');
      if (keys.length > MAX_KEYS) {
        return fail(`一次改了 ${keys.length} 个键，超过 ${MAX_KEYS} 上限。`
          + `改这么多说明你在重建整张表 —— 那用 write_on_board / edit_board 的 set_text 重写更合适。`);
      }

      const found = await findStateTable(sharedRoot);
      if (!found.found) {
        if (found.reason === 'multiple') {
          return fail(`板上有 ${found.rels.length} 条 tag 是「${STATE_TABLE_TAG}」的板书：${found.rels.join('、')}。`
            + `状态表只能有一条 —— 先把多余的那条改掉 tag 或撤下来（edit_board remove），我不猜该改哪一条。`);
        }
        return fail(`板上还没有状态表。先用 write_on_board 落一条（\`tag: "${STATE_TABLE_TAG}"\`），`
          + `正文里放一张两列的表：\n\n| 键 | 值 |\n| --- | --- |\n| 好感度_苏绵 | 3 |\n\n然后再来 set_vars。`);
      }

      let applied;
      try {
        applied = applyVars(found.body, vars);
      } catch (err) {
        // ⚠️ 两种失败要说成两句话（真工具探针当场抓到的：原来一律说"表看不懂"，
        // 于是模型传了个坏键、却被指去修一张根本没坏的表）。
        // 错误归因说错方向，比不报错好不了多少 —— 它会让人去改对的东西。
        if (err.code === 'BAD_KEY') {
          return fail(`这个键不能用，一个格都没改：${err.message}\n`
            + `（表本身没问题，换个键名重来。）`);
        }
        // 大声失败：读不懂就停，绝不"尽力写" —— 写坏的表下一次会被写得更坏，
        // 而这一路是三个写入方里唯一守得住的那个
        return fail(`${found.rel} 的状态表看不懂，这次一个键都没改：${err.message}\n`
          + `（先把表修好 —— 它是普通 markdown，Read 那个文件就能看见。）`);
      }

      if (!applied.changed.length && !applied.added.length) {
        return { content: [{ type: 'text', text: `表里这几个键已经是这个值了，没动：${keys.join('、')}（${found.rel}）` }] };
      }

      // 落盘 + 板上重算：走跟 set_text 同一个函数，三条语义（frontmatter 保留 /
      // 卡高重算 / 用户拖出来的留白留得住）不会两边不一致
      const board = await readBoard(projectId);
      const entry = board.objects?.[found.rel] || {};
      let box;
      try {
        box = await rewriteChalkBody(found.abs, applied.body, entry);
      } catch (err) {
        return fail(`${found.rel} 写不进去（${err.message}）—— 表没改成。`);
      }
      if (board.objects?.[found.rel]) {
        // patchBoard 收的是 diff 对象不是回调（board-store.js:85）
        try {
          await patchBoard(projectId, { objects: { [found.rel]: { ...entry, w: box.w, h: box.h } } });
        } catch { /* 板上尺寸没跟上不影响真相（文件已经改了），下次 reflow 会对 */ }
      }

      const lines = [];
      if (applied.changed.length) {
        lines.push(`改了 ${applied.changed.length} 格：`
          + applied.changed.map((c) => `${c.key} ${c.from || '（空）'} → ${c.to}`).join('；'));
      }
      if (applied.added.length) {
        lines.push(`新增 ${applied.added.length} 格：`
          + applied.added.map((c) => `${c.key} = ${c.value}`).join('；'));
      }
      if (applied.clamped.length) {
        // 钳住但要说（入参不许静默改口径）
        lines.push(`⚠️ 这几个值被清洗过（换行压成空格、竖线换成斜杠、超 ${VALUE_MAX} 字截断）：${applied.clamped.join('、')}`);
      }
      lines.push(`表在 ${found.rel}，现在共 ${applied.rows.length} 格。下一轮开头你会看到它。`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}

/** 给测试与 SKILL 用的样板表（保持和工具描述里那段一致） */
export function sampleStateTable(rows = [{ key: '好感度_苏绵', value: '3' }]) {
  return renderRows(rows).join('\n');
}

export { parseStateTable };
