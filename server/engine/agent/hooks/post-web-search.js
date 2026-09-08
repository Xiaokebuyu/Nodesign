/**
 * hooks/post-web-search.js —— web_search 之后的上网调查协议（2026-09-08 站主：agent 搜集信息浅尝辄止）。
 *
 * 提示词里早就写着「搜完就进去看」，不管用的原因是没有停下来 / 继续的判据，而搜索摘要长得像答案。
 * 这里挂在 PostToolUse（matcher web_search）：每会话第一次注入整份协议（深度表 / 落纸格式 / 停止判据），
 * 之后每次只注一句硬规矩 —— 下一步不能是回答用户，必须打开至少一个候选。跟 AskUserQuestion 协议注入同一手段。
 */
import { loadToolPrompt } from './tool-prompts.js';

export function makePostToolUseWebSearchProtocol() {
  let count = 0;
  return async () => {
    count += 1;
    const body = count === 1
      ? `<system-reminder>\n[上网调查协议 — 首次注入]\n\n${loadToolPrompt('web-research-protocol')}\n</system-reminder>`
      : '<system-reminder>[上网调查] 搜索结果只是候选清单。下一步不能是回答用户：打开至少一个候选（browser_navigate + browser_read），找的东西写进 assets/references/web/<站>.notes.md。</system-reminder>';
    return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: body } };
  };
}
