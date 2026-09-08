/**
 * 一条 user message 的组装（2026-08-17 从 turn.js 拆出 —— 行数棘轮，
 * turn.js 是路由层，"chat + 附件怎么变成 SDK content blocks"是独立的一件事，
 * 拆之前它占了那个文件的六分之一）。
 *
 * 对外只有 composeUserMessage 一个出口；inline 图那段是它的私事。
 */
import { promises as fs } from 'fs';
import path from 'path';
import { safeResolveRead } from '../lib/safe-path.js';
import { isExtractable } from '../lib/doc-extract.js';

/** 直接 image input 阈值：> 1MB 走 path 让 agent Read，< 1MB inline base64 */
const IMAGE_INLINE_MAX_BYTES = 1 * 1024 * 1024;
/** Anthropic API 支持的 image media types（sdk-tools.d.ts:150 + API doc） */
const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * 把 chat 文本 + attachments 拼成 SDK content blocks 数组。
 *
 * 返回：
 *   - displayText: 用于 createRun 审计 + run.error 时前端显示 fallback
 *   - blocks: BetaContentBlockParam[]（喂 SDK 的 user message content）
 *
 * 策略：
 *   - **小图（< 1MB） inline base64** → user message 顶层 image content block，
 *     agent 一上来就能 vision 看见参考图，不用先 Read。Kimi vision 通过
 *     binary-fixup-proxy 已验证（lift transform 仅处理 tool_result 嵌套；
 *     user message 顶层 image 直接走标准路径，无需 lift）。
 *   - **大图（>= 1MB）/ 非 image / 文档** → 文本路径让 agent Read（避免大文件
 *     爆 user message token，配合 prelude 的"开工前必看 ./assets/"硬规则）
 *   - **anchor / comment 类型** → 文本描述
 *
 * Anthropic image content block 仅支持 jpeg/png/gif/webp，不支持 svg/heic 等。
 * 不在白名单的 image mime → 按文本路径降级。
 */
/**
 * @param {string|{desk:string,cwd:string}} roots  旧签名是 sessionRoot 一个字符串（cwd = 桌面）；
 *   09-08 起可以分开给：desk = 桌面（上传件真住的地方，getWorkspaceRoot），cwd = agent 站的地方（getAgentCwd）。
 *   仓库项目里两者不同：内联要按 desk 找文件，写给 agent 的路径要从 cwd 出发才 Read 得到。
 */
