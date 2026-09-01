import { useEffect } from 'react';

/**
 * ui-bridge.js —— agent 那几只「改看的人这一侧」的手（2026-09-01 拆出）
 *
 * `chalk_edit`（08-25）拨用户的「改板书」开关，`show_sheet` 把某一页翻到他眼前，
 * `pin_view` 钉住他的视区（后两个 09-01 叠纸）。三个都**一个字不改 board.json** ——
 * 改的是此刻这个人看到什么、能动什么。服务端广播 ws 事件，这里转成窗口事件送进 BoardCanvas，免得为两个
 * 布尔值把 prop 钻五层。
 *
 * 收成一份也是为了下一只手：这类"不改板只改视线"的动作还会有（钉住视区、
 * 换摞），加在这儿就不用每次再去那个巨大的 switch 里找位置。
 *
 * @returns {string|null} 要给用户看的一句话；null = 不用报
 */
export function dispatchUiEvent(evt) {
  if (evt?.type === 'ui.show_sheet') {
    if (!evt.sheet) return null;
    window.dispatchEvent(new CustomEvent('nd:show-sheet', { detail: { sheet: evt.sheet } }));
    // ⚠️ 不报 —— 画面当场就翻过去了，再说一句是噪音
    return null;
  }
  if (evt?.type === 'ui.pin_view') {
    window.dispatchEvent(new CustomEvent('nd:pin-view', { detail: { on: !!evt.on } }));
    // 这个要报：镜头的行为变了，而变化本身在屏幕上看不出来（画面此刻可能没动）
    return evt.on
      ? 'agent 钉住了视区：镜头守着当前这一摞，它换页你也看得见'
      : 'agent 松开了视区';
  }
  if (evt?.type === 'ui.chalk_edit') {
    window.dispatchEvent(new CustomEvent('nd:chalk-edit', { detail: { on: !!evt.on } }));
    // 这个要报：开关本身在屏幕上看不见，不说用户不知道自己多了一只手
    return evt.on
      ? 'agent 打开了「改板书」：板书现在可以直接拖动/编辑'
      : 'agent 关上了「改板书」';
  }
  return null;
}

/**
 * useOpenSessionFromBoard —— 从板上的目录跳回「铺这一页时那段对话」
 * （2026-09-01 叠纸刀 8）
 *
 * 反方向的同一族：上面那几条是 agent → 界面，这条是**板 → 外壳**。叠纸之前板上的
 * 东西和聊天记录之间没有任何链接；一摞纸叠起来之后这件事更要紧 —— 用户翻到第三页
 * 想不起来当时聊的是什么，而那一页在屏幕上就是全部线索。铺纸那一刻把会话 id 记在
 * 纸上（`sheets[].sid`），目录里中键点一行就回到那段对话。
 *
 * 走窗口事件而不是 prop：目录活在 BoardCanvas 里，中间隔着 CanvasFrame 两层，
 * 为一个低频动作钻两层 prop 不值。
 *
 * ⚠️ **正在流式的时候不切** —— 把用户正看着的对话从脚下抽走，比让他多点一下糟得多。
 * 这跟 `project.active_session` 那条用的是同一个判据。
 */
export function useOpenSessionFromBoard({ sessionIdRef, currentRunIdRef, setCurrentSessionId }) {
  useEffect(() => {
    const onOpen = (e) => {
      const sid = e?.detail?.sid;
      if (!sid || sid === sessionIdRef.current || currentRunIdRef.current) return;
      sessionIdRef.current = sid;
      setCurrentSessionId(sid);
    };
    window.addEventListener('nd:open-session', onOpen);
    return () => window.removeEventListener('nd:open-session', onOpen);
  }, [sessionIdRef, currentRunIdRef, setCurrentSessionId]);
}
