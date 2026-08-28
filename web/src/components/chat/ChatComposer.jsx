import { useState, useRef, useEffect } from 'react';
import { Send, Square, Upload } from 'lucide-react';
import { COLOR, CHROME, GAP, RADIUS, FONT_SIZE, FONT_KAI } from '../../lib/theme.js';
import { PAPER, GRAIN, PAPER_SHADOW } from '../../lib/paper.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { useDropzone } from '../../lib/useDropzone.js';
import { isImeEnter } from '../../lib/helpers.js';
import { useMedia, COARSE } from '../../lib/use-media.js';
import ComposerTray from './ComposerTray.jsx';
import SuggestionChip from './SuggestionChip.jsx';
import ComposerMenu from './ComposerMenu.jsx';
import ModelPicker from './ModelPicker.jsx';

/**
 * Chat 输入框 — 双层结构（参考用户提供的设计图）
 *
 *   ┌──────────────────────────────────────┐
 *   │  描述你想做什么…                     │  ← textarea（单独占行，无装饰）
 *   │                                       │
 *   │  [+]  [Sonnet]                [✈ 发送] │  ← toolbar：展开菜单 / 模型 / Send
 *   └──────────────────────────────────────┘
 *
 * 视觉：
 *   - outer card: bgCard 圆角 + 1px 边
 *   - textarea: 纯文本输入区，自动增高
 *   - Send 按钮：亮黑 #2d2418（DeskSkill 主按钮色）+ 文字"发送" + 飞机图标
 *
 * 2026-05-07：移除 @引用 + AI brief 建议两个未实装占位 icon，避免点击只 toast
 *           "即将推出"的死交互。
 * 2026-07-30：删掉「深度对齐」toggle（plan mode 随后在 2026-08-21 整体移除）。
 *           附件收进 [+] 展开菜单，跟上下文查看和手动压缩放在一起。
 */
