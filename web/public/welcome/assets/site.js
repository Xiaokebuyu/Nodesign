(function () {
  /* ---------- 入场 ---------- */
  var els = document.querySelectorAll('.reveal');
  if (els.length) {
    function revealAll() {
      els.forEach(function (el) { el.classList.add('is-in'); });
    }
    if (!('IntersectionObserver' in window)) {
      revealAll();
    } else {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-in');
            io.unobserve(entry.target);
          }
        });
      }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 });
      els.forEach(function (el) { io.observe(el); });
      setTimeout(revealAll, 3000);
    }
  }

  /* ---------- 案例筛选 ---------- */
  var filters = document.querySelectorAll('[data-filter]');
  if (filters.length) {
    filters.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var kind = btn.getAttribute('data-filter');
        filters.forEach(function (b) { b.classList.toggle('is-on', b === btn); });
        document.querySelectorAll('.work[data-kind]').forEach(function (w) {
          w.classList.toggle('is-hidden', kind !== 'all' && w.getAttribute('data-kind') !== kind);
        });
      });
    });
  }

  /* ---------- 场景选择器 ---------- */
  var scenes = document.querySelectorAll('[data-scene]');
  if (scenes.length) {
    scenes.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.getAttribute('data-scene');
        scenes.forEach(function (b) { b.classList.toggle('is-on', b === btn); });
        document.querySelectorAll('[data-panel]').forEach(function (p) {
          p.classList.toggle('is-on', p.getAttribute('data-panel') === key);
        });
      });
    });
  }

  /* ---------- 用量计算器 ---------- */
  var vol = document.getElementById('vol');
  if (vol) {
    var volOut = document.getElementById('volOut');
    var costOut = document.getElementById('costOut');
    var perRun = 48000; /* 一次会话平均 token，取自公开的用量小票 */
    var update = function () {
      var n = Number(vol.value);
      volOut.textContent = n + ' 件';
      costOut.textContent = (n * perRun / 10000).toFixed(1) + ' 万 tok';
    };
    vol.addEventListener('input', update);
    update();
  }
})();
