/** 通用工具函数 */

import { t } from './i18n.js';

export function classNames(...args) {
  return args.filter(Boolean).join(' ');
}

/**
 * 这次 Enter 是不是输入法在选词，而不是用户想提交。
 * 中文/日文输入法里按 Enter 确认候选词时，浏览器照样派发 keydown Enter，
 * 不判这个就会把编辑到一半的整条消息发出去。isComposing 覆盖 Chrome/Firefox；
 * Safari 在结束组合的那次 keydown 里 isComposing 已经是 false 但 keyCode
 * 还是 229，所以两个都要看。React 合成事件和原生事件都能直接传进来。
 */
export function isImeEnter(e) {
  const ev = e.nativeEvent ?? e;
  return ev.isComposing || ev.keyCode === 229;
}

export function newId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 用户消息的 id —— 必须是 SDK uuid 形态（36-char），不能是 newId('msg')。
 *
 * 这条气泡的 id 不只是 React key：服务端把它盖到 SDKUserMessage.uuid 上，CLI 原样
 * 写进 jsonl，于是「回到此处」（rewindFiles）和「从这里分叉」（fork 的 upToMessageId）
 * 认的就是它。用 `msg_xxx` 的年代里这两个按钮的 uuid 判据一律不认乐观气泡，**得刷新
 * 页面**等 hydrate 从 jsonl 读回真 uuid 才出现（2026-08-30 修）。
 *
 * crypto.randomUUID 需要安全上下文（https / localhost）；退化路径手拼一个同形 v4，
 * 服务端只校验形状，来源不重要。
 */
export function newUserMessageId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(Math.random() * 4)]}${hex(3)}-${hex(12)}`;
}

/**
 * 时间戳 → Date。SQLite 的 `datetime('now')` 落的是 **UTC 但不带时区标记**的
 * "YYYY-MM-DD HH:MM:SS"，JS 按规范会把这种格式当**本地时间**解析——东八区就凭空
 * 差 8 小时（实测项目卡片上 6 小时前的东西显示成"14 小时前"，新建的东西因为落在
 * 未来一直显示"刚刚"）。这里显式补 'Z' 按 UTC 解。带 T / 带时区的 ISO 串原样走。
 */
function parseStamp(value) {
  if (!value) return null;
  const s = String(value);
  const naiveSqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s);
  const d = new Date(naiveSqlite ? `${s.replace(' ', 'T')}Z` : s);
  return isNaN(d.getTime()) ? null : d;
}

/** ISO → "YYYY-MM-DD" */
export function formatDate(iso) {
  const d = parseStamp(iso);
  if (!d) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** ISO → "M/D HH:MM"（画布卡片上的短时间戳） */
export function formatClock(iso) {
  const d = parseStamp(iso);
  if (!d) return '';
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * "刚刚" / "X 分钟前" / "X 小时前" / "X 天前"，超过 30 天走 formatDate。
 *
 * 2026-08-29 包 t()：这个函数的输出印在首页每张卡、橱窗每张卡、会话列表和控制台上
 * （8 个文件在调），英文界面里它是最扎眼的一处中文。英文的单复数走
 * `{ one, other }` + count，中文不受影响（zh-CN 没词表，t 恒等）。
 * 30 天以上落 formatDate 的 `2026-08-29`，那是数字格式，两种语言通用。
 */
export function timeAgo(iso) {
  const at = parseStamp(iso);
  if (!at) return '';
  const ms = Date.now() - at.getTime();
  if (isNaN(ms)) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return t('刚刚');
  if (m < 60) return t('{n} 分钟前', { n: m, count: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('{n} 小时前', { n: h, count: h });
  const d = Math.floor(h / 24);
  if (d < 30) return t('{n} 天前', { n: d, count: d });
  return formatDate(iso);
}

/** 安全 JSON parse，失败返回 fallback */
export function safeJsonParse(s, fallback = null) {
  try { return JSON.parse(s); } catch { return fallback; }
}

/** 文件大小人话：123 → "123 B" / "1.2 KB" / "3.4 MB" */
export function formatSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
