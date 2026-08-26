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
import { isResidentRole, safeRoleLabel } from './cast.js';

const AGENTS_DIR = '.claude/agents';
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
    displayName: nameMatch ? nameMatch[1] : null,
    description: descPlain,
    toolsDecl: parseToolsDeclaration(fm),
  };
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
  let names;
  try { names = await fs.readdir(path.join(workspaceRoot, AGENTS_DIR)); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.md')) continue;
    const slug = n.slice(0, -3);
    if (!isResidentRole(slug)) continue;
    const card = await readRoleCard(workspaceRoot, slug);
    // ⭐ 保留字闸在**这里**过，不在各个渲染面各过一次：08-26 复审实证三个面里漏了一个，
    // 而漏的那个正是携带用户原话的标注回路。下沉之后漏传 roleNames 只会降级成显示 slug。
    if (card?.displayName) out.set(slug, safeRoleLabel(slug, card.displayName));
  }
  return out;
}
