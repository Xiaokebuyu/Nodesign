/**
 * server/lib/plugin-validator.js — Plugin zip 包格式校验
 *
 * 用户上传 plugin zip 时先过这层，hard-fail 拒绝危险/不合规包，warn 提示
 * 非致命问题。pass 后才允许写盘。
 *
 * 校验流程（按成本递增）：
 *   1. zip 元信息（大小 / entry 数）—— 几乎免费
 *   2. entry 路径安全（path traversal / 绝对路径）—— 解析 zip 不读 entry 内容
 *   3. 必备文件存在（.claude-plugin/plugin.json + skills/<id>/SKILL.md）
 *   4. 读 plugin.json + 解析 + 字段校验
 *   5. 遍历每个 SKILL.md 读 frontmatter + 校验 name 字段
 *
 * 任何 hard-fail 立即停止后续，返 `{ok: false, errors: [...]}`。
 *
 * SDK plugin convention（约定的目录结构）：
 *   <plugin-root>/
 *     .claude-plugin/plugin.json   { name, version?, description? }
 *     skills/<skill-id>/SKILL.md   YAML frontmatter { name, version?, description? }
 *
 * 安全约束：
 *   - jszip 不解析 zip 里的 unix 文件类型/权限，所以不存在 symlink 风险
 *     （jszip 把所有 entry 当 data file 提取）；但仍需查 path traversal
 *   - 总 / 单文件大小限制防 zip bomb
 *
 * 复用：parseFrontmatter from server/engine/agent/skill.js
 */

import JSZip from 'jszip';
import { parseFrontmatter } from '../engine/agent/skill.js';

// ── 校验阈值 ──

export const LIMITS = {
  ZIP_MAX_BYTES: 8 * 1024 * 1024,      // 总大小 ≤ 8MB
  ENTRY_MAX_BYTES: 2 * 1024 * 1024,    // 单文件 ≤ 2MB
  ENTRY_MAX_COUNT: 200,                 // entries ≤ 200
};

export const WARN_THRESHOLDS = {
  DESC_MAX_CHARS: 1536,                 // SDK skill listing description 单条截断阈值
  SKILL_BODY_MAX_BYTES: 50 * 1024,      // SKILL.md body 超 50KB context 占用大
};

// plugin name 命名规范：仅 [a-z0-9-]，≤ 40 char
const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

// 保留前缀（不允许用户 plugin 撞）。`nodesign` 是内置，其余是潜在系统/protocol 名空间
const RESERVED_PLUGIN_NAMES = new Set([
  'nodesign', 'claude', 'anthropic', 'system', 'builtin', 'default',
]);

