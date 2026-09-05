/* ═══════════════════════════════════════════════════════════════
   显示器 —— 渲染小工具（2026-09-06 重写）
   纯函数：转义 / 正文成分识别 / 极简 markdown / 规则条件翻成人话 / 时间与数字格式。
   所有页面共用，挂在 window.ND.r 上。不碰 DOM 状态。
   ═══════════════════════════════════════════════════════════════ */
(() => {
  const ND = (window.ND = window.ND || {});
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = String(html).trim(); return t.content.firstElementChild; };
  const fmtK = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)}万` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));
  const fmtTime = (iso) => { try { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; } catch { return ''; } };

  /** 一段正文 → 段落数组（按空行切；单换行留在段内） */
  function paragraphs(text) {
    return String(text || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  }
  /** 一个段落的成分识别：引号里的话着色、*心理* 斜体、`code`。agent 照旧写整段散文，成分识别归显示器 */
  function inlineProse(p) {
    return esc(p)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/&quot;([^&]*?)&quot;/g, '<q>“$1”</q>')
      .replace(/“([^”]*)”/g, '<q>“$1”</q>')
      .replace(/(「[^」]*」)/g, '<q>$1</q>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');
  }
  function renderProse(text) {
    return paragraphs(text).map(p => `<p>${inlineProse(p)}</p>`).join('');
  }

  /* 极简 markdown：标题 / 列表 / 粗体 / 行内代码 / 段落 / 分隔线（人设与设定预览用；不求全）。frontmatter 与 HTML 注释剥掉 */
  function renderMd(text) {
    const lines = String(text || '').replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/<!--[\s\S]*?-->/g, '').split('\n');
    const out = []; let list = null; let para = [];
    const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
    const flushP = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
    const flushL = () => { if (list) { out.push(`<ul>${list.map(i => `<li>${inline(i)}</li>`).join('')}</ul>`); list = null; } };
    for (const raw of lines) {
      const l = raw.trimEnd();
      const h = /^(#{1,3})\s+(.*)$/.exec(l);
      if (h) { flushP(); flushL(); out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); continue; }
      const li = /^\s*[-*]\s+(.*)$/.exec(l);
      if (li) { flushP(); (list ||= []).push(li[1]); continue; }
      if (!l.trim()) { flushP(); flushL(); continue; }
      if (/^---+$/.test(l.trim())) { flushP(); flushL(); out.push('<hr>'); continue; }
      flushL(); para.push(l.trim());
    }
    flushP(); flushL();
    return out.join('');
  }

  /** 设定文件里某一节（## 世界）的正文 */
  function mdSection(text, title) {
    const m = new RegExp(`^##\\s*${title}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|(?![\\s\\S]))`, 'm').exec(String(text || ''));
    return m ? m[1].trim() : '';
  }

  /** 规则条件翻成人话：好感 >= 60 and 表白状态 == 1 → 好感 ≥ 60，且 表白状态 是 1 */
  function humanCondition(when) {
    return String(when || '')
      .replace(/\s+(and|且|&&)\s+/gi, ' ，且 ').replace(/\s+(or|或|\|\|)\s+/gi, ' ，或 ')
      .replace(/>=|≥/g, '≥').replace(/<=|≤/g, '≤').replace(/==/g, '是').replace(/!=/g, '不是')
      .replace(/\s+/g, ' ').replace(/ ，/g, '，').trim();
  }

  const CUP = { bronze: '铜', silver: '银', gold: '金', platinum: '白金' };
  const cupSvg = (tier) => `<svg class="cup ${esc(tier || 'bronze')}" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M7 3h10v3h3v3a4 4 0 0 1-4 4h-.3A5 5 0 0 1 13 16.9V19h3v2H8v-2h3v-2.1A5 5 0 0 1 8.3 13H8a4 4 0 0 1-4-4V6h3V3zm10 5v3a2 2 0 0 0 2-2V8h-2zM7 8H5v1a2 2 0 0 0 2 2V8z" fill="currentColor"/></svg>`;

  ND.r = { esc, el, fmtK, fmtTime, paragraphs, inlineProse, renderProse, renderMd, mdSection, humanCondition, CUP, cupSvg };
})();
