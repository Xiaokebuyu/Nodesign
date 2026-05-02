import { useState, useRef, useEffect } from 'react';
import { Send, Square, Paperclip, AtSign, Wand2, ClipboardList, Upload } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_SANS } from '../../lib/theme.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { useDropzone } from '../../lib/useDropzone.js';
import ComposerTray from './ComposerTray.jsx';
import SuggestionChip from './SuggestionChip.jsx';

/**
 * Chat 输入框 — 双层结构（参考用户提供的设计图）
 *
 *   ┌──────────────────────────────────────┐
 *   │  描述你想做什么…                     │  ← textarea（单独占行，无装饰）
 *   │                                       │
 *   │  [@] [📎] [✨]  [深度对齐]      [✈ 发送] │  ← toolbar：左 3 icon / plan-mode toggle / 右 Send
 *   └──────────────────────────────────────┘
 *
 * 视觉：
 *   - outer card: bgCard 圆角 + 1px 边
 *   - textarea: 纯文本输入区，自动增高
 *   - Send 按钮：亮黑 #2d2418（DeskSkill 主按钮色）+ 文字"发送" + 飞机图标
 *
 * 三个左侧 icon（P2 接通）：
 *   - AtSign     引用上下文（@ 引用项目内已上传的资料）
 *   - Paperclip  附件直传
 *   - Wand2      AI 建议（让 agent 帮写 brief 草稿）
 */
