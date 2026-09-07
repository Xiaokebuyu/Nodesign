// 设置 → 模型：一张清单（站点给的 + 本机钥匙的），每行：默认（单选）+ 在选择器里显示（开关）。
// "使用自己的 API Key"折在底下 —— BYOK 是子功能，不是主路（站主 09-06：照 Cursor 做）。
import { useEffect, useState } from 'react';
import { COLOR, GAP, FONT_SIZE, FONT_KAI } from '../../lib/theme.js';
import { Local } from '../../lib/api.js';
import { Panel, Block, Badge, Radio, Switch, Disclosure, Note, Mono } from './ui.jsx';
import ModelMark from '../ui/ModelMark.jsx';
import EnvKeys from '../local/EnvKeys.jsx';
import SlotEditor from '../local/SlotEditor.jsx';
import { t } from '../../lib/i18n.js';

const HAIR = 'rgba(43,33,23,0.08)';

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
  const toggle = (id, hidden) => put({ hiddenModels: hidden ? [...(prefs?.hiddenModels || []), id] : (prefs?.hiddenModels || []).filter((x) => x !== id) });

  const options = list?.options || [];
  const byokCount = cfg?.activeExternalModels?.length || 0;
  return (
    <>
      <Panel title={t('可用的模型')} desc={t('默认模型用于新建的会话。关闭显示后该行不再出现在选择器中，正在使用它的会话不受影响')}>
        {err && <Block><Note tone="bad">{err}</Note></Block>}
        {!list && !err && <Block first><Note>{t('读取中…')}</Note></Block>}
        {list && options.length === 0 && (
          <Block first><Note>{t('暂无可用模型。请在「账户」中登录站点账号，或在下方填写您的 API Key。')}</Note></Block>
        )}
        {options.map((m, i) => {
          const isDefault = list.default === m.id;
          return (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: GAP.xl, padding: `${GAP.lg}px ${GAP.xxl}px`, borderTop: i === 0 ? 0 : `1px solid ${HAIR}`, opacity: m.hidden ? 0.55 : 1 }}>
              <Radio checked={isDefault} disabled={m.locked || m.hidden} onChange={() => put({ defaultModel: m.id })} label={t('设为默认')} />
              <ModelMark brand={m.brand} size={16} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: GAP.md, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: FONT_KAI, fontSize: FONT_SIZE.lg, color: COLOR.text }}>{m.label}</span>
                  {isDefault && <Badge tone="ink">{t('默认')}</Badge>}
                  <Badge>{m.source === 'relay' ? t('站点') : t('自有 API Key')}</Badge>
                  {m.locked && <Badge tone="warn">{m.lockReason || t('受限')}</Badge>}
                </div>
                {m.desc && <div style={{ fontFamily: FONT_KAI, fontSize: FONT_SIZE.md, color: COLOR.text4, marginTop: 2, lineHeight: 1.6 }}>{m.desc}</div>}
              </div>
              <Switch checked={!m.hidden} onChange={(on) => toggle(m.id, !on)} label={t('在选择器里显示')} />
            </div>
          );
        })}
      </Panel>

      <Panel title={t('使用自己的 API Key')} desc={t('使用您自己 API Key 的模型不经过站点，费用由您的 API 账户承担，也不计入站点额度。')}>
        <Disclosure title={t('Claude 官方')} desc={status?.claudeAuth ? t('已配') : t('未配')}>
          <EnvKeys only={['模型']} bare showToast={showToast} onSaved={onStatus} />
        </Disclosure>
        <Disclosure title={t('自定义服务商')} desc={byokCount ? t('已配 {n} 个模型', { n: byokCount, count: byokCount }) : t('DeepSeek、OpenAI、智谱、通义、OpenRouter、中转站、本机 Ollama')}>
          <Note>{t('支持 OpenAI 格式与 Anthropic 格式。修改后需重启服务端方可生效（「关于」页提供重启按钮）。')}</Note>
          <div style={{ marginTop: GAP.md }}>
            {cfg && draft
              ? <SlotEditor config={draft} setConfig={setDraft} errors={cfg.errors} enums={cfg.enums} active={cfg.activeExternalModels} needsRestart={needsRestart} onSave={save} saving={saving} showToast={showToast} />
              : <Note>{t('读取中…')}</Note>}
          </div>
          {status?.configPath && <div style={{ marginTop: GAP.md }}><Note>{t('配置文件')}：<Mono copy>{status.configPath}</Mono></Note></div>}
        </Disclosure>
      </Panel>
    </>
  );
}
