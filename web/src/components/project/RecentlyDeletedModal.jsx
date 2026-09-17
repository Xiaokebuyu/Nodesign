import { useCallback, useEffect, useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { PAPER_SHADOW } from '../../lib/paper.js';
import { Trash } from '../../lib/api-trash.js';
import { useProjectStore } from '../../stores/projectStore.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { timeAgo } from '../../lib/helpers.js';
import { t } from '../../lib/i18n.js';

/**
 * RecentlyDeletedModal —— 首页「最近删除」（09-17，问题库 iss_mtjex6wv_5xhn）
 *
 * 删除的项目在回收站里保留 N 天（服务端 NODESIGN_TRASH_DAYS），这里列出来：恢复，或立即永久删除。
 * 已发布的站点不随项目删除下线（服务端一直是这样），有的话在行上注明，免得人以为删了项目站点就没了。
 */

const DAY_MS = 86_400_000;

/** 离自动永久删除还有几天（向上取整，过期记 0） */
export function remainingDays(purgeAfter, now = Date.now()) {
  const at = Date.parse(purgeAfter || '');
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.ceil((at - now) / DAY_MS));
}

function remainText(purgeAfter) {
  const n = remainingDays(purgeAfter);
  if (n == null) return '';
  return n > 0 ? t('{n} 天后永久删除', { n, count: n }) : t('即将永久删除');
}

const BTN = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  padding: `${GAP.xs}px ${GAP.md}px`,
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, fontWeight: 500,
  borderRadius: RADIUS.md, cursor: 'pointer', flexShrink: 0,
};

export default function RecentlyDeletedModal({ show, onClose }) {
  const [days, setDays] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const restoreProject = useProjectStore((s) => s.restoreProject);
  const confirm = useGlobalStore((s) => s.confirm);
  const showToast = useGlobalStore((s) => s.showToast);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await Trash.list();
      setDays(Number.isFinite(r?.retentionDays) ? r.retentionDays : null);
      setItems(r?.projects || []);
    } catch (err) {
      setError(err.message || 'load failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (show) reload(); }, [show, reload]);

  const drop = (id) => setItems((list) => list.filter((x) => x.id !== id));

  const handleRestore = async (p) => {
    setBusy(p.id);
    try {
      await restoreProject(p.id);
      drop(p.id);
      showToast(t('已恢复「{name}」', { name: p.name }), 'success');
    } catch (err) {
      showToast(t('恢复失败：{err}', { err: err.message }), 'error');
    } finally {
      setBusy(null);
    }
  };

  const handlePurge = async (p) => {
    const ok = await confirm({
      title: t('永久删除'),
      message: t('永久删除「{name}」？工作区里的文件会立即清除，无法恢复。', { name: p.name }),
      confirmLabel: t('永久删除'),
      danger: true,
    });
    if (!ok) return;
    setBusy(p.id);
    try {
      await Trash.purge(p.id);
      drop(p.id);
      showToast(t('已永久删除「{name}」', { name: p.name }), 'info');
    } catch (err) {
      showToast(t('永久删除失败：{err}', { err: err.message }), 'error');
    } finally {
      setBusy(null);
    }
  };

  const note = { fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub, lineHeight: 1.5 };

  return (
    <Modal show={show} onClose={onClose} title={t('最近删除')} width={560}>
      <div style={{ padding: `${GAP.xl}px ${GAP.xl}px ${GAP.lg}px` }}>
        <div style={{ ...note, marginBottom: GAP.md }}>
          {days == null
            ? t('删除的项目会在这里保留一段时间，到期自动永久删除。')
            : t('删除的项目在这里保留 {days} 天，到期自动永久删除。', { days })}
        </div>

        {error && <div style={{ ...note, color: COLOR.error, marginBottom: GAP.md }}>{t('加载失败：{err}', { err: error })}</div>}
        {loading && items.length === 0 && <div style={{ ...note, padding: GAP.lg }}>{t('正在打开…')}</div>}
        {!loading && !error && items.length === 0 && (
          <div style={{ ...note, padding: `${GAP.xl}px ${GAP.md}px`, textAlign: 'center' }}>{t('最近没有删除的项目。')}</div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.xs, maxHeight: 420, overflow: 'auto' }}>
          {items.map((p) => (
            <div
              key={p.id}
              data-testid="trash-row"
              style={{
                display: 'flex', alignItems: 'center', gap: GAP.md,
                padding: `${GAP.sm + 2}px ${GAP.md}px`,
                borderRadius: 2, background: COLOR.bgWhite, boxShadow: PAPER_SHADOW.far,
                opacity: busy === p.id ? 0.6 : 1,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 600, color: COLOR.text,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{p.name}</div>
                <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginTop: GAP.xxs }}>
                  {t('删除于 {when}', { when: timeAgo(p.deletedAt) })} · {remainText(p.purgeAfter)}
                </div>
                {p.publishedSites > 0 && (
                  <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text4, marginTop: GAP.xxs }}>
                    {t('{n} 个已发布的站点仍在线，需要下线请先恢复项目。', { n: p.publishedSites })}
                  </div>
                )}
              </div>
              <button
                type="button"
                disabled={busy === p.id}
                onClick={() => handleRestore(p)}
                style={{ ...BTN, color: COLOR.btnText, background: COLOR.btn, border: 'none', boxShadow: PAPER_SHADOW.near }}
              >
                <RotateCcw size={12} /> {t('恢复')}
              </button>
              <button
                type="button"
                disabled={busy === p.id}
                onClick={() => handlePurge(p)}
                title={t('立即永久删除，无法恢复')}
                style={{ ...BTN, color: COLOR.error, background: 'transparent', border: `1px solid ${COLOR.borderMd}` }}
              >
                <Trash2 size={12} /> {t('永久删除')}
              </button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
