/**
 * 行数棘轮（2026-08-14 可维护性行动 A 刀）。
 *
 * 规则：源文件 ≤ 600 行；已经超标的老户按**现状冻结上限**（下表），只许降
 * 不许升 —— 想给胖文件加功能，先拆出去一块再写。文件瘦下来之后把表里的
 * 数字**手动调低**（棘轮只进不退，这一步是刻意要人做的：降表=宣告胖子在
 * 减肥中，别人别再往里塞）。
 *
 * 为什么是测试不是 CI 规则：这仓库没有 CI，vitest 就是部署链的闸门 ——
 * 跟 path-compose.lint 同一个存在方式。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LIMIT = 600;

/** 老户冻结上限（= 2026-08-14 现状）。只许调低。 */
const GRANDFATHERED = {
  // B1 入座 → B2 搬家 → B3 菜单表 → B5 浮层族 → 08-17 一轮搬走八块（2752 → 2266）：
  // useDragEdgePan / board-keyframes / useBoardAuthoring / useBoardOpen /
  // useSpriteAmbient（并进 SpriteSketchLayer）/ board-tool-groups / useMarquee /
  // useZoneGestures。剩下三块**刻意没拆**：右键菜单组装（引用几乎所有动作和索引表，
  // 抽出去等于把整个组件当参数传）、renderObjectCard/FolderCard 与浮层族 JSX
  // （都是大参数包，拆了更难读）。再往下要先想清楚"状态该由谁持有"，不是搬代码能解决的。
  // 08-17 导出重做：exportCard handler 迁去 canvas/card-export.js，
  // annotTargetOf 收进 board-kinds.js（它的形状要跟右键菜单一字不差，抄两份会分叉）
  'web/src/components/canvas/BoardCanvas.jsx': 2169,
  // 08-17 导出重做：顶栏导出动作迁去 canvas/card-export.js 的 exportFromMenu
  'web/src/routes/ProjectWorkspace.jsx': 2408,
  // server/engine/agent/hooks.js 2026-08-14 拆完出表（1975 → 组装层 ~330，走 600 通用上限）
  'web/src/components/chat/Message.jsx': 1871,   // 正文渲染迁去 MarkdownText.jsx 后
  // 08-15 隔离配置搬去 agent/isolation.js → 08-17 plan mode 工具闸搬去
  // agent/plan-mode-gate.js（纯策略，跟会话循环零耦合）：1184 → 1058
  'server/engine/agent/session-loop.js': 1058,
  'server/projects/workspace.js': 1025,          // 起手模板迁去 workspace-templates.js 后
  // 08-17 组装 user message 迁去 turn-compose.js → 08-19 plan mode 那族端点
  // （permission-mode / plan-request decide / plan-approve / plan-reject）迁去
  // api/turn-plan.js：910 → 669。它们操作的是已经在跑的 run，跟本文件"收消息
  // 起会话"的主职责无关
  'server/api/turn.js': 669,
  'server/api/assets.js': 896,
  'server/api/exports/build-standalone.js': 980,
  // web/src/routes/Home.jsx 08-17 拆完出表（710 → 497，QuickEntry 迁去
  // home-quick-entry.jsx；样式表 08-15 已迁去 home-styles.js）—— 走 600 通用上限
  'web/src/components/canvas/DragOverlay.jsx': 927,
  // 08-17 导出重做：按卡导出迁去 exports/cards.js，旧交付包打包逻辑（待退役）
  // 整块迁去 exports/handoff.js —— 圈起来是为了退役时整份删，不用在大文件里挑
  'server/api/exports.js': 690,
  'server/engine/runs/active-runs.js': 912,
  'server/engine/mcp/tools/generate-image.js': 842,
  'web/src/components/canvas/SiteWindow.jsx': 841,
  'web/src/routes/AdminConsole.jsx': 830,
  'web/src/lib/drag-intent.js': 819,
  'web/src/components/canvas/StageLayer.jsx': 726,
  'server/lib/plugin-validator.js': 721,
  // web/src/components/AuthGate.jsx 08-17 拆完出表（684 → 210）：材质词汇迁去
  // login-wall/wall-css.js，一套构图一个文件迁去 login-wall/scenes/ —— 走 600 通用上限
  // server/engine/agent/agent-shared.js 08-19 拆完出表（600 → 551）：系统提示词的
  // 加载与渲染迁去 agent/system-prompts.js —— 走 600 通用上限
  // web/src/lib/api.js 08-19 顶到 600：导出族（收 blob 那一批 + 文件名头解析）
  // 迁去 lib/api-exports.js（520），仍走通用上限，没进表
  'server/projects/board-store.js': 640,
  'server/engine/mcp/tools/web-search.js': 548,
};

// 运行时用户数据（gitignored）：agent 替用户写的站点代码也会长出 .js 文件，
// 撞进扫描就是误伤 —— 棘轮只管仓库里的源码（2026-08-18 真撞过一次）。
const RUNTIME_DATA_DIRS = new Set(['projects-data', 'user-content']);

function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    if (e.isDirectory() && RUNTIME_DATA_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { sourceFiles(p, out); continue; }
    if (!/\.(js|jsx|mjs)$/.test(e.name)) continue;
    if (/\.(test|lint\.test)\./.test(e.name)) continue;
    out.push(p);
  }
  return out;
}

describe('行数棘轮', () => {
  const files = [
    ...sourceFiles(path.join(REPO, 'web/src')),
    ...sourceFiles(path.join(REPO, 'server')),
  ];

  it('源文件 ≤ 600 行（老户按冻结上限，只降不升）', () => {
    const overs = [];
    for (const f of files) {
      const rel = path.relative(REPO, f).split(path.sep).join('/');
      const src = fs.readFileSync(f, 'utf8');
      const lines = src.split('\n').length - (src.endsWith('\n') ? 1 : 0);   // 与 wc -l 同口径
      const ceiling = GRANDFATHERED[rel] ?? LIMIT;
      if (lines > ceiling) overs.push(`${rel}: ${lines} > ${ceiling}`);
    }
    expect(overs, `超标（胖了就拆，别抬上限）:\n${overs.join('\n')}`).toEqual([]);
  });

  it('冻结表不养幽灵：表里的文件都真实存在（拆完/删掉的从表里摘）', () => {
    const ghosts = Object.keys(GRANDFATHERED)
      .filter(rel => !fs.existsSync(path.join(REPO, rel)));
    expect(ghosts).toEqual([]);
  });
});
