/**
 * PostToolUse(Edit|Write) handler —— 干掉 tool_response.originalFile 防上下文累积。
 * （2026-08-14 可维护性行动：从 hooks.js 原样迁出，语义零改动）
 *
 * 背景：
 *   FileEditOutput.originalFile / FileWriteOutput.originalFile (sdk-tools.d.ts:2270, 2328)
 *   是完整原文件内容。canvas.html 25KB 一次 Edit 在 tool_result 里等于 6k tokens。
 *   30 turn 累积 ≈ 180k tokens → 跟 Kimi 256k 上限挤爆（用户实测 418k 报错）。
 *
 *   structuredPatch（diff 行）是模型理解改动所需的全部信息；oldString/newString
 *   是模型自己刚才传的 input，本来就在上下文里。originalFile 对模型基本无用 —
 *   要看完整文件后续再 Read 即可。
 *
 * 行为：
 *   updatedToolOutput 是 SDK 提供的"改写发给 model 的 tool_result"通道
 *   (sdk.d.ts:1944)。**只影响 model 视图**，jsonl 持久化仍是原 tool_response。
 *   也就是 forkSession / 断线恢复看到的还是完整产物 — 不丢数据。
 *
 *   保留字段：filePath / oldString / newString / structuredPatch / type / gitDiff
 *   清掉字段：originalFile（替换为 null，保持类型 string|null）
 *
 *   非 Edit/Write 的 tool_response 形态（如 input 不带 originalFile） noop。
 *
 * input: PostToolUseHookInput (sdk.d.ts:1926)
 * output: PostToolUseHookSpecificOutput (sdk.d.ts:1938)
 */
export function makePostToolUseEditWriteTrimHandler({ ctx }) {
  return async (input, _toolUseId, _options) => {
    try {
      const resp = input?.tool_response;
      if (!resp || typeof resp !== 'object') return {};
      if (!('originalFile' in resp)) return {};
      const originalSize = typeof resp.originalFile === 'string' ? resp.originalFile.length : 0;
      if (originalSize === 0) return {};  // 新建文件 originalFile 本就是 null

      const trimmed = { ...resp, originalFile: null };

      try {
        // ℹ️ 遥测事件：前端刻意不消费（截断是常态，弹提示只会变成噪音）——审计/排查用
        ctx.emit({
          type: 'run.tool_response_trimmed',
          tool: input?.tool_name || 'Edit/Write',
          field: 'originalFile',
          savedChars: originalSize,
        });
      } catch { /* emit fail-safe */ }

      return {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          updatedToolOutput: trimmed,
        },
      };
    } catch (err) {
      console.warn(`[hooks/PostToolUse Edit|Write trim] handler threw:`, err.message);
      return {};
    }
  };
}
