import { useState } from 'react';
import Modal, { ModalFooter } from '../ui/Modal.jsx';
import { GAP, FONT_SIZE, FONT_KAI } from '../../lib/theme.js';
import { PAPER } from '../../lib/paper.js';
import { t } from '../../lib/i18n.js';

/**
 * 回到某条消息之前 —— 两个问题，一张纸上问完（2026-08-30）。
 *
 * 以前这里只有一个 confirm：「回到此处？这会丢弃后续所有文件改动。」一句话把两件
 * 不同的后悔捆在一起做了。它们其实正交：
 *
 *   **回退什么**  只回对话（说错话了重说，做出来的东西留着）
 *                 对话和产物一起回（它照我说的做出来的东西我不要了）
 *   **原来那条线** 覆盖掉（就当没发生过）
 *                 留着，另开一条分支（我想试另一条路，但旧的别丢）
 *
 * 四个组合都成立，所以不做成四个按钮，做成两个问题。默认值 = 老「回到此处」的行为
 * （产物一起回、覆盖原线），老用户点开直接确认就是他习惯的那件事。
 *
 * ⚠️ 「产物一起回」这一档要在纸上写明它是**项目级**的：一个项目一个工作区，产物只有
 * 一份，回退后同项目其他会话看到的也是回退后的文件。分叉分得开对话，分不开产物。
 *
 * @param {{
 *   show: boolean,
 *   onCancel: () => void,
 *   onConfirm: (choice: { files: boolean, fork: boolean }) => void,
 * }} props
 */
export default function RewindDialog({ show, onCancel, onConfirm }) {
  const [files, setFiles] = useState(true);
  const [fork, setFork] = useState(false);

  return (
    <Modal show={show} onClose={onCancel} title={t('回到这条消息之前')} width={460}>
      <div style={{ padding: `${GAP.lg}px ${GAP.xl}px ${GAP.md}px` }}>
        <Section label={t('回退什么')}>
          <Choice
            selected={!files}
            onSelect={() => setFiles(false)}
            title={t('只回退对话')}
            hint={t('这条之后的来回不算数了。已经做出来的文件、板书、图片原样留着。')}
          />
          <Choice
            selected={files}
            onSelect={() => setFiles(true)}
            title={t('对话和产物一起回退')}
            hint={t('这条之后写的文件全部撤销，板书和产物一起回到那时的样子。')}
            warn={t('产物这个项目只有一份，所以这一步会影响项目里的所有会话，不只是当前这条。')}
          />
        </Section>

        <Section label={t('原来这条线')}>
          <Choice
            selected={!fork}
            onSelect={() => setFork(false)}
            title={t('覆盖掉')}
            hint={t('这条之后的对话从记录里删掉，就当没发生过。')}
          />
          <Choice
            selected={fork}
            onSelect={() => setFork(true)}
            title={t('留着，另开一条分支')}
            hint={t('现在这条会话一字不动，另外开一条从这里继续。两条都能在会话列表里找到。')}
          />
        </Section>
      </div>
      <ModalFooter
        onCancel={onCancel}
        onConfirm={() => onConfirm({ files, fork })}
        confirmLabel={fork ? t('分叉') : t('回退')}
        cancelLabel={t('取消')}
        danger={!fork}
      />
    </Modal>
  );
}

function Section({ label, children }) {
  return (
    <div style={{ marginBottom: GAP.xl }}>
      <div style={{
        fontFamily: FONT_KAI, fontSize: FONT_SIZE.base, color: PAPER.pencil,
        letterSpacing: '0.1em', marginBottom: GAP.md,
      }}>
        {label}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.xs }}>{children}</div>
    </div>
  );
}

/** 一档选择：左边一枚墨点，右边标题 + 一行小字（选中的那档才展开警示）。 */
function Choice({ selected, onSelect, title, hint, warn }) {
  return (
    <div
      onClick={onSelect}
      style={{
        display: 'flex', gap: GAP.md, alignItems: 'flex-start',
        padding: `${GAP.md}px ${GAP.md}px`,
        borderRadius: 2,
        cursor: 'pointer',
        background: selected ? 'rgba(43,33,23,0.045)' : 'transparent',
        transition: 'background 0.15s',
      }}
    >
      <span style={{
        flexShrink: 0, marginTop: 5,
        width: 11, height: 11, borderRadius: '50%',
        border: `1px solid ${selected ? PAPER.ink : PAPER.hair}`,
        background: selected ? PAPER.ink : 'transparent',
        boxShadow: selected ? `inset 0 0 0 2px ${PAPER.paper}` : 'none',
      }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: FONT_SIZE.lg, color: PAPER.ink, lineHeight: 1.6 }}>{title}</div>
        <div style={{ fontSize: FONT_SIZE.base, color: PAPER.ink2, lineHeight: 1.75, marginTop: 2 }}>{hint}</div>
        {warn && selected && (
          <div style={{ fontSize: FONT_SIZE.base, color: PAPER.red, lineHeight: 1.75, marginTop: GAP.xs }}>
            {warn}
          </div>
        )}
      </div>
    </div>
  );
}
