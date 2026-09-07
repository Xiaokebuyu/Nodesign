import Modal from '../ui/Modal.jsx';
import { GAP, FONT_SIZE, FONT_KAI, COLOR } from '../../lib/theme.js';
import { PAPER } from '../../lib/paper.js';
import { t } from '../../lib/i18n.js';

/**
 * 文件夹项目的信任门（2026-09-07 存量仓库道，桌面版）。
 *
 * 打开的文件夹里如果有 `.claude/settings.json`，SDK 会把它当项目设置装载：hooks 是任意
 * shell 命令，permissions.allow 会放宽我们的闸。这里把里面有什么原样列出来，答案是三选一：
 * 装载（folderTrust=true）、不装载照样打开（false，CLAUDE.md 也一起不进）、取消。
 * 什么都没有的文件夹服务端直接算信任，根本不弹这张纸 —— 没有可决定的事就别问。
 *
 * 跟 Claude Code 打开新目录时问「信任这个文件夹吗」是同一件事。
 */
export default function FolderTrustDialog({ show, folder, trust, onDecide, onCancel }) {
  const hooks = trust?.hooks || [];
  const allow = trust?.allow || [];
  const btn = (label, { primary = false, onClick }) => (
    <button
      onClick={onClick}
      style={{
        padding: `${GAP.md - 1}px ${primary ? GAP.xxl : GAP.xl}px`,
        fontFamily: FONT_KAI, fontSize: FONT_SIZE.lg, fontWeight: primary ? 700 : 400,
        letterSpacing: primary ? '0.22em' : '0.12em', textIndent: primary ? '0.22em' : '0.12em',
        color: primary ? COLOR.btnText : PAPER.pencil,
        background: primary ? PAPER.ink : 'transparent',
        border: `1px solid ${primary ? PAPER.ink : 'transparent'}`,
        borderRadius: 2, cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
  return (
    <Modal show={show} onClose={onCancel} title={t('这个文件夹带着自己的设置')} width={560}>
      <div style={{ padding: `${GAP.lg}px ${GAP.xl}px`, fontSize: FONT_SIZE.lg, color: PAPER.ink2, lineHeight: 1.8 }}>
        <div style={{ fontFamily: 'monospace', fontSize: FONT_SIZE.md, color: PAPER.pencil, wordBreak: 'break-all', marginBottom: GAP.md }}>{folder}</div>
        <p style={{ margin: `0 0 ${GAP.md}px` }}>
          {t('它的 .claude/ 里有下面这些东西。装载的话，hooks 会在 agent 干活时真的执行，allow 规则会放宽默认的权限闸。不装载也能打开，只是它的设置和 CLAUDE.md 都不进 agent 的上下文。')}
        </p>
        {hooks.length > 0 && (
          <>
            <div style={{ fontWeight: 700, marginTop: GAP.md }}>{t('hooks（会执行的命令）')}</div>
            <ul style={{ margin: `${GAP.xs}px 0`, paddingLeft: 18, fontFamily: 'monospace', fontSize: FONT_SIZE.md, wordBreak: 'break-all' }}>
              {hooks.map((h, i) => (
                <li key={i}><span style={{ color: PAPER.pencil }}>{h.event}{h.matcher ? ` [${h.matcher}]` : ''} · </span>{h.command}</li>
              ))}
            </ul>
          </>
        )}
        {allow.length > 0 && (
          <>
            <div style={{ fontWeight: 700, marginTop: GAP.md }}>{t('permissions.allow（放宽的规则）')}</div>
            <ul style={{ margin: `${GAP.xs}px 0`, paddingLeft: 18, fontFamily: 'monospace', fontSize: FONT_SIZE.md, wordBreak: 'break-all' }}>
              {allow.map((a, i) => <li key={i}>{a.rule}</li>)}
            </ul>
          </>
        )}
        {trust?.hasClaudeMd && <div style={{ color: PAPER.pencil, marginTop: GAP.md }}>{t('另有一份 CLAUDE.md，装载时会进上下文。')}</div>}
      </div>
      <div style={{
        padding: `${GAP.lg}px ${GAP.xl}px ${GAP.xl}px`, borderTop: `1px solid ${PAPER.hair}`,
        display: 'flex', justifyContent: 'flex-end', gap: GAP.lg, flexShrink: 0,
      }}>
        {btn(t('取消'), { onClick: onCancel })}
        {btn(t('不装载，照样打开'), { onClick: () => onDecide(false) })}
        {btn(t('装载并打开'), { primary: true, onClick: () => onDecide(true) })}
      </div>
    </Modal>
  );
}
