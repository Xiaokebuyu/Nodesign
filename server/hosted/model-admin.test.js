/**
 * 站点模型管理台（2026-09-10）。
 *
 * 用**真表**跑（不造假行）：这一层的价值就在于"它看到的是不是站上此刻真正的那些行"，
 * 拿桩数据测等于把被测的东西换掉了（见 nodesign-inspect-channel 那条：假数据比没有更坏）。
 * 开关会落进测试库，所以每个用例自己收尾（afterEach 把动过的行放回去）。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import router, { adminModelList, wouldLeaveNoModels } from './model-admin.js';
import { setModelEnabled } from '../lib/model-switches.js';

const MERGE_ROW = 'deepseek-v4.1-flash-merge';
const touched = new Set();

let server; let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 'admin-test', role: 'admin' }; next(); });   // 代替 adminGuard
  app.use('/api/admin/models', router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api/admin/models`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
afterEach(() => { for (const id of touched) setModelEnabled(id, true, { updatedBy: 'admin-test' }); touched.clear(); });

const call = (p = '', init = {}) => fetch(base + p, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
const patch = (id, body) => { touched.add(id); return call(`/${id}`, { method: 'PATCH', body: JSON.stringify(body) }); };

describe('GET /api/admin/models', () => {
  it('列出真表里的行，helper 行也在（selectable=false），默认全是启用', async () => {
    const { models } = await (await call()).json();
    expect(models.length).toBeGreaterThan(10);
    const merge = models.find((m) => m.id === MERGE_ROW);
    expect(merge.enabled).toBe(true);
    expect(merge.upstream).toBe('merge');
    expect(merge.wireModel).toBe('deepseek/deepseek-v4.1-flash');   // 展示名带 v4.1，发出去的是网关目录名
    expect(merge.prices.input).toBe(0.15);
    expect(merge.unavailable.windows).toEqual(['01:00-04:00', '06:00-10:00']);
    expect(models.some((m) => !m.selectable)).toBe(true);           // helper 行
    expect(models.some((m) => m.subscription)).toBe(true);          // 订阅行也要看得见
  });

  it('把"谁拿它当 helper / 备用行"摆出来（停用之前得知道会牵连谁）', async () => {
    const { models } = await (await call()).json();
    const helper = models.find((m) => m.id === 'deepseek-v4-flash-helper');
    expect(helper.usedAsFastBy.length).toBeGreaterThan(0);
    expect(helper.usedAsFastBy).toContain(MERGE_ROW);
  });

  it('钟点闸按传进去的"此刻"现算：高峰里关门、非高峰开门', () => {
    const inPeak = adminModelList(new Date(Date.UTC(2026, 8, 10, 7, 0))).find((m) => m.id === MERGE_ROW);
    expect(inPeak.closedNow.resumesAt).toBe('2026-09-10T10:00:00.000Z');
    expect(inPeak.enabled).toBe(true);   // 关门 ≠ 被停用，两件事分开记
    const offPeak = adminModelList(new Date(Date.UTC(2026, 8, 10, 13, 0))).find((m) => m.id === MERGE_ROW);
    expect(offPeak.closedNow).toBeNull();
  });
});

describe('站点插槽：加一行不用重启', () => {
  const SLOT = 'zzz-slot-test';
  const put = (body) => call('/slots', { method: 'PUT', body: JSON.stringify(body) });
  afterEach(async () => { await put({ upstreams: {}, models: [] }); });   // 收尾：把测试加的行撤掉

  it('存一行挂在**内置上游**上的模型 → 当场进表、选择器里就有它（没重启过进程）', async () => {
    const r = await put({
      upstreams: {},
      models: [{
        id: SLOT, label: '测试插槽', desc: '站点插槽测试用', window: 200_000,
        upstream: 'merge', wireModel: 'deepseek/deepseek-v4.1-flash', brand: 'deepseek',
        prices: { input: 0.15, output: 0.6 },
      }],
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.errors).toEqual([]);
    expect(j.activeExternalModels).toContain(SLOT);
    // 真相源那边也认了（这才叫"生效"，不是接口自己说生效）
    const { models } = await (await call()).json();
    const row = models.find((m) => m.id === SLOT);
    expect(row.external).toBe(true);
    expect(row.upstream).toBe('merge');
    expect(row.enabled).toBe(true);
  });

  it('坏行只丢自己：错回给页面，别的行照旧在表里', async () => {
    const r = await put({
      upstreams: {},
      models: [
        { id: SLOT, label: '好的', window: 200_000, upstream: 'merge', wireModel: 'deepseek/deepseek-v4.1-flash', brand: 'deepseek' },
        { id: 'zzz-bad-test', label: '坏的', window: 200_000, upstream: '压根没这个上游', wireModel: 'x' },
      ],
    });
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.errors.length).toBeGreaterThan(0);
    expect(j.activeExternalModels).toContain(SLOT);
    expect(j.activeExternalModels).not.toContain('zzz-bad-test');
  });

  it('插槽也能声明关门时段：落在**行级**字段上（不是掉进 api 段里静默失效）', async () => {
    const r = await put({
      upstreams: {},
      models: [{
        id: SLOT, label: '按点关门的插槽', window: 200_000, upstream: 'merge', wireModel: 'deepseek/deepseek-v4.1-flash', brand: 'deepseek',
        unavailable: { why: '上游高峰涨价', tz: 'UTC', windows: ['01:00-04:00'] },
      }],
    });
    expect((await r.json()).errors).toEqual([]);
    const inWindow = adminModelList(new Date(Date.UTC(2026, 8, 10, 2, 0))).find((m) => m.id === SLOT);
    expect(inWindow.unavailable.windows).toEqual(['01:00-04:00']);
    expect(inWindow.closedNow.resumesAt).toBe('2026-09-10T04:00:00.000Z');
    expect(adminModelList(new Date(Date.UTC(2026, 8, 10, 13, 0))).find((m) => m.id === SLOT).closedNow).toBeNull();
  });

  it('窗口写坏了：整行丢掉 + 一句人话，别的行不受连累', async () => {
    const r = await put({
      upstreams: {},
      models: [{ id: SLOT, label: '坏窗口', window: 200_000, upstream: 'merge', wireModel: 'x', unavailable: { windows: ['一点到四点'] } }],
    });
    const j = await r.json();
    expect(j.activeExternalModels).not.toContain(SLOT);
    expect(JSON.stringify(j.errors)).toMatch(/HH:MM-HH:MM/);
  });

  it('GET /slots 把表单要的东西一起给：枚举、内置上游名（不含钥匙）、被占的 id', async () => {
    const j = await (await call('/slots')).json();
    expect(j.enums.BRANDS).toContain('deepseek');
    expect(Object.keys(j.builtinUpstreams)).toContain('merge');
    expect(JSON.stringify(j.builtinUpstreams)).not.toMatch(/sk-|Bearer/);
    expect(j.reservedModelIds).toContain('claude-sonnet-5[1m]');       // 订阅行不许当插槽 id
    expect(j.shadowableModelIds).toContain('deepseek-v4.1-flash');     // 内置 API 行可被同名插槽顶替
  });
});

describe('关门时段：内置行也能在管理台上改', () => {
  const patchHours = (id, unavailable) => { touched.add(id); return call(`/${id}`, { method: 'PATCH', body: JSON.stringify({ unavailable }) }); };
  const inPeak = new Date(Date.UTC(2026, 8, 10, 7, 0));
  afterEach(async () => { await patchHours(MERGE_ROW, 'reset'); });

  it('默认用表里那份（source=row），改完变成站主那份（source=admin），reset 回到出厂', async () => {
    expect(adminModelList().find((m) => m.id === MERGE_ROW).unavailableSource).toBe('row');

    const r = await patchHours(MERGE_ROW, { why: '先只关早上那段', tz: 'UTC', windows: ['06:00-10:00'] });
    expect(r.status).toBe(200);
    const after = (await r.json()).model;
    expect(after.unavailableSource).toBe('admin');
    expect(after.unavailable.windows).toEqual(['06:00-10:00']);
    expect(after.builtinUnavailable.windows).toHaveLength(2);   // 出厂那份留着当参照
    expect(after.enabled).toBe(true);                            // ⛔ 改时段不该顺手动开关

    await patchHours(MERGE_ROW, 'reset');
    expect(adminModelList().find((m) => m.id === MERGE_ROW).unavailableSource).toBe('row');
  });

  it('null = 明确不关门：连表里写着的那两段也不再关（这就是"取消"，不是"没设过"）', async () => {
    expect(adminModelList(inPeak).find((m) => m.id === MERGE_ROW).closedNow).not.toBeNull();
    await patchHours(MERGE_ROW, null);
    const row = adminModelList(inPeak).find((m) => m.id === MERGE_ROW);
    expect(row.closedNow).toBeNull();
    expect(row.unavailableSource).toBe('admin');
    expect(row.unavailable).toBeNull();
  });

  it('给一条本来没时段的行加上关门（内置行的出厂值是空）', async () => {
    const r = await patchHours('deepseek-v4-flash-vision', { why: '夜里不开', tz: 'Asia/Shanghai', windows: ['23:00-02:00'] });
    expect(r.status).toBe(200);
    const row = adminModelList(new Date(Date.UTC(2026, 8, 10, 16, 0))).find((m) => m.id === 'deepseek-v4-flash-vision');   // 北京 00:00
    expect(row.closedNow.resumesAt).toBe('2026-09-10T18:00:00.000Z');   // 北京 02:00
    await patchHours('deepseek-v4-flash-vision', 'reset');
  });

  it('写坏了当场 400，不落库', async () => {
    const r = await patchHours(MERGE_ROW, { windows: ['一点到四点'] });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/HH:MM-HH:MM/);
    expect(adminModelList().find((m) => m.id === MERGE_ROW).unavailableSource).toBe('row');
    const tz = await patchHours(MERGE_ROW, { windows: ['01:00-02:00'], tz: 'Mars/Olympus' });
    expect(tz.status).toBe(400);
  });
});

describe('PATCH /api/admin/models/:id', () => {
  it('关一行：落库、留痕（谁关的）、清单立刻跟着变', async () => {
    const r = await patch(MERGE_ROW, { enabled: false, note: '先关着看看' });
    expect(r.status).toBe(200);
    const { model } = await r.json();
    expect(model.enabled).toBe(false);
    expect(model.switchedBy).toBe('admin-test');
    expect(model.switchNote).toBe('先关着看看');
    const { models } = await (await call()).json();
    expect(models.find((m) => m.id === MERGE_ROW).enabled).toBe(false);
  });

  it('关掉一条别人当 helper / 备用行用的：放行，但把牵连说出来（那条路不过选择器这道闸）', async () => {
    const r = await patch('deepseek-v4-flash-helper', { enabled: false });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.warning).toMatch(/helper/);
    expect(j.warning).toContain(MERGE_ROW);
  });

  it('不认识的 id → 404；enabled 不是布尔 → 400', async () => {
    expect((await call('/nobody-knows-this', { method: 'PATCH', body: '{"enabled":false}' })).status).toBe(404);
    expect((await call(`/${MERGE_ROW}`, { method: 'PATCH', body: '{"enabled":"no"}' })).status).toBe(400);
  });

  it('最后一条可选模型不许关（关完全站没模型可发消息）', () => {
    const one = [{ id: 'a', selectable: true, enabled: true }, { id: 'h', selectable: false, enabled: true }];
    expect(wouldLeaveNoModels(one, 'a')).toBe(true);        // 只剩它自己
    expect(wouldLeaveNoModels(one, 'h')).toBe(false);       // helper 行随便关
    const two = [...one, { id: 'b', selectable: true, enabled: true }];
    expect(wouldLeaveNoModels(two, 'a')).toBe(false);
    const already = [{ id: 'a', selectable: true, enabled: true }, { id: 'b', selectable: true, enabled: false }];
    expect(wouldLeaveNoModels(already, 'a')).toBe(true);    // 别的早就关了，也算最后一条
  });
});
