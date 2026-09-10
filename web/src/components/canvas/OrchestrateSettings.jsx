/**
 * OrchestrateSettings —— 演出编排的图形设置页（2026-08-15，静态原型过审后落地）。
 *
 * 打开方式：画布上双击 `编排.yaml`（board-kinds 的 file 变体路由到这儿），
 * 跟 .md 进阅读器同一条路数。整页就是一张播放单，从上到下 = 进模型的顺序：
 * 系统层（冻结吃缓存）→ 冻结线 → 历史（弹性区）→ 尾部（每轮可变）。
 *
 * 「每轮允许多大范围变化」的旋钮被空间化：条目在两区之间拖动/挪动就是取舍。
 * 带触发词的条目拒进系统层 —— 跟服务端 normalizeOrchestration 同一条规矩，
 * 这里拦是为了体感（当场告诉你为什么），服务端拦是为了兜底。
 *
 * 保存语义：显式「保存」→ PUT /chatai/config（服务端先校验再落盘，编排.yaml
 * 整文件重生成，注释保不住 —— skill 已教"说明写进名字字段"）。改动下一轮
 * 生效，正在跑的那轮不追。
 */
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, GripVertical, Plus } from 'lucide-react';
import { Chatai } from '../../lib/api.js';
import { GAP, RADIUS, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { useDockYield, yieldPadding } from '../../lib/dock-yield.js';
import { PAPER, PAPER_SHADOW } from '../../lib/paper.js';

/** token 估算 —— 服务端 orchestrate.js 同款下限口径（CJK 1 字 1 枚），只用于展示 */
function est(text) {
  const s = String(text || '');
  const cjk = (s.match(/[⺀-鿿豈-﫿＀-￯]/g) || []).length;
  return cjk + Math.ceil((s.length - cjk) / 4);
}

/** 平台默认那一行（选空模型时用）；其余各行由服务端 模型表 给，前端不再存单价 */
const 默认行 = { id: '', 注: '平台默认（服务端 env 定的那个）', 入: 0.75, 出: 3.75, 思耗: 3.4, 档: [], 默认档: null };

const 段色 = { 系: '#3F4D46', 史: '#7A6C58', 尾: PAPER.red };

export default function OrchestrateSettings({ projectId, dir, onClose }) {
  const 让 = useDockYield();   // 给钉住的聊天卡让位（判据在 lib/dock-yield.js）
  const [state, setState] = useState({ loading: true });   // {loading}|{error}|{cfg,files,状况}
  const [选中, set选中] = useState(null);                   // {区, i}
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [提示, set提示] = useState(null);                   // 页内 toast {文, red?}
  const [拖中, set拖中] = useState(null);                   // 高亮的目标区名
  const changedFiles = useRef(new Set());
  const toastTimer = useRef(null);

  const toast = useCallback((文, red = false) => {
    clearTimeout(toastTimer.current);
    set提示({ 文, red });
    toastTimer.current = setTimeout(() => set提示(null), 4200);
  }, []);

  useEffect(() => {
    let live = true;
    Chatai.config(projectId, dir)
      .then((d) => {
        if (live) setState({ cfg: structuredClone(d.配置), files: d.文件, 状况: d.状况, 模型表: [默认行, ...(d.模型表 || [])] });
      })
      .catch((e) => { if (live) setState({ error: e.message }); });
    return () => { live = false; clearTimeout(toastTimer.current); };
  }, [projectId, dir]);

  const { cfg, files, 状况, 模型表: 服务端表 = [默认行] } = state;

  // 配置里写的模型不在平台表里（手写实名、或者服务端还没重启到新版）也要能显示：
  // 下拉里少一行会让 select 掉回第一项，页面就在**替用户改配置**。宁可多一行说明。
  const 模型表 = useMemo(() => {
    const id = cfg?.模型 || '';
    if (!id || 服务端表.some((m) => m.id === id)) return 服务端表;
    return [...服务端表, { id, 入: 1, 出: 5, 注: '不在平台模型表里（手写的实名？单价按兜底价估）', 思耗: 1, 档: [], 默认档: null }];
  }, [服务端表, cfg?.模型]);
  const 文本of = useCallback((e) => (e?.内容 != null ? e.内容 : (files?.[e?.文件] ?? '')), [files]);

  /** 所有改动走这一个口：标脏 + 触发重渲染 */
  const 改 = useCallback((fn) => {
    setState((s) => { fn(s.cfg, s.files); return { ...s }; });
    setDirty(true);
  }, []);

  const 挪 = useCallback((从, i, 到) => {
    const e = cfg[从][i];
    if (到 === '系统层' && e.触发) {
      toast(`「${e.名字}」带着触发词，只能住尾部——这是缓存稳定性的结构保证。想冻结它，先去掉触发词。`, true);
      return;
    }
    改((c) => { c[从].splice(i, 1); c[到].push(e); });
    set选中(null);
    toast(到 === '系统层'
      ? `「${e.名字}」已冻结进缓存前缀：每轮省钱，但改动它=前缀重写一次。`
      : `「${e.名字}」现在每轮可变：它出现在最新对话之后，怎么改都伤不到缓存。`);
  }, [cfg, 改, toast]);

  const 保存 = useCallback(async () => {
    setSaving(true);
    try {
      const 文件 = {};
      for (const p of changedFiles.current) 文件[p] = files[p] ?? '';
      await Chatai.saveConfig(projectId, dir, cfg, 文件);
      changedFiles.current.clear();
      setDirty(false);
      toast('已保存——下一轮生效（正在跑的那轮不追）。');
    } catch (e) {
      toast(`没存上：${e.message}`, true);
    } finally { setSaving(false); }
  }, [projectId, dir, cfg, files, toast]);

  /* ── 预演帐目 ── */
  const 帐 = useMemo(() => {
    if (!cfg) return null;
    const m = 模型表.find((x) => x.id === (cfg.模型 || '')) || 模型表[0];
    // 生效档：选了就用选的，没选（或这个模型没这档）就落默认档 —— 跟服务端
    // resolveModelVariant 同一条降级规矩，帐目才不会跟真跑的那轮对不上。
    const 档 = m.档?.find((d) => d.名 === cfg.思考) || m.档?.find((d) => d.名 === m.默认档) || null;
    const 思耗 = 档?.思耗 ?? m.思耗 ?? 1;
    const 系 = cfg.系统层.filter((e) => !e.停用).reduce((n, e) => n + est(文本of(e)), 0);
    const 尾常 = cfg.尾部.filter((e) => !e.停用 && !e.触发).reduce((n, e) => n + est(文本of(e)), 0);
    const 尾触 = cfg.尾部.filter((e) => !e.停用 && e.触发).reduce((n, e) => n + est(文本of(e)), 0);
    const 史 = Math.min(状况?.活历史tok ?? 0, cfg.历史.保留轮数 * 420);
    const 摘 = 状况?.摘要 ? est(状况.摘要.内容) : 0;
    const 输入 = 60;
    const 总 = 系 + 史 + 摘 + 尾常 + 输入;
    const 钱 = (总 * m.入 + cfg.最大输出 * 思耗 * m.出) / 1e6;
    return { m, 档, 系, 史: 史 + 摘, 尾: 尾常 + 输入, 尾触, 总, 钱 };
  }, [cfg, 状况, 文本of, 模型表]);

  /* ── 样式 ── */
  const S = useMemo(() => ({
    // 全视口模态（portal 到 body + zIndex 走 MODAL 档 600）：站点窗、工具栏、
    // 聊天栏都在它底下。两个前身都翻过车：absolute 贴宿主 → 站点窗比可视区宽，
    // 保存钮被聊天栏压住；裸 fixed → 窗口的 POP_IN transform 把 fixed 变局部
    // 定位，照样困在窗里。编排是专注型任务，盖全屏是对的。
    // 让位（09-10）：这是**全视口** fixed，钉住的聊天卡就压在它上面 —— 900 宽的播放单
    // 右边一栏会整条被卡盖住。同 BoardOverlays 的罩子，走 padding 不走 inset（居中布局）。
    scrim: { position: 'fixed', inset: 0, zIndex: 600, background: PAPER.scrim,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: GAP.md,
      transition: 'padding 200ms ease', ...yieldPadding(让, GAP.md) },
    panel: { width: 'min(920px, 100%)', height: '100%', background: PAPER.wall,
      boxShadow: PAPER_SHADOW.far, display: 'flex', flexDirection: 'column',
      fontFamily: FONT_SANS, color: PAPER.ink },
    头: { display: 'flex', alignItems: 'baseline', gap: GAP.sm, padding: `${GAP.md}px ${GAP.lg}px ${GAP.xs}px`, flexShrink: 0 },
    身: { flex: 1, overflowY: 'auto', padding: `0 ${GAP.lg}px ${GAP.lg}px`, minHeight: 0 },
    区名: { fontSize: 17, letterSpacing: '0.18em' },
    区注: { fontSize: FONT_SIZE.xs, color: PAPER.ink2 },
    列: (名) => ({ marginTop: GAP.xs, padding: GAP.xs, minHeight: 52,
      background: 名 === '系统层' ? '#EDEFEA' : '#F5EDDD',
      outline: 拖中 === 名 ? `2px dashed ${PAPER.red}` : 'none', outlineOffset: -5 }),
    卡: (e, on) => ({ background: PAPER.paper, boxShadow: PAPER_SHADOW.near,
      padding: `${GAP.xs + 2}px ${GAP.sm}px`, display: 'flex', gap: GAP.xs, alignItems: 'flex-start',
      marginBottom: GAP.xs, cursor: 'grab', opacity: e.停用 ? 0.45 : 1,
      outline: on ? `2px solid ${PAPER.red}` : 'none', outlineOffset: -2 }),
    小钮: { border: 'none', background: 'none', color: PAPER.ink2, cursor: 'pointer',
      font: `12px ${FONT_SANS}`, padding: '2px 6px', whiteSpace: 'nowrap' },
    mono: { fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs },
    输入框: { border: `1px solid ${PAPER.hair}`, background: PAPER.paper, color: PAPER.ink,
      font: `13px ${FONT_MONO}`, padding: '3px 7px', width: 64 },
    脚: { flexShrink: 0, borderTop: `1px solid ${PAPER.hair}`, padding: `${GAP.xs + 2}px ${GAP.lg}px ${GAP.sm}px`, background: PAPER.wall },
  }), [拖中, 让]);

  const 区块 = (名, 注) => (
    <section style={{ marginTop: GAP.lg }}>
      <div style={{ display: 'flex', gap: GAP.sm, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={S.区名}>{名}</span><span style={S.区注}>{注}</span>
      </div>
      <div
        style={S.列(名)}
        onDragOver={(ev) => { ev.preventDefault(); set拖中(名); }}
        onDragLeave={() => set拖中(null)}
        onDrop={(ev) => {
          ev.preventDefault(); set拖中(null);
          const [从, i] = ev.dataTransfer.getData('text/plain').split(':');
          if (从 && 从 !== 名) 挪(从, Number(i), 名);
        }}
      >
        {cfg[名].map((e, i) => {
          const broken = e.文件 != null && files[e.文件] == null;
          const on = 选中 && 选中.区 === 名 && 选中.i === i;
          return (
            <div key={`${名}-${i}`} draggable style={S.卡(e, on)}
              onDragStart={(ev) => ev.dataTransfer.setData('text/plain', `${名}:${i}`)}
              onClick={() => set选中(on ? null : { 区: 名, i })}>
              <GripVertical size={13} style={{ color: PAPER.pencil, marginTop: 3, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: GAP.xs, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 15 }}>{e.名字}</span>
                  <span style={{ ...S.mono, color: PAPER.ink2 }}>{est(文本of(e))} tok</span>
                  {e.触发 && <span style={{ fontSize: 11, color: PAPER.red, border: `1px dashed ${PAPER.red}`, padding: '0 5px' }}>触发 · {e.触发.join(' ')}</span>}
                  {broken && <span style={{ fontSize: 11, color: PAPER.red }}>⚠ 引用的文件不存在</span>}
                </div>
                <div style={{ ...S.mono, color: PAPER.ink2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {e.文件 ?? `（内联）${文本of(e).slice(0, 40)}…`}
                </div>
              </div>
              <div style={{ display: 'flex', flexShrink: 0 }} onClick={(ev) => ev.stopPropagation()}>
                <button style={S.小钮} onClick={() => { 改(() => { e.停用 = !e.停用; }); toast(e.停用 ? `「${e.名字}」已停用——不进上下文，单子上留着随时点回来` : `「${e.名字}」回到场上`); }}>{e.停用 ? '启用' : '停用'}</button>
                <button style={S.小钮} onClick={() => 挪(名, i, 名 === '系统层' ? '尾部' : '系统层')}>{名 === '系统层' ? '挪去尾部' : '挪去系统层'}</button>
              </div>
            </div>
          );
        })}
        {!cfg[名].length && <div style={{ color: PAPER.pencil, fontSize: FONT_SIZE.xs, textAlign: 'center', padding: GAP.xs }}>（空）</div>}
      </div>
      <button style={{ display: 'block', width: '100%', marginTop: GAP.xs, padding: GAP.xs, background: 'none',
        border: `1px dashed ${PAPER.hair}`, color: PAPER.ink2, font: `13px ${FONT_SANS}`, cursor: 'pointer', letterSpacing: '0.2em' }}
        onClick={() => { 改((c) => c[名].push({ 名字: '新条目', 文件: null, 内容: '', 触发: null, 停用: false })); set选中({ 区: 名, i: cfg[名].length }); }}>
        <Plus size={11} style={{ verticalAlign: -1 }} /> 添一条
      </button>
    </section>
  );

  /* ── 编辑抽屉（右侧固定） ── */
  const 抽屉 = () => {
    if (!选中) return null;
    const e = cfg[选中.区]?.[选中.i];
    if (!e) return null;
    return (
      <div style={{ width: 340, flexShrink: 0, borderLeft: `1px solid ${PAPER.hair}`,
        display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: `${GAP.md}px ${GAP.md}px ${GAP.xs}px` }}>
          <span style={{ fontSize: 15, letterSpacing: '0.12em', flex: 1 }}>{e.名字 || '条目'}</span>
          <button style={S.小钮} onClick={() => set选中(null)}><X size={14} /></button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: `0 ${GAP.md}px ${GAP.md}px`, minHeight: 0 }}>
          <label style={{ display: 'block', fontSize: FONT_SIZE.xs, color: PAPER.ink2, margin: `${GAP.sm}px 0 3px` }}>名字</label>
          <input value={e.名字} style={{ width: '100%', border: `1px solid ${PAPER.hair}`, background: PAPER.paper,
            font: `14px ${FONT_SANS}`, padding: '5px 9px', color: PAPER.ink }}
            onChange={(ev) => 改(() => { e.名字 = ev.target.value; })} />
          <label style={{ display: 'block', fontSize: FONT_SIZE.xs, color: PAPER.ink2, margin: `${GAP.sm}px 0 3px` }}>
            {e.文件 != null ? <>文件 · <span style={S.mono}>{e.文件}</span>（改的是文件本身，agent 看到的是同一份）</> : '内联内容'}
            　<span style={S.mono}>{est(文本of(e))} tok</span>
          </label>
          <textarea value={文本of(e)} style={{ width: '100%', minHeight: 180, resize: 'vertical',
            border: `1px solid ${PAPER.hair}`, background: PAPER.paper, color: PAPER.ink,
            font: `13px/1.8 ${FONT_SANS}`, padding: '7px 9px' }}
            onChange={(ev) => 改((c, f) => {
              if (e.文件 != null) { f[e.文件] = ev.target.value; changedFiles.current.add(e.文件); }
              else e.内容 = ev.target.value;
            })} />
          {选中.区 === '尾部' && (
            <>
              <label style={{ display: 'block', fontSize: FONT_SIZE.xs, color: PAPER.ink2, margin: `${GAP.sm}px 0 3px` }}>触发词（空 = 每轮都插）</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
                {(e.触发 || []).map((k, ki) => (
                  <button key={ki} title="点击移除" style={{ fontSize: 12, border: `1px solid ${PAPER.red}`, color: PAPER.red,
                    background: 'none', padding: '1px 7px', cursor: 'pointer', fontFamily: FONT_SANS }}
                    onClick={() => 改(() => { e.触发.splice(ki, 1); if (!e.触发.length) e.触发 = null; })}>{k}</button>
                ))}
                <input placeholder="＋回车添加" style={{ width: 88, border: `1px solid ${PAPER.hair}`, background: PAPER.paper,
                  font: `12px ${FONT_SANS}`, padding: '2px 7px' }}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter' && !ev.isComposing && ev.target.value.trim()) {
                      const v = ev.target.value.trim();
                      改(() => { (e.触发 = e.触发 || []).push(v); });
                      ev.target.value = '';
                    }
                  }} />
              </div>
            </>
          )}
          <div style={{ fontSize: FONT_SIZE.xs, color: PAPER.ink2, background: PAPER.wall, padding: GAP.xs, marginTop: GAP.sm, lineHeight: 1.8 }}>
            {选中.区 === '系统层'
              ? '这条住在系统层：冻结、吃缓存。改一个字，下一轮缓存前缀整个重写一次——值得放这儿的，是不常动的东西。'
              : '这条住在尾部：每轮现拼，保存后下一轮立刻生效，不碰缓存。触发词命中最近几轮或当轮输入才插入。'}
          </div>
          <div style={{ display: 'flex', gap: GAP.xs, marginTop: GAP.sm }}>
            <button style={{ ...S.小钮, border: `1px solid ${PAPER.hair}`, padding: '4px 12px' }}
              onClick={() => 挪(选中.区, 选中.i, 选中.区 === '系统层' ? '尾部' : '系统层')}>
              {选中.区 === '系统层' ? '挪去尾部' : '挪去系统层'}</button>
            <button style={{ ...S.小钮, border: `1px solid ${PAPER.hair}`, padding: '4px 12px', color: PAPER.red }}
              onClick={() => { const 名 = e.名字; 改((c) => c[选中.区].splice(选中.i, 1)); set选中(null); toast(`「${名}」已删除（引用的文件还在磁盘上）`); }}>删除</button>
          </div>
        </div>
      </div>
    );
  };

  return createPortal(
    <div style={S.scrim} onClick={onClose}>
      <div style={S.panel} onClick={(ev) => ev.stopPropagation()}>
        {state.loading && <div style={{ margin: 'auto', color: PAPER.ink2 }}>读编排…</div>}
        {state.error && <div style={{ margin: 'auto', color: PAPER.red, maxWidth: 480, textAlign: 'center' }}>{state.error}</div>}
        {cfg && (
          <>
            <div style={S.头}>
              <span style={{ fontSize: 21, letterSpacing: '0.14em' }}>编排设置</span>
              <span style={{ ...S.mono, color: PAPER.ink2, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dir || '（工作区根）'}</span>
              {dirty && <span style={{ fontSize: FONT_SIZE.xs, color: PAPER.red }}>未保存</span>}
              <button disabled={!dirty || saving} onClick={保存}
                style={{ border: 'none', background: dirty ? PAPER.ink : PAPER.pencil, color: PAPER.paper,
                  font: `14px ${FONT_SANS}`, padding: '5px 18px', cursor: dirty ? 'pointer' : 'default' }}>
                {saving ? '存…' : '保存'}</button>
              <button style={S.小钮} onClick={onClose}><X size={16} /></button>
            </div>
            {提示 && (
              <div style={{ margin: `0 ${GAP.lg}px`, padding: `${GAP.xs}px ${GAP.sm}px`, fontSize: FONT_SIZE.xs,
                background: 提示.red ? PAPER.red : PAPER.ink, color: PAPER.paper, lineHeight: 1.7 }}>{提示.文}</div>
            )}
            <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
              <div style={S.身}>
                {/* 全局旋钮 */}
                <div style={{ display: 'flex', gap: GAP.md, flexWrap: 'wrap', background: PAPER.paper,
                  boxShadow: PAPER_SHADOW.near, padding: GAP.sm, marginTop: GAP.xs, alignItems: 'flex-end' }}>
                  <div style={{ flex: '1 1 200px' }}>
                    <label style={{ display: 'block', fontSize: FONT_SIZE.xs, color: PAPER.ink2 }}>模型</label>
                    <select value={cfg.模型 || ''} style={{ width: '100%', ...S.输入框 }}
                      onChange={(ev) => {
                        const id = ev.target.value || null;
                        const 新 = 模型表.find((x) => x.id === (id || ''));
                        // 换模型时清掉它不支持的档：各家档位词表不一样（gemini 低/中/高、
                        // claude 关/高），留着旧词会在服务端被降级，不如当场归默认。
                        const 保留 = 新?.档?.some((d) => d.名 === cfg.思考);
                        改((c) => { c.模型 = id; if (!保留) c.思考 = null; });
                      }}>
                      {模型表.map((m) => <option key={m.id} value={m.id}>{m.id || '（平台默认）'}</option>)}
                    </select>
                    <div style={{ fontSize: 11, color: PAPER.ink2, marginTop: 2 }}>{帐?.m.注}</div>
                  </div>
                  <div style={{ flex: '0 1 150px' }}>
                    <label style={{ display: 'block', fontSize: FONT_SIZE.xs, color: PAPER.ink2 }}>思考</label>
                    <select value={cfg.思考 || ''} disabled={!帐?.m.档?.length} style={{ width: '100%', ...S.输入框 }}
                      onChange={(ev) => 改((c) => { c.思考 = ev.target.value || null; })}>
                      <option value="">{帐?.m.档?.length ? `默认（${帐.m.默认档}）` : '不可调'}</option>
                      {(帐?.m.档 || []).map((d) => <option key={d.名} value={d.名}>{d.名}</option>)}
                    </select>
                    <div style={{ fontSize: 11, color: PAPER.ink2, marginTop: 2 }}>
                      {帐?.档?.注 || '这个模型的思考档由中转站定死，调不了'}
                    </div>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: FONT_SIZE.xs, color: PAPER.ink2 }}>最大输出</label>
                    <input type="number" min={100} max={4000} step={50} value={cfg.最大输出} style={S.输入框}
                      onChange={(ev) => 改((c) => { c.最大输出 = Number(ev.target.value) || 2000; })} />
                  </div>
                  <div style={{ flex: '1 1 180px' }}>
                    <label style={{ display: 'block', fontSize: FONT_SIZE.xs, color: PAPER.ink2 }}>
                      上下文预算 <span style={S.mono}>{Math.round(cfg.上下文预算 / 1000)}k</span></label>
                    <input type="range" min={10000} max={200000} step={5000} value={cfg.上下文预算}
                      style={{ width: '100%', accentColor: PAPER.red }}
                      onChange={(ev) => 改((c) => { c.上下文预算 = Number(ev.target.value); })} />
                  </div>
                </div>

                {区块('系统层', '冻结 · 缓存的本体 —— 身份、世界、文风住这里')}

                <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm, marginTop: GAP.lg,
                  color: PAPER.ink2, fontSize: FONT_SIZE.xs, letterSpacing: '0.1em' }}>
                  <span style={{ flex: 1, borderTop: `1px dashed ${PAPER.hair}` }} />
                  冻结线 —— 线上改一个字缓存前缀重写一次；线下每轮随便变
                  <span style={{ flex: 1, borderTop: `1px dashed ${PAPER.hair}` }} />
                </div>

                {/* 历史块 */}
                <section style={{ marginTop: GAP.lg }}>
                  <div style={{ display: 'flex', gap: GAP.sm, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <span style={S.区名}>历史</span><span style={S.区注}>对话记录 · 弹性区，被预算挤压、被摘要折叠</span>
                  </div>
                  <div style={{ marginTop: GAP.xs, background: PAPER.paper, boxShadow: PAPER_SHADOW.near,
                    borderLeft: `3px solid ${段色.史}`, padding: `${GAP.sm}px ${GAP.md}px`,
                    display: 'flex', gap: `${GAP.xs}px ${GAP.lg}px`, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }}>
                    <span style={S.mono}>{cfg.历史.文件} · {状况?.记录条数 ?? 0} 条 / {状况?.轮数 ?? 0} 轮</span>
                    <span>保留轮数 <input type="number" min={0} max={200} value={cfg.历史.保留轮数} style={S.输入框}
                      onChange={(ev) => 改((c) => { c.历史.保留轮数 = Number(ev.target.value) || 0; })} /></span>
                    <label style={{ cursor: 'pointer' }}>
                      <input type="checkbox" checked={cfg.摘要.启用} style={{ accentColor: PAPER.red }}
                        onChange={(ev) => 改((c) => { c.摘要.启用 = ev.target.checked; })} /> 自动摘要</label>
                    <span>攒 <input type="number" min={2} value={cfg.摘要.触发轮数} style={{ ...S.输入框, width: 52 }}
                      onChange={(ev) => 改((c) => { c.摘要.触发轮数 = Number(ev.target.value) || 24; })} /> 轮折叠，留
                      <input type="number" min={1} value={cfg.摘要.保留轮数} style={{ ...S.输入框, width: 52 }}
                        onChange={(ev) => 改((c) => { c.摘要.保留轮数 = Number(ev.target.value) || 12; })} /> 轮</span>
                    {cfg.摘要.触发轮数 <= cfg.摘要.保留轮数
                      && <span style={{ color: PAPER.red, fontSize: FONT_SIZE.xs }}>触发轮数得大于保留轮数，这么存会被拒</span>}
                    {状况?.摘要 && <span style={{ color: PAPER.ink2, fontSize: FONT_SIZE.xs }}>已折叠至 #{状况.摘要.至}</span>}
                  </div>
                </section>

                {区块('尾部', '每轮可变 · 拼在下一句之前 —— 场景、导演小纸条住这里')}
              </div>
              {抽屉()}
            </div>
            {/* 预演帐目 */}
            <div style={S.脚}>
              <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: GAP.xs, fontSize: FONT_SIZE.xs, color: PAPER.ink2 }}>
                <span>下一轮预演：<b style={{ fontWeight: 'normal', color: PAPER.ink }}>
                  {帐.总.toLocaleString()} tok</b>（系统层 {帐.系} · 历史 {帐.史} · 尾部 {帐.尾}{帐.尾触 ? ` · 触发时再 +${帐.尾触}` : ''}）/ 预算 {Math.round(cfg.上下文预算 / 1000)}k</span>
                <span>一轮约 ${帐.钱.toFixed(4)}
                  （{帐.档 ? `思考${帐.档.名}档粗估` : '含思考粗估'} · 未计缓存折扣）</span>
              </div>
              <div style={{ display: 'flex', height: 9, marginTop: 5, background: '#E2DAC6',
                outline: 帐.总 > cfg.上下文预算 ? `2px solid ${PAPER.red}` : 'none' }}>
                {[['系', 帐.系], ['史', 帐.史], ['尾', 帐.尾]].map(([k, v]) => (
                  <i key={k} style={{ background: 段色[k], width: `${Math.max(0.5, (v / cfg.上下文预算) * 100)}%`, transition: 'width .25s' }} />
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
