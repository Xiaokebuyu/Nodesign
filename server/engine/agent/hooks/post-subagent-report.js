/**
 * hooks/post-subagent-report.js — 子代理报告丢了的时候别整轮重跑（2026-08-18）
 *
 * ## 问题
 *
 * SDK 的子代理触到 `maxTurns` 时返回的是 SDKResultError，**那个类型没有 result
 * 字段** —— 最后一条 assistant 消息（也就是报告本身）直接消失，主 agent 拿到的
 * 是空的或者只有开场白。工作已经做完、token 已经烧掉，结果拿不到。
 *
 * 2026-08-05 真实记录：两次派 explorer，一次 59292 tokens / 16 轮工具调用 / 110s，
 * 回来只有一句开场白；一次 31228 tokens / 17 轮，回来 "(returned no output.)"。
 * 中间轮次少的那次正常。主 agent 的绕行只能是"拆小重派"或"放弃子代理" ——
 * 等于放弃了子代理隔离上下文的全部价值，长研究任务反而不敢派了。
 *
 * ## 做法
 *
 * 我们改不了 SDK 那个类型，但 `task_notification` 上带着 **`output_file`** ——
 * 子代理的完整转录 JSONL。所以：报告看起来是空的时候，把转录路径递给主 agent，
 * 让它 Read 一遍把结论捞出来。**从"整轮白烧"变成"多读一个文件"。**
 *
 * ⚠️ 判据故意保守（只在摘要短得不像报告时才提示）：把这句话贴在每次正常的
 * 子代理返回后面是噪音，而噪音会训练 agent 忽略提示。
 */

/** tool_use_id → 最近一次 task_notification（agent-shared 在收到时写进来） */
const lastNotification = new Map();
const MAX_TRACKED = 200;

export function recordTaskNotification(msg) {
  if (!msg?.tool_use_id) return;
  lastNotification.set(msg.tool_use_id, {
    status: msg.status,
    summary: msg.summary || '',
    outputFile: msg.output_file || null,
    toolUses: msg.usage?.tool_uses ?? null,
    tokens: msg.usage?.total_tokens ?? null,
  });
  // 别无限长：一个会话里子代理数量有限，但进程是长命的
  if (lastNotification.size > MAX_TRACKED) {
    const first = lastNotification.keys().next().value;
    lastNotification.delete(first);
  }
}

/** 已经消费过的 id（用来区分"没记上"和"记过又用掉了"，见下面那段） */
const consumed = new Set();
let missing = 0;

/** 报告"看起来是空的"的判据 —— 短于这个就不像一份报告 */
const SUSPICIOUS_LEN = 200;

export function makePostToolUseSubagentReportRecovery() {
  return async (input) => {
    const id = input?.tool_use_id;
    if (!id) return {};
    const note = lastNotification.get(id);
    if (!note) {
      // ⚠️ 这条分支是「静默死」的经典形状：`recordTaskNotification` 必须**先于**
      // 这个 hook 跑，否则整个 handler 什么都不做而且一声不响。这个仓库为
      // 「hook 静默死」付过三次账（最贵一次 19 个会话 0 触发、38k tokens 白跑），
      // 所以宁可留一行日志：真出问题时它会成堆出现，而不是一片安静。
      // 正常也会走到这儿（同一个 id 第二次进来，note 已被一次性消费掉），
      // 所以只在**从来没见过这个 id** 时才记。
      if (!consumed.has(id)) {
        missing += 1;
        console.warn(`[subagent-report] tool_use_id ${id} 没有对应的 task_notification`
          + `（累计 ${missing} 次）—— 如果这个数字在涨，说明 recordTaskNotification`
          + ' 没有跑在这个 hook 之前，兜底其实是死的。');
      }
      return {};
    }
    consumed.add(id);
    if (consumed.size > MAX_TRACKED) consumed.delete(consumed.values().next().value);
    lastNotification.delete(id);          // 一次性

    const looksEmpty = note.summary.trim().length < SUSPICIOUS_LEN;
    // 摘要有内容就什么都不说 —— 报告回来了，再贴一段提示是噪音，
    // 而噪音会训练 agent 忽略提示。
    if (!looksEmpty) return {};
    const didRealWork = (note.toolUses ?? 0) >= 4 || (note.tokens ?? 0) >= 8000;

    const lines = [
      `⚠️ 这个子代理回来的内容只有 ${note.summary.trim().length} 个字符`
      + `（status=${note.status}${note.toolUses != null ? `，跑了 ${note.toolUses} 次工具调用` : ''}`
      + `${note.tokens != null ? `，${note.tokens} tokens` : ''}）。`,
    ];
    if (didRealWork) {
      lines.push('它**确实干了活**，但最终报告没回传 —— SDK 的子代理触到轮次上限时'
        + '返回的错误类型不带 result 字段，最后那条消息会整个丢掉。');
    }
    if (note.outputFile) {
      lines.push(`完整转录在 \`${note.outputFile}\`。**Read 它取回结论，不要整轮重派** ——`
        + '相关 token 已消耗，重跑只会再次消耗。转录是 JSONL，从后往前读最快。');
    } else {
      lines.push('没有可用的转录路径。要重派的话把任务拆小（工具调用轮次少的时候不会丢）。');
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: lines.join('\n'),
      },
    };
  };
}
