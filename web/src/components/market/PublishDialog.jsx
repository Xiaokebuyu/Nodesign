import { useState, useEffect, useRef, useMemo } from 'react';
import { ImagePlus, X } from 'lucide-react';
import Modal, { ModalFooter, modalInput, modalLabel, modalHint, modalInputFocus } from '../ui/Modal.jsx';
import { PAPER } from '../../lib/paper.js';
import { GAP, RADIUS, FONT_SIZE, FONT_MONO } from '../../lib/theme.js';
import { Market } from '../../lib/api-market.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { t } from '../../lib/i18n.js';

/**
 * PublishDialog — 把一个 skill 发到市场（2026-09-08）
 *
 * 两个入口共用：橱窗卡片（带 showcaseId，不传图就用那件作品截封面）和 Skill 管理页
 * （只有 skillName，必须自己传图）。发出去进待审，站主看过全文和图才上架。
 *
 * 发布的是**装着的那份**打包后的字节，不是橱窗记录 —— 之后改本地的 skill 不影响货架上的。
 */
const IMAGE_MAX = 6;

export default function PublishDialog({ show, onClose, skillName, showcaseId = null, defaultTitle = '', defaultNote = '', onPublished }) {
  const [title, setTitle] = useState(defaultTitle);
  const [note, setNote] = useState(defaultNote);
  const [images, setImages] = useState([]);   // File[]
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const showToast = useGlobalStore(s => s.showToast);

  useEffect(() => { if (show) { setTitle(defaultTitle); setNote(defaultNote); setImages([]); } }, [show, defaultTitle, defaultNote]);

  const previews = useMemo(() => images.map(f => URL.createObjectURL(f)), [images]);
  useEffect(() => () => previews.forEach(u => URL.revokeObjectURL(u)), [previews]);

  const pick = (e) => {
    const files = Array.from(e.target.files || []).filter(f => f.type.startsWith('image/'));
    setImages(list => [...list, ...files].slice(0, IMAGE_MAX));
    e.target.value = '';
  };

  const submit = async () => {
    if (!title.trim()) return showToast(t('标题不能为空'), 'error');
    if (!images.length && !showcaseId) return showToast(t('至少传一张参考图'), 'error');
    setBusy(true);
    try {
      const { publication } = await Market.publish({ title: title.trim(), note: note.trim(), skillName, showcaseId, images });
      showToast(t('已提交，等站主看过就上架'), 'success');
      onPublished?.(publication);
      onClose?.();
    } catch (err) {
      const detail = Array.isArray(err.body?.errors) ? `：${err.body.errors[0]}` : '';
      showToast(t('发布失败：{err}', { err: err.message + detail }), 'error');
    } finally { setBusy(false); }
  };

  return (
    <Modal show={show} onClose={busy ? undefined : onClose} title={t('发布到市场')} width={520} closable={!busy}>
      <div style={{ padding: `${GAP.lg}px ${GAP.xl}px`, display: 'flex', flexDirection: 'column', gap: GAP.xl }}>
        <div>
          <label style={modalLabel}>Skill</label>
          <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.md, color: PAPER.ink }}>{skillName}</div>
          <div style={{ ...modalHint, marginTop: GAP.xs }}>{t('发的是现在装着的这份。之后本地再改，货架上的不跟着变。')}</div>
        </div>
        <div>
          <label style={modalLabel}>{t('标题')}</label>
          <input style={modalInput} {...modalInputFocus} value={title} maxLength={80} onChange={e => setTitle(e.target.value)} placeholder={t('别人在货架上看到的名字')} />
        </div>
        <div>
          <label style={modalLabel}>{t('说明')}</label>
          <textarea
            style={{ ...modalInput, fontSize: FONT_SIZE.lg, minHeight: 72, resize: 'vertical', lineHeight: 1.6 }}
            {...modalInputFocus} value={note} maxLength={2000} onChange={e => setNote(e.target.value)}
            placeholder={t('它适合做什么、在哪种场合会失效。写给要装它的人。')}
          />
        </div>
        <div>
          <label style={modalLabel}>{t('参考图')}</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: GAP.sm }}>
            {previews.map((src, i) => (
              <div key={src} style={{ position: 'relative', width: 96, height: 60, borderRadius: RADIUS.md, overflow: 'hidden', border: `1px solid ${PAPER.hair}` }}>
                <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                <button onClick={() => setImages(list => list.filter((_, j) => j !== i))} title={t('去掉')} style={{
                  position: 'absolute', top: 2, right: 2, width: 18, height: 18, borderRadius: 9, border: 0,
                  background: 'rgba(43,33,23,0.7)', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}><X size={10} /></button>
              </div>
            ))}
            {images.length < IMAGE_MAX && (
              <button onClick={() => fileRef.current?.click()} style={{
                width: 96, height: 60, borderRadius: RADIUS.md, border: `1px dashed ${PAPER.pencil}`, background: 'transparent',
                color: PAPER.pencil, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}><ImagePlus size={16} /></button>
            )}
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={pick} />
          </div>
          <div style={{ ...modalHint, marginTop: GAP.xs }}>
            {showcaseId
              ? t('不传就用这件作品的首屏截图当封面；最多 {n} 张。', { n: IMAGE_MAX })
              : t('至少一张，最多 {n} 张。给别人看看这套方法做出来的东西长什么样。', { n: IMAGE_MAX })}
          </div>
        </div>
      </div>
      <ModalFooter onCancel={onClose} onConfirm={submit} confirmLabel={busy ? t('提交中…') : t('提交审核')} cancelLabel={t('取消')} confirmDisabled={busy} />
    </Modal>
  );
}
