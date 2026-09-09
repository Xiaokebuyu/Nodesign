// 设置 → 外观：语言、字体。全在浏览器本地，改了立刻生效。（界面缩放 09-09 已拿掉，见 lib/ui-prefs.js 文件头）
import { useState } from 'react';
import { Panel, Row, Segmented } from './ui.jsx';
import { useGlobalStore } from '../../stores/globalStore.js';
import { loadUiPrefs, saveUiPrefs, FONTS } from '../../lib/ui-prefs.js';
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
      <Row first label={t('语言')} desc={t('界面显示语言。产物使用的语言由您的要求决定，不受此设置影响')}>
        <Segmented value={getLocale()} onChange={pickLocale} options={LOCALES.map((l) => ({ value: l.id, label: l.label }))} />
      </Row>
      <Row label={t('字体')} desc={t('界面文字使用楷体或系统无衬线字体')}>
        <Segmented value={prefs.font} onChange={(v) => set({ font: v })} options={FONTS.map((f) => ({ value: f.id, label: t(f.label) }))} />
      </Row>
    </Panel>
  );
}
