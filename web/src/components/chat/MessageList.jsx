import { useEffect, useRef, useMemo } from 'react';
import Message from './Message.jsx';
import TimelineGroup from './TimelineGroup.jsx';
import { COLOR, GAP, FONT_SANS, FONT_SIZE } from '../../lib/theme.js';

/**
 * groupMessages —— thinking + tool 进 timeline group；中间穿插的 assistant
 * 也进 group（让 timeline 跨 narration 不断）；末尾连续的 assistant 剥出来
 * 作 single（"真正的最终回复"——后面没工具调用了，让用户看到独立大字号）。
 *
 * 演进史：
 *   - H5：thinking+tool+assistant 全进 group + 末尾抽 final text
 *   - V2：assistant 全 break
 *   - V3：启发式 isShortNarration 当过场不 break（被 V4 撤）
 *   - V4：assistant 全 break，每段工作收尾出 DONE
 *   - V5：assistant 全进 group → 用户反 push："最终回复也被塞 timeline 里了"
 *   - V6（本次）：assistant 进 group 但 closed group 末尾的连续 assistant
 *     被剥出 → 中间穿插的窄 narration 进 timeline 不断线，末尾大段 final
 *     reply 出来正常 markdown 大字号显示。
 *
 * group 的 closed 信号：
 *   - 后面接 user / system → closed=true（新一轮 turn 起点 / 系统拦截独立）
 *   - 最后一个 group + !isStreaming → closed=true
 *   - 最后一个 group + isStreaming → closed=false（不剥尾，因为可能还有 tool 在路上）
 */
function groupMessages(messages, isStreaming) {
  const raw = [];
  let current = null;
  for (const m of messages) {
    const isTimeline = m.role === 'thinking' || m.role === 'tool' || m.role === 'assistant';
    if (isTimeline) {
      if (!current) {
        current = { type: 'timeline', items: [], closed: false };
        raw.push(current);
      }
      current.items.push(m);
    } else {
      // user / system break group
      if (current) { current.closed = true; current = null; }
      raw.push({ type: 'single', message: m });
    }
  }

  if (current && !isStreaming) {
    current.closed = true;
  }

  // Post-pass：closed timeline group 末尾连续的 assistant 剥成 single
  // （"final reply" 不进 timeline）。!closed group 不剥，避免 streaming 中
  // 当前 assistant 假装是 final 但其实下一帧又有 tool 来。
  const groups = [];
  for (const g of raw) {
    if (g.type !== 'timeline' || !g.closed) {
      groups.push(g);
      continue;
    }
    let lastNonAssistant = g.items.length - 1;
    while (lastNonAssistant >= 0 && g.items[lastNonAssistant].role === 'assistant') {
      lastNonAssistant--;
    }
    const inGroup = g.items.slice(0, lastNonAssistant + 1);
    const tail = g.items.slice(lastNonAssistant + 1);
    if (inGroup.length > 0) {
      groups.push({ type: 'timeline', items: inGroup, closed: true });
    }
    for (const m of tail) {
      groups.push({ type: 'single', message: m });
    }
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
