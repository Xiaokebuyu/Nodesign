/**
 * engine/agent/role-card.js —— 读角色文件（2026-08-26）
 *
 * 角色文件（`.claude/agents/rp-*.md`）**是模型可写的**：`cast_role` 是正门，但主 agent
 * 手里有 Write/Edit/Bash，`.claude/agents/` 就在工作区内，workspace-scope-guard 不拦它。
 * 所以「角色只能拿板上工具」这条教义如果只写在 cast_role 里，等于没写 —— 绕过它只要
 * 手写一份 md。
 *
 * 收口在**派发时**（见 hooks/pre-defaults.js 的 rp 分支）：不管这份文件是谁写的、
 * 怎么落的盘，派它之前都按同一张白名单核一遍。
 *
 * ## 三种要拦的写法
 *
 *   tools: mcp__nodesign__publish_site      点名要外发工具
 *   tools: mcp__nodesign                    **server 通配** = 这个 server 的全部工具
 *   （压根没有 tools 行）                    SDK 语义 = **继承父代理的全部工具**
 *
 * 最后那条最容易漏：少写一行比多写一行危险。所以缺失 = 不合法，不是"用默认值"。
 *
 * ## 解析为什么是保守的
 *
 * frontmatter 真的走 YAML 解析（CLI 侧 `Bun.YAML.parse`），合法写法不止一种
 * （`a, b` / `[a, b]` / 多行 `- a`）。这里三种都认；认不出的形状一律**当不合法**
 * 而不是当空 —— 判据看不懂的东西不能默认放行。角色文件本来就该由 cast_role 写，
 * 手写出奇怪形状时 deny 会指回正门。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { isResidentRole, isSlotType, safeRoleLabel } from './cast.js';

const AGENTS_DIR = '.claude/agents';
const REGISTRY_REL = '.nd/cast.json';

/**
 * 演员位登记表（2026-08-28 重构）：cast_role 写的 slug → {name, duty, pen, card}。
 * 没有/坏了 = 空表 —— 登记是展示层，fail-soft，坏了角色照样上场（署名退回 slug）。
 */
export async function readCastRegistry(workspaceRoot) {
  try {
    const raw = await fs.readFile(path.join(workspaceRoot, REGISTRY_REL), 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data.roles === 'object' && data.roles ? data : { version: 1, roles: {} };
  } catch { return { version: 1, roles: {} }; }
}
const FM_RE = /^---\r?\n([\s\S]{0,4000}?)\r?\n---/;

/** 从 frontmatter 文本里取一个键的原始值（只认顶层、单行键） */
function rawValue(fm, key) {
  const re = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm');
  const m = re.exec(fm);
  return m ? m[1] : null;
}

/**
 * 解析 tools 声明。
 * @returns {{ kind: 'list', tools: string[] } | { kind: 'missing' } | { kind: 'unparsable' }}
 */
export function parseToolsDeclaration(fm) {
  const raw = rawValue(fm, 'tools');
  if (raw === null) return { kind: 'missing' };
  const inline = raw.trim();

  if (inline === '') {
    // 多行数组：tools:\n  - a\n  - b
    const after = fm.slice(fm.indexOf('\ntools:') + 1).split('\n').slice(1);
    const items = [];
    for (const line of after) {
      if (/^\s*-\s+/.test(line)) { items.push(line.replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, '')); continue; }
      if (/^\S/.test(line)) break;          // 下一个顶层键
      if (line.trim() === '') continue;
      return { kind: 'unparsable' };
    }
    return items.length ? { kind: 'list', tools: items } : { kind: 'unparsable' };
  }

  const flow = /^\[(.*)\]$/.exec(inline);
  const body = flow ? flow[1] : inline;
  const tools = body.split(',').map((t) => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  return tools.length ? { kind: 'list', tools } : { kind: 'unparsable' };
}

/**
 * 读一份角色文件。
 * @returns {Promise<{ slug, displayName: string|null, description: string|null,
 *                     toolsDecl: ReturnType<typeof parseToolsDeclaration> } | null>}
 */
export async function readRoleCard(workspaceRoot, slug) {
  if (!workspaceRoot || !isResidentRole(slug)) return null;
  const file = path.join(workspaceRoot, AGENTS_DIR, `${slug}.md`);
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); } catch { return null; }
  const m = FM_RE.exec(raw);
  if (!m) return { slug, displayName: null, description: null, toolsDecl: { kind: 'unparsable' } };
  const fm = m[1];
  const description = rawValue(fm, 'description');
  const descPlain = description
    ? description.trim().replace(/^"([\s\S]*)"$/, '$1').replace(/\\"/g, '"')
    : null;
  const nameMatch = descPlain ? /^RP 角色「(.+?)」/.exec(descPlain) : null;
  return {
    slug,
    // ⚠️ 展示名是文件里的**自称**，不是实证 —— 角色文件模型可写，一个角色能自称
    // 「用户」或顶替别的角色。只拿它当展示层，归属的锚在名册（harness 亲眼所见的派发）。
    // 保留字闸（safeRoleLabel）在**这个出口**过（08-28 下沉）：此前只在 listRoleNames
    // 过，直接消费 readRoleCard().displayName 的新调用点会重蹈「三个渲染面漏一个」。
    displayName: nameMatch ? safeRoleLabel(slug, nameMatch[1]) : null,
    description: descPlain,
    toolsDecl: parseToolsDeclaration(fm),
  };
}

