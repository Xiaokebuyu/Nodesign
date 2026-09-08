/**
 * server/lib/plugin-components.js — 上传包的组件白名单 + frontmatter 严格形态（2026-09-08 市场线）
 *
 * 从 plugin-validator.js 拆出来的纯函数（那边顶到行数棘轮了）。validator 在三种上传形态里都调这两样；
 * lib/plugin-pack.js 导出时也用同一张白名单，导出再上传绕不过。
 */

/**
 * ── 组件白名单（2026-09-08，市场线）──
 *
 * 一个 plugin 目录在 SDK 眼里不只是 skill：hooks/hooks.json 能把 command 或 JS module 挂进 CLI 宿主进程，
 * .mcp.json 能起 stdio 进程，agents/ commands/ 是另两种会被加载的组件。`disableSkillShellExecution`
 * 只管 SKILL.md 正文和 slash command 里的 inline shell，管不到这些；bwrap 只管 Bash 工具。
 * 所以上传能进来的只有两样：plugin 清单 + skills/<id>/ 下的文本与图片。别的一律 hard-fail，
 * 错误里点名是哪几个文件，用户自己删掉再传。导出（lib/plugin-pack.js）用同一张表，导出再上传不会绕过。
 */
export const COMPONENT_ALLOW_RE = /\.(md|txt|json|ya?ml|csv|html|css|svg|png|jpe?g|webp|gif)$/i;
export const COMPONENT_DENY_DIRS = new Set(['hooks', 'agents', 'commands', 'scripts', 'bin', 'node_modules']);

/**
 * @param {string[]} rels  相对 plugin 根（plugin-zip）或 skill 根（single-skill-zip）的文件路径，不含目录项
 * @param {'plugin'|'skill'} layout
 * @returns {string[]} 不该出现的文件（空 = 通过）
 */
export function disallowedComponents(rels, layout) {
  const bad = [];
  for (const rel of rels) {
    const segs = rel.split('/');
    let ok;
    if (layout === 'plugin') {
      ok = rel === '.claude-plugin/plugin.json'
        || (segs[0] === 'skills' && segs.length >= 3 && !segs.some((x) => COMPONENT_DENY_DIRS.has(x)) && COMPONENT_ALLOW_RE.test(rel));
    } else {
      ok = !segs.some((x) => COMPONENT_DENY_DIRS.has(x)) && COMPONENT_ALLOW_RE.test(rel);
    }
    if (!ok) bad.push(rel);
  }
  return bad;
}

export function componentError(bad) {
  const shown = bad.slice(0, 5).map((x) => `\`${x}\``).join('、');
  return `包里有不允许的文件：${shown}${bad.length > 5 ? ` 等 ${bad.length} 个` : ''} —— 只收 plugin.json 和 skills/<id>/ 下的文本与图片；hooks / scripts / agents / commands / .mcp.json 不能带（它们会被 SDK 当组件执行）`;
}

/**
 * ── frontmatter 严格形态（2026-09-08）──
 *
 * 我们的 parseFrontmatter 是手写的极简版（重复 key 取最后一个、不认多行标量），SDK 自己用的是真 YAML。
 * 两边解出不同的 description 就是「validator 看到 A、注进 system prompt 的是 B」。堵法不是换解析器
 * （loader 那边还有一份），是把能造成分歧的形态在上传口全拒：重复 key、多行标量（| >）、非 key: value 的行、
 * 块内再出现 ---。合规的 SKILL.md 本来就长不成那样。
 */
export function frontmatterStrictErrors(rawText) {
  const m = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(rawText);
  if (!m) return ['缺 YAML frontmatter（文件要以 --- 开头、--- 结尾的一段 key: value 开场）'];
  const errors = [];
  const seen = new Set();
  for (const line of m[1].split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (t === '---' || t === '...') { errors.push('frontmatter 里不能再出现 --- / ...（多文档）'); continue; }
    const km = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(t);
    if (!km || line !== line.trimStart()) { errors.push(`frontmatter 只接受顶层 \`key: value\`，这一行不是：\`${t.slice(0, 60)}\``); continue; }
    const [, key, value] = km;
    if (seen.has(key)) errors.push(`frontmatter 里 \`${key}\` 出现了两次`);
    seen.add(key);
    if (/^[|>]/.test(value)) errors.push(`frontmatter \`${key}\` 用了多行标量（| 或 >），改成一行`);
    if (/^[&*!]/.test(value)) errors.push(`frontmatter \`${key}\` 用了锚点 / 标签（& * !），不支持`);
  }
  return errors;
}