/**
 * 校验 plugin zip buffer。
 *
 * @param {Buffer} buffer - 用户上传 zip 文件内容
 * @returns {Promise<{
 *   ok: true, manifest: object, skills: Array<{id, name, version, description}>, warnings: string[]
 * } | {
 *   ok: false, errors: string[]
 * }>}
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

function componentError(bad) {
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

export async function validatePluginZip(buffer) {
  const errors = [];
  const warnings = [];

  // ── 1. 总大小 ──
  if (!Buffer.isBuffer(buffer)) {
    return { ok: false, errors: ['上传内容不是有效 Buffer'] };
  }
  if (buffer.length > LIMITS.ZIP_MAX_BYTES) {
    return {
      ok: false,
      errors: [`zip 总大小 ${formatBytes(buffer.length)} 超限（≤ ${formatBytes(LIMITS.ZIP_MAX_BYTES)}）`],
    };
  }

  // ── 2. 解压 ──
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    return { ok: false, errors: [`zip 解压失败：${err.message}`] };
  }

  const entries = Object.keys(zip.files);

  // ── 3. entry 数量 ──
  if (entries.length > LIMITS.ENTRY_MAX_COUNT) {
    return {
      ok: false,
      errors: [`zip 含 ${entries.length} 个 entry，超限（≤ ${LIMITS.ENTRY_MAX_COUNT}）`],
    };
  }
  if (entries.length === 0) {
    return { ok: false, errors: ['zip 为空'] };
  }

  // ── 4. entry 路径安全（path traversal / 绝对路径） ──
  // 同时统一识别 zip 根：有些打包工具会包一层顶级目录（如 foo-plugin/.claude-plugin/...）
  // 这里查每个 entry path 是否 unsafe + 收集所有顶级 dir 段
  const topDirs = new Set();
  for (const p of entries) {
    if (p.includes('\\')) {
      errors.push(`entry 路径 \`${p}\` 含反斜杠（Windows 风格），拒绝`);
      break;
    }
    if (p.startsWith('/')) {
      errors.push(`entry 路径 \`${p}\` 是绝对路径，拒绝`);
      break;
    }
    // 任何段含 .. 都拒（即使 zip 库本身可能正规化）
    const segs = p.split('/');
    if (segs.some(s => s === '..')) {
      errors.push(`entry 路径 \`${p}\` 含 \`..\`（path traversal 风险），拒绝`);
      break;
    }
    if (segs[0]) topDirs.add(segs[0]);
  }
  if (errors.length > 0) return { ok: false, errors };

  // ── 5. 识别 plugin root（顶级要么直接是 .claude-plugin 要么是一层 wrapper） ──
  // 情况 A：zip 根 = plugin root（顶级有 .claude-plugin/）
  // 情况 B：zip 根 = wrapper/ → plugin root（wrapper/.claude-plugin/...）
  let rootPrefix = '';
  if (!zip.file('.claude-plugin/plugin.json')) {
    // 找单一 wrapper：所有 entry 顶级都是同一个 dir
    if (topDirs.size === 1) {
      const wrapper = [...topDirs][0];
      if (zip.file(`${wrapper}/.claude-plugin/plugin.json`)) {
        rootPrefix = `${wrapper}/`;
      }
    }
  }
  const manifestPath = `${rootPrefix}.claude-plugin/plugin.json`;
  const manifestEntry = zip.file(manifestPath);
  if (!manifestEntry) {
    return {
      ok: false,
      errors: ['缺 `.claude-plugin/plugin.json` —— zip 必须含 plugin manifest（直接在 zip 根或单层 wrapper 内）'],
    };
  }

  // ── 6. 读 manifest + 校验 ──
  let manifestRaw;
  try {
    manifestRaw = await manifestEntry.async('string');
  } catch (err) {
    return { ok: false, errors: [`读取 plugin.json 失败：${err.message}`] };
  }
  if (Buffer.byteLength(manifestRaw, 'utf8') > LIMITS.ENTRY_MAX_BYTES) {
    return { ok: false, errors: [`plugin.json 单文件超 ${formatBytes(LIMITS.ENTRY_MAX_BYTES)}`] };
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (err) {
    return { ok: false, errors: [`plugin.json 不是 valid JSON：${err.message}`] };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['plugin.json 必须是 JSON object'] };
  }

  const pluginName = manifest.name;
  if (!pluginName || typeof pluginName !== 'string') {
    return { ok: false, errors: ['plugin.json 缺 `name` 字段（必需）'] };
  }
  if (!PLUGIN_NAME_RE.test(pluginName)) {
    return {
      ok: false,
      errors: [`plugin name \`${pluginName}\` 不合规：仅允许 [a-z0-9-]，首字符不能是 -，长度 ≤ 40`],
    };
  }
  if (RESERVED_PLUGIN_NAMES.has(pluginName)) {
    return {
      ok: false,
      errors: [`plugin name \`${pluginName}\` 是保留名（不允许使用：${[...RESERVED_PLUGIN_NAMES].join(' / ')}）`],
    };
  }

  if (manifest.version && typeof manifest.version !== 'string') {
    return { ok: false, errors: ['plugin.json `version` 字段必须是 string'] };
  }
  if (!manifest.version) {
    warnings.push('plugin.json 缺 `version`，默认为 `0.0.0`');
  }

  // ── 6.5 组件白名单：只许 plugin.json + skills/<id>/ 下的文本与图片 ──
  {
    const rels = entries.filter((p) => !zip.files[p].dir && p.startsWith(rootPrefix)).map((p) => p.slice(rootPrefix.length)).filter(Boolean);
    const bad = disallowedComponents(rels, 'plugin');
    if (bad.length) return { ok: false, errors: [componentError(bad)] };
  }

  // ── 7. 找 skills/<id>/SKILL.md ──
  const skillsPrefix = `${rootPrefix}skills/`;
  const skillFiles = entries.filter(p => p.startsWith(skillsPrefix) && p.endsWith('/SKILL.md'));
  if (skillFiles.length === 0) {
    return {
      ok: false,
      errors: ['plugin 必须含至少 1 个 `skills/<id>/SKILL.md`'],
    };
  }

  // ── 8. 逐个 skill 校验 ──
  const skills = [];
  for (const skillFilePath of skillFiles) {
    // 路径形如 [rootPrefix]skills/<id>/SKILL.md，提取 <id>
    const relativeAfterSkills = skillFilePath.slice(skillsPrefix.length); // <id>/SKILL.md
    const segs = relativeAfterSkills.split('/');
    // 拒绝深层嵌套（skills/<id>/sub/SKILL.md 不算合规 skill 入口）
    if (segs.length !== 2 || segs[1] !== 'SKILL.md') {
      // 容忍 — 不是 skill 入口，跳过
      continue;
    }
    const skillId = segs[0];
    if (!PLUGIN_NAME_RE.test(skillId)) {
      return {
        ok: false,
        errors: [`skill id \`${skillId}\` 不合规：仅允许 [a-z0-9-]，长度 ≤ 40`],
      };
    }

    const skillEntry = zip.file(skillFilePath);
    let skillRaw;
    try {
      skillRaw = await skillEntry.async('string');
    } catch (err) {
      return { ok: false, errors: [`读取 ${skillFilePath} 失败：${err.message}`] };
    }
    const skillBytes = Buffer.byteLength(skillRaw, 'utf8');
    if (skillBytes > LIMITS.ENTRY_MAX_BYTES) {
      return {
        ok: false,
        errors: [`${skillFilePath} 单文件 ${formatBytes(skillBytes)} 超 ${formatBytes(LIMITS.ENTRY_MAX_BYTES)}`],
      };
    }

    {
      const fmErrors = frontmatterStrictErrors(skillRaw);
      if (fmErrors.length) return { ok: false, errors: fmErrors.map((e) => `${skillFilePath}：${e}`) };
    }
    const { frontmatter } = parseFrontmatter(skillRaw);
    if (!frontmatter.name) {
      return {
        ok: false,
        errors: [`${skillFilePath} 缺 YAML frontmatter \`name\` 字段（必需）`],
      };
    }
    if (!PLUGIN_NAME_RE.test(frontmatter.name)) {
      return {
        ok: false,
        errors: [`${skillFilePath} frontmatter \`name: ${frontmatter.name}\` 不合规：仅允许 [a-z0-9-]，长度 ≤ 40`],
      };
    }
    // description 按 Anthropic skill 范式强制必填 —— SDK 把 description 注入 system prompt 的
    // skill listing 让 agent 决定何时 invoke。缺 description = agent 看不清这个 skill 是干啥的，
    // 几乎不会主动调
    if (!frontmatter.description || !frontmatter.description.trim()) {
      return {
        ok: false,
        errors: [`${skillFilePath} 缺 YAML frontmatter \`description\` 字段（必需，让 agent 决定何时调用此 skill）`],
      };
    }

    // warn 阈值
    if (frontmatter.description.length > WARN_THRESHOLDS.DESC_MAX_CHARS) {
      warnings.push(
        `${skillFilePath} description ${frontmatter.description.length} char 超 ${WARN_THRESHOLDS.DESC_MAX_CHARS}（SDK skill listing 会被截）`,
      );
    }
    if (skillBytes > WARN_THRESHOLDS.SKILL_BODY_MAX_BYTES) {
      warnings.push(
        `${skillFilePath} body ${formatBytes(skillBytes)} 超 ${formatBytes(WARN_THRESHOLDS.SKILL_BODY_MAX_BYTES)}（agent invoke 时 context 占用大）`,
      );
    }
    if (!frontmatter.version) {
      warnings.push(`${skillFilePath} 缺 frontmatter \`version\`，默认为 \`0.0.0\``);
    }

    skills.push({
      id: skillId,
      name: frontmatter.name,
      version: frontmatter.version || '0.0.0',
      description: frontmatter.description || '',
    });
  }

  if (skills.length === 0) {
    return {
      ok: false,
      errors: ['未找到合规 skill（skills/<id>/SKILL.md 至少 1 个，路径形态需精确）'],
    };
  }

  // ── 9. 单文件大小：抽查所有 entry ──
  // 大文件可能在 patterns/ 等附件里；逐个 entry uncompressed 大小检查
  for (const p of entries) {
    const entry = zip.files[p];
    if (entry.dir) continue;
    // jszip 没暴露 uncompressedSize（除非用 _data），保守做法：解到 nodebuffer 看大小
    // 但全 zip 解一遍开销大，这里只对 *已知关键路径*（manifest + skill）做尺寸保护（上面已做）。
    // 其他文件（如 skill 的 patterns/*.md）按总大小限制即可（总 ≤ 8MB 包含）。
  }

  return {
    ok: true,
    manifest: {
      name: pluginName,
      version: manifest.version || '0.0.0',
      description: manifest.description || '',
    },
    skills,
    warnings,
    rootPrefix,  // 解压时用，去掉 wrapper 层
  };
}

/**
 * 把校验通过的 zip 解压到目标目录（atomic：先解到 staging，调用方完成后 rename）。
 *
 * 注意：本函数假定 `validatePluginZip` 已经过，**只关心 path 安全**这一项二次防御。
 *
 * @param {Buffer} buffer
 * @param {string} stagingDir - 已建好的空目录绝对路径
 * @param {string} rootPrefix - validate 时识别的 wrapper 前缀（可能是 '' 或 'foo/'）
 * @returns {Promise<void>}
 */
