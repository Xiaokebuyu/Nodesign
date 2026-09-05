/* ═══════════════════════════════════════════════════════════════
   显示器 —— 开场页 + 写法选择器（2026-09-06）

   故事还没开始时（记录为空、没点过开始），故事页让位给这一页：
   世界（设定里的 ## 世界）→ 在场的人（卡上的可选条目在这里勾）→ 写法（预设 + 模块）→ 开始。
   写法选择器（ND.stylePicker）设定页也用：故事进行中换写法，下一句话到时进程重开。
   ═══════════════════════════════════════════════════════════════ */
(() => {
  const ND = (window.ND = window.ND || {});
  const { esc, el, renderMd, mdSection } = ND.r;
  const store = ND.store; const api = ND.api;
  const CHEV = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

  /** 一套预设的默认勾选 */
  function defaults(preset) { const s = {}; for (const m of preset?.modules || []) s[m.id] = !!m.default; return s; }
  /** 整理成合法勾选：always 组全开，互斥组只留一个（跟服务端 normalizeSelection 同口径，服务端还会再整一次） */
  function normalize(preset, sel) {
    const groups = new Map((preset.groups || []).map(g => [g.id, g]));
    const out = { ...defaults(preset), ...(sel || {}) };
    const taken = new Set();
    for (const m of preset.modules) {
      const g = groups.get(m.group);
      if (g?.always) { out[m.id] = true; continue; }
      if (g?.exclusive && out[m.id]) { if (taken.has(g.id)) out[m.id] = false; else taken.add(g.id); }
      out[m.id] = !!out[m.id];
    }
    return out;
  }

  /**
   * 写法选择器。state = { preset: id, modules: {id: bool} }，每次变动调 onChange(state)。
   * presets 是 /presets 回的清单（没有正文）。上传的预设走 onUpload。
   */
  ND.stylePicker = function stylePicker(container, { presets, state, onChange, onUpload }) {
    const cur = () => presets.find(p => p.id === state.preset) || null;
    function paint() {
      const p = cur();
      container.innerHTML = `
        <div class="presets">
          ${presets.map(x => `<button class="preset${x.id === state.preset ? ' on' : ''}" data-p="${esc(x.id)}"><b>${esc(x.name)}</b><span>${esc(x.intro || '')}</span></button>`).join('')}
          <button class="preset${state.preset === 'none' ? ' on' : ''}" data-p="none"><b>不用预设</b><span>只按设定文件里的文风规矩写。</span></button>
          ${onUpload ? '<button class="preset upload" data-p="__upload"><b>上传自己的预设</b><span>酒馆（SillyTavern）的预设 JSON，或本平台导出的。条目会拆成下面这样的开关。</span></button>' : ''}
        </div>
        ${p ? `<p class="source">${esc(p.source || '')}</p>` : ''}
        <div class="modgroups" id="modgroups"></div>`;
      container.querySelectorAll('.preset').forEach(b => {
        b.onclick = async () => {
          if (b.dataset.p === '__upload') { await pickFile(); return; }
          state.preset = b.dataset.p;
          const np = cur(); state.modules = np ? defaults(np) : {};
          paint(); onChange(state);
        };
      });
      if (p) paintGroups(p);
    }
    function paintGroups(p) {
      const sel = state.modules = normalize(p, state.modules);
      const box = container.querySelector('#modgroups');
      const byGroup = new Map();
      for (const m of p.modules) { if (!byGroup.has(m.group)) byGroup.set(m.group, []); byGroup.get(m.group).push(m); }
      box.innerHTML = (p.groups || []).filter(g => byGroup.has(g.id)).map(g => {
        const mods = byGroup.get(g.id);
        const on = mods.filter(m => sel[m.id]).length;
        const open = ND.prefs.get(`grp:${p.id}:${g.id}`, g.exclusive ? 0 : 0);
        return `<div class="modgroup" data-g="${esc(g.id)}" data-open="${open}"><div class="ghd"><b>${esc(g.name)}</b>${g.hint ? `<span class="muted">${esc(g.hint)}</span>` : ''}<span class="n">${g.always ? '总是开' : (g.exclusive ? (mods.find(m => sel[m.id])?.name || '不选') : `${on} / ${mods.length}`)}</span>${CHEV}</div>
          <div class="gbody">${mods.map(m => `<label class="tog${g.always ? ' disabled' : ''}"><input type="${g.exclusive ? 'radio' : 'checkbox'}" name="g-${esc(g.id)}" data-m="${esc(m.id)}" ${sel[m.id] ? 'checked' : ''} ${g.always ? 'disabled' : ''}><span>${esc(m.name)}${m.hint ? `<small>${esc(m.hint)}</small>` : ''}</span></label>`).join('')}${g.exclusive && !g.always ? `<label class="tog"><input type="radio" name="g-${esc(g.id)}" data-none="1" ${on ? '' : 'checked'}><span>不选<small>这一组一条都不用</small></span></label>` : ''}</div></div>`;
      }).join('');
      box.querySelectorAll('.ghd').forEach(h => { h.onclick = () => { const g = h.parentElement; const v = g.dataset.open === '1' ? 0 : 1; g.dataset.open = String(v); ND.prefs.set(`grp:${p.id}:${g.dataset.g}`, v); }; });
      box.querySelectorAll('input').forEach(i => {
        i.onchange = () => {
          const g = i.closest('.modgroup').dataset.g;
          if (i.dataset.none) { for (const m of byGroup.get(g)) sel[m.id] = false; }
          else if (i.type === 'radio') { for (const m of byGroup.get(g)) sel[m.id] = m.id === i.dataset.m; }
          else sel[i.dataset.m] = i.checked;
          const open = {}; box.querySelectorAll('.modgroup').forEach(x => { open[x.dataset.g] = x.dataset.open; });
          paintGroups(p);
          box.querySelectorAll('.modgroup').forEach(x => { if (open[x.dataset.g] !== undefined) x.dataset.open = open[x.dataset.g]; });
          onChange(state);
        };
      });
    }
    async function pickFile() {
      const input = el('<input type="file" accept="application/json,.json" hidden>');
      document.body.appendChild(input);
      input.onchange = async () => {
        const f = input.files?.[0]; input.remove(); if (!f) return;
        try {
          const text = await f.text();
          const r = await api.uploadPreset(f.name, text);
          const res = await api.presets(); presets.splice(0, presets.length, ...res.presets);
          state.preset = r.id; state.modules = defaults(cur());
          paint(); onChange(state); ND.flash(`预设「${f.name.replace(/\.json$/i, '')}」拆好了${r.modules ? `，${r.modules} 个条目` : ''}`);
        } catch (err) { ND.flash(err.message, true); }
      };
      input.click();
    }
    if (onUpload) { /* 占位：上传由选择器自己处理 */ }
    paint();
    return { paint };
  };

  /**
   * 世界书开关。entries = /lore 回的触发条目；off = Set(关掉的名字)；每次变动调 onChange(off)。
   * 条目多（跑团卡几百条）就折起来只露数量，展开后一条一行：名字 + 触发词。
   */
  ND.lorePicker = function lorePicker(container, { entries, off, onChange, by }) {
    if (!entries?.length) { container.innerHTML = ''; return; }
    const paint = () => {
      const on = entries.filter(e => !off.has(e.name)).length;
      const open = ND.prefs.get('grp:lore', entries.length <= 12 ? 1 : 0);
      container.innerHTML = `<div class="modgroup lore" data-open="${open}"><div class="ghd"><b>世界书</b><span class="muted">对方写到相关的词时机器把这条送给它；关掉的不送</span><span class="n">${on} / ${entries.length}</span>${CHEV}</div>
        <div class="gbody">${by === 'agent' ? '<p class="source" style="color:var(--accent);margin:0 0 6px">有几条是 agent 按你开场前的回答关掉的，不合意就改。</p>' : ''}<div class="lorerow"><button class="btn sm" data-all="1">全开</button><button class="btn sm" data-all="0">全关</button></div>
        ${entries.map(e => `<label class="tog"><input type="checkbox" data-n="${esc(e.name)}" ${off.has(e.name) ? '' : 'checked'}><span>${esc(e.name)}<small>${esc(e.keys.slice(0, 8).join(' · '))}${e.keys.length > 8 ? ' …' : ''}</small></span></label>`).join('')}</div></div>`;
      container.querySelector('.ghd').onclick = () => { const g = container.firstElementChild; const v = g.dataset.open === '1' ? 0 : 1; g.dataset.open = String(v); ND.prefs.set('grp:lore', v); };
      container.querySelectorAll('input[data-n]').forEach(i => { i.onchange = () => { if (i.checked) off.delete(i.dataset.n); else off.add(i.dataset.n); container.querySelector('.n').textContent = `${entries.filter(e => !off.has(e.name)).length} / ${entries.length}`; onChange(off); }; });
      container.querySelectorAll('[data-all]').forEach(b => { b.onclick = () => { off.clear(); if (b.dataset.all === '0') for (const e of entries) off.add(e.name); paint(); onChange(off); }; });
    };
    paint();
  };

  /* ── 开场页 ── */
  ND.opening = {
    async mount(root) {
      const cfg = store.cfg; if (!cfg) { root.innerHTML = '<div class="empty">这里还没有故事。</div>'; return; }
      root.className = 'page';
      root.innerHTML = `<div class="opening"><div class="opening-inner">
        <div class="kicker">开始之前</div>
        <h1>${esc(cfg.title || '故事')}</h1>
        <p class="lede">看一眼这个世界和会遇到的人，挑一种写法，然后开始。写法和角色的可选条目之后在「设定」页还能改。</p>
        <div class="world md" id="world"><p class="muted">读取中…</p></div>
        <div class="kicker">在场的人</div>
        <div class="people" id="people"></div>
        <div id="lore"></div>
        <div class="kicker">写法</div>
        <p class="lede" style="margin-bottom:12px">对方按哪套规矩写。默认这套是从一份久经调试的中文预设拆出来的；也可以上传你自己的。展开每一组能看到具体条目。</p>
        ${cfg.style?.by === 'agent' ? '<p class="source" style="color:var(--accent)">下面的勾选是 agent 按你开场前的回答预选的，不合意就改，改了以你的为准。</p>' : ''}
        <div id="picker"></div>
        <div class="actions"><button class="btn primary big" id="go">开始</button><div class="note" id="openNote"></div></div>
      </div></div>`;
      const style = { preset: cfg.style?.preset || 'izumi', modules: cfg.style?.modules || null };
      const cardOptions = { ...(cfg.cardOptions || {}) };
      // 人物卡 + 可选条目
      const people = root.querySelector('#people');
      people.innerHTML = (cfg.cast || []).map(m => {
        const opts = store.castOptions?.[m.name] || [];
        return `<div class="person"><div class="pic">${m.portrait ? `<img alt="" src="${esc(m.portrait)}">` : `<b>${esc(String(m.name || '').slice(0, 1))}</b>`}</div><div class="txt"><h3>${esc(m.name)}</h3><p>${esc(m.note || '')}</p></div>
          ${opts.length ? `<div class="opts"><div class="lbl">由你决定</div>${opts.map(o => { const k = `${m.name}/${o.id}`; const on = cardOptions[k] === undefined ? !!o.default : !!cardOptions[k]; return `<label class="tog"><input type="checkbox" data-k="${esc(k)}" ${on ? 'checked' : ''}><span>${esc(o.label)}${o.desc ? `<small>${esc(o.desc)}</small>` : ''}</span></label>`; }).join('')}</div>` : ''}
        </div>`;
      }).join('') || '<p class="muted">还没有人物。</p>';
      people.querySelectorAll('input[data-k]').forEach(i => { i.onchange = () => { cardOptions[i.dataset.k] = i.checked; }; });
      // 世界
      try {
        const { text } = await api.readFile('台面.md');
        const world = (mdSection(text, '世界') || text.slice(0, 1200)).replace(/\{\{user\}\}/gi, '你').replace(/\{\{char\}\}/gi, '对方');   // 酒馆卡里的占位符别原样露给玩家
        root.querySelector('#world').innerHTML = renderMd(world) || '<p class="muted">设定里还没写世界。</p>';
      } catch { root.querySelector('#world').innerHTML = '<p class="muted">读不到设定。</p>'; }
      // 世界书开关（有触发条目才出现）
      const loreOff = new Set(cfg.lore?.off || []);
      try { const { entries } = await api.lore(); ND.lorePicker(root.querySelector('#lore'), { entries, off: loreOff, by: cfg.lore?.by, onChange: () => {} }); } catch { /* 没有世界书 */ }
      // 写法
      let presets = [];
      try { presets = (await api.presets()).presets; } catch { presets = []; }
      const picker = root.querySelector('#picker');
      if (picker) ND.stylePicker(picker, { presets, state: style, onChange: () => {}, onUpload: true });
      // 开始
      const go = root.querySelector('#go'); const note = root.querySelector('#openNote');
      go.onclick = async () => {
        go.disabled = true; note.textContent = '正在起进程、写开场…（第一段要等十几秒）'; note.className = 'note';
        try { await api.open({ style, cardOptions, lore: { off: [...loreOff] } }); }
        catch (err) { note.textContent = `没开起来：${err.message}`; note.className = 'note err'; go.disabled = false; }
      };
    },
  };
})();
