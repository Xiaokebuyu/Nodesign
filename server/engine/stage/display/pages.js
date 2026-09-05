/* ═══════════════════════════════════════════════════════════════
   显示器 —— 角色 / 记忆 / 设定 / 状态 四页（2026-09-06 重写）
   规则不再直接给 JSON：成就画成奖杯卡、推进画成"当 … 时"的条子，条件翻成人话；要改原文才开编辑器。
   ═══════════════════════════════════════════════════════════════ */
(() => {
  const ND = (window.ND = window.ND || {});
  const { esc, el, fmtK, renderMd, humanCondition, cupSvg, CUP } = ND.r;
  const store = ND.store; const api = ND.api;

  /* 内嵌编辑器：读 → 改 → 保存（PUT file） */
  function editor(card, rel, text, onSaved) {
    const body = card.querySelector('.body');
    const tools = card.querySelector('.tools') || card.querySelector('h3').appendChild(el('<span class="tools"></span>'));
    tools.innerHTML = '<button class="btn primary sm" data-save>保存</button><button class="btn sm" data-cancel>取消</button>';
    const ta = el('<textarea class="editor"></textarea>'); ta.value = text;
    body.replaceChildren(ta);
    const back = (msg) => { tools.innerHTML = `${msg ? `<span class="muted">${esc(msg)}</span>` : ''}<button class="btn sm" data-act="edit">编辑</button>`; tools.querySelector('[data-act=edit]').onclick = () => editor(card, rel, text, onSaved); };
    tools.querySelector('[data-cancel]').onclick = () => { onSaved(text); back(''); };
    tools.querySelector('[data-save]').onclick = async () => {
      try { const r = await api.saveFile(rel, ta.value); text = ta.value; onSaved(text); back(r.reopenOnNextLine ? '已保存 · 下一句话到时对方会按新的来' : '已保存'); }
      catch (err) { ND.flash(`没存上：${err.message}`, true); }
    };
  }
  ND.editor = editor;
  const relOf = (wsRel) => (wsRel ? wsRel.replace(new RegExp(`^${(store.cfg?.root || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`), '') : null);
  const condHtml = (when) => humanCondition(when).split(/，(且|或)\s*/).map(s => (s === '且' || s === '或' ? `<span class="and">${s}</span>` : `<i>${esc(s)}</i>`)).join('');

  /* ── 角色：一格一人，点开才看详情（站主 09-06：别一开始就全展开）── */
  ND.page({
    id: 'cast', label: '角色',
    mount(root) { root.className = 'page scroll'; this.root = root; this.open = null; this.paint(); },
    async paint() {
      const cfg = store.cfg || {}; const cast = cfg.cast || []; const S = store.state || {};
      const r = this.root;
      r.innerHTML = `<div class="page-inner castwrap" id="castwrap" data-open="${this.open ? 1 : 0}"><h2>登场的人<small>${cast.length} 位 · 点一位看设定与记忆</small><span class="tools"><button class="btn sm" id="castFold" ${this.open ? '' : 'hidden'}>收起详情</button></span></h2><div class="castcols"><div class="people wide" id="people"></div><div id="detail" class="detail-col"></div></div></div>`;
      r.querySelector('#castFold').onclick = () => this.close();
      const people = r.querySelector('#people');
      if (!cast.length) { people.innerHTML = '<p class="muted">还没有人。让 agent 用 cast_role 写卡、open_stage 建故事。</p>'; return; }
      let files = [];
      try { files = (await api.files()).files; } catch { files = []; }
      this.files = files;
      for (const m of cast) {
        const mine = (cfg.vitals || []).filter(v => v.who === m.name);
        const home = relOf(m.card)?.replace(/\/角色卡\.md$/, '');
        const memCount = home ? files.filter(f => f.rel.startsWith(`${home}/记忆/`)).length : 0;
        const spoke = [...store.scenes].reverse().find(x => x.by === 'stage' && (x.speakers || []).includes(m.name));
        const spokeIdx = spoke ? store.scenes.filter(x => x.by === 'stage').indexOf(spoke) + 1 : 0;
        const talking = store.activeSpeakers.includes(m.name);
        const card = el(`<button class="person${this.open === m.name ? ' on' : ''}" data-who="${esc(m.name)}"><div class="pic">${m.portrait ? `<img alt="" src="${esc(m.portrait)}">` : `<b>${esc(String(m.name || '').slice(0, 1))}</b>`}${talking ? '<span class="talk">正在说话</span>' : ''}</div>
          <div class="txt"><h3>${esc(m.name)}</h3><p>${esc(m.note || '')}</p></div>
          ${mine.length ? `<div class="stats">${mine.map(v => { const val = S[v.key] ?? v.initial ?? ''; const pct = v.as === 'bar' ? Math.max(0, Math.min(100, (parseFloat(val) / (v.max || 100)) * 100)) || 0 : null; return `<div class="vital"><div class="row"><span>${esc(v.label || v.key)}</span><b>${esc(val)}${v.as === 'bar' ? `<small>/ ${esc(v.max || 100)}</small>` : ''}</b></div>${pct !== null ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}</div>`; }).join('')}</div>` : ''}
          <div class="foot"><span>${spokeIdx ? `最近开口：第 ${spokeIdx} 段` : '还没开口'}</span><span>记忆 ${memCount} 条</span><span class="tools muted">看详情 ›</span></div></button>`);
        people.appendChild(card);
        card.onclick = () => (this.open === m.name ? this.close() : this.show(m));   // 再点一下选中的卡 = 收起
      }
      if (this.open) { const m = cast.find(x => x.name === this.open); if (m) this.show(m); }
    },
    /** FLIP：先记每张卡在哪，改布局，再从旧位置动画到新位置（卡"丝滑地挪到最左侧 / 归位"） */
    flip(change) {
      const cards = [...this.root.querySelectorAll('.person')];
      const before = new Map(cards.map(c => [c, c.getBoundingClientRect()]));
      change();
      for (const c of cards) {
        const a = before.get(c); const b = c.getBoundingClientRect();
        if (!a || !b.width) continue;
        const dx = a.left - b.left; const dy = a.top - b.top; const sx = a.width / b.width;
        if (!dx && !dy && Math.abs(sx - 1) < 0.01) continue;
        c.style.transition = 'none'; c.style.transformOrigin = 'top left'; c.style.transform = `translate(${dx}px,${dy}px) scale(${sx})`;
        void c.offsetWidth;
        c.style.transition = 'transform .38s cubic-bezier(.2,.7,.3,1)'; c.style.transform = '';
        c.addEventListener('transitionend', () => { c.style.transition = ''; c.style.transformOrigin = ''; }, { once: true });
      }
    },
    close() {
      this.open = null;
      const box = this.root.querySelector('#detail');
      const f = this.root.querySelector('#castFold'); if (f) f.hidden = true;
      this.root.querySelectorAll('.person').forEach(p => p.classList.remove('on'));
      const finish = () => this.flip(() => { const w = this.root.querySelector('#castwrap'); if (w) w.dataset.open = '0'; if (box) box.innerHTML = ''; });
      const d = box?.querySelector('.card.detail');
      if (d) { d.classList.add('closing'); setTimeout(finish, 180); } else finish();
    },
    /** 详情：卡片全部挪到左列、右侧展开一页可滚的详情（设定卡全文可编辑 + 这个人记得的事）。顶上「收起详情」回格子 */
    async show(m) {
      const wasOpen = !!this.open;
      this.open = m.name;
      const fold = this.root.querySelector('#castFold'); if (fold) fold.hidden = false;
      this.root.querySelectorAll('.person').forEach(p => p.classList.toggle('on', p.dataset.who === m.name));
      const box = this.root.querySelector('#detail');
      if (!wasOpen) this.flip(() => { const w = this.root.querySelector('#castwrap'); if (w) w.dataset.open = '1'; });
      const rel = relOf(m.card);
      const gear = Object.values(store.panels || {}).filter(pn => pn.kind === 'equipment' && pn.who === m.name);
      const wearing = (cfg => (cfg.vitals || []).filter(v => v.who === m.name && v.as === 'text' && /穿|着|装|饰/.test(v.label || v.key)))(store.cfg || {});
      box.innerHTML = `<div class="card detail"><h3>${esc(m.name)}<small>${esc(rel || '没有卡')}</small><span class="tools"><button class="btn sm" data-act="edit">编辑设定</button><button class="btn sm" data-back>收起</button></span></h3>
        <div class="tabs" id="dtabs"><button class="on" data-t="card">设定</button><button data-t="gear">装备与穿着</button><button data-t="mem">记得的事</button></div>
        <div class="tab" data-t="card"><div class="md body">读取中…</div></div>
        <div class="tab" data-t="gear" hidden>${gear.length ? gear.map(pn => `<div class="section-hd" style="padding:6px 0 8px">${esc(pn.name)}</div><div class="slots">${(pn.slots || []).map(sl => { const w = pn.items.find(x => x.equipped && x.slot === sl); return `<div class="slotbox${w ? ' on' : ''}"><span class="lbl">${esc(sl)}</span>${w ? `<b>${esc(w.name)}</b>${w.note ? `<p>${esc(w.note)}</p>` : ''}` : '<span class="muted">空</span>'}</div>`; }).join('')}</div><p class="muted" style="margin-top:8px">要换装去顶栏「${esc(pn.name)}」那一页。</p>`).join('') : ''}${wearing.length ? `<div class="section-hd" style="padding:6px 0 8px">此刻</div>${wearing.map(v => `<p class="md" style="margin:0 0 6px"><b>${esc(v.label || v.key)}</b>：${esc((store.state || {})[v.key] ?? v.initial ?? '')}</p>`).join('')}` : ''}${!gear.length && !wearing.length ? '<p class="muted">这个故事没给这个人开装备面板。要的话让 agent 在 open_stage 里加一块 kind=equipment、who 是这个人的面板，或加一个叫「穿着」的文字状态值。</p>' : ''}</div>
        <div class="tab" data-t="mem" hidden><div class="memlist" id="pmem"><p class="muted">读取中…</p></div></div></div>`;
      box.querySelector('[data-back]').onclick = () => this.close();
      box.querySelectorAll('#dtabs button').forEach(t => { t.onclick = () => { box.querySelectorAll('#dtabs button').forEach(x => x.classList.toggle('on', x === t)); box.querySelectorAll('.tab').forEach(x => { x.hidden = x.dataset.t !== t.dataset.t; }); }; });
      box.scrollTop = 0;
      const card = box.firstElementChild; const body = card.querySelector('.body');
      if (!rel) { body.textContent = '这个人没有卡'; return; }
      try {
        const { text } = await api.readFile(rel);
        const dedupe = (t) => t.replace(/^(# [^\n]+)\n+(?:<!--[\s\S]*?-->\n+)?\1\n/m, '$1\n');   // 09-05 之前的卡顶上叠着两个同名大标题
        body.innerHTML = renderMd(dedupe(text));
        card.querySelector('[data-act=edit]').onclick = () => editor(card, rel, text, (t) => { body.innerHTML = renderMd(dedupe(t)); });
      } catch (err) { body.textContent = `读不到：${err.message}`; }
      const home = rel.replace(/\/角色卡\.md$/, '');
      const mine = (this.files || []).filter(f => f.rel.startsWith(`${home}/记忆/`));
      const list = box.querySelector('#pmem');
      if (!mine.length) { list.innerHTML = '<p class="muted">还没有。她记住了什么，对方会自己写进来。</p>'; return; }
      const items = await Promise.all(mine.map(async (f) => { const { text } = await api.readFile(f.rel); const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text); const get = (k) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(fm?.[1] || '')?.[1] || ''; return { name: f.rel.split('/').pop().replace(/\.md$/, ''), type: get('type'), description: get('description'), content: fm ? text.slice(fm[0].length).trim() : text }; }));
      const T = { progress: '进展', character: '态度', thread: '伏笔', world: '设定' };
      list.innerHTML = items.map(i => `<details><summary><span class="t">${esc(T[i.type] || i.type || '')}</span><span class="d">${esc(i.description || i.name)}</span></summary><div class="md">${renderMd(i.content)}</div></details>`).join('');
    },
    update(what) { if (what.type === 'hello' || what.type === 'config' || what.type === 'state' || what.type === 'panel') this.paint(); },
  });

  /* ── 记忆 ── */
  ND.page({
    id: 'memory', label: '记忆',
    mount(root) { root.className = 'page scroll'; this.root = root; this.paint(); },
    async paint() {
      const r = this.root; const cast = store.cfg?.cast || [];
      r.innerHTML = `<div class="page-inner">
        <section><h2>这个故事记住的事<small>${store.memories.length} 条 · 进展 / 伏笔 / 世界里确立的新事实</small></h2><div class="memlist" id="playMem"></div></section>
        <section><h2>每个人记得的事<small>写在各自的卡上，跟着人走</small></h2><div id="castMem"></div></section></div>`;
      const pm = r.querySelector('#playMem');
      pm.innerHTML = store.memories.length ? store.memories.map(m => this.item(m, null)).join('') : '<p class="muted">还没有。不可逆的事发生时对方会自己记下来。</p>';
      this.bind(pm, null);
      const cm = r.querySelector('#castMem');
      let files = [];
      try { files = (await api.files()).files; } catch { files = []; }
      for (const m of cast) {
        const sec = el(`<div class="card"><h3>${esc(m.name)}</h3><div class="memlist">读取中…</div></div>`); cm.appendChild(sec);
        const list = sec.querySelector('.memlist');
        const home = relOf(m.card)?.replace(/\/角色卡\.md$/, '');
        const mine = files.filter(f => home && f.rel.startsWith(`${home}/记忆/`));
        if (!mine.length) { list.innerHTML = '<p class="muted">还没有</p>'; continue; }
        const items = await Promise.all(mine.map(async (f) => { const { text } = await api.readFile(f.rel); const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text); const get = (k) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(fm?.[1] || '')?.[1] || ''; return { name: f.rel.split('/').pop().replace(/\.md$/, ''), type: get('type'), description: get('description'), content: fm ? text.slice(fm[0].length).trim() : text }; }));
        list.innerHTML = items.map(i => this.item(i, m.name)).join('');
        this.bind(list, m.name);
      }
    },
    item(m, who) {
      const T = { progress: '进展', character: '态度', thread: '伏笔', world: '设定' };
      return `<details><summary><span class="t">${esc(T[m.type] || m.type || '')}</span><span class="d">${esc(m.description || m.name)}</span><button class="btn sm danger" data-del="${esc(m.name)}" data-who="${esc(who || '')}">删除</button></summary><div class="md">${renderMd(m.content)}</div></details>`;
    },
    bind(box, who) {
      box.querySelectorAll('[data-del]').forEach(b => { b.onclick = async (e) => { e.preventDefault(); if (!(await ND.confirm({ title: '删掉这条记忆？', body: '对方以后就不记得这件事了。', ok: '删除', danger: true }))) return; try { await api.deleteMemory(b.dataset.del, who); store.memories = store.memories.filter(x => x.name !== b.dataset.del); this.paint(); } catch (err) { ND.flash(err.message, true); } }; });
    },
    update(what) { if (what.type === 'hello') this.paint(); if (what.type === 'tool' && /remember|forget/.test(what.name || '')) this.dirty = true; if (what.type === 'turn_end' && this.dirty) { this.dirty = false; ND.refreshHello(); } },
  });

  /* ── 设定（上下文） ── */
  ND.page({
    id: 'context', label: '设定',
    mount(root) { root.className = 'page scroll'; this.root = root; this.paint(); },
    async paint() {
      const cfg = store.cfg || {}; const u = store.status.usage; const rules = store.rules; const earned = new Map(store.trophies.map(t => [t.id, t]));
      const r = this.root;
      r.innerHTML = `<div class="page-inner">
        <section><h2>对方看到的是什么<small>${fmtK(cfg.promptChars || 0)} 字 · 每句话都原样重发，命中缓存几乎不要钱；改一个字整块重付</small></h2>
          <table class="kv">${(cfg.sources || []).map(s => `<tr><td>${esc(relOf(s) || s)}</td><td class="num"><button class="btn sm" data-open="${esc(relOf(s) || s)}">编辑</button></td></tr>`).join('') || '<tr><td colspan="2" class="muted">进程还没起过，起了才知道拼了哪些文件</td></tr>'}${cfg.styleNames?.length ? `<tr><td>写法 · ${esc(cfg.styleNames.join(' / '))}</td><td class="num"><span class="muted">下面改</span></td></tr>` : ''}</table>
          <p class="muted">设定文件（世界 / 规矩 / 怎么演）+ 每个人的卡（人设 + 他记得的事）+ 这个故事的记忆索引 + 你挑的写法。没有别的。</p></section>
        <section><h2>写法<small>换了之后下一句话到时对方按新的来</small></h2><div id="picker"><p class="muted">读取中…</p></div></section>
        <section id="loreSec" hidden><h2>世界书<small>关掉的条目机器不再送给对方</small></h2><div id="lore"></div></section>
        <section><h2>成就<small>${earned.size} / ${rules.achievements.length}</small></h2>
          <div class="rules">${rules.achievements.map(a => { const e = earned.get(a.id); const hide = a.hidden && !e; return `<div class="rule ${e ? '' : 'locked'}"><span class="cupbox">${cupSvg(a.tier)}</span><div><b>${hide ? '？？？' : esc(a.title)}</b><span>${hide ? '隐藏成就 · 达成后揭晓' : esc(a.desc || '')}</span><div class="cond">${e ? `<span class="muted">第 ${e.beat} 段达成 · ${esc(CUP[a.tier] || '铜')}</span>` : condHtml(a.when)}</div></div></div>`; }).join('') || '<p class="muted">这个故事没设成就。</p>'}</div></section>
        <section><h2>剧情推进<small>条件一到，机器递张纸条给对方，怎么写还是它写</small></h2>
          ${rules.triggers.map(t => `<div class="trig"><div class="when">当 ${condHtml(t.when)} 时${(cfg.firedTriggers || []).includes(t.id) ? '<span class="fired">已触发</span>' : ''}${t.once === false ? '<span class="muted" style="font-size:10.5px;margin-left:6px">每次成立都递</span>' : ''}</div><div class="noteline">${esc(t.note)}</div></div>`).join('') || '<p class="muted">没设推进条件。</p>'}
          <p style="margin-top:8px"><button class="btn sm" id="editRules">编辑规则原文</button></p><div id="rulesSlot"></div></section>
        <section><h2>上一句的开销<small>${u ? `${esc(u.model || '')} · ${(u.durationMs / 1000).toFixed(1)}s` : '还没有'}</small></h2>
          ${u ? `<table class="kv"><tr><th>上下文长度</th><td class="num">${fmtK(u.context)}</td></tr><tr><th>缓存命中</th><td class="num">${fmtK(u.cacheRead)}（${u.context ? Math.round((u.cacheRead / u.context) * 100) : 0}%）</td></tr><tr><th>新写入缓存</th><td class="num">${fmtK(u.cacheCreate)}</td></tr><tr><th>输出</th><td class="num">${fmtK(u.output)}</td></tr><tr><th>花费</th><td class="num">$${(u.costUsd || 0).toFixed(4)}</td></tr></table>` : '<p class="muted">说一句话之后这里就有数了。</p>'}
        </section>
        <section><h2>这个故事的文件<small>世界书 / 预设 / 记忆正文，对方用到时自己读</small></h2><div id="fileList" class="muted">读取中…</div></section>
        <section id="editorSlot"></section></div>`;
      r.querySelectorAll('[data-open]').forEach(b => { b.onclick = () => this.open(b.dataset.open); });
      r.querySelector('#editRules').onclick = () => {
        const slot = r.querySelector('#rulesSlot'); slot.innerHTML = '<div class="card"><h3>规则.json<small>成就与推进的原文</small></h3><div class="body"></div></div>';
        editor(slot.firstElementChild, '规则.json', JSON.stringify(rules, null, 2), () => ND.refreshHello());
      };
      try {
        const presets = (await api.presets()).presets;
        const state = { preset: cfg.style?.preset || 'izumi', modules: cfg.style?.modules || null };
        let timer = null;
        ND.stylePicker(r.querySelector('#picker'), { presets, state, onUpload: true, onChange: (s) => { clearTimeout(timer); timer = setTimeout(() => api.config({ style: { preset: s.preset, modules: s.modules } }).then(() => ND.flash('写法已改，下一句话到时生效')).catch(err => ND.flash(err.message, true)), 500); } });
      } catch (err) { r.querySelector('#picker').innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
      try {
        const { entries } = await api.lore();
        if (entries.length) { r.querySelector('#loreSec').hidden = false; const off = new Set(cfg.lore?.off || []); let lt = null; ND.lorePicker(r.querySelector('#lore'), { entries, off, by: cfg.lore?.by, onChange: (o) => { clearTimeout(lt); lt = setTimeout(() => api.config({ lore: { off: [...o] } }).then(() => ND.flash('世界书开关已改')).catch(e => ND.flash(e.message, true)), 500); } }); }
      } catch { /* 没有世界书 */ }
      try {
        const { files } = await api.files();
        const fl = r.querySelector('#fileList'); fl.className = '';
        fl.innerHTML = `<table class="kv">${files.map(f => `<tr><td>${esc(f.rel)}</td><td class="num">${fmtK(f.size)} B</td><td class="num"><button class="btn sm" data-open="${esc(f.rel)}">编辑</button></td></tr>`).join('')}</table>`;
        fl.querySelectorAll('[data-open]').forEach(b => { b.onclick = () => this.open(b.dataset.open); });
      } catch (err) { r.querySelector('#fileList').textContent = err.message; }
    },
    async open(rel) {
      const slot = this.root.querySelector('#editorSlot');
      slot.innerHTML = `<div class="card"><h3>${esc(rel)}</h3><div class="body md">读取中…</div></div>`;
      const card = slot.firstElementChild;
      try { const { text } = await api.readFile(rel); editor(card, rel, text, (t) => { card.querySelector('.body').innerHTML = renderMd(t); }); }
      catch (err) { card.querySelector('.body').textContent = err.message; }
      slot.scrollIntoView({ behavior: 'smooth' });
    },
    update(what) { if (what.type === 'hello' || what.type === 'turn_end' || what.type === 'trophy') this.paint(); },
  });

  /* ── 状态 ── */
  ND.page({
    id: 'status', label: '状态',
    mount(root) { root.className = 'page scroll'; this.root = root; this.paint(); },
    async paint() {
      const cfg = store.cfg || {}; const S = store.state || {};
      const keys = [...new Set([...(cfg.vitals || []).map(v => v.key), ...Object.keys(S)])];
      const r = this.root;
      r.innerHTML = `<div class="page-inner">
        <section><h2>状态值<small>每段由对方报；这里能手改，改了下一句话会带给它</small></h2>
          <div class="statgrid">${keys.map(k => { const v = ND.vitalOf(k); return `<div class="stat"><div class="lbl"><span>${esc(v?.label || k)}${v?.who ? ` · ${esc(v.who)}` : ''}</span>${v && v.label && v.label !== k ? `<span class="k">${esc(k)}</span>` : ''}</div>${k === '拍数' ? `<div class="ro">${esc(S[k] ?? 0)}</div>` : `<input class="val" data-key="${esc(k)}" value="${esc(S[k] ?? '')}">`}</div>`; }).join('')}</div>
          <p><button class="btn primary" id="applyState">应用改动</button> <span class="muted" id="stateNote"></span></p></section>
        <section><h2>背景<small>换场时机器生的图；也可以自己选一张，或放进这个故事的 素材/ 文件夹</small></h2><div class="grid-imgs" id="imgs">读取中…</div><p style="margin-top:8px"><button class="btn sm" id="clearBg">跟着场景走</button></p></section></div>`;
      r.querySelector('#applyState').onclick = async () => {
        const patch = {}; r.querySelectorAll('input.val').forEach(i => { const v = i.value.trim(); if (v === '') return; const n = Number(v); patch[i.dataset.key] = Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(v) ? n : v; });
        try { const res = await api.setState(patch); r.querySelector('#stateNote').textContent = res.note ? res.note.replace(/^【|】$/g, '') : '已记下，下一句话带给它'; } catch (err) { r.querySelector('#stateNote').textContent = err.message; }
      };
      r.querySelector('#clearBg').onclick = () => api.config({ backdrop: null }).catch(() => {});
      try {
        const { images } = await api.images();
        const box = r.querySelector('#imgs');
        box.innerHTML = images.map(i => `<button data-rel="${esc(i.rel)}" class="${cfg.backdrop && cfg.backdrop.endsWith(encodeURIComponent(i.rel.split('/').pop())) ? 'on' : ''}"><img src="${esc(i.url)}" alt=""></button>`).join('') || '<p class="muted">还没有图。换场时机器会生一张。</p>';
        box.querySelectorAll('button[data-rel]').forEach(b => { b.onclick = () => api.config({ backdrop: `${cfg.root}/${b.dataset.rel}` }).catch(() => {}); });
      } catch (err) { r.querySelector('#imgs').textContent = err.message; }
    },
    update(what) { if (['hello', 'state', 'config', 'turn_end', 'backdrop'].includes(what.type)) this.paint(); },
  });

  /* ── 外观：单开一页（09-06 站主：以后还会加自定义项，现在先皮肤 + 正文宽度 + 侧栏） ── */
  ND.page({
    id: 'looks', label: '外观',
    mount(root) { root.className = 'page scroll'; this.root = root; this.paint(); },
    paint() {
      const cfg = store.cfg || {};
      const SK = [['paper', '纸', '跟平台一样的暖纸', ['#FFFEF6', '#F4EFE3', '#2B2117']], ['jiangnan', '江南', '青灰的水乡调子', ['#edf1f0', '#dbe1e0', '#26312f']], ['night', '夜', '深底金字', ['#15171b', '#22262c', '#dcd7ce']], ['terminal', '终端', '等宽字的墨绿屏', ['#0d100e', '#171c14', '#7fd08a']]];
      const measure = ND.prefs.get('measure', null);
      const r = this.root;
      r.innerHTML = `<div class="page-inner looks">
        <section><h2>皮肤<small>这个故事的外观，所有打开它的人都看到同一套</small></h2>
          <div class="skins">${SK.map(([id, name, hint, c]) => `<button class="skin${cfg.skin === id ? ' on' : ''}" data-skin="${id}" title="${esc(hint)}"><span class="sw"><i style="background:${c[0]}"></i><i style="background:${c[1]}"></i><i style="background:${c[2]}"></i></span><b>${name}</b></button>`).join('')}</div></section>
        <section><h2>这台机器上的偏好<small>只记在这个浏览器里</small></h2>
          <div class="row2">
            <div class="field"><span class="lbl">正文宽度 · <b id="mw">${measure ? `${measure}px` : '默认'}</b></span><input type="range" id="measure" min="480" max="1400" step="10" value="${measure || 680}"><span class="muted">故事页正文右侧那枚纸签也能拖；双击它复原。</span></div>
            <div class="field"><span class="lbl">人物栏</span><div><span class="seg" id="dockSide"><button data-v="left"${ND.dock.side === 'left' ? ' class="on"' : ''}>停左边</button><button data-v="right"${ND.dock.side === 'right' ? ' class="on"' : ''}>停右边</button></span></div><div><span class="seg" id="dockMode"><button data-v="open"${ND.dock.mode === 'open' ? ' class="on"' : ''}>展开</button><button data-v="mini"${ND.dock.mode === 'mini' ? ' class="on"' : ''}>收成一条</button></span></div></div>
            <div class="field"><span class="lbl">背景图透出多少 · <b id="vv">${Math.round((ND.prefs.get('veil', 0.9)) * 100)}% 纱</b></span><input type="range" id="veil" min="0" max="100" step="2" value="${Math.round((ND.prefs.get('veil', 0.9)) * 100)}"><span class="muted">拉到 0 就是完全透明，图整张露出来；字本身在纸上不受影响。顶栏的眼睛能把字整块收起来看图。</span>
              <label class="tog"><input type="checkbox" id="autoBg" ${cfg.backdropsAuto === false ? '' : 'checked'}><span>换场时自动生背景图<small>这个故事的设置，所有人共用；地点变了才生，同一处换钟点不重生</small></span></label></div>
            <div class="field"><span class="lbl">选项</span><div><span class="seg" id="optsDef"><button data-v="1"${ND.prefs.get('opts', 1) ? ' class="on"' : ''}>默认展开</button><button data-v="0"${ND.prefs.get('opts', 1) ? '' : ' class="on"'}>默认收起</button></span></div></div>
          </div></section>
        <section><h2>写故事的进程<small>配图权限与模型，这个故事的设置，所有人共用</small></h2>
          <div id="images"></div>
          <div class="field" style="margin-top:12px"><span class="lbl">模型 · 换了下一句话起生效</span><div id="models"><p class="muted">读取中…</p></div></div></section>
        <p class="muted">更多可自定义的项目以后加在这一页。</p></div>`;
      ND.imagesToggle(r.querySelector('#images'), { allow: !!cfg.images?.allow, by: cfg.images?.by, onChange: (v) => api.config({ images: { allow: v } }).then(() => ND.flash(v ? '对方可以配图了，下一句话起生效' : '关掉了配图，背景图回到机器自动生')).catch(err => ND.flash(err.message, true)) });
      api.models().then(m => { ND.modelPicker(r.querySelector('#models'), { options: m.options || [], current: m.current, onPick: (id) => api.config({ model: id }).then(() => ND.flash('换好了，下一句话起用新模型（记忆不丢）')).catch(err => ND.flash(err.message, true)) }); }).catch(err => { r.querySelector('#models').innerHTML = `<p class="muted">${esc(err.message)}</p>`; });
      r.querySelectorAll('[data-skin]').forEach(b => { b.onclick = () => api.config({ skin: b.dataset.skin }).catch(err => ND.flash(err.message, true)); });
      const range = r.querySelector('#measure');
      range.oninput = () => { const w = Number(range.value); document.documentElement.style.setProperty('--measure', `${w}px`); ND.prefs.set('measure', w); r.querySelector('#mw').textContent = `${w}px`; };
      r.querySelector('#dockSide').querySelectorAll('button').forEach(b => { b.onclick = () => { if (b.dataset.v !== ND.dock.side) ND.dock.flip(); setTimeout(() => this.paint(), 600); }; });
      r.querySelector('#dockMode').querySelectorAll('button').forEach(b => { b.onclick = () => { if (b.dataset.v !== ND.dock.mode) ND.dock.toggle(); ND.dock.forPage('looks'); this.paint(); }; });
      r.querySelector('#optsDef').querySelectorAll('button').forEach(b => { b.onclick = () => { ND.prefs.set('opts', Number(b.dataset.v)); this.paint(); }; });
      const veil = r.querySelector('#veil');
      veil.oninput = () => { const a = Number(veil.value) / 100; document.documentElement.style.setProperty('--veil-a', String(a)); ND.prefs.set('veil', a); r.querySelector('#vv').textContent = `${veil.value}% 纱`; };
      r.querySelector('#autoBg').onchange = (e) => api.config({ backdropsAuto: e.target.checked }).then(() => ND.flash(e.target.checked ? '换场会自动生背景' : '不再自动生背景')).catch(err => ND.flash(err.message, true));
    },
    update(what) { if (what.type === 'hello' || what.type === 'config') this.paint(); },
  });
})();