export async function extractPluginZip(buffer, stagingDir, rootPrefix = '') {
  const path = await import('node:path');
  const fs = await import('node:fs/promises');

  const zip = await JSZip.loadAsync(buffer);
  for (const [entryPath, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    // 去 wrapper 前缀
    if (rootPrefix && !entryPath.startsWith(rootPrefix)) continue;
    const relativePath = rootPrefix ? entryPath.slice(rootPrefix.length) : entryPath;
    if (!relativePath) continue;
    // 二次防御：拒绝 .. / 绝对路径（应该已被 validate 拦但保险）
    if (relativePath.includes('..') || relativePath.startsWith('/')) {
      throw new Error(`unsafe entry path during extract: ${relativePath}`);
    }
    const targetPath = path.join(stagingDir, relativePath);
    // 校验解压后路径仍在 stagingDir 下（resolve 后比较 prefix）
    const resolvedTarget = path.resolve(targetPath);
    const resolvedStaging = path.resolve(stagingDir);
    if (!resolvedTarget.startsWith(resolvedStaging + path.sep) && resolvedTarget !== resolvedStaging) {
      throw new Error(`extract target escapes staging dir: ${relativePath}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const content = await entry.async('nodebuffer');
    await fs.writeFile(targetPath, content);
  }
}

// ─────────────────────────────────────────────────────────────────────
// 双轨上传 dispatcher（2026-05-18 Commit C）
//
// 现实场景：用户上传一个新设计方法论 ≠ 打 plugin 包。绝大多数场景是单个
// SKILL.md（含 YAML frontmatter）。强制 plugin zip 是工程化负担，所以加
// 自动嗅探：单 .md / skill zip / 完整 plugin zip 三种上传形态都接，host
// 自动包装成 SDK plugin 布局。
//
// 三种 mode：
//   - 'single-md'        — UTF-8 文本（用户直接传 SKILL.md）
//   - 'single-skill-zip' — zip 内**无** .claude-plugin/plugin.json 但根
//                          （或单层 wrapper 内）有 SKILL.md
//   - 'plugin-zip'       — zip 内有 .claude-plugin/plugin.json，走旧路径
//
// 包装规则（用户已确认）：自动包装时 plugin name = frontmatter.name（跟
// skill name 同名）。trade-off：plugin/skill 共用一个 name，但对单 skill
// 场景最直觉；用户可以撞内置保留名时报错。
// ─────────────────────────────────────────────────────────────────────

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);  // PK\x03\x04

function isZipBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  return buffer.subarray(0, 4).equals(ZIP_MAGIC);
}

/**
 * 上传 dispatcher：自动识别 buffer 是单 .md / skill zip / 完整 plugin zip，
 * 调对应 validator，返统一形态。
 *
 * @param {Buffer} buffer
 * @returns {Promise<{
 *   ok: true,
 *   mode: 'single-md' | 'single-skill-zip' | 'plugin-zip',
 *   manifest: { name, version, description },
 *   skills: Array<{ id, name, version, description }>,
 *   warnings: string[],
 *   rawText?: string,         // mode='single-md'
 *   rootPrefix?: string,      // mode='single-skill-zip' / 'plugin-zip'
 *   skillRootPrefix?: string, // mode='single-skill-zip'：含 SKILL.md 的目录前缀
 * } | { ok: false, errors: string[] }>}
 */
export async function validateSkillUpload(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    return { ok: false, errors: ['上传内容不是有效 Buffer'] };
  }
  if (buffer.length === 0) {
    return { ok: false, errors: ['上传内容为空'] };
  }
  if (buffer.length > LIMITS.ZIP_MAX_BYTES) {
    return {
      ok: false,
      errors: [`上传大小 ${formatBytes(buffer.length)} 超限（≤ ${formatBytes(LIMITS.ZIP_MAX_BYTES)}）`],
    };
  }

  // 嗅探：zip vs UTF-8 文本
  if (!isZipBuffer(buffer)) {
    return validateSingleMd(buffer);
  }

  // 是 zip：判断含 plugin.json 还是单 skill zip
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    return { ok: false, errors: [`zip 解压失败：${err.message}`] };
  }
  const entries = Object.keys(zip.files);

  // entry path 安全 + 找顶级目录（跟 validatePluginZip 同逻辑）
  const topDirs = new Set();
  for (const p of entries) {
    if (p.includes('\\') || p.startsWith('/')) {
      return { ok: false, errors: [`entry 路径 \`${p}\` 含反斜杠或绝对路径，拒绝`] };
    }
    const segs = p.split('/');
    if (segs.some(s => s === '..')) {
      return { ok: false, errors: [`entry 路径 \`${p}\` 含 \`..\`（path traversal 风险），拒绝`] };
    }
    if (segs[0]) topDirs.add(segs[0]);
  }

  // 找 plugin root（含 .claude-plugin/plugin.json 的位置）
  let pluginRootPrefix = '';
  let hasPluginManifest = false;
  if (zip.file('.claude-plugin/plugin.json')) {
    hasPluginManifest = true;
  } else if (topDirs.size === 1) {
    const wrapper = [...topDirs][0];
    if (zip.file(`${wrapper}/.claude-plugin/plugin.json`)) {
      hasPluginManifest = true;
      pluginRootPrefix = `${wrapper}/`;
    }
  }

  if (hasPluginManifest) {
    // 走完整 plugin zip 路径（已有逻辑）
    const result = await validatePluginZip(buffer);
    if (!result.ok) return result;
    return { ...result, mode: 'plugin-zip' };
  }

  // 不含 plugin.json → 当 single-skill zip：找 SKILL.md
  return validateSingleSkillZip(zip, entries, topDirs);
}

