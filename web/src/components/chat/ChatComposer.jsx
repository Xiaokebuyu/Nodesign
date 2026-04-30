import { useState, useRef, useEffect } from 'react';
import { Send, Paperclip, AtSign, Wand2, FolderInput } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_SANS } from '../../lib/theme.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import ComposerTray from './ComposerTray.jsx';
import SuggestionChip from './SuggestionChip.jsx';

/**
 * Chat 输入框 — 双层结构（参考用户提供的设计图）
 *
 *   ┌──────────────────────────────────────┐
 *   │  描述你想做什么…                     │  ← textarea（单独占行，无装饰）
 *   │                                       │
 *   │  [@] [📎] [✨]    [⤓ Import]  [✈ 发送] │  ← toolbar：左 3 icon / 中 Import / 右 Send
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
 *
 * Import 按钮（P2/P6 接通）：从外部一键导入参考素材到当前 chat
 */
export default function ChatComposer({
  onSend, disabled, trayItems, onRemoveTrayItem, onPickFile,
  promptSuggestion, onDismissSuggestion,
}) {
  const [text, setText] = useState('');
  const ref = useRef(null);
  const fileInputRef = useRef(null);
  const chatDraft = useGlobalStore(s => s.chatDraft);
  const setChatDraft = useGlobalStore(s => s.setChatDraft);

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
    if (!trimmed || disabled) return;
    onSend?.(trimmed);
    setText('');
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const empty = !text.trim();

  return (
    <div style={{
      padding: GAP.lg,
      borderTop: `1px solid ${COLOR.border}`,
      background: '#fff',
    }}>
      <div style={{
        background: COLOR.bgCard,
        border: `1px solid ${COLOR.border}`,
        borderRadius: 14,
        padding: `${GAP.md + 2}px ${GAP.lg}px ${GAP.md}px`,
        display: 'flex',
        flexDirection: 'column',
        gap: GAP.sm,
        transition: 'border-color 0.15s, box-shadow 0.15s',
      }}>
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

          <div style={{ flex: 1 }} />

          {/* 中：Import 按钮（outline 风格）*/}
          <button
            onClick={() => alert('P6 实现：从外部 import 参考素材')}
            title="导入参考素材"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: GAP.xs + 1,
              padding: `${GAP.xs + 1}px ${GAP.md + 2}px`,
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 500,
              color: COLOR.text2,
              background: 'transparent',
              border: `1px solid ${COLOR.borderMd}`,
              borderRadius: 8,
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.03)'; e.currentTarget.style.borderColor = COLOR.borderHv; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = COLOR.borderMd; }}
          >
            <FolderInput size={13} />
            Import
          </button>

          {/* 右：Send 按钮（亮黑 filled）*/}
          <button
            onClick={submit}
            disabled={disabled || empty}
            title={empty ? '输入内容后发送' : '发送（Enter）'}
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

      {/* 底部 hint（参考图没有，但保留键盘提示，给新用户一个知道）*/}
      <div style={{
        marginTop: GAP.xs + 1,
        textAlign: 'center',
        fontFamily: FONT_SANS, fontSize: 10, color: COLOR.sub,
        opacity: 0.7,
      }}>
        Enter 发送 · Shift+Enter 换行
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
