import { useEffect, useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO, FONT_SANS, alpha } from '../../lib/theme.js';
import { Assets, Exports } from '../../lib/api.js';
import { deliverFile } from '../../lib/deliver-file.js';
import { groupArtifacts } from '../../lib/export-groups.js';
import { exportItemsFor } from '../../lib/export-formats.js';
import { CARD_PIPELINE } from '../canvas/card-export.js';

/**
 * ExportPicker — 按**产物类型**导出（2026-08-17）
 *
 * 两步：先选类型（站点 / 幻灯 / 图片 / …），再挑这个类型下的哪几个。
 * 旧的导出菜单跟着"当前聚焦的产物"走 —— 想导几张图得先去画布上点开某个任务，
 * 那是把内部实现（聚焦态）泄给了用户。
 *
 * 走 `Exports.cards`：卡 id 就是地址，跟画布上那颗导出按钮同一条管线。
 */

/** 烘焙类：跑 playwright / esbuild 的那几种，走老路由且一次只认一份产物 */
const BAKE_FORMATS = new Set(['html', 'pdf', 'pptx']);

/** 卡 id → 产物路径（老路由的 ?path= 收的是路径，不认卡 id 的前缀） */
function relOfCardId(cardId) {
  const c = cardId.indexOf(':');
  return (c > 0 && /^[a-z]+$/.test(cardId.slice(0, c))) ? cardId.slice(c + 1) : cardId;
}