export default function ChatComposer({
  onSend, disabled, trayItems, onRemoveTrayItem, onPickFile,
  promptSuggestion, onDismissSuggestion,
  // V2：Send 按钮承担运行状态显示责任。isRunning=true 时按钮变"停止"红，点击 onStop。
  // disabled 仍兼容（外部可强制禁用，如 hydrateError）但 isRunning 优先决定按钮形态。
  isRunning = false,
  // ⛔ 台上提示（「泉此方 在写／在等」那行）2026-08-28 撤役：同一件事画布上的
  // 角色精灵已经在说了（矢量标自己动 + 名牌上的状态点），输入框上再写一遍是重复，
  // 而画布那处才是它真正发生的地方。roleStage/roleNames 两个 prop 一并从这里摘掉 ——
  // 拆剩的空壳 prop 不留（这仓库为「空壳钩子」付过学费）。
  onStop,
  // [+] 菜单里的上下文分区（ChatPanel 透传）
  contextUsage = null,
  systemInfo = null,
  onCompact,
  onRefreshUsage,
  projectId = null,
  sessionId = null,
}) {
  const [text, setText] = useState('');
  const coarse = useMedia(COARSE);
  const ref = useRef(null);
  const fileInputRef = useRef(null);

  // 自动召回（08-28）：玩家对**散场**角色说话时 role-direct 发 nd:gm-nudge（自带 5 分钟
  // 去抖），这里替玩家给主对话递一句场务请托，GM 用 SendMessage 把角色召回。
  // 挂在这而不是 ProjectWorkspace：这里天然握着 onSend，且 ChatDock 收起 ≠ 卸载，监听常在。
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  useEffect(() => {
    const onNudge = (e) => { if (e.detail?.text) onSendRef.current?.(e.detail.text); };
    window.addEventListener('nd:gm-nudge', onNudge);
    return () => window.removeEventListener('nd:gm-nudge', onNudge);
  }, []);
  const chatDraft = useGlobalStore(s => s.chatDraft);
  const composerFocusTick = useGlobalStore(s => s.composerFocusTick);
  const setChatDraft = useGlobalStore(s => s.setChatDraft);

  // textarea 自动增高
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [text]);

  // 外部要求把光标放进来（画布按 `/` 唤出、右键「让 agent…」）。跟 chatDraft
  // 分开是因为那边判空值 —— 没垫词的时候什么也不会发生。首帧的 0 不触发。
  useEffect(() => {
    if (!composerFocusTick) return;
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [composerFocusTick]);

  // 监听 chatDraft（外部注入：Inspect "触发新 run" 等）→ 同步到 textarea + focus
  useEffect(() => {
    if (chatDraft) {
      setText(chatDraft);
      setChatDraft('');  // 消费后清掉，避免重复触发
      // 等下一帧 textarea 可见 + 自动增高完成后 focus + 光标到末尾
      requestAnimationFrame(() => {
        const el = ref.current;
        if (el) { el.focus(); el.setSelectionRange(chatDraft.length, chatDraft.length); }
      });
    }
  }, [chatDraft, setChatDraft]);

  /**
   * 传了附件就算有内容（2026-08-17，issue #1 第 8 条）——「拖张参考图进来 +
   * 直接发」是完整的一句话，逼用户再补一句"看看这个"是白要的动作。
   *
   * 只认**传完的**那些：还在上传的没有 path，这时候发出去服务端拿到的是空消息。
   * （`_file` 是首页那条路的暂存待发，submit 时才统一上传，按已就绪算。）
   */
  const readyAttachments = (trayItems || []).filter(
    it => it && it.type === 'asset' && !it.error && (it.path || it._file),
  );
  const hasAttachment = readyAttachments.length > 0;

  const submit = () => {
    const trimmed = text.trim();
    // streamInput 重构：isRunning 时仍允许发 —— message 排队，agent 跑完当前 turn
    // 后自然吃下一条。disabled / 空输入 仍阻止
    if ((!trimmed && !hasAttachment) || disabled) return;
    onSend?.(trimmed);
    setText('');
  };

  /**
   * 手指设备上回车 = 换行（2026-08-21，跟首页那张纸同一条规矩）。
   * 软键盘没有 Shift，回车一律被判成发送 —— 手机上就写不出第二段了。发送有按钮。
   */
  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (isImeEnter(e)) return;
      if (coarse) return;
      e.preventDefault();
      // streamInput 模式下 Enter 始终 = submit（追加排队）；停止走专门按钮
      submit();
    }
  };

  const empty = !text.trim() && !hasAttachment;


  // V3：拖文件入复合器 → 走和 Paperclip 同条路（onPickFile）。
  // isRunning 不拦：streamInput 模式下附件在 POST /turn 时就拼进 blocks 随消息
  // 排队，agent 跑着时上传照样能被下一 turn 吃到（"跑着时锁上传"是重构前的旧账）。
  const { dragging, dropProps } = useDropzone({
    onFiles: (files) => files.forEach(f => onPickFile?.(f)),
    disabled,
  });

  // 贴图：截图/复制的图片直接 Ctrl+V 进托盘，和拖入/Paperclip 同条路。
  // 只在剪贴板真有文件时拦默认行为，纯文本粘贴不受影响。
  const handlePaste = (e) => {
    if (disabled) return;
    const files = Array.from(e.clipboardData?.files || []);
    if (!files.length) return;
    e.preventDefault();
    files.forEach(f => onPickFile?.(f));
  };

  return (
    <div style={{
      padding: GAP.lg,
      borderTop: `1px solid ${CHROME.border}`,
      background: CHROME.bg,
    }}>
      <div
        className="nd-composer"
        {...dropProps}
        style={{
          // 2026-08-03 换纸：这里是一张摊在栏底的小纸，不是一个圆角输入盒。
          // 聚焦态靠 :focus-within 加深影子（见 nd-composer 那条全局规则）——
          // 纸没有边框，光靠一根光标判断"进没进输入态"太吃力，首页那张便签同理。
          background: PAPER.paper,
          backgroundImage: GRAIN,
          boxShadow: PAPER_SHADOW.mid,
          // 拖文件入时改虚线边 + 浅高亮 → 视觉确认
          border: dragging ? `1.5px dashed ${PAPER.ink}` : '1px solid transparent',
          borderRadius: 2,
          padding: `${GAP.md + 2}px ${GAP.lg}px ${GAP.md}px`,
          display: 'flex',
          flexDirection: 'column',
          gap: GAP.sm,
          position: 'relative',
          transition: 'border-color 0.15s, box-shadow 0.15s, background 0.15s',
        }}>
        {dragging && (
          <div style={{
            position: 'absolute', inset: 0,
            background: 'rgba(43,33,23,0.07)',
            borderRadius: 2,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: GAP.sm,
            fontFamily: FONT_KAI, fontSize: FONT_SIZE.lg,
            color: COLOR.text,
            pointerEvents: 'none',
            zIndex: 2,
          }}>
            <Upload size={14} /> 松开上传到附件托盘
          </div>
        )}
        {/* 顶层：附件托盘（多 modality 信号；空时不渲染）*/}
        <ComposerTray items={trayItems} onRemove={onRemoveTrayItem} />

        {/* C19：SDK 预测的下条 prompt（promptSuggestions: true）*/}
        <SuggestionChip
          suggestion={promptSuggestion}
          onAccept={(s) => {
            // 直接发送 suggestion；如果用户希望先编辑，把它填到 textarea：
            //   setText(s); ref.current?.focus();
            // 当前行为是直接发，参考 ChatGPT 之类的"接受建议立即提交"
            onSend?.(s);
            onDismissSuggestion?.();
          }}
          onDismiss={onDismissSuggestion}
        />

        {/* 上层：textarea */}
        <textarea
          ref={ref}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKey}
          onPaste={handlePaste}
          placeholder="描述你想做什么…"
          disabled={disabled}
          rows={1}
          style={{
            background: 'transparent',
            border: 'none',
            outline: 'none',
            resize: 'none',
            fontFamily: FONT_KAI,
            fontSize: FONT_SIZE.base,
            lineHeight: 1.55,
            color: COLOR.text,
            padding: `${GAP.xs}px 0`,
            maxHeight: 200,
            minHeight: 24,
            overflow: 'auto',
            width: '100%',
          }}
        />

        {/* 下层：toolbar */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: GAP.sm,
        }}>
          {/* 左：[+] 展开菜单（附件 / 上下文 / 压缩） */}
          <ComposerMenu
            onUpload={() => fileInputRef.current?.click()}
            usage={contextUsage}
            info={systemInfo}
            onCompact={onCompact}
            onRefreshUsage={onRefreshUsage}
            isStreaming={isRunning}
            disabled={disabled}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.docx,.xlsx,.pptx,.html,.htm,.png,.jpg,.jpeg,.svg,.webp,.json"
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              files.forEach(f => onPickFile?.(f));
              // 重置 value 让同名文件能再选一次
              e.target.value = '';
            }}
            style={{ display: 'none' }}
          />
          {/* 模型 picker：切换从下一条消息生效（服务端空闲时重启 query），
              正在跑时禁用 —— 不给"点了立刻切"的错觉 */}
          <ModelPicker
            disabled={disabled || isRunning}
            projectId={projectId}
            sessionId={sessionId}
            contextTokens={contextUsage?.totalTokens || 0}
          />

          <div style={{ flex: 1 }} />

          {/* 第三态：台上有角色，但主对话**没被占用**（2026-08-26）。
              以前这里什么都不显示，而按钮因为一个 bug 卡在「停止」，用户以为对话被占了
              不敢发消息（病根见 runs/turn-relay.js isBackgroundTurnOpener）。
              现在按钮照常是「发送」，只在旁边说清楚台上是谁、在写还是在等。 */}
          {/* streamInput 重构：恢复一体切换按钮（原设计）—— isRunning 时显 stop（中断
              当前 turn，query 不死），idle 时显 send。Enter 始终触发 submit（追加排队）—
              用户想在 agent 跑时追加消息直接 Enter，按钮形态不影响 */}
          {isRunning && onStop ? (
            <button
              onClick={onStop}
              title="停止当前 turn（按 Enter 可继续追加消息排队）"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: GAP.xs + 1,
                padding: `${GAP.xs + 1}px ${GAP.md + 2}px`,
                fontFamily: FONT_KAI, fontSize: FONT_SIZE.lg, fontWeight: 700,
                color: '#F5F0E4',
                background: PAPER.red,
                border: `1px solid ${PAPER.red}`,
                borderRadius: 2,
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.opacity = 0.85; }}
              onMouseLeave={e => { e.currentTarget.style.opacity = 1; }}
            >
              <Square size={11} fill="#FFFEF6" />
              停止
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={disabled || empty}
              title={empty ? '写点什么或传个附件再发' : '发送（Enter）'}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: GAP.xs + 1,
                padding: `${GAP.xs + 1}px ${GAP.md + 2}px`,
                fontFamily: FONT_KAI, fontSize: FONT_SIZE.lg, fontWeight: 700,
                color: disabled || empty ? PAPER.pencil : '#F5F0E4',
                background: disabled || empty ? 'transparent' : PAPER.ink,
                border: `1px solid ${disabled || empty ? PAPER.hair : PAPER.ink}`,
                borderRadius: 2,
                cursor: disabled || empty ? 'not-allowed' : 'pointer',
                transition: 'all 0.15s',
              }}
              onMouseEnter={e => { if (!disabled && !empty) e.currentTarget.style.background = COLOR.btnHover; }}
              onMouseLeave={e => { if (!disabled && !empty) e.currentTarget.style.background = COLOR.btn; }}
            >
              <Send size={13} />
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
