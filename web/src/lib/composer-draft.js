/**
 * lib/composer-draft.js —— 把用户的原话放回输入框（09-17，问题库 iss_mtxylgs4_xmmz）
 *
 * 病：两个时刻用户的原话会从界面上消失，而且不会回来 ——
 *   ① 「回到此处」回退 / 分叉成功后前端重拉消息，那条气泡连同原文一起没了（jsonl 从它本身起截掉）；
 *   ② 发送被拒或网络失败：submit 时输入框已清空，乐观气泡只在内存，刷新即丢。
 * 治法：这两个时刻把原文放回输入框。
 *
 * 通道是 window 事件（跟 `nd:to-main-chat` 同一个习惯）：输入框埋在 ChatDock → ChatPanel 下面，
 * 而 ChatDock / 手机抽屉收起都不卸载，监听常在。事件是同步派发的，所以 `restoreToComposer`
 * 派发完就能从 detail 上读到输入框怎么处理的（outcome），调用方据此决定提示怎么写。
 *
 * 附件：发出去的那一刻本页记一份（rememberSent，按消息 uuid），回退时能原样放回托盘；
 * 刷新过页面就没有这份了（附件文件还在项目素材里，只是不自动回托盘）。
 */
import { t } from './i18n.js';

export const COMPOSER_RESTORE_EVENT = 'nd:composer-restore';

/**
 * mode：
 *   'ask'           回退：输入框有别的字时先问（覆盖 / 保留并接在后面）
 *   'fill-if-empty' 发送失败：输入框有别的字就不动，交给调用方给「一键放回」
 *   'append'        一键放回：有字就接在后面
 * outcome：'filled' 放进去了 | 'same' 输入框里已经是这段 | 'asked' 弹了确认 |
 *          'occupied' 有别的字、没动 | 'appended' 接在后面了 | null 没有输入框在听
 */
export function restoreToComposer(text, { mode = 'fill-if-empty', attachments = null } = {}) {
  const detail = { text: typeof text === 'string' ? text : '', mode, attachments, outcome: null };
  if (typeof window === 'undefined') return null;
  window.dispatchEvent(new CustomEvent(COMPOSER_RESTORE_EVENT, { detail }));
  return detail.outcome;
}

/** 输入框那头的决定（纯函数）：返回 { outcome, next }，next = 要写进输入框的字（不写为 null） */
export function planRestore(current, restored, mode) {
  const cur = typeof current === 'string' ? current : '';
  const text = typeof restored === 'string' ? restored : '';
  if (!text.trim()) return { outcome: 'same', next: null };
  if (!cur.trim()) return { outcome: 'filled', next: text };
  if (cur.trim() === text.trim()) return { outcome: 'same', next: null };
  if (mode === 'append') return { outcome: 'appended', next: joinDraft(cur, text) };
  if (mode === 'ask') return { outcome: 'asked', next: null };
  return { outcome: 'occupied', next: null };
}

/** 保留现有的字，原话接在后面（空一行隔开） */
export function joinDraft(current, restored) {
  const cur = String(current || '').replace(/\s+$/, '');
  return cur ? `${cur}\n\n${restored}` : restored;
}

/** 回退时问的那一句（覆盖 = true，保留 = false；关掉弹框也算保留，两边都不丢字） */
export function askReplaceDraft(confirm) {
  return confirm({
    title: t('输入框里已经有内容'),
    message: t('回退的那条消息原文要放回输入框。用原文覆盖现在的内容，还是保留现在的内容、把原文接在后面？'),
    confirmLabel: t('用原文覆盖'),
    cancelLabel: t('保留，原文接在后面'),
  });
}

// ── 发出去的原话与附件（本页内存）──
const SENT_KEEP = 30;
const sent = new Map();   // 消息 uuid → { text, attachments }

export function rememberSent(uuid, { text = '', attachments = [] } = {}) {
  if (!uuid) return;
  sent.delete(uuid);
  sent.set(uuid, {
    text: typeof text === 'string' ? text : '',
    // 预览用的 objectURL 发送成功后就被回收了，不带；托盘没有预览时显示文件名
    attachments: (Array.isArray(attachments) ? attachments : []).map(({ previewUrl: _p, ...a }) => a),
  });
  while (sent.size > SENT_KEEP) sent.delete(sent.keys().next().value);
}

export function recallSent(uuid) {
  return uuid ? sent.get(uuid) || null : null;
}

/**
 * 服务端拼进用户消息的机械块（turn-compose.js）。hydrate 回来的正文是所有文字块用空行连起来的，
 * 这些块排在用户的话后面（<system> 在前面）—— 放回输入框前要摘掉，不然再发一次就叠两份。
 */
const TAIL_MARKERS = [
  '[已直接附上 ',
  '可用素材（用 Read 工具读取',
  'Office 文档（**用 mcp__nodesign__read_document 读',
];
const ONLY_ATTACHMENT = '[用户只发了附件，没有附带文字。先看附件再问他想拿它做什么]';

/** 一条用户消息的原话：本页发过的用记下来的那份；hydrate 回来的从正文里摘 */
export function originalTextOf(message) {
  const kept = recallSent(message?.id);
  if (kept) return kept.text;
  let s = typeof message?.content === 'string' ? message.content : '';
  s = s.replace(/<system>[\s\S]*?<\/system>/g, '').replace(/<memory-recall\b[^>]*>[\s\S]*?<\/memory-recall>/g, '');
  let cut = s.length;
  for (const m of TAIL_MARKERS) {
    const at = s.startsWith(m) ? 0 : s.indexOf(`\n\n${m}`);
    if (at >= 0 && at < cut) cut = at;
  }
  s = s.slice(0, cut);
  if (s.trim() === ONLY_ATTACHMENT) return '';
  // 只发附件的乐观气泡（ProjectWorkspace 写的「（附件：…）」）不是用户打的字
  if (/^（附件：[^\n]*）$/.test(s.trim())) return '';
  return s.trim();
}

/**
 * 发送失败：放回原话，并给出那条提示的文案与按钮。
 * 输入框空着 → 直接放回；他已经在写下一句 → 不动他的字，提示里给「放回输入框」（接在后面）。
 * @returns {{ msg: string, opts: object|null }}  直接喂 showToast(msg, kind, opts)
 */
export function restoreAfterFailedSend(body, msg, { attachments = null } = {}) {
  const outcome = restoreToComposer(body, { mode: 'fill-if-empty', attachments });
  if (outcome === 'filled') return { msg: `${msg}${t('（原文已放回输入框）')}`, opts: null };
  if (outcome === 'occupied') {
    return {
      msg: `${msg}${t('（上一条没发出去）')}`,
      opts: { action: { label: t('放回输入框'), onClick: () => restoreToComposer(body, { mode: 'append' }) }, ttl: 15000 },
    };
  }
  return { msg, opts: null };
}
