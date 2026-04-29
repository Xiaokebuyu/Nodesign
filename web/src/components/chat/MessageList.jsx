import { useEffect, useRef } from 'react';
import Message from './Message.jsx';
import { COLOR, GAP, FONT_SANS, FONT_SIZE } from '../../lib/theme.js';

/**
 * 消息流容器。
 *   - 新消息进来自动滚到底（除非用户手动滚开了 → P2 加 stickToBottom 检测）
 *   - 空状态显示 placeholder
 */
export default function MessageList({ messages = [] }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.scrollTop = ref.current.scrollHeight;
  }, [messages.length]);

  return (
    <div ref={ref} style={{
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
        messages.map((m, i) => <Message key={m.id || i} message={m} />)
      )}
    </div>
  );
}
