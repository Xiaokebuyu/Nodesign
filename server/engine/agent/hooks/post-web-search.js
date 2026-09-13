/**
 * hooks/post-web-search.js —— web_search 之后的上网调查协议（2026-09-08 站主：agent 搜集信息浅尝辄止）。
 *
 * 提示词里早就写着「搜完就进去看」，不管用的原因是没有停下来 / 继续的判据，而搜索摘要长得像答案。
 * 每会话第一次注入整份协议（深度表 / 落纸格式 / 停止判据），之后只注一句硬规矩 ——
 * 下一步不能是回答用户，必须打开至少一个候选。跟 AskUserQuestion 协议注入同一手段。
 *
 * 2026-09-13 从 PostToolUse 挪到 PostToolBatch：模型常在一条消息里连发几次 web_search，
 * 挂在 PostToolUse 时每次都注一遍（第一次整份协议、后面几句重复）。PostToolBatch 在同一条消息的
 * 全部工具结束后触发一次（09-13 真跑探针：两件工具一批、additionalContext 模型收得到），这一批里有
 * web_search 就注一次。
 */
import { loadToolPrompt } from './tool-prompts.js';

const isWebSearch = (name) => /(^|__)web_search$/.test(String(name || ''));

export function makePostToolBatchWebSearchProtocol() {
  let count = 0;
  return async (input) => {
    if (!(input?.tool_calls || []).some((c) => isWebSearch(c?.tool_name))) return {};
    count += 1;
    const body = count === 1
      ? `<system-reminder>\n[上网调查协议 — 首次注入]\n\n${loadToolPrompt('web-research-protocol')}\n</system-reminder>`
      : '<system-reminder>[上网调查] 搜索结果只是候选清单。下一步不能是回答用户：打开至少一个候选（browser_navigate + browser_read），找的东西写进 assets/references/web/<站>.notes.md。</system-reminder>';
    return { hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: body } };
  };
}
