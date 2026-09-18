/**
 * server/lib/err-text.js —— 错误对象 → 一句带原因的话（2026-09-18）
 *
 * Node 自带的 fetch（undici）网络失败只抛一句 "fetch failed"，真正的原因（ECONNRESET、证书、DNS、
 * 对端关连接）在 err.cause 里。原来各处只取 err.message，agent 拿到的整条失败正文就是
 * 「web_search error: fetch failed」，看不出是断网、被墙还是对方挂了（09-18 调查，
 * ~/claude-report-file/0918-tool-errors/）。runtime/components-fetch.js 早就这么取，这里收成一处。
 */

/** @returns {string} message，cause 里有别的信息就括号带上 */
export function errText(err) {
  if (err == null) return 'unknown error';
  if (typeof err !== 'object') return String(err);
  const msg = err.message || String(err);
  const c = err.cause;
  if (!c) return msg;
  const cm = typeof c === 'object' ? (c.message || '') : String(c);
  const cause = typeof c === 'object' && c.code && !cm.includes(c.code) ? `${c.code}${cm ? ` ${cm}` : ''}` : cm;
  return cause && !msg.includes(cause) ? `${msg}（${cause}）` : msg;
}

/**
 * 长报错留头留尾，中间省略（09-18）。子进程的报错原来一律只取结尾：paint_still 返回过
 * 「生成失败 exit 1：nput_name": "clip_name", …」，ComfyUI 报错的开头（哪个节点、什么错）被切掉了。
 */
export function headTail(s, head = 300, tail = 500) {
  const t = String(s ?? '');
  if (t.length <= head + tail + 20) return t;
  return `${t.slice(0, head)}\n…（中间省略 ${t.length - head - tail} 字）…\n${t.slice(-tail)}`;
}

/** 子进程输出的缓冲：开头留 head 字、结尾滚动留 tail 字（原来 `(err + d).slice(-N)` 只留结尾） */
export function headTailBuffer(head = 1000, tail = 2000) {
  let h = ''; let t = ''; let dropped = 0;
  return {
    push(d) {
      let s = String(d);
      if (h.length < head) { const n = head - h.length; h += s.slice(0, n); s = s.slice(n); }
      const all = t + s;
      dropped += Math.max(0, all.length - tail);
      t = all.slice(-tail);
    },
    text() { return dropped ? `${h}\n…（中间省略 ${dropped} 字）…\n${t}` : h + t; },
  };
}
