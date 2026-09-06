/**
 * server/projects/assets-summary.js — 工作区素材摘要（2026-08-18 从 workspace.js 拆出）
 *
 * 这条摘要进每个会话的 system 提示：告诉 agent 工作区里已经有什么素材。
 * 拆出来的理由是它跟"工作区生命周期"没关系 —— 它是个格式化器。
 *
 * ⚠️ 存在的意义在于：**跨会话可见的东西如果没人提，等于不存在**。
 * `assets/` 不随 sessionId 分桶，下个会话 Read 得到；但 agent 不会去猜有什么，
 * 它会重新搜一遍、重新逛一遍那个站。
 */

import path from 'node:path';
import { REFERENCE_IMAGE_DIR } from '../engine/mcp/tools/helpers/reference-download.js';
import fs from 'node:fs/promises';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const TEXT_DOC_EXT = new Set(['.md', '.txt', '.json']);
const BINARY_DOC_EXT = new Set(['.pdf', '.pptx', '.ppt', '.docx', '.doc', '.xlsx', '.xls']);

/**
 * @param {string} sessionRoot - sessions/<sid>/ 绝对路径
 * @returns {Promise<{ count: number, summary: string, hasBinaryDocs: boolean }>}
 *   count=0 时 summary 为空字符串，调用方据此判断是否注入提示。
 *   hasBinaryDocs=true 时调用方追加 python 处理提醒（Read 拿不到这些的内容）。
 */
export async function readAssetsSummary(sessionRoot) {
  try {
    const assetsLink = path.join(sessionRoot, 'assets');
    const stat = await fs.stat(assetsLink).catch(() => null);
    // 搜图落点 09-07 挪到根上的 参考图/（用户看得见的真文件夹）：assets/ 不在也要往下走，
    // 否则那一夹图对下个会话隐形 —— 正是这一节存在的理由（09-07 设计线对账 B2）
    if (!stat && !(await fs.stat(path.join(sessionRoot, REFERENCE_IMAGE_DIR)).catch(() => null))) return { count: 0, summary: '', hasBinaryDocs: false, paths: [], allPaths: [] };

    const entries = stat ? await fs.readdir(assetsLink, { withFileTypes: true }).catch(() => []) : [];
    const files = entries.filter((e) => !e.name.startsWith('.') && (e.isFile() || e.isSymbolicLink()));
    // ⚠️ 别在这儿提前 return：顶层一个文件都没有、但 assets/references/ 下有一堆
    // 采集素材是**常见情形**（agent 逛过站但用户没上传过东西）。提前 return 会让
    // 那些素材对 agent 彻底隐形。

    const images = [];
    const textDocs = [];
    const binaryDocs = [];
    const others = [];
    for (const f of files) {
      const ext = path.extname(f.name).toLowerCase();
      if (IMAGE_EXT.has(ext)) images.push(f.name);
      else if (TEXT_DOC_EXT.has(ext)) textDocs.push(f.name);
      else if (BINARY_DOC_EXT.has(ext)) binaryDocs.push(f.name);
      else others.push(f.name);
    }

    // 摘要：种类 + 头几个文件名（避免太长）
    const parts = [];
    if (images.length > 0) {
      const sample = images.slice(0, 3).join('、');
      parts.push(`${images.length} 张图（${sample}${images.length > 3 ? ` 等` : ''}）`);
    }
    if (textDocs.length > 0) {
      const sample = textDocs.slice(0, 3).join('、');
      parts.push(`${textDocs.length} 个文本文档（${sample}${textDocs.length > 3 ? ` 等` : ''}）`);
    }
    if (binaryDocs.length > 0) {
      const sample = binaryDocs.slice(0, 3).join('、');
      parts.push(`${binaryDocs.length} 个 PDF/Office 文档（${sample}${binaryDocs.length > 3 ? ` 等` : ''}）`);
    }
    if (others.length > 0) {
      parts.push(`${others.length} 个其他文件`);
    }

    // 完整文件清单（按路径列）—— 让 agent 不用再 Glob/LS 探。
    // （08-07 扁平化后 assets/ 是真目录，Glob 也能用；08-21 前这里还写着"symlink 别用 Glob"，删了。）
    const allNames = [...images, ...textDocs, ...binaryDocs, ...others];

    // 参考素材（2026-08-18）：`assets/references/**` 也要报，否则**没有任何机制
    // 告诉 agent 它们存在** —— 上面这遍只列顶层文件，而参考图和 browser_capture
    // 的采集都在子目录里。跨会话可见的东西如果没人提，等于不存在：agent 会重新
    // 去搜一遍、重新逛一遍那个站。
    // 只报数量和头几个名字（几十个文件全列会把这条 system 撑爆）。
    const refs = [];
    try {
      const refRoot = path.join(assetsLink, 'references');
      const walk = async (dir, rel, depth) => {
        for (const e of await fs.readdir(dir, { withFileTypes: true })) {
          if (e.name === '.meta' || e.name.startsWith('.')) continue;
          if (e.isDirectory()) { if (depth > 0) await walk(path.join(dir, e.name), `${rel}/${e.name}`, depth - 1); continue; }
          refs.push(`${rel}/${e.name}`);
        }
      };
      await walk(refRoot, 'assets/references', 2);
    } catch { /* 没有这个目录就没有 */ }
    // 搜下来的图（根上的 参考图/，只扫一层）：跟上面同一个清单，跨会话别重复搜
    try {
      for (const e of await fs.readdir(path.join(sessionRoot, REFERENCE_IMAGE_DIR), { withFileTypes: true })) {
        if (!e.name.startsWith('.') && e.isFile()) refs.push(`${REFERENCE_IMAGE_DIR}/${e.name}`);
      }
    } catch { /* 没搜过图 */ }

    const refLine = refs.length
      ? `另有 ${refs.length} 件参考素材（${refs.slice(0, 3).map(r => r.split('/').pop()).join('、')}`
        + `${refs.length > 3 ? ' 等' : ''}）—— 搜下来的图在根上的 参考图/（用户桌面上看得见），逛站采回来的调色板/字体/结构/动效清单 json 在 assets/references/web/，`
        + '出处记在同目录的 .meta/<同名>.json 里。**先看有没有现成的，别重复去搜。**'
      : '';

    // ⚠️ `paths` 会被 UserPromptSubmit 首轮全量打进状态块（之后只报变化，见
    // hooks/user-prompt-submit.js）。refs 随每次 browser_capture 单调增长，首轮也要封顶；
    // `allPaths` 不封顶，给按项算变化用（不直接打进文案）。
    const REF_CAP = 12;
    const TOP_CAP = 60;
    const refPaths = refs.slice(0, REF_CAP);
    const overflow = refs.length - refPaths.length;
    if (overflow > 0) {
      // 别只是截断了不说 —— 「静默截断」读起来就是"全都在这儿了"
      refPaths.push(`（另有 ${overflow} 件参考素材，在 参考图/ 与 assets/references/web/ 下）`);
    }
    return {
      count: files.length + refs.length,
      summary: [
        files.length ? `workspace 里已有 ${files.length} 个参考素材：${parts.join('、')}` : '',
        refLine,
      ].filter(Boolean).join('\n'),
      hasBinaryDocs: binaryDocs.length > 0,
      paths: [...allNames.slice(0, TOP_CAP).map((n) => `assets/${n}`), ...refPaths],
      allPaths: [...allNames.map((n) => `assets/${n}`), ...refs],
    };
  } catch {
    return { count: 0, summary: '', hasBinaryDocs: false, paths: [], allPaths: [] };
  }
}