/**
 * 从派发 prompt 里推断实例名（2026-08-28 晚，glm 撞闸案）。
 *
 * name 闸的原设计假设「deny 一次模型就会补参数」—— 对 sonnet 成立（探针实证），
 * 对免费行 glm 不成立：proj_mtd7d4et 里它连撞九次，第六次把 `name: rp-izumi`
 * 写进了 prompt 正文 —— 它想给，但参数就是发不出来。弱模型够不着的参数不能当
 * 硬前置，所以闸学会自己认，按可靠度分层：
 *
 *   1. prompt 头部的 `name: rp-xxx` 行（模型明说的）
 *   2. 登记表匹配：prompt 里出现某个已登记角色的卡路径（cast_role 的配方就是
 *      「第一行写卡路径」，正常照做的派发天然命中）
 *   3. prompt 里出现的、登记过的 rp- slug
 *
 * 推出来的名字跟模型传参同一信任级（名字本来就是模型起的），不碰任何安全判据
 * （工具白名单在演员位文件上，收件人闸认的是名册登记）。taken 是已在场名册 ——
 * 在场的不再当候选（那是"续演该用 SendMessage"的情形，不是新派）。
 */
export async function inferRoleNameFromPrompt(workspaceRoot, prompt, { taken = new Set(), isSlot = () => false } = {}) {
  const head = String(prompt || '').slice(0, 1200);
  const ok = (s) => s && /^rp-[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/.test(s) && !isSlot(s) && !taken.has(s);
  const explicit = /name[:：]\s*["'「]?(rp-[A-Za-z0-9][A-Za-z0-9_-]*)/.exec(head);
  if (explicit && ok(explicit[1])) return explicit[1];
  const reg = await readCastRegistry(workspaceRoot);
  const byCard = Object.entries(reg.roles)
    .filter(([slug, r]) => ok(slug) && typeof r?.card === 'string' && r.card && head.includes(r.card));
  if (byCard.length === 1) return byCard[0][0];
  const mentioned = Object.keys(reg.roles).filter((slug) => ok(slug) && head.includes(slug));
  if (mentioned.length === 1) return mentioned[0];
  return null;
}

/**
 * 列出这个工作区里所有角色的展示名（slug → 展示名）。
 *
 * 只当**展示层**用：展示名取自角色文件，而那份文件模型能写 —— 一个角色可以自称
 * 「用户」。所以这张表不许用来做判断（路由、权限、归属），只用来把 slug 渲染得好看。
 * 判断一律用 slug 本身（harness 盖的章）。
 */
export async function listRoleNames(workspaceRoot) {
  const out = new Map();
  if (!workspaceRoot) return out;
  // 旧式一角一定义（会话启动前就存在的 .claude/agents/rp-*.md）：仍然认，
  // 但演员位本身（rp-actor / rp-narrator）是位置不是人，不进名册。
  let names;
  try { names = await fs.readdir(path.join(workspaceRoot, AGENTS_DIR)); } catch { names = []; }
  for (const n of names) {
    if (!n.endsWith('.md')) continue;
    const slug = n.slice(0, -3);
    if (!isResidentRole(slug) || isSlotType(slug)) continue;
    const card = await readRoleCard(workspaceRoot, slug);
    // 保留字闸已下沉到 readRoleCard 出口（08-28）—— 这里拿到的已是洗过的名字。
    if (card?.displayName) out.set(slug, card.displayName);
  }
  // 登记表（08-28 演员位重构的主源）：同 slug 时登记表赢 —— cast_role 是正门。
  // 登记表也是模型可写的（.nd 在工作区里），展示名同样只当展示层、过保留字闸。
  const reg = await readCastRegistry(workspaceRoot);
  for (const [slug, r] of Object.entries(reg.roles)) {
    if (!isResidentRole(slug) || isSlotType(slug)) continue;
    const label = safeRoleLabel(slug, r?.name);
    if (label) out.set(slug, label);
  }
  return out;
}
