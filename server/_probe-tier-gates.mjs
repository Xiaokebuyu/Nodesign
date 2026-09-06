/**
import crypto from 'node:crypto';
 * server/_probe-tier-gates.mjs — 对着真服务端攻一遍账户层级闸（08-21）。
 *   node server/_probe-tier-gates.mjs [base=http://127.0.0.1:4001]
 * 注册一个公开号（无邀请码），逐条打：/api/me/models 的 locked+default、PUT 会话模型 403、
 * turn 带 sonnet 403、chatai 403、热切 runs/:rid/model 403；最后把号停用（admin 凭据走 .env 里的 ADMIN 密码，没配就只打印 id 让人手动停）。
 */
const BASE = process.argv[2] || 'http://127.0.0.1:4001';
const tag = Date.now().toString(36);
const jar = {};
async function call(method, path, body, cookie) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const setc = r.headers.get('set-cookie'); if (setc) jar.last = setc.split(';')[0];
  let j; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, j };
}
const results = [];
const check = (name, ok, detail) => { results.push([ok ? '✓' : '✗', name, detail]); };

const st = await call('GET', '/api/auth/status');
check('status.openRegistration=true', st.j?.openRegistration === true, JSON.stringify(st.j));
const reg = await call('POST', '/api/auth/register', { username: `gateprobe_${tag}`, password: 'probe-pass-12345' });
check('公开注册 201', reg.status === 201, `${reg.status} ${JSON.stringify(reg.j).slice(0, 120)}`);
const cookie = jar.last;
const me = await call('GET', '/api/me/models', null, cookie);
const opts = me.j?.options || [];
check('默认模型=glm-5.3-flash-merge（08-30 从耗尽的 glm-5.3-flash-zai 挪过来；此前是 minimax-m3）', me.j?.default === 'glm-5.3-flash-merge', JSON.stringify(me.j?.default));
check('Sonnet/Opus 在清单里且 locked', opts.filter(o => /claude-/.test(o.id)).length === 2 && opts.filter(o => /claude-/.test(o.id)).every(o => o.locked), JSON.stringify(opts.map(o => [o.id, !!o.locked])));
check('minimax-m3 在清单里且不 locked', opts.some(o => o.id === 'minimax-m3' && !o.locked), '');
check('glm-5.3-flash-merge 在清单里且不 locked（付费行也对公开号开，靠 $5/天日限管）', opts.some(o => o.id === 'glm-5.3-flash-merge' && !o.locked), '');
// 08-30 深夜拆出的第二条线（同模型同价，只是厂商不同）—— 09-06 起它**只在演出显示器的选择器里出现**（select.only:'stage'），
// 首页 / 画布这份清单不许列它（画布上选它只会在第 9 张图上 400）
check('glm-5.3-flash-rp（演出线）不在首页清单里（只在演出面出现）', !opts.some(o => o.id === 'glm-5.3-flash-rp'), JSON.stringify(opts.map(o => o.id)));
const proj = await call('POST', '/api/projects', { name: `gateprobe ${tag}` }, cookie);
const pid = proj.j?.project?.id || proj.j?.id;
check('建项目', proj.status < 300 && !!pid, `${proj.status} ${pid}`);
if (pid) {
  const sid = crypto.randomUUID();
  const t1 = await call('POST', `/api/projects/${pid}/turn`, { chat: 'hi', sessionId: sid, model: 'claude-sonnet-5[1m]', requestId: `r-${tag}-1` }, cookie);
  check('turn 带 sonnet → 403 MODEL_LOCKED', t1.status === 403 && t1.j?.code === 'MODEL_LOCKED', `${t1.status} ${t1.j?.code}`);
  const t2 = await call('POST', `/api/projects/${pid}/turn`, { chat: 'hi', sessionId: sid, model: 'gemini-3.7-flash', requestId: `r-${tag}-2` }, cookie);
  check('turn 带 gemini（看不见的）→ 拒（403 MODEL_NOT_ALLOWED / 400 UNKNOWN_MODEL）', (t2.status === 403 && t2.j?.code === 'MODEL_NOT_ALLOWED') || (t2.status === 400 && t2.j?.code === 'UNKNOWN_MODEL'), `${t2.status} ${t2.j?.code}`);
  const pm = await call('PUT', `/api/projects/${pid}/sessions/${sid}/model`, { model: 'claude-opus-5[1m]' }, cookie);
  check('PUT 会话模型 opus → 403', pm.status === 403 && pm.j?.code === 'MODEL_LOCKED', `${pm.status} ${pm.j?.code}`);
  const gm = await call('GET', `/api/projects/${pid}/sessions/${sid}/model`, null, cookie);
  check('GET 会话模型 default=minimax-m3', gm.j?.default === 'minimax-m3' && gm.j?.model === 'minimax-m3', JSON.stringify({ model: gm.j?.model, default: gm.j?.default }));
  const ca = await call('POST', `/api/projects/${pid}/chatai/turn`, { input: 'hi' }, cookie);
  check('chatai 演出 → 403', ca.status === 403, `${ca.status} ${JSON.stringify(ca.j).slice(0, 100)}`);
  const hot = await call('POST', `/api/projects/${pid}/runs/run_nonexistent/model`, { model: 'claude-sonnet-5[1m]' }, cookie);
  check('热切 runs/:rid/model（无活 run）→ 404（有活 run 时白名单在 query 之前，见 turn.js）', hot.status === 404 || hot.status === 403, `${hot.status} ${hot.j?.code}`);
  await call('DELETE', `/api/projects/${pid}`, null, cookie);
}
console.log(results.map(r => r.join('  ')).join('\n'));
console.log(`\n公开号 gateprobe_${tag} 已建（登录墙口径上它是真用户），请在 admin 控制台停用或留作对照。失败 ${results.filter(r => r[0] === '✗').length} 项`);
