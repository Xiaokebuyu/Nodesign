import { useState, useEffect, useCallback, useMemo } from 'react';
import { Power, PowerOff, Clock, ChevronDown, ChevronRight } from 'lucide-react';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { PAPER_SHADOW } from '../../lib/paper.js';
import { Admin } from '../../lib/api-admin.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { Chip } from './primitives.jsx';
import ModelMark from '../ui/ModelMark.jsx';
import SlotEditor from '../local/SlotEditor.jsx';

/**
 * ModelSwitchboard — 站点模型总闸（2026-09-10）。
 *
 * 站主要的是"上游出事 / 价钱不对 / 这行在乱说话"的时候能**当场把它从全站收走**，
 * 而不是找人改代码再重启（重启要等所有在飞的回合）。
 *
 * 三件事在这一页上要一眼看全，缺一件这页就没用：
 *   1. **此刻**是什么状态 —— 开着 / 被停用 / 撞在钟点闸里（几点回来）
 *   2. 停用会牵连谁 —— 被别的行当 helper 或备用行的，停用**拦不住**那条路（它们不过选择器）
 *   3. 这行到底连着哪儿 —— 上游、发出去的模型名、价
 *
 * ⛔ 停用不动正在跑的会话（站主 09-10：先别加 fallback）：下一发被拦下、话里请用户自己换一行。
 */

const usd = (n) => (n === 0 ? '0' : `$${n}`);
const fmtWindow = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `${Math.round(n / 1000)}k`);
/** '2026-09-10T10:00:00.000Z' → '18:00'（站里的人都看北京时间） */
const clockOf = (iso) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

export function ModelSwitchboard() {
  const showToast = useGlobalStore(s => s.showToast);
  const [models, setModels] = useState(null);
  const [busy, setBusy] = useState(null);
  const [showHelpers, setShowHelpers] = useState(false);

  const load = useCallback(() => {
    Admin.models().then(r => setModels(r.models)).catch(err => showToast(`拉取失败：${err.message}`, 'error'));
  }, [showToast]);
  useEffect(load, [load]);
  // 钟点闸是现算的：页面开着不动的话"几点回来"会过期。一分钟拉一次，够了
  useEffect(() => {
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const toggle = async (row) => {
    setBusy(row.id);
    try {
      const r = await Admin.patchModel(row.id, { enabled: !row.enabled });
      showToast(r.model.enabled ? `${row.label || row.id} 已放回全站` : `${row.label || row.id} 已从全站收走`, 'success');
      if (r.warning) showToast(r.warning, 'warn');
      load();
    } catch (err) {
      showToast(`改不动：${err.message}`, 'error');
    }
    setBusy(null);
  };

  const [selectable, helpers] = useMemo(() => [
    (models || []).filter(m => m.selectable),
    (models || []).filter(m => !m.selectable),
  ], [models]);

  if (!models) return <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub }}>正在拉模型清单…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.xl }}>
      <p style={{ margin: 0, fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub, lineHeight: 1.7 }}>
        停用 = 全站谁都不能再选这一行（管理员也不能），选择器里那行会灰着并写明原因。
        <br />
        正在用它的会话**不会被搬走**：下一发拦下来，请用户自己换一行。
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.md }}>
        {selectable.map(m => <ModelRow key={m.id} m={m} busy={busy === m.id} onToggle={() => toggle(m)} />)}
      </div>

      <SiteSlots onApplied={load} />

      <div>
        <button
          onClick={() => setShowHelpers(v => !v)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: GAP.sm, padding: 0,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
            background: 'transparent', border: 0, cursor: 'pointer',
          }}
        >
          {showHelpers ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          内部行（{helpers.length}）· 选择器里不出现，标题 / 压缩 / 子代理走它们
        </button>
        {showHelpers && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.md, marginTop: GAP.md }}>
            {helpers.map(m => <ModelRow key={m.id} m={m} busy={busy === m.id} onToggle={() => toggle(m)} />)}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 站点自己加的模型行（存库，保存当场生效）。
 *
 * ⭐ 表单**复用本地分发版那个 SlotEditor**：字段名跟服务端 schema 一一对应、枚举也是服务端给的，
 *   两个场合共用一份。差别只有"保存之后怎么生效"和"有没有逐行体检"，用 prop 表达。
 */
