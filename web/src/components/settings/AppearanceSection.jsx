// 设置 → 外观：语言、字体、缩放。全在浏览器本地，改了立刻生效。
import { useState } from 'react';
import { COLOR, GAP, FONT_SIZE, FONT_SANS } from '../../lib/theme.js';
import { Card } from '../local/primitives.jsx';
import LanguageSwitcher from '../ui/LanguageSwitcher.jsx';
import { loadUiPrefs, saveUiPrefs, FONTS, ZOOMS } from '../../lib/ui-prefs.js';
import { t } from '../../lib/i18n.js';

const row = { display: 'grid', gridTemplateColumns: '96px 1fr', gap: `${GAP.md}px ${GAP.lg}px`, alignItems: 'center', fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm };

export default function AppearanceSection() {
  const [prefs, setPrefs] = useState(loadUiPrefs());
  const set = (patch) => setPrefs(saveUiPrefs(patch));
  return (
    <Card>
      <div style={row}>
        <span style={{ color: COLOR.sub }}>{t('语言')}</span>
        <div><LanguageSwitcher variant="chrome" /></div>
        <span style={{ color: COLOR.sub }}>{t('字体')}</span>
        <div style={{ display: 'flex', gap: GAP.sm }}>
          {FONTS.map((f) => <Pill key={f.id} on={prefs.font === f.id} onClick={() => set({ font: f.id })}>{t(f.label)}</Pill>)}
        </div>
        <span style={{ color: COLOR.sub }}>{t('缩放')}</span>
        <div style={{ display: 'flex', gap: GAP.sm }}>
          {ZOOMS.map((z) => <Pill key={z} on={prefs.zoom === z} onClick={() => set({ zoom: z })}>{z}%</Pill>)}
        </div>
      </div>
    </Card>
  );
}

function Pill({ on, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      padding: `3px ${GAP.md}px`, borderRadius: 999, cursor: 'pointer', fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
      border: `1px solid ${on ? COLOR.text : COLOR.borderLt}`, background: on ? COLOR.text : 'transparent', color: on ? COLOR.bgWhite : COLOR.text2,
    }}>{children}</button>
  );
}
