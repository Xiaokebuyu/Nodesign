/* ═══════════════════════════════════════════════════════════════
   显示器 —— 内核（2026-09-06 重写）

   结构（每个文件一个 IIFE，都挂在 window.ND 上；index.html 按顺序加载，最后 ND.boot()）：
     render.js   纯渲染小工具（ND.r）
     app.js      这里：api / store / 事件流 / 页面路由 / 顶栏 / 弹条 / 停靠偏好
     panel.js    侧栏（人物 + 状态面板），跟着滚动换"此刻说话的人"
     story.js    故事页（正文流 / 思考容器 / 选项与输入 / 回退与分叉）
     pages.js    角色 / 记忆 / 设定 / 状态 四页
     opening.js  开场页（写法预设 / 卡上的可选条目 / 开始）
   本页不存任何真相，刷新就是重拉 hello。
   ═══════════════════════════════════════════════════════════════ */
(() => {
  const ND = (window.ND = window.ND || {});
  const { esc, el, fmtK, cupSvg } = ND.r;
  const BASE = location.pathname.replace(/\/view\/?$/, '');
  const q = new URLSearchParams(location.search);
  const EMBED = q.get('embed') === '1';
  if (EMBED) document.body.classList.add('embed');
  const $ = (id) => document.getElementById(id);
  ND.EMBED = EMBED; ND.$ = $;

  /* ── 本机偏好（停靠侧 / 收起 / 选项折叠 / 思考展开）── 只是这个浏览器的方便，丢了不心疼 */
  const prefs = {
    get(k, d) { try { const v = localStorage.getItem(`nd:stage:${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(`nd:stage:${k}`, JSON.stringify(v)); } catch { /* 私密窗口等 */ } },
  };
  ND.prefs = prefs;

  /* ── api ── */
  const api = {
    async json(method, path, body) {
      const res = await fetch(`${BASE}/${path}`, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
      const text = await res.text();
      let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      if (!res.ok) throw new Error(data?.error || res.statusText);
      return data;
    },
    say: (text, check) => api.json('POST', 'say', check ? { text, check } : { text }),
    start: () => api.json('POST', 'start', {}),
    stop: () => api.json('POST', 'stop'),
    config: (patch) => api.json('PATCH', 'config', patch),
    setState: (patch) => api.json('POST', 'state', patch),
    files: () => api.json('GET', 'files'),
    readFile: (p) => api.json('GET', `file?path=${encodeURIComponent(p)}`),
    saveFile: (p, text) => api.json('PUT', 'file', { path: p, text }),
    deleteMemory: (name, who) => api.json('DELETE', `memory?name=${encodeURIComponent(name)}${who ? `&who=${encodeURIComponent(who)}` : ''}`),
    images: () => api.json('GET', 'images'),
    presets: () => api.json('GET', 'presets'),
    lore: () => api.json('GET', 'lore'),
    models: () => api.json('GET', 'models'),
    uploadPreset: (name, data) => api.json('POST', 'preset', { name, data }),
    open: (body) => api.json('POST', 'open', body),
    lines: () => api.json('GET', 'lines'),
    rewind: (rowId) => api.json('POST', 'rewind', { rowId }),
    fork: (rowId, name) => api.json('POST', 'fork', { rowId, name }),
    switchLine: (id) => api.json('POST', 'line', { id }),
    renameLine: (id, name) => api.json('PATCH', 'line', { id, name }),
    deleteLine: (id) => api.json('DELETE', `line?id=${encodeURIComponent(id)}`),
  };
  ND.api = api;

  /* ── store ── */
  const store = {
    cfg: null, scenes: [], memories: [], trophies: [], rules: { achievements: [], triggers: [] }, castOptions: {},
    state: {}, status: { running: false, busy: false, queued: 0, error: null, usage: null },
    live: '', draft: '', thinking: '', backdrop: null, sending: false, page: 'story', lore: [], panels: {},
    activeSpeakers: [], activeScene: '',
  };
  ND.store = store;
  ND.lastStage = () => { for (let i = store.scenes.length - 1; i >= 0; i--) if (store.scenes[i].by === 'stage') return store.scenes[i]; return null; };
  ND.lastScene = () => { for (let i = store.scenes.length - 1; i >= 0; i--) if (store.scenes[i].scene) return store.scenes[i].scene; return ''; };
  ND.vitalOf = (key) => (store.cfg?.vitals || []).find(v => v.key === key) || null;
  ND.labelOf = (key) => ND.vitalOf(key)?.label || key;
  /** 故事还没开过场：记录为空，也没点过「开始」 */
  ND.needsOpening = () => !!store.cfg && !store.scenes.length && !store.cfg.opened && !store.status.busy;

  /* ── 顶栏 ── */
  const STATUS_TEXT = () => {
    const st = store.status;
    if (st.error) return '出错了';
    if (!store.cfg) return '还没有这个故事';
    if (st.running) return st.busy ? '正在回复' : (st.queued ? `排着 ${st.queued} 句` : '等你');
    return store.scenes.length ? '已停下 · 说一句就接上' : '还没开始';
  };
  function paintTop() {
    const st = store.status;
    $('title').textContent = store.cfg?.title || '故事';
    $('sceneText').textContent = store.activeScene || ND.lastScene();
    $('statusDot').className = `dot ${st.running ? (st.busy ? 'busy' : 'on') : ''}`;
    const s = $('statusText'); s.textContent = STATUS_TEXT(); s.className = `pill status${st.error ? ' err' : ''}`;
    const u = st.usage;
    $('ctxPill').textContent = u ? `上下文 ${fmtK(u.context)} · 缓存 ${u.context ? Math.round((u.cacheRead / u.context) * 100) : 0}%` : '';
    $('ctxPill').title = u ? `上一轮：输入 ${fmtK(u.input)} · 缓存读 ${fmtK(u.cacheRead)} · 缓存写 ${fmtK(u.cacheCreate)} · 输出 ${fmtK(u.output)} · $${(u.costUsd || 0).toFixed(4)} · ${(u.durationMs / 1000).toFixed(1)}s` : '';
    document.documentElement.dataset.skin = store.cfg?.skin || 'paper';
    const cur = (store.cfg?.lines || []).find(l => l.id === store.cfg?.currentLine);
    const lb = $('lineBtn');
    lb.hidden = !store.cfg || (store.cfg.lines || []).length < 2;
    lb.innerHTML = `${esc(cur?.name || '主线')} <i>▾</i>`;
  }
  ND.paintTop = paintTop;
  function paintBackdrop() {
    const b = $('backdrop');
    const url = store.cfg?.backdrop || store.backdrop;
    if (url) { b.style.backgroundImage = `url("${url}")`; b.classList.add('on'); } else b.classList.remove('on');
    document.documentElement.dataset.backdrop = url ? 'on' : 'off';   // 墙在有图时变薄纱（app.css 材质层）
    const pb = $('peekBtn'); if (pb) pb.hidden = !url || EMBED;
  }

  /* ── 停靠：侧栏停左 / 停右 / 收成一条；窄屏是抽屉 ── */
  const dock = { side: prefs.get('dock', 'left'), mode: prefs.get('cast', 'open') };
  function applyDock() {
    document.documentElement.dataset.dock = dock.side === 'right' ? 'right' : 'left';
    document.documentElement.dataset.cast = dock.mode;
  }
  ND.dock = {
    /** 换边：先朝当前那边滑出去，换了边再从新的那边滑进来（直接换 grid 区域会硬跳） */
    flip() {
      const cast = $('cast'); const from = dock.side;
      dock.side = from === 'right' ? 'left' : 'right'; prefs.set('dock', dock.side);
      if (!cast) { applyDock(); return; }
      cast.classList.add(from === 'right' ? 'slide-right' : 'slide-left');
      const app = document.querySelector('.app'); app?.classList.add('flipping');   // 轨道顺序换了不能插值，否则正文宽度乱跳
      setTimeout(() => {
        applyDock();
        setTimeout(() => app?.classList.remove('flipping'), 50);
        cast.classList.remove('slide-left', 'slide-right');
        cast.classList.add('no-anim', dock.side === 'right' ? 'slide-right' : 'slide-left');
        void cast.offsetWidth;   // 先站到新那边的屏外，再放开动画滑进来
        cast.classList.remove('no-anim');
        setTimeout(() => cast.classList.remove('slide-left', 'slide-right'), 20);
      }, 240);
    },
    toggle() { dock.mode = dock.mode === 'mini' ? 'open' : 'mini'; prefs.set('cast', dock.mode); applyDock(); },
    /** 非故事页侧栏没必要撑开：临时收成一条，回故事页恢复用户自己的偏好（不写偏好） */
    forPage(id) { document.documentElement.dataset.cast = id === 'story' ? dock.mode : 'mini'; },
    drawer(open) { document.documentElement.dataset.cast = open ? 'drawer' : dock.mode; },
    get side() { return dock.side; }, get mode() { return dock.mode; },
  };

  /* ── 弹条：奖杯 / 状态变化 ── */
  function toast(node, ms) {
    $('toasts').appendChild(node);
    setTimeout(() => { node.classList.add('out'); setTimeout(() => node.remove(), 600); }, ms);
  }
  ND.trophyToast = (t) => toast(el(`<div class="toast"><span class="cupbox">${cupSvg(t.tier)}</span><div><span class="kicker">成就达成 · ${esc(ND.r.CUP[t.tier] || '铜')}</span><b>${esc(t.title)}</b>${t.desc ? `<span>${esc(t.desc)}</span>` : ''}</div></div>`), 5600);
  /** 状态变了：右上角报一声。数值给增减，文字给前后 */
  ND.stateToast = (changed, before) => {
    const rows = [];
    for (const [k, v] of Object.entries(changed || {})) {
      if (k === '拍数') continue;
      const old = before?.[k];
      if (old === v) continue;
      const label = esc(ND.labelOf(k));
      const a = Number(old), b = Number(v);
      if (Number.isFinite(a) && Number.isFinite(b) && old !== undefined) {
        const d = b - a; if (!d) continue;
        rows.push(`<span>${label} <b class="mono">${esc(old)} → ${esc(v)}</b> <em class="delta${d < 0 ? ' down' : ''}">${d > 0 ? '+' : ''}${d}</em></span>`);
      } else rows.push(`<span>${label} ${old !== undefined ? `<b class="mono">${esc(old)}</b> → ` : ''}<b class="mono">${esc(v)}</b></span>`);
    }
    if (rows.length) toast(el(`<div class="toast state"><div class="kv"><span class="kicker">状态变化</span>${rows.join('')}</div></div>`), 4200);
  };

  /* ── 页面注册 / 路由 ── */
  ND.pages = [];
  ND.page = (def) => ND.pages.push(def);
  let current = null;
  ND.show = function show(id) {
    const def = ND.pages.find(p => p.id === id) || ND.pages[0];
    store.page = def.id;
    const main = $('main'); main.innerHTML = '';
    const root = document.createElement('div'); root.className = 'page'; main.appendChild(root);
    current = def; def.mount(root);
    ND.dock.forPage(def.id);
    $('pageNav').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.page === def.id)));
    tellParent();
  };
  ND.current = () => current;

  function tellParent() {
    try { window.parent !== window && window.parent.postMessage({ nd: 'stage', ...store.status, page: store.page, title: store.cfg?.title || null, skin: store.cfg?.skin || 'paper', root: store.cfg?.root || null }, location.origin); } catch { /* */ }
  }
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.nd === 'stage-skin') document.documentElement.dataset.skin = e.data.skin || 'paper';
    if (e.data.nd === 'stage-page') ND.show(e.data.page);
  });

  /* ── 事件流：SSE 只改 store，然后通知侧栏和当前页 ── */
  const hooks = [];
  ND.onEvent = (fn) => hooks.push(fn);
  function fanout(e) {
    for (const fn of hooks) { try { fn(e); } catch (err) { console.error(err); } }
    try { current?.update?.(e); } catch (err) { console.error(err); }
  }
  async function refreshHello() { try { onEvent(await api.json('GET', 'state')); } catch { /* */ } }
  ND.refreshHello = refreshHello;
  function onEvent(e) {
    switch (e.type) {
      case 'hello':
        store.cfg = e.config; store.scenes = e.scenes || []; store.memories = e.memories || []; store.trophies = e.trophies || []; store.rules = e.rules || { achievements: [], triggers: [] };
        store.castOptions = e.castOptions || {};
        store.state = e.state || {}; store.live = e.live || ''; store.draft = e.draft || ''; store.thinking = e.thinking || '';
        store.status = { running: !!e.running, busy: !!e.busy, queued: e.queued || 0, error: e.error || null, usage: e.usage || null };
        store.activeScene = ''; store.backdrop = e.backdrop || null;
        paintTop(); paintBackdrop(); break;
      case 'scene': store.live = ''; store.draft = ''; store.scenes.push(e.row); paintTop(); break;
      case 'draft': store.draft = e.text; break;
      case 'text': store.live += e.text; break;
      case 'thinking': store.thinking += e.text; break;
      case 'turn_end': store.live = ''; store.draft = ''; store.thinking = ''; store.lore = []; if (e.usage) store.status.usage = e.usage; paintTop(); break;
      case 'lore': store.lore = e.titles || []; break;
      case 'status': store.status = { running: !!e.running, busy: !!e.busy, queued: e.queued || 0, error: e.error || null, usage: e.usage || store.status.usage }; if (e.state) store.state = e.state; paintTop(); tellParent(); break;
      case 'state': { const before = store.state; store.state = e.state || store.state; if (!EMBED) ND.stateToast(e.changed || e.state, before); e.before = before; break; }
      case 'config': store.cfg = e.config; paintTop(); paintBackdrop(); tellParent(); break;
      case 'trophy': store.trophies.push(e.trophy); if (!EMBED) ND.trophyToast(e.trophy); break;
      case 'backdrop': if (!store.cfg?.backdrop) { store.backdrop = e.file; paintBackdrop(); } break;
      case 'error': store.status.error = e.error; paintTop(); break;
      case 'reload': refreshHello(); return;
      case 'image_pending': if (!ND.EMBED) ND.flash('对方在画一张插图，画好会出现在正文里'); return;
      case 'image_failed': if (!ND.EMBED) ND.flash(`插图没画出来：${e.error || ''}`, true); return;
      default: break;
    }
    fanout(e);
  }
  let es = null; let retry = 1000;
  function connect() {
    es = new EventSource(`${BASE}/events`);
    es.onmessage = (m) => { retry = 1000; try { onEvent(JSON.parse(m.data)); } catch (err) { console.error(err); } };
    es.onerror = () => { es.close(); setTimeout(connect, retry); retry = Math.min(retry * 2, 15000); };
  }

  /* ── 线路菜单（顶栏那颗按钮） ── */
  function closeMenus() { document.querySelectorAll('.menu').forEach(m => m.remove()); }
  async function lineMenu(anchor) {
    closeMenus();
    let lines = [];
    try { lines = (await api.lines()).lines; } catch { lines = store.cfg?.lines || []; }
    const m = el(`<div class="menu" role="menu"><div class="hd">线路</div>${lines.map(l => `<div class="row${l.current ? ' on' : ''}" data-id="${esc(l.id)}"><span class="nm">${esc(l.name)}</span><span class="n">${l.beats} 段${l.hasMemory ? '' : ' · 无记忆'}</span>${l.id !== 'main' ? `<button class="mini" data-act="rename">改名</button><button class="mini" data-act="del">删</button>` : ''}</div>`).join('')}<div class="foot">在正文里把鼠标停在你说过的某一句上，能「回到这句之前」或「从这里分叉」。</div></div>`);
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.top = `${r.bottom + 6}px`; m.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
    m.querySelectorAll('.row').forEach(row => {
      row.onclick = async (ev) => {
        const act = ev.target.dataset?.act; const id = row.dataset.id;
        try {
          if (act === 'del') { ev.stopPropagation(); if (await ND.confirm({ title: '删掉这条线？', body: '这条线上的记录会删掉，主线不受影响。', ok: '删掉', danger: true })) await api.deleteLine(id); }
          else if (act === 'rename') { ev.stopPropagation(); const name = await ND.prompt({ title: '给这条线起个名字', value: lines.find(l => l.id === id)?.name || '' }); if (name) await api.renameLine(id, name); }
          else await api.switchLine(id);
        } catch (err) { ND.flash(err.message, true); }
        closeMenus();
      };
    });
    setTimeout(() => document.addEventListener('click', (ev) => { if (!m.contains(ev.target)) closeMenus(); }, { once: true }), 0);
  }

  /* ── 小对话框（不用 window.confirm：iframe 里会卡住父页） ── */
  function dialog(html, wire) {
    return new Promise((resolve) => {
      const veil = el(`<div class="dlg-veil"><div class="dlg" role="dialog">${html}</div></div>`);
      const done = (v) => { veil.remove(); resolve(v); };
      veil.addEventListener('click', (ev) => { if (ev.target === veil) done(null); });
      document.body.appendChild(veil);
      wire(veil.firstElementChild, done);
    });
  }
  ND.dialog = dialog;
  ND.confirm = ({ title, body, ok = '好', cancel = '取消', danger = false }) => dialog(
    `<h3>${esc(title)}</h3><p class="muted" style="font-size:13px;margin:0">${esc(body || '')}</p><div class="foot"><button class="btn" data-c>${esc(cancel)}</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(ok)}</button></div>`,
    (d, done) => { d.querySelector('[data-c]').onclick = () => done(false); d.querySelector('[data-ok]').onclick = () => done(true); },
  );
  ND.prompt = ({ title, value = '', ok = '好' }) => dialog(
    `<h3>${esc(title)}</h3><input class="val" value="${esc(value)}"><div class="foot"><button class="btn" data-c>取消</button><button class="btn primary" data-ok>${esc(ok)}</button></div>`,
    (d, done) => { const i = d.querySelector('input'); i.focus(); i.select(); d.querySelector('[data-c]').onclick = () => done(null); d.querySelector('[data-ok]').onclick = () => done(i.value.trim()); i.onkeydown = (ev) => { if (ev.key === 'Enter') done(i.value.trim()); }; },
  );
  /** 顶栏右侧一闪而过的一句话（出错也走这儿） */
  ND.flash = (text, err) => { const n = el(`<div class="toast state"><div class="kv"><span class="kicker">${err ? '没成' : '好了'}</span><span${err ? ' style="color:var(--red)"' : ''}>${esc(text)}</span></div></div>`); toast(n, 3600); };

  /* ── 起 ── */
  /** 顶栏页签（面板页是 hello 之后才注册的，所以要能重画） */
  ND.paintNav = function paintNav() {
    $('pageNav').innerHTML = ND.pages.map(p => `<button data-page="${esc(p.id)}"${p.panelId ? ' class="panel-tab"' : ''} aria-pressed="${String(p.id === store.page)}">${esc(p.label)}</button>`).join('');
    $('pageNav').querySelectorAll('button').forEach(b => { b.onclick = () => ND.show(b.dataset.page); });
    if (matchMedia('(max-width:760px)').matches) $('pageNav')?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });   // 手机底部页签条：当前页签滑进视野
  };
  ND.boot = function boot() {
    applyDock();
    const measure = prefs.get('measure', null);   // 正文宽度（故事页的拖把改的）
    if (measure) document.documentElement.style.setProperty('--measure', `${measure}px`);
    ND.paintNav();
    $('lineBtn').onclick = (ev) => { ev.stopPropagation(); lineMenu($('lineBtn')); };
    $('castToggle').onclick = () => ND.dock.drawer(document.documentElement.dataset.cast !== 'drawer');
    const peek = (on) => { document.documentElement.dataset.peek = on ? 'on' : 'off'; $('peekBtn').classList.toggle('on', on); };
    $('peekBtn').onclick = () => peek(document.documentElement.dataset.peek !== 'on');
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.documentElement.dataset.peek === 'on') peek(false); });
    const veil = prefs.get('veil', null); if (veil !== null && veil !== undefined) document.documentElement.style.setProperty('--veil-a', String(veil));   // 0 也算（完全透明）
    $('drawerVeil').onclick = () => ND.dock.drawer(false);
    ND.panel?.init?.();
    ND.show(q.get('page') || 'story');
    connect();
  };
})();
