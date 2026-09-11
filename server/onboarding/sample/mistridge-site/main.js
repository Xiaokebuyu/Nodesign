document.documentElement.classList.add('js');

/* 通用 tab：按钮组 [role=tablist]，按钮上 aria-controls 指向面板 */
function tabs(list, onChange) {
  const btns = [...list.querySelectorAll('[role="tab"]')];
  const pick = (btn, focus) => {
    btns.forEach(b => {
      const on = b === btn;
      b.setAttribute('aria-selected', on);
      b.tabIndex = on ? 0 : -1;
      document.getElementById(b.getAttribute('aria-controls')).hidden = !on;
    });
    if (focus) btn.focus();
    onChange && onChange(btn);
  };
  btns.forEach((b, i) => {
    b.addEventListener('click', () => pick(b));
    b.addEventListener('keydown', e => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (d) { e.preventDefault(); pick(btns[(i + d + btns.length) % btns.length], true); }
    });
  });
  pick(btns.find(b => b.getAttribute('aria-selected') === 'true') || btns[0]);
}

/* 豆单：选中的袋子升起，名字点亮 */
const names = [...document.querySelectorAll('.shelf-names span')];
tabs(document.querySelector('.shelf'), btn => {
  const i = [...btn.parentNode.children].indexOf(btn);
  names.forEach((n, j) => n.classList.toggle('on', i === j));
});

/* 冲煮：方法 tab + 换算 */
const RATIO = {
  pour:  { mistrise: 16, ridgeline: 16, riverbank: 15, verb: '注水', unit: 'g 水', temp: { mistrise: '93 ℃', ridgeline: '91 ℃', riverbank: '88 ℃' }, time: '约 2 分 20 秒' },
  espresso: { mistrise: 2.3, ridgeline: 2.1, riverbank: 2, verb: '萃取液重', unit: 'g 液重', temp: { mistrise: '94 ℃', ridgeline: '93 ℃', riverbank: '91 ℃' }, time: '25 – 31 秒' },
  cold:  { mistrise: 12.5, ridgeline: 11.1, riverbank: 10, verb: '加水', unit: 'g 常温水', temp: { mistrise: '冷藏 14 小时', ridgeline: '冷藏 16 小时', riverbank: '冷藏 18 小时' }, time: '' }
};
const BEAN = { mistrise: '雾起', ridgeline: '岭线', riverbank: '江岸' };
let method = 'pour', bean = 'ridgeline';
const dose = document.getElementById('dose');
const out = document.getElementById('calc-out');
const methodName = document.getElementById('calc-method');
function calc() {
  const g = Math.max(0, parseFloat(dose.value) || 0);
  const r = RATIO[method];
  const v = Math.round(g * r[bean]);
  out.innerHTML = `<span class="big">${v} ${r.unit.split(' ')[0]}</span>
    <span class="sub">${BEAN[bean]} · ${r.verb} ${v} g（1 : ${r[bean]}）· ${r.temp[bean]}${r.time ? ' · ' + r.time : ''}</span>`;
}
tabs(document.querySelector('.tabs'), btn => {
  method = btn.dataset.method;
  methodName.textContent = btn.dataset.label;
  const defaults = { pour: 15, espresso: 18, cold: 100 };
  dose.value = defaults[method];
  calc();
});
document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.seg button').forEach(x => x.setAttribute('aria-pressed', x === b));
  bean = b.dataset.bean; calc();
}));
dose.addEventListener('input', calc);
calc();

/* 按节入场 */
const io = 'IntersectionObserver' in window && new IntersectionObserver(es => es.forEach(e => {
  if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
}), { rootMargin: '0px 0px -8% 0px' });
document.querySelectorAll('.reveal').forEach(el => io ? io.observe(el) : el.classList.add('in'));
