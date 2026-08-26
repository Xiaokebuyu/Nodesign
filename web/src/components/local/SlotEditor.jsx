// web/src/components/local/SlotEditor.jsx — 模型插槽编辑（<dataRoot>/config.json 的 upstreams + models）。
//
// 表单字段与 server/runtime/local-config.js 的 schema 一一对应（枚举来自 GET /api/local/config 的 enums）——
// 这里不另起一份字段清单。保存 = PUT 原始对象，服务端校验后把 errors 回来标红；表是加载时冻结的，
// 所以保存后要「重启」才生效（页头按钮）。每行有「体检」：POST /api/local/models/:id/probe 五项红绿。
//
// 08-22 下午按用户口径改：① 不让人手写 JSON —— 上游有「常用服务商」预设（选一个，地址/协议/示例模型名
// 自动填）；② 常用数值进下拉（窗口、maxOutput）；③ 模型行只露必填三项（上游 / 上游真名 / 显示名），
// id 从上游真名自动生成，其余收进「高级」。JSON 模式仍在，给会写的人。
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_SANS, FONT_MONO } from '../../lib/theme.js';
import { Local } from '../../lib/api.js';
import { Card, TextInput, Select, Hint, Err, Btn, Dot, Fold } from './primitives.jsx';
import { t } from '../../lib/i18n.js';

/**
 * 常用服务商预设。baseUrl 口径跟服务端一致：
 *   - openai-chat：服务端在后面接 `/chat/completions`，所以地址**带 /v1**（各家文档里的 base_url 原样抄）
 *   - anthropic：服务端把 CLI 的 `/v1/messages` 原路径接上去，所以地址**不带 /v1**
 * 模型名示例只是占位提示，以各家当下的模型列表为准。
 */