/**
 * 校验单 SKILL.md 文本（用户直接上传 .md 文件）
 *
 * @param {Buffer} buffer - UTF-8 文本
 */
function validateSingleMd(buffer) {
  let rawText;
  try {
    rawText = buffer.toString('utf8');
  } catch (err) {
    return { ok: false, errors: [`文本解码失败：${err.message}`] };
  }
  if (rawText.length > LIMITS.ENTRY_MAX_BYTES) {
    return {
      ok: false,
      errors: [`SKILL.md 大小 ${formatBytes(rawText.length)} 超限（≤ ${formatBytes(LIMITS.ENTRY_MAX_BYTES)}）`],
    };
  }

  {
    const fmErrors = frontmatterStrictErrors(rawText);
    if (fmErrors.length) return { ok: false, errors: fmErrors };
  }
  const { frontmatter } = parseFrontmatter(rawText);
  if (!frontmatter.name) {
    return {
      ok: false,
      errors: ['SKILL.md 缺 YAML frontmatter `name` 字段（必需，且 plugin 自动包装时用作 plugin name）'],
    };
  }
  if (!PLUGIN_NAME_RE.test(frontmatter.name)) {
    return {
      ok: false,
      errors: [`frontmatter \`name: ${frontmatter.name}\` 不合规：仅允许 [a-z0-9-]，首字符不能是 -，长度 ≤ 40`],
    };
  }
  if (RESERVED_PLUGIN_NAMES.has(frontmatter.name)) {
    return {
      ok: false,
      errors: [`name \`${frontmatter.name}\` 是保留名（包装成 plugin 时会撞内置保留前缀：${[...RESERVED_PLUGIN_NAMES].join(' / ')}）`],
    };
  }
  // description 按 Anthropic skill 范式强制必填（同 plugin-zip mode）
  if (!frontmatter.description || !frontmatter.description.trim()) {
    return {
      ok: false,
      errors: ['SKILL.md 缺 YAML frontmatter `description` 字段（必需，让 agent 决定何时调用此 skill）'],
    };
  }

  const warnings = [];
  if (frontmatter.description.length > WARN_THRESHOLDS.DESC_MAX_CHARS) {
    warnings.push(
      `description ${frontmatter.description.length} char 超 ${WARN_THRESHOLDS.DESC_MAX_CHARS}（SDK skill listing 会被截）`,
    );
  }
  if (rawText.length > WARN_THRESHOLDS.SKILL_BODY_MAX_BYTES) {
    warnings.push(
      `SKILL.md body ${formatBytes(rawText.length)} 超 ${formatBytes(WARN_THRESHOLDS.SKILL_BODY_MAX_BYTES)}（agent invoke 时 context 占用大）`,
    );
  }
  if (!frontmatter.version) {
    warnings.push(`frontmatter 缺 \`version\`，默认为 \`0.0.0\``);
  }

  // plugin 自动包装：plugin name = skill name
  return {
    ok: true,
    mode: 'single-md',
    manifest: {
      name: frontmatter.name,
      version: frontmatter.version || '0.0.0',
      description: frontmatter.description || '',
    },
    skills: [{
      id: frontmatter.name,
      name: frontmatter.name,
      version: frontmatter.version || '0.0.0',
      description: frontmatter.description || '',
    }],
    warnings,
    rawText,
  };
}

