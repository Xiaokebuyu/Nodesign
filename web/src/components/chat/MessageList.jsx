import { useEffect, useRef, useMemo } from 'react';
import Message from './Message.jsx';
import TimelineGroup from './TimelineGroup.jsx';
import { COLOR, GAP, FONT_SANS, FONT_SIZE } from '../../lib/theme.js';

/**
 * H5：thinking + tool + assistant 中间 text 都包进同一个 TimelineGroup。
 * 一个 turn 内 agent 的所有动作（思考、工具、中间说话）属于同一思考片段。
 * group 的 closed 信号：
 *   - 不是最后一个 group（后面有 user message 触发 break）→ closed=true（过去的 turn）
 *   - 是最后一个 group + isStreaming=false（run 结束）→ closed=true
 *   - 最后一个 group + isStreaming=true（运行中）→ closed=false（不显示 done）
 *
 * "正式回复"识别：!isStreaming 时，从末尾向前找最后一条 assistant text，
 * 如果它紧贴 thinking/tool（中间没 user）→ 视为 final → 抽出来作 single 显示
 * 在 group 之外（done 之后），让它像最终结论一样可读。
 */
function groupMessages(messages, isStreaming) {
  // 1. 找 final assistant text（仅当 !isStreaming）
  let finalTextIdx = -1;
  if (!isStreaming) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'user') break;
      if (m.role === 'assistant') {
        finalTextIdx = i;
        break;
      }
      // thinking / tool / system 等：继续向前找
    }
  }

  // 2. group 化
  const groups = [];
  let current = null;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (i === finalTextIdx) {
      // final text 抽出 — 关上当前 group + single 显示
      if (current) { current.closed = true; current = null; }
      groups.push({ type: 'single', message: m });
      continue;
    }
    const isTimeline =
      m.role === 'thinking' || m.role === 'tool' || m.role === 'assistant';
    if (isTimeline) {
      if (!current) {
        current = { type: 'timeline', items: [], closed: false };
        groups.push(current);
      }
      current.items.push(m);
    } else {
      // user / system 等 break group
      if (current) { current.closed = true; current = null; }
      groups.push({ type: 'single', message: m });
    }
  }

  // 3. 最后一个未关 group：!isStreaming 时也 close 显示 done；streaming 中保持 open
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