export default function ChatComposer({
  onSend, disabled, trayItems, onRemoveTrayItem, onPickFile,
  promptSuggestion, onDismissSuggestion,
  // V2：Send 按钮承担运行状态显示责任。isRunning=true 时按钮变"停止"红，点击 onStop。
  // disabled 仍兼容（外部可强制禁用，如 hydrateError）但 isRunning 优先决定按钮形态。
  isRunning = false,
  onStop,
}) {
  const [text, setText] = useState('');
  const ref = useRef(null);
  const fileInputRef = useRef(null);
  const chatDraft = useGlobalStore(s => s.chatDraft);
  const setChatDraft = useGlobalStore(s => s.setChatDraft);
  const planModeEnabled = useGlobalStore(s => s.planModeEnabled);
  const setPlanModeEnabled = useGlobalStore(s => s.setPlanModeEnabled);

  // textarea 自动增高
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [text]);

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

  const submit = () => {
    const trimmed = text.trim();
    // streamInput 重构：isRunning 时仍允许发 —— message 排队，agent 跑完当前 turn
    // 后自然吃下一条。disabled / 空输入 仍阻止
    if (!trimmed || disabled) return;
    onSend?.(trimmed);
    setText('');
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // streamInput 模式下 Enter 始终 = submit（追加排队）；停止走专门按钮
      submit();
    }
  };

  const empty = !text.trim();

  // V3：拖文件入复合器 → 走和 Paperclip 同条路（onPickFile）。
  // disabled 状态不接受拖入（避免 streaming 中追加附件被忽略）。
  const { dragging, dropProps } = useDropzone({
    onFiles: (files) => files.forEach(f => onPickFile?.(f)),
    disabled: disabled || isRunning,
  });

  return (
    <div style={{
      padding: GAP.lg,
      borderTop: `1px solid ${COLOR.border}`,
      background: '#fff',
    }}>
      <div
        {...dropProps}
        style={{
          // V2：用户反馈 bg 太重，改用 bgModal（#FDFCFA）— 比 bgCard 淡得多
          background: COLOR.bgModal,
          // V3：拖文件入时改 dashed 蓝边 + 浅高亮 → 视觉确认
          border: dragging
            ? `1.5px dashed ${COLOR.btn}`
            : `1px solid ${COLOR.borderLt}`,
          borderRadius: 14,
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
            background: 'rgba(45,36,24,0.06)',
            borderRadius: 14,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: GAP.sm,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
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
          placeholder="描述你想做什么…"
          disabled={disabled}
          rows={1}
          style={{
            background: 'transparent',
            border: 'none',
            outline: 'none',
            resize: 'none',
            fontFamily: FONT_SANS,
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
          {/* 左：3 个 icon */}
          <IconBtn
            icon={<AtSign size={14} />}
            title="引用项目内已上传的资料"
            onClick={() => alert('P2 实现：选择资料 @引用')}
          />
          <IconBtn
            icon={<Paperclip size={14} />}
            title="上传附件（图片 / PDF / HTML / 等）"
            onClick={() => fileInputRef.current?.click()}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.pptx,.docx,.html,.htm,.png,.jpg,.jpeg,.svg,.webp"
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              files.forEach(f => onPickFile?.(f));
              // 重置 value 让同名文件能再选一次
              e.target.value = '';
            }}
            style={{ display: 'none' }}
          />
          <IconBtn
            icon={<Wand2 size={14} />}
            title="AI 建议（帮你写 brief 草稿）"
            onClick={() => alert('P5 实现：让 agent 给 brief 候选')}
          />

          {/* Phase 3.2：plan-mode toggle —— 开 SDK 原生 plan mode（agent 先写 plan
              让用户审批再执行）。LocalStorage 持久化，开/关在 chip 文字 + 高亮区分。 */}
          <button
            onClick={() => setPlanModeEnabled(!planModeEnabled)}
            disabled={disabled}
            title={planModeEnabled
              ? 'plan-mode 已开：agent 会先写 design plan 让你审批 / 编辑后再执行（点击关闭）'
              : 'plan-mode 关：agent 跑默认流程，复杂 brief 想先 review plan 再开（点击开启）'
            }
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: `4px ${GAP.sm}px`,
              fontFamily: FONT_SANS, fontSize: 11, fontWeight: 500,
              color: planModeEnabled ? COLOR.btnText : COLOR.text2,
              background: planModeEnabled ? COLOR.warn : 'transparent',
              border: `1px solid ${planModeEnabled ? COLOR.warn : COLOR.borderMd}`,
              borderRadius: 6,
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.5 : 1,
              transition: 'all 0.15s',
              marginLeft: GAP.xs,
            }}
          >
            <ClipboardList size={11} />
            {planModeEnabled ? '深度对齐已开' : '深度对齐'}
          </button>

          <div style={{ flex: 1 }} />

          {/* streamInput 重构：发送按钮始终显示+始终叫"发送"。
              isRunning 时 Enter / 点发送 = 追加排队（agent 跑完当前 turn 自然吃下一条）。
              停止按钮在 isRunning 时显示在左侧 —— 中断当前 turn，query 不死继续等下条 */}
          {isRunning && onStop && (
            <button
              onClick={onStop}
              title="打断当前 turn（会话保留，可继续追加消息）"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: GAP.xs + 1,
                padding: `${GAP.xs + 1}px ${GAP.md + 2}px`,
                fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 500,
                color: '#fff',
                background: COLOR.error,
                border: `1px solid ${COLOR.error}`,
                borderRadius: 8,
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.opacity = 0.85; }}
              onMouseLeave={e => { e.currentTarget.style.opacity = 1; }}
            >
              <Square size={11} fill="#fff" />
              停止
            </button>
          )}
          <button
            onClick={submit}
            disabled={disabled || empty}
            title={empty ? '输入内容后发送' : (isRunning ? '发送（追加排队，agent 跑完当前自动处理）' : '发送（Enter）')}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: GAP.xs + 1,
              padding: `${GAP.xs + 1}px ${GAP.md + 2}px`,
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 500,
              color: COLOR.btnText,
              background: disabled || empty ? 'rgba(45,36,24,0.35)' : COLOR.btn,
              border: `1px solid ${disabled || empty ? 'rgba(45,36,24,0.35)' : COLOR.btn}`,
              borderRadius: 8,
              cursor: disabled || empty ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => { if (!disabled && !empty) e.currentTarget.style.background = COLOR.btnHover; }}
            onMouseLeave={e => { if (!disabled && !empty) e.currentTarget.style.background = COLOR.btn; }}
          >
            <Send size={13} />
            发送
          </button>
        </div>
      </div>
    </div>
  );
}

function IconBtn({ icon, title, onClick }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        width: 28, height: 28,
        borderRadius: 6,
        color: COLOR.text4,
        background: 'transparent',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
        cursor: 'pointer',
        transition: 'background 0.15s, color 0.15s',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.05)'; e.currentTarget.style.color = COLOR.text2; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = COLOR.text4; }}
    >
      {icon}
    </button>
  );
}