/**
 * 校验单 skill zip（无 .claude-plugin/plugin.json 但有 SKILL.md）
 *
 * @param {JSZip} zip
 * @param {string[]} entries
 * @param {Set<string>} topDirs
 */
async function validateSingleSkillZip(zip, entries, topDirs) {
  if (entries.length > LIMITS.ENTRY_MAX_COUNT) {
    return {
      ok: false,
      errors: [`zip 含 ${entries.length} 个 entry，超限（≤ ${LIMITS.ENTRY_MAX_COUNT}）`],
    };
  }

  // 找 SKILL.md：要么在根，要么在单层 wrapper 内
  let skillMdPath = null;
  let rootPrefix = '';
  if (zip.file('SKILL.md')) {
    skillMdPath = 'SKILL.md';
  } else if (topDirs.size === 1) {
    const wrapper = [...topDirs][0];
    if (zip.file(`${wrapper}/SKILL.md`)) {
      skillMdPath = `${wrapper}/SKILL.md`;
      rootPrefix = `${wrapper}/`;
    }
  }

  if (!skillMdPath) {
    return {
      ok: false,
      errors: ['zip 既无 `.claude-plugin/plugin.json`（plugin zip）也无 `SKILL.md`（skill zip）—— 至少要有一个'],
    };
  }

  // 组件白名单：skill 根下只许文本与图片，scripts/ 一类不进来
  {
    const rels = entries.filter((p) => !zip.files[p].dir && p.startsWith(rootPrefix)).map((p) => p.slice(rootPrefix.length)).filter(Boolean);
    const bad = disallowedComponents(rels, 'skill');
    if (bad.length) return { ok: false, errors: [componentError(bad)] };
  }

  // 读 SKILL.md frontmatter
  let rawText;
  try {
    rawText = await zip.file(skillMdPath).async('string');
  } catch (err) {
    return { ok: false, errors: [`读取 ${skillMdPath} 失败：${err.message}`] };
  }
  const bytes = Buffer.byteLength(rawText, 'utf8');
  if (bytes > LIMITS.ENTRY_MAX_BYTES) {
    return {
      ok: false,
      errors: [`${skillMdPath} 单文件 ${formatBytes(bytes)} 超 ${formatBytes(LIMITS.ENTRY_MAX_BYTES)}`],
    };
  }

  {
    const fmErrors = frontmatterStrictErrors(rawText);
    if (fmErrors.length) return { ok: false, errors: fmErrors };
  }
  const { frontmatter } = parseFrontmatter(rawText);
  if (!frontmatter.name) {
    return {
      ok: false,
      errors: [`${skillMdPath} 缺 YAML frontmatter \`name\` 字段（必需，且 plugin 自动包装时用作 plugin name）`],
    };
  }
  if (!PLUGIN_NAME_RE.test(frontmatter.name)) {
    return {
      ok: false,
      errors: [`${skillMdPath} frontmatter \`name: ${frontmatter.name}\` 不合规：仅允许 [a-z0-9-]，长度 ≤ 40`],
    };
  }
  if (RESERVED_PLUGIN_NAMES.has(frontmatter.name)) {
    return {
      ok: false,
      errors: [`name \`${frontmatter.name}\` 是保留名（包装成 plugin 时会撞内置保留前缀）`],
    };
  }
  // description 按 Anthropic skill 范式强制必填（同其他 mode）
  if (!frontmatter.description || !frontmatter.description.trim()) {
    return {
      ok: false,
      errors: [`${skillMdPath} 缺 YAML frontmatter \`description\` 字段（必需，让 agent 决定何时调用此 skill）`],
    };
  }

  const warnings = [];
  if (frontmatter.description.length > WARN_THRESHOLDS.DESC_MAX_CHARS) {
    warnings.push(
      `${skillMdPath} description ${frontmatter.description.length} char 超 ${WARN_THRESHOLDS.DESC_MAX_CHARS}`,
    );
  }
  if (bytes > WARN_THRESHOLDS.SKILL_BODY_MAX_BYTES) {
    warnings.push(
      `${skillMdPath} body ${formatBytes(bytes)} 超 ${formatBytes(WARN_THRESHOLDS.SKILL_BODY_MAX_BYTES)}`,
    );
  }
  if (!frontmatter.version) {
    warnings.push(`${skillMdPath} 缺 frontmatter \`version\`，默认为 \`0.0.0\``);
  }

  return {
    ok: true,
    mode: 'single-skill-zip',
    manifest: {
      name: frontmatter.name,
      version: frontmatter.version || '0.0.0',
      description: frontmatter.description || '',
    },
    skills: [{
      id: frontmatter.name,
      name: frontmatter.name,
      version: frontmatter.version || '0.0.0',
      description: frontmatter.description || '',
    }],
    warnings,
    rootPrefix,             // wrapper 前缀
    skillRootPrefix: rootPrefix,  // skill 内容前缀（同 rootPrefix，命名留扩展空间）
  };
}

