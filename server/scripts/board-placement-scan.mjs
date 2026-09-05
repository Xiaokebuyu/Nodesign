#!/usr/bin/env node
/**
 * scripts/board-placement-scan.mjs —— 板上工具的 14 天真会话对账尺（2026-09-05 意图层落位那一刀的量具）
 *
 * 用法：node server/scripts/board-placement-scan.mjs [天数=14]
 * 扫 ~/.claude/projects 下 Nodesign 项目的 SDK 转录，按工具统计：调用数 / 硬失败 /
 * 「装不下」类失败（short by / Too long / is full / OVERFLOW）。
 *
 * 09-05 改前的基线（设计模式 14 天）：write_on_board 567 次、硬失败 101、装不下 101、
 * 溢出上架 31；edit_board 363 次、硬失败 81；每 2.5 次写板配一次 look_at_board。
 * 改完做几场真会话后再跑：硬失败率、装不下次数、看板/写板比三个数不降就是改错了。
 */
import fs from "node:fs"; import path from "node:path";
const root=path.join(process.env.HOME,".claude/projects"); const since=Date.now()-(Number(process.argv[2])||14)*864e5;
const TOOLS=/^mcp__nodesign__(write_on_board|edit_board|open_sheet|pin_to_board|look_at_board)$/;
const agg={}; let files=0;
for(const d of fs.readdirSync(root)){ if(!/projects-data-proj-.*-shared$/.test(d))continue; const dir=path.join(root,d);
 for(const f of fs.readdirSync(dir)){ if(!f.endsWith(".jsonl"))continue; const fp=path.join(dir,f); if(fs.statSync(fp).mtimeMs<since)continue; files++;
  const pending={}; for(const line of fs.readFileSync(fp,"utf8").split("\n")){ if(!line)continue; let j; try{j=JSON.parse(line)}catch{continue}
   const c=j.message?.content; if(!Array.isArray(c))continue;
   for(const b of c){ if(b.type==="tool_use"&&TOOLS.test(b.name||""))pending[b.id]=b.name.replace("mcp__nodesign__","");
    if(b.type==="tool_result"&&pending[b.tool_use_id]){const t=pending[b.tool_use_id]; delete pending[b.tool_use_id]; agg[t]??={calls:0,error:0,capacity:0}; agg[t].calls++; if(b.is_error)agg[t].error++; const txt=typeof b.content==="string"?b.content:JSON.stringify(b.content||""); if(/short by|Too long for one card|is full|OVERFLOW/.test(txt))agg[t].capacity++;} } } } }
console.log("transcripts:",files); console.table(agg);