function SiteSlots({ onApplied }) {
  const showToast = useGlobalStore(s => s.showToast);
  const [cfg, setCfg] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => {
    Admin.modelSlots().then((r) => { setCfg(r); setDraft(r.raw || { upstreams: {}, models: [] }); })
      .catch(err => showToast(`拉取站点插槽失败：${err.message}`, 'error'));
  }, [showToast]);
  useEffect(load, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const r = await Admin.saveModelSlots(draft);
      setSaved(true);
      // errors 是"哪几行没进表"，不是"没保存"：保存成功了也可能带着错
      if (r.errors?.length) showToast(`已保存，但有 ${r.errors.length} 处没通过校验（对应的行没进表）`, 'warn');
      else showToast('已保存，当场生效', 'success');
      setCfg((c) => ({ ...c, errors: r.errors || [], activeExternalModels: r.activeExternalModels || [] }));
      onApplied?.();          // 上面那张总闸清单也要跟着变
    } catch (err) {
      showToast(`保存失败：${err.message}`, 'error');
    }
    setSaving(false);
  };

  if (!cfg || !draft) return null;

  return (
    <div style={{ borderTop: `1px solid ${COLOR.border}`, paddingTop: GAP.xl }}>
      <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, fontWeight: 600, color: COLOR.text, marginBottom: GAP.sm }}>
        站点自己加的模型
      </div>
      <p style={{ margin: `0 0 ${GAP.lg}px`, fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub, lineHeight: 1.7 }}>
        在这儿加的行跟内置行并排出现在选择器里，保存**当场生效，不用重启**。
        服务商可以直接挑站内已有的（地址和钥匙在服务端，页面上不出现），也可以自己填一个新的。
        {cfg.readOnly && <span style={{ color: COLOR.warn }}> 这个实例的插槽读的是本地文件，改这儿不生效。</span>}
      </p>
      <SlotEditor
        config={draft} setConfig={setDraft} errors={cfg.errors} enums={cfg.enums}
        active={cfg.activeExternalModels}
        names={{ reservedUpstreams: cfg.reservedUpstreamIds, reservedModels: cfg.reservedModelIds, shadowableModels: cfg.shadowableModelIds, shadowed: cfg.shadowedBuiltinModels }}
        needsRestart={saved} applyMode="hot" builtinUpstreams={cfg.builtinUpstreams} canProbe={false}
        onSave={save} saving={saving} showToast={showToast}
      />
    </div>
  );
}

function ModelRow({ m, busy, onToggle }) {
  const closed = m.closedNow;
  const off = !m.enabled;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: GAP.lg, flexWrap: 'wrap',
      padding: `${GAP.md}px ${GAP.xl}px`,
      background: COLOR.bgCard, border: `1px solid ${off ? COLOR.borderMd : COLOR.border}`, borderRadius: RADIUS.xxl,
      opacity: off ? 0.62 : 1,
    }}>
      <ModelMark brand={m.brand} size={15} />
      <div style={{ minWidth: 210, flex: '1 1 260px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, fontWeight: 600, color: COLOR.text }}>
            {m.label || m.id}
          </span>
          {off && <Chip color={COLOR.error}>已停用</Chip>}
          {!off && closed && <Chip color={COLOR.warn}><Clock size={10} style={{ marginRight: 3 }} />关门中 · {clockOf(closed.resumesAt)} 恢复</Chip>}
          {m.gate === 'subscription' && <Chip color={COLOR.text3}>Pro 档</Chip>}
          {m.gate === 'localGen' && <Chip color={COLOR.text3}>需批准</Chip>}
          {m.only === 'stage' && <Chip color={COLOR.text3}>只在演出</Chip>}
          {m.external && <Chip color={COLOR.text3}>插槽</Chip>}
        </div>
        <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginTop: 3, wordBreak: 'break-all' }}>
          {m.id}
          {m.wireModel && <span style={{ color: COLOR.text3 }}> → {m.upstream}/{m.wireModel}</span>}
          {!m.wireModel && <span style={{ color: COLOR.text3 }}> · 订阅通路</span>}
        </div>
        {(m.unavailable || m.usedAsFastBy.length > 0 || m.usedAsStandbyBy.length > 0) && (
          <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text3, marginTop: 3 }}>
            {m.unavailable && <span>每天 {m.unavailable.windows.join('、')}（{m.unavailable.tz || 'UTC'}）关门 —— {m.unavailable.why}。</span>}
            {m.usedAsFastBy.length > 0 && <span> {m.usedAsFastBy.length} 行拿它当 helper。</span>}
            {m.usedAsStandbyBy.length > 0 && <span> {m.usedAsStandbyBy.length} 行拿它当备用行。</span>}
          </div>
        )}
      </div>

      <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub, minWidth: 150 }}>
        {m.prices
          ? <>入 {usd(m.prices.input)} / 出 {usd(m.prices.output)}<span style={{ color: COLOR.text3 }}> ·/M</span></>
          : <span style={{ color: COLOR.text3 }}>按订阅额度</span>}
        <div style={{ color: COLOR.text3 }}>{fmtWindow(m.window)} 上下文</div>
      </div>

      <button
        onClick={onToggle}
        disabled={busy}
        title={off ? '放回全站' : '从全站收走'}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: GAP.sm,
          padding: `${GAP.sm}px ${GAP.lg}px`,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 600,
          color: off ? COLOR.success : COLOR.error,
          background: `color-mix(in srgb, ${off ? COLOR.success : COLOR.error} 10%, transparent)`,
          border: 0, borderRadius: RADIUS.lg, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1,
        }}
      >
        {off ? <><Power size={13} /> 启用</> : <><PowerOff size={13} /> 停用</>}
      </button>
    </div>
  );
}

export default ModelSwitchboard;