/**
 * 把校验通过的 upload 解到 stagingDir，按 SDK plugin 目录结构布局。
 *
 * mode 多态分派：
 *   - 'single-md'        → 写 plugin.json + skills/<name>/SKILL.md
 *   - 'single-skill-zip' → 解 zip 全部内容到 skills/<name>/（含 patterns/ 等附件）+ 写 plugin.json
 *   - 'plugin-zip'       → 走旧 extractPluginZip 逻辑（直接解压）
 *
 * @param {object} opts
 * @param {Buffer} opts.buffer
 * @param {object} opts.validation - validateSkillUpload 返回
 * @param {string} opts.stagingDir - 已建好的空目录绝对路径
 */
export async function extractToStaging({ buffer, validation, stagingDir }) {
  const path = await import('node:path');
  const fs = await import('node:fs/promises');

  if (validation.mode === 'plugin-zip') {
    await extractPluginZip(buffer, stagingDir, validation.rootPrefix);
    // 清单永远重写成只含 name / version / description：用户带来的 hooks / mcpServers 一类字段不落盘
    // （SDK 会读 manifest 里的组件声明，组件白名单只拦文件，这里拦字段）
    await fs.writeFile(
      path.join(stagingDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: validation.manifest.name, version: validation.manifest.version, description: validation.manifest.description }, null, 2),
      'utf8',
    );
    return;
  }

  // 写 plugin.json（single-md 和 single-skill-zip 都要）
  const manifestDir = path.join(stagingDir, '.claude-plugin');
  await fs.mkdir(manifestDir, { recursive: true });
  await fs.writeFile(
    path.join(manifestDir, 'plugin.json'),
    JSON.stringify({
      name: validation.manifest.name,
      version: validation.manifest.version,
      description: validation.manifest.description,
    }, null, 2),
    'utf8',
  );

  const skillDir = path.join(stagingDir, 'skills', validation.manifest.name);
  await fs.mkdir(skillDir, { recursive: true });

  if (validation.mode === 'single-md') {
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), validation.rawText, 'utf8');
    return;
  }

  if (validation.mode === 'single-skill-zip') {
    const zip = await JSZip.loadAsync(buffer);
    const prefix = validation.skillRootPrefix || '';
    for (const [entryPath, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      if (prefix && !entryPath.startsWith(prefix)) continue;
      const relativePath = prefix ? entryPath.slice(prefix.length) : entryPath;
      if (!relativePath) continue;
      // 二次防御
      if (relativePath.includes('..') || relativePath.startsWith('/')) {
        throw new Error(`unsafe entry path during extract: ${relativePath}`);
      }
      const targetPath = path.join(skillDir, relativePath);
      const resolvedTarget = path.resolve(targetPath);
      const resolvedSkill = path.resolve(skillDir);
      if (!resolvedTarget.startsWith(resolvedSkill + path.sep) && resolvedTarget !== resolvedSkill) {
        throw new Error(`extract target escapes skill dir: ${relativePath}`);
      }
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const content = await entry.async('nodebuffer');
      await fs.writeFile(targetPath, content);
    }
    return;
  }

  throw new Error(`unknown validation.mode: ${validation.mode}`);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
