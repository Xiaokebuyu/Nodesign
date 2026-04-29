/**
 * read_file — 读 workspace 内的文本文件
 *
 * 失败处理：
 *   - 路径越界 / 非法 → safeResolve 抛 → registry 捕获 → category='unknown'（其实是 'invalid_input'，但简化处理）
 *   - 文件不存在 → 返回 { ok: false, error: { category: 'not_found', ... } }
 *   - 文件过大 → 拒绝（默认 5MB），返回 too_large 错（避免炸 LLM context）
 */

const MAX_BYTES = 5 * 1024 * 1024;

export const readFileTool = {
  name: 'read_file',
  description: '读取 workspace 内的文本文件。路径相对 workspace 根。',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: "相对路径，例如 'deck.html' 或 'design-notes.md'" },
    },
    required: ['path'],
  },
  async execute({ path }, ctx) {
    if (!ctx?.workspace) throw new Error('read_file: missing workspace ctx');
    if (typeof path !== 'string' || !path) {
      return { ok: false, error: { category: 'invalid_input', message: 'path 必须为非空字符串', retryable: false } };
    }

    const exists = await ctx.workspace.exists(path);
    if (!exists) {
      return { ok: false, error: { category: 'not_found', message: `文件不存在: ${path}`, retryable: false } };
    }

    // 检查大小
    const abs = ctx.workspace.resolve(path);
    const { stat } = await import('fs').then(m => ({ stat: m.promises.stat }));
    const s = await stat(abs);
    if (s.size > MAX_BYTES) {
      return {
        ok: false,
        error: {
          category: 'invalid_input',
          message: `文件过大 (${(s.size / 1024 / 1024).toFixed(2)} MB > ${MAX_BYTES / 1024 / 1024} MB)，请分块读或精简`,
          retryable: false,
        },
      };
    }

    const content = await ctx.workspace.read(path);
    return { path, bytes: s.size, content };
  },
};
