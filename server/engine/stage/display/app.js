/* ═══════════════════════════════════════════════════════════════
   RP 显示器 —— 逻辑（2026-09-05 晚重写）

   结构：
     api      同目录的 REST（state / say / file …）
     store    唯一状态 + 订阅；SSE 事件只改 store，页面只读 store
     pages    页面注册表：{ id, label, mount(el), update(what) }；加一页 = 往表里 push 一个对象
     cast     左栏在场者槽（所有页共用）
     toasts   奖杯弹条
   本页不存任何真相，刷新就是重拉 hello。
   ═══════════════════════════════════════════════════════════════ */
(() => {
  const BASE = location.pathname.replace(/\/view\/?$/, '');
  const q = new URLSearchParams(location.search);
  const EMBED = q.get('embed') === '1';
  if (EMBED) document.body.classList.add('embed');
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtK = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)}万` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

  /* ── api ── */
  const api = {
    async json(method, path, body) {
      const res = await fetch(`${BASE}/${path}`, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
      const text = await res.text();
      let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      if (!res.ok) throw new Error(data?.error || res.statusText);
      return data;
    },
    say: (text) => api.json('POST', 'say', { text }),
    start: () => api.json('POST', 'start', {}),
    stop: () => api.json('POST', 'stop'),
    config: (patch) => api.json('PATCH', 'config', patch),
    setState: (patch) => api.json('POST', 'state', patch),
    files: () => api.json('GET', 'files'),
    readFile: (p) => api.json('GET', `file?path=${encodeURIComponent(p)}`),
    saveFile: (p, text) => api.json('PUT', 'file', { path: p, text }),
    deleteMemory: (name, who) => api.json('DELETE', `memory?name=${encodeURIComponent(name)}${who ? `&who=${encodeURIComponent(who)}` : ''}`),
    images: () => api.json('GET', 'images'),
  };

  /* ── store ── */
  const store = {
    cfg: null, scenes: [], memories: [], trophies: [], rules: { achievements: [], triggers: [] },
    state: {}, status: { running: false, busy: false, queued: 0, error: null, usage: null },
    live: '', draft: '', thinking: '', backdrop: null, sending: false, page: 'stage',
    listeners: new Set(),
    emit(what) { for (const fn of this.listeners) { try { fn(what); } catch (e) { console.error(e); } } },
    on(fn) { this.listeners.add(fn); },
  };
  const lastStage = () => { for (let i = store.scenes.length - 1; i >= 0; i--) if (store.scenes[i].by === 'stage') return store.scenes[i]; return null; };
  const lastScene = () => { for (let i = store.scenes.length - 1; i >= 0; i--) if (store.scenes[i].scene) return store.scenes[i].scene; return ''; };

  /* 正文：agent 照旧写整段散文，成分识别归显示器 */
  function renderProse(text) {
    return String(text || '').split(/\n{2,}/).map((raw) => {
      const p = raw.trim(); if (!p) return '';
      const h = esc(p)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/&quot;([^&]*?)&quot;/g, '<q>“$1”</q>')
        .replace(/“([^”]*)”/g, '<q>“$1”</q>')
        .replace(/(「[^」]*」)/g, '<q>$1</q>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/\n/g, '<br>');
      return `<p>${h}</p>`;
    }).join('');
  }
  /* 极简 markdown：标题 / 列表 / 粗体 / 行内代码 / 段落（人设与台面预览用；不求全） */
  function renderMd(text) {
    const lines = String(text || '').replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/<!--[\s\S]*?-->/g, '').split('\n');
    const out = []; let list = null; let para = [];
    const flushP = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
    const flushL = () => { if (list) { out.push(`<ul>${list.map(i => `<li>${inline(i)}</li>`).join('')}</ul>`); list = null; } };
    const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
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

  /* ── 顶栏 / 在场者槽 / 背景（所有页共用） ── */
  function paintTop() {
    const st = store.status;
    $('title').textContent = store.cfg?.title || '演出';
    $('sceneText').textContent = lastScene();
    $('statusDot').className = `dot ${st.running ? (st.busy ? 'busy' : 'on') : ''}`;
    $('statusText').textContent = st.error ? '出错了' : st.running ? (st.busy ? '台上正在写' : (st.queued ? `排着 ${st.queued} 句` : '台上在等你')) : (store.cfg ? '散场了 · 说一句就再开' : '还没开戏');
    const u = st.usage;
    $('ctxPill').textContent = u ? `上下文 ${fmtK(u.context)} · 缓存 ${u.context ? Math.round((u.cacheRead / u.context) * 100) : 0}% · $${(u.costUsd || 0).toFixed(3)}` : '';
    document.documentElement.dataset.skin = store.cfg?.skin || 'paper';
  }
  function paintBackdrop() {
    const b = $('backdrop');
    const url = store.cfg?.backdrop || store.backdrop;
    if (url) { b.style.backgroundImage = `url("${url}")`; b.classList.add('on'); } else b.classList.remove('on');
  }
  function paintCast() {
    const box = $('cast'); const cfg = store.cfg; const cast = cfg?.cast || []; const S = store.state || {};
    const vitals = `<div class="vitals">${(cfg?.vitals || []).map((v) => {
      const val = S[v.key] ?? v.initial ?? ''; const label = esc(v.label || v.key);
      if (v.as === 'bar') { const pct = Math.max(0, Math.min(100, (parseFloat(val) / (v.max || 100)) * 100)) || 0; return `<div class="vital"><div class="row"><span>${label}</span><b>${esc(val)}</b></div><div class="bar"><i style="width:${pct}%"></i></div></div>`; }
      if (v.as === 'chips') return `<div class="vital"><div class="row"><span>${label}</span></div><div class="chips">${(v.options || []).map((o) => `<span class="chip${String(o) === String(val) ? ' on' : ''}">${esc(o)}</span>`).join('')}</div></div>`;
      if (v.as === 'num') return `<div class="vital"><div class="row"><span>${label}</span><b>${esc(val)}${v.unit ? `<small>${esc(v.unit)}</small>` : ''}</b></div></div>`;
      return `<div class="vital"><div class="row"><span>${label}</span><b>${esc(val)}</b></div></div>`;
    }).join('')}</div>`;
    const earned = store.trophies.length; const total = store.rules.achievements.length;
    const foot = `<div class="foot">${total ? `奖杯 ${earned} / ${total}<br>` : ''}第 ${S['拍数'] || 0} 拍${cfg?.footer ? `<br>${esc(cfg.footer)}` : ''}</div>`;
    if (cast.length <= 1) {
      const m = cast[0] || { name: cfg?.title || '演出', note: '' };
      const img = m.portrait ? `<img alt="" src="${esc(m.portrait)}">` : `<b>${esc(String(m.name || '').slice(0, 1))}</b><i>立绘位</i>`;
      box.innerHTML = `<div class="portrait">${img}</div><div class="who"><h3>${esc(m.name)}</h3><p>${esc(m.note || '')}</p></div>${vitals}${foot}`;
    } else {
      const on = new Set(lastStage()?.speakers || []);
      box.innerHTML = `${vitals}<div class="roster"><div class="hd">在场 ${cast.length} 人</div>${cast.map((m) => `<div class="mate${on.has(m.name) ? ' on' : ''}" title="${esc(m.note || '')}"><span class="av">${m.portrait ? `<img alt="" src="${esc(m.portrait)}">` : esc(String(m.name || '').slice(0, 1))}</span><span><span class="nm">${esc(m.name)}</span><span class="du">${esc(m.note || '')}</span></span></div>`).join('')}</div>${foot}`;
    }
  }

  /* ── 奖杯弹条 ── */
  const CUP = { bronze: '🥉', silver: '🥈', gold: '🥇', platinum: '🏆' };
  function toast(t) {
    const node = el(`<div class="toast ${esc(t.tier || 'bronze')}"><span class="cup">${CUP[t.tier] || '🏆'}</span><div><span class="kicker">成就达成</span><b>${esc(t.title)}</b>${t.desc ? `<span>${esc(t.desc)}</span>` : ''}</div></div>`);
    $('toasts').appendChild(node);
    setTimeout(() => { node.classList.add('out'); setTimeout(() => node.remove(), 600); }, 5200);
  }

  /* ═══════════ 页面 ═══════════ */
  const pages = [];
  const page = (def) => pages.push(def);

  /* 舞台 */
  page({
    id: 'stage', label: '舞台',
    mount(root) {
      root.innerHTML = '<div class="beats" id="beats"><div class="beats-inner" id="inner"></div></div><div class="handles"><div class="handles-inner" id="handles"></div><div class="note" id="note"></div></div>';
      this.paintAll();
    },
    beatHtml(r) {
      if (r.by === 'user') return `<div class="beat me"><div class="tagline">你</div>${renderProse(r.text)}</div>`;
      if (r.by === 'user-state') return `<div class="beat sys">你拨了状态：${esc(Object.entries(r.state || {}).map(([k, v]) => `${k} ${v}`).join(' · '))}</div>`;
      if (r.by === 'dice') return `<div class="beat dice">🎲 ${esc(r.reason || '')} · d${r.sides}×${(r.rolls || []).length} → [${(r.rolls || []).join(', ')}] = <b>${r.total}</b></div>`;
      return `<div class="beat">${renderProse(r.text)}</div>`;
    },
    tail() {
      let h = '';
      if (store.thinking) h += `<details class="think"><summary>正在想…</summary><pre>${esc(store.thinking.slice(-1500))}</pre></details>`;
      if (store.draft) h += `<div class="beat draft" id="draft">${renderProse(store.draft)}</div>`;
      else if (store.live) h += `<div class="beat live" id="live">${renderProse(store.live)}</div>`;
      return h;
    },
    paintAll() {
      const inner = $('inner'); if (!inner) return;
      inner.innerHTML = (!store.scenes.length && !store.draft && !store.live)
        ? `<div class="empty">${store.cfg ? '台上还是空的。<br>说一句话，戏就开了。' : '这里还没有戏。'}</div>`
        : store.scenes.map(r => this.beatHtml(r)).join('') + `<div id="tail">${this.tail()}</div>`;
      this.paintHandles(); this.scroll();
    },
    paintTail() {
      const t = $('tail'); if (!t) { this.paintAll(); return; }
      const wasOpen = t.querySelector('details')?.open;
      t.innerHTML = this.tail();
      if (wasOpen && t.querySelector('details')) t.querySelector('details').open = true;
      this.scroll();
    },
    append(r) {
      const inner = $('inner'); if (!inner) return;
      inner.querySelector('.empty')?.remove();
      const t = $('tail');
      const node = el(this.beatHtml(r));
      if (t) inner.insertBefore(node, t); else inner.appendChild(node);
      this.paintTail(); this.paintHandles(); this.scroll();
    },
    scroll() { setTimeout(() => { const b = $('beats'); if (b) b.scrollTop = b.scrollHeight; }, 0); },   // 不用 rAF：卡片预览里 rAF 被冻住
    paintHandles() {
      const box = $('handles'); if (!box) return;
      const last = lastStage(); const lastRow = store.scenes[store.scenes.length - 1];
      const spent = lastRow && lastRow.by === 'user';
      let list = (last && !spent) ? (last.choices || []) : [];
      if (!list.length && store.cfg && !spent && last) list = [{ label: '继续', prompt: '继续。' }];
      const dis = (!store.cfg || store.status.busy || store.sending) ? ' disabled' : '';
      box.innerHTML = list.map((c) => `<button class="handle" data-p="${esc(c.prompt || c.label)}"${dis}><b>${esc(c.label)}</b>${c.hint ? `<span>${esc(c.hint)}</span>` : ''}</button>`).join('')
        + `<div class="say"><textarea id="say" rows="1" placeholder="${store.cfg ? '或者直接说你要做什么（Enter 发送，Shift+Enter 换行）' : '还没开戏'}"${store.cfg ? '' : ' disabled'}></textarea><button id="sayGo"${dis}>说</button></div>`;
      box.querySelectorAll('.handle').forEach((b) => { b.onclick = () => this.fire(b.dataset.p); });
      const ta = $('say'); const go = () => { const v = ta.value.trim(); if (v) { this.fire(v); ta.value = ''; ta.style.height = 'auto'; } };
      $('sayGo').onclick = go;
      ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); go(); } };
      ta.oninput = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; };
    },
    async fire(text) {
      if (!text || store.sending || EMBED) return;
      store.sending = true; this.note(''); this.paintHandles();
      try { await api.say(text); } catch (err) { this.note(`没送出去：${err.message}`, true); }
      finally { store.sending = false; this.paintHandles(); }
    },
    note(t, err) { const n = $('note'); if (n) { n.textContent = t || ''; n.className = 'note' + (err ? ' err' : ''); } },
    update(what) {
      if (what.type === 'scene') this.append(what.row);
      else if (what.type === 'draft' || what.type === 'text' || what.type === 'thinking' || what.type === 'turn_end') this.paintTail();
      else if (what.type === 'status') this.paintHandles();
      else if (what.type === 'error') this.note(`演出进程出错：${what.error}`, true);
      else if (what.type === 'hello' || what.type === 'config') this.paintAll();
    },
  });

  /* 人物 */
  page({
    id: 'cast', label: '人物',
    mount(root) { root.className = 'page scroll'; this.root = root; this.paint(); },
    async paint() {
      const cast = store.cfg?.cast || [];
      const r = this.root; r.innerHTML = `<div class="page-inner"><h2>在场者<small>${cast.length} 人 · 卡是这个人的全部，改完下一句话到时进程自动重开</small></h2><div id="castCards"></div></div>`;
      const box = r.querySelector('#castCards');
      if (!cast.length) { box.innerHTML = '<p class="muted">还没有人。让 agent 用 cast_role 写卡、open_stage 开戏。</p>'; return; }
      for (const m of cast) {
        const card = el(`<div class="card"><h3>${m.portrait ? `<img src="${esc(m.portrait)}" alt="" style="width:28px;height:28px;border-radius:50%;object-fit:cover">` : ''}${esc(m.name)}<small>${esc(m.note || '')}</small><span class="tools"><button class="btn" data-act="edit">编辑卡</button></span></h3><div class="md body">读取中…</div></div>`);
        box.appendChild(card);
        const rel = m.card ? m.card.replace(new RegExp(`^${store.cfg.root}/`), '') : null;
        const body = card.querySelector('.body');
        if (!rel) { body.textContent = '这个人没有卡'; continue; }
        try {
          const { text } = await api.readFile(rel);
          body.innerHTML = renderMd(text);
          card.querySelector('[data-act=edit]').onclick = () => editor(card, rel, text, (t) => { body.innerHTML = renderMd(t); });
        } catch (err) { body.textContent = `读不到：${err.message}`; }
      }
    },
    update(what) { if (what.type === 'hello' || what.type === 'config') this.paint(); },
  });

  /* 记忆 */
  page({
    id: 'memory', label: '记忆',
    mount(root) { root.className = 'page scroll'; this.root = root; this.paint(); },
    async paint() {
      const r = this.root;
      const cast = store.cfg?.cast || [];
      r.innerHTML = `<div class="page-inner">
        <section><h2>这场戏记住的事<small>${store.memories.length} 条 · 演到哪 / 伏笔 / 世界新事实</small></h2><div class="memlist" id="playMem"></div></section>
        <section><h2>每个人记得的事<small>写在各自的卡上，跟着人走</small></h2><div id="castMem"></div></section></div>`;
      const pm = r.querySelector('#playMem');
      pm.innerHTML = store.memories.length ? store.memories.map(m => this.item(m, null)).join('') : '<p class="muted">还没有。演出进程在不可逆的事发生时会自己记。</p>';
      this.bind(pm, null);
      const cm = r.querySelector('#castMem');
      for (const m of cast) {
        const sec = el(`<div class="card"><h3>${esc(m.name)}</h3><div class="memlist">读取中…</div></div>`); cm.appendChild(sec);
        const list = sec.querySelector('.memlist');
        try {
          const { files } = await api.files();
          const home = m.card ? m.card.replace(new RegExp(`^${store.cfg.root}/`), '').replace(/\/角色卡\.md$/, '') : null;
          const mine = files.filter(f => home && f.rel.startsWith(`${home}/记忆/`));
          if (!mine.length) { list.innerHTML = '<p class="muted">还没有</p>'; continue; }
          const items = [];
          for (const f of mine) { const { text } = await api.readFile(f.rel); const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text); const get = (k) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(fm?.[1] || '')?.[1] || ''; items.push({ name: f.rel.split('/').pop().replace(/\.md$/, ''), type: get('type'), description: get('description'), content: fm ? text.slice(fm[0].length).trim() : text }); }
          list.innerHTML = items.map(i => this.item(i, m.name)).join('');
          this.bind(list, m.name);
        } catch (err) { list.textContent = `读不到：${err.message}`; }
      }
    },
    item(m, who) {
      return `<details><summary><span class="t">${esc(m.type || '')}</span><span class="d">${esc(m.description || m.name)}</span><button class="btn danger" data-del="${esc(m.name)}" data-who="${esc(who || '')}">删</button></summary><div class="md">${renderMd(m.content)}</div></details>`;
    },
    bind(box, who) {
      box.querySelectorAll('[data-del]').forEach(b => { b.onclick = async (e) => { e.preventDefault(); if (!confirm(`删掉「${b.dataset.del}」？`)) return; try { await api.deleteMemory(b.dataset.del, who); store.memories = store.memories.filter(x => x.name !== b.dataset.del); this.paint(); } catch (err) { alert(err.message); } }; });
    },
    update(what) { if (what.type === 'hello') this.paint(); if (what.type === 'tool' && /remember|forget/.test(what.name || '')) this.dirty = true; if (what.type === 'turn_end' && this.dirty) { this.dirty = false; refreshHello(); } },
  });

  /* 上下文 */
  page({
    id: 'context', label: '上下文',
    mount(root) { root.className = 'page scroll'; this.root = root; this.paint(); },
    async paint() {
      const cfg = store.cfg || {}; const u = store.status.usage;
      const r = this.root;
      r.innerHTML = `<div class="page-inner">
        <section><h2>系统提示词由什么拼成<small>${fmtK(cfg.promptChars || 0)} 字 · 冻结区，改一个字整块重付</small></h2>
          <table class="kv"><tr><th>来源</th><th></th></tr>${(cfg.sources || []).map(s => `<tr><td>${esc(s)}</td><td class="num"><button class="btn" data-open="${esc(s.replace(new RegExp(`^${cfg.root}/`), ''))}">改</button></td></tr>`).join('') || '<tr><td colspan="2" class="muted">进程还没起过，起了才知道拼了哪些文件</td></tr>'}</table>
          <p class="muted">台面（世界 / 规矩 / 怎么演）+ 每个在场者的卡（人设 + 他的记忆索引）+ 这场戏的记忆索引 + 几句工具提醒。没有 CLAUDE.md，没有别的。</p></section>
        <section><h2>上一轮<small>${u ? `${u.model || ''} · ${(u.durationMs / 1000).toFixed(1)}s` : '还没有'}</small></h2>
          ${u ? `<table class="kv"><tr><th>上下文长度</th><td class="num">${fmtK(u.context)}</td></tr><tr><th>缓存命中</th><td class="num">${fmtK(u.cacheRead)}（${u.context ? Math.round((u.cacheRead / u.context) * 100) : 0}%）</td></tr><tr><th>新写入缓存</th><td class="num">${fmtK(u.cacheCreate)}</td></tr><tr><th>输出</th><td class="num">${fmtK(u.output)}</td></tr><tr><th>花费</th><td class="num">$${(u.costUsd || 0).toFixed(4)}</td></tr></table>` : '<p class="muted">说一句话之后这里就有数了。</p>'}
        </section>
        <section><h2>这场戏的文件<small>世界书 / 预设 / 记忆正文，进程用到时自己 Read</small></h2><div id="fileList" class="muted">读取中…</div></section>
        <section id="editorSlot"></section></div>`;
      r.querySelectorAll('[data-open]').forEach(b => { b.onclick = () => this.open(b.dataset.open); });
      try {
        const { files } = await api.files();
        const fl = r.querySelector('#fileList');
        fl.className = '';
        fl.innerHTML = `<table class="kv">${files.map(f => `<tr><td>${esc(f.rel)}</td><td class="num">${fmtK(f.size)} B</td><td class="num"><button class="btn" data-open="${esc(f.rel)}">改</button></td></tr>`).join('')}</table>`;
        fl.querySelectorAll('[data-open]').forEach(b => { b.onclick = () => this.open(b.dataset.open); });
      } catch (err) { r.querySelector('#fileList').textContent = err.message; }
    },
    async open(rel) {
      const slot = this.root.querySelector('#editorSlot');
      slot.innerHTML = `<div class="card"><h3>${esc(rel)}</h3><div class="body md">读取中…</div></div>`;
      const card = slot.firstElementChild;
      try { const { text } = await api.readFile(rel); editor(card, rel, text, (t) => { card.querySelector('.body').innerHTML = renderMd(t); }); card.querySelector('.body').innerHTML = renderMd(text); }
      catch (err) { card.querySelector('.body').textContent = err.message; }
      slot.scrollIntoView({ behavior: 'smooth' });
    },
    update(what) { if (what.type === 'hello' || what.type === 'turn_end' || what.type === 'config') this.paint(); },
  });

  /* 状态 */
  page({
    id: 'status', label: '状态',
    mount(root) { root.className = 'page scroll'; this.root = root; this.paint(); },
    async paint() {
      const cfg = store.cfg || {}; const S = store.state || {}; const rules = store.rules; const earned = new Map(store.trophies.map(t => [t.id, t]));
      const keys = [...new Set([...(cfg.vitals || []).map(v => v.key), ...Object.keys(S)])];
      const r = this.root;
      r.innerHTML = `<div class="page-inner">
        <section><h2>状态值<small>每拍由演出进程报，这里能手拨；拨了下一句话会带给它</small></h2>
          <table class="kv">${keys.map(k => `<tr><th>${esc(k)}</th><td>${k === '拍数' ? `<span class="muted">${esc(S[k] ?? 0)}</span>` : `<input class="val" data-key="${esc(k)}" value="${esc(S[k] ?? '')}">`}</td></tr>`).join('')}</table>
          <p style="margin-top:8px"><button class="btn primary" id="applyState">应用改动</button> <span class="muted" id="stateNote"></span></p></section>
        <section><h2>成就<small>${earned.size} / ${rules.achievements.length}</small></h2>
          <div class="trophies">${rules.achievements.map(a => { const e = earned.get(a.id); const hide = a.hidden && !e; return `<div class="trophy ${esc(a.tier || 'bronze')}${e ? '' : ' locked'}"><span class="cup">${CUP[a.tier] || '🏆'}</span><div><b>${hide ? '？？？' : esc(a.title)}</b><span>${hide ? '隐藏成就' : esc(a.desc || '')}</span><span class="muted">${e ? `第 ${e.beat} 拍达成` : esc(a.when)}</span></div></div>`; }).join('') || '<p class="muted">这场戏没设成就。</p>'}</div></section>
        <section><h2>剧情推进<small>阈值到了机器递纸条，谁开口怎么开口还是它写</small></h2>
          <table class="kv"><tr><th>条件</th><th>纸条</th><th></th></tr>${rules.triggers.map(t => `<tr><td>${esc(t.when)}</td><td>${esc(t.note)}</td><td class="num">${(cfg.firedTriggers || []).includes(t.id) ? '已触发' : ''}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">没设触发。</td></tr>'}</table>
          <p style="margin-top:8px"><button class="btn" id="editRules">改规则表</button></p><div id="rulesSlot"></div></section>
        <section><h2>背景<small>换场时机器生的图，也可以自己选</small></h2><div class="grid-imgs" id="imgs">读取中…</div><p style="margin-top:8px"><button class="btn" id="clearBg">跟着场景走</button></p></section>
        <section><h2>皮肤</h2><p>${['paper', 'jiangnan', 'night', 'terminal'].map(s => `<button class="btn${cfg.skin === s ? ' primary' : ''}" data-skin="${s}">${{ paper: '纸', jiangnan: '江南', night: '夜', terminal: '终端' }[s]}</button>`).join(' ')}</p></section></div>`;
      r.querySelector('#applyState').onclick = async () => {
        const patch = {}; r.querySelectorAll('input.val').forEach(i => { const v = i.value.trim(); if (v === '') return; const n = Number(v); patch[i.dataset.key] = Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(v) ? n : v; });
        try { const res = await api.setState(patch); r.querySelector('#stateNote').textContent = res.note || '已记下，下一句话带给它'; } catch (err) { r.querySelector('#stateNote').textContent = err.message; }
      };
      r.querySelector('#editRules').onclick = async () => {
        const slot = r.querySelector('#rulesSlot'); slot.innerHTML = '<div class="card"><h3>规则.json</h3><div class="body"></div></div>';
        const card = slot.firstElementChild; const text = JSON.stringify(rules, null, 2);
        editor(card, '规则.json', text, () => refreshHello());
      };
      r.querySelectorAll('[data-skin]').forEach(b => { b.onclick = () => api.config({ skin: b.dataset.skin }).catch(() => {}); });
      r.querySelector('#clearBg').onclick = () => api.config({ backdrop: null }).catch(() => {});
      try {
        const { images } = await api.images();
        const box = r.querySelector('#imgs');
        box.innerHTML = images.map(i => `<button data-rel="${esc(i.rel)}" class="${cfg.backdrop && cfg.backdrop.endsWith(encodeURIComponent(i.rel.split('/').pop())) ? 'on' : ''}"><img src="${esc(i.url)}" alt=""></button>`).join('') || '<p class="muted">还没有图。换场时机器会生；也可以把图放进这场戏的 素材/ 文件夹。</p>';
        box.querySelectorAll('button[data-rel]').forEach(b => { b.onclick = () => api.config({ backdrop: `${cfg.root}/${b.dataset.rel}` }).catch(() => {}); });
      } catch (err) { r.querySelector('#imgs').textContent = err.message; }
    },
    update(what) { if (['hello', 'state', 'trophy', 'config', 'turn_end'].includes(what.type)) this.paint(); },
  });

  /* 内嵌编辑器：读 → 改 → 保存（PUT file） */
  function editor(card, rel, text, onSaved) {
    const body = card.querySelector('.body');
    const tools = card.querySelector('.tools') || card.querySelector('h3').appendChild(el('<span class="tools"></span>'));
    tools.innerHTML = '<button class="btn primary" data-save>保存</button><button class="btn" data-cancel>取消</button>';
    const ta = el(`<textarea class="editor"></textarea>`); ta.value = text;
    body.replaceChildren(ta);
    tools.querySelector('[data-cancel]').onclick = () => { tools.innerHTML = '<button class="btn" data-act="edit">编辑</button>'; onSaved(text); tools.querySelector('[data-act=edit]').onclick = () => editor(card, rel, text, onSaved); };
    tools.querySelector('[data-save]').onclick = async () => {
      try {
        const r = await api.saveFile(rel, ta.value);
        text = ta.value; onSaved(text);
        tools.innerHTML = `<span class="muted">${r.reopenOnNextLine ? '已存 · 下一句话到时进程会重开' : '已存'}</span> <button class="btn" data-act="edit">编辑</button>`;
        tools.querySelector('[data-act=edit]').onclick = () => editor(card, rel, text, onSaved);
      } catch (err) { alert(`没存上：${err.message}`); }
    };
  }

  /* ── 页面路由 ── */
  let current = null;
  function show(id) {
    const def = pages.find(p => p.id === id) || pages[0];
    store.page = def.id;
    const main = $('main'); main.innerHTML = '';
    const root = document.createElement('div'); root.className = 'page'; main.appendChild(root);
    current = def; def.mount(root);
    $('pageNav').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.page === def.id)));
    tellParent();
  }
  $('pageNav').innerHTML = pages.map(p => `<button data-page="${p.id}">${p.label}</button>`).join('');
  $('pageNav').querySelectorAll('button').forEach(b => { b.onclick = () => show(b.dataset.page); });

  function tellParent() {
    try { window.parent !== window && window.parent.postMessage({ nd: 'stage', ...store.status, page: store.page, title: store.cfg?.title || null, skin: store.cfg?.skin || 'paper', root: store.cfg?.root || null }, location.origin); } catch { /* */ }
  }
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.nd === 'stage-skin') document.documentElement.dataset.skin = e.data.skin || 'paper';
    if (e.data.nd === 'stage-page') show(e.data.page);
  });

  /* ── 事件流 ── */
  async function refreshHello() { try { onEvent(await api.json('GET', 'state')); } catch { /* */ } }
  function onEvent(e) {
    switch (e.type) {
      case 'hello':
        store.cfg = e.config; store.scenes = e.scenes || []; store.memories = e.memories || []; store.trophies = e.trophies || []; store.rules = e.rules || { achievements: [], triggers: [] };
        store.state = e.state || {}; store.live = e.live || ''; store.draft = e.draft || ''; store.thinking = e.thinking || '';
        store.status = { running: !!e.running, busy: !!e.busy, queued: e.queued || 0, error: e.error || null, usage: e.usage || null };
        paintTop(); paintCast(); paintBackdrop(); break;
      case 'scene': store.live = ''; store.draft = ''; store.scenes.push(e.row); paintCast(); paintTop(); break;
      case 'draft': store.draft = e.text; store.thinking = store.thinking; break;
      case 'text': store.live += e.text; break;
      case 'thinking': store.thinking += e.text; break;
      case 'tool': break;
      case 'turn_end': store.live = ''; store.draft = ''; store.thinking = ''; if (e.usage) store.status.usage = e.usage; paintTop(); break;
      case 'status': store.status = { running: !!e.running, busy: !!e.busy, queued: e.queued || 0, error: e.error || null, usage: e.usage || store.status.usage }; if (e.state) store.state = e.state; paintTop(); paintCast(); tellParent(); break;
      case 'state': store.state = e.state || store.state; paintCast(); break;
      case 'config': store.cfg = e.config; paintTop(); paintCast(); paintBackdrop(); tellParent(); break;
      case 'trophy': store.trophies.push(e.trophy); toast(e.trophy); paintCast(); break;
      case 'backdrop': if (!store.cfg?.backdrop) { store.backdrop = e.file; paintBackdrop(); } break;
      case 'error': store.status.error = e.error; paintTop(); break;
      default: break;
    }
    current?.update?.(e);
  }
  let es = null; let retry = 1000;
  function connect() {
    es = new EventSource(`${BASE}/events`);
    es.onmessage = (m) => { retry = 1000; try { onEvent(JSON.parse(m.data)); } catch (err) { console.error(err); } };
    es.onerror = () => { es.close(); setTimeout(connect, retry); retry = Math.min(retry * 2, 15000); };
  }
  show(q.get('page') || 'stage');
  connect();
})();
