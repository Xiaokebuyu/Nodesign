// 设置 → 模型：一张清单（站点给的 + 本机钥匙的），每行一个开关决定进不进选择器，一个"默认"。
// "使用自己的 API Key"收在底下折叠框里 —— BYOK 是子功能，不是主路（站主 09-06：照 Cursor 做）。
import { useEffect, useState } from 'react';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO } from '../../lib/theme.js';
import { Local } from '../../lib/api.js';
import { Card, Fold, Err, Hint, Dot } from '../local/primitives.jsx';
import EnvKeys from '../local/EnvKeys.jsx';
import SlotEditor from '../local/SlotEditor.jsx';
import { t } from '../../lib/i18n.js';

export default function ModelsSection({ status, cfg, draft, setDraft, save, saving, needsRestart, onStatus, showToast }) {
  const [list, setList] = useState(null);
  const [prefs, setPrefs] = useState(null);
  const [err, setErr] = useState('');

  const reload = () => Promise.all([fetch('/api/me/models').then((r) => r.json()), Local.prefs()])
    .then(([m, p]) => { setList(m); setPrefs(p.prefs); }).catch((e) => setErr(e.message));
  useEffect(() => { reload(); }, []);

  const put = async (patch) => {
    try { const r = await Local.savePrefs(patch); setPrefs(r.prefs); await reload(); }
    catch (e) { showToast?.(e.message, 'error'); }
  };
  const toggle = (id, hidden) => put({ hiddenModels: hidden ? [...(prefs.hiddenModels || []), id] : (prefs.hiddenModels || []).filter((x) => x !== id) });

  const options = list?.options || [];
  return (
    <>
      <Card style={{ marginBottom: GAP.md }}>
        {err && <Err>{err}</Err>}
        {list && options.length === 0 && (
          <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text3 }}>
            {t('还没有可用的模型。登录站点账号（「账户」页），或者在下面填自己的 API Key。')}
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: `${GAP.sm}px ${GAP.lg}px`, alignItems: 'center', fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm }}>
          {options.map((m) => {
            const isDefault = list.default === m.id;
            return [
              <div key={m.id + 'a'} style={{ opacity: m.hidden ? 0.55 : 1 }}>
                <span style={{ color: COLOR.text }}>{m.label}</span>
                <span style={{ marginLeft: GAP.sm, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>{m.source === 'relay' ? t('站点') : t('本机钥匙')}{m.locked ? ` · ${m.lockReason || t('锁着')}` : ''}</span>
                <div style={{ fontSize: FONT_SIZE.xs, color: COLOR.text4 }}>{m.desc}</div>
              </div>,
              <button key={m.id + 'b'} disabled={m.locked || m.hidden} onClick={() => put({ defaultModel: m.id })} style={pill(isDefault)}>{isDefault ? t('默认') : t('设为默认')}</button>,
              <label key={m.id + 'c'} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: COLOR.text3, fontSize: FONT_SIZE.xs }}>
                <input type="checkbox" checked={!m.hidden} onChange={(e) => toggle(m.id, !e.target.checked)} />{t('在选择器里显示')}
              </label>,
            ];
          })}
        </div>
      </Card>

      <Fold title={t('使用自己的 API Key')} desc={t('填了钥匙的模型走你自己的账，不经站点，也不计入站点额度')}>
        <div style={{ marginBottom: GAP.lg }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: GAP.md, marginBottom: GAP.sm, fontFamily: FONT_SANS }}>
            <span style={{ fontSize: FONT_SIZE.md, fontWeight: 600, color: COLOR.text }}>{t('Claude 官方')}</span>
            <span style={{ fontSize: FONT_SIZE.xs, color: status?.claudeAuth ? COLOR.success : COLOR.sub }}>
              <Dot ok={!!status?.claudeAuth} />
              {status?.claudeAuth ? t('已配（API Key）') : t('未配')}
            </span>
          </div>
          <EnvKeys only={['模型']} bare showToast={showToast} onSaved={onStatus} />
        </div>
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: GAP.md, marginBottom: GAP.sm, fontFamily: FONT_SANS }}>
            <span style={{ fontSize: FONT_SIZE.md, fontWeight: 600, color: COLOR.text }}>{t('自定义服务商')}</span>
            <span style={{ fontSize: FONT_SIZE.xs, color: COLOR.sub }}>{t('DeepSeek、OpenAI、智谱、通义、OpenRouter、中转站、本机 Ollama…（OpenAI 格式或 Anthropic 格式都行）')}</span>
            <span style={{ fontSize: FONT_SIZE.xs, color: cfg?.activeExternalModels?.length ? COLOR.success : COLOR.sub }}>
              <Dot ok={!!cfg?.activeExternalModels?.length} />{cfg?.activeExternalModels?.length ? t('已配 {n} 个模型', { n: cfg.activeExternalModels.length, count: cfg.activeExternalModels.length }) : t('未配')}
            </span>
          </div>
          {cfg && draft
            ? <SlotEditor config={draft} setConfig={setDraft} errors={cfg.errors} enums={cfg.enums} active={cfg.activeExternalModels} needsRestart={needsRestart} onSave={save} saving={saving} showToast={showToast} />
            : <span style={{ color: COLOR.sub, fontSize: FONT_SIZE.sm }}>{t('读取中…')}</span>}
          <Hint><span style={{ fontFamily: FONT_MONO }}>{status?.configPath}</span></Hint>
        </div>
      </Fold>
    </>
  );
}

const pill = (on) => ({
  padding: `2px ${GAP.md}px`, borderRadius: 999, cursor: 'pointer', fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
  border: `1px solid ${on ? COLOR.text : COLOR.borderLt}`, background: on ? COLOR.text : 'transparent', color: on ? COLOR.bgWhite : COLOR.text3,
});
