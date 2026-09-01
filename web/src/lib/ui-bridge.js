/**
 * ui-bridge.js —— agent 那几只「改看的人这一侧」的手（2026-09-01 拆出）
 *
 * `chalk_edit`（08-25）拨用户的「改板书」开关，`show_sheet`（09-01 叠纸）把某一页
 * 翻到用户眼前。两个都**一个字不改 board.json** —— 改的是此刻这个人看到什么、
 * 能动什么。服务端广播 ws 事件，这里转成窗口事件送进 BoardCanvas，免得为两个
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
  if (evt?.type === 'ui.chalk_edit') {
    window.dispatchEvent(new CustomEvent('nd:chalk-edit', { detail: { on: !!evt.on } }));
    // 这个要报：开关本身在屏幕上看不见，不说用户不知道自己多了一只手
    return evt.on
      ? 'agent 打开了「改板书」：板书现在可以直接拖动/编辑'
      : 'agent 关上了「改板书」';
  }
  return null;
}
