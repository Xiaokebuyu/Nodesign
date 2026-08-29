/**
 * mcp/tools/read-tavern-json.js — read_tavern_json MCP tool（2026-08-15）
 *
 * 搬酒馆的东西进来时的读取口。**不要用 Read 去读这类文件**：真样本
 * （Izumi 0814.json）464KB、210 条提示词，启用的只有 56 条 —— Read 一次就是
 * 十几万 token 进上下文，换来的绝大部分是停用的备选条目。
 *
 * 两步走：先 `摘要` 看结构（每条只给名字/角色/字数/一句引子），挑好了再
 * `取` 正文。转成 编排.yaml 和设定文件是 agent 自己的活，这个工具只读不写。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { detectKind, digest, fetchEntries, extractCardFromPng, listBookEntries } from '../../../lib/tavern-json.js';

const MAX_FETCH_CHARS = 24_000;

/**
 * 世界书条目表。四方世界卡这种 570 条的怪物逐条带引子会刷出上千行 ——
 * 超过 80 条就转紧凑档：常驻的全列（那是要人工挑进 CLAUDE.md 的），
 * 触发的只报名字+触发词不带引子，并指路 export_book 一步落盘。
 */
function 渲染世界书(条目, 标题) {
  const L = [标题 + '：'];
  const compact = 条目.length > 80;
  const 常驻 = 条目.filter(e => e.常驻 && !e.停用);
  const 触发 = 条目.filter(e => !e.常驻 && !e.停用);
  const 停用数 = 条目.filter(e => e.停用).length;
  if (compact) {
    L.push(`启用 ${常驻.length + 触发.length}（常驻 ${常驻.length} / 触发 ${触发.length}）· 停用 ${停用数}`);
    L.push('');
    L.push(`常驻条目（每轮在场的候选 —— 逐条人工过：内容进 CLAUDE.md，引擎件不搬）：`);
    for (const e of 常驻) L.push(`- ${e.名字}  ${e.字数}字`);
    L.push('');
    L.push(`触发条目 ${触发.length} 条（名字｜触发词）——别逐条 fetch，用 mode="export_book" 一步落成 世界书/ 文件：`);
    for (const e of 触发) L.push(`- ${e.名字} ｜ ${e.触发.slice(0, 4).join(' ')}`);
  } else {
    for (const e of 条目) {
      L.push(`- ${e.名字}  ${e.常驻 ? '常驻' : `触发[${e.触发.join(' ')}]`} ${e.字数}字${e.停用 ? ' (停用)' : ''}`);
      if (e.引子) L.push(`    ${e.引子}…`);
    }
  }
  return L.join('\n');
}

function 渲染摘要(d, 文件名) {
  const L = [];
  if (d.形态 === 'preset') {
    L.push(`酒馆 Chat Completion 预设：${文件名}`);
    L.push(`启用 ${d.启用.length} 条（其中有正文的 ${d.启用.filter(e => e.字数 > 0).length} 条，合计 ${d.合计字数} 字）· 停用 ${d.停用.length} 条`);
    const p = d.参数;
    L.push(`参数：temperature ${p.temperature} · top_p ${p.top_p} · 最大输出 ${p.最大输出} · reasoning_effort ${p.reasoning_effort ?? '未设'}`);
    L.push('');
    L.push('启用条目（顺序 = 进模型顺序）:');
    for (const [i, e] of d.启用.entries()) {
      const 标 = e.占位 ? '〔占位·酒馆运行时填，搬过来丢掉〕'
        : e.分隔 ? '〔分节标题·无正文〕' : `${e.字数}字`;
      L.push(`${String(i + 1).padStart(2)}. ${e.名字}  [${e.角色}] ${标}${e.深度 != null ? ` 深度${e.深度}` : ''}`);
      if (e.引子) L.push(`      ${e.引子}…`);
    }
    if (d.停用.length) {
      L.push('');
      L.push(`停用的 ${d.停用.length} 条（同一功能的备选，酒馆里只开一个；名字列表）：`);
      L.push(d.停用.map(e => e.名字).join(' / '));
    }
    L.push('');
    L.push('占位条目（marker，酒馆运行时填角色卡/历史，搬过来一律丢）：' + (d.占位条目.join(' / ') || '无'));
    L.push('分节标题（0 字，只是把开关分组，也不用搬）：' + (d.分隔条目.join(' / ') || '无'));
  } else if (d.形态 === 'card') {
    L.push(`酒馆角色卡：${d.名字}（${文件名}）`);
    for (const f of d.字段) L.push(`- ${f.字段}  ${f.字数}字　${f.引子}…`);
    if (d.开场白备选) L.push(`- alternate_greetings  ${d.开场白备选} 条备选开场白`);
    if (d.世界书.length) {
      L.push('');
      L.push(渲染世界书(d.世界书, `内嵌世界书 ${d.世界书.length} 条`));
    }
  } else {
    L.push(`酒馆世界书：${文件名}`);
    L.push(渲染世界书(d.条目, `${d.条目.length} 条`));
  }
  L.push('');
  L.push('要正文就再调一次本工具：mode="fetch"，entries=["名字或名字的一部分", …]。');
  return L.join('\n');
}

