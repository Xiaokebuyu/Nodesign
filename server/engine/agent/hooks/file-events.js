/**
 * 文件改动 → 前端刷新 的两条通路（2026-08-14 可维护性行动：从 hooks.js 原样迁出）。
 *
 * ⚠️ `toWorkspaceRel` 2026-08-13 提到 `server/lib/workspace-path.js`：
 * 发给前端当物件寻址依据的路径全都要过它，而那些 emit 不只在这个文件里
 * （agent-shared 的流式 tool_input 也发 filePath）。
 *
 * （这里曾经有「任务 → 会话」的认领机制（2026-07-28 ~ 08-07）：会话第一次往
 * `tasks/<任务>/` 写东西时落一个 `.nd-task.json` 记住是谁的家，还配了一个
 * PostToolUse(Bash) 钩子扫命令行里的 `tasks/<名>`。整套随任务层一起退役 ——
 * 产物属于项目，不属于任何一次对话。）
 */
import { Events } from '../events.js';
import { walkTaskFiles } from '../../../lib/task-scan.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { toWorkspaceRel } from '../../../lib/workspace-path.js';
import { setActiveArtifact } from '../../../lib/artifact-target.js';

/**
 * FileChanged handler（P0+ s1 C4）：agent 写文件后 SDK 触发，转发给 EventBus。
 *
 * input: FileChangedHookInput (sdk.d.ts:557)
 *   - file_path: string         绝对路径或相对 cwd
 *   - event: 'change' | 'add' | 'unlink'
 *
 * 不在这里做 .html 过滤 —— 全部转发让前端按需消费（C18 ContextUsageBar /
 * C20 file changes 列表都可能用）。前端 Project.jsx 只对 canvas.html bump reloadToken。
 *
 * 返回 {}：不干预 SDK，不影响 agent loop。
 */
/**
 * 画布相对路径；根外返回 null（2026-09-07 存量仓库道）。
 * 文件夹项目里 agent 站在用户仓库、画布只看 `.nodesign/`：改一个源码文件不该在画布上
 * 多一张卡。toWorkspaceRel 对根外路径是「原样退回」，下游会把那串绝对路径当物件 id
 * 去入座，所以这里先拦。相对路径按 cwd 解析（SDK 的 Write/Edit 实际只给绝对路径，
 * 这是兜底）—— 没传 cwdRoot 时 cwd 就是画布根，跟从前一样。
 */
function canvasRelOrNull(filePath, { workspaceRoot, cwdRoot }) {
  if (typeof filePath !== 'string' || !filePath) return null;
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(cwdRoot || workspaceRoot, filePath);
  const rel = toWorkspaceRel(abs, workspaceRoot);
  return path.isAbsolute(rel) ? null : rel;
}

export function makeFileChangedHandler({ ctx, workspaceRoot, cwdRoot = null }) {
  // eslint-disable-next-line no-unused-vars
  return async (input, _toolUseId, _options) => {
    try {
      // 同下 emitter：发工作区相对路径，前端拿它直接当物件 id 的路径部分
      const rel = canvasRelOrNull(input.file_path, { workspaceRoot, cwdRoot });
      if (rel === null) return {};
      ctx.emit(Events.fileChanged(rel, input.event));
    } catch (err) {
      console.warn(`[hooks/FileChanged] handler threw:`, err.message);
    }
    return {};
  };
}

/**
 * PostToolUse(写文件系工具) → 直发 run.file_changed（2026-07-28）。
 *
 * SDK 的 FileChanged hook 是 watcher 型（要先声明 watchPaths 才启动），实测从未
 * 触发。这里走确定性路径：Write/Edit/MultiEdit/NotebookEdit 成功完成即从入参拿
 * 路径发事件 —— agent 每写完一笔，前端立刻 reload iframe / 刷产物墙 / 打角标，
 * 不再等 run.done。PostToolUse 只在工具成功后触发（失败走 PostToolUseFailure），
 * 不会把写坏的半成品刷给用户。
 */
export function makePostToolUseFileChangedEmitter({ ctx, workspaceRoot, sharedRoot, sessionId, cwdRoot = null }) {
  // eslint-disable-next-line no-unused-vars
  return async (input, _toolUseId, _options) => {
    try {
      const t = input?.tool_input;
      const filePath = typeof t?.file_path === 'string' ? t.file_path
        : typeof t?.notebook_path === 'string' ? t.notebook_path : null;
      if (filePath && canvasRelOrNull(filePath, { workspaceRoot, cwdRoot }) !== null) {
        // 刚写的这份 html 就是"当前产物"——list_pages / screenshot / read_page
        // 不给 path 时默认打它，子代理不必知道任务目录长什么样（artifact-target.js）。
        // 形态（deck / site）不在这里定：resolveArtifactTarget 每次解析都按任务现状
        // 重算，免得"先写 index.html 记成 site、后来目录变了"这种陈旧状态。
        const rel = toWorkspaceRel(filePath, workspaceRoot);
        setActiveArtifact(sessionId, rel);
        // 发**工作区相对路径**：画布物件的 id 就是这个字符串。以前发绝对路径，
        // 前端靠 `tasks/<任务>/` 这个特征段把相对部分抠出来 —— 那一层拆掉之后
        // 绝对路径里再没有可锚定的标志，寻址静默失败（舞台卡掉 dock）。
        ctx.emit(Events.fileChanged(rel, 'change'));
      }
    } catch (err) {
      console.warn('[hooks/PostToolUse:file-changed] emit failed:', err.message);
    }
    return {};
  };
}

/**
 * Bash 写盘嗅探（2026-09-07 设计线对账 B1）：cp / npm run build / curl -L -o 落的文件从来不发
 * run.file_changed —— 上面那条只读 Write/Edit 的 file_path。prelude 说「你写盘的文件几秒内自动排进
 * 版面」，对 Bash 一直是假话（站点技术参考教的正是 cp 图进 <站名>/assets/）。
 * 做法：PreToolUse 记下这次 Bash 的起始时间，PostToolUse 走一遍工作区（task-scan 的同一套排除件，
 * node_modules / 隐藏目录不进），mtime 晚于起点的都发一次。上限 48 条，超了不发（构建产物成百上千，
 * 入座器那边也有封顶）。
 */
export function makeBashWriteSniffer({ ctx, workspaceRoot, maxEmit = 48 }) {
  const started = new Map();   // toolUseId → ms
  return {
    pre: async (_input, toolUseId) => { started.set(String(toolUseId), Date.now() - 1500); return {}; },
    post: async (_input, toolUseId) => {
      const since = started.get(String(toolUseId));
      started.delete(String(toolUseId));
      if (!since || !workspaceRoot || !ctx?.emit) return {};
      try {
        const files = await walkTaskFiles(workspaceRoot, { maxDepth: 4 });
        let n = 0;
        for (const f of files) {
          let st;
          try { st = await fs.stat(f.abs); } catch { continue; }
          if (st.mtimeMs < since) continue;
          if (n++ >= maxEmit) break;
          try { ctx.emit(Events.fileChanged(f.rel, 'change')); } catch { /* */ }
        }
      } catch (err) { console.warn('[hooks/bash-write-sniffer]', err.message); }
      return {};
    },
  };
}
