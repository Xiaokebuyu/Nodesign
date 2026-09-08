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
import { disallowedComponents, componentError, frontmatterStrictErrors } from './plugin-components.js';
export { disallowedComponents, frontmatterStrictErrors, COMPONENT_ALLOW_RE, COMPONENT_DENY_DIRS } from './plugin-components.js';
// 解压那半 09-08 拆去 plugin-extract.js（行数棘轮）；老调用方仍从这里引
export { extractPluginZip, extractToStaging } from './plugin-extract.js';

// ── 校验阈值 ──

export const LIMITS = {
  ZIP_MAX_BYTES: 8 * 1024 * 1024,      // 总大小 ≤ 8MB
  ENTRY_MAX_BYTES: 2 * 1024 * 1024,    // 单文件 ≤ 2MB
  UNZIPPED_MAX_BYTES: 32 * 1024 * 1024, // 解压后总量 ≤ 32MB（09-08：压缩后 8MB 挡不住炸弹）
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

  // ── 3b. 解压后大小（09-08 审出的 zip 炸弹）：ZIP_MAX_BYTES 量的是压缩后，DEFLATE 能到 1000:1。
  // 在**任何** entry 解压之前按 central directory 里的 uncompressedSize 逐个卡单文件上限、累计卡总量；
  // 读不到这个数（不是 loadAsync 来的对象）就当超限 —— 宁可拒一个正常包，不能让一个人上传所有安装者替他解。
  {
    let total = 0;
    for (const p of entries) {
      const e = zip.files[p];
      if (e.dir) continue;
      const size = e?._data?.uncompressedSize;
      if (!Number.isFinite(size) || size < 0) return { ok: false, errors: [`entry \`${p}\` 读不到解压后大小，拒绝`] };
      if (size > LIMITS.ENTRY_MAX_BYTES) return { ok: false, errors: [`entry \`${p}\` 解压后 ${formatBytes(size)} 超限（≤ ${formatBytes(LIMITS.ENTRY_MAX_BYTES)}）`] };
      total += size;
      if (total > LIMITS.UNZIPPED_MAX_BYTES) return { ok: false, errors: [`zip 解压后总大小超限（≤ ${formatBytes(LIMITS.UNZIPPED_MAX_BYTES)}）`] };
    }
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

  // ── 9. 单文件大小：第 3b 步已经按 central directory 的 uncompressedSize 逐个卡过，这里不再解压抽查 ──

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

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
