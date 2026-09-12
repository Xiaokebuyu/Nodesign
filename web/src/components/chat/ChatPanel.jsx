import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, History, PanelRightClose, Pin } from 'lucide-react';
import MessageList from './MessageList.jsx';
import ChatComposer from './ChatComposer.jsx';
import ContextMeter from './ContextMeter.jsx';
import { COLOR, CHROME, GAP, RADIUS, FONT_SIZE, FONT_KAI } from '../../lib/theme.js';
import { t } from '../../lib/i18n.js';

/**
 * Chat Panel — 左栏整体壳
 *
 * 结构：header → MessageList → ChatComposer
 *（TodoPanel 2026-08-24 退役：TodoWrite 的计划清单已经上板成看板贴，
 *  侧栏再吸顶一份是同一件东西两个实例。）
 *
 * S4：header 显示当前 session 标题（来自 SDK SDKSessionInfo.summary /
 * customTitle / firstPrompt），点击触发 SessionListModal 切换/fork/rename/tag/delete。
 */
const headerBtn = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  padding: `3px ${GAP.sm}px`,
  fontFamily: FONT_KAI, fontSize: FONT_SIZE.md, color: CHROME.pencil,
  background: 'transparent', border: 'none', borderRadius: RADIUS.sm,
  cursor: 'pointer', letterSpacing: '0.04em',
  transition: 'background 0.15s, color 0.15s',
};

