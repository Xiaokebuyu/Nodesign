import { useEffect, useRef, useMemo } from 'react';
import Message from './Message.jsx';
import TimelineGroup from './TimelineGroup.jsx';
import { COLOR, GAP, FONT_SANS, FONT_SIZE } from '../../lib/theme.js';

/**
 * groupMessages —— 只 thinking + tool 进 timeline group，assistant 文字一律
 * single 抽出。这样视觉上 agent 的"想 → 做 → 想 → 做"流程被中间正式回复
 * 自然断开（前段 group 显示 done，后段开新 group），而不是跟正文连成一串。
 *
 * group 的 closed 信号：
 *   - 后面接非 timeline message（assistant / user / system）→ closed=true
 *   - 最后一个 group + !isStreaming → closed=true（run 结束加 done）
 *   - 最后一个 group + isStreaming → closed=false（运行中不显示 done）
 *
 * 历史：H5 之前 assistant 也进 group + 末尾 final text 抽出。新版抽出策略
 * 统一为"assistant 全 single"，不再区分 final vs mid-turn —— 用户反馈
 * mid-turn 正文回复跟前后 thinking 连在一起视觉上误导。
 */
function groupMessages(messages, isStreaming) {
  const groups = [];
  let current = null;
  for (const m of messages) {
    const isTimeline = m.role === 'thinking' || m.role === 'tool';
    if (isTimeline) {
      if (!current) {
        current = { type: 'timeline', items: [], closed: false };
        groups.push(current);
      }
      current.items.push(m);
    } else {
      // user / assistant / system 全 break group
      if (current) { current.closed = true; current = null; }
      groups.push({ type: 'single', message: m });
    }
  }

  // 最后一个未关 group：!isStreaming 时也 close 显示 done；streaming 中保持 open
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