const PROVIDER_PRESETS = [
  { id: 'deepseek', label: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/v1', protocol: 'openai-chat', brand: 'deepseek', example: 'deepseek-chat / deepseek-reasoner' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', protocol: 'openai-chat', brand: 'custom', example: 'gpt-5 / gpt-5-mini' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai-chat', brand: 'custom', example: 'deepseek/deepseek-chat（厂商/模型）' },
  { id: 'moonshot', label: 'Moonshot（Kimi）', baseUrl: 'https://api.moonshot.cn/v1', protocol: 'openai-chat', brand: 'custom', example: 'kimi-k2-…（见官方模型列表）' },
  { id: 'zhipu', label: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'openai-chat', brand: 'custom', example: 'glm-4.6 / glm-4.5' },
  { id: 'dashscope', label: '阿里百炼（通义）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'openai-chat', brand: 'qwen', example: 'qwen3-max / qwen-plus' },
  { id: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', protocol: 'openai-chat', brand: 'custom', example: 'deepseek-ai/DeepSeek-V3（厂商/模型）' },
  { id: 'zen', label: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1', protocol: 'openai-chat', brand: 'opencode', example: 'x-preview-f-free' },
  { id: 'zen-go', label: 'OpenCode Zen Go（Go 订阅）', baseUrl: 'https://opencode.ai/zen/go/v1', protocol: 'openai-chat', brand: 'opencode', example: 'ox-alpha-free / deepseek-v4-flash-vision-exp' },
  { id: 'ollama', label: 'Ollama（本机）', baseUrl: 'http://127.0.0.1:11434/v1', protocol: 'openai-chat', authStyle: 'none', brand: 'custom', example: 'qwen3:32b（ollama list 里的名字）' },
  { id: 'lmstudio', label: 'LM Studio（本机）', baseUrl: 'http://127.0.0.1:1234/v1', protocol: 'openai-chat', authStyle: 'none', brand: 'custom', example: '加载中的模型名' },
  { id: 'anthropic-relay', label: 'Anthropic 格式中转站', baseUrl: '', protocol: 'anthropic', brand: 'claude', example: 'claude-sonnet-4-5 之类（中转站给的名字）' },
  { id: 'custom', label: '自定义', baseUrl: '', protocol: 'openai-chat', brand: 'custom', example: '' },
];
const presetByBaseUrl = (baseUrl) => PROVIDER_PRESETS.find((p) => p.baseUrl && baseUrl && baseUrl.replace(/\/+$/, '') === p.baseUrl);

/** 窗口常用档（上游真实上下文）。不在档里的数值显示成「自定义」并露出输入框 */
const WINDOW_PRESETS = [
  { value: 32000, label: '32k' }, { value: 64000, label: '64k' }, { value: 128000, label: '128k' },
  { value: 200000, label: '200k' }, { value: 256000, label: '256k' }, { value: 1000000, label: '1M' },
];
const MAX_OUTPUT_PRESETS = [4096, 8192, 16384, 32768, 65536, 131072];

const EMPTY_UPSTREAM = { baseUrl: '', protocol: 'openai-chat', key: '' };
const EMPTY_MODEL = { id: '', label: '', window: 128000, upstream: '', wireModel: '' };

function errorsFor(errors, whereRe) {
  return (errors || []).filter((e) => whereRe.test(e.where)).map((e) => e.message).join('；');
}
const num = (v) => (v === '' || v == null ? undefined : Number(v));
const esc = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 上游真名 → 合法 id（schema：字母数字 . _ -，64 字内）。'deepseek/deepseek-chat' → 'deepseek-chat' */
const idFromWire = (wire) => String(wire || '').split('/').pop().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

/** 字段 = 小标题 + 控件。放组件外：在 SlotEditor 里定义的话每次渲染都是新类型，React 重挂输入框，敲一个字失一次焦 */
const labelStyle = { fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginBottom: 2 };
function Field({ label, children }) { return <div><div style={labelStyle}>{label}</div>{children}</div>; }

/** 带「自定义」的数值下拉：值在档里就选档，不在就显示自定义 + 输入框 */
function NumberPick({ value, presets, allowEmpty, emptyLabel, onChange, width = 120 }) {
  const inPreset = value == null ? allowEmpty : presets.some((p) => p.value === value);
  const [custom, setCustom] = useState(!inPreset);
  const sel = custom ? '__custom' : (value == null ? '' : String(value));
  const options = [
    ...(allowEmpty ? [{ value: '', label: emptyLabel || t('默认') }] : []),
    ...presets.map((p) => ({ value: String(p.value), label: p.label })),
    { value: '__custom', label: t('自定义…') },
  ];
  return (
    <div style={{ display: 'flex', gap: GAP.xs, alignItems: 'center' }}>
      <Select width={width} value={sel} options={options} onChange={(v) => {
        if (v === '__custom') { setCustom(true); return; }
        setCustom(false); onChange(v === '' ? undefined : Number(v));
      }} />
      {custom && <TextInput type="number" width={110} value={value ?? ''} onChange={(v) => onChange(num(v))} placeholder={t('数字')} />}
    </div>
  );
}

export default function SlotEditor({ config, setConfig, errors, enums, active, needsRestart, onSave, saving, showToast }) {
  const [probe, setProbe] = useState({});        // id → { busy, result }
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonErr, setJsonErr] = useState('');
  const upstreams = config.upstreams || {};
  const models = config.models || [];

  const setUp = (id, patch) => setConfig({ ...config, upstreams: { ...upstreams, [id]: { ...upstreams[id], ...patch } } });
  const renameUp = (oldId, newId) => {
    if (newId === oldId || !newId) return;
    const next = {}; for (const [k, v] of Object.entries(upstreams)) next[k === oldId ? newId : k] = v;
    setConfig({ ...config, upstreams: next, models: models.map((m) => (m.upstream === oldId ? { ...m, upstream: newId } : m)) });
  };
  const delUp = (id) => { const next = { ...upstreams }; delete next[id]; setConfig({ ...config, upstreams: next }); };
  const setModel = (i, patch) => setConfig({ ...config, models: models.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  const delModel = (i) => setConfig({ ...config, models: models.filter((_, j) => j !== i) });
  const addUpstream = () => { let i = 1; while (upstreams[`upstream${i}`]) i++; setUp(`upstream${i}`, EMPTY_UPSTREAM); };
  const addModel = () => setConfig({ ...config, models: [...models, { ...EMPTY_MODEL, upstream: Object.keys(upstreams)[0] || '' }] });

  /** 选预设：地址/协议/鉴权/显示名一起填；id 还是自动名（upstreamN）的话换成预设名（不撞已有的） */
  const applyPreset = (id, presetId) => {
    const p = PROVIDER_PRESETS.find((x) => x.id === presetId);
    if (!p) return;
    const patch = { baseUrl: p.baseUrl, protocol: p.protocol, label: p.label, authStyle: p.authStyle };
    let newId = id;
    if (/^upstream\d+$/.test(id) && p.id !== 'custom' && !upstreams[p.id]) newId = p.id;
    const next = {}; for (const [k, v] of Object.entries(upstreams)) next[k === id ? newId : k] = k === id ? { ...v, ...patch } : v;
    if (!patch.authStyle) delete next[newId].authStyle;
    setConfig({ ...config, upstreams: next, models: models.map((m) => (m.upstream === id ? { ...m, upstream: newId } : m)) });
  };

  const runProbe = async (id) => {
    setProbe((p) => ({ ...p, [id]: { busy: true } }));
    try { const r = await Local.probe(id); setProbe((p) => ({ ...p, [id]: { result: r } })); }
    catch (e) { setProbe((p) => ({ ...p, [id]: { result: { error: e.message } } })); showToast?.(t('体检失败：{err}', { err: e.message }), 'error'); }
  };

  if (jsonMode) {
    return (
      <Card>
        <div style={{ display: 'flex', gap: GAP.md, marginBottom: GAP.sm, alignItems: 'center' }}>
          <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>{t('直接编辑 config.json（形状见 server/runtime/local-config.js 文件头）')}</span>
          <span style={{ flex: 1 }} />
          <Btn small onClick={() => { try { setConfig(JSON.parse(jsonText)); setJsonErr(''); setJsonMode(false); } catch (e) { setJsonErr(t('JSON 不合法：{err}', { err: e.message })); } }}>{t('应用到表单')}</Btn>
          <Btn small onClick={() => { setJsonMode(false); setJsonErr(''); }}>{t('取消')}</Btn>
        </div>
        <textarea value={jsonText} onChange={(e) => setJsonText(e.target.value)} spellCheck={false}
          style={{ width: '100%', minHeight: 320, boxSizing: 'border-box', fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, color: COLOR.text, background: COLOR.bgWhite, border: `1px solid ${COLOR.borderMd}`, borderRadius: RADIUS.lg, padding: GAP.md }} />
        <Err>{jsonErr}</Err>
      </Card>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.lg }}>
      <div style={{ display: 'flex', gap: GAP.md, alignItems: 'center' }}>
        <Btn primary disabled={saving} onClick={onSave}>{saving ? t('保存中…') : t('保存插槽')}</Btn>
        {needsRestart && <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.warn }}>{t('已保存，重启后生效（页头「重启」）')}</span>}
        <span style={{ flex: 1 }} />
        <Btn small onClick={() => { setJsonText(JSON.stringify(config, null, 2)); setJsonMode(true); }}>{t('JSON 模式')}</Btn>
      </div>
      <Err>{errorsFor(errors, /^\((根|文件)\)/)}</Err>

      {/* 第一步：上游 */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: GAP.md, marginBottom: GAP.sm }}>
          <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2 }}>{t('① 服务商（接口地址 + 钥匙）')}</span>
          <Btn small onClick={addUpstream}><Plus size={12} /> {t('加一个')}</Btn>
        </div>
        {Object.keys(upstreams).length === 0 && <Hint>{t('先加一个服务商：从预设里挑（DeepSeek / OpenAI / 中转站…），填上钥匙；然后在 ② 里加模型。')}</Hint>}
        <div style={{ display: 'grid', gap: GAP.md }}>
          {Object.entries(upstreams).map(([id, u]) => {
            const preset = presetByBaseUrl(u.baseUrl);
            return (
              <Card key={id} style={{ padding: GAP.md }}>
                <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr 200px 28px', gap: GAP.sm, alignItems: 'end' }}>
                  <Field label={t('服务商')}>
                    <Select value={preset?.id || (u.baseUrl ? 'custom' : '')} options={[{ value: '', label: t('选一个…') }, ...PROVIDER_PRESETS.map((p) => ({ value: p.id, label: t(p.label) }))]} onChange={(v) => applyPreset(id, v)} />
                  </Field>
                  <Field label={(u.protocol || 'openai-chat') === 'openai-chat' ? t('接口地址（OpenAI 格式，带 /v1）') : t('接口地址（Anthropic 格式，不带 /v1）')}>
                    <TextInput value={u.baseUrl} onChange={(v) => setUp(id, { baseUrl: v })} placeholder={(u.protocol || 'openai-chat') === 'openai-chat' ? 'https://api.example.com/v1' : 'https://relay.example.com'} />
                  </Field>
                  <Field label="API Key">
                    <TextInput type="password" value={u.key || ''} onChange={(v) => setUp(id, { key: v })} placeholder={u.keyEnv ? t('从 env {env} 取', { env: u.keyEnv }) : (u.authStyle === 'none' ? t('本机服务不用钥匙') : t('钥匙'))} />
                  </Field>
                  <button onClick={() => delUp(id)} title="删除" style={{ border: 0, background: 'transparent', color: COLOR.sub, cursor: 'pointer', paddingBottom: 8 }}><Trash2 size={14} /></button>
                </div>
                <Fold title={t('高级')} desc={t('协议 / 鉴权方式 / 内部名')}>
                  <div style={{ display: 'grid', gridTemplateColumns: '160px 160px 160px', gap: GAP.sm, alignItems: 'end' }}>
                    <Field label={t('接口格式')}>
                      <Select value={u.protocol || 'openai-chat'} options={enums.PROTOCOLS.map((p) => ({ value: p, label: p === 'openai-chat' ? t('OpenAI 格式') : t('Anthropic 格式') }))} onChange={(v) => setUp(id, { protocol: v })} />
                    </Field>
                    <Field label={t('鉴权头')}>
                      <Select value={u.authStyle || ''} options={[{ value: '', label: t('按格式默认') }, ...enums.AUTH_STYLES]} onChange={(v) => setUp(id, { authStyle: v || undefined })} />
                    </Field>
                    <Field label={t('内部名（模型行引用它）')}>
                      <TextInput value={id} onChange={(v) => renameUp(id, v)} placeholder={t('字母数字')} />
                    </Field>
                  </div>
                  <Hint>OpenAI 格式 = /chat/completions（经转换层，大多数国产/第三方接口是这个）；Anthropic 格式 = /v1/messages 原生直通。鉴权头默认：OpenAI 格式 bearer，Anthropic 格式 x-api-key。</Hint>
                </Fold>
                <Err>{errorsFor(errors, new RegExp(`^upstreams\\.${esc(id)}(\\b|$)`))}</Err>
              </Card>
            );
          })}
        </div>
      </div>

      {/* 第二步：模型行 */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: GAP.md, marginBottom: GAP.sm }}>
          <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2 }}>{t('② 模型（每一行 = 模型选择器里的一项）')}</span>
          <Btn small disabled={!Object.keys(upstreams).length} onClick={addModel}><Plus size={12} /> {t('加一行')}</Btn>
        </div>
        <div style={{ display: 'grid', gap: GAP.md }}>
          {models.map((m, i) => {
            const pr = probe[m.id];
            const isActive = active?.includes(m.id);
            const preset = presetByBaseUrl(upstreams[m.upstream]?.baseUrl);
            const idAuto = !m.id || m.id === idFromWire(m.wireModel);   // id 还跟着上游真名走 → 改真名时自动更新
            return (
              <Card key={i} style={{ padding: GAP.md }}>
                <div style={{ display: 'grid', gridTemplateColumns: '170px 1fr 1fr 150px 28px', gap: GAP.sm, alignItems: 'end' }}>
                  <Field label={t('服务商')}>
                    <Select value={m.upstream || ''} options={[{ value: '', label: t('选一个…') }, ...Object.keys(upstreams).map((k) => ({ value: k, label: upstreams[k].label || k }))]}
                      onChange={(v) => { const p = presetByBaseUrl(upstreams[v]?.baseUrl); setModel(i, { upstream: v, ...(p?.brand && (!m.brand || m.brand === 'custom') ? { brand: p.brand } : {}) }); }} />
                  </Field>
                  <Field label={t('模型名（发给服务商的 model，一字不差）')}>
                    <TextInput value={m.wireModel} onChange={(v) => setModel(i, { wireModel: v, ...(idAuto ? { id: idFromWire(v) } : {}), ...(!m.label || m.label === m.wireModel ? { label: v } : {}) })} placeholder={preset?.example || t('如 deepseek-chat')} />
                  </Field>
                  <Field label={t('显示名（选择器里的名字）')}>
                    <TextInput mono={false} value={m.label} onChange={(v) => setModel(i, { label: v })} placeholder={t('如 DeepSeek V3')} />
                  </Field>
                  <Field label={t('上下文窗口')}>
                    <NumberPick value={m.window} presets={WINDOW_PRESETS} onChange={(v) => setModel(i, { window: v })} width={150} />
                  </Field>
                  <button onClick={() => delModel(i)} title="删除" style={{ border: 0, background: 'transparent', color: COLOR.sub, cursor: 'pointer', paddingBottom: 8 }}><Trash2 size={14} /></button>
                </div>
                <div style={{ display: 'flex', gap: GAP.sm, alignItems: 'center', justifyContent: 'flex-end', marginTop: GAP.sm }}>
                  <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: isActive ? COLOR.success : COLOR.sub }}>{isActive ? t('● 生效中') : t('○ 未生效（保存并重启）')}</span>
                  <Btn small disabled={!isActive || pr?.busy} onClick={() => runProbe(m.id)}>{pr?.busy ? t('体检中…') : t('体检')}</Btn>
                </div>
                <Fold title={t('高级')} desc={t('说明 / 思考参数 / 输出上限 / 图标 / 内部 id')}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 200px 140px 200px 140px 160px', gap: GAP.sm, alignItems: 'end' }}>
                    <Field label={t('一句话说明（选择器里的灰字）')}><TextInput mono={false} value={m.desc || ''} onChange={(v) => setModel(i, { desc: v })} placeholder={t('可空')} /></Field>
                    <Field label={t('thinking 参数')}><Select value={m.thinking || 'strip'} options={enums.THINKING_MODES.map((t) => ({ value: t, label: t === 'strip' ? t('剥掉（非 Claude 用这个）') : t }))} onChange={(v) => setModel(i, { thinking: v })} /></Field>
                    <Field label="reasoning_effort"><Select value={m.reasoningEffort || ''} options={[{ value: '', label: t('不传') }, ...enums.REASONING_EFFORTS]} onChange={(v) => setModel(i, { reasoningEffort: v || undefined })} /></Field>
                    <Field label={t('单轮最大输出')}><NumberPick value={m.maxOutput} presets={MAX_OUTPUT_PRESETS.map((v) => ({ value: v, label: v >= 1024 ? `${Math.round(v / 1024)}k` : String(v) }))} allowEmpty emptyLabel="默认" onChange={(v) => setModel(i, { maxOutput: v })} width={110} /></Field>
                    <Field label={t('图标')}><Select value={m.brand || 'custom'} options={enums.BRANDS} onChange={(v) => setModel(i, { brand: v })} /></Field>
                    <Field label={t('内部 id')}><TextInput value={m.id} onChange={(v) => setModel(i, { id: v })} placeholder={t('自动')} /></Field>
                  </div>
                  <Hint>{t('窗口填服务商标称的上下文长度（填大了撑满时对方 400，填小了白扔容量）。价目 / 重试 / liftImages / fastModel 这些少用字段在 JSON 模式里填，字段名同内置表。')}</Hint>
                </Fold>
                <Err>{errorsFor(errors, new RegExp(`^models(\\[${i}\\]| \\(${esc(m.id)}\\))`))}</Err>
                {pr?.result && <ProbeResult r={pr.result} />}
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ProbeResult({ r }) {
  if (r.error) return <Err>{r.error}</Err>;
  return (
    <div style={{ marginTop: GAP.sm, borderTop: `1px solid ${COLOR.borderLt}`, paddingTop: GAP.sm }}>
      {r.checks.map((c) => (
        <div key={c.id} style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text3, padding: '2px 0' }}>
          <Dot ok={c.ok} /><b style={{ color: COLOR.text2 }}>{c.label}</b>
          {c.level === 'info' && <span style={{ color: COLOR.sub }}>{t('（参考）')}</span>}
          <span style={{ fontFamily: FONT_MONO, color: COLOR.sub, marginLeft: 6 }}>{c.ms ? `${(c.ms / 1000).toFixed(1)}s` : ''}</span>
          <span style={{ marginLeft: 8 }}>{c.note}</span>
        </div>
      ))}
    </div>
  );
}
