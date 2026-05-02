import { useEffect, useRef, useMemo } from 'react';
import Message from './Message.jsx';
import TimelineGroup from './TimelineGroup.jsx';
import { COLOR, GAP, FONT_SANS, FONT_SIZE } from '../../lib/theme.js';

/**
 * groupMessages —— thinking + tool 进 timeline group；任何 assistant text
 * 都 break group 让 DONE 出现 + assistant 内容作 single 显示。
 *
 * 演进史：
 *   - H5：thinking+tool+assistant 全进 group + 末尾抽 final text
 *   - V2：assistant 全 break —— 用户反馈"每个 Edit 后的 1 句话也 break，太碎"
 *   - V3：启发式 isShortNarration（< 200 字 + 无 \n\n + 不带 ?）当过场不 break
 *   - V4（本次）：去 isShortNarration —— 用户反馈交错模式下 60-150 字的真实
 *     内容（"已完成 page 2，接下来…"）被当过场，DONE 永远不显示。
 *     现在：任何 assistant text 都 break，每段 thinking/tool 工作收尾就出 DONE。
 *
 * 为什么 V4 不再担心 V3 的"碎"问题：
 *   - Kimi 交错模式下 assistant text 频率本来就低（它喜欢做完一坨再总结）
 *   - 如果真出现 "Edit→narration→Edit→narration" 这种碎模式，那是 SKILL.md
 *     该约束的事（让 agent "做完一段再报告"），不是前端该兜底的
 *   - 缺 DONE 比多碎 group 更坏 —— 用户没法判断 agent "这段做完没"
 *
 * group 的 closed 信号：
 *   - 后面接任何非 timeline message（assistant / user / system）→ closed=true
 *   - 最后一个 group + !isStreaming → closed=true
 *   - 最后一个 group + isStreaming → closed=false
 */
function groupMessages(messages, isStreaming) {
  const groups = [];
  let current = null;
  for (const m of messages) {
    // assistant 任何内容都不进 group —— 让 DONE 显示在工作段尾
    const isTimeline = m.role === 'thinking' || m.role === 'tool';
    if (isTimeline) {
      if (!current) {
        current = { type: 'timeline', items: [], closed: false };
        groups.push(current);
      }
      current.items.push(m);
    } else {
      // assistant / user / system 全 break group
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