function sizeText(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function ExportPicker({ open, onClose, projectId, initialType = null, onToast }) {
  const [groups, setGroups] = useState([]);
  const [type, setType] = useState(initialType);
  const [picked, setPicked] = useState(() => new Set());
  const [format, setFormat] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    setLoading(true);
    Assets.artifacts(projectId)
      .then((payload) => {
        if (cancelled) return;
        const gs = groupArtifacts(payload);
        setGroups(gs);
        // 进来时如果调用方点的是某个类型，直接落到那一组；否则落第一组
        const g = gs.find(x => x.type === initialType) || gs[0] || null;
        setType(g?.type || null);
        setPicked(new Set());
        setFormat(g?.formats?.[0] || null);
      })
      .catch(err => { if (!cancelled) onToast?.(`读取产物失败：${err.message}`, 'error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, projectId, initialType, onToast]);

  const group = useMemo(() => groups.find(g => g.type === type) || null, [groups, type]);
  const formatItems = useMemo(
    () => (group ? exportItemsFor(group.type, group.formats) : []),
    [group],
  );

  if (!open) return null;

  const switchType = (t) => {
    const g = groups.find(x => x.type === t);
    setType(t);
    setPicked(new Set());
    setFormat(g?.formats?.[0] || null);
  };

  const toggle = (cardId) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(cardId)) next.delete(cardId); else next.add(cardId);
    return next;
  });

  const doExport = async () => {
    if (!picked.size || !format) return;
    // 烘焙类（PDF / PPTX / 单页 HTML）要跑 playwright / esbuild，走老路由，
    // 而且它一次只认一份产物 —— 说清楚，别让用户勾了五个只拿到一个还不知道。
    if (BAKE_FORMATS.has(format) && picked.size !== 1) {
      onToast?.('这个格式一次只能导一份，勾一个再来', 'error');
      return;
    }
    setBusy(true);
    try {
      const ids = [...picked];
      const { blob, filename, skipped } = BAKE_FORMATS.has(format)
        ? await Exports.download(projectId, format, relOfCardId(ids[0]))
        // 菜单里的格式 id 和按卡导出管线的格式不是一套词（'site' → 'zip'），映射表
        // 跟顶栏那条路共用一份，别在这里再抄一份（原来直接把 'site' 发过去，必 400）
        : await Exports.cards(projectId, ids, CARD_PIPELINE[format] || format);
      const name = filename || '导出';
      const { path } = await deliverFile(blob, name);   // 桌面版由主进程写盘，见 lib/deliver-file.js
      onToast?.(path ? `已保存：${path}` : `已下载：${name}`, 'success');
      // 少了什么必须说出来 —— 静默少东西是导出最贵的失败方式
      if (skipped?.total) onToast?.(`有 ${skipped.total} 个没导出：${skipped.items?.[0]?.reason || ''}`, 'error');
      onClose?.();
    } catch (err) {
      onToast?.(`导出失败：${err.message}`, 'error');
    } finally { setBusy(false); }
  };

  const rowBase = {
    display: 'flex', alignItems: 'center', gap: GAP.sm, width: '100%',
    padding: `${GAP.sm}px ${GAP.md}px`, border: 0, borderRadius: RADIUS.sm,
    cursor: 'pointer', textAlign: 'left', fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
  };

  return (
    <Modal show={open} onClose={onClose} title="导出产物" width={560}>
      {loading && <div style={{ padding: GAP.lg, color: COLOR.sub, fontSize: FONT_SIZE.sm }}>读取中…</div>}

      {!loading && !groups.length && (
        <div style={{ padding: GAP.lg, color: COLOR.sub, fontSize: FONT_SIZE.sm }}>
          这个项目里还没有可导出的产物。
        </div>
      )}

      {!loading && !!groups.length && (
        <>
          {/* 第一步：选类型。数量写在标签上 —— 「图片 47」比光写「图片」有用得多 */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: GAP.xs, marginBottom: GAP.md }}>
            {groups.map(g => (
              <button
                key={g.type}
                onClick={() => switchType(g.type)}
                style={{
                  padding: `${GAP.xs}px ${GAP.md}px`, borderRadius: RADIUS.sm, cursor: 'pointer',
                  fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm,
                  border: `1px solid ${g.type === type ? COLOR.text : COLOR.borderLt}`,
                  background: g.type === type ? alpha(COLOR.text, 0.06) : 'transparent',
                  color: g.type === type ? COLOR.text : COLOR.text2,
                }}
              >
                {g.label} {g.items.length}
              </button>
            ))}
          </div>

          {/* 第二步：挑具体哪几个 */}
          <div style={{ maxHeight: 300, overflowY: 'auto', marginBottom: GAP.md }}>
            {group?.items.map(it => (
              <label key={it.cardId} style={{ ...rowBase, background: picked.has(it.cardId) ? alpha(COLOR.text, 0.04) : 'transparent' }}>
                <input type="checkbox" checked={picked.has(it.cardId)} onChange={() => toggle(it.cardId)} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', color: COLOR.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.title}</span>
                  <span style={{ display: 'block', color: COLOR.sub, fontSize: FONT_SIZE.xs }}>{it.subtitle}</span>
                </span>
                {it.size != null && <span style={{ color: COLOR.sub, fontSize: FONT_SIZE.xs, fontFamily: FONT_MONO }}>{sizeText(it.size)}</span>}
              </label>
            ))}
          </div>

          {/* 第三步：格式。格式表由服务端形态注册表给，不在前端硬编码 */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: GAP.xs, marginBottom: GAP.md }}>
            {formatItems.map(f => (
              <button
                key={f.id}
                onClick={() => setFormat(f.id)}
                title={f.desc}
                style={{
                  padding: `${GAP.xs}px ${GAP.md}px`, borderRadius: RADIUS.sm, cursor: 'pointer',
                  fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
                  border: `1px solid ${f.id === format ? COLOR.text : COLOR.borderLt}`,
                  background: f.id === format ? alpha(COLOR.text, 0.06) : 'transparent',
                  color: f.id === format ? COLOR.text : COLOR.text2,
                }}
              >
                {f.label}
              </button>
            ))}
          </div>

          <button
            disabled={!picked.size || !format || busy}
            onClick={doExport}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: GAP.sm,
              width: '100%', padding: `${GAP.sm + 2}px`, borderRadius: RADIUS.sm, border: 0,
              cursor: (!picked.size || !format || busy) ? 'not-allowed' : 'pointer',
              opacity: (!picked.size || !format || busy) ? 0.45 : 1,
              background: COLOR.text, color: COLOR.bgWhite,
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
            }}
          >
            <Download size={14} />
            {busy ? '打包中…' : `导出选中的 ${picked.size} 个`}
          </button>
        </>
      )}
    </Modal>
  );
}