export function makeReadTavernJsonTool({ workspaceRoot, sharedRoot }) {
  return tool(
    'read_tavern_json',
    `Read a SillyTavern (酒馆) export JSON — a chat-completion **preset**, a
**character card** (V2/V3), or a **lorebook** — without pouring the whole file
into your context.

Use this instead of Read for any 酒馆 JSON. A real preset in the wild is 460KB
with 210 prompt entries of which only 56 are enabled; Read would burn six digits
of tokens on disabled alternates.

Two steps:
1. mode "digest" (default) — structure only: every entry's name, role, size and a
   60-char peek, plus which are enabled/disabled, plus sampler params.
2. mode "fetch" with entries[] — full text of just the ones you picked (name,
   partial name, or id). Capped at ${MAX_FETCH_CHARS} chars per call.

Also reads **PNG character cards** directly (V2 chara / V3 ccv3 embedded data) —
point path at the .png, no conversion needed.

mode "export_book" is the one writing mode: dumps every enabled lorebook entry to
workspace files in one call (triggered entries one file each with trigger keys in
frontmatter → grep them before writing a chapter; constant entries under 常驻/ for
you to curate into CLAUDE.md). Use it for big world cards — hundreds of entries
must not flow through your context. Judgment stays yours: what goes to CLAUDE.md,
and dropping 酒馆 engine machinery (MVU variables / HTML status bars / CoT
frameworks / regex_scripts — this platform has its own 状态板/明骰/记忆). Markers
are filled by 酒馆 at runtime and have no place here; jailbreak sections are
pointless on this platform.`,
    {
      path: z.string().describe(
        'Path to the .json. Relative paths resolve against the session workspace, '
        + 'then the shared project dir (e.g. "assets/Izumi 0814.json").',
      ),
      // ⚠️ 参数名和枚举值一律 ASCII —— 工具 schema 是模型要照着填的东西，
      // 中文键名在这条路上不可靠（全仓其他工具也都是 ASCII，别开这个头）
      mode: z.enum(['digest', 'fetch', 'export_book']).optional()
        .describe('digest = structure only (default); fetch = full text of picked entries; export_book = write every enabled lorebook entry to workspace files (triggered ones one file each with keys in frontmatter, constant ones under 常驻/) — the mechanical half of an import, judgment stays yours'),
      entries: z.array(z.string()).optional()
        .describe('For mode="fetch": entry names (partial match ok) or ids'),
      out: z.string().max(120).optional()
        .describe('For mode="export_book": target folder, workspace-relative (default 世界书)'),
    },
    async ({ path: rel, mode = 'digest', entries = [], out }) => {
      const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });
      try {
        const raw = String(rel || '').trim();
        if (!raw) return fail('read_tavern_json needs a path.');
        const candidates = path.isAbsolute(raw)
          ? [raw]
          : [workspaceRoot && path.resolve(workspaceRoot, raw),
             sharedRoot && path.resolve(sharedRoot, raw)].filter(Boolean);
        let abs = null;
        for (const c of candidates) {
          try { await fs.access(c); abs = c; break; } catch { /* 下一个 */ }
        }
        if (!abs) return fail(`File not found: ${raw}\nLooked in:\n${candidates.map(c => `  ${c}`).join('\n')}`);

        let doc;
        const buf = await fs.readFile(abs);
        if (buf.length > 3 && buf.readUInt32BE(0) === 0x89504e47) {
          // 酒馆的卡就是一张 PNG（V3 ccv3 / V2 chara 藏在 tEXt 块里）
          doc = extractCardFromPng(buf);
          if (!doc) return fail('这张 PNG 里没有角色卡数据（tEXt 块无 ccv3/chara）——它可能只是普通图片。');
        } else {
          try { doc = JSON.parse(buf.toString('utf8')); } catch (e) {
            return fail(`这个文件不是合法 JSON：${e.message}`);
          }
        }
        const kind = detectKind(doc);
        if (!kind) {
          return fail('认不出这是酒馆的哪种导出（预设要有 prompts + prompt_order；角色卡要有 first_mes；世界书要有 entries）。普通 JSON 用 Read 就行。');
        }

        if (mode === 'fetch') {
          const 出 = fetchEntries(doc, entries);
          if (!出.length) return fail(`没找到这些条目：${entries.join(' / ')}。先用 mode="digest" 看名字。`);
          let 总 = 0;
          const 块 = [];
          for (const e of 出) {
            if (总 >= MAX_FETCH_CHARS) { 块.push(`〔余下 ${出.length - 块.length} 条超出单次上限，分批取〕`); break; }
            const 文 = e.正文.slice(0, MAX_FETCH_CHARS - 总);
            总 += 文.length;
            块.push(`### ${e.名字}${e.角色 ? `  [${e.角色}]` : ''}\n${文}`);
          }
          return { content: [{ type: 'text', text: 块.join('\n\n') }] };
        }

        if (mode === 'export_book') {
          const all = listBookEntries(doc);
          const live = all.filter(e => !e.停用 && e.正文.trim());
          if (!live.length) return fail('这份文件里没有启用且有正文的世界书条目。');
          const root = sharedRoot || workspaceRoot;
          const dirRel = String(out || '世界书').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
          if (!dirRel || dirRel.split('/').some(s2 => s2 === '..' || s2.startsWith('.'))) return fail('out 目录不合法。');
          const slug = (t) => String(t).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'entry';
          const used = new Set();
          let 触发数 = 0; let 常驻数 = 0;
          for (const e of live) {
            const sub = e.常驻 ? `${dirRel}/常驻` : dirRel;
            await fs.mkdir(path.join(root, sub), { recursive: true });
            let name = slug(e.名字);
            for (let i = 2; used.has(`${sub}/${name}`); i += 1) name = `${slug(e.名字)}-${i}`;
            used.add(`${sub}/${name}`);
            const fm = ['---', 'nd: lore',
              `keys: ${JSON.stringify(e.触发)}`,
              `constant: ${e.常驻}`, `source: ${path.basename(abs)}`, '---', '', e.正文.trim(), ''];
            await fs.writeFile(path.join(root, sub, `${name}.md`), fm.join('\n'), 'utf8');
            if (e.常驻) 常驻数 += 1; else 触发数 += 1;
          }
          return { content: [{ type: 'text', text:
            `Exported ${live.length} entries → ${dirRel}/：触发 ${触发数} 条（一条一文件，frontmatter 带 keys —— `
            + `每章动笔前拿本章的人名/地名/物件 grep 这个目录，命中就 Read）；常驻 ${常驻数} 条在 ${dirRel}/常驻/`
            + `（逐条人工过：世界观内容挑十条以内进 CLAUDE.md，MVU/状态栏/CoT/回复格式这类酒馆引擎件不搬 —— `
            + `平台有自己的状态板/明骰/记忆）。停用条目已跳过。` }] };
        }

        return { content: [{ type: 'text', text: 渲染摘要(digest(doc), path.basename(abs)) }] };
      } catch (err) {
        return fail(`read_tavern_json failed: ${err?.message || String(err)}`);
      }
    },
  );
}
