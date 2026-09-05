/* ═══════════════════════════════════════════════════════════════
   显示器 —— 故事页（2026-09-06 重写）

   正文流只渲染最近 40 段，往上翻再加载（记录长了不卡）。
   流式那一段是一个**常驻节点**，按段落做差分：只改变了的那一段落，别的一个字不碰 ——
   09-05 那版每来一个字就把整段 innerHTML 重写一遍、还带入场动画，所以文字一直在闪。
   思考走一个常驻的过程容器（参考侧边栏的 Timeline 节点），这一段落地后它冻成一枚折叠的小条留在那段上面。
   工具之外的字（"好感度 +2…"那种）只进过程容器里的「台下的话」，不进正文。
   滚动时看哪一段，侧栏就换成谁在说话（IntersectionObserver）。
   ═══════════════════════════════════════════════════════════════ */
(() => {
  const ND = (window.ND = window.ND || {});
  const { esc, el, renderProse, paragraphs, inlineProse, fmtTime } = ND.r;
  const store = ND.store; const api = ND.api; const $ = ND.$;
  const WINDOW = 40;
  const CHEV = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

  ND.page({
    id: 'story', label: '故事',
    mount(root) {
      this.root = root;
      if (ND.needsOpening()) { this.openingShown = true; ND.opening.mount(root); return; }
      this.openingShown = false;
      root.innerHTML = `<div class="beats" id="beats"><div class="beats-inner" id="inner"></div></div>
        <div class="handles" id="handles" data-open="${ND.prefs.get('opts', 1)}"><div class="handles-inner">
          <div id="chips"></div>
          <div class="opt-hd" id="optHd">${CHEV}<span>选项</span><span class="n" id="optN"></span></div>
          <div class="options" id="options"></div>
          <div class="say"><textarea id="say" rows="1" placeholder="${window.innerWidth < 640 ? '说你要做什么、要说什么' : '说你要做什么、要说什么（Enter 发送，Shift+Enter 换行）'}"></textarea><button id="sayGo">发送</button></div>
          <div class="say-foot"><div class="note" id="note"></div><span class="hint" id="hint"></span></div>
        </div></div>`;
      this.shown = Math.min(store.scenes.length, WINDOW);
      this.stick = true;
      const beats = $('beats');
      beats.addEventListener('scroll', () => { this.stick = beats.scrollHeight - beats.scrollTop - beats.clientHeight < 140; });
      $('inner').addEventListener('click', (e) => this.onClick(e));
      $('optHd').onclick = () => { const h = $('handles'); const v = h.dataset.open === '1' ? 0 : 1; h.dataset.open = String(v); ND.prefs.set('opts', v); };
      this.paintAll();
      this.observe();
    },
    /* ── 正文宽度拖把：拖右侧竖杠改 --measure（两边一起动），双击复原 ── */
    grip() {
      const inner = $('inner'); if (!inner || ND.EMBED || inner.querySelector('.grip') || matchMedia('(max-width:760px)').matches) return;   // 手机：没有拖把也没有它的提示
      const g = el('<div class="grip" title="拖动改正文宽度，双击复原"><span class="lbl">拖动调宽窄 · 双击复原</span></div>');
      inner.appendChild(g);
      const root = document.documentElement;
      // 纸比屏高，把手要跟着可视区居中，不然它在纸的正中、多半在屏外（站主：根本没看见）
      const beats = $('beats');
      const place = () => { g.style.top = `${Math.max(0, beats.scrollTop + beats.clientHeight * 0.5 - inner.offsetTop - 32)}px`; };
      beats.addEventListener('scroll', place); window.addEventListener('resize', place); place();
      if (!ND.prefs.get('gripHint', false)) { ND.prefs.set('gripHint', true); setTimeout(() => ND.flash('正文右边那枚小纸签能拖：拖宽拖窄，双击复原'), 1500); }
      let tip = null;
      g.onpointerdown = (e) => {
        e.preventDefault(); g.setPointerCapture(e.pointerId); g.classList.add('on');
        const startX = e.clientX; const startW = inner.getBoundingClientRect().width;
        tip = el('<div class="grip-tip"></div>'); document.body.appendChild(tip);
        const move = (ev) => {
          const w = Math.max(420, Math.min(window.innerWidth - 80, Math.round(startW + (ev.clientX - startX) * 2)));
          root.style.setProperty('--measure', `${w}px`); ND.prefs.set('measure', w);
          tip.textContent = `${w}px`; tip.style.left = `${ev.clientX + 12}px`; tip.style.top = `${ev.clientY - 28}px`;
        };
        const up = () => { g.classList.remove('on'); tip?.remove(); tip = null; g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); };
        g.addEventListener('pointermove', move); g.addEventListener('pointerup', up);
      };
      g.ondblclick = () => { root.style.removeProperty('--measure'); ND.prefs.set('measure', null); };
    },

    /* ── 一行 → HTML ── */
    actions(r) {
      if (ND.EMBED) return '';
      return `<div class="beat-actions"><button data-act="rewind" data-id="${esc(r.id)}" title="这句和之后的都不算数了">回到这句之前</button><button data-act="fork" data-id="${esc(r.id)}" title="原来这条线留着，另开一条从这里继续">从这里分叉</button></div>`;
    },
    beatHtml(r, i) {
      if (r.by === 'user') return `<article class="beat me" data-id="${esc(r.id)}" data-i="${i}" tabindex="0"><div class="tagline">你<time>${fmtTime(r.at)}</time></div>${renderProse(r.text)}${this.actions(r)}</article>`;
      if (r.by === 'system') return `<div class="beat sys" data-id="${esc(r.id)}" data-i="${i}" tabindex="0"><span>${esc(r.text)}</span>${this.actions(r)}</div>`;
      if (r.by === 'user-state') return `<div class="beat sys" data-i="${i}"><span>你改了状态：${esc(Object.entries(r.state || {}).map(([k, v]) => `${ND.labelOf(k)} ${v}`).join(' · '))}</span></div>`;
      if (r.by === 'dice') return this.diceRow(r, i);
      if (r.by === 'image') return `<figure class="beat image" data-id="${esc(r.id)}" data-i="${i}"><img src="${esc(r.url || '')}" alt="${esc(r.caption || '')}" loading="lazy">${r.caption ? `<figcaption>${esc(r.caption)}</figcaption>` : ''}</figure>`;
      const speakers = (r.speakers || []).join('|');
      return `<article class="beat" data-id="${esc(r.id)}" data-i="${i}" data-speakers="${esc(speakers)}"${r.scene ? ` data-scene="${esc(r.scene)}"` : ''}>${r.scene ? `<div class="scene-tag">${esc(r.scene)}</div>` : ''}${renderProse(r.text)}</article>`;
    },

    /* ── 整页 ── */
    paintAll() {
      const inner = $('inner'); if (!inner) return;
      const rows = store.scenes;
      // 挂载时 hello 可能还没到（shown 算成 0），hello 到了再算一次；用户点过"更早"就保住他展开的数量
      this.shown = Math.min(rows.length, Math.max(this.shown || 0, WINDOW));
      const from = Math.max(0, rows.length - this.shown);
      const more = from > 0 ? `<button class="more" data-act="more">查看更早的 ${from} 段</button>` : '';
      inner.innerHTML = (!rows.length && !store.draft && !store.thinking)
        ? `<div class="empty">${store.cfg ? '还是空的。说一句话，故事就开始了。' : '这里还没有故事。'}</div>`
        : more + rows.slice(from).map((r, k) => this.beatHtml(r, from + k)).join('');
      inner.appendChild(el('<div class="process" id="process" data-open="auto" hidden><div class="hd">' + ND.markSvg(store.cfg?.brand, 15) + '<b></b><span class="n"></span>' + CHEV + '</div><div class="body"></div></div>'));
      inner.appendChild(el('<article class="beat draft" id="draft" hidden></article>'));
      this.grip();
      $('process').querySelector('.hd').onclick = () => { const p = $('process'); p.dataset.open = p.dataset.open === '1' ? '0' : '1'; };
      this.paintProcess(); this.paintDraft(); this.paintHandles();
      this.scroll(true);
      this.observe();
    },
    /** 新的一段落地：思考条冻在它上面，正文接在流末尾 */
    append(r) {
      const inner = $('inner'); if (!inner) return;
      inner.querySelector('.empty')?.remove();
      const proc = $('process'); const draft = $('draft');
      if (r.by === 'stage' && this.frozenThinking) {
        const n = this.frozenThinking.length;
        const f = el(`<div class="process" data-open="0"><div class="hd">${ND.markSvg(store.cfg?.brand, 15)}<b>想了 ${n} 字</b>${CHEV}</div><div class="body">${esc(this.frozenThinking)}</div></div>`);
        f.querySelector('.hd').onclick = () => { f.dataset.open = f.dataset.open === '1' ? '0' : '1'; };
        inner.insertBefore(f, proc);
        this.frozenThinking = '';
      }
      const node = el(this.beatHtml(r, store.scenes.length - 1));
      node.classList.add('settled');
      inner.insertBefore(node, proc);
      this.shown += 1;
      if (draft) { draft.hidden = true; draft.innerHTML = ''; }
      this.paintProcess(); this.paintHandles(); this.scroll(false); this.observe();
    },

    /* ── 过程容器：思考 + 台下的话 ── */
    paintProcess() {
      const p = $('process'); if (!p) return;
      const th = store.thinking || ''; const live = store.live || ''; const lore = store.lore || [];
      const busy = store.status.busy;
      if (!th && !live && !lore.length) { p.hidden = true; return; }
      p.hidden = false;
      p.classList.toggle('live', busy);
      const hd = p.querySelector('.hd b'); const n = p.querySelector('.hd .n');
      hd.textContent = busy ? (store.draft ? '正在写这一段' : (th ? '正在想' : '正在回复')) : `想了 ${th.length} 字`;
      n.textContent = th ? `${th.length} 字` : '';
      const body = p.querySelector('.body');
      const tail = busy && p.dataset.open !== '1' ? th.slice(-900) : th;
      const want = `${esc(tail)}${lore.length ? `<div class="lore">带上了设定：${esc(lore.join(' · '))}</div>` : ''}${live ? `<div class="aside">${esc(live.slice(-400))}</div>` : ''}`;
      if (body.innerHTML !== want) { body.innerHTML = want; if (busy) body.scrollTop = body.scrollHeight; }
      if (th) this.frozenThinking = th;
    },
    /* ── 流式正文：按段落差分，只改变了的那段 ── */
    paintDraft() {
      const d = $('draft'); if (!d) return;
      const text = store.draft || '';
      if (!text) { d.hidden = true; d.innerHTML = ''; return; }
      d.hidden = false;
      const paras = paragraphs(text);
      const kids = [...d.children];
      paras.forEach((ptext, i) => {
        const html = inlineProse(ptext);
        const node = kids[i];
        if (node) { if (node.dataset.src !== ptext) { node.innerHTML = html; node.dataset.src = ptext; } }
        else { const np = document.createElement('p'); np.innerHTML = html; np.dataset.src = ptext; d.appendChild(np); }
      });
      for (let i = paras.length; i < kids.length; i++) kids[i].remove();
      this.scroll(false);
    },
    scroll(force) {
      const b = $('beats'); if (!b) return;
      if (force || this.stick) setTimeout(() => { b.scrollTop = b.scrollHeight; }, 0);   // 不用 rAF：卡片预览里 rAF 被冻住
    },

    /** 判定行：名目 · 骰式 = 点数（+修正）vs 难度 → 成败 */
    diceRow(r, i) {
      const OUT = { crit: '大成功', success: '成功', fail: '失败', fumble: '大失败' };
      const mod = r.modifier ? (r.modifier > 0 ? ` +${r.modifier}` : ` ${r.modifier}`) : '';
      const faces = (r.rolls || []).length > 1 ? `[${(r.rolls || []).join(', ')}]` : String((r.rolls || [])[0] ?? '');
      const dice = `d${r.sides}${r.count > 1 ? `×${r.count}` : ''}${r.advantage === 'adv' ? '（优势）' : r.advantage === 'dis' ? '（劣势）' : ''}`;
      const vs = r.dc !== null && r.dc !== undefined ? ` <span class="vs">vs 难度 ${esc(r.dc)}</span> <em class="${esc(r.outcome || '')}">${OUT[r.outcome] || ''}</em>` : '';
      return `<div class="beat dice ${esc(r.outcome || '')}" data-i="${i}"><span class="why">${esc(r.reason || '')}</span> · ${esc(dice)} = ${esc(faces)}${mod ? esc(mod) : ''}${(r.rolls || []).length > 1 || mod ? ` = <b>${esc(r.total)}</b>` : ''}${vs}</div>`;
    },

    /* ── 选项 + 输入 ── */
    paintHandles() {
      const box = $('options'); if (!box) return;
      const last = ND.lastStage(); const lastRow = store.scenes[store.scenes.length - 1];
      const spent = lastRow && (lastRow.by === 'user' || lastRow.by === 'system');
      let list = (last && !spent) ? (last.choices || []) : [];
      if (!list.length && store.cfg && !spent && last) list = [{ label: '继续', prompt: '继续。' }];
      const dis = (!store.cfg || store.status.busy || store.sending) ? ' disabled' : '';
      const CAT = /^[（(\[【]?\s*(推进主线|主线|人际|人际关系|意外|意想不到|合理但意想不到|剑走偏锋|支线|日常)\s*[）)\]】]?[。.]?$/;   // 类别词不是动作意图，不给玩家看（tools.js 同一条）
      box.innerHTML = list.map((c) => {
        let label = c.label || ''; let hint = c.hint && !CAT.test(c.hint.trim()) ? c.hint : '';
        if (CAT.test(label.trim()) && hint) { label = hint; hint = ''; }   // 老记录里按钮写的是"主线"、小字才是动作：换过来
        const chk = c.check && c.check.dc ? `<i class="chk" title="点下去机器代掷，成败随这句话一起告诉对方"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/><circle cx="16" cy="8" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="8" cy="16" r="1.4" fill="currentColor"/><circle cx="16" cy="16" r="1.4" fill="currentColor"/></svg>${esc(c.check.label || '判定')} · d${esc(c.check.sides || 20)}${c.check.modifier ? (c.check.modifier > 0 ? ` +${esc(c.check.modifier)}` : ` ${esc(c.check.modifier)}`) : ''} vs ${esc(c.check.dc)}</i>` : '';
        return `<button class="handle${chk ? ' checked' : ''}" data-p="${esc(c.prompt || c.label)}"${chk ? ` data-check="${esc(JSON.stringify(c.check))}"` : ''}${dis}><b>${esc(label)}</b>${hint ? `<span>${esc(hint)}</span>` : ''}${chk}</button>`;
      }).join('');
      $('optN').textContent = list.length ? `${list.length} 个` : (store.status.busy ? '等这一段写完' : '');
      const chips = $('chips'); if (chips) { chips.innerHTML = ND.panelChips ? ND.panelChips() : ''; chips.querySelectorAll('[data-page]').forEach(b => { b.onclick = () => ND.show(b.dataset.page); }); }
      $('optHd').style.display = list.length || store.status.busy ? '' : 'none';
      box.querySelectorAll('.handle').forEach((b) => { b.onclick = () => { let chk = null; try { chk = b.dataset.check ? JSON.parse(b.dataset.check) : null; } catch { chk = null; } this.fire(b.dataset.p, chk); }; });
      const ta = $('say'); const go = $('sayGo');
      go.disabled = !store.cfg || store.sending; ta.disabled = !store.cfg;
      const send = () => { const v = ta.value.trim(); if (v) { this.fire(v); ta.value = ''; ta.style.height = 'auto'; } };
      go.onclick = send;
      ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } };
      ta.oninput = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; };
      $('hint').textContent = store.status.busy ? '正在回复，你说的会排在后面' : (store.status.running ? '' : (store.scenes.length ? '进程已停下，说一句就接上（第一句慢一点）' : ''));
    },
    async fire(text, check = null) {
      if (!text || store.sending || ND.EMBED) return;
      store.sending = true; this.note(''); this.paintHandles();
      try { await api.say(text, check); } catch (err) { this.note(`没送出去：${err.message}`, true); }
      finally { store.sending = false; this.paintHandles(); }
    },
    note(t, err) { const n = $('note'); if (n) { n.textContent = t || ''; n.className = 'note' + (err ? ' err' : ''); } },

    /* ── 点击：更早 / 回退 / 分叉 ── */
    async onClick(e) {
      const btn = e.target.closest('button[data-act]'); if (!btn) return;
      if (btn.dataset.act === 'more') {
        const b = $('beats'); const keep = b.scrollHeight - b.scrollTop;
        this.shown = Math.min(store.scenes.length, this.shown + WINDOW);
        this.paintAll();
        b.scrollTop = b.scrollHeight - keep;   // 位置不跳
        return;
      }
      const row = store.scenes.find(r => r.id === btn.dataset.id); if (!row) return;
      const idx = store.scenes.indexOf(row);
      const after = store.scenes.slice(idx).filter(r => r.by === 'stage').length;
      const noAnchor = idx > 0 && !store.scenes.slice(idx).some(r => (r.by === 'user' || r.by === 'system') && r.uuid);
      const fork = btn.dataset.act === 'fork';
      const choice = await ND.dialog(
        `<h3>${fork ? '从这里分叉' : '回到这句之前'}</h3>
         <div class="lbl">这一句之后</div>
         <p class="muted" style="margin:0 0 4px;font-size:12.5px">${after ? `对方写的 ${after} 段` : '还没有对方的回复'}${fork ? '不会带进新线，' : '会被丢掉，'}${noAnchor ? '<span style="color:var(--warn)">这一句之前的记录没有记忆锚点（早期记录），对方会忘掉前面发生的事，只剩记忆索引。</span>' : '对方的记忆也回到那时候。'}</p>
         <div class="lbl">原来这条线</div>
         <button class="choice${fork ? '' : ' on'}" data-mode="rewind"><b>覆盖掉</b><span>这一句和之后的从记录里删掉，就当没发生过。</span></button>
         <button class="choice${fork ? ' on' : ''}" data-mode="fork"><b>留着，另开一条线</b><span>现在这条线一字不动，另开一条从这里继续。两条都在顶栏的线路菜单里。</span></button>
         <div class="foot"><button class="btn" data-c>取消</button><button class="btn primary" data-ok>${fork ? '分叉' : '回退'}</button></div>`,
        (d, done) => {
          let mode = fork ? 'fork' : 'rewind';
          d.querySelectorAll('.choice').forEach(c => { c.onclick = () => { mode = c.dataset.mode; d.querySelectorAll('.choice').forEach(x => x.classList.toggle('on', x === c)); d.querySelector('[data-ok]').textContent = mode === 'fork' ? '分叉' : '回退'; }; });
          d.querySelector('[data-c]').onclick = () => done(null);
          d.querySelector('[data-ok]').onclick = () => done(mode);
        },
      );
      if (!choice) return;
      try {
        if (choice === 'fork') { const r = await api.fork(row.id); ND.flash(r.memory === 'kept' ? '分出一条新线，已经切过去' : '分出一条新线（对方不带前文记忆）'); }
        else { const r = await api.rewind(row.id); ND.flash(r.memory === 'kept' ? `回退了 ${r.removed} 条记录` : `回退了 ${r.removed} 条记录（对方的记忆重置了）`); }
      } catch (err) { ND.flash(err.message, true); }
    },

    /* ── 滚到哪一段，侧栏就换成谁 ── */
    observe() {
      this.io?.disconnect();
      const beats = $('beats'); if (!beats) return;
      const ratios = new Map();
      this.io = new IntersectionObserver((entries) => {
        for (const en of entries) ratios.set(en.target, en.isIntersecting ? en.intersectionRatio : 0);
        let best = null; let bestR = 0;
        for (const [node, r] of ratios) if (r > bestR) { best = node; bestR = r; }
        if (!best) return;
        const i = Number(best.dataset.i);
        let scene = ''; for (let k = i; k >= 0; k--) if (store.scenes[k]?.scene) { scene = store.scenes[k].scene; break; }
        ND.setSpeakers((best.dataset.speakers || '').split('|').filter(Boolean), scene);
      }, { root: beats, threshold: [0, 0.2, 0.4, 0.6, 0.8, 1] });
      beats.querySelectorAll('.beat[data-speakers]').forEach(n => this.io.observe(n));
    },

    update(what) {
      if (this.openingShown) {
        if (!ND.needsOpening() && (what.type === 'scene' || what.type === 'hello' || what.type === 'status' || what.type === 'config')) this.mount(this.root);
        else if (what.type === 'hello' || what.type === 'config') ND.opening.mount(this.root);
        return;
      }
      if (what.type === 'scene') this.append(what.row);
      else if (what.type === 'draft') { this.paintDraft(); this.paintProcess(); }
      else if (what.type === 'text' || what.type === 'thinking' || what.type === 'lore') this.paintProcess();
      else if (what.type === 'turn_end') { this.paintDraft(); this.paintProcess(); this.paintHandles(); }
      else if (what.type === 'status' || what.type === 'panel') { this.paintHandles(); this.paintProcess(); }
      else if (what.type === 'error') this.note(`出错了：${what.error}`, true);
      else if (what.type === 'hello' || what.type === 'config') { if (ND.needsOpening()) this.mount(this.root); else this.paintAll(); }
    },
  });
})();
