// 设置 → 外观：语言、字体、缩放。全在浏览器本地，改了立刻生效。
import { useState } from 'react';
import { Panel, Row, Segmented } from './ui.jsx';
import { useGlobalStore } from '../../stores/globalStore.js';
import { loadUiPrefs, saveUiPrefs, FONTS, ZOOMS } from '../../lib/ui-prefs.js';
import { LOCALES, getLocale, t } from '../../lib/i18n.js';

export default function AppearanceSection() {
  const [prefs, setPrefs] = useState(loadUiPrefs());
  const set = (patch) => setPrefs(saveUiPrefs(patch));
  useGlobalStore((s) => s.locale);   // 订阅只为重渲染；真值读 getLocale()
  const setLocale = useGlobalStore((s) => s.setLocale);
  const pickLocale = (id) => {
    setLocale(id);
    fetch('/api/auth/locale', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locale: id }) }).catch(() => {});
  };
  return (
    <Panel>
      <Row first label={t('语言')} desc={t('界面语言。产物用什么语言写，跟着你的要求走，不受这里影响')}>
        <Segmented value={getLocale()} onChange={pickLocale} options={LOCALES.map((l) => ({ value: l.id, label: l.label }))} />
      </Row>
      <Row label={t('字体')} desc={t('界面文字用楷体还是系统无衬线')}>
        <Segmented value={prefs.font} onChange={(v) => set({ font: v })} options={FONTS.map((f) => ({ value: f.id, label: t(f.label) }))} />
      </Row>
      <Row label={t('缩放')} desc={t('整个界面的大小。高分辨率屏幕上字太小就调大一档')}>
        <Segmented value={prefs.zoom} onChange={(v) => set({ zoom: v })} options={ZOOMS.map((z) => ({ value: z, label: `${z}%` }))} />
      </Row>
    </Panel>
  );
}
