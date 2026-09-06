// web/src/components/local/EnvKeys.jsx — 钥匙与开关（<dataRoot>/.env 白名单）。值只在输入框里存在，
// 服务端回的是打码预览；清空 = 删键。保存后钥匙类立刻生效，能力表随响应刷新。
import { useState, useEffect } from 'react';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO } from '../../lib/theme.js';
import { Local } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { Card, TextInput, Select, Hint, Err, Btn, Dot } from './primitives.jsx';

/**
 * @param {string[]} [only]    只渲染这些分组（设置页「模型」那块只要 '模型' 组）
 * @param {string[]} [exclude] 不渲染这些分组
 * @param {boolean}  [bare]    不套 Card（嵌进别人的 Card 里）
 */
export default function EnvKeys({ onCapabilities, showToast, onSaved, only, exclude, bare = false }) {
  const [keys, setKeys] = useState(null);     // 服务端视图
  const [edits, setEdits] = useState({});     // key → 新值（'' = 清空）
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const reload = () => Local.env().then((r) => { setKeys(r.keys); setEdits({}); }).catch((e) => setErr(e.message));
  useEffect(() => { reload(); }, []);

  if (!keys) return <Card><span style={{ color: COLOR.sub, fontSize: FONT_SIZE.sm }}>{err || '读取中…'}</span></Card>;
  const groups = [...new Set(keys.map((k) => k.group))].filter((g) => (!only || only.includes(g)) && !(exclude || []).includes(g));
  const dirty = Object.keys(edits).length > 0;

  const save = async (values) => {
    setBusy(true); setErr('');
    try {
      const r = await Local.saveEnv(values);
      setKeys(r.keys); setEdits({});
      onCapabilities?.(r.capabilities);
      onSaved?.(r);
      showToast?.(r.changed.length ? `已保存 ${r.changed.join(', ')}` : '没有变化', 'info');
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const Wrap = bare ? ({ children }) => <div>{children}</div> : Card;
  return (
    <Wrap>
      {groups.map((g) => (
        <div key={g} style={{ marginBottom: GAP.lg }}>
          {groups.length > 1 && <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text4, marginBottom: GAP.sm, letterSpacing: 1 }}>{t(g)}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 220px) 1fr', gap: `${GAP.sm}px ${GAP.lg}px`, alignItems: 'start' }}>
            {keys.filter((k) => k.group === g).filter((k) => {
              // showIf：{ 某键: 值 } —— 那个键的当前值（正在编辑的优先，其次已存的，再次默认值）等于它才显示
              if (!k.showIf) return true;
              return Object.entries(k.showIf).every(([dep, want]) => {
                const d = keys.find((x) => x.key === dep);
                const cur = dep in edits ? edits[dep] : (d?.preview || d?.default || '');
                return cur === want;
              });
            }).map((k) => {
              const editing = k.key in edits;
              const curVal = editing ? edits[k.key] : (k.preview || k.default || '');
              return [
                <div key={k.key + '-l'} style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2, paddingTop: 6 }}>
                  <Dot ok={k.set ? true : null} />{k.label}
                  <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>{k.key}</div>
                </div>,
                <div key={k.key + '-v'}>
                  {k.options
                    ? <Select width={220} value={curVal} options={k.options} onChange={(v) => setEdits({ ...edits, [k.key]: v })} />
                    : <TextInput type={k.secret ? 'password' : 'text'} value={editing ? edits[k.key] : ''} placeholder={k.set ? `已配 ${k.preview}（留空不改；要清除请输入 - ）` : '未配'}
                      onChange={(v) => setEdits({ ...edits, [k.key]: v })} />}
                  {k.hint && <Hint>{k.hint}</Hint>}
                  {k.optionHints?.[curVal] && <Hint>{k.optionHints[curVal]}</Hint>}
                </div>,
              ];
            })}
          </div>
        </div>
      ))}
      <div style={{ display: 'flex', gap: GAP.md, alignItems: 'center' }}>
        <Btn primary disabled={!dirty || busy} onClick={() => {
          // 约定：输入单个 "-" = 清除这个键
          const values = Object.fromEntries(Object.entries(edits).map(([k, v]) => [k, v === '-' ? null : v]));
          save(values);
        }}>{busy ? '保存中…' : '保存钥匙'}</Btn>
        {dirty && <Btn onClick={() => setEdits({})}>放弃改动</Btn>}
        <Err>{err}</Err>
      </div>
    </Wrap>
  );
}