export default function ChatPanel({
  messages = [], onSend, isStreaming = false,
  queueDepth = 0,
  wsStatus = 'open',          // 'connecting' | 'open' | 'reconnecting' | 'closed'
  lastEventAt = 0,            // 最近一次 WS 事件时间戳——header dot 据此判断"在动 vs 静默"
  trayItems, onRemoveTrayItem, onPickFile,
  promptSuggestion, onDismissSuggestion,
  agentProgress,
  thinkingTokens = null,      // run.status thinking 心跳的累计 tokens（null = 非思考期）
  onStop,
  sessionTitle,
  onOpenSessionList,
  onCollapse,                // 收起悬浮卡（ChatDock 递进来；贴屏缘唤回）
  pinned = false,            // 悬浮卡固定态（固定 = 不自动收）
  onTogglePin,               // 切换固定（ChatDock 递进来，记 localStorage）
  projectId,                   // Phase B 批次 2：rewindFiles 走 /api/projects/:pid/sessions/:sid/rewind
  sessionId,
  onCanvasReload,              // 回调：rewindFiles 成功后让 iframe bump reloadToken
  systemInfo = null,           // run.system_init 的会话常量（model / 工具数…）→ ContextMeter popover
  contextUsage = null,         // run.context_usage 实时用量 → composer 上沿指示条
  onCompact,                   // 手动 /compact（指示条 ≥85% 时长出入口 + [+] 菜单常驻入口）
  onRefreshUsage,              // [+] 菜单展开时重问一次用量（两轮之间 WS 不推）
}) {
  // V2：streaming 状态从 header 移到 Send 按钮，header 不再显示文字。
  // agentProgress 还保留——后续如果想加进度气泡（hover Send 看 last tool）可用。
  void agentProgress;

  // 主线只看无 parentToolUseId 的消息 —— 子代理的正文流仍带着
  // parentToolUseId 进来（server forwardSubagentText 透传），这里滤掉。
  // 子代理 tabs 2026-08-18 退役：动态收进对话时间轴的 Task 抽屉行
  //（Message.jsx），不再开第二个投影。
  const shownMessages = useMemo(() => (
    messages.filter(m => !m.parentToolUseId)
  ), [messages]);

  // Header liveness dot：
  //   isStreaming + 距上次事件 < 2s → 绿色 pulse（agent 在产 output）
  //   isStreaming + ≥ 2s 无事件   → 灰色 static（在 turn 内但静默：深度思考 / 长工具调用）
  //   !isStreaming                 → 不渲染
  // 替换老的"已 30s 无输出"chip——liveness 范式：图标在动 = OK, 不动 = 待审视。
  const [iconActive, setIconActive] = useState(false);
  useEffect(() => {
    if (!isStreaming) { setIconActive(false); return undefined; }
    setIconActive(true);
    const timer = setTimeout(() => setIconActive(false), 2000);
    return () => clearTimeout(timer);
  }, [isStreaming, lastEventAt]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 顶部 header：session selector（点击弹 SessionListModal）+ 流式状态 */}
      <div style={{
        padding: `${GAP.md}px ${GAP.lg}px`,
        borderBottom: `1px solid ${CHROME.border}`,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: GAP.md,
      }}>
        {/* 会话切换器：原来是一行裸标题，看不出能点。2026-07-28 做成带框的
            下拉块（历史图标 + 标题 + ⌄），一眼看出"对话历史从这进" */}
        <button
          onClick={onOpenSessionList}
          disabled={!onOpenSessionList}
          title={onOpenSessionList ? t('切换会话 / 翻历史对话（重命名、复刻、删除也在这）') : ''}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
            padding: `${GAP.xs}px ${GAP.sm}px`,
            fontFamily: FONT_KAI, fontSize: FONT_SIZE.md, fontWeight: 500,
            color: COLOR.text,
            background: 'transparent',
            // 09-12 印刷风：方角、墨线细一档
            border: '1px solid rgba(31,24,16,0.35)',
            borderRadius: 0,
            cursor: onOpenSessionList ? 'pointer' : 'default',
            flex: 1,
            minWidth: 0,
            transition: 'background 0.15s, border-color 0.15s',
          }}
          onMouseEnter={e => {
            if (!onOpenSessionList) return;
            e.currentTarget.style.background = CHROME.hover;
            e.currentTarget.style.borderColor = COLOR.borderHv;
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.borderColor = CHROME.border;
          }}
        >
          <History size={11} strokeWidth={1.75} color={COLOR.sub} style={{ flexShrink: 0 }} />
          <span style={{
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            minWidth: 0,
            letterSpacing: 0,
            textTransform: 'none',
          }}>
            {sessionTitle || t('新对话')}
          </span>
          <ChevronDown size={12} strokeWidth={1.75} color={COLOR.sub} style={{ flexShrink: 0 }} />
        </button>

        {/* 「新对话」「结束会话」两颗按钮 2026-09-12 撤掉（站主定）：新会话从会话列表
            弹窗的「+ 新会话」开；结束会话收进同一个弹窗当前会话的菜单里。原注释担心的
            「藏起来撞 429」已由 WS 断开 60s 自动回收（server/ws/index.js）兜住。 */}

        {/* 图钉（2026-08-13 悬浮卡）：固定 = 不自动收；取消固定 = 鼠标离卡
            300ms 自动收、贴屏缘唤回。状态记 localStorage，卡顶那枚装饰钉纽扣
            跟着它出现/消失。
            09-12 做成看得出来的开关：两态都是钉子图标（PinOff 那道斜杠读起来像
            「禁用」），钉住 = 实墨反白块，没钉 = 墨线描边；比旁边的「收起」大一档。 */}
        {onTogglePin && (
          <button
            onClick={onTogglePin}
            data-pin-toggle={pinned ? 'on' : 'off'}
            title={pinned ? t('已固定：点一下取消（鼠标离开后自动收起，贴屏幕左右边缘唤回）') : t('固定这张卡（一直开着，不自动收起）')}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 26, height: 26, marginLeft: GAP.xs,
              color: pinned ? COLOR.btnText : COLOR.text2,
              background: pinned ? COLOR.btn : 'transparent',
              border: `1px solid ${pinned ? COLOR.btn : 'rgba(31,24,16,0.35)'}`,
              borderRadius: 0, cursor: 'pointer', padding: 0,
              transition: 'background 0.15s, color 0.15s',
            }}
            onMouseEnter={e => { if (!pinned) e.currentTarget.style.background = CHROME.hover; }}
            onMouseLeave={e => { if (!pinned) e.currentTarget.style.background = 'transparent'; }}
          >
            <Pin size={15} strokeWidth={pinned ? 2 : 1.75} />
          </button>
        )}

        {/* 收起悬浮卡。放在这排而不是让 ChatDock 自己画一条标题栏 ——
            那样一个面板上会有两条 header。"收起"是一个会话级动作，它属于这里。 */}
        {onCollapse && (
          <button
            onClick={onCollapse}
            title={t('收起（鼠标贴屏幕左右边缘唤回）')}
            style={{
              display: 'inline-flex', alignItems: 'center',
              padding: `${GAP.xs}px ${GAP.xs}px`,
              color: COLOR.sub, background: 'transparent', border: 'none',
              borderRadius: RADIUS.sm, cursor: 'pointer',
              transition: 'background 0.15s, color 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = CHROME.hover; e.currentTarget.style.color = COLOR.text2; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = COLOR.sub; }}
          >
            <PanelRightClose size={13} strokeWidth={1.75} />
          </button>
        )}
      </div>

      <MessageList
        onOpenSessionList={onOpenSessionList}
        messages={shownMessages}
        isStreaming={isStreaming}
        thinkingTokens={thinkingTokens}
        agentActive={iconActive}
        projectId={projectId}
        sessionId={sessionId}
        onCanvasReload={onCanvasReload}
      />

      {/* WS 连接异常 — 真错误才弹（agent 静默走 header dot 显示，不再发文字 chip） */}
      {(wsStatus === 'reconnecting' || wsStatus === 'closed') && (
        <div style={{
          padding: `${GAP.xs}px ${GAP.lg}px`,
          fontFamily: FONT_KAI,
          fontSize: FONT_SIZE.md,
          color: wsStatus === 'closed' ? COLOR.error : COLOR.sub,
          letterSpacing: '0.04em',
          background: wsStatus === 'closed' ? 'rgba(220, 53, 69, 0.06)' : 'rgba(255, 193, 7, 0.06)',
          borderTop: `1px dashed ${COLOR.borderLt}`,
          display: 'flex', alignItems: 'center', gap: GAP.sm,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: RADIUS.round,
            background: wsStatus === 'closed' ? COLOR.error : COLOR.warn,
            animation: wsStatus === 'reconnecting' ? 'pulse 1.5s ease-in-out infinite' : 'none',
          }} />
          {wsStatus === 'closed'
            ? t('连接已关闭 · 请刷新页面')
            : t('正在重连服务器…（已收到的事件不会丢，重连后会补 replay）')}
        </div>
      )}

      {/* streamInput 排队提示：当用户在 agent 跑时追加消息后 inputQueue 积压，
          显示"已排队 N 条"chip，agent 会跑完当前 turn 后自动吃下一条 */}
      {queueDepth > 0 && (
        <div style={{
          padding: `${GAP.xs}px ${GAP.lg}px`,
          fontFamily: FONT_KAI,
          fontSize: FONT_SIZE.md,
          color: COLOR.sub,
          letterSpacing: '0.04em',
          background: 'rgba(43,33,23, 0.04)',
          borderTop: `1px dashed ${COLOR.borderLt}`,
          display: 'flex', alignItems: 'center', gap: GAP.sm,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: RADIUS.round,
            background: COLOR.warn,
          }} />
          {t('已排队 {n} 条 · agent 跑完当前会自动处理', { n: queueDepth })}
        </div>
      )}
      {/* 上下文指示：composer 上沿的一条 hairline，60% 以下零像素（见 ContextMeter） */}
      <ContextMeter
        usage={contextUsage}
        info={systemInfo}
        onCompact={onCompact}
        isStreaming={isStreaming}
      />
      <ChatComposer
        onSend={onSend}
        // disabled 给外部留口（hydrateError 等）；isRunning 单独控 Send/停止 形态
        disabled={false}
        isRunning={isStreaming}
        onStop={onStop}
        trayItems={trayItems}
        onRemoveTrayItem={onRemoveTrayItem}
        onPickFile={onPickFile}
        promptSuggestion={promptSuggestion}
        onDismissSuggestion={onDismissSuggestion}
        contextUsage={contextUsage}
        systemInfo={systemInfo}
        onCompact={onCompact}
        onRefreshUsage={onRefreshUsage}
        projectId={projectId}
        sessionId={sessionId}
      />
    </div>
  );
}

