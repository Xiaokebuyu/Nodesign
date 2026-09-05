/* ═══════════════════════════════════════════════════════════════
   显示器 —— 侧栏：人物 + 状态面板（2026-09-06 重写）

   一个人：大立绘 + 名字 + 一句话 + 属于他的状态 + 世界状态。
   几个人：此刻说话的人的立绘在上（跟着正文滚动换，story.js 报 ND.setSpeakers），名册在下。
   状态变化不重画整栏：只改数值、亮一下（flash）。停靠 / 收起的按钮在栏顶。
   ═══════════════════════════════════════════════════════════════ */
(() => {
  const ND = (window.ND = window.ND || {});
  const { esc, el } = ND.r;
  const store = ND.store;
  const $ = ND.$;
  const box = () => $('cast');
  let shownName = null;   // 立绘位上现在是谁

  const ICON = {
    flip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 16l-4-4 4-4M17 8l4 4-4 4M3 12h18"/></svg>',
    fold: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M9 4v16"/></svg>',
  };

  function initial(name) { return esc(String(name || '').slice(0, 1)); }

  function vitalHtml(v, S) {
    const val = S[v.key] ?? v.initial ?? '';
    const label = esc(v.label || v.key);
    if (v.as === 'bar') {
      const pct = Math.max(0, Math.min(100, (parseFloat(val) / (v.max || 100)) * 100)) || 0;
      return `<div class="vital bar-v" data-key="${esc(v.key)}"><div class="row"><span>${label}</span><b data-val>${esc(val)}<small>/ ${esc(v.max || 100)}</small></b></div><div class="bar"><i data-bar style="width:${pct}%"></i></div></div>`;
    }
    if (v.as === 'chips') return `<div class="vital chips-v" data-key="${esc(v.key)}"><div class="row"><span>${label}</span></div><div class="chips" data-chips>${(v.options || []).map((o) => `<span class="chip${String(o) === String(val) ? ' on' : ''}" data-opt="${esc(o)}">${esc(o)}</span>`).join('')}</div></div>`;
    if (v.as === 'num') return `<div class="vital" data-key="${esc(v.key)}"><div class="row"><span>${label}</span><b data-val>${esc(val)}${v.unit ? `<small>${esc(v.unit)}</small>` : ''}</b></div></div>`;
    return `<div class="vital text" data-key="${esc(v.key)}"><div class="row"><span>${label}</span><b data-val>${esc(val)}</b></div></div>`;
  }

  /** 状态面板分两截：属于某个人的（vitals.who）和世界的 */
  function vitalsHtml(cfg, S, who) {
    const mine = (cfg?.vitals || []).filter(v => (who ? v.who === who : !v.who));
    if (!mine.length) return '';
    return `<div class="section-hd">${who ? esc(who) : '此刻'}</div><div class="vitals">${mine.map(v => vitalHtml(v, S)).join('')}</div>`;
  }

  function portraitHtml(m, talking) {
    const img = m?.portrait ? `<img alt="" src="${esc(m.portrait)}">` : `<b>${initial(m?.name)}</b>`;
    return `<div class="portrait" data-who="${esc(m?.name || '')}">${img}${talking ? '<span class="tag talking">正在说话</span>' : ''}</div><div class="who"><h3>${esc(m?.name || '')}</h3><p>${esc(m?.note || '')}</p></div>`;
  }

  function paint() {
    const cfg = store.cfg; const cast = cfg?.cast || []; const S = store.state || {};
    const b = box(); if (!b) return;
    const tools = `<div class="cast-tools"><button class="icon-btn" data-act="flip" title="${ND.dock.side === 'right' ? '停到左边' : '停到右边'}">${ICON.flip}</button><button class="icon-btn" data-act="fold" title="${ND.dock.mode === 'mini' ? '展开' : '收成一条'}">${ICON.fold}</button></div>`;
    const earned = store.trophies.length; const total = store.rules.achievements.length;
    const foot = `<div class="foot"><span>第 <b>${esc(S['拍数'] || 0)}</b> 段</span>${total ? `<span>成就 <b>${earned} / ${total}</b></span>` : ''}${cfg?.lines?.length > 1 ? `<span>${esc((cfg.lines.find(l => l.id === cfg.currentLine) || {}).name || '主线')}</span>` : ''}</div>`;
    const mini = `<div class="mini-avatars">${cast.map(m => `<button class="av" data-who="${esc(m.name)}" title="${esc(m.name)}">${m.portrait ? `<img alt="" src="${esc(m.portrait)}">` : initial(m.name)}</button>`).join('')}</div>`;
    if (!cast.length) {
      b.innerHTML = `${tools}<div class="cast-scroll">${portraitHtml({ name: cfg?.title || '故事', note: '' }, false)}${vitalsHtml(cfg, S, null)}</div>${foot}`;
    } else if (cast.length === 1) {
      const m = cast[0];
      shownName = m.name;
      b.innerHTML = `${tools}${mini}<div class="cast-scroll">${portraitHtml(m, store.activeSpeakers.includes(m.name))}${vitalsHtml(cfg, S, m.name)}${vitalsHtml(cfg, S, null)}</div>${foot}`;
    } else {
      const active = cast.find(m => store.activeSpeakers.includes(m.name)) || cast.find(m => m.name === shownName) || cast[0];
      shownName = active.name;
      const on = new Set(store.activeSpeakers);
      b.innerHTML = `${tools}${mini}<div class="cast-scroll">${portraitHtml(active, on.has(active.name))}${vitalsHtml(cfg, S, active.name)}<div class="section-hd">在场 ${cast.length} 人</div><div class="roster">${cast.map((m) => `<button class="mate${on.has(m.name) ? ' on' : ''}" data-who="${esc(m.name)}" title="${esc(m.note || '')}"><span class="av">${m.portrait ? `<img alt="" src="${esc(m.portrait)}">` : initial(m.name)}</span><span><span class="nm">${esc(m.name)}</span><span class="du">${esc(m.note || '')}</span></span></button>`).join('')}</div>${vitalsHtml(cfg, S, null)}</div>${foot}`;
    }
    b.querySelector('[data-act=flip]').onclick = () => { ND.dock.flip(); paint(); };
    b.querySelector('[data-act=fold]').onclick = () => { ND.dock.toggle(); paint(); };
    b.querySelectorAll('.mate, .mini-avatars .av').forEach(x => { x.onclick = () => { shownName = x.dataset.who; store.activeSpeakers = [x.dataset.who]; paint(); if (ND.dock.mode === 'mini' && x.classList.contains('av')) { ND.dock.toggle(); paint(); } }; });
  }

  /** 状态变了：就地改数值，亮一下。键不在面板上的不管（状态页看全） */
  function paintVitals(changed) {
    const S = store.state || {};
    const b = box(); if (!b) return;
    const keys = changed ? Object.keys(changed) : (store.cfg?.vitals || []).map(v => v.key);
    for (const k of keys) {
      const node = b.querySelector(`.vital[data-key="${k.replace(/"/g, '\\"')}"]`);
      if (!node) continue;
      const v = ND.vitalOf(k) || {}; const val = S[k] ?? '';
      const vb = node.querySelector('[data-val]');
      if (vb) vb.innerHTML = `${esc(val)}${v.as === 'bar' ? `<small>/ ${esc(v.max || 100)}</small>` : (v.unit ? `<small>${esc(v.unit)}</small>` : '')}`;
      const bar = node.querySelector('[data-bar]');
      if (bar) bar.style.width = `${Math.max(0, Math.min(100, (parseFloat(val) / (v.max || 100)) * 100)) || 0}%`;
      node.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.opt === String(val)));
      node.classList.add('flash'); setTimeout(() => node.classList.remove('flash'), 1400);
    }
    const beats = b.querySelector('.foot b'); if (beats) beats.textContent = S['拍数'] || 0;
  }

  /** 脚注：段数 / 成就数（不整栏重画） */
  function paintFoot() {
    const f = box()?.querySelector('.foot'); if (!f) return;
    const S = store.state || {}; const earned = store.trophies.length; const total = store.rules.achievements.length;
    const cfg = store.cfg;
    f.innerHTML = `<span>第 <b>${esc(S['拍数'] || 0)}</b> 段</span>${total ? `<span>成就 <b>${earned} / ${total}</b></span>` : ''}${cfg?.lines?.length > 1 ? `<span>${esc((cfg.lines.find(l => l.id === cfg.currentLine) || {}).name || '主线')}</span>` : ''}`;
  }

  /** story.js 报：正文里此刻看着的那一段是谁在说 */
  ND.setSpeakers = (names, scene) => {
    const list = Array.isArray(names) ? names : [];
    const changed = list.join('|') !== store.activeSpeakers.join('|');
    store.activeSpeakers = list;
    if (scene !== undefined && scene !== store.activeScene) { store.activeScene = scene || ''; ND.paintTop(); }
    if (!changed) return;
    const cast = store.cfg?.cast || [];
    if (cast.length <= 1) {
      const tag = box()?.querySelector('.portrait');
      if (tag) { tag.querySelector('.tag')?.remove(); if (list.includes(cast[0]?.name)) tag.appendChild(el('<span class="tag talking">正在说话</span>')); }
      return;
    }
    const first = cast.find(m => list.includes(m.name));
    if (first && first.name !== shownName) { paint(); return; }   // 换人：重画立绘位
    const on = new Set(list);
    box()?.querySelectorAll('.mate').forEach(m => m.classList.toggle('on', on.has(m.dataset.who)));
    box()?.querySelectorAll('.mini-avatars .av').forEach(m => m.classList.toggle('on', on.has(m.dataset.who)));
    const tag = box()?.querySelector('.portrait');
    if (tag) { tag.querySelector('.tag')?.remove(); if (on.has(shownName)) tag.appendChild(el('<span class="tag talking">正在说话</span>')); }
  };

  ND.panel = {
    init() {
      ND.onEvent((e) => {
        if (e.type === 'hello' || e.type === 'config' || e.type === 'reload') { shownName = null; paint(); }
        else if (e.type === 'state') paintVitals(e.changed || null);
        else if (e.type === 'status' && e.state) paintVitals(null);
        else if (e.type === 'trophy' || e.type === 'scene') paintFoot();
      });
    },
    paint,
  };
})();
