import { useState } from 'react';
import { Undo2 } from 'lucide-react';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_SANS } from '../../lib/theme.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { Sessions } from '../../lib/api.js';
import { parseAnnotationMessage, annotationTargets } from '../../lib/annotation-message.js';
import AnnotationNote from './AnnotationNote.jsx';
import RewindDialog from './RewindDialog.jsx';
import { t } from '../../lib/i18n.js';

/**
 * UserMessage —— 用户消息气泡 + 悬停「回到此处」按钮。
 *
 * 点开的是 RewindDialog（2026-08-30），四个组合都从那张纸上出：
 *   回退什么   只回对话（jsonl 截断）│ 对话和产物一起（+ SDK rewindFiles）
 *   原来那条线 覆盖掉                │ 留着，另开一条分支（SDK forkSession）
 *
 * 分支那两档走 fork：新会话的对话截到这条之前，原会话一字不动。选了「产物一起回退」
 * 时再对**源会话**发一次只回文件的 rewind（truncateConversation:false）—— 产物一个
 * 项目只有一份，分支分得开对话分不开文件，所以那是一次项目级回退，纸上写明了。
 */
// SDK uuid 36-char 形态（"abc12345-1234-1234-1234-123456789abc"）—— rewindFiles 和
// fork 的 upToMessageId 都只认它。2026-08-30 之前前端乐观插入的气泡拿的是
// newId('msg') = "msg_xxx"，这条判据一律不认 → 按钮**得刷新页面**才出现（等 hydrate
// 从 jsonl 读回真 uuid）。现在 id 从 helpers.newUserMessageId 生成、随 turn 请求下发、
// 服务端盖到 SDKUserMessage.uuid 上，气泡一出现按钮就在。判据留着兜老消息和
// 服务端替发的那些（场务托词之类）。同一份正则在 server/api/turn.js。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function UserMessage({ message, projectId, sessionId, onCanvasReload }) {
  const showToast = useGlobalStore(s => s.showToast);
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dlgOpen, setDlgOpen] = useState(false);
  // 画布标注那条：机械描述默认折起来，见下面 anno
  const [annoOpen, setAnnoOpen] = useState(false);

  // 场务托词（08-28 自动召回无扰化）：nd:gm-nudge 替玩家发的召回请托是机器话，
  // 不占一整个用户气泡 —— 渲染成一行淡色场记，指令尾巴（SendMessage 那段）不给人看。
  const plainText = typeof message.content === 'string' ? message.content : '';
  if (plainText.startsWith('【场务】')) {
    return (
      <div style={{ fontSize: 12, opacity: 0.55, padding: '2px 8px', fontStyle: 'italic' }}>
        {plainText.split('——')[0]}
      </div>
    );
  }

  /**
   * 画布标注（2026-08-28 用户报「完整的附加内容都被显示在侧边栏」）：
   * 用户在板上圈一段字回话，前端拼的那条里有路径、作者、原文摘录、reply_to 指令 ——
   * 那些是**给 agent 的**（它要靠它们接线程），发出去的内容一个字不动；
   * 但侧边栏原样显示，用户自己那句话淹在机械里。这里只管显示：机械折起来，
   * 留一行小字说标了什么，点开能看全。拆分判据在 lib/annotation-message.js（有单测）。
   */
  const anno = parseAnnotationMessage(plainText);
  const annoWhat = anno ? annotationTargets(anno.desc) : [];

  const canUndo = !!(projectId && sessionId && message.id && UUID_RE.test(message.id));

  /**
   * 走覆盖那条：原地回退。files 决定顺带不顺带撤销文件。
   * 只回对话时服务端不起 SDK 临时 query，瞬间完成。
   */
  async function rewindInPlace(files) {
    const result = await Sessions.rewind(projectId, sessionId, message.id, { files, truncateConversation: true });
    if (result?.canRewind === false) {
      showToast(result.error || t('此处不支持回滚'), 'warn');
      return;
    }
    const n = result?.filesChanged?.length || 0;
    // iframe reload 由后端 emit 的 run.file_changed event 自动触发（ProjectWorkspace 已 case），
    // 不再依赖 onCanvasReload —— 但保留兼容调用（active query 路径同步返回时也 bump）
    if (files && onCanvasReload) onCanvasReload();
    showToast(files
      ? (n > 0 ? t('已回退对话，撤销了 {n} 个文件').replace('{n}', n) : t('已回退对话（没有文件改动要撤销）'))
      : t('已回退对话，产物留在原处'), 'success');
    // 对话层已被服务端截断 → 通知 ProjectWorkspace 重拉消息（免传三层 props）
    if (result?.conversationTruncated) {
      window.dispatchEvent(new CustomEvent('nd-conversation-rewound', { detail: { sessionId } }));
    }
  }

  /**
   * 走分支那条：fork 出新会话（对话截到这条之前），原会话一字不动。
   * files 时再对源会话发一次**只回文件**的 rewind —— 产物只有一份，这一步是项目级的。
   */
  async function forkFromHere(files) {
    const { sessionId: newSid } = await Sessions.fork(projectId, sessionId, { upToMessageId: message.id });
    if (files) {
      await Sessions.rewind(projectId, sessionId, message.id, { files: true, truncateConversation: false });
      if (onCanvasReload) onCanvasReload();
    }
    showToast(files ? t('已开新分支，产物也回到了那时的样子') : t('已开新分支，产物保持现在的样子'), 'success');
    // 切到新分支（ProjectWorkspace 收这条改服务端指针 + 重 hydrate）
    window.dispatchEvent(new CustomEvent('nd-session-forked', { detail: { sessionId: newSid } }));
  }

  async function handleRewind({ files, fork }) {
    setDlgOpen(false);
    if (!canUndo || busy) return;
    setBusy(true);
    try {
      if (fork) await forkFromHere(files);
      else await rewindInPlace(files);
    } catch (err) {
      const msg = err?.message || String(err);
      if (msg.includes('REWIND_BUSY') || msg.includes('409')) {
        showToast(t('上一个回滚还在进行，稍候重试'), 'warn');
      } else if (msg.includes('JSONL_MISSING') || msg.includes('404')) {
        showToast(t('会话历史已删，无法回滚'), 'warn');
      } else if (msg.includes('REWIND_FAILED') || msg.includes('timeout')) {
        showToast(t('回滚超时，请重试（临时会话启动较慢时偶发）'), 'error');
      } else {
        showToast(`${fork ? t('分叉') : t('回退')}失败：${msg}`, 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{ display: 'flex', justifyContent: 'flex-end', padding: `${GAP.sm}px ${GAP.lg}px`, position: 'relative' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {canUndo && hover && (
        <button
          onClick={() => setDlgOpen(true)}
          disabled={busy}
          title={t('回到这条消息之前（可只回对话，也可连产物一起；还能留着原来那条线开新分支）')}
          style={{
            position: 'absolute',
            top: 4,
            right: GAP.lg,
            display: 'flex', alignItems: 'center', gap: GAP.xs,
            padding: `${GAP.xs}px ${GAP.md}px`,
            background: COLOR.bgCard,
            color: COLOR.text2,
            border: `1px solid ${COLOR.border}`,
            borderRadius: RADIUS.md,
            fontSize: FONT_SIZE.xs || 11,
            fontFamily: FONT_SANS,
            cursor: busy ? 'wait' : 'pointer',
            opacity: busy ? 0.6 : 0.95,
            zIndex: 1,
          }}
        >
          <Undo2 size={11} />
          {busy ? t('回滚中...') : t('回到此处')}
        </button>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', maxWidth: '85%', minWidth: 0 }}>
        {anno && (
          <AnnotationNote desc={anno.desc} what={annoWhat} open={annoOpen} onToggle={() => setAnnoOpen((v) => !v)} />
        )}
        <div style={{
          background: COLOR.btn, color: COLOR.btnText,
          padding: `${GAP.md}px ${GAP.lg}px`,
          borderRadius: 14,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.base,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>{anno ? anno.text : message.content}</div>
      </div>
      <RewindDialog show={dlgOpen} onCancel={() => setDlgOpen(false)} onConfirm={handleRewind} />
    </div>
  );
}

export default UserMessage;
