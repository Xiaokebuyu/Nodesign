import { useEffect, useRef, useMemo } from 'react';
import Message from './Message.jsx';
import TimelineGroup from './TimelineGroup.jsx';
import { COLOR, GAP, FONT_SANS, FONT_SIZE } from '../../lib/theme.js';

/**
 * groupMessages —— thinking + tool + 短过场 assistant 进 timeline group；
 * 长 assistant 正式回复 break group 显示 single。
 *
 * 启发式判断"短过场" vs "正式回复"：
 *   - 含 `\n\n`（多段）→ 正式回复，break
 *   - 长度 > 200 字符 → 正式回复，break
 *   - 末尾是问号 → agent 在问用户，break
 *   - 否则（短单行过程叙述如"接下来改 page 4"）→ 留 group 作 timeline node
 *
 * 这样视觉上：
 *   - agent "想→做→说一句→做→说一句→做" 这种连续工作 → 一个 group 视觉连贯
 *   - agent "[做完一坨] 我做了 A/B/C 三件事，markdown 表格..." → break 让正式
 *     回复独立显示
 *
 * group 的 closed 信号：
 *   - 后面接 break message（长 assistant / user / system）→ closed=true
 *   - 最后一个 group + !isStreaming → closed=true
 *   - 最后一个 group + isStreaming → closed=false
 *
 * 历史：H5 是 thinking+tool+assistant 全进 group + 末尾 final text 抽出。
 * 第一版改动是 assistant 全 break，但用户反馈"短过场也 break"导致每个
 * Edit 自己一个 group 太碎。当前版本（启发式 break）是折中。
 */
function isShortNarration(text) {
  if (!text || typeof text !== 'string') return true;  // 空 assistant 当过场
  if (text.length > 200) return false;
  if (text.includes('\n\n')) return false;
  if (/[?？]\s*$/.test(text.trim())) return false;
  return true;
}

function groupMessages(messages, isStreaming) {
  const groups = [];
  let current = null;
  for (const m of messages) {
    const isTimeline = m.role === 'thinking'
      || m.role === 'tool'
      || (m.role === 'assistant' && isShortNarration(m.content));
    if (isTimeline) {
      if (!current) {
        current = { type: 'timeline', items: [], closed: false };
        groups.push(current);
      }
      current.items.push(m);
    } else {
      // user / 长 assistant / system 全 break group
      if (current) { current.closed = true; current = null; }
      groups.push({ type: 'single', message: m });
    }
  }

  if (current && !isStreaming) {
    current.closed = true;
  }

  return groups;
}

/**
 * 消息流容器。
 *
 * 滚动行为（修：原版只 length 变才滚 → 流式 delta 累加同条 message 时不滚，看不到底）：
 *   - 依赖整个 messages 引用：setMessages 触发就检查滚不滚
 *   - stickToBottom：用户离底 < 80px 视作粘底（rAF 内 scroll，避免 layout 抖）
 *   - 用户主动往上翻 → stick=false，新消息不会强行把视图拽回；翻回近底 → stick 恢复
 */
const STICK_THRESHOLD = 80;

export default function MessageList({ messages = [], isStreaming = false }) {
  const ref = useRef(null);
  const stickRef = useRef(true);

  const handleScroll = () => {
    const el = ref.current;
    if (!el) return;
    stickRef.current = (el.scrollHeight - el.scrollTop - el.clientHeight) < STICK_THRESHOLD;
  };

  useEffect(() => {
    const el = ref.current;
    if (!el || !stickRef.current) return;
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [messages]);

  const groups = useMemo(() => groupMessages(messages, isStreaming), [messages, isStreaming]);

  return (
    <div ref={ref} onScroll={handleScroll} style={{
      flex: 1,
      minHeight: 0,
      overflow: 'auto',
      padding: `${GAP.lg}px 0`,
    }}>
      {messages.length === 0 ? (
        <div style={{
          padding: GAP.page,
          textAlign: 'center',
          fontFamily: FONT_SANS,
          fontSize: FONT_SIZE.sm,
          color: COLOR.sub,
          lineHeight: 1.6,
        }}>
          输入 brief 开始 ——<br />
          描述你想做什么、给谁看、传达什么。
        </div>
      ) : (
        groups.map((g, i) => g.type === 'timeline'
          ? <TimelineGroup key={`tl-${i}`} messages={g.items} closed={g.closed} />
          : <Message key={g.message.id || `m-${i}`} message={g.message} />,
        )
      )}
    </div>
  );
}