export async function composeUserMessage(chat, attachments, pendingSummary, roots) {
  const deskRoot = typeof roots === 'string' ? roots : roots.desk;
  const cwdRoot = typeof roots === 'string' ? roots : (roots.cwd || roots.desk);
  const sessionRoot = deskRoot;
  /** 去掉老前缀后的桌面相对路径 */
  const deskRel = (p) => String(p || '').replace(/^(?:\.\.\/)+shared\//, '');
  /** 给 Read 用：从 cwd 出发的路径；两个根不同时直接给绝对路径，不让 agent 算 */
  const forRead = (p) => (deskRoot === cwdRoot ? deskRel(p) : path.join(deskRoot, deskRel(p)));
  const blocks = [];

  // C4：用户在过去时段做的 direct edit + comment → prepend system 提示
  // 不灌详情（让 agent 主动调 mcp__nodesign__get_pending_changes 拉），省 token
  if (pendingSummary && pendingSummary.count > 0) {
    blocks.push({
      type: 'text',
      text: `<system>${pendingSummary.summary}。可调 mcp__nodesign__get_pending_changes 查看详情；处理完调 mcp__nodesign__clear_pending_changes 清 buffer。</system>`,
    });
  }

  // （素材摘要 08-21 搬去 hooks/user-prompt-submit.js 的状态块：首轮全量、之后只报变化；
  //   这里不再拼进用户消息 —— 两条线两个真相源的病，顺手把"assets 是 symlink"那句假话删了。）

  // 空文字块会被 API 直接判 400（text content block 不许为空），所以只发附件的
  // 那条消息这里不能盲推。改成一句交代处境的话 —— agent 得知道"用户没说话"是
  // 事实本身，而不是以为上下文丢了。
  if (chat && chat.trim()) {
    blocks.push({ type: 'text', text: chat });
  } else {
    blocks.push({ type: 'text', text: '[用户只发了附件，没有附带文字。先看附件再问他想拿它做什么]' });
  }

  if (Array.isArray(attachments) && attachments.length > 0) {
    // 先尝试给 image attachment inline base64；inline 失败的当 path 走文本路径
    const inlineImageNames = [];
    const fallbackLines = [];
    // Office 三件套单独一队：**普通 Read 读它们只会拿到二进制乱码而且不报错**，
    // 底下那句"用 Read 读取"对这几种是错的指路，agent 会拿着空气往下干
    const docLines = [];

    for (const a of attachments) {
      if (!a || typeof a !== 'object') continue;
      if (a.type === 'anchor') {
        fallbackLines.push(`- 选中元素: page=${a.pageIndex} ${a.tag || 'element'} ${a.text ? `"${a.text}"` : ''}`);
        continue;
      }
      if (a.type === 'comment') {
        fallbackLines.push(`- 评论: ${a.text} (anchor: ${JSON.stringify(a.anchor || {})})`);
        continue;
      }
      // asset 路径分支（assets API 返回 path 形如 '../../shared/assets/<name>'）
      if (!a.path) continue;
      const inline = await tryInlineImageAttachment(a, sessionRoot);
      if (inline) {
        blocks.push(inline);
        inlineImageNames.push(a.name || path.basename(a.path));
      } else if (isExtractable(a.path)) {
        // read_document 是画布工具，收的是相对桌面的路径
        docLines.push(`- ${deskRel(a.path)}${a.name ? `（${a.name}）` : ''}`);
      } else {
        fallbackLines.push(`- ${forRead(a.path)}${a.name ? `（${a.name}）` : ''}`);
      }
    }

    if (inlineImageNames.length > 0) {
      blocks.push({
        type: 'text',
        text: `[已直接附上 ${inlineImageNames.length} 张参考图：${inlineImageNames.join('、')} —— 你可以直接 vision 看，不需要再 Read]`,
      });
    }
    if (fallbackLines.length > 0) {
      blocks.push({
        type: 'text',
        text: `可用素材（用 Read 工具读取${deskRoot === cwdRoot ? '，路径相对 cwd' : '，给的是绝对路径'}）：\n${fallbackLines.join('\n')}`,
      });
    }
    if (docLines.length > 0) {
      blocks.push({
        type: 'text',
        text: `Office 文档（**用 mcp__nodesign__read_document 读，不要用 Read** ——`
          + ` 这几种是 zip 包，Read 会返回二进制且不报错）：\n${docLines.join('\n')}`,
      });
    }
  }

  // （comment 附件的「改前回看 design-plan / spec.json」提醒 08-21 删：plan 模式整体移除，两个文件都没人再写；评论怎么处理 prelude § DirectEdit 已讲）

  // displayText：合并 blocks 用 \n\n，给 DB 审计 / fallback 显示用
  // image block 用占位文本而非 base64（base64 进 DB / 前端 fallback 都没意义）
  const displayText = blocks.map((b) => {
    if (b.type === 'image') return '[image]';
    return b.text || `[${b.type}]`;
  }).join('\n\n');

  return { displayText, blocks };
}

/**
 * 尝试把 attachment 直接读成 image content block。
 * 失败（不是 image / 太大 / 读取失败 / mime 不在白名单）返 null，让调用方
 * 走 path 字符串 fallback。
 *
 * @param {object} attachment - { path, name?, mime?, size? }
 * @param {string} sessionRoot - 绝对路径，sessions/<sid>/
 * @returns {Promise<null | { type: 'image', source: { type: 'base64', media_type, data } }>}
 */
async function tryInlineImageAttachment(attachment, sessionRoot) {
  const mime = attachment.mime;
  if (!mime || !IMAGE_MEDIA_TYPES.has(mime)) return null;

  // ⛔ 上面这段注释原来写着"并校验解析后仍在 project workspace 内（防 path traversal）"
  // —— **代码里根本没有这个校验**。真攻过（2026-08-18）：
  //   path: '../../<别人的 pid>/shared/.../x.png' → 别的用户的图被 base64 塞进
  //   我这轮的 context（多租户隔离直接破）；
  //   path: '../../../../.env'                   → 服务端 .env 原文进 context
  //   （解出来第一行就是 "# === Nodesign 服务端环境变量 ==="）。
  // 判据用仓库里已有的那一份 safeResolveRead（realpath 复核，软链也拦）。
  //
  // ⚠️ 顺带修一个**静默坏了很久**的东西：assets API 至今返回
  // `../../shared/assets/<name>`，那是扁平化之前 `sessions/<sid>/` 时代的相对路径。
  // 扁平化后 sessionRoot 就是 `<pid>/shared`，它解析到 `projects-data/shared/...`
  // （不存在）→ stat 失败 → **静默不内联**，agent 只拿到一行文字而不是图。
  // 实测：`../../shared/assets/x.png` MISSING、`assets/x.png` INLINED。
  // 在这儿把老前缀剥掉（跟 artifact-file 那条 `tasks/` 兼容同一个思路）。
  const relRaw = String(attachment.path || '').replace(/^(?:\.\.\/)+shared\//, '');
  const absPath = await safeResolveRead(sessionRoot, relRaw);
  if (!absPath) return null;

  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size > IMAGE_INLINE_MAX_BYTES) return null;

  let buf;
  try {
    buf = await fs.readFile(absPath);
  } catch {
    return null;
  }

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mime,
      data: buf.toString('base64'),
    },
  };
}
