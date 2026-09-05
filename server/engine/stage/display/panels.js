/* ═══════════════════════════════════════════════════════════════
   显示器 —— 面板页（2026-09-06）：背包 / 装备 / 商店 / 清单，一块面板一页

   面板由 open_stage 声明、演出进程 update_panel 记账、玩家在这里点"买 / 用 / 装上"（POST panel，同一条账）。
   页是**按 hello 里的 panels 动态注册**的：顶栏多几个页签，故事页选项上方多一行快捷入口，
   面板页顶上有「回到故事」（入口必须同时是出口）。
   ═══════════════════════════════════════════════════════════════ */
(() => {
  const ND = (window.ND = window.ND || {});
  const { esc, el } = ND.r;
  const store = ND.store; const api = ND.api;
  const KN = { inventory: '背包', equipment: '装备', shop: '商店', list: '清单' };
  const registered = new Set();

  ND.panelPages = () => Object.values(store.panels || {}).map(p => ({ id: `panel:${p.id}`, label: p.name, kind: p.kind }));

  /** hello 到了：把还没注册的面板注册成页，重画顶栏页签 */
  ND.registerPanelPages = function registerPanelPages() {
    let added = false;
    for (const p of Object.values(store.panels || {})) {
      const id = `panel:${p.id}`;
      if (registered.has(id)) continue;
      registered.add(id); added = true;
      ND.page({
        id, label: p.name, panelId: p.id,
        mount(root) { root.className = 'page scroll'; this.root = root; this.paint(); },
        paint() { paintPanel(this.root, store.panels?.[p.id]); },
        update(what) { if (what.type === 'panel' || what.type === 'hello' || what.type === 'state') this.paint(); },
      });
    }
    if (added) ND.paintNav();
  };

  async function act(op, note) {
    try { const r = await api.json('POST', 'panel', op); ND.flash(r.change || note || '好了'); }
    catch (err) { ND.flash(err.message, true); }
  }

  function itemCard(p, it, S) {
    const tags = (it.tags || []).map(t => `<span class="chip">${esc(t)}</span>`).join('');
    const price = it.price !== undefined ? `<span class="price">${esc(it.price)}${p.currency ? ` ${esc(p.currency)}` : ''}</span>` : '';
    let actions = '';
    if (p.kind === 'shop') {
      const have = p.currency ? Number(S[p.currency]) : null;
      const can = have === null || !Number.isFinite(have) || have >= (it.price || 0);
      actions = `<button class="btn sm primary" data-op="buy" data-item="${esc(it.name)}" ${can ? '' : 'disabled title="钱不够"'}>买</button>`;
    } else if (p.kind === 'equipment') {
      actions = it.equipped ? `<button class="btn sm" data-op="unequip" data-item="${esc(it.name)}">脱下</button>` : `<button class="btn sm" data-op="equip" data-item="${esc(it.name)}">装上</button>`;
    } else if (p.kind === 'inventory') {
      actions = `<button class="btn sm" data-op="remove" data-qty="1" data-item="${esc(it.name)}" title="用掉一个">用一个</button>`;
    }
    return `<div class="item${it.equipped ? ' on' : ''}"><div class="it-hd"><b>${esc(it.name)}</b>${it.qty > 1 || p.kind === 'shop' ? `<span class="qty">×${esc(it.qty)}</span>` : ''}${price}</div>${it.note ? `<p>${esc(it.note)}</p>` : ''}${tags ? `<div class="chips">${tags}</div>` : ''}${it.slot ? `<span class="slot">${esc(it.slot)}</span>` : ''}<div class="it-act">${actions}</div></div>`;
  }

  function paintPanel(root, p) {
    if (!p) { root.innerHTML = '<div class="empty">这块面板没了。</div>'; return; }
    const S = store.state || {};
    let body = '';
    if (p.kind === 'equipment') {
      const slots = p.slots || [];
      const worn = (slot) => p.items.find(x => x.equipped && x.slot === slot);
      body = `<div class="slots">${slots.map(sl => { const w = worn(sl); return `<div class="slotbox${w ? ' on' : ''}"><span class="lbl">${esc(sl)}</span>${w ? `<b>${esc(w.name)}</b>${w.note ? `<p>${esc(w.note)}</p>` : ''}<button class="btn sm" data-op="unequip" data-item="${esc(w.name)}">脱下</button>` : '<span class="muted">空</span>'}</div>`; }).join('')}</div>
        <div class="section-hd" style="padding:18px 0 8px">没穿在身上的</div>
        <div class="items">${p.items.filter(x => !x.equipped).map(it => itemCard(p, it, S)).join('') || '<p class="muted">没有</p>'}</div>`;
    } else {
      body = `<div class="items">${p.items.map(it => itemCard(p, it, S)).join('') || `<p class="muted">${p.kind === 'shop' ? '货架空着。' : '空的。'}</p>`}</div>`;
    }
    const money = p.kind === 'shop' && p.currency ? `<span class="pill">${esc(p.currency)} ${esc(S[p.currency] ?? '?')}</span>` : '';
    root.innerHTML = `<div class="page-inner panelpage"><h2><button class="btn sm" data-back>‹ 回到故事</button>${esc(p.name)}<small>${esc(KN[p.kind] || p.kind)}${p.who ? ` · ${esc(p.who)}` : ''} · ${p.items.length} 项</small><span class="tools">${money}</span></h2>${body}
      <p class="muted" style="margin-top:14px">你在这里改的，对方下一句会知道；对方在故事里给你的、拿走的，会自己记到这儿。</p></div>`;
    root.querySelector('[data-back]').onclick = () => ND.show('story');
    root.querySelectorAll('[data-op]').forEach(b => { b.onclick = () => act({ panel: p.id, op: b.dataset.op, item: b.dataset.item, ...(b.dataset.qty ? { qty: Number(b.dataset.qty) } : {}) }); });
  }

  /* 故事页选项上方的快捷入口（story.js 在 paintHandles 时调） */
  ND.panelChips = function panelChips() {
    const pages = ND.panelPages();
    if (!pages.length) return '';
    return `<div class="panel-chips">${pages.map(p => `<button class="chip-btn" data-page="${esc(p.id)}"><span class="k">${esc(KN[p.kind] || '')}</span>${esc(p.label)}</button>`).join('')}</div>`;
  };

  ND.onEvent((e) => {
    if (e.type === 'hello') { store.panels = e.panels || {}; ND.registerPanelPages(); }
    else if (e.type === 'panel') { store.panels = e.panels || store.panels; if (e.by === 'stage' && e.change && !ND.EMBED) ND.flash(e.change); }
  });
})();
