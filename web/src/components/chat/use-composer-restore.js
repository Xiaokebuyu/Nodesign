import { useEffect, useRef } from 'react';
import { useGlobalStore } from '../../stores/globalStore.js';
import { COMPOSER_RESTORE_EVENT, planRestore, joinDraft, askReplaceDraft } from '../../lib/composer-draft.js';

/**
 * 输入框这头接「把原话放回来」（09-17，问题库 iss_mtxylgs4_xmmz）。协议与各 mode 的含义见 lib/composer-draft.js。
 *
 * 拆成 hook 是为了让 ChatComposer 只多两行：它只交出「现在框里是什么」（ref）和「怎么写进去」。
 * outcome 写回事件的 detail —— 派发是同步的，派发方当场就能读到。
 *
 * @param {{ current: string }} textRef  ChatComposer 里跟 text 同步的 ref（submit 清空时要同步置空，
 *   否则发送失败的回调赶在重渲染之前跑，会把旧字当成「框里已经是这段」而不放回）
 * @param {(next: string) => void} write  写进输入框并把光标放到末尾
 */
export function useComposerRestore(textRef, write) {
  const writeRef = useRef(write);
  writeRef.current = write;
  useEffect(() => {
    const onRestore = (e) => {
      const d = e.detail;
      if (!d || d.outcome) return;   // 已经有别的输入框接过了（同页只该有一个，防重复）
      const plan = planRestore(textRef.current, d.text, d.mode);
      d.outcome = plan.outcome;
      if (plan.next != null) writeRef.current(plan.next);
      if (plan.outcome !== 'asked') return;
      const confirm = useGlobalStore.getState().confirm;
      Promise.resolve(confirm ? askReplaceDraft(confirm) : false).then((replace) => {
        // 弹框期间框里的字可能变了（弹框挡着，基本不会）：接在后面按最新的算
        writeRef.current(replace ? d.text : joinDraft(textRef.current, d.text));
      });
    };
    window.addEventListener(COMPOSER_RESTORE_EVENT, onRestore);
    return () => window.removeEventListener(COMPOSER_RESTORE_EVENT, onRestore);
  }, [textRef]);
}
